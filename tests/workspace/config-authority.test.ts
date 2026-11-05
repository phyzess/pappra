import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  CROSS_LAYER_VALUE_COMPOSITIONS,
  MACHINE_CONFIG_AUTHORITY,
  WORKSPACE_CONFIG_AUTHORITY,
  configAuthorityGaps,
  inspectConfigAuthority,
  scanConfigSchema,
  summarizeConfigAuthority,
  type ConfigAuthoritySource,
  type ConfigFieldAuthority,
} from '../../src/schemas/config-authority.js';
import { machineConfigSchema } from '../../src/schemas/machine.js';
import { workspaceConfigSchema } from '../../src/schemas/workspace.js';
import { runDoctor } from '../../src/app/doctor.js';
import { configAuthorityCheck } from '../../src/app/config-authority-check.js';
import { discoverWorkspace } from '../../src/workspace/discover.js';
import { inspectWorkspaceConfig } from '../../src/workspace/config.js';
import { testSubprocessEnvironment } from '../../scripts/test-environment.js';
import {
  baseWorkspaceConfig,
  cleanup,
  createRepository,
  makeTempDir,
  realpath,
  writeText,
  writeWorkspaceConfig,
} from './fixtures.js';

const projectRoot = dirname(
  fileURLToPath(import.meta.resolve('@phyzess/pappra/package.json')),
);
const cli = join(projectRoot, 'dist/cli/main.js');

function field(
  fields: readonly ConfigFieldAuthority[],
  path: string,
): ConfigFieldAuthority {
  const found = fields.find((entry) => entry.path === path);
  assert.notEqual(found, undefined, `missing classification for ${path}`);
  return found as ConfigFieldAuthority;
}

/** A candidate schema/source pair, used to probe the classification contract. */
function candidateSource(
  schema: z.core.$ZodType,
  fields: readonly ConfigFieldAuthority[],
  file = '.pappra/candidate-workspace.json',
): ConfigAuthoritySource {
  return {
    layer: 'shared',
    file,
    schemaName: 'pappra/workspace/1',
    schema,
    fields,
  };
}

test('classifies every workspace.json and machine.json field', () => {
  const inspection = inspectConfigAuthority();
  assert.deepEqual(inspection.violations, []);
  const [shared, machine] = inspection.sources;
  assert.notEqual(shared, undefined);
  assert.notEqual(machine, undefined);
  assert.equal(shared?.file, '.pappra/workspace.json');
  assert.equal(machine?.file, '.pappra/local/machine.json');
  assert.deepEqual(shared?.unclassified, []);
  assert.deepEqual(machine?.unclassified, []);
  assert.deepEqual(shared?.stale, []);
  assert.deepEqual(machine?.stale, []);
  assert.deepEqual(shared?.unsupported, []);
  assert.deepEqual(machine?.unsupported, []);
  // The schema walker really reads the schemas, so an empty table would fail.
  assert.ok((shared?.fields.length ?? 0) >= 20);
  assert.ok((machine?.fields.length ?? 0) >= 9);
  // A repeated name across layers is reported, and is not a violation.
  assert.deepEqual(inspection.duplicatePaths, ['schema']);
});

test('the current schemas use only constructs the contract models', () => {
  assert.deepEqual(scanConfigSchema(workspaceConfigSchema).unsupported, []);
  assert.deepEqual(scanConfigSchema(machineConfigSchema).unsupported, []);
});

test('a field added without a classification is reported as drift', () => {
  const scan = scanConfigSchema(workspaceConfigSchema);
  const withoutRuntime = WORKSPACE_CONFIG_AUTHORITY.filter(
    (entry) => entry.path !== 'runtimeVersion',
  );
  const missing = configAuthorityGaps(scan.fields, withoutRuntime);
  assert.deepEqual(missing.unclassified, ['runtimeVersion']);
  assert.deepEqual(missing.stale, []);

  const machineScan = scanConfigSchema(machineConfigSchema);
  const withGhost = [
    ...MACHINE_CONFIG_AUTHORITY,
    {
      path: 'removedField',
      layer: 'private',
      kind: 'descriptive',
      gate: 'none',
      note: 'Removed from the schema.',
    } satisfies ConfigFieldAuthority,
  ];
  const ghost = configAuthorityGaps(machineScan.fields, withGhost);
  assert.deepEqual(ghost.unclassified, []);
  assert.deepEqual(ghost.stale, ['removedField']);
});

test('an unmodelled construct is reported instead of silently passing', () => {
  // The pre-fix failure mode: a classified leaf replaced by a union that holds
  // an object. A walker that flattens unknown constructs into leaves reports the
  // same path, so the coverage check passes while the interior is unclassified.
  const schema = z.strictObject({
    name: z.string(),
    runtimeVersion: z.union([
      z.string(),
      z.strictObject({ nestedField: z.string() }),
    ]),
    knowledge: z.strictObject({
      sources: z.array(
        z.union([z.string(), z.strictObject({ deep: z.string() })]),
      ),
    }),
  });
  const fields: readonly ConfigFieldAuthority[] = [
    {
      path: 'name',
      layer: 'shared',
      kind: 'descriptive',
      gate: 'none',
      note: 'Candidate label.',
    },
    {
      path: 'runtimeVersion',
      layer: 'shared',
      kind: 'selection',
      gate: 'explicit-command',
      note: 'Candidate target.',
    },
    {
      path: 'knowledge.sources[]',
      layer: 'shared',
      kind: 'access-candidate',
      gate: 'explicit-command',
      note: 'Candidate read list.',
    },
  ];

  const scan = scanConfigSchema(schema);
  assert.deepEqual(
    scan.fields.map((entry) => entry.path),
    ['name'],
  );
  assert.deepEqual(scan.unsupported, [
    { path: 'runtimeVersion', construct: 'union' },
    { path: 'knowledge.sources[]', construct: 'union' },
  ]);

  const inspection = inspectConfigAuthority([candidateSource(schema, fields)]);
  const coverage = inspection.sources[0];
  assert.deepEqual(coverage?.unclassified, []);
  // The construct failure is the reported one; it is not mislabelled as a stale
  // table entry, so the message names the construct the contract cannot model.
  assert.deepEqual(coverage?.stale, []);
  const constructViolations = inspection.violations.filter((entry) =>
    entry.includes('unmodelled schema construct "union"'),
  );
  assert.equal(constructViolations.length, 2);
  assert.match(
    constructViolations.join(' | '),
    /runtimeVersion uses the unmodelled schema construct "union"; the classification \(selection\) cannot cover its interior/,
  );
  assert.match(constructViolations.join(' | '), /knowledge\.sources\[\]/);
});

test('a schema the contract cannot walk at all still produces a verdict', () => {
  const schema = z.union([
    z.strictObject({ a: z.string() }),
    z.strictObject({ b: z.string() }),
  ]);
  const inspection = inspectConfigAuthority([
    candidateSource(schema, [], '.pappra/rootless.json'),
  ]);
  assert.equal(inspection.violations.length, 1);
  assert.match(
    inspection.violations[0] ?? '',
    /\(root\) uses the unmodelled schema construct "union"; no classification can cover its interior/,
  );
  assert.deepEqual(inspection.sources[0]?.fields, []);
});

test('unsupported subtrees suppress only uninspectable coverage diagnostics', () => {
  const unsupported = z.union([
    z.string(),
    z.strictObject({ hidden: z.string() }),
  ]);
  const candidates = [
    { path: '', schema: z.union([workspaceConfigSchema, z.string()]) },
    {
      path: 'knowledge',
      schema: workspaceConfigSchema.extend({ knowledge: unsupported }),
    },
    {
      path: 'repositories',
      schema: workspaceConfigSchema.extend({ repositories: unsupported }),
    },
    {
      path: 'repositories[]',
      schema: workspaceConfigSchema.extend({
        repositories: z.array(unsupported),
      }),
    },
    {
      path: 'extensions',
      schema: workspaceConfigSchema.extend({ extensions: unsupported }),
    },
    {
      path: 'validation[].args',
      schema: workspaceConfigSchema.extend({
        validation: z.array(
          z.strictObject({
            id: z.string(),
            repositoryId: z.string(),
            executable: z.string(),
            args: unsupported,
          }),
        ),
      }),
    },
  ];
  for (const candidate of candidates) {
    const inspection = inspectConfigAuthority([
      candidateSource(candidate.schema, WORKSPACE_CONFIG_AUTHORITY),
    ]);
    assert.deepEqual(inspection.sources[0]?.unsupported, [
      { path: candidate.path, construct: 'union' },
    ]);
    assert.deepEqual(inspection.sources[0]?.stale, [], candidate.path);
    assert.deepEqual(inspection.sources[0]?.unclassified, [], candidate.path);
    assert.equal(inspection.violations.length, 1, candidate.path);
    assert.match(
      inspection.violations[0] ?? '',
      /unmodelled schema construct "union"/,
    );
  }
});

test('unsupported arrays suppress descendant open-boundary noise without hiding stale siblings', () => {
  const schema = workspaceConfigSchema.extend({
    repositories: z.array(
      z.union([z.string(), z.strictObject({ id: z.string() })]),
    ),
    knowledge: z.union([z.string(), workspaceConfigSchema.shape.knowledge]),
    newInspectableField: z.string(),
  });
  const extraFields = [
    {
      ...field(WORKSPACE_CONFIG_AUTHORITY, 'extensions'),
      path: 'repositories[].extensions',
    },
    ...[
      'repositoriesExtra[].id',
      'repositories[]Extra.id',
      'knowledgeExtra.sources[]',
      'removedField',
    ].map((path) => ({ ...field(WORKSPACE_CONFIG_AUTHORITY, 'name'), path })),
  ];
  const inspection = inspectConfigAuthority([
    candidateSource(schema, [...WORKSPACE_CONFIG_AUTHORITY, ...extraFields]),
  ]);
  assert.deepEqual(inspection.sources[0]?.stale, [
    'repositoriesExtra[].id',
    'repositories[]Extra.id',
    'knowledgeExtra.sources[]',
    'removedField',
  ]);
  assert.deepEqual(inspection.sources[0]?.unclassified, [
    'newInspectableField',
  ]);
  assert.equal(inspection.sources[0]?.unsupported.length, 2);
  assert.equal(inspection.violations.length, 7);
  assert.ok(
    inspection.violations.some((entry) =>
      entry.includes('newInspectableField has no authority classification'),
    ),
  );
  assert.ok(
    inspection.violations.every(
      (entry) => !entry.includes('but is enumerable'),
    ),
  );
});

test('unsupported roots retain independent classification policy violations', () => {
  const schema = z.union([workspaceConfigSchema, z.string()]);
  const fields: readonly ConfigFieldAuthority[] = [
    ...WORKSPACE_CONFIG_AUTHORITY.map((entry) => {
      if (entry.path === 'name')
        return {
          ...entry,
          layer: 'private' as const,
          gate: 'explicit-command' as const,
        };
      if (entry.path === 'runtimeVersion')
        return { ...entry, gate: 'none' as const };
      return entry;
    }),
    field(WORKSPACE_CONFIG_AUTHORITY, 'extensions'),
  ];
  const inspection = inspectConfigAuthority([candidateSource(schema, fields)]);
  assert.deepEqual(inspection.sources[0]?.stale, []);
  assert.equal(inspection.violations.length, 7);
  const diagnostics = inspection.violations.join(' | ');
  assert.match(
    diagnostics,
    /\(root\) uses the unmodelled schema construct "union"/,
  );
  assert.match(diagnostics, /name declares layer private, expected shared/);
  assert.match(diagnostics, /name is descriptive but gate is explicit-command/);
  assert.match(
    diagnostics,
    /runtimeVersion is selection without an enabling condition/,
  );
  assert.match(
    diagnostics,
    /runtimeVersion is authority-bearing with gate none/,
  );
  assert.match(
    diagnostics,
    /runtimeVersion is activated by the committed layer/,
  );
  assert.match(diagnostics, /extensions is classified twice/);
});

test('unsupported array boundaries do not cover similar textual prefixes', () => {
  const schema = workspaceConfigSchema.extend({
    repositories: z.union([z.string(), z.array(z.string())]),
    extensions: z.strictObject({ inspectable: z.string() }),
  });
  const stalePaths = ['repositoriesExtra.id', 'repositories[]Extra.id'];
  const inspection = inspectConfigAuthority([
    candidateSource(schema, [
      ...WORKSPACE_CONFIG_AUTHORITY,
      ...stalePaths.map((path) => ({
        ...field(WORKSPACE_CONFIG_AUTHORITY, 'name'),
        path,
      })),
    ]),
  ]);
  assert.deepEqual(inspection.sources[0]?.stale, ['extensions', ...stalePaths]);
  assert.deepEqual(inspection.sources[0]?.unclassified, [
    'extensions.inspectable',
  ]);
  assert.equal(inspection.violations.length, 6);
  assert.ok(
    inspection.violations.includes(
      '.pappra/candidate-workspace.json: extensions is classified as an open container but is enumerable',
    ),
  );
});

test('doctor reports a controlled warning for an unmodelled construct', () => {
  const schema = z.strictObject({
    runtimeVersion: z.union([z.string(), z.strictObject({ x: z.string() })]),
  });
  const inspection = inspectConfigAuthority([
    candidateSource(schema, [
      {
        path: 'runtimeVersion',
        layer: 'shared',
        kind: 'selection',
        gate: 'explicit-command',
        note: 'Candidate target.',
      },
    ]),
  ]);
  assert.ok(inspection.violations.length > 0);

  const check = configAuthorityCheck({
    configPath: '/tmp/candidate/.pappra/workspace.json',
    machinePath: null,
    workspaceDigest: null,
    machineDigest: null,
    observedAt: '2026-01-01T00:00:00.000Z',
    inspection,
  });
  assert.equal(check.id, 'workspace.authority');
  assert.equal(check.code, 'doctor_config_authority');
  assert.equal(check.status, 'warning');
  assert.equal(check.severity, 'warning');
  assert.match(check.summary, /^Classification gaps: /);
  assert.match(check.summary, /unmodelled schema construct "union"/);
  // The observation stays scoped to what this check did.
  assert.match(check.summary, /it resolved, spawned and executed nothing/);
});

test('the committed layer never activates an authority-bearing field by itself', () => {
  const allowedGates = new Set([
    'explicit-command',
    'local-binding',
    'no-consumer',
  ]);
  for (const source of [
    { layer: 'shared', fields: WORKSPACE_CONFIG_AUTHORITY },
    { layer: 'private', fields: MACHINE_CONFIG_AUTHORITY },
  ] as const) {
    for (const entry of source.fields) {
      assert.ok(
        entry.kind !== 'open-container' || entry.gate === 'none',
        `${entry.path} open container must not be gated`,
      );
      assert.ok(
        entry.note.length > 0,
        `${entry.path} needs a note explaining the classification`,
      );
      if (entry.kind === 'descriptive' || entry.kind === 'open-container') {
        assert.equal(entry.gate, 'none', `${entry.path} is descriptive`);
        continue;
      }
      assert.ok(
        allowedGates.has(entry.gate),
        `${entry.path} is authority-bearing and needs an enabling condition, not ${entry.gate}`,
      );
      if (source.layer === 'shared') {
        // A shared declaration may propose; it may never be the whole decision.
        assert.notEqual(
          entry.gate,
          'none',
          `${entry.path} cannot be enabled by the committed file alone`,
        );
      }
    }
  }

  const executable = field(
    WORKSPACE_CONFIG_AUTHORITY,
    'validation[].executable',
  );
  assert.equal(executable.layer, 'shared');
  assert.equal(executable.kind, 'execution-candidate');
  assert.equal(executable.gate, 'explicit-command');
  assert.equal(
    field(WORKSPACE_CONFIG_AUTHORITY, 'validation[].args[]').gate,
    'explicit-command',
  );

  const access = field(WORKSPACE_CONFIG_AUTHORITY, 'repositories[].access');
  assert.equal(access.kind, 'access-candidate');
  assert.match(access.note, /not operating-system isolation/);

  const external = field(
    MACHINE_CONFIG_AUTHORITY,
    'externalRepositories[].path',
  );
  assert.equal(external.layer, 'private');
  assert.equal(external.kind, 'local-binding');

  const extensions = field(WORKSPACE_CONFIG_AUTHORITY, 'extensions');
  assert.equal(extensions.kind, 'open-container');
  assert.match(
    extensions.note,
    /interior keys are not part of the schema contract/,
  );
  const extensionField = scanConfigSchema(workspaceConfigSchema).fields.find(
    (entry) => entry.path === 'extensions',
  );
  assert.equal(extensionField?.open, true);
});

test('shared and private summaries cover the schema without duplicates', () => {
  const shared = summarizeConfigAuthority('shared');
  const machine = summarizeConfigAuthority('private');
  assert.equal(
    shared.descriptive + shared.authorityBearing + shared.openContainers,
    shared.total,
  );
  assert.equal(
    machine.descriptive + machine.authorityBearing + machine.openContainers,
    machine.total,
  );
  assert.equal(
    shared.explicitCommand + shared.localBinding + shared.noConsumer,
    shared.authorityBearing,
  );
  assert.deepEqual(shared.inertPaths, [
    'code.prepare',
    'continuity.autoResume',
  ]);
  assert.equal(
    new Set(shared.authorityBearingPaths).size,
    shared.authorityBearingPaths.length,
  );
});

test('every cross-layer composition names fields from the classified tables', () => {
  const known = new Set([
    ...WORKSPACE_CONFIG_AUTHORITY.map((entry) => entry.path),
    ...MACHINE_CONFIG_AUTHORITY.map((entry) => entry.path),
  ]);
  assert.ok(CROSS_LAYER_VALUE_COMPOSITIONS.length > 0);
  for (const composition of CROSS_LAYER_VALUE_COMPOSITIONS) {
    assert.ok(composition.effective.length > 0);
    assert.ok(composition.note.length > 0);
    for (const path of [...composition.shared, ...composition.private]) {
      assert.ok(
        known.has(path),
        `${composition.id} names unknown field ${path}`,
      );
    }
  }
  const external = CROSS_LAYER_VALUE_COMPOSITIONS.find(
    (entry) => entry.id === 'external-repository-location',
  );
  assert.deepEqual(external?.shared, ['repositories[].path']);
  assert.deepEqual(external?.private, [
    'externalRepositories[].id',
    'externalRepositories[].path',
  ]);
});

/** A marker executable that records every run; nothing in the fixture runs it. */
function writeMarkerExecutable(root: string): {
  readonly executable: string;
  readonly marker: string;
} {
  const marker = join(root, 'executed.marker');
  const executable = join(root, 'marker-executable.sh');
  writeText(
    executable,
    `#!/bin/sh\nprintf 'executed\\n' >> "${marker}"\nexit 0\n`,
  );
  chmodSync(executable, 0o755);
  return { executable, marker };
}

function invoke(
  args: readonly string[],
  cwd: string,
  home: string,
  data: string,
) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 60_000,
    env: testSubprocessEnvironment(
      { HOME: home, PAPPRA_DATA_HOME: data, PATH: data },
      { allowPappra: ['PAPPRA_DATA_HOME'] },
    ),
  });
  if (result.error) throw result.error;
  return result;
}

test('a committed validation entry is never executed by doctor or discovery', async () => {
  const root = makeTempDir('authority-validation');
  const home = makeTempDir('authority-validation-home');
  const data = makeTempDir('authority-validation-data');
  try {
    createRepository(root);
    const { executable, marker } = writeMarkerExecutable(root);
    const configPath = writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        repositories: [{ id: 'app', path: '.', access: 'read' }],
        validation: [
          {
            id: 'marker',
            repositoryId: 'app',
            executable,
            args: ['--shared-declaration'],
          },
        ],
      }),
    );

    // The declaration is accepted as configuration and stays a candidate.
    const inspection = await inspectWorkspaceConfig(root);
    assert.equal(inspection.value?.validation.length, 1);
    assert.deepEqual(inspection.value?.validation[0], {
      id: 'marker',
      repositoryId: 'app',
      executable,
      args: ['--shared-declaration'],
    });
    assert.equal(existsSync(marker), false);

    const discovery = await discoverWorkspace(root);
    const candidate = discovery.validationCandidates.find(
      (entry) => entry.id === 'workspace-config:marker',
    );
    assert.notEqual(candidate, undefined);
    assert.equal(candidate?.origin, 'workspace-config');
    assert.equal(candidate?.verification, 'not-verified');
    assert.equal(candidate?.executable, executable);
    assert.equal(
      candidate?.declaredBy,
      `${realpath(configPath)}#/validation/0`,
    );
    assert.equal(existsSync(marker), false);

    const report = await runDoctor({ root, homeDir: home, dataDir: data });
    const validation = report.checks.find(
      (entry) => entry.id === 'workspace.validation',
    );
    assert.equal(validation?.status, 'ok');
    assert.match(validation?.summary ?? '', /none are executed/);
    const authority = report.checks.find(
      (entry) => entry.id === 'workspace.authority',
    );
    assert.equal(authority?.code, 'doctor_config_authority');
    assert.equal(authority?.status, 'ok');
    assert.match(authority?.summary ?? '', /^Static field classification/);
    assert.match(
      authority?.summary ?? '',
      /Non-execution of validation candidates is pinned by tests over current entrypoints, not observed here\./,
    );
    assert.equal(existsSync(marker), false);

    // The CLI must complete the run, emit one valid report, and still not run
    // the marker. The exit code is not asserted: unrelated checks such as a
    // missing runtime decide it, and coupling this pin to them would make the
    // test fail for reasons that have nothing to do with validation execution.
    const cliDoctor = invoke(
      ['doctor', '--root', root, '--json'],
      home,
      home,
      data,
    );
    assert.equal(cliDoctor.signal, null, 'doctor exited without a signal');
    assert.equal(typeof cliDoctor.status, 'number');
    assert.equal(cliDoctor.stderr, '');
    const parsed = JSON.parse(cliDoctor.stdout) as {
      readonly schema: string;
      readonly checks: readonly {
        readonly id: string;
        readonly status: string;
        readonly summary: string;
      }[];
      readonly summary: { readonly exitCode: number };
    };
    assert.equal(parsed.schema, 'pappra/doctor-report/1');
    assert.equal(typeof parsed.summary.exitCode, 'number');
    // Completion means the whole check set ran, not that the process stopped.
    assert.ok(parsed.checks.length >= 10);
    assert.ok(
      parsed.checks.some((entry) => entry.id === 'workspace.validation'),
    );
    const cliAuthority = parsed.checks.find(
      (entry) => entry.id === 'workspace.authority',
    );
    assert.equal(cliAuthority?.status, 'ok');
    assert.match(cliAuthority?.summary ?? '', /authority-bearing/);
    assert.equal(existsSync(marker), false);
  } finally {
    cleanup(root);
    cleanup(home);
    cleanup(data);
  }
});

test('doctor reports the layer each field belongs to', async () => {
  const root = makeTempDir('authority-layers');
  const home = mkdtempSync(join(tmpdir(), 'authority-layers-home-'));
  const data = mkdtempSync(join(tmpdir(), 'authority-layers-data-'));
  try {
    createRepository(root);
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        repositories: [{ id: 'app', path: '.', access: 'write' }],
      }),
    );
    const report = await runDoctor({ root, homeDir: home, dataDir: data });
    const authority = report.checks.find(
      (entry) => entry.id === 'workspace.authority',
    );
    assert.equal(
      authority?.source,
      join(realpath(root), '.pappra', 'workspace.json'),
    );
    assert.match(authority?.summary ?? '', /shared \.pappra\/workspace\.json/);
    assert.match(
      authority?.summary ?? '',
      /Static field classification of the two configuration schemas, not a runtime observation/,
    );
    assert.match(
      authority?.summary ?? '',
      /Field path\(s\) occurring in both files: schema; a repeated name is not by itself one effective value/,
    );
    assert.match(authority?.summary ?? '', /composed at read time/);
    assert.match(authority?.coverage ?? '', /nothing resolved or executed/);
    assert.ok(
      report.scope.checked.includes('configuration-authority'),
      'doctor scope names the classification check',
    );
  } finally {
    cleanup(root);
    rmSync(home, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});

test('a workspace without configuration reports the classification as not checked', async () => {
  const root = makeTempDir('authority-missing');
  const home = mkdtempSync(join(tmpdir(), 'authority-missing-home-'));
  const data = mkdtempSync(join(tmpdir(), 'authority-missing-data-'));
  try {
    writeFileSync(join(root, 'README.md'), '# nothing registered\n');
    const report = await runDoctor({ root, homeDir: home, dataDir: data });
    const authority = report.checks.find(
      (entry) => entry.id === 'workspace.authority',
    );
    assert.equal(authority?.status, 'unknown');
    assert.match(authority?.summary ?? '', /Not checked/);
  } finally {
    cleanup(root);
    rmSync(home, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});
