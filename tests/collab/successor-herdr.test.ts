import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createHerdrOps,
  type HerdrRunner,
} from '../../src/app/collab-successor/herdr.js';

const run =
  (reply: {
    stdout?: string;
    stderr?: string;
    code?: number | null;
    timedOut?: boolean;
  }): HerdrRunner =>
  async () => ({
    code: reply.code ?? 0,
    stdout: reply.stdout ?? '',
    stderr: reply.stderr ?? '',
    timedOut: reply.timedOut ?? false,
  });

const agent = {
  name: 'succ',
  pane_id: 'w1:p2',
  agent_status: 'idle',
  cwd: '/work',
  agent_session: { kind: 'id', value: 'sess-1' },
};

test('a refusal is read from stderr: a missing agent name means "not taken"', async () => {
  const ops = createHerdrOps({
    run: run({
      code: 1,
      stderr: JSON.stringify({
        error: {
          code: 'agent_not_found',
          message: 'agent target succ not found',
        },
      }),
    }),
  });
  assert.deepEqual(await ops.agentExists('succ'), { ok: true, value: false });
});

test('other refusals stay typed and are not "unknown"; an existing agent is "taken"', async () => {
  const refused = createHerdrOps({
    run: run({
      code: 1,
      stderr: JSON.stringify({
        error: { code: 'pane_not_found', message: 'no such pane' },
      }),
    }),
  });
  const pane = await refused.paneGet('w1:p9');
  assert.equal(pane.ok, false);
  if (!pane.ok) {
    assert.equal(pane.code, 'pane_not_found');
    assert.equal(pane.unknown, false);
  }
  const taken = createHerdrOps({
    run: run({ stdout: JSON.stringify({ result: { agent } }) }),
  });
  assert.deepEqual(await taken.agentExists('succ'), { ok: true, value: true });
});

test('success is read from stdout and parsed into typed values', async () => {
  const ops = createHerdrOps({
    run: run({ stdout: JSON.stringify({ result: { agent } }) }),
  });
  const got = await ops.getAgent('succ');
  assert.ok(got.ok);
  if (got.ok) {
    assert.equal(got.value.sessionValue, 'sess-1');
    assert.equal(got.value.paneId, 'w1:p2');
    assert.equal(got.value.cwd, '/work');
  }
  const pane = await createHerdrOps({
    run: run({
      stdout: JSON.stringify({
        result: {
          pane: {
            pane_id: 'w1:p1',
            cwd: '/work',
            agent_session: { value: 's' },
          },
        },
      }),
    }),
  }).paneGet('w1:p1');
  assert.deepEqual(pane.ok && pane.value, {
    paneId: 'w1:p1',
    cwd: '/work',
    agentName: null,
    sessionValue: 's',
  });
});

test('a timeout or unparseable output is "unknown", never a plain failure', async () => {
  for (const reply of [
    { code: null, timedOut: true },
    { stdout: 'not json' },
    { stdout: JSON.stringify({ unexpected: true }) },
  ]) {
    const result = await createHerdrOps({ run: run(reply) }).splitPane({
      paneId: 'w1:p1',
      cwd: '/work',
      direction: 'right',
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.unknown, true);
  }
});

test('only fixed argv is ever sent: no shell, text only through prompt', async () => {
  const seen: (readonly string[])[] = [];
  const ops = createHerdrOps({
    run: async (argv) => {
      seen.push(argv);
      return {
        code: 0,
        stdout: JSON.stringify({
          result: { agent, pane: { pane_id: 'w1:p3' } },
        }),
        stderr: '',
        timedOut: false,
      };
    },
  });
  await ops.splitPane({ paneId: 'w1:p1', cwd: '/a b', direction: 'down' });
  await ops.startAgent({
    name: 'succ',
    kind: 'claude',
    paneId: 'w1:p3',
    args: ['--session-id', 'u'],
  });
  await ops.promptAgent('succ', "multi\nline 'seed'");
  assert.deepEqual(seen[0], [
    'pane',
    'split',
    'w1:p1',
    '--direction',
    'down',
    '--cwd',
    '/a b',
    '--no-focus',
  ]);
  assert.deepEqual(seen[1]?.slice(0, 7), [
    'agent',
    'start',
    'succ',
    '--kind',
    'claude',
    '--pane',
    'w1:p3',
  ]);
  assert.deepEqual(seen[1]?.slice(-3), ['--', '--session-id', 'u']);
  assert.deepEqual(seen[2], ['agent', 'prompt', 'succ', "multi\nline 'seed'"]);
});
