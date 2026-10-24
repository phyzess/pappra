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
  releaseManagedPiResume,
  type ManagedPiResumeRuntimeRegistration,
} from '../../src/app/managed-pi-resume-admission.js';
import type { ManagedPiRequest } from '../../src/app/managed-pi.js';
import { runManagedPiSdkRuntime } from '../../src/app/managed-pi-sdk-runtime.js';
import { ManagedPiJournal } from '../../src/hosts/pi/managed-session.js';
import { managedPiHostIdentity } from '../../src/hosts/pi/managed-host-identity.js';
import { captureProcessIdentity } from '../../src/infra/process-identity.js';
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
    priorBoot?: boolean;
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
    ...(options.priorBoot
      ? {
          process_identity: {
            ...captureProcessIdentity()!,
            pid: source.pid,
            boot: sha('prior-boot'),
          },
        }
      : {}),
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

test('verified dead source is reserved once and only an atomic exact registry takeover enables execution', async (t) => {
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
    // A different process can acquire the source PID after the atomic takeover.
    const kill = process.kill;
    t.mock.method(
      process,
      'kill',
      (pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === f.source.pid) return true;
        return kill(pid, signal);
      },
    );
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
    releaseManagedPiResume(auth);
    assert.deepEqual(readRecord(f.task)!.managed_pi_resume_admissions, []);
  } finally {
    f.cleanup();
  }
});

test('failed or cancelled startup releases its reservation and permits a fresh retry', async () => {
  const f = fixture();
  try {
    const auth = await prepareManagedPiResume(f.request);
    releaseManagedPiResume(auth);
    releaseManagedPiResume(auth);
    assert.deepEqual(readRecord(f.task)!.managed_pi_resume_admissions, []);
    assert.throws(
      () =>
        assertManagedPiSdkResumeAuthorization(auth, {
          sessionId: auth.sessionId,
          cwd: auth.cwd,
        }),
      /authorization_invalid/,
    );
    const retry = await prepareManagedPiResume(f.request);
    releaseManagedPiResume(retry);
    await assert.rejects(runManagedPiSdkRuntime(f.request));
    assert.deepEqual(readRecord(f.task)!.managed_pi_resume_admissions, []);
    releaseManagedPiResume(await prepareManagedPiResume(f.request));
  } finally {
    f.cleanup();
  }
});

test('dead reservation owners are reclaimed before the capacity and duplicate checks', async () => {
  const f = fixture();
  try {
    f.change((record) => {
      record.managed_pi_resume_admissions = Array.from(
        { length: 64 },
        (_, index) => ({
          schema: 'pappra/managed-pi-resume-admission/1',
          reservation_id: `abandoned-${index}`,
          source_run_id: f.source.controller_run_id,
          pid: f.source.pid,
          status: index % 2 === 0 ? 'reserved' : 'registered',
        }),
      );
    });
    const auth = await prepareManagedPiResume(f.request);
    assert.equal(
      (readRecord(f.task)!.managed_pi_resume_admissions as unknown[]).length,
      1,
    );
    releaseManagedPiResume(auth);
  } finally {
    f.cleanup();
  }
});

test('a live reservation owner is preserved and blocks duplicate admission', async () => {
  const f = fixture();
  try {
    const auth = await prepareManagedPiResume(f.request);
    await assert.rejects(prepareManagedPiResume(f.request), /already_reserved/);
    assert.equal(
      (readRecord(f.task)!.managed_pi_resume_admissions as unknown[]).length,
      1,
    );
    releaseManagedPiResume(auth);
  } finally {
    f.cleanup();
  }
});

test('same-machine previous-boot checkpoint and reservations can resume without trusting reused PIDs', async () => {
  const f = fixture({ priorBoot: true, foreignHost: true });
  try {
    const self = captureProcessIdentity();
    assert(self);
    f.change((record) => {
      record.managed_pi_resume_admissions = [
        {
          reservation_id: 'prior-boot-reservation',
          source_run_id: f.source.controller_run_id,
          pid: process.pid,
          host_identity: sha('prior-host-boot'),
          process_identity: { ...self, boot: sha('prior-boot') },
          status: 'reserved',
        },
      ];
    });
    const authorization = await prepareManagedPiResume(f.request);
    assert.equal(
      (readRecord(f.task)!.managed_pi_resume_admissions as unknown[]).length,
      1,
    );
    assert.equal(releaseManagedPiResume(authorization), true);
  } finally {
    f.cleanup();
  }
});

test('release failure is reported without throwing over the original runtime error', async () => {
  const f = fixture();
  try {
    const authorization = await prepareManagedPiResume(f.request);
    f.change((record) => {
      record.managed_pi_resume_admissions = 'malformed';
    });
    assert.equal(releaseManagedPiResume(authorization), false);
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
