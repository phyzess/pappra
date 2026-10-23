import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  FixtureController,
  PiRpcController,
  driveRun,
  finishStarted,
  prepareCollaboration,
  startPrepared,
} from '../../src/app/collaboration.js';
import { readRecord } from '../../src/collab/store.js';
import { fingerprintSkill } from '../../src/collab/fingerprint.js';
import { cleanup, makeTempDir } from '../workspace/fixtures.js';

const SKILL_PATH = join(process.cwd(), 'src/assets/integrations/skills/pappra');
const SKILL_BUNDLE = fingerprintSkill(SKILL_PATH).bundle_digest;

function setup(label: string, access: 'read' | 'write' = 'write') {
  const root = makeTempDir(`p10-${label}`);
  const cwd = join(root, 'workspace');
  const domainRoot = join(root, 'domain');
  fs.mkdirSync(cwd, { recursive: true });
  const session = `session-${label}`;
  const goal = {
    schema: 'pappra/collaboration-goal/1',
    task_id: `task-${label}`,
    subtask_id: 'work',
    attempt: 1,
    phase: 'implementation',
    objective: 'Bounded repair regression',
    acceptance: ['checked'],
    prompt: 'FROZEN_TASK_PROMPT',
    coordinator: {
      agent_id: 'coordinator',
      session_id: 'coordinator-session',
      harness: 'codex',
      owner_epoch: 1,
    },
    assignee: {
      agent_id: 'worker',
      session_id: session,
      harness: 'pi',
      surface: 'fixture',
      cwd,
      configuration_id: 'fixture-config',
    },
    resources: [{ path: cwd, access }],
    required: {
      skills: [{ id: 'workspace/harness-collab', bundle_digest: SKILL_BUNDLE }],
      tools: ['read'],
    },
    preferred: { skills: [], tools: [] },
  };
  const card = {
    schema: 'harness-collab/capabilities/1',
    agent_id: 'worker',
    session_id: session,
    harness: 'pi',
    surface: 'fixture',
    configuration_id: 'fixture-config',
    cwd,
    observed_at: new Date().toISOString(),
    evidence_level: 'runtime',
    skills: [
      {
        id: 'workspace/harness-collab',
        path: SKILL_PATH,
        bundle_digest: SKILL_BUNDLE,
        state: 'verified',
        evidence_ref: `session:${session}`,
      },
    ],
    tools: [
      {
        id: 'read',
        state: 'verified',
        evidence_ref: `session:${session}`,
      },
    ],
  };
  const cardFile = join(root, 'card.json');
  fs.writeFileSync(cardFile, `${JSON.stringify(card, null, 2)}\n`);
  return { root, cwd, domainRoot, goal, cardFile };
}

async function prepare(box: ReturnType<typeof setup>) {
  const result = await prepareCollaboration(box.goal, {
    domainRoot: box.domainRoot,
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}

test('rejects redirected private namespace and preserves read-only claims', async () => {
  const box = setup('redirect', 'read');
  const taskRoot = join(box.domainRoot, 'tasks', box.goal.task_id);
  const shared = join(box.root, 'outside-private');
  fs.mkdirSync(taskRoot, { recursive: true });
  fs.mkdirSync(shared);
  fs.symlinkSync(shared, join(taskRoot, 'p10'));
  try {
    const result = await prepareCollaboration(box.goal, {
      domainRoot: box.domainRoot,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(fs.readdirSync(shared), []);
  } finally {
    cleanup(box.root);
  }

  const readBox = setup('readonly', 'read');
  try {
    const prepared = await prepare(readBox);
    const record = readRecord(prepared.prepared.task_root);
    assert.equal(record?.claims?.[0]?.access, 'read');
  } finally {
    cleanup(readBox.root);
  }
});

test('records cancel intent and leaves claims pending', async () => {
  const box = setup('cancel');
  try {
    const prepared = await prepare(box);
    const started = await startPrepared(
      join(prepared.prepared.prepared_dir, 'prepared.json'),
      {
        capabilitiesFile: box.cardFile,
        controller: new FixtureController(),
        controllerId: 'fixture',
      },
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const result = await driveRun(
      started.value,
      (async function* () {
        yield {
          schema: 'pappra/collaboration-command/1',
          action: 'cancel',
          request_id: 'cancel-1',
        };
      })(),
      () => undefined,
    );
    assert.equal(result.ok, false);
    const record = readRecord(prepared.prepared.task_root);
    assert(
      record?.messages?.some((message) => message.type === 'CANCEL') === true,
    );
    assert(
      record?.claims?.some((claim) => claim.cancel_pending === true) === true,
    );
  } finally {
    cleanup(box.root);
  }
});

test('marks an ambiguous controller start as unknown instead of not started', async () => {
  const box = setup('ambiguous');
  try {
    const prepared = await prepare(box);
    let sideEffects = 0;
    const started = await startPrepared(
      join(prepared.prepared.prepared_dir, 'prepared.json'),
      {
        capabilitiesFile: box.cardFile,
        controllerId: 'fixture',
        controller: {
          id: 'fixture',
          async start() {
            sideEffects += 1;
            throw new Error('lost connection after launch side effect');
          },
        },
      },
    );
    assert.equal(sideEffects, 1);
    assert.equal(started.ok, false);
    const record = readRecord(prepared.prepared.task_root);
    assert.equal(record?.launch_reservations?.[0]?.outcome, 'spawn_failed');
    assert.equal(record?.attempts?.[0]?.state, 'unknown');
  } finally {
    cleanup(box.root);
  }
});

test('runs the actual Pi adapter against a no-model RPC child', async () => {
  const box = setup('native');
  const oldPath = process.env.PATH;
  const bin = join(box.root, 'bin');
  const log = join(box.root, 'fake-pi.log');
  fs.mkdirSync(bin);
  const fake = fileURLToPath(new URL('../hosts/fake-pi.js', import.meta.url));
  const wrapper = `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({argv: process.argv.slice(2)}) + '\\n');
process.stdin.on('data', (chunk) => fs.appendFileSync(${JSON.stringify(log)}, chunk));
await import(${JSON.stringify(`file://${fake}`)});
`;
  fs.writeFileSync(join(bin, 'pi'), wrapper, { mode: 0o755 });
  process.env.PATH = `${bin}:${oldPath ?? ''}`;
  try {
    const prepared = await prepare(box);
    const started = await startPrepared(
      join(prepared.prepared.prepared_dir, 'prepared.json'),
      {
        capabilitiesFile: box.cardFile,
        controller: new PiRpcController(),
        controllerId: 'pi-rpc',
      },
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const events: unknown[] = [];
    const empty = await driveRun(
      started.value,
      (async function* () {})(),
      (event) => events.push(event),
    );
    assert.equal(empty.ok, false);
    assert.equal(
      (events as { kind?: string }[]).some((event) => event.kind === 'started'),
      true,
    );
    assert.equal((await started.value.session.query()).status, 'disposed');
    const finished = await finishStarted(started.value);
    assert.equal(finished.ok, true);
    if (!finished.ok) return;
    assert.equal(finished.value.status, 'unknown');
    assert.equal(finished.value.outputs.length > 0, true);
    const text = fs.readFileSync(log, 'utf8');
    assert.match(text, /"type":"prompt","message":"FROZEN_TASK_PROMPT/);
    assert.doesNotMatch(text, /--no-mcp|--tools/);
  } finally {
    process.env.PATH = oldPath;
    cleanup(box.root);
  }
});

test('recovers typed assistant output from the no-model Pi adapter', async () => {
  const box = setup('native-message');
  const oldPath = process.env.PATH;
  const oldAssistant = process.env['FAKE_PI_ASSISTANT'];
  const bin = join(box.root, 'bin');
  const log = join(box.root, 'fake-pi.log');
  fs.mkdirSync(bin);
  const fake = fileURLToPath(new URL('../hosts/fake-pi.js', import.meta.url));
  const wrapper = `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({argv: process.argv.slice(2)}) + '\\n');
process.stdin.on('data', (chunk) => fs.appendFileSync(${JSON.stringify(log)}, chunk));
await import(${JSON.stringify(`file://${fake}`)});
`;
  fs.writeFileSync(join(bin, 'pi'), wrapper, { mode: 0o755 });
  process.env.PATH = `${bin}:${oldPath ?? ''}`;
  process.env['FAKE_PI_ASSISTANT'] = '1';
  try {
    const prepared = await prepare(box);
    const started = await startPrepared(
      join(prepared.prepared.prepared_dir, 'prepared.json'),
      {
        capabilitiesFile: box.cardFile,
        controller: new PiRpcController(),
        controllerId: 'pi-rpc',
      },
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;
    await driveRun(started.value, (async function* () {})(), () => undefined);
    const finished = await finishStarted(started.value);
    assert.equal(finished.ok, true);
    if (!finished.ok) return;
    assert.equal(finished.value.status, 'completed');
    assert.equal(
      finished.value.outputs.some(
        (output) =>
          typeof output === 'object' &&
          output !== null &&
          'ref' in output &&
          typeof output.ref === 'string' &&
          output.ref.endsWith('.current-result.json'),
      ),
      true,
    );
  } finally {
    process.env.PATH = oldPath;
    if (oldAssistant === undefined) delete process.env['FAKE_PI_ASSISTANT'];
    else process.env['FAKE_PI_ASSISTANT'] = oldAssistant;
    cleanup(box.root);
  }
});

test('fails honestly when the no-model child refuses the prompt', async () => {
  const box = setup('native-refusal');
  const oldPath = process.env.PATH;
  const bin = join(box.root, 'bin');
  fs.mkdirSync(bin);
  const script = `#!/usr/bin/env node
import fs from 'node:fs';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const sessionId = value('--session-id');
const dir = value('--session-dir');
fs.mkdirSync(dir, { recursive: true });
const file = dir + '/' + sessionId + '.jsonl';
if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ type: 'session', id: sessionId, cwd: process.cwd() }) + '\\n');
const emit = (record) => process.stdout.write(JSON.stringify(record) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.type === 'get_state') {
    emit({ type: 'response', id: request.id, command: request.type, success: true, data: { sessionId, sessionFile: file, isStreaming: false, isCompacting: false, pendingMessageCount: 0, messageCount: 0 } });
  } else {
    emit({ type: 'response', id: request.id, command: request.type, success: false, error: 'fixture prompt refusal' });
  }
});
`;
  fs.writeFileSync(join(bin, 'pi'), script, { mode: 0o755 });
  process.env.PATH = `${bin}:${oldPath ?? ''}`;
  try {
    const prepared = await prepare(box);
    const started = await startPrepared(
      join(prepared.prepared.prepared_dir, 'prepared.json'),
      {
        capabilitiesFile: box.cardFile,
        controller: new PiRpcController(),
        controllerId: 'pi-rpc',
      },
    );
    assert.equal(started.ok, false);
    if (started.ok) return;
    assert.equal(started.code, 'native_prompt_failed');
    const record = readRecord(prepared.prepared.task_root);
    assert.equal(record?.launch_reservations?.[0]?.outcome, 'exited');
    assert.equal(record?.attempts?.[0]?.state, 'unknown');
  } finally {
    process.env.PATH = oldPath;
    cleanup(box.root);
  }
});

test('honors one explicit shared domain across distinct workspaces', async () => {
  const first = setup('shared-first');
  const second = setup('shared-second');
  try {
    second.goal.task_id = 'task-shared-second';
    second.goal.resources = [{ path: first.cwd, access: 'write' }];
    const prepared = await prepareCollaboration(first.goal, {
      domainRoot: first.domainRoot,
    });
    assert.equal(prepared.ok, true);
    const conflict = await prepareCollaboration(second.goal, {
      domainRoot: first.domainRoot,
    });
    assert.equal(conflict.ok, false);
    if (conflict.ok) return;
    assert.equal(conflict.code, 'resource_conflict');
  } finally {
    cleanup(first.root);
    cleanup(second.root);
  }
});

test('composed Pi cancellation reuses driver intent once', async () => {
  const box = setup('composed-cancel');
  const oldPath = process.env.PATH;
  const oldAssistant = process.env['FAKE_PI_ASSISTANT'];
  const bin = join(box.root, 'bin');
  const trace = join(box.root, 'fake-pi-cancel.log');
  fs.mkdirSync(bin);
  const fake = fileURLToPath(new URL('../hosts/fake-pi.js', import.meta.url));
  const wrapper = `#!${process.execPath}
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
process.stdin.on('data', (chunk) => fs.appendFileSync(${JSON.stringify(trace)}, chunk));
await import(${JSON.stringify(`file://${fake}`)});
`;
  fs.writeFileSync(join(bin, 'pi'), wrapper, { mode: 0o755 });
  process.env.PATH = `${bin}:${oldPath ?? ''}`;
  delete process.env['FAKE_PI_ASSISTANT'];
  try {
    const prepared = await prepare(box);
    const started = await startPrepared(
      join(prepared.prepared.prepared_dir, 'prepared.json'),
      {
        capabilitiesFile: box.cardFile,
        controller: new PiRpcController(),
        controllerId: 'pi-rpc',
      },
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const events: Record<string, unknown>[] = [];
    const result = await driveRun(
      started.value,
      (async function* () {
        yield {
          schema: 'pappra/collaboration-command/1',
          action: 'cancel',
          request_id: 'composed-cancel-1',
        };
      })(),
      (event) => events.push(event as unknown as Record<string, unknown>),
    );
    assert.equal(result.ok, false);
    const record = readRecord(prepared.prepared.task_root);
    const cancels = (record?.messages ?? []).filter(
      (message) => message.type === 'CANCEL',
    );
    const cancelUncertainty = (record?.uncertainty ?? []).filter(
      (entry) => entry.kind === 'cancel_unconfirmed',
    );
    const cancelEvent = events.find((event) => event.kind === 'cancel');
    const eventData = cancelEvent?.data as Record<string, unknown> | undefined;
    const native = eventData?.native as Record<string, unknown> | undefined;
    const stopEvidence = native?.stop_evidence as
      Record<string, unknown> | undefined;
    const requests = fs.readFileSync(trace, 'utf8');
    const count = (type: string) =>
      requests.match(new RegExp(`"type":"${type}"`, 'g'))?.length ?? 0;
    assert.equal(
      cancels.length,
      1,
      JSON.stringify({
        cancel_ids: cancels.map((message) => message.message_id),
        uncertainty_count: (record?.uncertainty ?? []).filter(
          (entry) => entry.kind === 'cancel_unconfirmed',
        ).length,
        native_cancel_message_id: stopEvidence?.cancel_message_id ?? null,
        clear_queue_count: count('clear_queue'),
        abort_count: count('abort'),
      }),
    );
    assert.equal(cancelUncertainty.length, 1);
    assert.equal(stopEvidence?.cancel_message_id, cancels[0]?.message_id);
    assert.equal(count('clear_queue'), 1);
    assert.equal(count('abort'), 1);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldAssistant === undefined) delete process.env['FAKE_PI_ASSISTANT'];
    else process.env['FAKE_PI_ASSISTANT'] = oldAssistant;
    cleanup(box.root);
  }
});
