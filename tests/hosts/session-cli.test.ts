import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../../src/cli/run.js';
import {
  planManagedPiSession,
  readManagedPiRequest,
} from '../../src/app/managed-pi.js';

test('managed native launch plan preserves daily configuration and performs no effects', () => {
  const root = mkdtempSync(join(tmpdir(), 'managed-cli-'));
  try {
    const file = join(root, 'request.json');
    const input = {
      schema: 'pappra/managed-pi-session-request/1',
      cwd: root,
      model: 'openai/gpt-6-luna',
      journalPath: join(root, 'ingress.jsonl'),
    };
    writeFileSync(file, JSON.stringify(input));
    const before = readFileSync(file, 'utf8');
    const plan = planManagedPiSession(readManagedPiRequest(file));
    assert.equal(plan.provider, 'openrouter');
    assert.equal(plan.model, input.model);
    assert.equal(plan.daily_configuration, 'preserved');
    assert.equal(plan.native_tui, true);
    assert.equal(plan.effect, 'none');
    assert.equal(plan.transfer_safe_quiescence, 'unavailable');
    assert.equal(readFileSync(file, 'utf8'), before);
    for (const bad of [
      { ...input, journalPath: 'relative' },
      { ...input, model: '--no-tools' },
      { ...input, schema: 'unknown' },
      { ...input, noMcp: true },
      { ...input, shutdownGraceMs: 0 },
      { ...input, cwd: file },
      { ...input, runtime: 'sdk' },
      { ...input, sdkModulePath: join(root, 'index.js') },
      { ...input, runtime: 'sdk', sdkModulePath: 'relative' },
      {
        ...input,
        runtime: 'sdk',
        sdkModulePath: join(root, 'index.js'),
        sessionId: 'old-session',
      },
      {
        ...input,
        runtime: 'sdk',
        sdkModulePath: join(root, 'index.js'),
        piBin: 'pi',
      },
    ]) {
      writeFileSync(file, JSON.stringify(bad));
      assert.throws(() => readManagedPiRequest(file));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SDK launch plan pins a fresh session and exposes only owned-runtime quiescence scope', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdk-session-plan-'));
  try {
    const file = join(root, 'request.json');
    writeFileSync(
      file,
      JSON.stringify({
        schema: 'pappra/managed-pi-session-request/1',
        runtime: 'sdk',
        cwd: root,
        model: 'openai/gpt-6-luna',
        journalPath: join(root, 'events.jsonl'),
        sdkModulePath: join(root, 'sdk/dist/index.js'),
        sessionId: '11111111-1111-4111-8111-111111111111',
      }),
    );
    const plan = planManagedPiSession(readManagedPiRequest(file));
    assert.equal(plan.runtime, 'sdk');
    assert.equal(plan.owned_runtime_quiescence, 'pinned-version-runtime-scope');
    assert.equal(plan.transfer_safe_quiescence, 'unavailable');
    assert.equal(plan.effect, 'none');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('session CLI rejects unsafe modes before native launch and exposes read-only plan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-cli-'));
  const file = join(root, 'request.json');
  writeFileSync(
    file,
    JSON.stringify({
      schema: 'pappra/managed-pi-session-request/1',
      cwd: root,
      model: 'openai/gpt-6-luna',
      journalPath: join(root, 'ingress.jsonl'),
    }),
  );
  const run = async (args: string[]) => {
    let out = '';
    let err = '';
    const code = await runCli(args, {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
    });
    return { code, out, err };
  };
  try {
    const planned = await run(['session', 'plan', '--config', file, '--json']);
    assert.equal(planned.code, 0, planned.out + planned.err);
    assert.equal(
      (JSON.parse(planned.out) as { effect: string }).effect,
      'none',
    );
    assert.equal(
      (await run(['session', 'start', '--config', file, '--json'])).code,
      2,
    );
    assert.equal(
      (await run(['session', 'plan', '--config', file, '--apply', '--json']))
        .code,
      2,
    );
    assert.equal(
      (
        await run([
          'session',
          'plan',
          '--config',
          file,
          '--config',
          file,
          '--json',
        ])
      ).code,
      2,
    );
    assert.equal((await run(['doctor', '--live', '--json'])).code, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
