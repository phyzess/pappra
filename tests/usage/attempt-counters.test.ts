import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claudeAttemptCounters,
  codexAttemptCounters,
  piAttemptCounters,
} from '../../src/usage/attempt-counters.js';

test('Codex subtracts the earlier cumulative snapshot and includes cache hits once', () => {
  assert.deepEqual(
    codexAttemptCounters(
      { input_tokens: 131138, cached_input_tokens: 106752, output_tokens: 427 },
      { input_tokens: 100000, cached_input_tokens: 80000, output_tokens: 400 },
    ),
    {
      input_tokens: 31138,
      output_tokens: 27,
      cache_read_input_tokens: 26752,
      cache_write_input_tokens: null,
      total_tokens: 31165,
    },
  );
});

test('Claude adds its separate cache creation and read counts to input', () => {
  assert.deepEqual(
    claudeAttemptCounters({
      input_tokens: 15,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 1000,
      output_tokens: 20,
    }),
    {
      input_tokens: 1115,
      output_tokens: 20,
      cache_read_input_tokens: 1000,
      cache_write_input_tokens: 100,
      total_tokens: 1135,
    },
  );
});

test('Pi combines only the selected native rows, including cache reads', () => {
  assert.deepEqual(
    piAttemptCounters([
      { input: 10, output: 4, cacheRead: 25, cacheWrite: 2, totalTokens: 41 },
      { input: 11, output: 5, cacheRead: 25, cacheWrite: 0, totalTokens: 41 },
    ]),
    {
      input_tokens: 73,
      output_tokens: 9,
      cache_read_input_tokens: 50,
      cache_write_input_tokens: 2,
      total_tokens: 82,
    },
  );
});

test('missing, decreasing or internally inconsistent counters remain unknown', () => {
  assert.equal(codexAttemptCounters({}, {}), null);
  assert.equal(
    codexAttemptCounters(
      { input_tokens: 1, cached_input_tokens: 0, output_tokens: 5 },
      { input_tokens: 2, cached_input_tokens: 0, output_tokens: 2 },
    ),
    null,
  );
  assert.equal(
    claudeAttemptCounters({ input_tokens: 15, output_tokens: 20 }),
    null,
  );
  assert.equal(
    piAttemptCounters([
      { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 1 },
    ]),
    null,
  );
  assert.equal(piAttemptCounters([]), null);
});
