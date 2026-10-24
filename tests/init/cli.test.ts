import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { getPackageInfo } from '../../src/index.js';
import { applyInitPlan, planWorkspaceInit } from '../../src/app/init.js';
import { describeInitRuntimeOperation } from '../../src/cli/commands/init.js';
import { installRuntime, runtimePaths } from '../../src/install/runtime.js';
import { baseInitChoices } from './fixtures.js';
import { createRuntimeTarball } from '../install/fixtures.js';
import {
  baseMachineConfig,
  baseWorkspaceConfig,
  createRepository,
  snapshotTree,
  writeMachineConfig,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';

const root = dirname(
  fileURLToPath(import.meta.resolve('@phyzess/pappra/package.json')),
);
const cli = join(root, 'dist/cli/main.js');

function invoke(
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = {},
) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 90_000,
    env: { ...process.env, ...environment },
  });
  if (result.error) throw result.error;
  return result;
}

function parseJson(stdout: string): Record<string, unknown> {
  const value: unknown = JSON.parse(stdout);
  assert(typeof value === 'object' && value !== null);
  return value as Record<string, unknown>;
}

function writeChoices(path: string): void {
  writeFileSync(path, `${JSON.stringify(baseInitChoices(), null, 2)}\n`);
}

/** Keeps the durable runtime copy out of the developer's real data directory. */
function runtimeEnv(temporary: string): NodeJS.ProcessEnv {
  return { PAPPRA_DATA_HOME: join(temporary, 'pappra-data') };
}

test('init runtime preview is read-only; --apply ensures and reuses an isolated runtime', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'pappra-init-cli-'));
  const dataDir = join(temporary, 'pappra-data');
  try {
    const choices = join(temporary, 'choices.json');
    writeChoices(choices);

    const planned = invoke(['init', '--config', choices, '--json'], temporary);
    assert.equal(planned.status, 0, planned.stderr);
    const plan = parseJson(planned.stdout);
    assert('ok' in plan && plan.ok === true);
    assert('plan' in plan);
    assert('scope' in plan);
    assert.equal(planned.stderr, '');
    assert.deepEqual(readdirSync(temporary), ['choices.json']);
    const humanPreview = invoke(['init', '--config', choices], temporary, {
      PAPPRA_DATA_HOME: dataDir,
    });
    assert.equal(humanPreview.status, 0, humanPreview.stderr);
    assert(humanPreview.stdout.includes('Runtime operation:'));
    assert(humanPreview.stdout.includes('Default self-package source:'));
    assert(
      humanPreview.stdout.includes(
        runtimePaths(getPackageInfo().version, dataDir).runtimeRoot,
      ),
    );
    assert(humanPreview.stdout.includes('preview does not'));
    assert.equal(existsSync(dataDir), false);
    assert.deepEqual(readdirSync(temporary), ['choices.json']);

    const configOnly = invoke(
      ['init', '--config', choices, '--apply', '--no-runtime', '--json'],
      temporary,
      { PAPPRA_DATA_HOME: dataDir },
    );
    assert.equal(configOnly.status, 0, configOnly.stderr);
    const configOnlyResult = parseJson(configOnly.stdout);
    assert.equal(configOnlyResult.ok, true);
    assert.equal(configOnlyResult.initComplete, false);
    assert.equal(configOnlyResult.runtime, null);
    assert.equal(existsSync(dataDir), false);
    const machinePath = join(temporary, '.pappra', 'local', 'machine.json');
    const machineBeforeRuntime = JSON.parse(readFileSync(machinePath, 'utf8'));
    assert.equal(machineBeforeRuntime.runtime, null);

    const beforeEmptyPlan = snapshotTree(temporary);
    const emptyPlanPreview = invoke(
      ['init', '--config', choices],
      temporary,
      runtimeEnv(temporary),
    );
    assert.equal(emptyPlanPreview.status, 0, emptyPlanPreview.stderr);
    assert(emptyPlanPreview.stdout.includes('No file changes are planned.'));
    assert(emptyPlanPreview.stdout.includes('Runtime operation:'));
    assert(
      emptyPlanPreview.stdout.includes(
        runtimePaths(getPackageInfo().version, dataDir).runtimeRoot,
      ),
    );
    assert.deepEqual(snapshotTree(temporary), beforeEmptyPlan);
    assert.equal(existsSync(dataDir), false);

    const version = getPackageInfo().version;
    const localTarball = createRuntimeTarball(temporary, {
      version,
      packageName: getPackageInfo().name,
    });
    const seededRuntime = await installRuntime({
      version,
      source: { kind: 'tarball', path: localTarball },
      dataDir,
      packageName: getPackageInfo().name,
      offline: true,
    });
    assert.equal(
      seededRuntime.ok,
      true,
      JSON.stringify(seededRuntime.diagnostics),
    );
    assert.equal(seededRuntime.status, 'installed');
    assert(seededRuntime.manifest !== null);

    const applied = invoke(
      ['init', '--config', choices, '--apply', '--json'],
      temporary,
      runtimeEnv(temporary),
    );
    assert.equal(applied.status, 0, applied.stderr);
    const apply = parseJson(applied.stdout);
    assert.equal(apply.ok, true);
    assert.equal(apply.initComplete, true);
    const applyValue = apply.apply;
    assert(typeof applyValue === 'object' && applyValue !== null);
    assert.equal(
      (applyValue as Record<string, unknown>).status,
      'external-actions-pending',
    );
    const runtimeValue = apply.runtime;
    assert(typeof runtimeValue === 'object' && runtimeValue !== null);
    assert.equal((runtimeValue as Record<string, unknown>).status, 'reused');
    const machine = JSON.parse(readFileSync(machinePath, 'utf8'));
    assert.equal(machine.runtime.executable, seededRuntime.manifest.executable);

    const repeated = invoke(
      ['init', '--config', choices, '--apply', '--json'],
      temporary,
      runtimeEnv(temporary),
    );
    assert.equal(repeated.status, 0, repeated.stderr);
    const repeat = parseJson(repeated.stdout);
    assert.equal(repeat.initComplete, true);
    const repeatApply = repeat.apply;
    assert(typeof repeatApply === 'object' && repeatApply !== null);
    assert.equal((repeatApply as Record<string, unknown>).status, 'no-changes');
    const repeatedRuntime = repeat.runtime;
    assert(typeof repeatedRuntime === 'object' && repeatedRuntime !== null);
    assert.equal((repeatedRuntime as Record<string, unknown>).status, 'reused');
    const beforeHumanApply = snapshotTree(temporary);
    const humanApply = invoke(
      ['init', '--config', choices, '--apply'],
      temporary,
      runtimeEnv(temporary),
    );
    assert.equal(humanApply.status, 0, humanApply.stderr);
    assert(humanApply.stdout.includes('Runtime operation result: reused'));
    assert(
      humanApply.stdout.includes(
        'Existing runtime was verified, reused and bound',
      ),
    );
    assert(
      humanApply.stdout.includes(
        'No knowledge documents are registered by init.',
      ),
    );
    assert.deepEqual(snapshotTree(temporary), beforeHumanApply);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('init --no-runtime reports no-changes and exit 0 once a matching runtime is bound', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'pappra-init-cli-no-runtime-'));
  try {
    const workspace = join(temporary, 'workspace');
    mkdirSync(workspace, { recursive: true });
    createRepository(workspace);
    const choices = join(temporary, 'choices.json');
    writeChoices(choices);
    const environment = runtimeEnv(temporary);

    const pending = invoke(
      ['init', '--config', choices, '--apply', '--no-runtime', '--json'],
      workspace,
      environment,
    );
    assert.equal(pending.status, 0, `${pending.stdout}\n${pending.stderr}`);
    const pendingValue = parseJson(pending.stdout);
    assert.equal(pendingValue.ok, true);
    assert.equal(pendingValue.initComplete, false);
    const pendingApply = pendingValue.apply;
    assert(typeof pendingApply === 'object' && pendingApply !== null);
    assert.equal(
      (pendingApply as Record<string, unknown>).status,
      'external-actions-pending',
    );

    writeMachineConfig(
      workspace,
      baseMachineConfig(workspace, {
        runtime: {
          version: getPackageInfo().version,
          executable: process.execPath,
          verifiedAt: '2026-10-17T00:00:00.000Z',
        },
      }),
    );
    const before = snapshotTree(workspace);
    const settled = invoke(
      ['init', '--config', choices, '--apply', '--no-runtime', '--json'],
      workspace,
      environment,
    );
    assert.equal(settled.status, 0, `${settled.stdout}\n${settled.stderr}`);
    const settledValue = parseJson(settled.stdout);
    assert.equal(settledValue.ok, true);
    assert.equal(settledValue.initComplete, false);
    assert.equal(settledValue.runtime, null);
    const settledApply = settledValue.apply;
    assert(typeof settledApply === 'object' && settledApply !== null);
    assert.equal(
      (settledApply as Record<string, unknown>).status,
      'no-changes',
    );
    assert.deepEqual(
      (settledApply as Record<string, unknown>).appliedFiles,
      [],
    );
    assert.deepEqual(snapshotTree(workspace), before);
    assert.equal(existsSync(join(temporary, 'pappra-data')), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('invalid init config returns JSON on stdout and writes nothing', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'pappra-init-cli-invalid-'));
  try {
    const choices = join(temporary, 'choices.json');
    writeFileSync(choices, '{"schema":');
    const result = invoke(['init', '--config', choices, '--json'], temporary);
    assert.equal(result.status, 2);
    const value = parseJson(result.stdout);
    assert('ok' in value && value.ok === false);
    assert('code' in value && value.code === 'init_invalid_input');
    assert.equal(result.stderr, '');
    assert.deepEqual(readdirSync(temporary), ['choices.json']);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('init help is available without opening the wizard', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'pappra-init-cli-help-'));
  try {
    const result = invoke(['init', '--help', '--json'], temporary);
    assert.equal(result.status, 0, result.stderr);
    const value = parseJson(result.stdout);
    assert('usage' in value && typeof value.usage === 'string');
    assert.match(value.usage, /pappra init/);
    assert.equal(result.stderr, '');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('runtime operation description distinguishes default, tarball, version and no-runtime modes', async () => {
  const temporary = mkdtempSync(
    join(tmpdir(), 'pappra-init-runtime-description-'),
  );
  try {
    const version = getPackageInfo().version;
    const prepared = await planWorkspaceInit({
      root: temporary,
      choices: baseInitChoices(),
      runtimeVersion: version,
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const dataDir = join(temporary, 'isolated-data');
    const options = {
      cwd: temporary,
      configPath: null,
      apply: false,
      json: false,
    };
    const defaultOperation = describeInitRuntimeOperation(
      options,
      prepared.bundle,
      dataDir,
    );
    assert.equal(defaultOperation.mode, 'default-self');
    assert.equal(defaultOperation.runtimeRequested, true);
    assert.equal(defaultOperation.targetVersion, version);
    assert.equal(
      defaultOperation.runtimeRoot,
      runtimePaths(version, dataDir).runtimeRoot,
    );
    assert(defaultOperation.source?.includes(getPackageInfo().name));
    assert(defaultOperation.source?.includes(getPackageInfo().version));
    assert(
      defaultOperation.previewLines.join('\n').includes('cannot promise reuse'),
    );
    assert(
      defaultOperation.confirmationMessage.includes(
        'verify/reuse a runtime for the workspace target',
      ),
    );
    assert(defaultOperation.confirmationMessage.includes('or install'));

    const olderVersion = '0.0.7';
    const preparedOlder = await planWorkspaceInit({
      root: temporary,
      choices: baseInitChoices(),
      runtimeVersion: olderVersion,
    });
    assert.equal(preparedOlder.ok, true);
    if (!preparedOlder.ok) return;
    const olderOperation = describeInitRuntimeOperation(
      options,
      preparedOlder.bundle,
      dataDir,
    );
    assert.equal(olderOperation.targetVersion, olderVersion);
    const olderPreview = olderOperation.previewLines.join('\n');
    assert(
      olderPreview.includes(
        'A verified runtime for this workspace target may still be reused.',
      ),
    );
    assert(
      olderPreview.includes(
        'If no verified runtime can be reused, the current package source cannot satisfy this target and runtime setup will fail after config apply.',
      ),
    );
    assert(!olderPreview.includes('will be rejected after config apply'));
    assert(
      olderOperation.confirmationMessage.includes(
        'first verify/reuse a runtime for the workspace target',
      ),
    );
    assert(
      olderOperation.confirmationMessage.includes(
        'If no verified target runtime is reusable, the current package cannot satisfy this target',
      ),
    );
    assert(
      !olderOperation.confirmationMessage.includes(
        'the runtime request will fail after config apply',
      ),
    );

    const tarballPath = join(temporary, 'runtime.tgz');
    const tarballOperation = describeInitRuntimeOperation(
      {
        ...options,
        installRuntime: true,
        runtimeTarball: 'runtime.tgz',
      },
      prepared.bundle,
      dataDir,
    );
    assert.equal(tarballOperation.mode, 'tarball');
    assert(tarballOperation.source?.includes(tarballPath));
    assert(tarballOperation.previewLines.join('\n').includes('network access'));

    const versionOperation = describeInitRuntimeOperation(
      { ...options, installRuntime: true, runtimeVersion: version },
      prepared.bundle,
      dataDir,
    );
    assert.equal(versionOperation.mode, 'version');
    assert.equal(
      versionOperation.source,
      `${getPackageInfo().name}@${version}`,
    );
    assert.equal(
      versionOperation.runtimeRoot,
      runtimePaths(version, dataDir).runtimeRoot,
    );

    const mismatchedVersion = describeInitRuntimeOperation(
      { ...options, installRuntime: true, runtimeVersion: olderVersion },
      prepared.bundle,
      dataDir,
    );
    assert(
      mismatchedVersion.previewLines
        .join('\n')
        .includes('the runtime request will be rejected before installation'),
    );
    assert(
      mismatchedVersion.confirmationMessage.includes(
        'will fail before installation',
      ),
    );

    const disabledOperation = describeInitRuntimeOperation(
      { ...options, noRuntime: true },
      prepared.bundle,
      dataDir,
    );
    assert.equal(disabledOperation.mode, 'disabled');
    assert.equal(disabledOperation.runtimeRequested, false);
    assert.equal(disabledOperation.source, null);
    assert.equal(disabledOperation.runtimeRoot, null);
    assert(
      disabledOperation.previewLines
        .join('\n')
        .includes(
          'No runtime installation, verification or binding operation will run',
        ),
    );
    assert(
      disabledOperation.confirmationMessage.includes(
        'No runtime operation will run (--no-runtime)',
      ),
    );
    assert.equal(existsSync(dataDir), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('default init conditionally previews and reuses a verified older target runtime', async () => {
  const temporary = mkdtempSync(
    join(tmpdir(), 'pappra-init-older-runtime-reuse-'),
  );
  const workspace = join(temporary, 'workspace');
  const dataDir = join(temporary, 'data');
  const olderVersion = '0.0.7';
  const executionMarker = join(temporary, 'runtime-executed.txt');
  const previousNpmCache = process.env.npm_config_cache;
  const previousNpmOffline = process.env.npm_config_offline;
  try {
    createRepository(workspace);
    const choices = baseInitChoices({
      name: 'older runtime target',
      repositories: [],
      hosts: [],
    });
    const prepared = await planWorkspaceInit({
      root: workspace,
      choices,
      runtimeVersion: olderVersion,
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const configured = await applyInitPlan(prepared.bundle);
    assert.equal(configured.ok, true, JSON.stringify(configured));
    const choicesPath = join(temporary, 'choices.json');
    writeFileSync(choicesPath, `${JSON.stringify(choices, null, 2)}\n`);
    process.env.npm_config_cache = join(temporary, 'npm-cache');
    process.env.npm_config_offline = 'true';

    const tarball = createRuntimeTarball(join(temporary, 'offline-package'), {
      version: olderVersion,
      packageName: getPackageInfo().name,
      executionMarkerPath: executionMarker,
    });
    const seededRuntime = await installRuntime({
      version: olderVersion,
      source: { kind: 'tarball', path: tarball },
      dataDir,
      packageName: getPackageInfo().name,
      offline: true,
    });
    assert.equal(
      seededRuntime.ok,
      true,
      JSON.stringify(seededRuntime.diagnostics),
    );
    assert.equal(seededRuntime.status, 'installed');
    assert(seededRuntime.manifest !== null);
    rmSync(executionMarker, { force: true });

    const environment = {
      PAPPRA_DATA_HOME: dataDir,
      npm_config_cache: process.env.npm_config_cache,
      npm_config_offline: 'true',
    };
    const workspaceBeforePreview = snapshotTree(workspace);
    const dataBeforePreview = snapshotTree(dataDir);
    const preview = invoke(
      ['init', '--config', choicesPath],
      workspace,
      environment,
    );
    assert.equal(preview.status, 0, preview.stderr);
    assert(preview.stdout.includes('Default self-package source:'));
    assert(
      preview.stdout.includes(
        'A verified runtime for this workspace target may still be reused.',
      ),
    );
    assert(
      preview.stdout.includes(
        'If no verified runtime can be reused, the current package source cannot satisfy this target',
      ),
    );
    assert(!preview.stdout.includes('will be rejected after config apply'));
    assert.equal(existsSync(executionMarker), false);
    assert.deepEqual(snapshotTree(workspace), workspaceBeforePreview);
    assert.deepEqual(snapshotTree(dataDir), dataBeforePreview);

    const applied = invoke(
      ['init', '--config', choicesPath, '--apply', '--json'],
      workspace,
      environment,
    );
    assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
    const result = parseJson(applied.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.initComplete, true);
    const runtime = result.runtime;
    assert(typeof runtime === 'object' && runtime !== null);
    assert.equal((runtime as Record<string, unknown>).status, 'reused');
    assert.equal((runtime as Record<string, unknown>).version, olderVersion);
    const machine = JSON.parse(
      readFileSync(join(workspace, '.pappra', 'local', 'machine.json'), 'utf8'),
    );
    assert.equal(machine.runtime.version, olderVersion);
    assert.equal(machine.runtime.executable, seededRuntime.manifest.executable);
    assert.equal(readFileSync(executionMarker, 'utf8'), 'executed');
  } finally {
    if (previousNpmCache === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = previousNpmCache;
    if (previousNpmOffline === undefined) delete process.env.npm_config_offline;
    else process.env.npm_config_offline = previousNpmOffline;
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('default init fails only when an older target has no verified runtime to reuse', async () => {
  const temporary = mkdtempSync(
    join(tmpdir(), 'pappra-init-older-runtime-missing-'),
  );
  const workspace = join(temporary, 'workspace');
  const dataDir = join(temporary, 'data');
  const olderVersion = '0.0.7';
  try {
    createRepository(workspace);
    const choices = baseInitChoices({
      name: 'older runtime target',
      repositories: [],
      hosts: [],
    });
    const prepared = await planWorkspaceInit({
      root: workspace,
      choices,
      runtimeVersion: olderVersion,
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const configured = await applyInitPlan(prepared.bundle);
    assert.equal(configured.ok, true, JSON.stringify(configured));
    const choicesPath = join(temporary, 'choices.json');
    writeFileSync(choicesPath, `${JSON.stringify(choices, null, 2)}\n`);
    const environment = {
      PAPPRA_DATA_HOME: dataDir,
      npm_config_cache: join(temporary, 'npm-cache'),
      npm_config_offline: 'true',
    };
    const workspaceBefore = snapshotTree(workspace);

    const preview = invoke(
      ['init', '--config', choicesPath],
      workspace,
      environment,
    );
    assert.equal(preview.status, 0, preview.stderr);
    assert(
      preview.stdout.includes(
        'A verified runtime for this workspace target may still be reused.',
      ),
    );
    assert(
      preview.stdout.includes(
        'If no verified runtime can be reused, the current package source cannot satisfy this target',
      ),
    );
    assert(
      !preview.stdout.includes('the default runtime request will be rejected'),
    );
    assert.equal(existsSync(dataDir), false);
    assert.deepEqual(snapshotTree(workspace), workspaceBefore);

    const applied = invoke(
      ['init', '--config', choicesPath, '--apply', '--json'],
      workspace,
      environment,
    );
    assert.equal(applied.status, 1, applied.stderr);
    const result = parseJson(applied.stdout);
    assert.equal(result.ok, false);
    assert.equal(result.initComplete, false);
    const apply = result.apply;
    assert(typeof apply === 'object' && apply !== null);
    assert.equal((apply as Record<string, unknown>).ok, true);
    const runtime = result.runtime;
    assert(typeof runtime === 'object' && runtime !== null);
    assert.equal((runtime as Record<string, unknown>).status, 'failed');
    const diagnostics = (runtime as Record<string, unknown>).diagnostics;
    assert(Array.isArray(diagnostics));
    assert(
      diagnostics.some((diagnostic) =>
        String((diagnostic as Record<string, unknown>).message).includes(
          'does not match',
        ),
      ),
    );
    assert.equal(
      JSON.parse(
        readFileSync(join(workspace, '.pappra', 'workspace.json'), 'utf8'),
      ).runtimeVersion,
      olderVersion,
    );
    assert.equal(
      JSON.parse(
        readFileSync(
          join(workspace, '.pappra', 'local', 'machine.json'),
          'utf8',
        ),
      ).runtime,
      null,
    );
    const runtimeRoot = runtimePaths(olderVersion, dataDir).runtimeRoot;
    assert.equal(existsSync(runtimeRoot), false);
    assert.equal(existsSync(join(runtimeRoot, 'install-manifest.json')), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('explicit runtime-version mismatch still rejects before runtime installation', async () => {
  const temporary = mkdtempSync(
    join(tmpdir(), 'pappra-init-explicit-version-mismatch-'),
  );
  const workspace = join(temporary, 'workspace');
  const dataDir = join(temporary, 'data');
  try {
    createRepository(workspace);
    const targetVersion = getPackageInfo().version;
    const choices = baseInitChoices({
      name: 'current runtime target',
      repositories: [],
      hosts: [],
    });
    const prepared = await planWorkspaceInit({
      root: workspace,
      choices,
      runtimeVersion: targetVersion,
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const configured = await applyInitPlan(prepared.bundle);
    assert.equal(configured.ok, true, JSON.stringify(configured));
    const choicesPath = join(temporary, 'choices.json');
    writeFileSync(choicesPath, `${JSON.stringify(choices, null, 2)}\n`);

    const result = invoke(
      [
        'init',
        '--config',
        choicesPath,
        '--install-runtime',
        '--runtime-version',
        '0.0.7',
        '--apply',
        '--json',
      ],
      workspace,
      { PAPPRA_DATA_HOME: dataDir },
    );
    assert.equal(result.status, 1, result.stderr);
    const value = parseJson(result.stdout);
    assert.equal(value.ok, false);
    assert.equal(value.initComplete, false);
    const runtime = value.runtime;
    assert.equal(runtime, null);
    assert(
      (value.diagnostics as readonly Record<string, unknown>[]).some((entry) =>
        String(entry.message).includes(
          `Runtime version 0.0.7 does not match workspace target ${targetVersion}.`,
        ),
      ),
    );
    assert.equal(existsSync(dataDir), false);
    const machine = JSON.parse(
      readFileSync(join(workspace, '.pappra', 'local', 'machine.json'), 'utf8'),
    );
    assert.equal(machine.runtime, null);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('init --no-runtime previews and applies configuration without runtime work', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'pappra-init-no-runtime-'));
  const dataDir = join(temporary, 'pappra-data');
  try {
    const choices = join(temporary, 'choices.json');
    writeChoices(choices);
    const preview = invoke(
      ['init', '--config', choices, '--no-runtime'],
      temporary,
      { PAPPRA_DATA_HOME: dataDir },
    );
    assert.equal(preview.status, 0, preview.stderr);
    assert(
      preview.stdout.includes(
        'No runtime installation, verification or binding operation will run',
      ),
    );
    assert.equal(existsSync(dataDir), false);
    assert.equal(
      existsSync(join(temporary, '.pappra', 'workspace.json')),
      false,
    );

    const applied = invoke(
      ['init', '--config', choices, '--apply', '--no-runtime', '--json'],
      temporary,
      { PAPPRA_DATA_HOME: dataDir },
    );
    assert.equal(applied.status, 0, applied.stderr);
    const result = parseJson(applied.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.initComplete, false);
    assert.equal(result.runtime, null);
    assert(
      Array.isArray(result.nextActions) &&
        result.nextActions.some((action) =>
          String(action).includes('intentionally deferred by --no-runtime'),
        ),
    );
    const machine = JSON.parse(
      readFileSync(join(temporary, '.pappra', 'local', 'machine.json'), 'utf8'),
    );
    assert.equal(machine.runtime, null);
    assert.equal(existsSync(dataDir), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('default init preserves applied configuration and reports runtime lock residuals', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'pappra-init-runtime-locked-'));
  const workspace = join(temporary, 'workspace');
  const dataDir = join(temporary, 'data');
  try {
    createRepository(workspace);
    const version = getPackageInfo().version;
    const runtimeRoot = runtimePaths(version, dataDir).runtimeRoot;
    const lockPath = runtimePaths(version, dataDir).lockPath;
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, 'temporary runtime-lock fixture\n');
    const userDataBefore = snapshotTree(dataDir);
    const choices = join(temporary, 'choices.json');
    writeChoices(choices);

    const result = invoke(
      ['init', '--config', choices, '--apply', '--json'],
      workspace,
      { PAPPRA_DATA_HOME: dataDir },
    );
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const value = parseJson(result.stdout);
    assert.equal(value.ok, false);
    assert.equal(value.initComplete, false);
    const apply = value.apply;
    assert(typeof apply === 'object' && apply !== null);
    assert.equal((apply as Record<string, unknown>).ok, true);
    assert.deepEqual((apply as Record<string, unknown>).appliedFiles, [
      '.pappra/workspace.json',
      '.pappra/local/machine.json',
    ]);
    const runtime = value.runtime;
    assert(typeof runtime === 'object' && runtime !== null);
    assert.equal((runtime as Record<string, unknown>).status, 'locked');
    assert.deepEqual((runtime as Record<string, unknown>).residualPaths, [
      lockPath,
    ]);
    const machine = JSON.parse(
      readFileSync(join(workspace, '.pappra', 'local', 'machine.json'), 'utf8'),
    );
    assert.equal(machine.runtime, null);
    assert.equal(
      JSON.parse(
        readFileSync(join(workspace, '.pappra', 'workspace.json'), 'utf8'),
      ).name,
      'fixture workspace',
    );
    assert.equal(existsSync(runtimeRoot), false);
    assert.deepEqual(snapshotTree(dataDir), userDataBefore);

    const beforeHumanFailure = snapshotTree(workspace);
    const humanFailure = invoke(
      ['init', '--config', choices, '--apply'],
      workspace,
      { PAPPRA_DATA_HOME: dataDir },
    );
    assert.equal(humanFailure.status, 1, humanFailure.stderr);
    assert(humanFailure.stdout.includes('Runtime operation result: locked'));
    assert(
      humanFailure.stdout.includes('Existing workspace configuration reused.'),
    );
    assert(humanFailure.stderr.includes(`Runtime residual paths: ${lockPath}`));
    assert(
      humanFailure.stderr.includes(
        'workspace configuration state reported above remains in place',
      ),
    );
    assert.deepEqual(snapshotTree(workspace), beforeHumanFailure);
    assert.deepEqual(snapshotTree(dataDir), userDataBefore);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('default init preserves applied configuration when a corrupt runtime blocks completion', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'pappra-init-runtime-corrupt-'));
  const workspace = join(temporary, 'workspace');
  const dataDir = join(temporary, 'data');
  try {
    createRepository(workspace);
    const version = getPackageInfo().version;
    const runtimeRoot = runtimePaths(version, dataDir).runtimeRoot;
    mkdirSync(runtimeRoot, { recursive: true });
    const sentinel = join(runtimeRoot, 'partial-state.txt');
    writeFileSync(sentinel, 'preserve the corrupt runtime directory');
    const userDataBefore = snapshotTree(dataDir);
    const choices = join(temporary, 'choices.json');
    writeChoices(choices);

    const result = invoke(
      ['init', '--config', choices, '--apply', '--json'],
      workspace,
      { PAPPRA_DATA_HOME: dataDir },
    );
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const value = parseJson(result.stdout);
    assert.equal(value.ok, false);
    assert.equal(value.initComplete, false);
    const apply = value.apply;
    assert(typeof apply === 'object' && apply !== null);
    assert.equal((apply as Record<string, unknown>).ok, true);
    assert.deepEqual((apply as Record<string, unknown>).appliedFiles, [
      '.pappra/workspace.json',
      '.pappra/local/machine.json',
    ]);
    const runtime = value.runtime;
    assert(typeof runtime === 'object' && runtime !== null);
    assert.equal((runtime as Record<string, unknown>).status, 'corrupt');
    const appliedWorkspace = JSON.parse(
      readFileSync(join(workspace, '.pappra', 'workspace.json'), 'utf8'),
    );
    assert.equal(appliedWorkspace.name, 'fixture workspace');
    const machine = JSON.parse(
      readFileSync(join(workspace, '.pappra', 'local', 'machine.json'), 'utf8'),
    );
    assert.equal(machine.runtime, null);
    assert.equal(
      readFileSync(sentinel, 'utf8'),
      'preserve the corrupt runtime directory',
    );
    assert.equal(existsSync(join(runtimeRoot, 'install-manifest.json')), false);
    assert.deepEqual(snapshotTree(dataDir), userDataBefore);
    const beforeHumanFailure = snapshotTree(workspace);
    const humanFailure = invoke(
      ['init', '--config', choices, '--apply'],
      workspace,
      { PAPPRA_DATA_HOME: dataDir },
    );
    assert.equal(humanFailure.status, 1, humanFailure.stderr);
    assert(humanFailure.stdout.includes('Runtime operation result: corrupt'));
    assert(
      humanFailure.stdout.includes('Existing workspace configuration reused.'),
    );
    assert(
      humanFailure.stderr.includes(
        'configuration state reported above remains in place',
      ),
    );
    assert.deepEqual(snapshotTree(workspace), beforeHumanFailure);
    assert.deepEqual(snapshotTree(dataDir), userDataBefore);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('default runtime does not trust a bound regular executable when the runtime manifest is corrupt', () => {
  const temporary = mkdtempSync(
    join(tmpdir(), 'pappra-init-runtime-unverified-'),
  );
  const workspace = join(temporary, 'workspace');
  const dataDir = join(temporary, 'data');
  try {
    createRepository(workspace);
    const version = getPackageInfo().version;
    writeWorkspaceConfig(
      workspace,
      baseWorkspaceConfig({
        name: 'existing',
        runtimeVersion: version,
        repositories: [{ id: 'app', path: '.', access: 'write' }],
      }),
    );
    const runtimeRoot = runtimePaths(version, dataDir).runtimeRoot;
    mkdirSync(runtimeRoot, { recursive: true });
    const sentinel = join(runtimeRoot, 'partial-state.txt');
    writeFileSync(sentinel, 'preserve the corrupt runtime directory');
    const userDataBefore = snapshotTree(dataDir);
    const machinePath = writeMachineConfig(
      workspace,
      baseMachineConfig(workspace, {
        runtime: {
          version,
          executable: process.execPath,
          verifiedAt: '2026-10-17T00:00:00.000Z',
        },
      }),
    );
    const machineBefore = readFileSync(machinePath, 'utf8');
    const choices = join(temporary, 'choices.json');
    writeChoices(choices);

    const result = invoke(
      ['init', '--config', choices, '--apply', '--json'],
      workspace,
      { PAPPRA_DATA_HOME: dataDir },
    );
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const value = parseJson(result.stdout);
    assert.equal(value.ok, false);
    assert.equal(value.initComplete, false);
    const apply = value.apply;
    assert(typeof apply === 'object' && apply !== null);
    assert.equal((apply as Record<string, unknown>).ok, true);
    assert.equal((apply as Record<string, unknown>).status, 'no-changes');
    const runtime = value.runtime;
    assert(typeof runtime === 'object' && runtime !== null);
    assert.equal((runtime as Record<string, unknown>).status, 'corrupt');
    assert.equal(readFileSync(machinePath, 'utf8'), machineBefore);
    assert.equal(
      readFileSync(sentinel, 'utf8'),
      'preserve the corrupt runtime directory',
    );
    assert.equal(existsSync(join(runtimeRoot, 'install-manifest.json')), false);
    assert.deepEqual(snapshotTree(dataDir), userDataBefore);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('installs a verified local runtime and records it in machine.json', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'pappra-init-cli-runtime-'));
  const dataDir = join(temporary, 'data');
  try {
    const version = getPackageInfo().version;
    const businessPackage = join(temporary, 'package.json');
    writeFileSync(
      businessPackage,
      `${JSON.stringify({ name: 'business-project', private: true }, null, 2)}\n`,
    );
    const businessBefore = readFileSync(businessPackage, 'utf8');
    const tarball = createRuntimeTarball(temporary, {
      version,
      packageName: getPackageInfo().name,
    });
    const choices = join(temporary, 'choices.json');
    writeChoices(choices);
    const result = invoke(
      [
        'init',
        '--config',
        choices,
        '--apply',
        '--install-runtime',
        '--runtime-tarball',
        tarball,
        '--json',
      ],
      temporary,
      { PAPPRA_DATA_HOME: dataDir, npm_config_offline: 'true' },
    );
    assert.equal(
      result.status,
      0,
      `${result.stdout}
${result.stderr}`,
    );
    const value = parseJson(result.stdout);
    assert.equal(value.ok, true);
    assert.equal(value.initComplete, true);
    const runtime = value.runtime;
    assert(typeof runtime === 'object' && runtime !== null);
    assert.equal((runtime as Record<string, unknown>).status, 'installed');
    const machine = JSON.parse(
      readFileSync(join(temporary, '.pappra', 'local', 'machine.json'), 'utf8'),
    );
    assert.equal(machine.runtime.version, version);
    assert.equal(
      existsSync(join(dataDir, 'runtimes', version, 'install-manifest.json')),
      true,
    );
    assert.equal(readFileSync(businessPackage, 'utf8'), businessBefore);
    const beforeHumanRepeat = snapshotTree(temporary);
    const humanRepeat = invoke(
      [
        'init',
        '--config',
        choices,
        '--apply',
        '--install-runtime',
        '--runtime-tarball',
        tarball,
      ],
      temporary,
      { PAPPRA_DATA_HOME: dataDir, npm_config_offline: 'true' },
    );
    assert.equal(humanRepeat.status, 0, humanRepeat.stderr);
    assert(
      humanRepeat.stdout.includes(
        `Explicit tarball source: tarball ${tarball}`,
      ),
    );
    assert(
      humanRepeat.stdout.includes(runtimePaths(version, dataDir).runtimeRoot),
    );
    assert(humanRepeat.stdout.includes('Runtime operation result: reused'));
    assert.deepEqual(snapshotTree(temporary), beforeHumanRepeat);

    const repeated = invoke(
      ['init', '--config', choices, '--apply', '--json'],
      temporary,
      { PAPPRA_DATA_HOME: dataDir, npm_config_offline: 'true' },
    );
    assert.equal(repeated.status, 0, repeated.stderr);
    const repeatedValue = parseJson(repeated.stdout);
    assert('apply' in repeatedValue);
    const repeatedApply = repeatedValue.apply;
    assert(typeof repeatedApply === 'object' && repeatedApply !== null);
    assert.equal(
      (repeatedApply as Record<string, unknown>).status,
      'no-changes',
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('runtime flags require an explicit install request and source', () => {
  const temporary = mkdtempSync(
    join(tmpdir(), 'pappra-init-cli-runtime-invalid-'),
  );
  try {
    const choices = join(temporary, 'choices.json');
    writeChoices(choices);
    const missingInstall = invoke(
      [
        'init',
        '--config',
        choices,
        '--apply',
        '--runtime-tarball',
        'x.tgz',
        '--json',
      ],
      temporary,
    );
    assert.equal(missingInstall.status, 2);
    const missingSource = invoke(
      ['init', '--config', choices, '--apply', '--install-runtime', '--json'],
      temporary,
    );
    assert.equal(missingSource.status, 2);
    const missingApply = invoke(
      [
        'init',
        '--config',
        choices,
        '--install-runtime',
        '--runtime-version',
        '0.1.0',
        '--json',
      ],
      temporary,
    );
    assert.equal(missingApply.status, 2);
    assert.equal(
      existsSync(join(temporary, '.pappra', 'workspace.json')),
      false,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

interface DeterministicPath {
  readonly path: string;
  readonly directory: string;
}

/**
 * Prepends stubs that fail or report a fixed version so derived host and graph
 * selections do not depend on the machine running the suite. The rest of PATH is
 * preserved because discovery shells out to git.
 */
function deterministicPath(
  versions: { readonly claude?: string } = {},
): DeterministicPath {
  const directory = mkdtempSync(join(tmpdir(), 'pappra-init-bin-'));
  const stub = (name: string, body: string): void => {
    const file = join(directory, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  };
  stub('codegraph', 'exit 1');
  stub('codex', 'exit 1');
  stub('pi', 'exit 1');
  stub(
    'claude',
    versions.claude === undefined
      ? 'exit 1'
      : `echo "${versions.claude} (Claude Code)"`,
  );
  return {
    path: `${directory}:${process.env.PATH ?? ''}`,
    directory,
  };
}

function isolatedRepository(): string {
  const temporary = mkdtempSync(join(tmpdir(), 'pappra-init-derived-'));
  createRepository(temporary);
  writeFileSync(join(temporary, 'AGENTS.md'), '# agents\n');
  mkdirSync(join(temporary, 'docs'), { recursive: true });
  writeFileSync(join(temporary, 'docs', 'README.md'), '# docs\n');
  writeFileSync(
    join(temporary, 'package.json'),
    `${JSON.stringify({
      name: 'derived-fixture',
      scripts: { lint: 'true', typecheck: 'true', test: 'true', build: 'true' },
    })}\n`,
  );
  return temporary;
}

test('init --json without selections reports candidates and derived choices', () => {
  const temporary = isolatedRepository();
  const isolated = deterministicPath();
  try {
    const result = invoke(['init', '--json'], temporary, {
      PATH: isolated.path,
    });
    assert.equal(result.status, 1, result.stderr);
    const value = parseJson(result.stdout);
    assert.equal(value.ok, false);
    assert.equal(value.status, 'needs_input');
    const candidates = value.candidates as Record<string, unknown>;
    assert.deepEqual(candidates.repositories, ['.']);
    assert.equal(
      (candidates.knowledge as readonly string[]).includes('docs'),
      true,
    );
    const suggested = value.suggestedChoices as Record<string, unknown>;
    assert.equal(suggested.schema, 'pappra/init-choices/1');
    assert.deepEqual((suggested.knowledge as Record<string, unknown>).sources, [
      'AGENTS.md',
      'docs',
    ]);
    assert.deepEqual(suggested.validation, [
      'package-script:.:lint',
      'package-script:.:typecheck',
      'package-script:.:test',
    ]);
    assert.deepEqual(suggested.repositories, [{ path: '.', access: 'write' }]);
    assert.equal(existsSync(join(temporary, '.pappra')), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    rmSync(isolated.directory, { recursive: true, force: true });
  }
});

test('init --print-choices prints a round-trippable choices document', () => {
  const temporary = isolatedRepository();
  const isolated = deterministicPath({ claude: '2.1.292' });
  try {
    const printed = invoke(['init', '--print-choices'], temporary, {
      PATH: isolated.path,
    });
    assert.equal(printed.status, 0, printed.stderr);
    const choices = parseJson(printed.stdout);
    assert.equal(choices.schema, 'pappra/init-choices/1');
    assert.deepEqual(choices.hosts, ['claude']);
    assert.equal(existsSync(join(temporary, '.pappra')), false);
    const choicesPath = join(temporary, 'choices.json');
    writeFileSync(choicesPath, printed.stdout);

    const dataDir = join(temporary, 'pappra-data');
    const applied = invoke(
      ['init', '--config', choicesPath, '--apply', '--no-runtime', '--json'],
      temporary,
      { PATH: isolated.path, PAPPRA_DATA_HOME: dataDir },
    );
    assert.equal(applied.status, 0, applied.stderr);
    const appliedValue = parseJson(applied.stdout);
    assert.equal(appliedValue.ok, true);
    assert.equal(appliedValue.initComplete, false);
    assert.equal(appliedValue.runtime, null);
    assert.equal(existsSync(dataDir), false);
    assert.equal(
      (appliedValue.apply as Record<string, unknown>).status,
      'external-actions-pending',
    );
    const wrapped = invoke(['init', '--print-choices', '--json'], temporary, {
      PATH: isolated.path,
    });
    assert.equal(wrapped.status, 0, wrapped.stderr);
    const wrapper = parseJson(wrapped.stdout);
    assert.equal(wrapper.mode, 'choices');
    assert.equal(wrapper.ok, true);
    assert.equal(Array.isArray(wrapper.rules), true);
    assert.deepEqual((wrapper.candidates as Record<string, unknown>).hosts, [
      'claude',
    ]);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    rmSync(isolated.directory, { recursive: true, force: true });
  }
});

test('init --yes applies derived selections without a TTY', () => {
  const temporary = isolatedRepository();
  const isolated = deterministicPath();
  try {
    const applied = invoke(
      ['init', '--yes', '--apply', '--no-runtime', '--json'],
      temporary,
      {
        PATH: isolated.path,
        ...runtimeEnv(temporary),
      },
    );
    assert.equal(applied.status, 0, applied.stderr);
    const value = parseJson(applied.stdout);
    assert.equal(value.ok, true);
    assert.equal(value.initComplete, false);
    assert.equal(value.runtime, null);
    assert.equal(existsSync(join(temporary, 'pappra-data')), false);
    const workspace = JSON.parse(
      readFileSync(join(temporary, '.pappra', 'workspace.json'), 'utf8'),
    ) as Record<string, unknown>;
    const repositories = workspace.repositories as readonly Record<
      string,
      unknown
    >[];
    assert.equal(repositories.length, 1);
    assert.equal(repositories[0]?.path, '.');
    assert.equal(repositories[0]?.access, 'write');
    assert.deepEqual((workspace.knowledge as Record<string, unknown>).sources, [
      'AGENTS.md',
      'docs',
    ]);
    assert.deepEqual(workspace.code, {
      graph: 'none',
      symbols: 'auto',
      prepare: 'on-demand',
    });
    assert.equal((workspace.validation as readonly unknown[]).length, 3);
    const machine = JSON.parse(
      readFileSync(join(temporary, '.pappra', 'local', 'machine.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.deepEqual(machine.selectedHosts, []);
    assert.equal(machine.runtime, null);

    const repeated = invoke(
      ['init', '--yes', '--apply', '--no-runtime', '--json'],
      temporary,
      {
        PATH: isolated.path,
        ...runtimeEnv(temporary),
      },
    );
    assert.equal(repeated.status, 0, repeated.stderr);
    const repeatedValue = parseJson(repeated.stdout);
    assert.equal(repeatedValue.ok, true);
    assert.equal(repeatedValue.initComplete, false);
    assert.equal(repeatedValue.runtime, null);
    assert.equal(existsSync(join(temporary, 'pappra-data')), false);
    assert.equal(
      (repeatedValue.apply as Record<string, unknown>).status,
      'external-actions-pending',
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    rmSync(isolated.directory, { recursive: true, force: true });
  }
});

test('init rejects conflicting non-interactive selections', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'pappra-init-conflict-'));
  try {
    const both = invoke(
      ['init', '--yes', '--config', 'choices.json', '--json'],
      temporary,
    );
    assert.equal(both.status, 2, both.stderr);
    assert.equal(parseJson(both.stdout).status, 'invalid');

    const printApply = invoke(
      ['init', '--print-choices', '--apply', '--json'],
      temporary,
    );
    assert.equal(printApply.status, 2, printApply.stderr);
    assert.equal(parseJson(printApply.stdout).status, 'invalid');

    const otherCommand = invoke(['doctor', '--yes', '--json'], temporary);
    assert.equal(otherCommand.status, 2, otherCommand.stderr);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('init --reconfigure replaces a stale workspace config with a backup', () => {
  const temporary = isolatedRepository();
  const isolated = deterministicPath();
  const environment = { PATH: isolated.path, ...runtimeEnv(temporary) };
  try {
    const first = invoke(
      ['init', '--yes', '--apply', '--no-runtime', '--json'],
      temporary,
      environment,
    );
    assert.equal(first.status, 0, first.stderr);
    const firstValue = parseJson(first.stdout);
    assert.equal(firstValue.ok, true);
    assert.equal(firstValue.initComplete, false);
    assert.equal(firstValue.runtime, null);
    assert.equal(existsSync(join(temporary, 'pappra-data')), false);
    const workspacePath = join(temporary, '.pappra', 'workspace.json');
    const before = JSON.parse(readFileSync(workspacePath, 'utf8')) as Record<
      string,
      unknown
    >;
    const workspaceId = before.workspaceId;
    const edited = {
      ...before,
      runtimeVersion: '0.0.0-old',
      knowledge: {
        ...(before.knowledge as Record<string, unknown>),
        sources: [],
      },
    };
    writeFileSync(workspacePath, `${JSON.stringify(edited, null, 2)}\n`);

    const printedExisting = invoke(
      ['init', '--print-choices', '--reconfigure', '--json'],
      temporary,
      environment,
    );
    assert.equal(printedExisting.status, 0, printedExisting.stderr);
    const printedValue = parseJson(printedExisting.stdout);
    assert.equal(printedValue.mode, 'choices');
    const printedChoices = printedValue.choices as Record<string, unknown>;
    assert.equal(printedChoices.workspaceId, workspaceId);
    assert.deepEqual(
      (printedChoices.knowledge as Record<string, unknown>).sources,
      [],
    );

    const nonTty = invoke(
      ['init', '--reconfigure', '--json'],
      temporary,
      environment,
    );
    assert.equal(nonTty.status, 1, nonTty.stderr);
    const nonTtyValue = parseJson(nonTty.stdout);
    assert.equal(nonTtyValue.status, 'needs_input');
    assert.match(
      String(nonTtyValue.nextAction),
      /--print-choices --reconfigure/,
    );

    const reconfigured = invoke(
      ['init', '--yes', '--reconfigure', '--apply', '--no-runtime', '--json'],
      temporary,
      environment,
    );
    assert.equal(reconfigured.status, 0, reconfigured.stderr);
    const value = parseJson(reconfigured.stdout);
    assert.equal(value.ok, true);
    assert.equal(value.initComplete, false);
    assert.equal(value.runtime, null);
    assert.equal(existsSync(join(temporary, 'pappra-data')), false);
    assert.deepEqual((value.apply as Record<string, unknown>).appliedFiles, [
      '.pappra/workspace.json',
    ]);
    const after = JSON.parse(readFileSync(workspacePath, 'utf8')) as Record<
      string,
      unknown
    >;
    assert.equal(after.workspaceId, workspaceId);
    assert.equal(after.runtimeVersion, getPackageInfo().version);
    assert.deepEqual((after.knowledge as Record<string, unknown>).sources, []);
    assert.equal(
      existsSync(
        join(
          temporary,
          '.pappra',
          'local',
          'backups',
          String(value.plan !== undefined ? 'x' : 'x'),
        ),
      ),
      false,
    );
    const backups = readdirSync(join(temporary, '.pappra/local/backups'));
    assert.equal(backups.length >= 1, true);

    const repeated = invoke(
      ['init', '--yes', '--reconfigure', '--apply', '--no-runtime', '--json'],
      temporary,
      environment,
    );
    assert.equal(repeated.status, 0, repeated.stderr);
    const repeatedValue = parseJson(repeated.stdout);
    assert.equal(repeatedValue.ok, true);
    assert.equal(repeatedValue.initComplete, false);
    assert.equal(repeatedValue.runtime, null);
    assert.equal(existsSync(join(temporary, 'pappra-data')), false);
    assert.equal(
      (repeatedValue.apply as Record<string, unknown>).status,
      'external-actions-pending',
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    rmSync(isolated.directory, { recursive: true, force: true });
  }
});

test('init --config inspects explicit undiscovered paths without prompting or writing', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'pappra-init-explicit-config-'));
  try {
    const workspace = join(temporary, 'workspace');
    mkdirSync(workspace, { recursive: true });
    const repositoryPath = 'projects/one/two/three/explicit-repo';
    createRepository(join(workspace, repositoryPath));
    mkdirSync(join(workspace, 'notes', 'empty'), { recursive: true });
    const choicesPath = join(temporary, 'choices.json');
    writeFileSync(
      choicesPath,
      `${JSON.stringify(
        baseInitChoices({
          repositories: [{ path: repositoryPath, access: 'read' }],
          knowledge: {
            sources: ['notes/empty'],
            newDocuments: '.pappra/knowledge',
            taskVisibility: 'private',
          },
        }),
        null,
        2,
      )}\n`,
    );
    const before = snapshotTree(workspace);

    const result = invoke(
      ['init', '--config', choicesPath, '--no-runtime', '--json'],
      workspace,
      runtimeEnv(temporary),
    );
    assert.equal(result.status, 0, result.stderr);
    const value = parseJson(result.stdout);
    assert.equal(value.ok, true);
    const scope = value.scope as {
      readonly repositories: readonly { readonly path: string }[];
      readonly knowledge: { readonly sources: readonly string[] };
    };
    assert.equal(scope.repositories[0]?.path, repositoryPath);
    assert.deepEqual(scope.knowledge.sources, ['notes/empty']);
    assert.deepEqual(snapshotTree(workspace), before);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
