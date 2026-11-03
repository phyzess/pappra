import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { buildMessage } from '../../src/collab/envelope.js';
import { bindNative } from '../../src/collab/lifecycle.js';
import {
  NATIVE_OBSERVATION_FUTURE_TOLERANCE_MS,
  NATIVE_OBSERVATION_MAX_AGE_MINUTES,
  evaluateNativeObservationAge,
  nativeObservationAgeSummary,
} from '../../src/collab/native-observation.js';
import { initTask, readRecord, transact } from '../../src/collab/store.js';
import { WORK_PLAN_SCHEMA } from '../../src/collab/work-plan.js';
import type { Identity } from '../../src/collab/types.js';
import {
  applyAccept,
  applyDispatch,
  applyParticipant,
  applyPrepare,
  inspectWorkflow,
  type WorkflowParticipantRequest,
  type WorkflowPrepareRequest,
} from '../../src/app/collab-workflow.js';
import { deriveCapabilityCard } from '../../src/app/capability-evidence/index.js';
import type { WorkExecutionAdapter } from '../../src/app/collab-work-execution.js';
import { claimResources, releaseClaim } from '../../src/collab/resources.js';
import {
  COLLAB_ROLLOVER_REQUEST_SCHEMA,
  inspectOrPlanRollover,
} from '../../src/app/collab-rollover.js';
import * as rollover from '../../src/collab/rollover.js';
import { submitMessage } from '../../src/collab/messages.js';
import type { Message, MessageInput } from '../../src/collab/types.js';
import { workflowIntentsDir } from '../../src/schemas/collab-workflow.js';
import {
  handoffBundleRelativeRef,
  saveHandoffBundle,
} from '../../src/continuity/index.js';
import {
  continuityTaskPaths,
  writeContinuityBytes,
} from '../../src/continuity/paths.js';
import { makeCapabilitiesFixture } from './capabilities-fixtures.js';
import { makeTaskDomain, OTHER } from './task-resources-fixtures.js';
import { owner } from './scenarios.js';
import {
  baseWorkspaceConfig,
  cleanup,
  makeTempDir,
  workspaceId as WORKSPACE_ID,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';
import {
  executeRecovery,
  type RecoveryController,
  type RecoveryExecutionRequest,
} from '../../src/app/collab-recovery-executor.js';
import {
  notifyRegisteredMessage,
  type HerdrAgentObservation,
  type HerdrCallerResult,
  type HerdrListResult,
  type HerdrPromptResult,
  type HerdrTransport,
} from '../../src/app/collab-notify.js';
import { readDeliveryRecord } from '../../src/app/collab-messages.js';

/**
 * #35 — the shared native-observation age bound.
 *
 * The decision consumers (recovery `continue`, rollover claim transfer) must not authorize
 * on a stale observation, the dispatch retry gate must keep refusing one (no code change),
 * and the history consumers must report the classification without refusing. Each
 * classification — `fresh`, `expired`, `missing`, `invalid`, `future` — is exercised with a
 * real outcome quoted in the assertion.
 */

const MINUTE = 60_000;
const COORDINATOR = {
  agent_id: owner.agent_id,
  session_id: owner.session_id,
  harness: 'pi' as const,
  owner_epoch: owner.owner_epoch,
  since: owner.since,
};
const WRITER: Identity = {
  agent_id: 'writer-a',
  session_id: 'writer-a-session',
  harness: 'pi',
};
const WRITER_PARTICIPANT = {
  agent_id: WRITER.agent_id,
  session_id: WRITER.session_id,
  harness: 'pi' as const,
  cwd: '',
  surface: 'cli',
  configuration_id: 'fixture',
};

/** The five-way classification, evaluated against an explicit clock. */
test('the shared evaluation classifies fresh, expired, missing, invalid and future', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  const at = (offsetMs: number): string =>
    new Date(now + offsetMs).toISOString();
  const evaluate = (
    observed_at: unknown,
    overrides: Record<string, unknown> = {},
  ) =>
    evaluateNativeObservationAge(
      {
        runner: 'pi',
        session_id: WRITER.session_id,
        run_id: null,
        mission_id: null,
        observation: 'confirmed',
        observed_at,
        evidence_ref: 'herdr:agent:w9:p28:settled',
        ...overrides,
      },
      { now },
    );

  const fresh = evaluate(at(-MINUTE));
  assert.equal(fresh.classification, 'fresh');
  assert.equal(fresh.fresh, true);
  assert.equal(fresh.asserted, true);
  assert.equal(fresh.age_ms, MINUTE);
  assert.equal(fresh.max_age_ms, NATIVE_OBSERVATION_MAX_AGE_MINUTES * MINUTE);

  const expired = evaluate(
    at(-(NATIVE_OBSERVATION_MAX_AGE_MINUTES + 1) * MINUTE),
  );
  assert.equal(expired.classification, 'expired');
  assert.equal(expired.fresh, false);
  assert.match(expired.detail, /native observation bound is 1800000ms/);

  const missing = evaluate(null);
  assert.equal(missing.classification, 'missing');
  assert.equal(missing.fresh, false);
  assert.equal(missing.age_ms, null);

  const invalid = evaluate('not-a-timestamp');
  assert.equal(invalid.classification, 'invalid');
  assert.equal(invalid.fresh, false);
  assert.equal(invalid.observed_at, 'not-a-timestamp');

  const future = evaluate(
    new Date(
      now + NATIVE_OBSERVATION_FUTURE_TOLERANCE_MS + MINUTE,
    ).toISOString(),
  );
  assert.equal(future.classification, 'future');
  assert.equal(future.fresh, false);
  assert.ok((future.age_ms ?? 0) < 0);

  // A timestamp inside the clock-skew tolerance is still current, matching the card bound.
  assert.equal(
    evaluate(new Date(now + 30_000).toISOString()).classification,
    'fresh',
  );

  // `unknown` is the floor: an unobserved placeholder is not "assume unchanged", and the
  // reader-facing summary never claims freshness for it.
  const untouched = evaluateNativeObservationAge(
    {
      runner: null,
      session_id: null,
      run_id: null,
      mission_id: null,
      observation: 'unknown',
      observed_at: null,
      evidence_ref: null,
    },
    { now },
  );
  assert.equal(untouched.classification, 'missing');
  assert.equal(untouched.asserted, false);
  assert.equal(untouched.recorded_observation, 'unknown');
  assert.deepEqual(nativeObservationAgeSummary({}, { now }), {
    classification: 'missing',
    observed_at: null,
    age_ms: null,
    max_age_ms: NATIVE_OBSERVATION_MAX_AGE_MINUTES * MINUTE,
  });
});

const noNativeNotify = (async () => ({
  ok: false as const,
  code: 'fixture_no_native',
  message: 'Explicit fixture; no native notification',
  retryable: false,
  nextAction: null,
})) as unknown as typeof notifyRegisteredMessage;

interface WriterCohort {
  readonly domainRoot: string;
  readonly taskRoot: string;
  readonly output: string;
  readonly inputRevision: string;
  setObservedAt(value: string | null): void;
  report(): Promise<Awaited<ReturnType<typeof applyParticipant>>>;
  inspect(): Promise<Awaited<ReturnType<typeof inspectWorkflow>>>;
  cleanup(): void;
}

/** One sealed `writer` assignment, so the participant and recovery consumers have a subject. */
async function writerCohort(label: string): Promise<WriterCohort> {
  const domain = makeTaskDomain(`native-age-${label}`, ['cohort']);
  const taskRoot = domain.tasks['cohort']!;
  const output = join(domain.root, 'out.txt');
  writeFileSync(output, 'fixture output\n');
  const briefFile = join(domain.root, 'brief.json');
  const briefBytes = `${JSON.stringify({ brief: 'native observation age' })}\n`;
  writeFileSync(briefFile, briefBytes);
  const inputRevision = `sha256:${createHash('sha256')
    .update(briefBytes)
    .digest('hex')}`;
  const prepare: WorkflowPrepareRequest = {
    schema: 'pappra/collab-workflow-prepare-request/1',
    domain_root: domain.domainRoot,
    task_id: 'cohort',
    goal: {
      objective: 'Pin the native observation age bound for #35',
      input_ref: briefFile,
      input_digest: inputRevision,
    },
    coordinator: {
      ...COORDINATOR,
      cwd: domain.root,
      surface: 'cli',
      configuration_id: 'fixture',
    },
    participants: [
      { ...WRITER_PARTICIPANT, cwd: domain.root },
      {
        ...COORDINATOR,
        cwd: domain.root,
        surface: 'cli',
        configuration_id: 'fixture',
      },
    ],
    bindings: [],
    runner: { name: 'fixture', mode: 'fixture' },
    assignments: [
      {
        subtask_id: 'work',
        role: 'writer',
        assignee: WRITER.agent_id,
        objective: 'Produce one declared output.',
        acceptance: ['The output file exists.'],
        resources: [{ path: output, access: 'write', scope: 'file' }],
        required_skills: [],
        required_tools: [],
        native_evidence: [],
      },
    ],
  };
  const prepared = await applyPrepare(prepare);
  assert.equal(prepared.ok, true, JSON.stringify(prepared));

  const bound = transact(taskRoot, {
    actor: 'fixture',
    purpose: 'bind-native-observation',
    apply: (record) => {
      const outcome = bindNative(record, {
        subtaskId: 'work',
        attempt: 1,
        runner: 'pi',
        sessionId: WRITER.session_id,
        observation: 'confirmed',
        evidenceRef: 'herdr:agent:w9:p28:settled',
        observedAt: new Date(Date.now() - MINUTE).toISOString(),
      });
      if (!outcome.ok) return outcome as never;
      return {
        record,
        op: 'bind-native-observation',
        summary: {},
        result: outcome,
      };
    },
  });
  assert.equal(bound.ok, true, JSON.stringify(bound));

  const participant = {
    schema: 'pappra/collab-workflow-participant-request/1',
    task_root: taskRoot,
    caller: { ...WRITER_PARTICIPANT, cwd: domain.root },
    subtask_id: 'work',
    attempt: 1,
    caller_pane: null,
  } as const;
  const request = (action: 'report'): WorkflowParticipantRequest =>
    ({
      ...participant,
      action,
      report: {
        status: 'completed',
        summary: 'Fixture output produced',
        blockers: [],
        outputs: [output],
      },
      release: null,
    }) as WorkflowParticipantRequest;

  return {
    domainRoot: domain.root,
    taskRoot,
    output,
    inputRevision,
    setObservedAt(value: string | null): void {
      const written = transact(taskRoot, {
        actor: 'fixture',
        purpose: 'set-native-observed-at',
        apply: (record) => {
          record.attempts.find(
            (attempt) => attempt.subtask_id === 'work' && attempt.attempt === 1,
          )!.native.observed_at = value;
          return { record };
        },
      });
      assert.equal(written.ok, true, JSON.stringify(written));
    },
    report: () =>
      applyParticipant(request('report'), { notify: noNativeNotify }),
    inspect: () => inspectWorkflow(taskRoot),
    cleanup: domain.cleanup,
  };
}

test('recovery continue refuses every non-fresh observation and takes no claim effect', async () => {
  const now = Date.now();
  for (const item of [
    {
      name: 'fresh',
      observedAt: new Date(now - MINUTE).toISOString(),
      classification: 'fresh',
    },
    {
      name: 'expired',
      observedAt: new Date(
        now - (NATIVE_OBSERVATION_MAX_AGE_MINUTES + 1) * MINUTE,
      ).toISOString(),
      classification: 'expired',
    },
    { name: 'missing', observedAt: null, classification: 'missing' },
    {
      name: 'invalid',
      observedAt: 'not-a-timestamp',
      classification: 'invalid',
    },
    {
      name: 'future',
      observedAt: new Date(
        now + NATIVE_OBSERVATION_FUTURE_TOLERANCE_MS + MINUTE,
      ).toISOString(),
      classification: 'future',
    },
  ] as const) {
    const cohort = await writerCohort(`recovery-${item.name}`);
    try {
      cohort.setObservedAt(item.observedAt);
      const planFile = join(cohort.domainRoot, 'plan.json');
      writeFileSync(
        planFile,
        `${JSON.stringify({
          schema: WORK_PLAN_SCHEMA,
          plan_id: 'plan-native-age',
          task_id: 'cohort',
          owner_epoch: 1,
          nodes: [
            {
              node_id: 'work',
              role: 'writer',
              assignment_id: 'work',
              attempt: 1,
              input_revision: cohort.inputRevision,
              assignee: {
                agent_id: WRITER.agent_id,
                session_id: WRITER.session_id,
              },
              depends_on: [],
              resources: [],
            },
          ],
        })}\n`,
      );
      const bindingContent = `${JSON.stringify(
        {
          schema: 'pappra/collab-binding/1',
          task_id: 'cohort',
          task_root: cohort.taskRoot,
          channel: 'herdr',
          participants: [
            {
              agent_id: WRITER.agent_id,
              harness: 'pi',
              cwd: '/work',
              herdr_agent: 'writer-a',
              pane_id: 'w9:p28',
              native_session_id: WRITER.session_id,
            },
            {
              agent_id: COORDINATOR.agent_id,
              harness: 'pi',
              cwd: '/work',
              herdr_agent: 'coordinator',
              pane_id: 'w9:p1',
              native_session_id: COORDINATOR.session_id,
            },
          ],
        },
        null,
        2,
      )}\n`;
      const bindingFile = join(cohort.taskRoot, 'recovery-binding.json');
      writeFileSync(bindingFile, bindingContent);
      const before = readRecord(cohort.taskRoot)!;
      const claimsBefore = JSON.stringify(before.claims ?? []);
      let performed = 0;
      const controller: RecoveryController = {
        id: 'fixture-native-age',
        perform: async () => {
          performed += 1;
          return {
            disposition: 'submitted',
            detail: null,
            observation: 'queued',
          };
        },
      };
      const request: RecoveryExecutionRequest = {
        taskRoot: cohort.taskRoot,
        planFile,
        self: WRITER,
        policy: { role: 'writer' },
        requestId: `req-native-age-${item.name}`,
        expectedSession: {
          session_id: WRITER.session_id,
          cwd: '/work',
          binding_digest: `sha256:${createHash('sha256')
            .update(bindingContent)
            .digest('hex')}`,
          binding_ref: bindingFile,
          target_agent: 'writer-a',
          pane_id: 'w9:p28',
          harness: 'pi',
        },
        mode: 'apply',
      };
      const result = await executeRecovery(request, { controller });
      if (item.classification === 'fresh') {
        assert.equal(result.status, 'applied', JSON.stringify(result));
        assert.equal(performed, 1);
      } else {
        assert.equal(result.status, 'refused', JSON.stringify(result));
        assert.equal(performed, 0, 'a refusal takes no controller effect');
        assert.equal(
          result.reservation,
          null,
          'a refusal writes no reservation',
        );
        assert.ok(
          result.notes.some((note) =>
            note.includes(`native observation is ${item.classification}`),
          ),
          JSON.stringify(result.notes),
        );
        assert.equal(
          JSON.stringify(readRecord(cohort.taskRoot)!.claims ?? []),
          claimsBefore,
          'a refusal changes no claim record',
        );
      }
    } finally {
      cohort.cleanup();
    }
  }
});

function herdrObservation(
  overrides: Partial<HerdrAgentObservation> = {},
): HerdrAgentObservation {
  return {
    name: 'pappra-implement',
    harness: 'codex',
    paneId: 'w9:p2',
    cwd: '/tmp/task-root',
    sessionValue: null,
    sessionKind: null,
    status: 'idle',
    focused: false,
    ...overrides,
  };
}

/** Minimal transport seam: it records what notify asked it to do and nothing else. */
class FakeTransport implements HerdrTransport {
  readonly id = 'fake-herdr';
  readonly prompts: { readonly agent: string; readonly text: string }[] = [];
  constructor(
    private readonly agents: readonly HerdrAgentObservation[],
    private readonly callerPane: string,
    private readonly cwd: string,
  ) {}

  async verifyCaller(): Promise<HerdrCallerResult> {
    return {
      ok: true,
      caller: {
        paneId: this.callerPane,
        workspaceId: 'w9',
        tabId: 'w9:t1',
        harness: 'pi',
        cwd: this.cwd,
        sessionKind: null,
        sessionValue: null,
        source: 'current',
      },
    };
  }

  async list(): Promise<HerdrListResult> {
    return { ok: true, agents: this.agents };
  }

  async prompt(agent: string, text: string): Promise<HerdrPromptResult> {
    this.prompts.push({ agent, text });
    return { status: 'submitted', detail: null, effect: 'possible' };
  }
}

test('notify is untouched: a live match still delivers and dates the caller from the clock', async () => {
  const root = makeTempDir('native-age-notify');
  const clock = Date.parse('2026-11-03T04:00:00Z');
  try {
    const taskRoot = join(root, 'domain', 'tasks', 'sample');
    initTask(taskRoot, {
      taskId: 'sample',
      coordinator: COORDINATOR,
      domainRoot: join(root, 'domain'),
      clock,
    });
    const message = buildMessage(
      {
        type: 'STATUS_QUERY',
        message_id: 'msg-native-age-1',
        task_id: 'sample',
        from: COORDINATOR,
        to: WRITER,
        reply_to: null,
        subtask_id: null,
        attempt: null,
        owner_epoch: null,
        body: { status: 'running' },
      },
      { clock },
    );
    writeFileSync(
      join(taskRoot, 'messages', 'msg-native-age-1.json'),
      `${JSON.stringify(message, null, 2)}\n`,
    );
    const bindingFile = join(taskRoot, 'binding.json');
    writeFileSync(
      bindingFile,
      `${JSON.stringify(
        {
          schema: 'pappra/collab-binding/1',
          task_id: 'sample',
          task_root: taskRoot,
          channel: 'herdr',
          participants: [
            {
              agent_id: COORDINATOR.agent_id,
              harness: 'pi',
              cwd: root,
              herdr_agent: 'pappra-coordinator',
              pane_id: 'w9:p1',
              native_session_id: COORDINATOR.session_id,
            },
            {
              agent_id: WRITER.agent_id,
              harness: 'pi',
              cwd: root,
              herdr_agent: 'pappra-implement',
              pane_id: 'w9:p2',
              native_session_id: WRITER.session_id,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const transport = new FakeTransport(
      [
        herdrObservation({
          name: 'pappra-coordinator',
          harness: 'pi',
          paneId: 'w9:p1',
          cwd: root,
        }),
        herdrObservation({ cwd: root, harness: 'pi' }),
      ],
      'w9:p1',
      root,
    );
    const notified = await notifyRegisteredMessage({
      taskRoot,
      messageId: 'msg-native-age-1',
      bindingFile,
      apply: true,
      retry: false,
      transport,
      clock,
    });
    assert.equal(notified.ok, true, JSON.stringify(notified));
    if (!notified.ok) return;
    assert.equal(notified.value.status, 'submitted');
    assert.equal(transport.prompts.length, 1);
    // No age rule was added to the live path: the delivered caller evidence is the clock.
    const delivery = readDeliveryRecord(taskRoot, 'msg-native-age-1') as {
      caller?: { observed_at?: string | null } | null;
    } | null;
    assert.equal(delivery?.caller?.observed_at, new Date(clock).toISOString());
  } finally {
    cleanup(root);
  }
});

test('history consumers report the age classification without refusing', async () => {
  const cohort = await writerCohort('history');
  try {
    // An expired observation is reported as recorded, plus its classification.
    cohort.setObservedAt(
      new Date(
        Date.now() - (NATIVE_OBSERVATION_MAX_AGE_MINUTES + 5) * MINUTE,
      ).toISOString(),
    );
    const reported = await cohort.report();
    assert.equal(reported.ok, true, JSON.stringify(reported));
    const reportId = reported.messages[0]!.message_id;
    const body = JSON.parse(
      readFileSync(
        join(cohort.taskRoot, 'messages', `${reportId}.json`),
        'utf8',
      ),
    ).body as {
      native_ref: { observation: string; observed_at: string | null } | null;
      native_age: { classification: string; observed_at: string | null };
    };
    assert.equal(body.native_ref?.observation, 'confirmed');
    assert.equal(body.native_age.classification, 'expired');
    assert.equal(body.native_age.observed_at, body.native_ref?.observed_at);

    const inspected = await cohort.inspect();
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    const attempts = (
      inspected.detail as {
        attempts: {
          native_observation: string;
          native_age: { classification: string };
        }[];
      }
    ).attempts;
    assert.equal(attempts[0]?.native_observation, 'confirmed');
    assert.equal(attempts[0]?.native_age.classification, 'expired');
  } finally {
    cohort.cleanup();
  }
});

test('an observed_at null record still loads for the history consumers', () => {
  return writerCohort('history-missing').then(async (cohort) => {
    try {
      cohort.setObservedAt(null);
      const inspected = await cohort.inspect();
      assert.equal(inspected.ok, true, JSON.stringify(inspected));
      const attempts = (
        inspected.detail as {
          attempts: {
            native_observation: string;
            native_age: { classification: string; observed_at: null };
          }[];
        }
      ).attempts;
      assert.equal(attempts[0]?.native_observation, 'confirmed');
      assert.equal(attempts[0]?.native_age.classification, 'missing');
      assert.equal(attempts[0]?.native_age.observed_at, null);
    } finally {
      cohort.cleanup();
    }
  });
});

const DISPATCH_WRITER = {
  agent_id: 'author',
  session_id: 'author-session',
  harness: 'pi' as const,
  surface: 'cli',
  configuration_id: 'fixture',
};

interface DispatchCohort {
  readonly taskRoot: string;
  readonly request: Parameters<typeof applyDispatch>[0];
  readonly adapter: Parameters<typeof applyDispatch>[1] extends
    { adapter?: infer A } | undefined
    ? A
    : never;
  readonly calls: string[];
  readonly releaseHolder: () => void;
  readonly reviewAttempt: () => Record<string, unknown>;
  readonly mutateReview: (
    mutate: (
      attempt: NonNullable<ReturnType<typeof readRecord>>['attempts'][number],
    ) => void,
  ) => void;
  readonly cleanup: () => void;
}

/** A sealed writer+reviewer cohort whose review claim is deferred by a foreign holder. */
async function dispatchCohort(): Promise<DispatchCohort> {
  const domain = makeTaskDomain('native-age-dispatch', ['cohort', 'holder'], {
    initialize: ['holder'],
  });
  const capability = makeCapabilitiesFixture('native-age-dispatch-card', {
    harness: 'pi',
  });
  const template = capability.template as Record<string, unknown>;
  const reviewer = {
    agent_id: String(template.agent_id),
    session_id: String(template.session_id),
    harness: 'pi' as const,
    surface: String(template.surface),
    configuration_id: String(template.configuration_id),
    cwd: String(template.cwd),
  };
  const taskRoot = domain.tasks['cohort']!;
  const first = join(domain.root, 'a.txt');
  const second = join(domain.root, 'b.txt');
  writeFileSync(first, 'author output\n');
  writeFileSync(second, 'second review input\n');
  const prepare: WorkflowPrepareRequest = {
    schema: 'pappra/collab-workflow-prepare-request/1',
    domain_root: domain.domainRoot,
    task_id: 'cohort',
    goal: {
      objective: 'Pin the dispatch retry gate for #35',
      input_ref: null,
      input_digest: null,
    },
    coordinator: {
      ...COORDINATOR,
      cwd: domain.root,
      surface: 'cli',
      configuration_id: 'fixture',
    },
    participants: [{ ...DISPATCH_WRITER, cwd: domain.root }, reviewer],
    bindings: [],
    runner: { name: 'fixture', mode: 'fixture' },
    assignments: [
      {
        subtask_id: 'author',
        role: 'writer',
        assignee: DISPATCH_WRITER.agent_id,
        objective: 'Produce one declared output.',
        acceptance: ['Fixture completion'],
        resources: [{ path: first, access: 'write', scope: 'file' }],
        required_skills: [],
        required_tools: [],
        native_evidence: [],
      },
      {
        subtask_id: 'review',
        role: 'reviewer',
        assignee: reviewer.agent_id,
        objective: 'Read the declared inputs.',
        acceptance: ['Fixture completion'],
        resources: [
          { path: first, access: 'read', scope: 'file' },
          { path: second, access: 'read', scope: 'file' },
        ],
        required_skills: [],
        required_tools: [],
        native_evidence: [],
      },
    ],
  };
  const prepared = await applyPrepare(prepare);
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const derived = deriveCapabilityCard({
    harness: 'pi',
    assignmentFile: capability.assignmentFile,
    templateFile: capability.templateFile,
    sessionFile: capability.sessionFile,
    live: true,
  });
  assert.equal(derived.ok, true, JSON.stringify(derived));
  assert.ok(derived.card);
  const cardFile = join(capability.root, 'runtime-card.json');
  writeFileSync(cardFile, JSON.stringify(derived.card));

  const participant: WorkflowParticipantRequest = {
    schema: 'pappra/collab-workflow-participant-request/1',
    action: 'ack',
    task_root: taskRoot,
    caller: { ...DISPATCH_WRITER, cwd: domain.root },
    subtask_id: 'author',
    attempt: 1,
    caller_pane: null,
    report: null,
    release: null,
  };
  const ack = await applyParticipant(participant, { notify: noNativeNotify });
  assert.equal(ack.ok, true, JSON.stringify(ack));
  const reported = await applyParticipant(
    {
      ...participant,
      action: 'report',
      report: {
        status: 'completed',
        summary: 'Fixture author finished',
        blockers: [],
        outputs: [first],
      },
    },
    { notify: noNativeNotify },
  );
  assert.equal(reported.ok, true, JSON.stringify(reported));
  const accepted = await applyAccept(
    {
      schema: 'pappra/collab-workflow-accept-request/1',
      task_root: taskRoot,
      caller: { ...COORDINATOR, cwd: domain.root },
      subtask_id: 'author',
      attempt: 1,
      report_message_id: reported.messages[0]!.message_id,
      caller_pane: null,
      reason: 'Accept fixture author',
    },
    { notify: noNativeNotify },
  );
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const released = await applyParticipant(
    {
      ...participant,
      action: 'release',
      release: {
        reason: 'Accepted author hands back scope',
        cancel_attempt: false,
        correlates_to: accepted.messages[0]!.message_id,
      },
    },
    { notify: noNativeNotify },
  );
  assert.equal(released.ok, true, JSON.stringify(released));

  const held = claimResources(domain.tasks['holder']!, {
    resources: [{ path: second, scope: 'file' }],
    holder: OTHER,
    access: 'write',
    includeSharedGit: false,
  });
  assert.equal(held.ok, true, JSON.stringify(held));

  const request: Parameters<typeof applyDispatch>[0] = {
    schema: 'pappra/collab-workflow-dispatch-request/1',
    task_root: taskRoot,
    caller: { ...COORDINATOR, cwd: domain.root },
    caller_pane: 'w9:p1',
    capability_targets: [
      {
        subtask_id: 'review',
        attempt: 1,
        capabilities_file: cardFile,
        template_file: null,
        session_file: null,
        events_file: null,
        execution_file: null,
      },
    ],
    subtasks: ['review'],
    activate_deferred: true,
    max_age_minutes: 30,
  };
  const calls: string[] = [];
  const adapter: WorkExecutionAdapter = {
    preflight: async () => ({
      ok: true,
      status: 'planned',
      detail: 'Explicit no-model adapter',
    }),
    dispatch: async () => {
      calls.push('dispatch');
      return { ok: true, status: 'submitted', detail: 'fixture only' };
    },
  };
  const reviewAttempt = () => {
    const attempt = readRecord(taskRoot)!.attempts.find(
      (item) => item.subtask_id === 'review',
    );
    assert.ok(attempt, 'the reviewer attempt must exist');
    return attempt as unknown as Record<string, unknown>;
  };
  return {
    taskRoot,
    request,
    adapter,
    calls,
    releaseHolder() {
      for (const claim of readRecord(domain.tasks['holder']!)!.claims.filter(
        (entry) => entry.released_at === null,
      ))
        assert.equal(
          releaseClaim(domain.tasks['holder']!, {
            claimId: claim.claim_id,
            holder: OTHER,
            reason: 'Fixture foreign writer stopped',
          }).ok,
          true,
        );
    },
    reviewAttempt,
    mutateReview(mutate) {
      const written = transact(taskRoot, {
        actor: 'fixture',
        purpose: 'mutate-review-native',
        apply: (record) => {
          mutate(record.attempts.find((item) => item.subtask_id === 'review')!);
          return { record };
        },
      });
      assert.equal(written.ok, true, JSON.stringify(written));
    },
    cleanup() {
      domain.cleanup();
      cleanup(capability.root);
    },
  };
}

test('the dispatch retry gate still refuses a recorded native observation, expired or not', async () => {
  for (const variant of ['expired', 'fresh'] as const) {
    const cohort = await dispatchCohort();
    try {
      // The first dispatch conflicts on the reviewer's read claim and writes no intent.
      const conflicted = await applyDispatch(cohort.request, {
        adapter: cohort.adapter,
      });
      assert.equal(conflicted.ok, false, JSON.stringify(conflicted));
      assert.equal(
        existsSync(
          join(workflowIntentsDir(cohort.taskRoot), 'dispatch-review-1.json'),
        ),
        false,
      );
      assert.equal(cohort.calls.length, 0);
      cohort.releaseHolder();
      // Only the observation's age differs; dispatch.ts itself is unchanged.
      cohort.mutateReview((attempt) => {
        attempt.native = {
          runner: 'pi',
          session_id: String(
            (attempt.assignee as { session_id?: unknown }).session_id,
          ),
          run_id: 'run-review',
          mission_id: null,
          observation: 'confirmed',
          observed_at: new Date(
            Date.now() -
              (variant === 'expired'
                ? (NATIVE_OBSERVATION_MAX_AGE_MINUTES + 1) * MINUTE
                : MINUTE),
          ).toISOString(),
          evidence_ref: 'herdr:agent:w9:p7:settled',
        };
      });
      assert.equal(
        evaluateNativeObservationAge(cohort.reviewAttempt().native as object)
          .classification,
        variant,
      );
      const retried = await applyDispatch(cohort.request, {
        adapter: cohort.adapter,
      });
      assert.equal(retried.ok, false, JSON.stringify(retried));
      assert.equal(
        evaluateNativeObservationAge(cohort.reviewAttempt().native as object)
          .classification,
        variant,
        'recency never lifts the guard',
      );
      assert.equal(
        readRecord(cohort.taskRoot)!.claims.filter(
          (claim) =>
            claim.subtask_id === 'review' && claim.released_at === null,
        ).length,
        0,
      );
      assert.equal(cohort.calls.length, 0);
      assert.equal(
        existsSync(
          join(workflowIntentsDir(cohort.taskRoot), 'dispatch-review-1.json'),
        ),
        false,
      );
    } finally {
      cohort.cleanup();
    }
  }
});

const ROLLOVER_TASK = 'sample';
const ROLLOVER_SUBTASK = 'work';
const ROLLOVER_INPUT = `sha256:${'1'.repeat(64)}`;
const CONTINUITY_TASK = 'wsx-native-age';
const ROLLOVER_INTENT = 'intent-native-age';
const ROLLOVER_HANDOFF = 'handoff-native-age';
const SOURCE: Identity = {
  agent_id: 'writer-a',
  session_id: 'session-a',
  harness: 'pi',
};
const NEXT: Identity = {
  agent_id: 'writer-b',
  session_id: 'session-b',
  harness: 'pi',
};

interface RolloverCohort {
  readonly taskRoot: string;
  readonly bundle: {
    readonly root: string;
    readonly continuity_task_id: string;
    readonly bundle_id: string;
    readonly digest: string;
  };
  readonly claimRecords: () => string;
  readonly cleanup: () => void;
}

function checkpointBytes(checkpointId: string): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      {
        schema: 'pappra/checkpoint/1',
        checkpointId,
        taskId: CONTINUITY_TASK,
        workspaceId: WORKSPACE_ID,
        revision: 1,
        previousDigest: null,
        createdAt: new Date().toISOString(),
        authorSession: SOURCE.session_id,
        objective: 'Native observation age fixture',
        acceptance: [],
        constraints: [],
        decisions: [],
        attempted: [],
        nextActions: [],
        limitations: [],
        repositories: [],
        artifacts: [],
        validations: [],
        nativeRefs: [],
        collaborationRecordRef: null,
        contextCompleteness: 'complete',
      },
      null,
      2,
    )}\n`,
  );
}

/** A pre-transfer rollover intent whose source native observation is dated by the caller. */
async function rolloverCohort(
  label: string,
  observedAt: string | null,
): Promise<RolloverCohort> {
  const domain = makeTaskDomain(`native-age-rollover-${label}`, [
    ROLLOVER_TASK,
  ]);
  const task = domain.tasks[ROLLOVER_TASK]!;
  const send = (input: MessageInput): Message => {
    const message = buildMessage(input);
    const outcome = submitMessage(task, message);
    assert.equal(
      outcome.ok,
      true,
      `submit ${input.type}: ${JSON.stringify(outcome)}`,
    );
    return message;
  };
  const claimed = claimResources(task, {
    resources: [{ kind: 'path', path: join(domain.root, 'work-a') }],
    holder: SOURCE,
    subtaskId: ROLLOVER_SUBTASK,
    attempt: 1,
  });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  send({
    message_id: 'msg-assign-work',
    type: 'ASSIGN',
    task_id: ROLLOVER_TASK,
    from: COORDINATOR,
    to: SOURCE,
    subtask_id: ROLLOVER_SUBTASK,
    attempt: 1,
    owner_epoch: 1,
    body: {
      assignment_digest: `sha256:${'a'.repeat(64)}`,
      input_revision: ROLLOVER_INPUT,
    },
  });
  const bound = transact(task, {
    actor: 'fixture',
    purpose: 'bind-source-native',
    apply: (record) => {
      const outcome = bindNative(record, {
        subtaskId: ROLLOVER_SUBTASK,
        attempt: 1,
        runner: 'pi',
        sessionId: SOURCE.session_id,
        runId: 'run-source',
        observation: 'confirmed',
        evidenceRef: 'herdr:agent:w9:p3:settled',
        observedAt: new Date().toISOString(),
      });
      if (!outcome.ok) return outcome as never;
      return { record, op: 'bind-source-native', summary: {}, result: outcome };
    },
  });
  assert.equal(bound.ok, true, JSON.stringify(bound));
  // `bindNative` always stamps a time, so the classification fixtures set the value directly.
  const stamped = transact(task, {
    actor: 'fixture',
    purpose: 'set-source-native-observed-at',
    apply: (record) => {
      record.attempts.find(
        (attempt) =>
          attempt.subtask_id === ROLLOVER_SUBTASK && attempt.attempt === 1,
      )!.native.observed_at = observedAt;
      return { record };
    },
  });
  assert.equal(stamped.ok, true, JSON.stringify(stamped));
  writeWorkspaceConfig(domain.root, baseWorkspaceConfig());
  const paths = continuityTaskPaths(domain.root, CONTINUITY_TASK);
  const checkpointId = randomUUID();
  const name = `${checkpointId}.json`;
  const written = await writeContinuityBytes(
    domain.root,
    CONTINUITY_TASK,
    join(paths.checkpointsDir, name),
    checkpointBytes(checkpointId),
    true,
    {},
  );
  assert.ok(written.ok, 'checkpoint fixture must publish');
  const saved = await saveHandoffBundle({
    root: domain.root,
    continuityTaskId: CONTINUITY_TASK,
    checkpoint: {
      checkpointId,
      taskId: CONTINUITY_TASK,
      workspaceId: WORKSPACE_ID,
      ref: `checkpoints/${name}`,
      digest: written.value.digest,
      authorSession: SOURCE.session_id,
      contextCompleteness: 'complete',
    },
    collaboration: {
      taskId: ROLLOVER_TASK,
      attempt: 1,
      ownerEpoch: 1,
      subtaskId: ROLLOVER_SUBTASK,
      inputRevision: ROLLOVER_INPUT,
      association: `continuity ${CONTINUITY_TASK} backs collaboration ${ROLLOVER_TASK}`,
    },
    sourceNativeSession: {
      harness: 'pi',
      sessionId: SOURCE.session_id,
      agentId: SOURCE.agent_id,
      paneId: 'w9:p3',
      surface: 'cli',
      configurationId: 'fixture',
      modelObservation: { model: null, provider: null, reasoning: null },
    },
    handoff: {
      claims: (claimed.ok ? claimed.claims : []).map((claim) => ({
        claimId: claim.claim_id,
        resource: claim.path ?? claim.key,
        resourceEpoch: claim.resource_epoch,
        holder: claim.holder.agent_id,
      })),
      claimsCompleteness: 'complete',
      pendingTools: { items: [], completeness: 'complete' },
      pendingMessages: { items: [], completeness: 'complete' },
      pendingApprovals: { items: [], completeness: 'complete' },
      nextAction: 'Inspect only',
      recovery: [],
      executionAuthority: 'none',
      advisory: true,
    },
  });
  assert.ok(saved.ok, `bundle fixture must publish: ${JSON.stringify(saved)}`);
  const claimIds = claimed.ok
    ? claimed.claims.map((claim) => ({
        claim_id: claim.claim_id,
        resource_epoch: claim.resource_epoch ?? 0,
      }))
    : [];
  const intent = transact(task, {
    actor: 'fixture',
    purpose: 'create-rollover-intent',
    apply: (record) => {
      const created = rollover.createRolloverIntent(record, {
        intent_id: ROLLOVER_INTENT,
        generation: 1,
        handoff_id: ROLLOVER_HANDOFF,
        subtask_id: ROLLOVER_SUBTASK,
        attempt: 1,
        input_revision: ROLLOVER_INPUT,
        from: SOURCE,
        to: NEXT,
        claims: claimIds,
        bundle: {
          ref: handoffBundleRelativeRef(saved.value.bundleId),
          digest: saved.value.digest,
        },
        coordinator_epoch: 1,
      });
      if (!created.ok) return created as never;
      return {
        record,
        op: 'create-rollover-intent',
        summary: {},
        result: created,
      };
    },
  });
  assert.equal(intent.ok, true, JSON.stringify(intent));
  return {
    taskRoot: task,
    bundle: {
      root: domain.root,
      continuity_task_id: CONTINUITY_TASK,
      bundle_id: saved.value.bundleId,
      digest: saved.value.digest,
    },
    claimRecords: () =>
      JSON.stringify(
        (readRecord(task)!.claims ?? []).map((claim) => ({
          claim_id: claim.claim_id,
          holder: claim.holder,
          resource_epoch: claim.resource_epoch,
          released_at: claim.released_at,
        })),
      ),
    cleanup: domain.cleanup,
  };
}

test('rollover refuses an expired confirmed observation and keeps the claim records', async () => {
  const now = Date.now();
  for (const item of [
    {
      name: 'fresh',
      observedAt: new Date(now - MINUTE).toISOString(),
      stale: false,
    },
    {
      name: 'expired',
      observedAt: new Date(
        now - (NATIVE_OBSERVATION_MAX_AGE_MINUTES + 1) * MINUTE,
      ).toISOString(),
      stale: true,
    },
    { name: 'missing', observedAt: null, stale: true },
    { name: 'invalid', observedAt: 'not-a-timestamp', stale: true },
    {
      name: 'future',
      observedAt: new Date(
        now + NATIVE_OBSERVATION_FUTURE_TOLERANCE_MS + MINUTE,
      ).toISOString(),
      stale: true,
    },
  ] as const) {
    const cohort = await rolloverCohort(item.name, item.observedAt);
    try {
      const claimsBefore = cohort.claimRecords();
      const result = await inspectOrPlanRollover({
        schema: COLLAB_ROLLOVER_REQUEST_SCHEMA,
        action: 'plan',
        task_root: cohort.taskRoot,
        intent_id: ROLLOVER_INTENT,
        proposed_intent: null,
        bundle: cohort.bundle,
        evidence: { ack_message_id: null, report_message_id: null },
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      if (!result.ok) return;
      const report = result.value;
      const staleDrift = report.drift.find(
        (entry) => entry.code === 'native_observation_stale',
      );
      const recordedObservation = report.attempt?.native?.observation;
      if (item.stale) {
        // `missing` still reads `confirmed` as recorded; the age verdict is what refuses.
        assert.equal(recordedObservation, 'confirmed', item.name);
        assert.ok(staleDrift, `${item.name}: ${JSON.stringify(report.drift)}`);
        assert.match(
          staleDrift.detail,
          /cannot count as confirmed for a transfer/,
        );
        assert.equal(report.plan_complete, false, item.name);
        assert.equal(
          cohort.claimRecords(),
          claimsBefore,
          `${item.name}: the transfer refusal changes no claim record`,
        );
      } else {
        assert.equal(staleDrift, undefined, JSON.stringify(report.drift));
      }
    } finally {
      cohort.cleanup();
    }
  }
});

test('the rollover age check judges the record against the caller clock', async () => {
  // A fixed instant, far from any wall clock on purpose: the assertions below only use
  // injected clocks, so this test cannot start failing when real time moves.
  const observedAt = '2026-10-20T00:02:00.000Z';
  const takenAt = Date.parse(observedAt);
  const lateClock =
    takenAt + (NATIVE_OBSERVATION_MAX_AGE_MINUTES + 15) * MINUTE;
  const cohort = await rolloverCohort('caller-clock', observedAt);
  try {
    const request = {
      schema: COLLAB_ROLLOVER_REQUEST_SCHEMA,
      action: 'plan' as const,
      task_root: cohort.taskRoot,
      intent_id: ROLLOVER_INTENT,
      proposed_intent: null,
      bundle: cohort.bundle,
      evidence: { ack_message_id: null, report_message_id: null },
    };
    const staleDrift = (
      result: Awaited<ReturnType<typeof inspectOrPlanRollover>>,
    ) => {
      assert.equal(result.ok, true, JSON.stringify(result));
      if (!result.ok) return [];
      return result.value.drift.filter(
        (entry) => entry.code === 'native_observation_stale',
      );
    };

    // The same record: expired against a late clock, current against its own clock.
    const againstLateClock = staleDrift(
      await inspectOrPlanRollover(request, { now: () => lateClock }),
    );
    assert.equal(againstLateClock.length, 1);
    assert.match(
      againstLateClock[0]!.detail,
      /The recorded source native observation is expired/,
    );
    const againstOwnClock = staleDrift(
      await inspectOrPlanRollover(request, { now: () => takenAt }),
    );
    assert.equal(againstOwnClock.length, 0);
  } finally {
    cohort.cleanup();
  }
});
