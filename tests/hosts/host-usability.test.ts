import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { captureProcessIdentity } from '../../src/infra/process-identity.js';
import { HostIntegrationService } from '../../src/hosts/integration/service.js';
import { FixtureHostIntegrationService } from './integration-fixture.js';
import { makeTempDir, cleanup, snapshotTree } from '../workspace/fixtures.js';

test('install and verify observe the real executable version instead of trusting supplied strings', async () => {
  const root = makeTempDir('host-version-probe');
  try {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const executable = path.join(bin, 'claude');
    const writeVersion = (version: string) =>
      fs.writeFileSync(
        executable,
        `#!${process.execPath}\nif(process.argv[2]!=="--version")process.exit(2);console.log("Claude Code ${version}");\n`,
        { mode: 0o700 },
      );
    writeVersion('9.9.9');
    const service = new HostIntegrationService({
      root,
      homeDir: root,
      pathEnv: bin,
      hostVersion: '2.1.292',
    });
    const hostRoot = path.join(root, '.claude');
    assert.equal(
      (await service.install('claude', { hostRoot, apply: true })).status,
      'unsupported',
    );
    assert.equal(fs.existsSync(hostRoot), false);
    writeVersion('2.1.308');
    assert.equal(
      (
        await service.install('claude', {
          hostRoot,
          apply: true,
          hostVersion: '9.9.9',
        })
      ).status,
      'applied',
    );
    const verified = await service.verify('claude', {
      hostRoot,
      hostVersion: '9.9.9',
    });
    assert.equal(verified.version, '2.1.308');
    assert.equal(verified.status, 'verified');
    fs.unlinkSync(executable);
    assert.equal(
      (await service.uninstall('claude', { hostRoot, apply: true })).status,
      'removed',
    );
  } finally {
    cleanup(root);
  }
});

test('host merge and uninstall preserve user bytes, indentation, newline style and file permissions', async () => {
  const root = makeTempDir('host-uninstall-user-config');
  try {
    const hostRoot = path.join(root, '.claude');
    fs.mkdirSync(hostRoot);
    const config = path.join(hostRoot, 'settings.json');
    const original =
      '{\r\n\t"model" : "user-model",\r\n\t"hooks": {"Stop":[{"hooks":[{"type":"command","command":"USER_HOOK"}]}]}\r\n}\r\n';
    fs.writeFileSync(config, original, { mode: 0o640 });
    const service = new FixtureHostIntegrationService({
      root,
      homeDir: root,
      pathEnv: '',
      hostVersion: '2.1.308',
    });
    assert.equal(
      (await service.install('claude', { hostRoot, apply: true })).status,
      'applied',
    );
    const merged = fs.readFileSync(config, 'utf8');
    assert(merged.includes('\t"model" : "user-model",\r\n'));
    assert(!merged.replaceAll('\r\n', '').includes('\n'));
    assert.equal(fs.statSync(config).mode & 0o777, 0o640);
    fs.writeFileSync(path.join(hostRoot, 'user.txt'), 'retain me');
    const before = snapshotTree(root);
    assert.equal(
      (await service.uninstall('claude', { hostRoot, apply: false })).status,
      'planned',
    );
    assert.deepEqual(snapshotTree(root), before);
    const removed = await service.uninstall('claude', {
      hostRoot,
      apply: true,
    });
    assert.equal(removed.status, 'removed', JSON.stringify(removed));
    assert.equal(
      fs.readFileSync(path.join(hostRoot, 'user.txt'), 'utf8'),
      'retain me',
    );
    assert.equal(fs.statSync(config).mode & 0o777, 0o640);
    const next = JSON.parse(fs.readFileSync(config, 'utf8')) as {
      model: string;
      hooks: Record<string, unknown>;
    };
    assert.equal(next.model, 'user-model');
    assert.deepEqual(Object.keys(next.hooks), ['Stop']);
    assert.equal(fs.existsSync(path.join(hostRoot, 'pappra-host.json')), false);
    assert.equal(
      (await service.uninstall('claude', { hostRoot, apply: true })).status,
      'unchanged',
    );
  } finally {
    cleanup(root);
  }
});

test('edited managed assets and their ownership manifest survive uninstall as explicit residuals', async () => {
  const root = makeTempDir('host-uninstall-edited');
  try {
    const hostRoot = path.join(root, '.pi');
    const service = new FixtureHostIntegrationService({
      root,
      homeDir: root,
      pathEnv: '',
      hostVersion: '1.4.0',
    });
    assert.equal(
      (await service.install('pi', { hostRoot, apply: true })).status,
      'applied',
    );
    const entry = path.join(hostRoot, 'extensions', 'pappra', 'index.ts');
    fs.appendFileSync(entry, '\n// user extension edit\n');
    const edited = fs.readFileSync(entry, 'utf8');
    const result = await service.uninstall('pi', { hostRoot, apply: true });
    assert.equal(result.status, 'partial');
    assert.equal(result.ok, false);
    assert(result.retainedPaths.includes(entry));
    assert.equal(fs.readFileSync(entry, 'utf8'), edited);
    assert(
      fs.existsSync(path.join(hostRoot, 'extensions', 'pappra', 'runtime.mjs')),
    );
    assert(fs.existsSync(path.join(hostRoot, 'pappra-host.json')));
  } finally {
    cleanup(root);
  }
});

test('relative project hooks verify and reinstall after moving the checkout', async () => {
  const original = makeTempDir('host-move-original');
  const moved = `${original}-moved`;
  try {
    const service = new FixtureHostIntegrationService({
      root: original,
      homeDir: original,
      pathEnv: '',
      hostVersion: '2.1.308',
    });
    assert.equal(
      (
        await service.install('claude', {
          hostRoot: path.join(original, '.claude'),
          apply: true,
        })
      ).status,
      'applied',
    );
    fs.renameSync(original, moved);
    const relocated = new FixtureHostIntegrationService({
      root: moved,
      homeDir: moved,
      pathEnv: '',
      hostVersion: '2.1.308',
    });
    const hostRoot = path.join(moved, '.claude');
    assert.equal(
      (await relocated.verify('claude', { hostRoot })).status,
      'verified',
    );
    assert.equal(
      (await relocated.install('claude', { hostRoot, apply: true })).status,
      'applied',
    );
    const config = fs.readFileSync(
      path.join(hostRoot, 'settings.json'),
      'utf8',
    );
    assert(
      config.includes('${CLAUDE_PROJECT_DIR}/.claude/hooks/pappra-hook.mjs'),
    );
    assert(!config.includes(original));
  } finally {
    cleanup(original);
    cleanup(moved);
  }
});

test('uninstall refuses manifest claims on unrelated files and never follows a replaced managed symlink', async () => {
  const root = makeTempDir('host-uninstall-unsafe');
  try {
    const hostRoot = path.join(root, '.claude');
    const service = new FixtureHostIntegrationService({
      root,
      homeDir: root,
      pathEnv: '',
      hostVersion: '2.1.308',
    });
    assert.equal(
      (await service.install('claude', { hostRoot, apply: true })).status,
      'applied',
    );
    const user = path.join(hostRoot, 'user.txt');
    fs.writeFileSync(user, 'USER_CONTENT');
    const manifestFile = path.join(hostRoot, 'pappra-host.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as {
      files: unknown[];
    };
    manifest.files.push({
      path: 'user.txt',
      kind: 'skill',
      digest: `sha256:${createHash('sha256').update('USER_CONTENT').digest('hex')}`,
    });
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const script = path.join(hostRoot, 'hooks', 'pappra-hook.mjs');
    fs.unlinkSync(script);
    fs.symlinkSync(user, script);
    const result = await service.uninstall('claude', { hostRoot, apply: true });
    assert.equal(result.status, 'partial');
    assert(result.retainedPaths.includes(script));
    assert(result.retainedPaths.includes(user));
    assert.equal(fs.readFileSync(user, 'utf8'), 'USER_CONTENT');
    assert(fs.lstatSync(script).isSymbolicLink());
  } finally {
    cleanup(root);
  }
});

test('public uninstall CLI previews and removes owned wiring without launching a host', async () => {
  const root = makeTempDir('host-uninstall-cli');
  try {
    const hostRoot = path.join(root, '.pi');
    const service = new FixtureHostIntegrationService({
      root,
      homeDir: root,
      pathEnv: '',
      hostVersion: '1.4.0',
    });
    assert.equal(
      (await service.install('pi', { hostRoot, apply: true })).status,
      'applied',
    );
    const cli = fileURLToPath(
      new URL('../../src/cli/main.js', import.meta.url),
    );
    for (const apply of [false, true]) {
      const executed = spawnSync(
        process.execPath,
        [
          cli,
          'host',
          'uninstall',
          '--host',
          'pi',
          '--host-root',
          hostRoot,
          '--json',
          ...(apply ? ['--apply'] : []),
        ],
        { cwd: root, encoding: 'utf8', timeout: 20_000 },
      );
      assert.equal(executed.status, 0, executed.stderr || executed.stdout);
      const result = JSON.parse(executed.stdout) as { status: string };
      assert.equal(result.status, apply ? 'removed' : 'planned');
      assert.equal(
        fs.existsSync(path.join(hostRoot, 'pappra-host.json')),
        !apply,
      );
    }
  } finally {
    cleanup(root);
  }
});

test('host locks recover proven dead owners, preserve live owners, and archive legacy locks only after explicit force', async () => {
  const self = captureProcessIdentity();
  assert(self);
  for (const owner of ['dead', 'alive', 'legacy'] as const) {
    const root = makeTempDir(`host-lock-${owner}`);
    try {
      const hostRoot = path.join(root, '.claude');
      fs.mkdirSync(hostRoot);
      const lock = path.join(hostRoot, '.pappra-host.lock');
      const raw: string =
        owner === 'legacy'
          ? 'legacy-opaque-token'
          : JSON.stringify({
              token: 'fixture',
              pid: process.pid,
              process_identity:
                owner === 'dead'
                  ? { ...self, boot: `sha256:${'0'.repeat(64)}` }
                  : self,
            });
      fs.writeFileSync(lock, raw, { mode: 0o600 });
      const service = new FixtureHostIntegrationService({
        root,
        homeDir: root,
        pathEnv: '',
        hostVersion: '2.1.308',
      });
      const installed = await service.install('claude', {
        hostRoot,
        apply: true,
      });
      if (owner === 'dead') {
        assert.equal(installed.status, 'applied', JSON.stringify(installed));
        assert.equal(fs.existsSync(lock), false);
      } else if (owner === 'alive') {
        assert.equal(installed.status, 'conflict');
        const refused = await service.uninstall('claude', {
          hostRoot,
          apply: true,
          force: true,
        });
        assert.equal(refused.status, 'conflict');
        assert.equal(fs.readFileSync(lock, 'utf8'), raw);
      } else {
        assert.equal(installed.status, 'conflict');
        assert.equal(
          (await service.uninstall('claude', { hostRoot, apply: true })).status,
          'conflict',
        );
        assert.equal(
          (
            await service.uninstall('claude', {
              hostRoot,
              apply: false,
              force: true,
            })
          ).status,
          'planned',
        );
        assert.equal(fs.readFileSync(lock, 'utf8'), raw);
        const cli = fileURLToPath(
          new URL('../../src/cli/main.js', import.meta.url),
        );
        const executed = spawnSync(
          process.execPath,
          [
            cli,
            'host',
            'uninstall',
            '--host',
            'claude',
            '--host-root',
            hostRoot,
            '--force',
            '--apply',
            '--json',
          ],
          { cwd: root, encoding: 'utf8', timeout: 20_000 },
        );
        assert.equal(executed.status, 0, executed.stderr || executed.stdout);
        const recovered = JSON.parse(executed.stdout) as {
          status: string;
          quarantinedLocks: string[];
        };
        assert.equal(recovered.status, 'removed', JSON.stringify(recovered));
        assert.equal(recovered.quarantinedLocks.length, 1);
        const archive = recovered.quarantinedLocks[0]!;
        assert.equal(fs.readFileSync(archive, 'utf8'), raw);
        assert.equal(fs.statSync(archive).mode & 0o777, 0o600);
        assert.equal(
          (
            JSON.parse(fs.readFileSync(`${archive}.receipt.json`, 'utf8')) as {
              operator_assertion: { all_host_writers_stopped: boolean };
            }
          ).operator_assertion.all_host_writers_stopped,
          true,
        );
        assert.equal(
          fs.readFileSync(
            path.join(root, '.pappra', 'local', '.gitignore'),
            'utf8',
          ),
          '*\n',
        );
        assert.equal(fs.existsSync(lock), false);
        assert.equal(
          (await service.install('claude', { hostRoot, apply: true })).status,
          'applied',
        );
      }
    } finally {
      cleanup(root);
    }
  }
});
