import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runGit } from '../../src/infra/git.js';
import { CodeIntelligenceService } from '../../src/code/service.js';
import { CheckpointService } from '../../src/continuity/service.js';
import { testSubprocessEnvironment } from '../../scripts/test-environment.js';
import {
  baseMachineConfig,
  baseWorkspaceConfig,
  cleanup,
  createRepository,
  makeTempDir,
  runGit as fixtureGit,
  writeMachineConfig,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';

test(
  'code status and checkpoint never execute repository external diff or textconv drivers',
  { skip: process.platform === 'win32' },
  async () => {
    const root = makeTempDir('readonly-diff-drivers');
    const previous = process.env.GIT_EXTERNAL_DIFF;
    try {
      createRepository(root);
      writeWorkspaceConfig(
        root,
        baseWorkspaceConfig({
          repositories: [{ id: 'app', path: '.', access: 'write' }],
        }),
      );
      writeMachineConfig(root, baseMachineConfig(root));
      const externalMarker = join(root, 'external-marker');
      const textconvMarker = join(root, 'textconv-marker');
      const external = join(root, 'external-driver.js');
      const textconv = join(root, 'textconv-driver.js');
      writeFileSync(
        external,
        `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(externalMarker)},'executed'); process.stdout.write('external driver output');\n`,
      );
      writeFileSync(
        textconv,
        `#!/usr/bin/env node\nconst fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(textconvMarker)},'executed'); process.stdout.write(fs.readFileSync(process.argv[2],'utf8'));\n`,
      );
      chmodSync(external, 0o755);
      chmodSync(textconv, 0o755);
      writeFileSync(join(root, '.gitattributes'), 'tracked.txt diff=fixture\n');
      fixtureGit(root, ['add', '.gitattributes']);
      fixtureGit(root, ['commit', '-qm', 'fixture attributes']);
      fixtureGit(root, ['config', 'diff.external', './external-driver.js']);
      fixtureGit(root, [
        'config',
        'diff.fixture.textconv',
        './textconv-driver.js',
      ]);
      writeFileSync(join(root, 'tracked.txt'), 'staged changed bytes\n');
      fixtureGit(root, ['add', 'tracked.txt']);
      writeFileSync(join(root, 'tracked.txt'), 'unstaged changed bytes\n');
      const control = (args: string[]) => {
        const result = spawnSync('git', args, {
          cwd: root,
          env: testSubprocessEnvironment(),
          encoding: 'utf8',
          shell: false,
          timeout: 5000,
        });
        assert.equal(result.status, 0, result.stderr);
      };
      control([
        'diff',
        '--ext-diff',
        '--no-textconv',
        'HEAD',
        '--',
        'tracked.txt',
      ]);
      assert.equal(
        existsSync(externalMarker),
        true,
        'the external driver fixture must actually execute when permitted',
      );
      rmSync(externalMarker);
      control([
        'diff',
        '--no-ext-diff',
        '--textconv',
        'HEAD',
        '--',
        'tracked.txt',
      ]);
      assert.equal(
        existsSync(textconvMarker),
        true,
        'the textconv fixture must actually execute when permitted',
      );
      rmSync(textconvMarker);
      process.env.GIT_EXTERNAL_DIFF = external;
      const status = await new CodeIntelligenceService(root).status({
        repositoryId: 'app',
      });
      assert.equal(
        status.identity?.workingTree.completeness,
        'complete',
        JSON.stringify(status),
      );
      assert.equal(existsSync(externalMarker), false);
      assert.equal(existsSync(textconvMarker), false);
      const saved = await new CheckpointService(root).save({
        taskId: 'readonly-diff',
        objective: 'Observe changed bytes without running repository drivers',
        acceptance: ['No driver marker is created'],
      });
      assert.equal(saved.ok, true, JSON.stringify(saved));
      assert.equal(existsSync(externalMarker), false);
      assert.equal(existsSync(textconvMarker), false);
    } finally {
      if (previous === undefined) delete process.env.GIT_EXTERNAL_DIFF;
      else process.env.GIT_EXTERNAL_DIFF = previous;
      cleanup(root);
    }
  },
);

test(
  'read-only Git commands do not inherit GIT_EXTERNAL_DIFF',
  { skip: process.platform === 'win32' },
  async () => {
    const root = makeTempDir('readonly-git-env');
    const previousPath = process.env.PATH;
    const previousDiff = process.env.GIT_EXTERNAL_DIFF;
    try {
      const bin = join(root, 'bin');
      mkdirSync(bin);
      const executable = join(bin, 'git');
      writeFileSync(
        executable,
        '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({inherited:!!process.env.GIT_EXTERNAL_DIFF}));\n',
      );
      chmodSync(executable, 0o755);
      process.env.PATH = `${bin}:${previousPath ?? ''}`;
      process.env.GIT_EXTERNAL_DIFF = 'untrusted-inherited-driver';
      const observed = await runGit({ cwd: root, args: ['status'] });
      assert(observed.ok, JSON.stringify(observed));
      assert.deepEqual(JSON.parse(observed.value.stdout), { inherited: false });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousDiff === undefined) delete process.env.GIT_EXTERNAL_DIFF;
      else process.env.GIT_EXTERNAL_DIFF = previousDiff;
      cleanup(root);
    }
  },
);
