import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../src/cli/run.js';

interface CapturedOutput {
  readonly stdout: string;
  readonly stderr: string;
}

function capture(): {
  readonly output: {
    stdout: (text: string) => void;
    stderr: (text: string) => void;
  };
  readonly read: () => CapturedOutput;
} {
  let stdout = '';
  let stderr = '';
  return {
    output: {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
    read: () => ({ stdout, stderr }),
  };
}

async function invoke(args: readonly string[]): Promise<{
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const captured = capture();
  const status = await runCli(args, captured.output);
  return { status, ...captured.read() };
}

test('collab help routes through one action-specific usage table', async () => {
  const result = await invoke(['collab', '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pappra collab <prepare\|run\|/);
  assert.equal(result.stderr, '');
});

test('collab help narrows the usage line for a selected action', async () => {
  const result = await invoke(['collab', 'role-run', '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /role-orchestration\.json/);
  assert.doesNotMatch(result.stdout, /pappra collab <prepare\|run\|/);
});

test('an unknown collab action is rejected before any dispatch', async () => {
  const result = await invoke(['collab', 'nonsense', '--json']);
  assert.equal(result.status, 2);
  assert.equal(result.stderr, '');
  const value: unknown = JSON.parse(result.stdout);
  assert(typeof value === 'object' && value !== null);
  assert('code' in value && value.code === 'invalid_arguments');
});
test('collab message routes into its own per-action validator', async () => {
  const result = await invoke([
    'collab',
    'message',
    'list',
    '--binding',
    '/tmp/pappra-unused-binding.json',
  ]);
  assert.equal(result.status, 2);
  assert.match(
    result.stderr,
    /collab message requires send\/list\/read\/notify/,
  );
});

test('--watch stays rejected outside collab role-run', async () => {
  const result = await invoke(['collab', 'role-plan', 'expand', '--watch']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--watch is supported only by collab role-run\./);
});

test('cross-command flags stay rejected for non-collab commands', async () => {
  const result = await invoke(['docs', '--task-root', '/tmp/pappra-unused']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--task-root/);
  assert.match(result.stderr, /only valid for collab/);
});

test('collab state routing reports a missing task without writing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pappra-cli-routing-'));
  try {
    const taskRoot = join(root, 'absent-task');
    const result = await invoke([
      'collab',
      'state',
      'show',
      '--task-root',
      taskRoot,
      '--json',
    ]);
    assert.notEqual(result.status, 0);
    assert.equal(result.stderr, '');
    const value: unknown = JSON.parse(result.stdout);
    assert(typeof value === 'object' && value !== null);
    assert('ok' in value && value.ok === false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('docs forget routes --scope private and shared into the docs command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pappra-cli-scope-'));
  const previous = process.cwd();
  try {
    process.chdir(root);
    for (const scope of ['private', 'shared'] as const) {
      const result = await invoke([
        'docs',
        'forget',
        '00000000-0000-4000-8000-000000000000',
        '--scope',
        scope,
        '--json',
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      const value: unknown = JSON.parse(result.stdout);
      assert(typeof value === 'object' && value !== null);
      assert('action' in value && value.action === 'forget');
      assert('scope' in value && value.scope === scope);
      assert('applied' in value && value.applied === false);
    }
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  }
});

test('docs scope accepts only private or shared, and only for forget', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pappra-cli-scope-'));
  const previous = process.cwd();
  try {
    process.chdir(root);
    const invalid = await invoke([
      'docs',
      'forget',
      '00000000-0000-4000-8000-000000000000',
      '--scope',
      'project',
    ]);
    assert.equal(invalid.status, 2);
    assert.match(
      invalid.stderr,
      /--scope accepts private or shared for docs\./,
    );
    const wrongAction = await invoke(['docs', 'list', '--scope', 'private']);
    assert.equal(wrongAction.status, 2);
    assert.match(
      wrongAction.stderr,
      /Only docs forget accepts --scope private\|shared\./,
    );
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  }
});

test('host keeps its own scope values', async () => {
  const preserved = await invoke([
    'host',
    'plan',
    '--host',
    'claude',
    '--scope',
    'private',
  ]);
  assert.equal(preserved.status, 2);
  assert.match(preserved.stderr, /--scope accepts project or user\./);
});

test('scope stays rejected on unrelated command families', async () => {
  const result = await invoke(['mcp', '--scope', 'private']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--scope is only valid for host or docs\./);
});
