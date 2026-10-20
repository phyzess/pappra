import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CheckpointService } from '../../src/continuity/index.js';
import {
  baseMachineConfig,
  baseWorkspaceConfig,
  cleanup,
  createRepository,
  makeTempDir,
  writeMachineConfig,
  writeText,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';

const packageRoot = dirname(
  fileURLToPath(import.meta.resolve('pappra/package.json')),
);
const cli = join(packageRoot, 'dist/cli/main.js');

function invoke(args: string[], cwd: string, home: string) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 30_000,
    env: { ...process.env, HOME: home },
  });
  if (result.error) throw result.error;
  return result;
}

function parse(stdout: string): Record<string, unknown> {
  const value: unknown = JSON.parse(stdout);
  assert(typeof value === 'object' && value !== null);
  return value as Record<string, unknown>;
}

test('checkpoint and resume CLI share a single JSON contract without private patches', async () => {
  const root = makeTempDir('continuity-cli');
  const home = mkdtempSync(join(tmpdir(), 'continuity-cli-home-'));
  try {
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        knowledge: {
          sources: [],
          newDocuments: 'knowledge',
          taskVisibility: 'private',
        },
      }),
    );
    writeMachineConfig(root, baseMachineConfig(root));
    const saved = invoke(
      [
        'checkpoint',
        '--task',
        'task-cli',
        '--objective',
        'Cross-host recovery',
        '--acceptance',
        'Preserve decisions',
        '--decision',
        'Use explicit identity',
        '--next-action',
        'Review the packet',
        '--author-session',
        'session-a',
        '--native-session',
        'session-a',
        '--context-completeness',
        'complete',
        '--json',
      ],
      root,
      home,
    );
    assert.equal(saved.status, 0, saved.stderr);
    assert.equal(saved.stderr, '');
    const savedValue = parse(saved.stdout);
    assert.equal(savedValue.schema, 'pappra/checkpoint-result/1');
    assert.equal(savedValue.status, 'saved');
    assert.equal(
      (savedValue.checkpoint as Record<string, unknown>).revision,
      1,
    );
    const checkpointPath = String(savedValue.checkpointPath);
    assert.equal(
      readFileSync(checkpointPath, 'utf8').includes('diff --git'),
      false,
    );

    const resumed = invoke(
      ['resume', 'task-cli', '--session', 'session-a', '--json'],
      root,
      home,
    );
    assert.equal(resumed.status, 1, resumed.stderr);
    assert.equal(resumed.stderr, '');
    const packet = parse(resumed.stdout);
    assert.equal(packet.schema, 'pappra/resume-packet/1');
    assert.equal(packet.executionAllowed, false);
    assert.equal(packet.taskId, 'task-cli');
    assert.equal(
      (packet.boundedContext as Record<string, unknown>).objective,
      'Cross-host recovery',
    );
    assert.equal(JSON.stringify(packet).includes('diff --git'), false);
    assert.equal(JSON.stringify(packet).includes('private patch'), false);

    const blocked = invoke(['resume', 'task-cli', '--json'], root, home);
    assert.equal(blocked.status, 1);
    const blockedPacket = parse(blocked.stdout);
    assert.equal(blockedPacket.executionAllowed, false);
    assert.equal(
      (blockedPacket.blockingReasons as Array<{ code: string }>).length > 0,
      true,
    );
  } finally {
    cleanup(root);
    rmSync(home, { recursive: true, force: true });
  }
});

test('checkpoint and resume reject invalid argument combinations', async () => {
  const root = makeTempDir('continuity-cli-invalid');
  const home = mkdtempSync(join(tmpdir(), 'continuity-cli-home-'));
  try {
    writeWorkspaceConfig(root, baseWorkspaceConfig());
    writeMachineConfig(root, baseMachineConfig(root));
    for (const args of [
      ['checkpoint', '--json'],
      ['checkpoint', '--task', 'x', '--context-completeness', 'bad', '--json'],
      ['resume', '--json'],
      ['resume', 'a', 'b', '--json'],
      ['checkpoint', '--task', 'x', '--unknown', '--json'],
    ]) {
      const result = invoke(args, root, home);
      assert.equal(result.status, 2);
    }
  } finally {
    cleanup(root);
    rmSync(home, { recursive: true, force: true });
  }
});

test('stale resume exits nonzero and reports stale verification', async () => {
  const root = makeTempDir('continuity-cli-stale');
  const home = mkdtempSync(join(tmpdir(), 'continuity-cli-home-'));
  try {
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        repositories: [{ id: 'app', path: '.', access: 'write' }],
      }),
    );
    writeMachineConfig(root, baseMachineConfig(root));
    createRepository(root);
    const service = new CheckpointService(root);
    const saved = await service.save({
      taskId: 'task-stale',
      objective: 'Stale CLI test',
      acceptance: ['Exit nonzero'],
      decisions: ['Keep decisions'],
      nextActions: ['Review'],
      authorSession: 'session-a',
      contextCompleteness: 'complete',
    });
    assert.equal(saved.ok, true, saved.diagnostics[0]?.message);
    writeText(join(root, 'tracked.txt'), 'changed after checkpoint\n');
    const result = invoke(
      ['resume', 'task-stale', '--session', 'session-a', '--json'],
      root,
      home,
    );
    assert.equal(result.status, 1, result.stderr);
    const packet = parse(result.stdout);
    assert.equal(packet.verificationStatus, 'stale');
    assert.equal(packet.executionAllowed, false);
  } finally {
    cleanup(root);
    rmSync(home, { recursive: true, force: true });
  }
});
