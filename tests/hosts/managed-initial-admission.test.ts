import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { watchManagedPiInitialAdmission } from '../../src/app/managed-pi-initial-admission.js';
import type { ManagedPiSdkSessionController } from '../../src/hosts/pi/managed-sdk-session.js';
import { claimResources } from '../../src/collab/resources.js';
import { buildMessage } from '../../src/collab/envelope.js';
import { submitMessage } from '../../src/collab/messages.js';
import { transact } from '../../src/collab/store.js';
import { readBoundedFile } from '../../src/app/bounded-file.js';
import type { Assignment } from '../../src/collab/contracts.js';
import type { TaskRecord } from '../../src/collab/types.js';
import { makeTaskDomain, CLAIMANT } from '../collab/task-resources-fixtures.js';
import { owner } from '../collab/scenarios.js';

const INPUT_REVISION = `sha256:${'a'.repeat(64)}`;

function fakeController(sessionId: string, agentId: string, cwd: string) {
  const listeners = new Set<(event: unknown) => void>();
  const snapshot = {
    schema: 'harness-collab/pi-managed-sdk-session/1',
    process: { pid: process.pid, exit: 'not_owned' },
    session: { sessionId, sessionFile: null },
    contextUsage: null,
    ingress: {
      state: 'open',
      journalPath: '/tmp/fixture',
      sequence: 0,
      headDigest: '0'.repeat(64),
      healthy: true,
    },
    ownedRuntime: {
      scope: 'pi_agent_session',
      queues: {
        observedScope: 'pinned_pi_1_4_owned_runtime',
        completeness: 'complete',
        pendingMessageCount: 0,
        steering: [],
        followUp: [],
        internal: {
          pendingNextTurn: [],
          pendingCustom: [],
          pendingBash: [],
          deferredSettledActionCount: 0,
          pendingUserInputs: [],
          compactionMessages: [],
          extensionDialogCount: 0,
          activeSelector: false,
        },
      },
      work: {
        observation: 'complete',
        isIdle: true,
        isStreaming: false,
        isCompacting: false,
        isBashRunning: false,
        hasPendingBashMessages: false,
        pendingToolCalls: 0,
      },
      extensionDialogs: {
        observedScope: 'InteractiveMode_extension_confirm_select_input',
        completeness: 'complete',
        pending: [],
      },
      builtInUiApprovals: { observation: 'complete', uncoveredPaths: [] },
    },
    externalWriters: 'outside_runtime_scope',
    descendants: 'not_owned_by_sdk_runtime',
    scopedQuiescent: true,
    blockers: [],
  };
  const controller = {
    observe: () => ({
      native: {
        harness: 'pi',
        sessionId,
        agentId,
        configurationId: 'fixture-config',
        paneId: null,
        surface: 'pi-sdk-tui',
        modelObservation: {
          model: 'openrouter/test-model',
          provider: 'openrouter',
          reasoning: null,
        },
      },
      cwd,
    }),
    snapshot: () => snapshot,
    inventory: async () => ({
      scope: 'pinned_pi_1_4_owned_runtime',
      completeness: 'complete',
      inflight: [],
      pending_approvals: [],
      pending_messages: [],
      outside_scope: [],
      partial_outputs: [],
    }),
    subscribe: (listener: (event: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (type: string) => {
      for (const listener of listeners) listener({ type });
    },
  } as unknown as ManagedPiSdkSessionController & { emit(type: string): void };
  return controller;
}

function fixture(label: string) {
  const domain = makeTaskDomain(label, ['sample']);
  const taskRoot = domain.tasks.sample!;
  const assignee = { ...CLAIMANT, session_id: randomUUID(), cwd: domain.root };
  const resourcePath = path.join(domain.root, 'work');
  fs.mkdirSync(resourcePath);
  const claim = claimResources(taskRoot, {
    resources: [{ kind: 'path', path: resourcePath }],
    holder: assignee,
    subtaskId: 'role-node',
    attempt: 1,
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) throw new Error('fixture claim failed');

  const assignmentFile = path.join(domain.root, 'prepared', 'assignment.json');
  fs.mkdirSync(path.dirname(assignmentFile));
  const assignment: Assignment = {
    schema: 'harness-collab/assignment/1',
    task_id: 'sample',
    assignment_id: 'different-from-subtask-id',
    objective: 'unit fixture only',
    attempt: 1,
    roles: ['worker'],
    acceptance: ['fixture assertion'],
    coordinator: {
      agent_id: owner.agent_id,
      session_id: owner.session_id,
      owner_epoch: 1,
    },
    assignee: {
      ...assignee,
      harness: 'pi',
      surface: 'pi-sdk-tui',
      configuration_id: 'fixture-config',
    },
    inputs: [],
    resources: [
      {
        kind: 'path',
        path: resourcePath,
        access: 'write',
        resource_epoch: claim.claims[0]!.resource_epoch,
      },
    ],
    runner: { name: 'pi-cli', mode: 'native', omitted_capabilities: [] },
    required: { skills: [], tools: [] },
    preferred: { skills: [], tools: [] },
  };
  const writeAssignment = (value: Assignment) => {
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    fs.writeFileSync(assignmentFile, bytes);
    return readBoundedFile(assignmentFile, 1024 * 1024);
  };
  // This preview is intentionally allowed to be replaced before the real ASSIGN.
  const preview = { ...assignment, objective: 'advisory preview' };
  writeAssignment(preview);
  const authoritative = writeAssignment(assignment);
  assert.equal(authoritative.ok, true);
  if (!authoritative.ok) throw new Error('fixture assignment unreadable');

  const seeded = transact(taskRoot, {
    actor: 'fixture',
    purpose: 'fixture-input-revision',
    apply(record) {
      record.input_revision = INPUT_REVISION;
      return {
        record,
        op: 'fixture-input-revision',
        summary: {},
        result: null,
      };
    },
  });
  assert.equal(seeded.ok, true);

  const config = {
    taskRoot,
    assignmentFile,
    subtaskId: 'role-node',
    attempt: 1,
    ownerEpoch: 1,
    inputRevision: INPUT_REVISION,
  } as const;
  const controller = fakeController(
    assignee.session_id,
    assignee.agent_id,
    assignee.cwd!,
  );
  const admit = (approval?: { approved_by: string; reason: string }) => {
    const message = buildMessage({
      message_id: 'fixture-real-assign',
      type: 'ASSIGN',
      task_id: 'sample',
      from: { ...owner, owner_epoch: undefined } as never,
      to: assignee,
      subtask_id: config.subtaskId,
      attempt: config.attempt,
      owner_epoch: config.ownerEpoch,
      body: {
        assignment_ref: assignmentFile,
        assignment_digest: authoritative.digest,
        input_revision: INPUT_REVISION,
        ...(approval ? { approval } : {}),
      },
    });
    const result = submitMessage(taskRoot, message);
    assert.equal(result.ok, true);
  };
  const mutate = (apply: (record: TaskRecord) => void) => {
    const result = transact(taskRoot, {
      actor: 'fixture',
      purpose: 'fixture-drift',
      apply(record) {
        apply(record);
        return { record, op: 'fixture-drift', summary: {}, result: null };
      },
    });
    assert.equal(result.ok, true);
  };
  const close = () => domain.cleanup();
  return {
    taskRoot,
    assignmentFile,
    assignment,
    authoritative,
    config,
    controller,
    admit,
    mutate,
    close,
  };
}

async function bind(f: ReturnType<typeof fixture>) {
  let binds = 0;
  const watcher = await watchManagedPiInitialAdmission(
    f.controller,
    f.config,
    async (binding) => {
      assert.equal(binding.scope.subtask_id, f.config.subtaskId);
      binds += 1;
    },
  );
  return {
    watcher,
    get binds() {
      return binds;
    },
  };
}

test('preview alone is inert; a real ASSIGN plus current claims binds exactly once', async () => {
  const f = fixture('managed-initial-admission-success');
  try {
    const value = await bind(f);
    assert.equal(value.watcher.status().state, 'waiting');
    assert.equal(value.watcher.canExecute(), false);
    f.admit();
    await value.watcher.refresh();
    assert.equal(value.watcher.status().state, 'bound');
    assert.equal(value.watcher.canExecute(), true);
    const work = f.controller.snapshot().ownedRuntime.work as {
      isIdle: boolean;
      isStreaming: boolean;
    };
    work.isIdle = false;
    work.isStreaming = true;
    assert.equal(
      value.watcher.canExecute(),
      true,
      'the admitted model turn may execute its tools',
    );
    work.isIdle = true;
    work.isStreaming = false;
    f.controller.emit('resources_ready');
    await value.watcher.refresh();
    assert.equal(value.binds, 1);
    await value.watcher.close();
    assert.equal(value.watcher.canExecute(), false);
  } finally {
    f.close();
  }
});

test('an admitted approval is historical authorization and its pin must remain intact', async () => {
  const f = fixture('managed-initial-admission-approved');
  try {
    f.admit({
      approved_by: owner.agent_id,
      reason: 'The coordinator authorizes this assigned work.',
    });
    const value = await bind(f);
    assert.equal(value.watcher.canExecute(), true);
    f.mutate((record) => {
      record.attempts[0]!.approval!.reason = 'Changed authorization';
    });
    assert.equal(value.watcher.canExecute(), false);
    await value.watcher.close();
  } finally {
    f.close();
  }
});

test('an independent subtask input revision does not revoke the admitted attempt', async () => {
  const f = fixture('managed-initial-admission-independent-input');
  try {
    f.admit();
    const value = await bind(f);
    const other = submitMessage(
      f.taskRoot,
      buildMessage({
        message_id: 'assign-independent',
        type: 'ASSIGN',
        task_id: 'sample',
        from: owner,
        to: { agent_id: 'other', session_id: 'other-session', harness: 'pi' },
        subtask_id: 'other',
        attempt: 1,
        owner_epoch: 1,
        body: {
          input_revision: `sha256:${'b'.repeat(64)}`,
          assignment_digest: `sha256:${'c'.repeat(64)}`,
        },
      }),
    );
    assert.equal(other.ok, true);
    assert.equal(value.watcher.canExecute(), true);
    await value.watcher.close();
  } finally {
    f.close();
  }
});

test('authoritative artifact drift after binding denies execution', async () => {
  const f = fixture('managed-initial-admission-artifact-drift');
  try {
    f.admit();
    const value = await bind(f);
    assert.equal(value.watcher.canExecute(), true);
    fs.writeFileSync(
      f.assignmentFile,
      `${JSON.stringify({ ...f.assignment, objective: 'changed' })}\n`,
    );
    assert.equal(value.watcher.canExecute(), false);
    await value.watcher.close();
  } finally {
    f.close();
  }
});

test('late cancellation and approval block the synchronous gate', async (t) => {
  for (const [name, change] of [
    [
      'cancel',
      (record: TaskRecord) => {
        record.attempts[0]!.cancel_requested_at = new Date().toISOString();
      },
    ],
    [
      'approval',
      (record: TaskRecord) => {
        record.attempts[0]!.awaiting = 'approval';
      },
    ],
  ] as const) {
    await t.test(name, async () => {
      const f = fixture(`managed-initial-admission-${name}`);
      try {
        f.admit();
        const value = await bind(f);
        assert.equal(value.watcher.canExecute(), true);
        f.mutate(change);
        assert.equal(value.watcher.canExecute(), false);
        await value.watcher.close();
      } finally {
        f.close();
      }
    });
  }
});

test('epoch and namespace drift fail closed', async (t) => {
  for (const [name, change] of [
    [
      'epoch',
      (record: TaskRecord) => {
        record.coordinator!.owner_epoch = 2;
      },
    ],
    [
      'namespace',
      (record: TaskRecord) => {
        record.domain_root = path.join(
          path.dirname(fixtureRoot(record)),
          'redirect',
        );
      },
    ],
  ] as const) {
    await t.test(name, async () => {
      const f = fixture(`managed-initial-admission-${name}`);
      try {
        f.admit();
        const value = await bind(f);
        assert.equal(value.watcher.canExecute(), true);
        f.mutate(change);
        assert.equal(value.watcher.canExecute(), false);
        await value.watcher.close();
      } finally {
        f.close();
      }
    });
  }
});

function fixtureRoot(record: { task_root: string }) {
  return path.dirname(path.dirname(path.dirname(record.task_root)));
}

test('claim epoch drift, release, and superseding attempt deny execution', async (t) => {
  const changes = [
    [
      'claim-epoch',
      (record: TaskRecord) => {
        record.claims[0]!.resource_epoch += 1;
      },
    ],
    [
      'claim-release',
      (record: TaskRecord) => {
        record.claims[0]!.released_at = new Date().toISOString();
      },
    ],
    [
      'superseded',
      (record: TaskRecord) => {
        record.attempts.push({ ...record.attempts[0]!, attempt: 2 });
      },
    ],
  ] as const;
  for (const [name, change] of changes) {
    await t.test(name, async () => {
      const f = fixture(`managed-initial-admission-${name}`);
      try {
        f.admit();
        const value = await bind(f);
        assert.equal(value.watcher.canExecute(), true);
        f.mutate(change);
        assert.equal(value.watcher.canExecute(), false);
        await value.watcher.close();
      } finally {
        f.close();
      }
    });
  }
});
