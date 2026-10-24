import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  prepareManagedPiResume,
  assertManagedPiSdkResumeAuthorization,
  canExecuteManagedPiResume,
  consumeManagedPiResumeRegistration,
  type ManagedPiResumeRuntimeRegistration,
} from '../../src/app/managed-pi-resume-admission.js';
import type { ManagedPiRequest } from '../../src/app/managed-pi.js';
import { ManagedPiJournal } from '../../src/hosts/pi/managed-session.js';
import { managedPiHostIdentity } from '../../src/hosts/pi/managed-host-identity.js';
import { buildMessage } from '../../src/collab/envelope.js';
import { submitMessage } from '../../src/collab/messages.js';
import { claimResources } from '../../src/collab/resources.js';
import { readRecord, transact } from '../../src/collab/store.js';
import { bindNative } from '../../src/collab/lifecycle.js';
import type { Assignment } from '../../src/collab/contracts.js';
import type { TaskRecord } from '../../src/collab/types.js';
import { makeTaskDomain } from '../collab/task-resources-fixtures.js';
import { owner } from '../collab/scenarios.js';

const sha = (text: string) =>
  `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;

function fixture(
  options: {
    alive?: boolean;
    invalidated?: boolean;
    pending?: boolean;
    error?: boolean;
    foreignHost?: boolean;
  } = {},
) {
  const domain = makeTaskDomain('managed-resume', ['sample']);
  fs.chmodSync(domain.root, 0o700);
  const task = domain.tasks.sample!;
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
    timeout: 5000,
  });
  assert.equal(child.status, 0);
  const pid = options.alive ? process.pid : child.pid;
  assert.ok(pid);
  const sessionId = crypto.randomUUID();
  const assignee = {
    agent_id: 'resume-writer',
    session_id: sessionId,
    harness: 'pi',
    cwd: domain.root,
    surface: 'pi-sdk-tui',
    configuration_id: 'resume-test',
  };
  const resource = path.join(domain.root, 'output.txt');
  fs.writeFileSync(resource, '');
  const claimed = claimResources(task, {
    holder: assignee,
    resources: [{ kind: 'path', path: resource }],
    subtaskId: 'work',
    attempt: 1,
  });
  assert.ok(claimed.ok);
  if (!claimed.ok) throw new Error('fixture claim denied');
  const assignment: Assignment = {
    schema: 'harness-collab/assignment/1',
    task_id: 'sample',
    assignment_id: 'work',
    attempt: 1,
    objective: 'Resume admission fixture',
    roles: ['writer'],
    acceptance: ['Unit assertion'],
    coordinator: {
      agent_id: owner.agent_id,
      session_id: owner.session_id,
      owner_epoch: 1,
    },
    assignee,
    inputs: [],
    resources: [
      {
        kind: 'path',
        path: resource,
        access: 'write',
        resource_epoch: claimed.claims[0]!.resource_epoch,
      },
    ],
    runner: { name: 'pi-cli', mode: 'native', omitted_capabilities: [] },
    required: { skills: [], tools: [] },
    preferred: { skills: [], tools: [] },
  };
  const assignmentFile = path.join(domain.root, 'assignment.json');
  const assignmentText = `${JSON.stringify(assignment)}\n`;
  fs.writeFileSync(assignmentFile, assignmentText);
  const input = `sha256:${'a'.repeat(64)}`;
  assert.ok(
    submitMessage(
      task,
      buildMessage({
        message_id: 'assign-resume',
        type: 'ASSIGN',
        task_id: 'sample',
        from: owner,
        to: assignee,
        subtask_id: 'work',
        attempt: 1,
        owner_epoch: 1,
        body: {
          assignment_ref: assignmentFile,
          assignment_digest: sha(assignmentText),
          input_revision: input,
        },
      }),
    ).ok,
  );
  const scope = {
    schema: 'pappra/managed-pi-execution-scope/1' as const,
    task_id: 'sample',
    task_root: task,
    session_id: sessionId,
    cwd: domain.root,
    subtask_id: 'work',
    attempt: 1,
    owner_epoch: 1,
    claim_epochs: claimed.claims.map((c) => ({
      claim_id: c.claim_id,
      resource_epoch: c.resource_epoch,
    })),
  };
  const sourceJournal = path.join(domain.root, 'source.jsonl');
  const sessionFile = path.join(domain.root, 'native.jsonl');
  const text = `${JSON.stringify({ type: 'session', id: sessionId, cwd: domain.root })}\n${JSON.stringify({ type: 'message', message: { role: 'assistant', stopReason: options.error ? 'error' : 'stop', content: [{ type: 'text', text: 'READY' }] } })}\n`;
  fs.writeFileSync(sessionFile, text, { mode: 0o644 });
  const descriptorFile = `${sourceJournal}.control.json`;
  const sourceRunId = crypto.randomUUID();
  fs.writeFileSync(
    descriptorFile,
    JSON.stringify({
      schema: 'harness-collab/pi-managed-control/1',
      sessionId,
      runId: sourceRunId,
    }),
    { mode: 0o600 },
  );
  const source: ManagedPiResumeRuntimeRegistration = {
    schema: 'pappra/managed-pi-runtime/1',
    agent_id: assignee.agent_id,
    session_id: sessionId,
    pid,
    descriptor_file: descriptorFile,
    controller_run_id: sourceRunId,
    input_revision: input,
    scope,
    pane_id: null,
  };
  const saved = transact(task, {
    actor: 'fixture',
    purpose: 'source-registration',
    apply(record) {
      const binding = bindNative(record, {
        subtaskId: 'work',
        attempt: 1,
        runner: 'pi',
        sessionId,
        runId: sourceRunId,
        observation: 'confirmed',
        evidenceRef: sourceJournal,
      });
      assert.ok(binding.ok);
      record.managed_pi_runtime_registry = [source];
      return { record, op: 'fixture-source', summary: {}, result: null };
    },
  });
  assert.ok(saved.ok);
  const journal = new ManagedPiJournal(
    sourceJournal,
    fs.openSync(sourceJournal, 'wx', 0o600),
    crypto.randomUUID(),
  );
  const snapshot = {
    process: { pid },
    session: { sessionId, sessionFile },
    ingress: { healthy: true, state: 'open', journalPath: sourceJournal },
    ownedRuntime: {
      queues: {
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
        completeness: 'complete',
        pending: options.pending ? [{}] : [],
      },
      builtInUiApprovals: { observation: 'complete' },
    },
  };
  journal.append('sdk_resume_checkpoint', {
    checkpoint_schema: 'pappra/managed-pi-resume-checkpoint/1',
    session_id: sessionId,
    session_file: sessionFile,
    cwd: domain.root,
    model: 'openai/gpt-6-luna',
    process_pid: pid,
    host_identity: options.foreignHost
      ? `sha256:${'0'.repeat(64)}`
      : managedPiHostIdentity(),
    execution_scope: scope,
    transcript_digest: sha(text),
    snapshot,
    registered_inputs: [
      { request_id: 'prior-message', input_digest: 'b'.repeat(64) },
    ],
  });
  if (options.invalidated)
    journal.append('sdk_resume_checkpoint_invalidated', {
      reason: 'provider_run',
    });
  journal.close();
  const request: ManagedPiRequest = {
    schema: 'pappra/managed-pi-session-request/1',
    runtime: 'sdk',
    cwd: domain.root,
    model: 'openai/gpt-6-luna',
    sdkModulePath: '/private/pinned-sdk.js',
    journalPath: path.join(domain.root, 'resumed.jsonl'),
    sessionId,
    executionScope: scope,
    resume: {
      sourceJournalPath: sourceJournal,
      sourceSessionFile: sessionFile,
      sourceRunId,
    },
  };
  const change = (mutate: (record: TaskRecord) => void) => {
    const result = transact(task, {
      actor: 'fixture',
      purpose: 'change',
      apply(record) {
        mutate(record);
        return { record, op: 'fixture-change', summary: {}, result: null };
      },
    });
    assert.ok(result.ok);
  };
  return {
    ...domain,
    task,
    source,
    request,
    change,
    sourceJournal,
    sessionFile,
    assignmentFile,
  };
}

test('verified dead source is reserved once and only an atomic exact registry takeover enables execution', async () => {
  const f = fixture();
  try {
    const auth = await prepareManagedPiResume(f.request);
    assert.equal(auth.sessionId, f.source.session_id);
    assert.deepEqual(auth.registeredInputs, [
      { requestId: 'prior-message', inputDigest: 'b'.repeat(64) },
    ]);
    assertManagedPiSdkResumeAuthorization(auth, {
      sessionId: auth.sessionId,
      cwd: auth.cwd,
    });
    assert.throws(
      () =>
        assertManagedPiSdkResumeAuthorization(
          { ...auth },
          { sessionId: auth.sessionId, cwd: auth.cwd },
        ),
      /authorization_invalid/,
    );
    assert.equal(
      canExecuteManagedPiResume(auth, {
        sessionId: auth.sessionId,
        cwd: auth.cwd,
      }),
      false,
    );
    await assert.rejects(prepareManagedPiResume(f.request), /already_reserved/);
    f.change((record) => {
      const next = {
        ...f.source,
        pid: process.pid,
        controller_run_id: 'new-controller-run',
        descriptor_file: `${f.request.journalPath}.control.json`,
      };
      consumeManagedPiResumeRegistration(record, auth, f.source, next);
      record.managed_pi_runtime_registry = [next];
    });
    assert.equal(
      canExecuteManagedPiResume(auth, {
        sessionId: auth.sessionId,
        cwd: auth.cwd,
      }),
      true,
    );
    assert.equal(
      canExecuteManagedPiResume(auth, {
        sessionId: crypto.randomUUID(),
        cwd: auth.cwd,
      }),
      false,
    );
    assert.throws(
      () =>
        assertManagedPiSdkResumeAuthorization(auth, {
          sessionId: auth.sessionId,
          cwd: auth.cwd,
        }),
      /authorization_invalid/,
    );
    f.change((record) => {
      record.claims[0]!.released_at = new Date().toISOString();
    });
    assert.equal(
      canExecuteManagedPiResume(auth, {
        sessionId: auth.sessionId,
        cwd: auth.cwd,
      }),
      false,
    );
  } finally {
    f.cleanup();
  }
});

for (const [label, options, pattern] of [
  ['living source', { alive: true }, /source_pid_invalid|source_still_alive/],
  ['invalidated checkpoint', { invalidated: true }, /checkpoint_invalidated/],
  ['pending approval', { pending: true }, /checkpoint_not_idle/],
  ['unknown native effect', { error: true }, /native_outcome_unresolved/],
  [
    'another OS boot or PID namespace',
    { foreignHost: true },
    /source_host_mismatch/,
  ],
] as const) {
  test(`resume refuses ${label}`, async () => {
    const f = fixture(options);
    try {
      await assert.rejects(prepareManagedPiResume(f.request), pattern);
    } finally {
      f.cleanup();
    }
  });
}

test('resume rejects tampered source bytes and authority drift after its reservation', async () => {
  const f = fixture();
  try {
    const auth = await prepareManagedPiResume(f.request);
    fs.appendFileSync(f.sourceJournal, '{}\n');
    assert.throws(
      () =>
        assertManagedPiSdkResumeAuthorization(auth, {
          sessionId: auth.sessionId,
          cwd: auth.cwd,
        }),
      /source_file_changed/,
    );
  } finally {
    f.cleanup();
  }
  const second = fixture();
  try {
    const auth = await prepareManagedPiResume(second.request);
    second.change((record) => {
      record.coordinator!.owner_epoch++;
    });
    assert.throws(
      () =>
        assertManagedPiSdkResumeAuthorization(auth, {
          sessionId: auth.sessionId,
          cwd: auth.cwd,
        }),
      /task_authority_stale/,
    );
    assert.equal(
      canExecuteManagedPiResume(auth, {
        sessionId: auth.sessionId,
        cwd: auth.cwd,
      }),
      false,
    );
  } finally {
    second.cleanup();
  }
});

test('an old journal without a checkpoint and an altered native transcript cannot resume', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.sourceJournal, '');
    await assert.rejects(
      prepareManagedPiResume(f.request),
      /source_journal_partial/,
    );
  } finally {
    f.cleanup();
  }
  const second = fixture();
  try {
    fs.appendFileSync(second.sessionFile, '{}\n');
    await assert.rejects(
      prepareManagedPiResume(second.request),
      /transcript_changed/,
    );
    assert.equal(
      readRecord(second.task)!.managed_pi_resume_admissions,
      undefined,
    );
  } finally {
    second.cleanup();
  }
});
