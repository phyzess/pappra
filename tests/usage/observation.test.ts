import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  adviseHandoff,
  parseClaudeStatusline,
  parseCodexTokenUsage,
  readUsageObservation,
  usageObservationPath,
  writeUsageObservation,
  type UsageObservation,
} from '../../src/usage/observation.js';
import { cleanup, makeTempDir } from '../workspace/fixtures.js';

const NOW = new Date('2026-10-27T06:00:00.000Z');

const statusline = (overrides: Record<string, unknown> = {}) => ({
  session_id: 'bf4725b6-48d0-4410-8a62-7716b13c1345',
  version: '2.1.308',
  context_window: {
    total_input_tokens: 45734,
    context_window_size: 1000000,
    used_percentage: 5,
    ...overrides,
  },
});

test('claude status line: percent is taken as given and null means not yet observable', () => {
  const observed = parseClaudeStatusline(statusline(), NOW);
  assert.equal(observed?.used_percent, 5);
  assert.equal(observed?.used_tokens, 45734);
  assert.equal(observed?.window_tokens, 1000000);
  assert.equal(observed?.host_version, '2.1.308');
  assert.equal(
    parseClaudeStatusline(statusline({ used_percentage: null }), NOW),
    null,
    'null before the first response is not 0%',
  );
  assert.equal(
    parseClaudeStatusline(statusline({ used_percentage: 101 }), NOW),
    null,
  );
  assert.equal(
    parseClaudeStatusline(statusline({ used_percentage: -1 }), NOW),
    null,
  );
  assert.equal(
    parseClaudeStatusline({ ...statusline(), session_id: '../x' }, NOW),
    null,
  );
  assert.equal(parseClaudeStatusline('nope', NOW), null);
});

test('codex token usage: occupancy is last.totalTokens over the window, never the cumulative total', () => {
  const observed = parseCodexTokenUsage(
    '01a17bbb-731b-7c50-b012-b4e2d12a3981',
    {
      total: { totalTokens: 50222 },
      last: { totalTokens: 25120 },
      modelContextWindow: 475000,
    },
    NOW,
    '0.164.0',
  );
  assert.equal(observed?.used_percent, 5.3);
  assert.equal(observed?.used_tokens, 25120);
  assert.equal(observed?.window_tokens, 475000);
  assert.equal(observed?.source, 'codex-app-server');
  const missingWindow = parseCodexTokenUsage(
    '01a17bbb-731b-7c50-b012-b4e2d12a3981',
    { last: { totalTokens: 1 }, modelContextWindow: null },
    NOW,
  );
  assert.equal(
    missingWindow,
    null,
    'an unknown window cannot give a percentage',
  );
  const over = parseCodexTokenUsage(
    'thread-1',
    { last: { totalTokens: 900 }, modelContextWindow: 100 },
    NOW,
  );
  assert.equal(over?.used_percent, 100, 'capped at 100');
});

test('observation store: atomic private write, strict read, staleness and mismatches', () => {
  const dir = makeTempDir('usage');
  try {
    const observation = parseClaudeStatusline(statusline(), NOW)!;
    const file = writeUsageObservation(dir, observation);
    assert.equal(
      file,
      usageObservationPath(dir, 'claude', observation.session_id),
    );
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(
      statSync(join(dir, 'context-usage')).mode & 0o077,
      0,
      'private directory',
    );

    const fresh = readUsageObservation(dir, 'claude', observation.session_id, {
      now: new Date(NOW.getTime() + 30_000),
    });
    assert.equal(fresh.state, 'available');

    const stale = readUsageObservation(dir, 'claude', observation.session_id, {
      now: new Date(NOW.getTime() + 11 * 60_000),
    });
    assert.deepEqual(stale, { state: 'unavailable', reason: 'stale' });
    const future = readUsageObservation(dir, 'claude', observation.session_id, {
      now: new Date(NOW.getTime() - 5 * 60_000),
    });
    assert.deepEqual(future, { state: 'unavailable', reason: 'stale' });

    assert.deepEqual(
      readUsageObservation(dir, 'claude', 'absent', { now: NOW }),
      {
        state: 'unavailable',
        reason: 'missing',
      },
    );
    assert.deepEqual(
      readUsageObservation(dir, 'claude', '../escape', { now: NOW }),
      {
        state: 'unavailable',
        reason: 'session_id_invalid',
      },
    );
    // A file recorded for another host or session is not accepted under this key.
    writeUsageObservation(dir, { ...observation, session_id: 'other-session' });
    const wrongKey = usageObservationPath(dir, 'claude', 'other-session');
    const swapped = readFileSync(wrongKey, 'utf8').replace(
      'other-session',
      'someone-else',
    );
    writeFileSync(wrongKey, swapped);
    assert.deepEqual(
      readUsageObservation(dir, 'claude', 'other-session', { now: NOW }),
      {
        state: 'unavailable',
        reason: 'invalid',
      },
    );
    // Unknown fields and a bad percent are refused.
    writeFileSync(
      wrongKey,
      JSON.stringify({ ...observation, session_id: 'other-session', extra: 1 }),
    );
    assert.equal(
      readUsageObservation(dir, 'claude', 'other-session', { now: NOW }).state,
      'unavailable',
    );
    writeFileSync(
      wrongKey,
      JSON.stringify({
        ...observation,
        session_id: 'other-session',
        used_percent: 140,
      }),
    );
    assert.equal(
      readUsageObservation(dir, 'claude', 'other-session', { now: NOW }).state,
      'unavailable',
    );
    writeFileSync(wrongKey, '{ not json');
    assert.deepEqual(
      readUsageObservation(dir, 'claude', 'other-session', { now: NOW }),
      {
        state: 'unavailable',
        reason: 'invalid',
      },
    );
  } finally {
    cleanup(dir);
  }
});

test('observation store refuses a redirected directory and a symlinked file', () => {
  const dir = makeTempDir('usage-redirect');
  const outside = makeTempDir('usage-outside');
  try {
    symlinkSync(outside, join(dir, 'context-usage'));
    const observation = parseClaudeStatusline(statusline(), NOW)!;
    assert.throws(
      () => writeUsageObservation(dir, observation),
      /not a real directory/,
    );

    const clean = makeTempDir('usage-link');
    try {
      const real = parseClaudeStatusline(statusline(), NOW)!;
      const file = writeUsageObservation(clean, real);
      const target = join(outside, 'real.json');
      writeFileSync(target, readFileSync(file));
      chmodSync(target, 0o600);
      mkdirSync(join(clean, 'x'), { recursive: true });
      const linked = usageObservationPath(clean, 'claude', 'linked');
      symlinkSync(target, linked);
      assert.deepEqual(
        readUsageObservation(clean, 'claude', 'linked', { now: NOW }),
        {
          state: 'unavailable',
          reason: 'unreadable',
        },
      );
    } finally {
      cleanup(clean);
    }
  } finally {
    cleanup(dir);
    cleanup(outside);
  }
});

test('advice is only an advisory and unavailable is never reported as low', () => {
  const observation: UsageObservation = parseClaudeStatusline(
    statusline({ used_percentage: 72 }),
    NOW,
  )!;
  const advised = adviseHandoff({ state: 'available', observation });
  assert.equal(advised.state, 'advised');
  assert.match(advised.next_action ?? '', /collab handoff check/);
  const low = adviseHandoff({ state: 'available', observation }, 80);
  assert.equal(low.state, 'below_threshold');
  assert.equal(low.next_action, null);
  const unavailable = adviseHandoff({ state: 'unavailable', reason: 'stale' });
  assert.equal(unavailable.state, 'unavailable');
  assert.equal(unavailable.used_percent, null);
});

test('observations dated beyond the skew tolerance are stale, a permission error is not "missing", and finer than one decimal is refused', () => {
  const dir = makeTempDir('usage-edges');
  try {
    const observation = parseClaudeStatusline(statusline(), NOW)!;
    writeUsageObservation(dir, observation);
    const at = (offsetMs: number) =>
      readUsageObservation(dir, 'claude', observation.session_id, {
        now: new Date(NOW.getTime() + offsetMs),
      });
    assert.equal(
      at(-3_000).state,
      'available',
      'a few seconds of skew is tolerated',
    );
    assert.deepEqual(at(-30_000), { state: 'unavailable', reason: 'stale' });

    const file = usageObservationPath(dir, 'claude', observation.session_id);
    chmodSync(file, 0o000);
    try {
      const denied = at(1000);
      // Running as root can still read the file, so only assert when the OS enforced it.
      if (denied.state === 'unavailable')
        assert.equal(denied.reason, 'unreadable');
    } finally {
      chmodSync(file, 0o600);
    }

    writeFileSync(
      file,
      JSON.stringify({ ...observation, used_percent: 33.333 }),
    );
    assert.deepEqual(at(1000), { state: 'unavailable', reason: 'invalid' });
    writeFileSync(file, JSON.stringify({ ...observation, used_percent: 33.3 }));
    assert.equal(at(1000).state, 'available');
  } finally {
    cleanup(dir);
  }
});
