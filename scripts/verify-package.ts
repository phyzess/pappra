import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { npmCli, pnpmCommand, projectRoot, runNode } from './project.js';
import { testSubprocessEnvironment } from './test-environment.js';

const temporary = mkdtempSync(join(tmpdir(), 'pappra-package-'));
try {
  const npm = npmCli();
  const packed = spawnSync(
    process.execPath,
    [
      npm,
      'pack',
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      temporary,
    ],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      shell: false,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      env: testSubprocessEnvironment(),
    },
  );
  if (packed.error) throw packed.error;
  assert.equal(packed.status, 0, packed.stderr);
  const report: unknown = JSON.parse(packed.stdout);
  assert(Array.isArray(report) && report.length === 1);
  const entry: unknown = report[0];
  assert(typeof entry === 'object' && entry !== null);
  assert('filename' in entry && typeof entry.filename === 'string');
  assert.equal(basename(entry.filename), entry.filename);
  assert('files' in entry && Array.isArray(entry.files));
  const files = entry.files.map((file: unknown) => {
    assert(typeof file === 'object' && file !== null);
    assert('path' in file && typeof file.path === 'string');
    return file.path;
  });
  assert(files.includes('dist/cli/main.js'));
  assert(files.includes('dist/index.d.ts'));
  // The beta publishes a deliberately compact map: core subpaths plus one
  // curated experimental barrel and its Pi adapter. Nothing points at the
  // internal `src/app` layout, and no per-surface collaboration or managed-Pi
  // path exists merely so an older beta import keeps working.
  const manifest = JSON.parse(
    readFileSync(join(projectRoot, 'package.json'), 'utf8'),
  ) as { readonly exports: Record<string, unknown> };
  const exportTarget = (key: string): string => {
    const entry = manifest.exports[key];
    assert(entry !== undefined, `Missing package export: ${key}`);
    if (typeof entry === 'string') return entry;
    assert(typeof entry === 'object' && entry !== null);
    assert('import' in entry && typeof entry.import === 'string');
    return entry.import;
  };
  const CORE_SUBPATHS = [
    '.',
    './workspace',
    './knowledge',
    './continuity',
    './code',
    './schemas',
    './install',
    './hosts',
    './init',
    './doctor',
    './collab',
    './experimental',
    './experimental/pi',
    './package.json',
  ];
  assert(
    Object.keys(manifest.exports).length <= 14,
    'The published export map must stay at or below 14 subpaths.',
  );
  assert.deepEqual(
    Object.keys(manifest.exports).sort(),
    [...CORE_SUBPATHS].sort(),
    'The published export map must match the compact beta contract exactly.',
  );
  for (const key of CORE_SUBPATHS) {
    const target = exportTarget(key);
    assert(
      !target.startsWith('./dist/app/'),
      `${key} must not expose the internal src/app layout.`,
    );
    assert(
      !/^\.\/dist\/hosts\/(?:pi|integration)\//.test(target),
      `${key} must not expose the internal src/hosts layout.`,
    );
  }
  for (const key of CORE_SUBPATHS) {
    const target = exportTarget(key);
    if (!target.startsWith('./dist/')) continue;
    const modulePath = target.slice('./'.length);
    assert(
      files.includes(modulePath),
      `Missing published module: ${modulePath}`,
    );
    assert(
      files.includes(modulePath.replace(/\.js$/, '.d.ts')),
      `Missing published types: ${modulePath}`,
    );
  }
  for (const file of [
    'dist/hosts/integration/pappra-recovery-extension.mjs',
    'dist/hosts/integration/pappra-session-transition-extension.mjs',
    'dist/adapters/pi/recovery-extension.js',
    'dist/adapters/pi/session-transition-extension.js',
  ])
    assert(files.includes(file), `Missing public host artifact: ${file}`);
  assert(files.includes('assets/manifest.json'));
  assert(files.includes('assets/integrations/skills/pappra/SKILL.md'));
  assert(
    files.includes('assets/integrations/skills/pappra/references/lifecycle.md'),
  );
  assert(files.includes('skills/pappra/SKILL.md'));
  assert(files.includes('skills/pappra/references/operations.md'));
  assert(
    files.every((file) =>
      /^(?:dist\/|assets\/|skills\/|package\.json$|README(?:\.zh-CN)?\.md$|LICENSE$|THIRD_PARTY_NOTICES\.md$)/.test(
        file,
      ),
    ),
    'Unexpected source, configuration or private files in the tarball.',
  );
  for (const file of files.filter((file) => file.endsWith('.map'))) {
    assert(
      !readFileSync(join(projectRoot, file), 'utf8').includes(projectRoot),
    );
  }
  for (const file of files) {
    const content = readFileSync(join(projectRoot, file), 'utf8');
    for (const forbidden of [projectRoot, '/Users/', '/home/']) {
      assert(
        !content.includes(forbidden),
        `Tarball file ${file} contains a development-machine/private path.`,
      );
    }
  }

  const consumer = join(temporary, 'consumer with spaces');
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({
      name: 'pappra-package-consumer',
      private: true,
      type: 'module',
    }),
  );
  const pnpm = pnpmCommand();
  const tarballPath = join(temporary, entry.filename);
  const installTarball = (offline: boolean) =>
    spawnSync(
      pnpm.executable,
      [
        ...pnpm.args,
        'add',
        ...(offline ? ['--offline'] : []),
        '--ignore-scripts',
        '--config.package-manager-strict=false',
        tarballPath,
      ],
      {
        cwd: consumer,
        encoding: 'utf8',
        shell: false,
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
        env: testSubprocessEnvironment(),
      },
    );
  let installedResult = installTarball(true);
  if (installedResult.error) throw installedResult.error;
  if (installedResult.status !== 0) {
    // The offline metadata mirror is warmed per runner and per operating system,
    // so a cold CI runner can fail resolution even though the tarball itself is
    // complete. Retry once against the registry instead of reporting a false
    // packaging failure.
    console.log(
      'Offline tarball install lacked registry metadata; retrying with resolution.',
    );
    installedResult = installTarball(false);
    if (installedResult.error) throw installedResult.error;
  }
  assert.equal(
    installedResult.status,
    0,
    `pnpm add failed:\n${installedResult.stdout}\n${installedResult.stderr}`,
  );
  const installed = join(consumer, 'node_modules/@phyzess/pappra');
  const metadata: unknown = JSON.parse(
    readFileSync(join(installed, 'package.json'), 'utf8'),
  );
  assert(typeof metadata === 'object' && metadata !== null);
  assert('version' in metadata && typeof metadata.version === 'string');
  const version = spawnSync(
    process.execPath,
    [join(installed, 'dist/cli/main.js'), '--version', '--json'],
    {
      cwd: consumer,
      encoding: 'utf8',
      shell: false,
      timeout: 10_000,
      env: testSubprocessEnvironment(),
    },
  );
  if (version.error) throw version.error;
  assert.equal(version.status, 0, version.stderr);
  const result: unknown = JSON.parse(version.stdout);
  assert(typeof result === 'object' && result !== null);
  assert('version' in result && result.version === metadata.version);
  copyFileSync(
    join(projectRoot, '.build/scripts/scripts/fixtures/consumer.js'),
    join(consumer, 'consumer.js'),
  );
  runNode(
    ['consumer.js', metadata.version],
    consumer,
    360_000,
    testSubprocessEnvironment(),
  );
  const collaborationConsumer = join(consumer, 'collaboration-consumer.mjs');
  writeFileSync(
    collaborationConsumer,
    [
      "import * as root from '@phyzess/pappra';",
      "import * as collabSurface from '@phyzess/pappra/collab';",
      "import * as experimental from '@phyzess/pappra/experimental';",
      "import * as pi from '@phyzess/pappra/experimental/pi';",
      "import * as hostsSurface from '@phyzess/pappra/hosts';",
      "import { KnowledgeService } from '@phyzess/pappra/knowledge';",
      'const { validateWorkPlan, evaluateWorkPlan } = collabSurface.workPlan;',
      'const { inspectWorkPlan } = experimental.collabWorkPlanInspection;',
      'const { runWorkExecution } = experimental.collabWorkExecution;',
      'const { inspectRecovery } = experimental.collabRecovery;',
      'const { executeRecovery } = experimental.collabRecoveryExecutor;',
      'const { validateSessionTransitionRequest } = experimental.collabSessionTransition;',
      'const { admitLaunch } = experimental.collabAdmission;',
      'for (const value of [validateWorkPlan, evaluateWorkPlan, inspectWorkPlan, runWorkExecution, inspectRecovery, executeRecovery, validateSessionTransitionRequest, admitLaunch]) {',
      '  if (typeof value !== "function") throw new Error("public collaboration API missing");',
      '}',
      'if ("collabWorkExecution" in root || "collabRecoveryExecutor" in root || "collabSessionTransition" in root || "collaboration" in root || "managedPi" in root) throw new Error("stable root still exposes automation");',
      'if (typeof root.getPackageInfo !== "function" || typeof root.HostIntegrationService !== "function") throw new Error("root core surface missing");',
      'if ("piManaged" in hostsSurface || "piManagedSdk" in hostsSurface || "piRecovery" in hostsSurface || "piSessionTransition" in hostsSurface) throw new Error("stable hosts barrel still exposes managed or extension namespaces");',
      'if (!experimental.collabWorkPlan || typeof experimental.collabWorkPlan.validateWorkPlan !== "function") throw new Error("experimental work plan namespace missing");',
      'if (!experimental.collabRolePlan.expandRolePlan) throw new Error("role plan namespace missing");',
      'for (const name of ["planPrepare", "applyPrepare", "applyDispatch", "applyParticipant", "applyAccept", "inspectWorkflow"]) if (typeof experimental.collabWorkflow?.[name] !== "function") throw new Error(`workflow API missing: ${name}`);',
      'for (const name of ["previewReview", "applyReview"]) if (typeof KnowledgeService.prototype[name] !== "function") throw new Error(`document review API missing: ${name}`);',
      'if (!experimental.collabRecoveryProjection || !experimental.collabAutomaticHandoff) throw new Error("recovery projection namespace missing");',
      'if (pi.piRecovery.PI_RECOVERY_CONFIG_SCHEMA !== "pappra/pi-recovery-config/1") throw new Error("recovery host export missing");',
      'if (pi.piSessionTransition.PI_SESSION_TRANSITION_EXTENSION_ID !== "pappra/pi-session-transition-host/1") throw new Error("transition host export missing");',
      'if (!pi.piManaged.startManagedPiSession || !pi.piManagedSdk.startManagedPiSdkSession) throw new Error("managed Pi adapter missing");',
      'if ("breakLock" in collabSurface.store) throw new Error("unsafe store.breakLock is public");',
      'const removed = [',
      '  "@phyzess/pappra/collaboration",',
      '  "@phyzess/pappra/collab/recovery",',
      '  "@phyzess/pappra/collab/recovery-executor",',
      '  "@phyzess/pappra/collab/work-plan",',
      '  "@phyzess/pappra/collab/admission",',
      '  "@phyzess/pappra/hosts/pi-managed",',
      '  "@phyzess/pappra/hosts/pi-recovery",',
      '];',
      'for (const specifier of removed) {',
      '  let code = null;',
      '  try {',
      '    await import(specifier);',
      '  } catch (error) {',
      '    code = error && typeof error === "object" && "code" in error ? error.code : null;',
      '  }',
      '  if (code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw new Error(`removed subpath still resolves: ${specifier} (${code})`);',
      '}',
    ].join('\n'),
  );
  runNode(
    ['collaboration-consumer.mjs'],
    consumer,
    360_000,
    testSubprocessEnvironment(),
  );

  const lifecycleRoot = join(temporary, 'installed workspace ünicode');
  const lifecycleHome = join(temporary, 'fixture home');
  for (const directory of [
    lifecycleRoot,
    lifecycleHome,
    join(lifecycleHome, 'config'),
    join(lifecycleHome, 'data'),
    join(lifecycleHome, 'state'),
  ])
    mkdirSync(directory, { recursive: true });
  const choicesPath = join(lifecycleRoot, 'init-choices.json');
  writeFileSync(
    choicesPath,
    `${JSON.stringify({
      schema: 'pappra/init-choices/1',
      name: 'installed fixture workspace ünicode',
      workspaceId: randomUUID(),
      repositories: [],
      knowledge: {
        sources: [],
        newDocuments: '.pappra/knowledge',
        taskVisibility: 'private',
      },
      code: { graph: 'none', symbols: 'auto', prepare: 'on-demand' },
      validation: [],
      excludes: [],
      hosts: [],
    })}\n`,
  );
  const installedCli = join(installed, 'dist/cli/main.js');
  assert.equal(installedCli.includes(projectRoot), false);
  const lifecycleEnv: NodeJS.ProcessEnv = testSubprocessEnvironment({
    HOME: lifecycleHome,
    XDG_CONFIG_HOME: join(lifecycleHome, 'config'),
    XDG_DATA_HOME: join(lifecycleHome, 'data'),
    XDG_STATE_HOME: join(lifecycleHome, 'state'),
  });
  const runInstalled = (args: readonly string[]) =>
    spawnSync(process.execPath, [installedCli, ...args], {
      cwd: lifecycleRoot,
      encoding: 'utf8',
      shell: false,
      timeout: 90_000,
      env: lifecycleEnv,
    });
  const parseInstalled = (output: string): Record<string, unknown> => {
    const decoded: unknown = JSON.parse(output);
    assert(typeof decoded === 'object' && decoded !== null);
    return decoded as Record<string, unknown>;
  };
  const recoveryConfigPath = join(temporary, 'installed-recovery-config.json');
  const recoveryConfig = {
    schema: 'pappra/pi-recovery-config/1',
    taskRoot: lifecycleRoot,
    planFile: join(lifecycleRoot, '.pappra', 'work-plan.json'),
    self: {
      agent_id: 'installed-writer',
      session_id: 'installed-session',
      harness: 'pi',
    },
    policy: { role: 'writer' },
    expected: {
      session_id: 'installed-session',
      cwd: lifecycleRoot,
      binding_ref: join(lifecycleRoot, '.pappra', 'binding.json'),
      binding_digest: `sha256:${'b'.repeat(64)}`,
      pane_id: 'w3:p1',
      harness: 'pi',
    },
    mode: 'plan',
    target: { agent: 'installed-writer' },
    requestId: 'installed-recovery-smoke',
  };
  writeFileSync(
    recoveryConfigPath,
    `${JSON.stringify(recoveryConfig, null, 2)}\n`,
  );
  const collaborationBundlePath = join(
    temporary,
    'installed collaboration bundle',
  );
  const collaborationBundle = runInstalled([
    'host',
    'bundle',
    '--host',
    'pi',
    '--host-version',
    '1.3.0',
    '--out',
    collaborationBundlePath,
    '--recovery-config',
    recoveryConfigPath,
    '--transition-extension',
    '--json',
  ]);
  if (collaborationBundle.error) throw collaborationBundle.error;
  assert.equal(collaborationBundle.status, 0, collaborationBundle.stderr);
  const collaborationBundleResult = parseInstalled(collaborationBundle.stdout);
  assert.equal(collaborationBundleResult.ok, true);
  const collaborationManifest = JSON.parse(
    readFileSync(join(collaborationBundlePath, 'package.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.deepEqual(
    (collaborationManifest['pi'] as Record<string, unknown>)['extensions'],
    [
      './extensions/pappra-recovery/index.ts',
      './extensions/pappra-session-transition/index.ts',
    ],
  );
  assert.equal(
    readFileSync(
      join(collaborationBundlePath, 'extensions/pappra-recovery/recovery.json'),
      'utf8',
    ),
    `${JSON.stringify(recoveryConfig, null, 2)}\n`,
  );
  assert.equal(
    existsSync(
      join(
        collaborationBundlePath,
        'extensions/pappra-session-transition/runtime.mjs',
      ),
    ),
    true,
  );
  console.log('Installed opt-in recovery/transition bundle smoke passed.');
  assert.equal(
    statSync(
      join(collaborationBundlePath, 'extensions/pappra-recovery/recovery.json'),
    ).mode & 0o777,
    0o600,
  );
  const userSentinel = Buffer.from('pre-init user-owned content\n', 'utf8');
  const sentinelPath = join(lifecycleRoot, 'user-sentinel.txt');
  writeFileSync(sentinelPath, userSentinel);
  const init = runInstalled([
    'init',
    '--config',
    choicesPath,
    '--apply',
    '--no-runtime',
    '--json',
  ]);
  if (init.error) throw init.error;
  assert.equal(init.status, 0, init.stderr);
  const initValue = parseInstalled(init.stdout);
  assert.equal(initValue.ok, true);
  assert.equal(initValue.initComplete, false);
  const installedApply = initValue.apply;
  assert(typeof installedApply === 'object' && installedApply !== null);
  assert.equal(
    (installedApply as Record<string, unknown>).status,
    'external-actions-pending',
  );
  assert.deepEqual(readFileSync(sentinelPath), userSentinel);
  const workspacePath = join(lifecycleRoot, '.pappra', 'workspace.json');
  const machinePath = join(lifecycleRoot, '.pappra', 'local', 'machine.json');
  const workspaceAfterInit = readFileSync(workspacePath);
  const machineAfterInit = readFileSync(machinePath);
  const repeatPlan = runInstalled(['init', '--config', choicesPath, '--json']);
  if (repeatPlan.error) throw repeatPlan.error;
  assert([0, 1].includes(repeatPlan.status ?? -1), repeatPlan.stderr);
  assert.equal(parseInstalled(repeatPlan.stdout).ok, true);
  assert.deepEqual(readFileSync(sentinelPath), userSentinel);
  assert.deepEqual(readFileSync(workspacePath), workspaceAfterInit);
  assert.deepEqual(readFileSync(machinePath), machineAfterInit);
  const doctor = runInstalled(['doctor', '--json']);
  if (doctor.error) throw doctor.error;
  assert([0, 1].includes(doctor.status ?? -1), doctor.stderr);
  const doctorValue = parseInstalled(doctor.stdout);
  assert.equal(doctorValue.schema, 'pappra/doctor-report/1');
  const checkpoint = runInstalled([
    'checkpoint',
    '--task',
    'installed-lifecycle',
    '--objective',
    'Installed package lifecycle',
    '--acceptance',
    'Resume remains advisory',
    '--decision',
    'Use installed artifacts',
    '--next-action',
    'Review resume packet',
    '--author-session',
    'installed-session',
    '--native-session',
    'installed-session',
    '--context-completeness',
    'complete',
    '--json',
  ]);
  if (checkpoint.error) throw checkpoint.error;
  assert.equal(checkpoint.status, 0, checkpoint.stderr);
  const checkpointValue = parseInstalled(checkpoint.stdout);
  assert.equal(checkpointValue.schema, 'pappra/checkpoint-result/1');
  const resume = runInstalled([
    'resume',
    'installed-lifecycle',
    '--session',
    'installed-session',
    '--json',
  ]);
  if (resume.error) throw resume.error;
  assert([0, 1].includes(resume.status ?? -1), resume.stderr);
  const resumeValue = parseInstalled(resume.stdout);
  assert.equal(resumeValue.schema, 'pappra/resume-packet/1');
  assert.equal(resumeValue.executionAllowed, false);

  const runtimeDataDir = join(temporary, 'runtime data');
  const runtimeEnvironment: NodeJS.ProcessEnv = testSubprocessEnvironment(
    {
      PAPPRA_DATA_HOME: runtimeDataDir,
    },
    { allowPappra: ['PAPPRA_DATA_HOME'] },
  );
  const runRuntime = (args: readonly string[]) =>
    spawnSync(process.execPath, [installedCli, ...args], {
      cwd: lifecycleRoot,
      encoding: 'utf8',
      shell: false,
      timeout: 240_000,
      env: runtimeEnvironment,
    });
  const runtimeInstall = runRuntime([
    'runtime',
    'install',
    '--apply',
    '--json',
  ]);
  if (runtimeInstall.error) throw runtimeInstall.error;
  assert.equal(
    runtimeInstall.status,
    0,
    `${runtimeInstall.stdout}\n${runtimeInstall.stderr}`,
  );
  const runtimeValue = parseInstalled(runtimeInstall.stdout);
  assert.equal(runtimeValue.ok, true);
  assert.equal(
    (runtimeValue.runtime as Record<string, unknown>).status,
    'installed',
  );
  const runtimeStatus = runRuntime(['runtime', 'status', '--json']);
  if (runtimeStatus.error) throw runtimeStatus.error;
  assert.equal(runtimeStatus.status, 0, runtimeStatus.stderr);
  const runtimeState = parseInstalled(runtimeStatus.stdout).runtime as Record<
    string,
    unknown
  >;
  assert.equal(runtimeState.status, 'content-match');
  assert.equal(runtimeState.source, 'self');
  console.log(
    'Installed runtime self-install passed (durable copy, no checkout).',
  );
  const cleanupScript = join(consumer, 'cleanup-managed.mjs');
  writeFileSync(
    cleanupScript,
    [
      "import {readFileSync, writeFileSync} from 'node:fs';",
      "const install = await import('@phyzess/pappra/install');",
      'const root = process.argv[2];',
      'const mode = process.argv[3];',
      "if (mode === 'edited') {",
      '  const file = `${root}/.pappra/workspace.json`;',
      "  writeFileSync(file, `${readFileSync(file, 'utf8')} `);",
      '}',
      'const result = await install.uninstallWorkspaceManagedFiles({root});',
      'console.log(JSON.stringify(result));',
      '',
    ].join('\n'),
  );
  const runCleanup = (
    root: string,
    mode: 'normal' | 'edited',
  ): Record<string, unknown> => {
    const cleaned = spawnSync(process.execPath, [cleanupScript, root, mode], {
      cwd: consumer,
      encoding: 'utf8',
      shell: false,
      timeout: 90_000,
      env: lifecycleEnv,
    });
    if (cleaned.error) throw cleaned.error;
    assert.equal(cleaned.status, 0, cleaned.stderr);
    return parseInstalled(cleaned.stdout);
  };
  const normalCleanup = runCleanup(lifecycleRoot, 'normal');
  assert.equal(normalCleanup.status, 'uninstalled');
  assert.equal(
    existsSync(join(lifecycleRoot, '.pappra/workspace.json')),
    false,
  );
  assert.equal(
    existsSync(join(lifecycleRoot, '.pappra/local/machine.json')),
    false,
  );
  assert.deepEqual(readFileSync(sentinelPath), userSentinel);

  const editedRoot = join(temporary, 'installed edited workspace ünicode');
  mkdirSync(editedRoot);
  const editedSentinelPath = join(editedRoot, 'user-sentinel.txt');
  writeFileSync(editedSentinelPath, userSentinel);
  const editedInit = spawnSync(
    process.execPath,
    [
      installedCli,
      'init',
      '--config',
      choicesPath,
      '--apply',
      '--no-runtime',
      '--json',
    ],
    {
      cwd: editedRoot,
      encoding: 'utf8',
      shell: false,
      timeout: 90_000,
      env: lifecycleEnv,
    },
  );
  if (editedInit.error) throw editedInit.error;
  assert.equal(editedInit.status, 0, editedInit.stderr);
  assert.equal(parseInstalled(editedInit.stdout).ok, true);
  assert.deepEqual(readFileSync(editedSentinelPath), userSentinel);
  const editedWorkspacePath = join(editedRoot, '.pappra', 'workspace.json');
  const editedWorkspaceBefore = readFileSync(editedWorkspacePath);
  const editedCleanup = runCleanup(editedRoot, 'edited');
  assert.equal(editedCleanup.status, 'partial');
  assert.equal(
    (editedCleanup.residualPaths as unknown[]).includes(
      '.pappra/workspace.json',
    ),
    true,
  );
  assert.equal(existsSync(join(editedRoot, '.pappra/workspace.json')), true);
  assert.equal(
    existsSync(join(editedRoot, '.pappra/local/machine.json')),
    false,
  );
  assert.deepEqual(readFileSync(editedSentinelPath), userSentinel);
  assert.deepEqual(
    readFileSync(editedWorkspacePath),
    Buffer.concat([editedWorkspaceBefore, Buffer.from(' ')]),
  );
  console.log(
    'Installed managed cleanup passed (owned removal, edited-file residual, user-content preservation).',
  );
  console.log(
    'Installed workspace lifecycle passed (init/doctor/checkpoint/resume; spaces/Unicode; fixture HOME/XDG).',
  );
  assert(
    readFileSync(join(installed, 'dist/cli/main.js'), 'utf8').startsWith(
      '#!/usr/bin/env node\n',
    ),
  );
  if (process.platform !== 'win32') {
    const executable = spawnSync(
      join(consumer, 'node_modules/.bin/pappra'),
      ['--help'],
      {
        cwd: consumer,
        encoding: 'utf8',
        shell: false,
        timeout: 10_000,
        env: testSubprocessEnvironment(),
      },
    );
    if (executable.error) throw executable.error;
    assert.equal(executable.status, 0, executable.stderr);
    assert.match(executable.stdout, /Usage:/);
    assert.match(executable.stdout, /init/);
    assert.match(executable.stdout, /doctor/);
  }
  const selectedRealProject =
    process.env['PAPPRA_VALIDATION_REAL_PROJECT'] ?? projectRoot;
  const selectedProjectWorkspace = join(
    temporary,
    'read-only selected project workspace',
  );
  const selectedProjectHome = join(
    temporary,
    'read-only selected project home',
  );
  const selectedProjectData = join(
    temporary,
    'read-only selected project data',
  );
  const selectedProjectState = join(
    temporary,
    'read-only selected project state',
  );
  for (const directory of [
    selectedProjectWorkspace,
    selectedProjectHome,
    selectedProjectData,
    selectedProjectState,
    join(selectedProjectWorkspace, '.pappra', 'local'),
    join(selectedProjectWorkspace, 'notes'),
  ])
    mkdirSync(directory, { recursive: true });
  const selectedProjectEnv: NodeJS.ProcessEnv = {
    ...lifecycleEnv,
    HOME: selectedProjectHome,
    XDG_CONFIG_HOME: join(selectedProjectHome, 'config'),
    XDG_DATA_HOME: selectedProjectData,
    XDG_STATE_HOME: selectedProjectState,
    PAPPRA_DATA_HOME: selectedProjectData,
  };
  const selectedWorkspaceId = randomUUID();
  writeFileSync(
    join(selectedProjectWorkspace, '.pappra', 'local', 'machine.json'),
    `${JSON.stringify(
      {
        schema: 'pappra/machine/1',
        workspaceRealpath: realpathSync(selectedProjectWorkspace),
        checkoutId: randomUUID(),
        externalRepositories: [{ id: 'pappra', path: selectedRealProject }],
        selectedHosts: [],
        runtime: null,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(selectedProjectWorkspace, '.pappra', 'workspace.json'),
    `${JSON.stringify(
      {
        schema: 'pappra/workspace/1',
        workspaceId: selectedWorkspaceId,
        name: 'read-only selected project workspace',
        runtimeVersion: metadata.version,
        repositories: [
          { id: 'pappra', path: 'external:pappra', access: 'read' },
        ],
        knowledge: {
          sources: ['notes'],
          newDocuments: '.pappra/knowledge',
          taskVisibility: 'private',
        },
        code: { graph: 'none', symbols: 'none', prepare: 'manual' },
        validation: [],
        excludes: [],
        extensions: {},
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(selectedProjectWorkspace, 'notes', 'existing.md'),
    '# Existing private knowledge\n\nIsolated package verification fixture.\n',
  );
  const selectedChoicesPath = join(temporary, 'read-only-project-choices.json');
  const selectedChoices = {
    schema: 'pappra/init-choices/1',
    name: 'read-only selected project workspace',
    workspaceId: selectedWorkspaceId,
    repositories: [{ id: 'pappra', path: 'external:pappra', access: 'read' }],
    knowledge: {
      sources: ['notes'],
      newDocuments: '.pappra/knowledge',
      taskVisibility: 'private',
    },
    code: { graph: 'none', symbols: 'auto', prepare: 'on-demand' },
    validation: [],
    excludes: [],
    hosts: [],
  };
  const reconfiguredChoices = {
    ...selectedChoices,
    name: 'read-only selected project reconfigured',
  };
  writeFileSync(
    selectedChoicesPath,
    `${JSON.stringify(reconfiguredChoices, null, 2)}\n`,
  );
  const sourceStatusBefore = spawnSync('git', ['status', '--porcelain'], {
    cwd: selectedRealProject,
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
    env: testSubprocessEnvironment(),
  });
  if (sourceStatusBefore.error) throw sourceStatusBefore.error;
  assert.equal(sourceStatusBefore.status, 0, sourceStatusBefore.stderr);
  const sourcePackageBytes = readFileSync(
    join(selectedRealProject, 'package.json'),
  );
  const runSelectedProject = (args: readonly string[], timeoutMs = 90_000) =>
    spawnSync(process.execPath, [installedCli, ...args], {
      cwd: selectedProjectWorkspace,
      encoding: 'utf8',
      shell: false,
      timeout: timeoutMs,
      env: selectedProjectEnv,
    });
  const runSelectedProjectOk = (
    args: readonly string[],
    timeoutMs = 90_000,
  ): Record<string, unknown> => {
    const result = runSelectedProject(args, timeoutMs);
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return parseInstalled(result.stdout);
  };
  const workspaceConfigPath = join(
    selectedProjectWorkspace,
    '.pappra',
    'workspace.json',
  );
  const workspaceConfigBefore = readFileSync(workspaceConfigPath);
  const selectedPlanResult = runSelectedProject([
    'init',
    '--config',
    selectedChoicesPath,
    '--reconfigure',
    '--no-runtime',
    '--json',
  ]);
  if (selectedPlanResult.error) throw selectedPlanResult.error;
  assert([0, 1].includes(selectedPlanResult.status ?? -1));
  assert.equal(parseInstalled(selectedPlanResult.stdout).ok, true);
  assert.deepEqual(readFileSync(workspaceConfigPath), workspaceConfigBefore);
  const selectedPlan = parseInstalled(selectedPlanResult.stdout);
  assert.equal(selectedPlan.ok, true);
  const selectedScope = selectedPlan.scope as {
    readonly workspaceRoot: string;
    readonly repositories: readonly { readonly path: string }[];
  };
  assert.equal(
    selectedScope.workspaceRoot,
    realpathSync(selectedProjectWorkspace),
  );
  assert.equal(selectedScope.repositories[0]?.path, 'external:pappra');
  assert.deepEqual(readFileSync(workspaceConfigPath), workspaceConfigBefore);
  runSelectedProjectOk(['docs', 'scan', '--apply', '--json']);
  const listedKnowledge = runSelectedProjectOk([
    'docs',
    'list',
    '--include-private',
    '--json',
  ]);
  assert(JSON.stringify(listedKnowledge).includes('existing.md'));
  const newDocument = join(
    selectedProjectWorkspace,
    '.pappra',
    'knowledge',
    'authored-during-verification.md',
  );
  mkdirSync(dirname(newDocument), { recursive: true });
  writeFileSync(newDocument, '# New isolated knowledge\n');
  const repositoryStatus = runSelectedProject([
    'code',
    'status',
    '--repo',
    'pappra',
    '--json',
  ]);
  if (repositoryStatus.error) throw repositoryStatus.error;
  assert([0, 1].includes(repositoryStatus.status ?? -1));
  parseInstalled(repositoryStatus.stdout);
  const projectCheckpoint = runSelectedProjectOk([
    'checkpoint',
    '--task',
    'read-only-project-walkthrough',
    '--objective',
    'Verify the installed package with a selected read-only repository',
    '--acceptance',
    'The real repository remains unchanged',
    '--decision',
    'Keep workspace and knowledge roots isolated',
    '--next-action',
    'Review the saved resume packet',
    '--author-session',
    'isolated-package-session',
    '--native-session',
    'isolated-package-session',
    '--context-completeness',
    'complete',
    '--json',
  ]);
  assert.equal(projectCheckpoint.schema, 'pappra/checkpoint-result/1');
  const projectResumeResult = runSelectedProject([
    'resume',
    'read-only-project-walkthrough',
    '--session',
    'isolated-package-session',
    '--json',
  ]);
  if (projectResumeResult.error) throw projectResumeResult.error;
  assert.equal(projectResumeResult.status, 0, projectResumeResult.stderr);
  const projectResume = parseInstalled(projectResumeResult.stdout);
  assert.equal(projectResume.schema, 'pappra/resume-packet/1');
  assert.equal(projectResume.verificationStatus, 'current');
  assert.equal(projectResume.executionAllowed, false);
  assert.equal(projectResume.contextCompleteness, 'complete');
  // Let npm's existing 120-second install deadline produce its own diagnostic.
  const projectRuntime = runSelectedProjectOk(
    ['runtime', 'install', '--apply', '--json'],
    150_000,
  );
  assert.equal(projectRuntime.ok, true);
  runSelectedProjectOk(['runtime', 'status', '--json']);
  assert.deepEqual(
    readFileSync(join(selectedRealProject, 'package.json')),
    sourcePackageBytes,
  );
  const sourceStatusAfter = spawnSync('git', ['status', '--porcelain'], {
    cwd: selectedRealProject,
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
    env: testSubprocessEnvironment(),
  });
  if (sourceStatusAfter.error) throw sourceStatusAfter.error;
  assert.equal(sourceStatusAfter.status, 0, sourceStatusAfter.stderr);
  assert.equal(sourceStatusAfter.stdout, sourceStatusBefore.stdout);
  console.log(
    'Installed selected-project walkthrough passed (read-only external repository; isolated workspace, config, knowledge, runtime and task roots).',
  );
  console.log(`Package smoke passed (${files.length} files).`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
