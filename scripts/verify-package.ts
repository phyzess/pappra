import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { npmCli, pnpmCommand, projectRoot, runNode } from './project.js';

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
  assert(files.includes('assets/manifest.json'));
  assert(files.includes('assets/integrations/skills/pappra/SKILL.md'));
  assert(
    files.includes('assets/integrations/skills/pappra/references/lifecycle.md'),
  );
  assert(files.includes('skills/pappra/SKILL.md'));
  assert(files.includes('skills/pappra/references/operations.md'));
  assert(
    files.every((file) =>
      /^(?:dist\/|assets\/|skills\/|package\.json$|README\.md$|LICENSE$|THIRD_PARTY_NOTICES\.md$)/.test(
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
  const installedResult = spawnSync(
    pnpm.executable,
    [
      ...pnpm.args,
      'add',
      '--offline',
      '--ignore-scripts',
      '--config.package-manager-strict=false',
      join(temporary, entry.filename),
    ],
    {
      cwd: consumer,
      encoding: 'utf8',
      shell: false,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (installedResult.error) throw installedResult.error;
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
    { cwd: consumer, encoding: 'utf8', shell: false, timeout: 10_000 },
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
  runNode(['consumer.js', metadata.version], consumer);

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
  const lifecycleEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: lifecycleHome,
    XDG_CONFIG_HOME: join(lifecycleHome, 'config'),
    XDG_DATA_HOME: join(lifecycleHome, 'data'),
    XDG_STATE_HOME: join(lifecycleHome, 'state'),
  };
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
  const userSentinel = Buffer.from('pre-init user-owned content\n', 'utf8');
  const sentinelPath = join(lifecycleRoot, 'user-sentinel.txt');
  writeFileSync(sentinelPath, userSentinel);
  const init = runInstalled([
    'init',
    '--config',
    choicesPath,
    '--apply',
    '--json',
  ]);
  if (init.error) throw init.error;
  assert([0, 1].includes(init.status ?? -1), init.stderr);
  const initValue = parseInstalled(init.stdout);
  assert.equal(initValue.ok, true);
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
    [installedCli, 'init', '--config', choicesPath, '--apply', '--json'],
    {
      cwd: editedRoot,
      encoding: 'utf8',
      shell: false,
      timeout: 90_000,
      env: lifecycleEnv,
    },
  );
  if (editedInit.error) throw editedInit.error;
  assert([0, 1].includes(editedInit.status ?? -1), editedInit.stderr);
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
      { cwd: consumer, encoding: 'utf8', shell: false, timeout: 10_000 },
    );
    if (executable.error) throw executable.error;
    assert.equal(executable.status, 0, executable.stderr);
    assert.match(executable.stdout, /Usage:/);
    assert.match(executable.stdout, /init/);
    assert.match(executable.stdout, /doctor/);
  }
  console.log(`Package smoke passed (${files.length} files).`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
