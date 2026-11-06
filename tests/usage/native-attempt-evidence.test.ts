import assert from 'node:assert/strict';
import test from 'node:test';
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
  assert.equal(codexRolloutAttempt(jsonl(rows.slice(0, 9)), window), null);
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
  const assistant = (id: string, timestamp: number, stopReason: string) => ({
    type: 'message',
    id,
    timestamp: stamp(timestamp),
    message: { role: 'assistant', stopReason, usage },
  });
  const rows = [
    { type: 'session', id: 'session-a' },
    assistant('prior', 1, 'stop'),
    assistant('tools', 12, 'toolUse'),
    assistant('done', 30, 'stop'),
    assistant('later', 41, 'stop'),
  ];
  assert.equal(piSessionAttempt(jsonl(rows), window)?.total_tokens, 200);
  assert.equal(piSessionAttempt(jsonl(rows.slice(0, 3)), window), null);
  assert.equal(
    piSessionAttempt(jsonl([...rows, assistant('done', 39, 'stop')]), window),
    null,
  );
});
