import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  FixtureController,
  PiRpcController,
  driveRun,
  finishStarted,
  prepareCollaboration,
  startPrepared,
  submitResultReport,
  type CollaborationController,
} from '../../src/app/collaboration.js';
import { readRecord, transact } from '../../src/collab/store.js';
import { fingerprintSkill } from '../../src/collab/fingerprint.js';
import { cleanup, makeTempDir } from '../workspace/fixtures.js';

const SKILL_PATH = join(process.cwd(), 'src/assets/integrations/skills/pappra');
const SKILL_BUNDLE = fingerprintSkill(SKILL_PATH).bundle_digest;

function setup(
  label: string,
  surface: 'fixture' | 'pi' = 'fixture',
  access: 'read' | 'write' = 'write',
) {
  const root = makeTempDir(`p10r2-${label}`);
  const cwd = join(root, 'workspace');
  const domainRoot = join(root, 'domain');
  fs.mkdirSync(cwd, { recursive: true });
  const session = `${label}-session`;
  const goal = {
    schema: 'pappra/collaboration-goal/1',
    task_id: `${label}-task`,
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
      surface,
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
    surface,
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
      { id: 'read', state: 'verified', evidence_ref: `session:${session}` },
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

function startOf(
  box: ReturnType<typeof setup>,
  prepared: Awaited<ReturnType<typeof prepare>>,
  controller: CollaborationController = new FixtureController(),
) {
  return startPrepared(join(prepared.prepared.prepared_dir, 'prepared.json'), {
    capabilitiesFile: box.cardFile,
    controller,
    controllerId: controller.id,
  });
}

test('refuses a task-root symlink before writing task metadata', async () => {
  const box = setup('alias');
  const tasks = join(box.domainRoot, 'tasks');
  const outside = join(box.root, 'outside-task');
  fs.mkdirSync(tasks, { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, join(tasks, box.goal.task_id));
  try {
    const result = await prepareCollaboration(box.goal, {
      domainRoot: box.domainRoot,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.code, /namespace_redirected|init_target_unsafe/);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    cleanup(box.root);
  }
});

test('refuses a private directory redirected during preparation', async () => {
  const box = setup('during');
  const moved = join(box.root, 'shared-moved');
  const original = fs.writeFileSync;
  let switched = false;
  fs.writeFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    const result = (original as (...args: unknown[]) => void)(file, ...rest);
    if (
      typeof file === 'string' &&
      file.endsWith('/p10/goal.json') &&
      !switched
    ) {
      const directory = join(file, '..', '');
      fs.renameSync(directory, moved);
      fs.symlinkSync(moved, directory);
      switched = true;
    }
    return result;
  }) as typeof fs.writeFileSync;
  try {
    const result = await prepareCollaboration(box.goal, {
      domainRoot: box.domainRoot,
    });
    assert.equal(switched, true);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'private_namespace_redirected');
    assert.deepEqual(fs.readdirSync(moved), ['goal.json']);
  } finally {
    fs.writeFileSync = original;
    cleanup(box.root);
  }
});

test('refuses a prepared task moved outside private state without reading it', async () => {
  const box = setup('after');
  try {
    const prepared = await prepare(box);
    const privateDir = prepared.prepared.prepared_dir;
    const moved = join(box.root, 'outside-prepared');
    fs.renameSync(privateDir, moved);
    fs.symlinkSync(moved, privateDir);
    const original = fs.readFileSync;
    let outsideReads = 0;
    fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof file === 'string' && file.startsWith(`${privateDir}/`)) {
        outsideReads += 1;
      }
      return (original as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync;
    try {
      const started = await startOf(box, prepared);
      assert.equal(started.ok, false);
      if (started.ok) return;
      assert.match(started.code, /namespace_redirected|unrecognized/);
      assert.equal(outsideReads, 0);
    } finally {
      fs.readFileSync = original;
    }
  } finally {
    cleanup(box.root);
  }
});

test('a repeated rejected REPORT stays rejected while an accepted duplicate succeeds', async () => {
  const stale = setup('stale');
  try {
    const prepared = await prepare(stale);
    const started = await startOf(stale, prepared);
    assert.equal(started.ok, true);
    if (!started.ok) return;
    transact(prepared.prepared.task_root, {
      actor: 'regression',
      purpose: 'replace assignee',
      apply: (record) => {
        record.attempts[0]!.assignee.session_id = 'replacement-session';
        return { record, op: 'owner-change', summary: null, result: null };
      },
    });
    const finished = await finishStarted(started.value);
    assert.equal(finished.ok, true);
    if (!finished.ok) return;
    const first = submitResultReport(started.value, finished.value);
    const second = submitResultReport(started.value, finished.value);
    assert.equal(first.ok, false);
    assert.equal(first.classification, 'stale_sender');
    assert.equal(second.ok, false);
    assert.equal(second.classification, 'stale_sender');
    const stored = readRecord(prepared.prepared.task_root)?.results ?? [];
    assert.deepEqual(
      stored.map((entry) => entry.classification),
      ['stale_sender'],
    );
  } finally {
    cleanup(stale.root);
  }

  const accepted = setup('accepted');
  try {
    const prepared = await prepare(accepted);
    const started = await startOf(accepted, prepared);
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const finished = await finishStarted(started.value);
    assert.equal(finished.ok, true);
    if (!finished.ok) return;
    const first = submitResultReport(started.value, finished.value);
    const second = submitResultReport(started.value, finished.value);
    assert.equal(first.ok, true);
    assert.equal(first.classification, 'applied');
    assert.equal(second.ok, true);
    assert.equal(second.duplicate, true);
    assert.equal(second.classification, 'applied');
    const stored = readRecord(prepared.prepared.task_root)?.results ?? [];
    assert.equal(stored.length, 1);
  } finally {
    cleanup(accepted.root);
  }
});

test('denied cancellation authority never calls the native controller', async () => {
  const box = setup('denied');
  let cancelCalls = 0;
  const controller: CollaborationController = {
    id: 'fixture',
    async start() {
      return {
        ok: true as const,
        session: {
          async query() {
            return { status: 'live', detail: null, data: null };
          },
          async cancel() {
            cancelCalls += 1;
            return {
              acknowledged: true,
              terminal_observed: false,
              stop_evidence: null,
            };
          },
          async finish() {
            return {
              outcome: 'exited',
              status: 'completed',
              exitCode: 0,
              sessionId: box.goal.assignee.session_id,
              outputs: [],
              nativeRef: null,
              evidenceRef: null,
            };
          },
          async dispose() {},
        },
      };
    },
  };
  try {
    const prepared = await prepare(box);
    const started = await startOf(box, prepared, controller);
    assert.equal(started.ok, true);
    if (!started.ok) return;
    transact(prepared.prepared.task_root, {
      actor: 'regression',
      purpose: 'coordinator epoch changes',
      apply: (record) => {
        record.coordinator!.owner_epoch = 2;
        return { record, op: 'owner-epoch', summary: null, result: null };
      },
    });
    const events: { kind?: string; status?: string; data?: unknown }[] = [];
    const result = await driveRun(
      started.value,
      (async function* () {
        yield {
          schema: 'pappra/collaboration-command/1',
          action: 'cancel',
          request_id: 'denied-cancel',
        };
      })(),
      (event) => events.push(event),
    );
    assert.equal(result.ok, false);
    assert.equal(cancelCalls, 0);
    const cancel = events.find((event) => event.kind === 'cancel');
    assert.equal(cancel?.status, 'cancel-intent-failed');
    const record = readRecord(prepared.prepared.task_root);
    assert.equal(
      record?.claims?.some((claim) => claim.cancel_pending === true) !== true,
      true,
    );
  } finally {
    cleanup(box.root);
  }
});

function fakePiSource(mode: string): string {
  return `#!/usr/bin/env node
import fs from 'node:fs';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const sessionId = value('--session-id');
const dir = value('--session-dir');
const file = dir + '/' + sessionId + '.jsonl';
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(file, JSON.stringify({ type: 'session', id: sessionId, cwd: process.cwd() }) + '\\n');
const assistant = ${JSON.stringify(mode)} === 'error'
  ? { type: 'message', role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Synthetic provider failure' }
  : ${JSON.stringify(mode)} === 'aborted'
    ? { type: 'message', role: 'assistant', content: [], stopReason: 'aborted' }
    : ${JSON.stringify(mode)} === 'tool'
      ? { type: 'message', role: 'assistant', content: [{ type: 'tool_use', name: 'read' }], stopReason: 'toolUse' }
      : ${JSON.stringify(mode)} === 'text-tool'
        ? { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'I will inspect a file next.' }, { type: 'toolCall', name: 'read' }], stopReason: 'toolUse' }
        : ${JSON.stringify(mode)} === 'incomplete'
          ? { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'partial answer' }], stopReason: 'length' }
          : ${JSON.stringify(mode)} === 'missing-terminal'
            ? { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'answer without terminal marker' }] }
            : ${JSON.stringify(mode)} === 'empty-terminal'
              ? { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'answer with empty terminal' }], stopReason: '' }
              : ${JSON.stringify(mode)} === 'nonstring-terminal'
                ? { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'answer with malformed terminal' }], stopReason: 42 }
                : { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'current answer' }], stopReason: 'stop' };
if (${JSON.stringify(mode)} === 'prior') fs.appendFileSync(file, JSON.stringify(assistant) + '\\n');
const emit = (record) => process.stdout.write(JSON.stringify(record) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.type === 'get_state') {
    emit({ type: 'response', id: request.id, command: request.type, success: true, data: { sessionId, sessionFile: file, isStreaming: false, isCompacting: false, pendingMessageCount: 0, messageCount: 0 } });
    return;
  }
  if (request.type === 'prompt') {
    if (${JSON.stringify(mode)} !== 'prior') fs.appendFileSync(file, JSON.stringify(assistant) + '\\n');
    emit({ type: 'response', id: request.id, command: request.type, success: true, data: { disposition: 'started' } });
    emit({ type: 'agent_settled' });
    return;
  }
  emit({ type: 'response', id: request.id, command: request.type, success: true, data: {} });
});
`;
}

test('recovers only the current prompt-correlated native result', async () => {
  for (const [mode, expected] of [
    ['success', 'completed'],
    ['prior', 'unknown'],
    ['error', 'failed'],
    ['aborted', 'cancelled'],
    ['tool', 'unknown'],
    ['text-tool', 'unknown'],
    ['incomplete', 'unknown'],
    ['missing-terminal', 'unknown'],
    ['empty-terminal', 'unknown'],
    ['nonstring-terminal', 'unknown'],
  ] as const) {
    const box = setup(`native-${mode}`, 'pi');
    const oldPath = process.env.PATH;
    const bin = join(box.root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(join(bin, 'pi'), fakePiSource(mode), {
      mode: 0o755,
    });
    process.env.PATH = `${bin}:${oldPath ?? ''}`;
    try {
      const prepared = await prepare(box);
      const started = await startOf(box, prepared, new PiRpcController());
      assert.equal(started.ok, true);
      if (!started.ok) throw new Error(JSON.stringify(started));
      const finished = await finishStarted(started.value);
      assert.equal(finished.ok, true);
      if (!finished.ok) throw new Error(JSON.stringify(finished));
      assert.equal(finished.value.status, expected);
      const evidence = finished.value.outputs.find(
        (output) =>
          typeof output === 'object' &&
          output !== null &&
          'ref' in output &&
          typeof output.ref === 'string' &&
          output.ref.endsWith('.current-result.json'),
      );
      assert.notEqual(evidence, undefined);
      await started.value.session.dispose?.();
    } finally {
      process.env.PATH = oldPath;
      cleanup(box.root);
    }
  }
});

test('live namespace redirect prevents query and finish pathname effects', async () => {
  const box = setup('native-live-redirect', 'pi');
  const oldPath = process.env.PATH;
  const bin = join(box.root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(join(bin, 'pi'), fakePiSource('success'), { mode: 0o755 });
  process.env.PATH = `${bin}:${oldPath ?? ''}`;
  try {
    const prepared = await prepare(box);
    const started = await startOf(box, prepared, new PiRpcController());
    if (!started.ok) throw new Error(JSON.stringify(started));
    const privateDir = prepared.prepared.prepared_dir;
    const moved = join(box.root, 'moved-private');
    fs.renameSync(privateDir, moved);
    fs.symlinkSync(moved, privateDir);
    const before = fs.readdirSync(join(moved, 'evidence')).sort();
    const query = await started.value.session.query();
    assert.equal(query.status, 'unknown');
    const finished = await finishStarted(started.value);
    if (!finished.ok) throw new Error(JSON.stringify(finished));
    assert.equal(finished.value.status, 'unknown');
    assert.equal(finished.value.outputs.length, 0);
    const after = fs.readdirSync(join(moved, 'evidence')).sort();
    assert.deepEqual(after, before);
    assert.equal(
      after.some((name) => /query|execution|proof|current-result/.test(name)),
      false,
    );
    await started.value.session.dispose?.();
  } finally {
    process.env.PATH = oldPath;
    cleanup(box.root);
  }
});

test('current-result publication failure is visible and repeated finish reuses evidence', async () => {
  const box = setup('native-write-failure', 'pi');
  const oldPath = process.env.PATH;
  const originalWrite = fs.writeFileSync;
  const bin = join(box.root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(join(bin, 'pi'), fakePiSource('success'), { mode: 0o755 });
  process.env.PATH = `${bin}:${oldPath ?? ''}`;
  try {
    const prepared = await prepare(box);
    const started = await startOf(box, prepared, new PiRpcController());
    if (!started.ok) throw new Error(JSON.stringify(started));
    let attempts = 0;
    fs.writeFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof file === 'string' && file.endsWith('.current-result.json')) {
        attempts += 1;
        throw Object.assign(new Error('injected EIO'), { code: 'EIO' });
      }
      return (originalWrite as (...args: unknown[]) => void)(file, ...rest);
    }) as typeof fs.writeFileSync;
    const failed = await finishStarted(started.value);
    fs.writeFileSync = originalWrite;
    if (!failed.ok) throw new Error(JSON.stringify(failed));
    assert.equal(attempts, 1);
    assert.equal(failed.value.status, 'unknown');
    assert.equal(
      failed.value.outputs.some(
        (output) =>
          typeof output === 'object' &&
          output !== null &&
          'ref' in output &&
          typeof output.ref === 'string' &&
          output.ref.endsWith('.current-result.json'),
      ),
      false,
    );
    const native = failed.value.nativeRef as Record<string, unknown>;
    assert.equal(typeof native['current_result_publication_error'], 'string');
    const recovered = await finishStarted(started.value);
    if (!recovered.ok) throw new Error(JSON.stringify(recovered));
    assert.equal(recovered.value.status, 'completed');
    const again = await finishStarted(started.value);
    if (!again.ok) throw new Error(JSON.stringify(again));
    assert.equal(again.value.status, 'completed');
    await started.value.session.dispose?.();
  } finally {
    fs.writeFileSync = originalWrite;
    process.env.PATH = oldPath;
    cleanup(box.root);
  }
});

test('current-result conflicts and symlinks are visible and never overwritten', async () => {
  for (const mode of ['foreign', 'symlink'] as const) {
    const box = setup(`native-result-${mode}`, 'pi');
    const oldPath = process.env.PATH;
    const bin = join(box.root, 'bin');
    const outside = join(box.root, 'outside-result');
    fs.mkdirSync(bin);
    fs.writeFileSync(join(bin, 'pi'), fakePiSource('success'), {
      mode: 0o755,
    });
    process.env.PATH = `${bin}:${oldPath ?? ''}`;
    try {
      const prepared = await prepare(box);
      const started = await startOf(box, prepared, new PiRpcController());
      if (!started.ok) throw new Error(JSON.stringify(started));
      const sessionDir = join(
        prepared.prepared.task_root,
        'p10',
        'evidence',
        'pi-sessions',
      );
      fs.mkdirSync(sessionDir, { recursive: true });
      const resultFile = join(
        sessionDir,
        `${box.goal.assignee.session_id}.jsonl.current-result.json`,
      );
      if (mode === 'foreign') {
        fs.writeFileSync(resultFile, 'foreign content');
      } else {
        fs.writeFileSync(outside, 'outside content');
        fs.symlinkSync(outside, resultFile);
      }
      const finished = await finishStarted(started.value);
      if (!finished.ok) throw new Error(JSON.stringify(finished));
      assert.equal(finished.value.status, 'unknown');
      const native = finished.value.nativeRef as Record<string, unknown>;
      assert.equal(typeof native['current_result_publication_error'], 'string');
      assert.equal(
        finished.value.outputs.some(
          (output) =>
            typeof output === 'object' &&
            output !== null &&
            'ref' in output &&
            typeof output.ref === 'string' &&
            output.ref.endsWith('.current-result.json'),
        ),
        false,
      );
      if (mode === 'foreign') {
        assert.equal(fs.readFileSync(resultFile, 'utf8'), 'foreign content');
      } else {
        assert.equal(fs.lstatSync(resultFile).isSymbolicLink(), true);
        assert.equal(fs.readFileSync(outside, 'utf8'), 'outside content');
      }
      await started.value.session.dispose?.();
    } finally {
      process.env.PATH = oldPath;
      cleanup(box.root);
    }
  }
});

test('mid-finish redirect stops later evidence writes, hashes and settlement', async () => {
  const box = setup('native-finish-redirect', 'pi');
  const oldPath = process.env.PATH;
  const originalWrite = fs.writeFileSync;
  const bin = join(box.root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(join(bin, 'pi'), fakePiSource('success'), {
    mode: 0o755,
  });
  process.env.PATH = `${bin}:${oldPath ?? ''}`;
  try {
    const prepared = await prepare(box);
    const started = await startOf(box, prepared, new PiRpcController());
    if (!started.ok) throw new Error(JSON.stringify(started));
    const privateDir = prepared.prepared.prepared_dir;
    const moved = join(box.root, 'moved-private');
    fs.writeFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      const result = (originalWrite as (...args: unknown[]) => void)(
        file,
        ...rest,
      );
      if (typeof file === 'string' && file.endsWith('pi-rpc.execution.json')) {
        fs.renameSync(privateDir, moved);
        fs.symlinkSync(moved, privateDir);
      }
      return result;
    }) as typeof fs.writeFileSync;
    const finished = await finishStarted(started.value);
    fs.writeFileSync = originalWrite;
    if (!finished.ok) throw new Error(JSON.stringify(finished));
    assert.equal(finished.value.status, 'unknown');
    assert.equal(finished.value.outputs.length, 0);
    const evidence = fs.readdirSync(join(moved, 'evidence')).sort();
    assert.equal(evidence.includes('pi-rpc.execution.json'), true);
    assert.equal(evidence.includes('pi-rpc.proof.json'), false);
    assert.equal(evidence.includes('pi-rpc.stderr.log'), false);
    assert.equal(
      evidence.some((name) => name.includes('current-result')),
      false,
    );
    await started.value.session.dispose?.();
  } finally {
    fs.writeFileSync = originalWrite;
    process.env.PATH = oldPath;
    cleanup(box.root);
  }
});

test('query mid-redirect stops later body hashes and redirected evidence refs', async () => {
  const box = setup('native-query-redirect', 'pi');
  const oldPath = process.env.PATH;
  const originalWrite = fs.writeFileSync;
  const originalRead = fs.readFileSync;
  const bin = join(box.root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(join(bin, 'pi'), fakePiSource('success'), {
    mode: 0o755,
  });
  process.env.PATH = `${bin}:${oldPath ?? ''}`;
  try {
    const prepared = await prepare(box);
    const started = await startOf(box, prepared, new PiRpcController());
    if (!started.ok) throw new Error(JSON.stringify(started));
    const privateDir = prepared.prepared.prepared_dir;
    const moved = join(box.root, 'moved-private');
    let redirectedBodyReads = 0;
    fs.writeFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      const result = (originalWrite as (...args: unknown[]) => void)(
        file,
        ...rest,
      );
      if (typeof file === 'string' && file.endsWith('.query-1.json')) {
        fs.renameSync(privateDir, moved);
        fs.symlinkSync(moved, privateDir);
      }
      return result;
    }) as typeof fs.writeFileSync;
    fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof file === 'string' && file.startsWith(`${privateDir}/`)) {
        redirectedBodyReads += 1;
      }
      return (originalRead as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync;
    const query = await started.value.session.query();
    fs.writeFileSync = originalWrite;
    fs.readFileSync = originalRead;
    assert.equal(query.status, 'unknown');
    assert.equal(query.data, null);
    assert.equal(redirectedBodyReads, 0);
    const finished = await finishStarted(started.value);
    if (!finished.ok) throw new Error(JSON.stringify(finished));
    assert.equal(finished.value.status, 'unknown');
    assert.equal(finished.value.outputs.length, 0);
    await started.value.session.dispose?.();
  } finally {
    fs.writeFileSync = originalWrite;
    fs.readFileSync = originalRead;
    process.env.PATH = oldPath;
    cleanup(box.root);
  }
});

test('current-result mid-redirect verification opens no redirected body', async () => {
  const box = setup('native-result-redirect', 'pi');
  const oldPath = process.env.PATH;
  const originalWrite = fs.writeFileSync;
  const originalRead = fs.readFileSync;
  const bin = join(box.root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(join(bin, 'pi'), fakePiSource('success'), {
    mode: 0o755,
  });
  process.env.PATH = `${bin}:${oldPath ?? ''}`;
  try {
    const prepared = await prepare(box);
    const started = await startOf(box, prepared, new PiRpcController());
    if (!started.ok) throw new Error(JSON.stringify(started));
    const privateDir = prepared.prepared.prepared_dir;
    const moved = join(box.root, 'moved-private');
    let redirectedBodyReads = 0;
    fs.writeFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      const result = (originalWrite as (...args: unknown[]) => void)(
        file,
        ...rest,
      );
      if (typeof file === 'string' && file.endsWith('.current-result.json')) {
        fs.renameSync(privateDir, moved);
        fs.symlinkSync(moved, privateDir);
      }
      return result;
    }) as typeof fs.writeFileSync;
    fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof file === 'string' && file.startsWith(`${privateDir}/`)) {
        redirectedBodyReads += 1;
      }
      return (originalRead as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync;
    const finished = await finishStarted(started.value);
    fs.writeFileSync = originalWrite;
    fs.readFileSync = originalRead;
    if (!finished.ok) throw new Error(JSON.stringify(finished));
    assert.equal(finished.value.status, 'unknown');
    assert.equal(finished.value.outputs.length, 0);
    assert.equal(redirectedBodyReads, 0);
    await started.value.session.dispose?.();
  } finally {
    fs.writeFileSync = originalWrite;
    fs.readFileSync = originalRead;
    process.env.PATH = oldPath;
    cleanup(box.root);
  }
});
