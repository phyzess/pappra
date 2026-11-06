import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { getPackageRoot } from '../../src/package-info.js';
import {
  claudeInvocationAttempt,
  codexRolloutAttempt,
  piSessionAttempt,
} from '../../src/usage/native-attempt-evidence.js';

const clock = Date.parse('2026-11-06T01:00:00Z');
const stamp = (offset: number) => new Date(clock + offset).toISOString();
const window = {
  sessionId: 'session-a',
  started: clock + 10,
  finished: clock + 40,
};
const jsonl = (rows: readonly unknown[]) =>
  `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
const recording = (name: string) =>
  readFileSync(
    join(getPackageRoot(), 'tests', 'usage', 'fixtures', name),
    'utf8',
  );

test('recorded Codex snapshots count the selected turn delta', () => {
  const usage = codexRolloutAttempt(recording('codex-rollout.jsonl'), {
    sessionId: 'recorded-codex-thread',
    started: clock + 350,
    finished: clock + 700,
  });
  assert.deepEqual(usage, {
    input_tokens: 1412016,
    output_tokens: 6815,
    cache_read_input_tokens: 1388032,
    cache_write_input_tokens: 0,
    total_tokens: 1418831,
  });
});

test('a Codex fork cannot assume zero inherited usage', () => {
  const fork = [
    {
      timestamp: stamp(11),
      type: 'session_meta',
      payload: {
        id: 'session-a',
        forked_from_id: 'parent-thread',
      },
    },
    codexEvent(12, 'task_started', { turn_id: 'fork-turn' }),
    codexCount(13, 120, 70, 21),
    codexEvent(14, 'task_complete', { turn_id: 'fork-turn' }),
  ];
  assert.equal(codexRolloutAttempt(jsonl(fork), window), null);
});

test('recorded Claude stream uses the terminal usage from its native envelope', () => {
  const usage = claudeInvocationAttempt(
    recording('claude-stream.jsonl'),
    {
      status: 'exited',
      exit_code: 0,
      started_at: stamp(20),
      finished_at: stamp(30),
    },
    { ...window, sessionId: 'recorded-claude-session' },
  );
  assert.equal(usage?.total_tokens, 17);
  const [init, result] = recording('claude-stream.jsonl').trim().split('\n');
  const foreign = JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 'other',
  });
  assert.equal(
    claudeInvocationAttempt(
      [init, foreign, result].join('\n'),
      {
        status: 'exited',
        exit_code: 0,
        started_at: stamp(20),
        finished_at: stamp(30),
      },
      { ...window, sessionId: 'recorded-claude-session' },
    ),
    null,
  );
});

test('recorded Pi turn includes assistant responses across a native tool chain', () => {
  const usage = piSessionAttempt(recording('pi-session.jsonl'), {
    sessionId: 'recorded-pi-session',
    started: clock,
    finished: clock + 5000,
  });
  assert.equal(usage?.total_tokens, 1931913);
});

function codexEvent(timestamp: number, type: string, payload: object) {
  return {
    timestamp: stamp(timestamp),
    type: 'event_msg',
    payload: { type, ...payload },
  };
}

function codexCount(
  timestamp: number,
  input: number,
  cached: number,
  output: number,
) {
  return codexEvent(timestamp, 'token_count', {
    info: {
      total_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
      },
    },
  });
}

test('Codex rollout isolates completed turns by subtracting the prior thread total', () => {
  const rows = [
    { timestamp: stamp(0), type: 'session_meta', payload: { id: 'session-a' } },
    codexEvent(1, 'task_started', { turn_id: 'older' }),
    codexCount(2, 100, 60, 10),
    codexEvent(3, 'task_complete', { turn_id: 'older' }),
    codexEvent(11, 'task_started', { turn_id: 'attempt-1' }),
    codexCount(12, 160, 90, 21),
    codexEvent(13, 'task_complete', { turn_id: 'attempt-1' }),
    codexEvent(20, 'task_started', { turn_id: 'attempt-2' }),
    codexCount(21, 230, 140, 35),
    codexEvent(22, 'task_complete', { turn_id: 'attempt-2' }),
    codexEvent(41, 'task_started', { turn_id: 'later' }),
    codexCount(42, 360, 200, 60),
    codexEvent(43, 'task_complete', { turn_id: 'later' }),
  ];
  assert.deepEqual(codexRolloutAttempt(jsonl(rows), window), {
    input_tokens: 130,
    output_tokens: 25,
    cache_read_input_tokens: 80,
    cache_write_input_tokens: null,
    total_tokens: 155,
  });
  assert.equal(
    codexRolloutAttempt(jsonl([rows[0], ...rows.slice(4)]), window),
    null,
  );
  assert.equal(
    codexRolloutAttempt(jsonl(rows.slice(0, 9)), window)?.total_tokens,
    71,
  );
});

test('Claude terminal evidence requires the exact session and a complete invocation window', () => {
  const events = jsonl([
    { type: 'system', subtype: 'init', session_id: 'session-a' },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'session-a',
      usage: {
        input_tokens: 20,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 100,
        output_tokens: 10,
      },
    },
  ]);
  const execution = {
    status: 'exited',
    exit_code: 0,
    started_at: stamp(11),
    finished_at: stamp(30),
  };
  assert.equal(
    claudeInvocationAttempt(events, execution, window)?.total_tokens,
    160,
  );
  assert.equal(
    claudeInvocationAttempt(events, execution, {
      ...window,
      sessionId: 'other',
    }),
    null,
  );
  assert.equal(
    claudeInvocationAttempt(
      events,
      { ...execution, started_at: stamp(0) },
      window,
    ),
    null,
  );
});

test('Pi ignores prior session usage and requires a completed response', () => {
  const usage = {
    input: 20,
    output: 10,
    cacheRead: 30,
    cacheWrite: 40,
    totalTokens: 100,
  };
  const message = (
    id: string,
    parentId: string | null,
    timestamp: number,
    payload: object,
  ) => ({
    type: 'message',
    id,
    parentId,
    timestamp: stamp(timestamp),
    message: payload,
  });
  const assistant = (
    id: string,
    parentId: string,
    timestamp: number,
    stopReason: string,
  ) =>
    message(id, parentId, timestamp, { role: 'assistant', stopReason, usage });
  const rows = [
    { type: 'session', id: 'session-a' },
    message('prior-user', null, 0, { role: 'user' }),
    assistant('prior', 'prior-user', 1, 'stop'),
    message('attempt-user', 'prior', 11, { role: 'user' }),
    assistant('tools', 'attempt-user', 12, 'toolUse'),
    message('tool-result', 'tools', 20, { role: 'toolResult' }),
    assistant('done', 'tool-result', 30, 'stop'),
    message('later-user', 'done', 41, { role: 'user' }),
    assistant('later', 'later-user', 42, 'stop'),
  ];
  assert.equal(piSessionAttempt(jsonl(rows), window)?.total_tokens, 200);
  assert.equal(piSessionAttempt(jsonl(rows.slice(0, 6)), window), null);
  assert.equal(
    piSessionAttempt(jsonl(rows), { ...window, started: clock + 12 }),
    null,
  );
  assert.equal(
    piSessionAttempt(
      jsonl([
        ...rows.slice(0, 6),
        assistant('other-branch', 'attempt-user', 30, 'stop'),
      ]),
      window,
    ),
    null,
  );
  assert.equal(
    piSessionAttempt(
      jsonl([...rows.slice(0, 5), assistant('done', 'tools', 30, 'stop')]),
      window,
    ),
    null,
  );
  assert.equal(
    piSessionAttempt(
      jsonl([
        ...rows.slice(0, 4),
        assistant('early', 'attempt-user', 10, 'stop'),
      ]),
      window,
    ),
    null,
  );
});
