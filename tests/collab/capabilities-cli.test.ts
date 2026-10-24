import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { cleanup } from '../workspace/fixtures.js';
import {
  FIXTURE_SECRET,
  makeCapabilitiesFixture,
  writeRows,
  type CapabilitiesFixture,
  type FixtureHarness,
} from './capabilities-fixtures.js';

const ROOT = join(
  dirname(fileURLToPath(import.meta.resolve('@phyzess/pappra/package.json'))),
);
const CLI = join(ROOT, 'dist/cli/main.js');

function run(args: readonly string[], cwd: string, timeout = 30_000) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function argsFor(
  fixture: CapabilitiesFixture,
  overrides: Partial<Record<string, string>> = {},
): string[] {
  const harness = overrides.harness ?? fixture.harness;
  const evidence = harness === 'pi' ? '--session' : '--events';
  return [
    'collab',
    'capabilities',
    'derive',
    '--harness',
    harness,
    '--assignment',
    overrides.assignment ?? fixture.assignmentFile,
    '--template',
    overrides.template ?? fixture.templateFile,
    '--execution',
    overrides.execution ?? fixture.executionFile,
    evidence,
    overrides.evidence ??
      (harness === 'pi' ? fixture.sessionFile : fixture.eventsFile),
    '--json',
  ];
}

function digestOf(file: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
}

function snapshot(fixture: CapabilitiesFixture): string[] {
  const files = [
    fixture.assignmentFile,
    fixture.templateFile,
    fixture.executionFile,
    fixture.harness === 'pi' ? fixture.sessionFile : fixture.eventsFile,
    fixture.skillFile,
  ];
  return files.map(
    (file) => `${file}:${String(lstatSync(file).mtimeMs)}:${digestOf(file)}`,
  );
}

test('Pi --live derives directly from a saved interactive session and rejects incompatible modes', () => {
  const fixture = makeCapabilitiesFixture('pi-live-cli', { harness: 'pi' });
  try {
    const args = argsFor(fixture);
    const executionIndex = args.indexOf('--execution');
    args.splice(executionIndex, 2, '--live');
    const before = snapshot(fixture);
    const result = run(args, fixture.cwd);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(parsed.status, 'derived');
    assert.deepEqual(snapshot(fixture), before);
    for (const extra of [['--execution', fixture.executionFile], ['--live']]) {
      const invalid = run([...args, ...extra], fixture.cwd);
      assert.equal(invalid.status, 2, invalid.stdout + invalid.stderr);
    }
  } finally {
    cleanup(fixture.root);
  }
});

for (const harness of ['pi', 'codex', 'claude'] as FixtureHarness[]) {
  test(`installed ${harness} derivation is read-only from an unrelated cwd`, () => {
    const fixture = makeCapabilitiesFixture(`c3-cli-${harness}`, { harness });
    try {
      const unrelated = join(fixture.root, 'elsewhere');
      mkdirSync(unrelated, { recursive: true });
      const before = snapshot(fixture);
      const runResult = run(argsFor(fixture), unrelated);
      assert.equal(runResult.status, 0, runResult.stderr);
      const parsed = JSON.parse(runResult.stdout) as Record<string, unknown>;
      assert.equal(parsed.schema, 'pappra/collaboration-capabilities/1');
      assert.equal(parsed.status, 'derived');
      assert.equal(parsed.harness, harness);
      const card = parsed.card as Record<string, unknown>;
      assert.equal(card.evidence_level, 'runtime');
      assert.ok(!runResult.stdout.includes(FIXTURE_SECRET));
      assert.deepEqual(snapshot(fixture), before);
    } finally {
      cleanup(fixture.root);
    }
  });
}

test('needs_input exits 1 for each host without promoting evidence', () => {
  const pi = makeCapabilitiesFixture('c3-cli-pi-needs', { harness: 'pi' });
  const codex = makeCapabilitiesFixture('c3-cli-codex-needs', {
    harness: 'codex',
  });
  const claude = makeCapabilitiesFixture('c3-cli-claude-needs', {
    harness: 'claude',
  });
  try {
    const piRows = readFileSync(pi.sessionFile, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    writeRows(
      pi.sessionFile,
      piRows.filter(
        (row) =>
          (row.message as Record<string, unknown> | undefined)?.toolCallId !==
          'call-bash',
      ),
    );
    const piRun = run(argsFor(pi), pi.root);
    assert.equal(piRun.status, 1);
    assert.equal(
      (JSON.parse(piRun.stdout) as Record<string, unknown>).status,
      'needs_input',
    );

    const codexRows = readFileSync(codex.eventsFile, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    codexRows.splice(codexRows.length - 1, 0, { type: 'turn.unknown' });
    writeRows(codex.eventsFile, codexRows);
    const codexRun = run(argsFor(codex), codex.root);
    assert.equal(codexRun.status, 1);
    assert.equal(
      (JSON.parse(codexRun.stdout) as Record<string, unknown>).status,
      'needs_input',
    );

    const execution = JSON.parse(
      readFileSync(claude.executionFile, 'utf8'),
    ) as Record<string, unknown>;
    execution.phase = 'exec';
    writeFileSync(claude.executionFile, `${JSON.stringify(execution)}\n`);
    const claudeRun = run(argsFor(claude), claude.root);
    assert.equal(claudeRun.status, 1);
    assert.equal(
      (JSON.parse(claudeRun.stdout) as Record<string, unknown>).status,
      'needs_input',
    );
  } finally {
    cleanup(pi.root);
    cleanup(codex.root);
    cleanup(claude.root);
  }
});

test('invalid options and unsafe configuration files exit 2', () => {
  const fixture = makeCapabilitiesFixture('c3-cli-invalid', {
    harness: 'pi',
  });
  try {
    const wrongHost = run(
      [
        'collab',
        'capabilities',
        'derive',
        '--harness',
        'pi',
        '--assignment',
        fixture.assignmentFile,
        '--template',
        fixture.templateFile,
        '--execution',
        fixture.executionFile,
        '--session',
        fixture.sessionFile,
        '--events',
        fixture.eventsFile,
        '--json',
      ],
      fixture.root,
    );
    assert.equal(wrongHost.status, 2);
    assert.match(wrongHost.stdout, /--events is only valid/);

    const relative = run(
      argsFor(fixture, { assignment: 'assignment.json' }),
      fixture.root,
    );
    assert.equal(relative.status, 2);
    assert.match(relative.stdout, /must be absolute/);

    const unknown = run(
      [...argsFor(fixture), '--output', join(fixture.root, 'out.json')],
      fixture.root,
    );
    assert.equal(unknown.status, 2);

    const duplicate = run(
      [...argsFor(fixture), '--session', fixture.sessionFile],
      fixture.root,
    );
    assert.equal(duplicate.status, 2);

    const fifo = join(fixture.root, 'assignment.fifo');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    const fifoRun = run(
      argsFor(fixture, { assignment: fifo }),
      fixture.root,
      2_000,
    );
    assert.equal(fifoRun.status, 2);
    assert.match(fifoRun.stdout, /regular_file/);

    const link = join(fixture.root, 'assignment.link.json');
    symlinkSync(fixture.assignmentFile, link);
    const linkRun = run(argsFor(fixture, { assignment: link }), fixture.root);
    assert.equal(linkRun.status, 2);
    assert.match(linkRun.stdout, /regular_file/);

    const broken = join(fixture.root, 'broken.json');
    writeFileSync(broken, '{not json');
    const brokenRun = run(
      argsFor(fixture, { assignment: broken }),
      fixture.root,
    );
    assert.equal(brokenRun.status, 2);
    assert.match(brokenRun.stdout, /invalid_json/);
  } finally {
    cleanup(fixture.root);
  }
});

test('special or oversize native evidence is refused promptly', () => {
  const fixture = makeCapabilitiesFixture('c3-cli-special', {
    harness: 'pi',
  });
  try {
    const fifo = join(fixture.root, 'session.fifo');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    const started = Date.now();
    const fifoRun = run(
      argsFor(fixture, { evidence: fifo }),
      fixture.root,
      2_500,
    );
    assert.ok(Date.now() - started < 2_000);
    assert.equal(fifoRun.status, 1);
    const parsed = JSON.parse(fifoRun.stdout) as Record<string, unknown>;
    assert.equal(parsed.status, 'needs_input');
    assert.deepEqual(parsed.blockers, ['unsupported_evidence_file']);

    const link = join(fixture.root, 'session.link.jsonl');
    symlinkSync(fixture.sessionFile, link);
    const linkRun = run(argsFor(fixture, { evidence: link }), fixture.root);
    assert.equal(linkRun.status, 1);
    assert.deepEqual(
      (JSON.parse(linkRun.stdout) as Record<string, unknown>).blockers,
      ['unsupported_evidence_file'],
    );

    const oversize = join(fixture.root, 'session.oversize.jsonl');
    writeFileSync(oversize, '');
    truncateSync(oversize, 16 * 1024 * 1024 + 1);
    const bigRun = run(argsFor(fixture, { evidence: oversize }), fixture.root);
    assert.equal(bigRun.status, 1);
    assert.deepEqual(
      (JSON.parse(bigRun.stdout) as Record<string, unknown>).blockers,
      ['unsupported_evidence_file'],
    );
  } finally {
    cleanup(fixture.root);
  }
});
