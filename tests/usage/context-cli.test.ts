import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCli } from '../../src/cli/run.js';
import { runContextCli, shellQuote } from '../../src/cli/commands/context.js';
import {
  parseClaudeStatusline,
  writeUsageObservation,
} from '../../src/usage/observation.js';
import { decodeChain, encodeChain } from '../../src/usage/statusline-beacon.js';
import { cleanup, makeTempDir } from '../workspace/fixtures.js';
import { snapshotTree } from '../collab/task-resources-fixtures.js';

/** Any existing regular file stands in for the compiled beacon entry. */
const THIS_FILE = fileURLToPath(import.meta.url);
const entryFile = (_root: string) => THIS_FILE;
const NOW = new Date('2026-10-27T06:00:00.000Z');
const SESSION = 'bf4725b6-48d0-4410-8a62-7716b13c1345';

async function run(args: string[], dependencies = {}) {
  let stdout = '';
  const code = await runContextCli(
    args,
    { stdout: (t) => (stdout += t), stderr: () => {} },
    { beaconEntry: THIS_FILE, ...dependencies },
  );
  return { code, stdout };
}
function seed(dir: string, percent: number): void {
  const observation = parseClaudeStatusline(
    {
      session_id: SESSION,
      context_window: {
        used_percentage: percent,
        context_window_size: 1000000,
        total_input_tokens: 1,
      },
    },
    NOW,
  )!;
  writeUsageObservation(dir, observation);
}

test('context usage reports an advisory, never a handoff, and exits by availability', async () => {
  const dir = makeTempDir('ctx-usage');
  try {
    seed(dir, 72);
    const deps = { dataDir: dir, now: () => new Date(NOW.getTime() + 10_000) };
    const advised = await run(
      ['usage', '--host', 'claude', '--session', SESSION, '--json'],
      deps,
    );
    assert.equal(advised.code, 0);
    const body = JSON.parse(advised.stdout);
    assert.equal(body.status, 'available');
    assert.equal(body.advice.state, 'advised');
    assert.ok(body.limits.includes('advisory_only'));
    assert.ok(body.limits.includes('no_handoff_started'));

    const low = JSON.parse(
      (
        await run(
          [
            'usage',
            '--host',
            'claude',
            '--session',
            SESSION,
            '--advise-percent',
            '90',
            '--json',
          ],
          deps,
        )
      ).stdout,
    );
    assert.equal(low.advice.state, 'below_threshold');

    const human = await run(
      ['usage', '--host', 'claude', '--session', SESSION],
      deps,
    );
    assert.match(human.stdout, /context 72%/);
    assert.match(human.stdout, /collab handoff check/);

    const stale = await run(
      ['usage', '--host', 'claude', '--session', SESSION, '--json'],
      {
        dataDir: dir,
        now: () => new Date(NOW.getTime() + 3 * 3600_000),
      },
    );
    assert.equal(stale.code, 1);
    assert.equal(JSON.parse(stale.stdout).reason, 'stale');
    const none = await run(
      ['usage', '--host', 'claude', '--session', 'other-session'],
      deps,
    );
    assert.equal(none.code, 1);
    assert.match(none.stdout, /not a low reading/);
  } finally {
    cleanup(dir);
  }
});

test('context usage validates arguments and wires the codex reader without owning it', async () => {
  for (const args of [
    ['usage'],
    ['usage', '--host', 'pi', '--session', SESSION],
    ['usage', '--host', 'claude', '--session', '../x'],
    [
      'usage',
      '--host',
      'claude',
      '--session',
      SESSION,
      '--advise-percent',
      '100',
    ],
    ['usage', '--host', 'claude', '--session', SESSION, '--session', SESSION],
    ['usage', '--host', 'claude', '--session', SESSION, '--bogus'],
    ['nope'],
  ]) {
    const result = await run([...args, '--json']);
    assert.equal(result.code, 2, args.join(' '));
  }
  const unavailable = await run(
    ['usage', '--host', 'codex', '--session', 'thread-1', '--json'],
    {
      readCodex: async () => ({
        state: 'unavailable',
        reason: 'no_rollout_yet',
      }),
    },
  );
  assert.equal(unavailable.code, 1);
  assert.equal(JSON.parse(unavailable.stdout).reason, 'no_rollout_yet');

  const observation = parseClaudeStatusline(
    {
      session_id: 'thread-1',
      context_window: {
        used_percentage: 41,
        context_window_size: 1000,
        total_input_tokens: 1,
      },
    },
    NOW,
  )!;
  const live = await run(
    ['usage', '--host', 'codex', '--session', 'thread-1', '--json'],
    {
      readCodex: async () => ({
        state: 'available',
        observation: {
          ...observation,
          host: 'codex',
          source: 'codex-app-server',
        },
      }),
    },
  );
  assert.equal(live.code, 0);
  assert.equal(
    JSON.parse(live.stdout).limits.includes('live_daemon_read'),
    true,
  );
});

test('the context family is routed before the global parser', async () => {
  let stdout = '';
  const code = await runCli(
    ['context', 'usage', '--host', 'claude', '--session', SESSION, '--json'],
    {
      stdout: (t) => (stdout += t),
      stderr: () => {},
    },
  );
  assert.ok([0, 1].includes(code));
  assert.equal(JSON.parse(stdout).schema, 'pappra/context-usage-result/1');
});

function settings(dir: string, name: string, value: unknown): void {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(
    join(dir, '.claude', name),
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}

test('statusline-plan chains the effective command, writes nothing, and never edits user scope', async () => {
  const root = makeTempDir('ctx-plan');
  try {
    const project = join(root, 'project');
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({
        statusLine: {
          type: 'command',
          command: 'user-line --fancy',
          padding: 2,
        },
      }),
    );
    const before = snapshotTree(root);
    const plan = await run(
      [
        'statusline-plan',
        '--project-dir',
        project,
        '--claude-home',
        home,
        '--json',
      ],
      { beaconEntry: entryFile(root) },
    );
    assert.equal(plan.code, 0, plan.stdout);
    const body = JSON.parse(plan.stdout);
    assert.equal(body.writes, 'none');
    assert.equal(body.current.scope, 'user');
    assert.equal(body.chained_command, 'user-line --fancy');
    assert.equal(
      body.proposed_statusLine.padding,
      2,
      'other keys are preserved',
    );
    const encoded = /--chain-base64 (\S+)/.exec(
      body.proposed_statusLine.command,
    )![1];
    assert.equal(decodeChain(encoded), 'user-line --fancy');
    assert.equal(
      body.apply_to,
      join(project, '.claude', 'settings.local.json'),
    );
    assert.deepEqual(snapshotTree(root), before, 'a plan writes no file');

    // A more specific local setting wins over user scope.
    settings(project, 'settings.local.json', {
      statusLine: { type: 'command', command: 'local-line' },
    });
    const local = JSON.parse(
      (
        await run([
          'statusline-plan',
          '--project-dir',
          project,
          '--claude-home',
          home,
          '--json',
        ])
      ).stdout,
    );
    assert.equal(local.current.scope, 'local');
    assert.equal(local.chained_command, 'local-line');
  } finally {
    cleanup(root);
  }
});

test('statusline-plan with no existing status line chains nothing; unsupported or unreadable settings block', async () => {
  const root = makeTempDir('ctx-plan-none');
  try {
    const project = join(root, 'project');
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    const none = JSON.parse(
      (
        await run([
          'statusline-plan',
          '--project-dir',
          project,
          '--claude-home',
          home,
          '--json',
        ])
      ).stdout,
    );
    assert.equal(none.status, 'planned');
    assert.equal(none.chained_command, null);
    assert.doesNotMatch(none.proposed_statusLine.command, /--chain-base64/);

    settings(project, 'settings.local.json', {
      statusLine: { type: 'static', text: 'hi' },
    });
    const typed = await run([
      'statusline-plan',
      '--project-dir',
      project,
      '--claude-home',
      home,
      '--json',
    ]);
    assert.equal(typed.code, 1);
    assert.equal(JSON.parse(typed.stdout).proposed_statusLine, null);

    settings(project, 'settings.local.json', '{ not json');
    const broken = await run([
      'statusline-plan',
      '--project-dir',
      project,
      '--claude-home',
      home,
      '--json',
    ]);
    assert.equal(broken.code, 1);
    assert.match(JSON.parse(broken.stdout).blockers[0], /unreadable/);

    const relative = await run([
      'statusline-plan',
      '--project-dir',
      'rel',
      '--json',
    ]);
    assert.equal(relative.code, 2);
  } finally {
    cleanup(root);
  }
});

test('statusline-plan quotes the beacon path for a POSIX shell, whatever metacharacters it holds', async () => {
  const nasty = '/tmp/it\'s $HOME `echo INJECTED >&2` "x" y!\\z';
  const quoted = shellQuote(nasty);
  const echoed = spawnSync('/bin/sh', ['-c', `printf %s ${quoted}`], {
    encoding: 'utf8',
  });
  assert.equal(echoed.stdout, nasty, 'the shell yields the exact path');
  assert.equal(echoed.stderr, '', 'nothing inside the path was executed');

  const root = makeTempDir('ctx-plan-quote');
  try {
    mkdirSync(join(root, 'home'), { recursive: true });
    mkdirSync(join(root, 'project'), { recursive: true });
    const body = JSON.parse(
      (
        await run(
          [
            'statusline-plan',
            '--project-dir',
            join(root, 'project'),
            '--claude-home',
            join(root, 'home'),
            '--json',
          ],
          { beaconEntry: THIS_FILE },
        )
      ).stdout,
    );
    assert.ok(
      body.proposed_statusLine.command.startsWith(
        `node ${shellQuote(THIS_FILE)}`,
      ),
    );
    assert.ok(
      !body.proposed_statusLine.command.includes('"'),
      'no double-quoted expansion context',
    );
  } finally {
    cleanup(root);
  }
});

test('statusline-plan blocks a missing beacon build, an unchainable length, and Windows', async () => {
  const root = makeTempDir('ctx-plan-blockers');
  try {
    const project = join(root, 'project');
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(project, '.claude'), { recursive: true });
    const args = [
      'statusline-plan',
      '--project-dir',
      project,
      '--claude-home',
      home,
      '--json',
    ];

    const missing = await run(args, {
      beaconEntry: join(root, 'no-such-entry.js'),
    });
    assert.equal(missing.code, 1);
    assert.match(
      JSON.parse(missing.stdout).blockers.join(' '),
      /does not exist in this build/,
    );

    writeFileSync(
      join(project, '.claude', 'settings.local.json'),
      JSON.stringify({
        statusLine: { type: 'command', command: 'x'.repeat(13_000) },
      }),
    );
    const long = JSON.parse((await run(args)).stdout);
    assert.equal(long.status, 'blocked');
    assert.match(long.blockers.join(' '), /chain limit/);
    assert.ok(encodeChain('x'.repeat(13_000)).length > 16 * 1024);

    const windows = JSON.parse((await run(args, { platform: 'win32' })).stdout);
    assert.match(windows.blockers.join(' '), /POSIX shells only/);
  } finally {
    cleanup(root);
  }
});

test('duplicate path flags and a meaningless --max-age-seconds for codex are refused', async () => {
  const root = makeTempDir('ctx-dupes');
  try {
    const dup = await run([
      'statusline-plan',
      '--project-dir',
      root,
      '--project-dir',
      root,
      '--json',
    ]);
    assert.equal(dup.code, 2);
    const age = await run([
      'usage',
      '--host',
      'codex',
      '--session',
      'thread-1',
      '--max-age-seconds',
      '30',
      '--json',
    ]);
    assert.equal(age.code, 2);
    assert.match(age.stdout, /Claude observations only/);
  } finally {
    cleanup(root);
  }
});
