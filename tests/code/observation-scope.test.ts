import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  createGitObservationScope,
  inspectGitRepository,
} from '../../src/infra/git.js';
import { CodeIntelligenceService } from '../../src/code/service.js';
import { CodeGraphProvider } from '../../src/code/providers/codegraph.js';
import {
  baseMachineConfig,
  baseWorkspaceConfig,
  cleanup,
  createRepository,
  makeTempDir,
  runGit,
  writeMachineConfig,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';

test(
  'prepare refreshes HEAD after an awaited engine mutation even when the tree bytes stay unchanged',
  {
    skip:
      spawnSync('codegraph', ['--version'], {
        encoding: 'utf8',
        timeout: 10_000,
      }).status !== 0,
  },
  async () => {
    const root = makeTempDir('code-prepare-head-drift');
    const original = CodeGraphProvider.prototype.prepare;
    try {
      createRepository(root);
      writeFileSync(join(root, 'example.ts'), 'export const answer = 42;\n');
      writeWorkspace(root);
      writeWorkspaceConfig(
        root,
        baseWorkspaceConfig({
          repositories: [{ id: 'app', path: '.', access: 'write' }],
          code: { graph: 'codegraph', symbols: 'auto', prepare: 'manual' },
        }),
      );
      let committed = false;
      CodeGraphProvider.prototype.prepare = async function (...args) {
        const result = await original.apply(this, args);
        if (result.ok && result.value.state === 'ready') {
          runGit(root, [
            '-c',
            'user.name=Fixture',
            '-c',
            'user.email=fixture@example.com',
            'commit',
            '--allow-empty',
            '-m',
            'concurrent metadata-only commit',
          ]);
          committed = true;
        }
        return result;
      };
      const prepared = await new CodeIntelligenceService(root).prepare({
        root,
        repositoryId: 'app',
        apply: true,
        rebuild: false,
      });
      assert.equal(committed, true, JSON.stringify(prepared));
      assert.equal(prepared.status, 'partial');
      assert(prepared.health.reasons.includes('source_changed_during_prepare'));
      assert.equal(prepared.registrationPath, null);
    } finally {
      CodeGraphProvider.prototype.prepare = original;
      cleanup(root);
    }
  },
);

const FS_MONITOR_PREFIX = '-c core.fsmonitor=false ';

/**
 * Installs a `git` shim first on PATH that records every argv and then executes
 * the real git. The shim measures subprocess count, which is the property under
 * test: one operation must not spawn the same probe twice.
 */
function installGitCounter(logPath: string): () => void {
  const located = spawnSync('sh', ['-c', 'command -v git'], {
    encoding: 'utf8',
  });
  const realGit = located.stdout.trim();
  if (located.status !== 0 || realGit === '') {
    throw new Error('git is required for this test');
  }
  const bin = join(logPath, '..', 'git-counter-bin');
  mkdirSync(bin, { recursive: true });
  const script = `#!/bin/sh\nprintf '%s\\n' "$*" >> '${logPath}'\nexec '${realGit}' "$@"\n`;
  writeFileSync(join(bin, 'git'), script);
  chmodSync(join(bin, 'git'), 0o755);
  const previous = process.env['PATH'];
  process.env['PATH'] = `${bin}:${previous ?? ''}`;
  return () => {
    if (previous === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previous;
  };
}

function readCalls(logPath: string): readonly string[] {
  try {
    return readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) =>
        line.startsWith(FS_MONITOR_PREFIX)
          ? line.slice(FS_MONITOR_PREFIX.length)
          : line,
      );
  } catch {
    return [];
  }
}

function countCalls(calls: readonly string[], prefix: string): number {
  return calls.filter((call) => call.startsWith(prefix)).length;
}

function writeWorkspace(root: string): void {
  writeWorkspaceConfig(
    root,
    baseWorkspaceConfig({
      repositories: [{ id: 'app', path: '.', access: 'write' }],
    }),
  );
  writeMachineConfig(root, baseMachineConfig(root));
}

test(
  'one Git observation scope probes a checkout once',
  { skip: process.platform === 'win32' },
  async () => {
    const root = makeTempDir('code-scope');
    try {
      const repo = join(root, 'repo');
      createRepository(repo);
      // The call log stays outside the checkout so it never dirties the tree.
      const log = join(root, 'git-calls.log');
      const restore = installGitCounter(log);
      try {
        const scope = createGitObservationScope({ workingTreeState: false });
        const first = await scope.repository(repo);
        assert.equal(first.ok, true);
        const baseline = readCalls(log);
        assert.equal(countCalls(baseline, 'rev-parse --is-bare-repository'), 1);

        await scope.repository(repo);
        // Same checkout, differently spelled root, still the same observation.
        await scope.repository(join(repo, '.'));
        assert.deepEqual(readCalls(log), baseline);
      } finally {
        restore();
      }
    } finally {
      cleanup(root);
    }
  },
);

test(
  'scopes skip the status scan unless working-tree state is requested',
  { skip: process.platform === 'win32' },
  async () => {
    const root = makeTempDir('code-scope');
    try {
      const repo = join(root, 'repo');
      createRepository(repo);
      // The call log stays outside the checkout so it never dirties the tree.
      const log = join(root, 'git-calls.log');
      const restore = installGitCounter(log);
      try {
        const identityScope = createGitObservationScope({
          workingTreeState: false,
        });
        const identityOnly = await identityScope.repository(repo);
        assert.equal(identityOnly.ok, true);
        if (identityOnly.ok) {
          assert.equal(identityOnly.value.dirty, null);
          assert.ok(
            identityOnly.value.limitations.includes(
              'working tree state not requested',
            ),
          );
        }
        assert.equal(readCalls(log).length > 0, true);
        assert.equal(countCalls(readCalls(log), 'status '), 0);

        // The default scope keeps the full inspect semantics, `dirty` included.
        const fullScope = createGitObservationScope();
        const full = await fullScope.repository(repo);
        assert.equal(full.ok, true);
        if (full.ok) assert.equal(full.value.dirty, false);
        assert.equal(countCalls(readCalls(log), 'status '), 1);
      } finally {
        restore();
      }
    } finally {
      cleanup(root);
    }
  },
);

test(
  'one code status operation shares discovery and identity probes',
  { skip: process.platform === 'win32' },
  async () => {
    const root = makeTempDir('code-scope');
    try {
      const repo = join(root, 'repo');
      createRepository(repo);
      writeWorkspace(repo);
      // The call log stays outside the checkout so it never dirties the tree.
      const log = join(root, 'git-calls.log');
      const restore = installGitCounter(log);
      try {
        // A direct probe establishes the per-checkout probe set for this Git.
        const direct = await inspectGitRepository(repo, {
          workingTreeState: false,
        });
        assert.equal(direct.ok, true);
        const probeSet = readCalls(log).length;
        assert.equal(probeSet > 0, true);

        writeFileSync(log, '');
        const result = await new CodeIntelligenceService(repo).status({
          repositoryId: 'app',
        });
        assert.equal(result.identity !== null, true);
        const calls = readCalls(log);
        // Five repository probes plus the three working-tree diff probes; the
        // workspace root declaration and the identity probe reuse the same five.
        assert.equal(countCalls(calls, 'rev-parse --is-bare-repository'), 1);
        assert.equal(countCalls(calls, 'rev-parse --path-format=absolute'), 1);
        assert.equal(
          countCalls(calls, 'rev-parse --show-superproject-working-tree'),
          1,
        );
        assert.equal(countCalls(calls, 'rev-parse --verify --quiet HEAD'), 1);
        assert.equal(countCalls(calls, 'symbolic-ref --short -q HEAD'), 1);
        assert.equal(countCalls(calls, 'status --porcelain=v1 -z'), 0);
        assert.equal(
          countCalls(
            calls,
            'diff --no-ext-diff --no-textconv --binary --cached',
          ),
          1,
        );
        assert.equal(
          countCalls(calls, 'diff --no-ext-diff --no-textconv --binary -- '),
          1,
        );
        assert.equal(
          countCalls(calls, 'ls-files --others --exclude-standard'),
          1,
        );

        // A second operation re-probes: nothing is cached across commands.
        writeFileSync(log, '');
        await new CodeIntelligenceService(repo).status({ repositoryId: 'app' });
        assert.equal(
          countCalls(readCalls(log), 'rev-parse --is-bare-repository'),
          1,
        );
      } finally {
        restore();
      }
    } finally {
      cleanup(root);
    }
  },
);
