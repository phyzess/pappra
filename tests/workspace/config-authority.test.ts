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
import {
  CROSS_LAYER_VALUE_COMPOSITIONS,
  MACHINE_CONFIG_AUTHORITY,
  WORKSPACE_CONFIG_AUTHORITY,
  configAuthorityGaps,
  configSchemaFields,
  inspectConfigAuthority,
  summarizeConfigAuthority,
  type ConfigFieldAuthority,
} from '../../src/schemas/config-authority.js';
import { machineConfigSchema } from '../../src/schemas/machine.js';
import { workspaceConfigSchema } from '../../src/schemas/workspace.js';
import { runDoctor } from '../../src/app/doctor.js';
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
  // The schema walker really reads the schemas, so an empty table would fail.
  assert.ok((shared?.fields.length ?? 0) >= 20);
  assert.ok((machine?.fields.length ?? 0) >= 9);
});

test('a field added without a classification is reported as drift', () => {
  const fields = configSchemaFields(workspaceConfigSchema);
  const withoutRuntime = WORKSPACE_CONFIG_AUTHORITY.filter(
    (entry) => entry.path !== 'runtimeVersion',
  );
  const missing = configAuthorityGaps(fields, withoutRuntime);
  assert.deepEqual(missing.unclassified, ['runtimeVersion']);
  assert.deepEqual(missing.stale, []);

  const machineFields = configSchemaFields(machineConfigSchema);
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
  const ghost = configAuthorityGaps(machineFields, withGhost);
  assert.deepEqual(ghost.unclassified, []);
  assert.deepEqual(ghost.stale, ['removedField']);
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
        assert.ok(
          entry.gate === 'explicit-command' ||
            entry.gate === 'local-binding' ||
            entry.gate === 'no-consumer',
          `${entry.path} needs a command, a private binding or a decision`,
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
  const extensionField = configSchemaFields(workspaceConfigSchema).find(
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
    assert.match(
      authority?.summary ?? '',
      /No validation executable was resolved, spawned or executed\./,
    );
    assert.equal(existsSync(marker), false);

    const cliDoctor = invoke(
      ['doctor', '--root', root, '--json'],
      home,
      home,
      data,
    );
    assert.equal(cliDoctor.status, 1);
    const parsed = JSON.parse(cliDoctor.stdout) as {
      readonly checks: readonly {
        readonly id: string;
        readonly summary: string;
      }[];
    };
    const cliAuthority = parsed.checks.find(
      (entry) => entry.id === 'workspace.authority',
    );
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
    assert.match(authority?.summary ?? '', /Shared .pappra\/workspace\.json/);
    assert.match(
      authority?.summary ?? '',
      /No field is defined in both layers/,
    );
    assert.match(authority?.summary ?? '', /read-time composition/);
    assert.match(authority?.coverage ?? '', /no executable resolved or run/);
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
