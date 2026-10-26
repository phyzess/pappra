import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const cli = fileURLToPath(new URL('../../src/cli/main.js', import.meta.url));

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

test('actual checkpoint CLI cleans failed new task directories and reports preserved state', () => {
  const root = realpathSync(makeTempDir('checkpoint-cli-cleanup'));
  const home = mkdtempSync(join(tmpdir(), 'checkpoint-cli-home-'));
  try {
    writeWorkspaceConfig(root, baseWorkspaceConfig());
    writeMachineConfig(root, baseMachineConfig(root));
    const tasks = join(root, '.pappra/local/tasks');
    for (const args of [
      ['--task', 'missing-input'],
      ['--task', 'invalid-context', '--objective', '', '--acceptance', 'Save'],
    ]) {
      const result = invoke(['checkpoint', ...args, '--json'], root, home);
      assert.equal(result.status, 1, result.stderr);
      const value = parse(result.stdout);
      assert.equal(value.ok, false);
      assert.deepEqual(value.residualPaths, []);
      assert.equal(existsSync(join(tasks, args[1]!)), false);
    }
    const existing = join(tasks, 'existing');
    mkdirSync(existing);
    const failed = invoke(
      ['checkpoint', '--task', 'existing', '--json'],
      root,
      home,
    );
    assert.equal(failed.status, 1, failed.stderr);
    assert.deepEqual(parse(failed.stdout).residualPaths, [existing]);
    assert.deepEqual(readdirSync(existing), []);

    const locked = join(tasks, 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'checkpoint.lock'), 'foreign lock\n');
    const conflict = invoke(
      ['checkpoint', '--task', 'locked', '--json'],
      root,
      home,
    );
    assert.equal(conflict.status, 1, conflict.stderr);
    assert.deepEqual(parse(conflict.stdout).residualPaths, [locked]);
    assert.equal(
      readFileSync(join(locked, 'checkpoint.lock'), 'utf8'),
      'foreign lock\n',
    );

    const retry = invoke(
      [
        'checkpoint',
        '--task',
        'missing-input',
        '--objective',
        'Retry',
        '--acceptance',
        'Save',
        '--json',
      ],
      root,
      home,
    );
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(parse(retry.stdout).status, 'saved');
    assert.deepEqual(parse(retry.stdout).residualPaths, []);
  } finally {
    cleanup(root);
    rmSync(home, { recursive: true, force: true });
  }
});

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
    assert.equal(resumed.status, 0, resumed.stderr);
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
    assert.equal(blocked.status, 0);
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

test('human resume does not repeat a blocked reason as a warning', () => {
  const root = makeTempDir('continuity-cli-human');
  const home = mkdtempSync(join(tmpdir(), 'continuity-cli-home-'));
  try {
    writeWorkspaceConfig(root, baseWorkspaceConfig());
    writeMachineConfig(root, baseMachineConfig(root));
    const saved = invoke(
      [
        'checkpoint',
        '--task',
        'task-human',
        '--objective',
        'Human resume output',
        '--acceptance',
        'Keep the blocked reason visible',
      ],
      root,
      home,
    );
    assert.equal(saved.status, 0, saved.stderr);

    const resumed = invoke(['resume', 'task-human'], root, home);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(
      resumed.stdout,
      /Blocked: live_writer_unverified: A stored checkpoint cannot prove/,
    );
    assert.equal(
      resumed.stderr.includes('live_writer_unverified'),
      false,
      resumed.stderr,
    );
    assert.equal(
      resumed.stderr.includes('A stored checkpoint cannot prove'),
      false,
      resumed.stderr,
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

test('task CLI enforces the shared 64-character id rule before writes', async () => {
  const root = makeTempDir('task-cli-id-rule');
  const home = mkdtempSync(join(tmpdir(), 'task-cli-home-'));
  try {
    writeWorkspaceConfig(root, baseWorkspaceConfig());
    const pinFile = join(root, '.pappra', 'local', 'current-task');
    const long = invoke(['task', 'pin', 'a'.repeat(65), '--json'], root, home);
    assert.equal(long.status, 2, long.stderr);
    assert.equal(existsSync(pinFile), false);
    assert.match(String(parse(long.stdout).message), /64 characters/);
    const accepted = invoke(
      ['task', 'pin', 'a'.repeat(64), '--json'],
      root,
      home,
    );
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(parse(accepted.stdout).task, 'a'.repeat(64));
    assert.equal(existsSync(pinFile), true);
    const checkpoint64 = invoke(
      [
        'checkpoint',
        '--task',
        'a'.repeat(64),
        '--objective',
        '64-character task',
        '--acceptance',
        'Exit zero',
        '--author-session',
        'session-a',
        '--context-completeness',
        'complete',
        '--json',
      ],
      root,
      home,
    );
    assert.equal(checkpoint64.status, 0, checkpoint64.stderr);
    assert.equal(parse(checkpoint64.stdout).status, 'saved');
    const resume64 = invoke(['resume', 'a'.repeat(64), '--json'], root, home);
    const resume64Value = parse(resume64.stdout);
    assert.equal(resume64Value.taskId, 'a'.repeat(64));
    const checkpoint = invoke(
      [
        'checkpoint',
        '--task',
        'a'.repeat(65),
        '--objective',
        'too long',
        '--json',
      ],
      root,
      home,
    );
    assert.notEqual(checkpoint.status, 0, checkpoint.stderr);
    assert.equal(
      existsSync(join(root, '.pappra', 'local', 'tasks', 'a'.repeat(65))),
      false,
    );
    const resume = invoke(['resume', 'a'.repeat(65), '--json'], root, home);
    assert.notEqual(resume.status, 0, resume.stderr);
  } finally {
    cleanup(root);
    rmSync(home, { recursive: true, force: true });
  }
});

test('task CLI refuses an incomplete inner registration without writing outward', async () => {
  const root = makeTempDir('task-cli-inner');
  const home = mkdtempSync(join(tmpdir(), 'task-cli-home-'));
  try {
    writeWorkspaceConfig(root, baseWorkspaceConfig());
    const inner = join(root, 'inner');
    mkdirSync(join(inner, '.pappra'), { recursive: true });
    const result = invoke(['task', 'pin', 'T-INNER', '--json'], inner, home);
    assert.equal(result.status, 2, result.stderr);
    assert.match(String(parse(result.stdout).message), /found: incomplete/);
    assert.equal(
      existsSync(join(root, '.pappra', 'local', 'current-task')),
      false,
    );
    assert.equal(existsSync(join(inner, '.pappra', 'local')), false);
  } finally {
    cleanup(root);
    rmSync(home, { recursive: true, force: true });
  }
});

test('task CLI reports partial pin success when autoResume cannot be enabled', async () => {
  const root = makeTempDir('task-cli-partial');
  const home = mkdtempSync(join(tmpdir(), 'task-cli-home-'));
  try {
    writeWorkspaceConfig(root, baseWorkspaceConfig());
    mkdirSync(join(root, '.pappra', 'local'), { recursive: true });
    const lockPath = join(root, '.pappra', 'local', 'apply.lock');
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        schema: 'pappra/install-lock/1',
        token: 'foreign',
        operation: 'set-auto-resume',
        target: '.pappra/workspace.json',
        pid: process.pid,
        createdAt: new Date().toISOString(),
      })}\n`,
    );
    const before = readFileSync(join(root, '.pappra', 'workspace.json'));
    const result = invoke(
      ['task', 'pin', 'T-PARTIAL', '--auto-resume', '--json'],
      root,
      home,
    );
    assert.equal(result.status, 2, result.stderr);
    const payload = parse(result.stdout);
    assert.equal(payload.code, 'task_invalid');
    assert.match(
      String(payload.message),
      /is pinned, but autoResume was not enabled/,
    );
    assert.equal(
      existsSync(join(root, '.pappra', 'local', 'current-task')),
      true,
    );
    assert.deepEqual(
      readFileSync(join(root, '.pappra', 'workspace.json')),
      before,
    );
    assert.equal(existsSync(lockPath), true);
    const show = invoke(['task', 'show', '--json'], root, home);
    assert.equal(show.status, 0, show.stderr);
    assert.equal(parse(show.stdout).autoResume, false);
  } finally {
    cleanup(root);
    rmSync(home, { recursive: true, force: true });
  }
});

test('task CLI refuses redirected private state and reports unpin failure', async () => {
  const root = makeTempDir('task-cli-redirect');
  const home = mkdtempSync(join(tmpdir(), 'task-cli-home-'));
  try {
    writeWorkspaceConfig(root, baseWorkspaceConfig());
    const outside = join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(root, '.pappra', 'local'), 'dir');
    const pin = invoke(['task', 'pin', 'T-REDIRECT', '--json'], root, home);
    assert.equal(pin.status, 2, pin.stderr);
    assert.deepEqual(
      readFileSync(join(root, '.pappra', 'workspace.json'), 'utf8').length > 0,
      true,
    );
    assert.deepEqual(existsSync(join(outside, 'current-task')), false);
    const unpin = invoke(['task', 'unpin', '--json'], root, home);
    assert.equal(unpin.status, 2, unpin.stderr);
    assert.match(
      String(parse(unpin.stdout).message),
      /symlink|redirected|real directory|not a directory|resolves outside/i,
    );
  } finally {
    cleanup(root);
    rmSync(home, { recursive: true, force: true });
  }
});
