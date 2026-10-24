import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';
import { buildMessage } from '../../src/collab/envelope.js';
import { bindNative } from '../../src/collab/lifecycle.js';
import { submitMessage } from '../../src/collab/messages.js';
import { claimResources } from '../../src/collab/resources.js';
import * as rollover from '../../src/collab/rollover.js';
import { readRecord, transact } from '../../src/collab/store.js';
import type {
  Claim,
  Identity,
  Message,
  MessageInput,
  TaskRecord,
} from '../../src/collab/types.js';
import {
  COLLAB_ROLLOVER_REPORT_SCHEMA,
  COLLAB_ROLLOVER_REQUEST_SCHEMA,
  inspectOrPlanRollover,
  loadRolloverRequest,
  type RolloverReport,
  type RolloverRequest,
} from '../../src/app/collab-rollover.js';
import {
  COLLAB_ROLLOVER_REPORT_SCHEMA as PUBLIC_REPORT_SCHEMA,
  inspectOrPlanRollover as publicInspectOrPlanRollover,
} from '../../src/app/collaboration.js';
import { routeExclusionFor } from '../../src/app/collab-route.js';
import {
  notifyRegisteredMessage,
  type HerdrTransport,
} from '../../src/app/collab-notify.js';
import {
  deliveryPathFor,
  readDeliveryRecord,
} from '../../src/app/collab-messages.js';
import {
  handoffBundleRelativeRef,
  saveHandoffBundle,
  type HandoffBundle,
} from '../../src/continuity/index.js';
import {
  continuityTaskPaths,
  writeContinuityBytes,
} from '../../src/continuity/paths.js';
import {
  baseWorkspaceConfig,
  workspaceId as WORKSPACE_ID,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';
import {
  makeTaskDomain,
  snapshotTree,
  type TaskDomainFixture,
} from './task-resources-fixtures.js';

/**
 * The repository root is located from the working directory so this file also runs when it
 * is compiled into an isolated layout.
 */
function repoRoot(): string {
  let current = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    if (
      existsSync(join(current, 'tsconfig.test.json')) &&
      existsSync(join(current, 'package.json'))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    'Could not locate the repository root for the isolated CLI build.',
  );
}
const ROOT = repoRoot();
const TASK = 'sample';
const SUBTASK = 'work';
const INPUT = `sha256:${'1'.repeat(64)}`;
const OTHER_INPUT = `sha256:${'2'.repeat(64)}`;
const CONTINUITY_TASK = 'wsx-rollover';
const INTENT = 'intent-1';
const HANDOFF = 'handoff-1';
const COORD: Identity = {
  agent_id: 'coordinator',
  session_id: 'coord-session',
  harness: 'pi',
};
const OLD: Identity = {
  agent_id: 'writer-a',
  session_id: 'session-a',
  harness: 'pi',
};
const NEXT: Identity = {
  agent_id: 'writer-b',
  session_id: 'session-b',
  harness: 'pi',
};
const WATCH: Identity = {
  agent_id: 'watcher',
  session_id: 'watch-session',
  harness: 'codex',
};

const COMPLETE_INVENTORY = {
  completeness: 'complete' as const,
  inflight: [],
  pending_approvals: [],
  pending_messages: [],
};

let isolated: { readonly dir: string; readonly cli: string } | null = null;
function isolatedCli(): { readonly dir: string; readonly cli: string } {
  if (isolated !== null) return isolated;
  const dir = mkdtempSync(join(tmpdir(), 'pappra-rollover-cli-'));
  const pkg = join(dir, 'pkg');
  const build = spawnSync(
    process.execPath,
    [
      join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p',
      join(ROOT, 'tsconfig.test.json'),
      '--outDir',
      pkg,
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 600_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  assert.equal(build.status, 0, build.stderr);
  copyFileSync(join(ROOT, 'package.json'), join(pkg, 'package.json'));
  symlinkSync(join(ROOT, 'node_modules'), join(pkg, 'node_modules'), 'dir');
  isolated = { dir, cli: join(pkg, 'src', 'cli', 'main.js') };
  return isolated;
}
after(() => {
  if (isolated !== null) rmSync(isolated.dir, { recursive: true, force: true });
});

function runCli(
  args: readonly string[],
  cwd: string,
): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const cli = isolatedCli();
  const result = spawnSync(process.execPath, [cli.cli, ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

interface BundleReference {
  readonly root: string;
  readonly continuity_task_id: string;
  readonly bundle_id: string;
  readonly digest: string;
}

interface Fixture {
  readonly domain: TaskDomainFixture;
  readonly task: string;
  readonly claims: readonly string[];
  readonly bundle: BundleReference;
  readonly messages: Message[];
  nextId(prefix: string): string;
  send(input: MessageInput): Message;
  load(): TaskRecord;
  write(name: string, value: unknown): string;
  cleanup(): void;
}

function buildCheckpointBytes(
  checkpointId: string,
  authorSession: string,
): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      {
        schema: 'pappra/checkpoint/1',
        checkpointId,
        taskId: CONTINUITY_TASK,
        workspaceId: WORKSPACE_ID,
        revision: 1,
        previousDigest: null,
        createdAt: '2026-10-22T00:00:00.000Z',
        authorSession,
        objective: 'Rollover inspection fixture',
        acceptance: [],
        constraints: ['No authority transfer'],
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
    'utf8',
  );
}

async function publishBundle(
  root: string,
  collaboration: Record<string, unknown>,
  claims: readonly Claim[],
  handoffOverrides: Record<string, unknown> = {},
): Promise<BundleReference> {
  writeWorkspaceConfig(root, baseWorkspaceConfig());
  const paths = continuityTaskPaths(root, CONTINUITY_TASK);
  const checkpointId = randomUUID();
  const name = `${checkpointId}.json`;
  const abs = join(paths.checkpointsDir, name);
  const bytes = buildCheckpointBytes(checkpointId, OLD.session_id);
  const write = await writeContinuityBytes(
    root,
    CONTINUITY_TASK,
    abs,
    bytes,
    true,
    {},
  );
  assert.ok(write.ok, 'checkpoint fixture must publish');
  const saved = await saveHandoffBundle({
    root,
    continuityTaskId: CONTINUITY_TASK,
    checkpoint: {
      checkpointId,
      taskId: CONTINUITY_TASK,
      workspaceId: WORKSPACE_ID,
      ref: `checkpoints/${name}`,
      digest: write.value.digest,
      authorSession: OLD.session_id,
      contextCompleteness: 'complete',
    },
    collaboration: {
      taskId: TASK,
      attempt: 1,
      ownerEpoch: 1,
      subtaskId: SUBTASK,
      inputRevision: INPUT,
      association: `continuity ${CONTINUITY_TASK} backs collaboration ${TASK}`,
      ...collaboration,
    },
    sourceNativeSession: {
      harness: 'pi',
      sessionId: OLD.session_id,
      agentId: OLD.agent_id,
      paneId: 'w3:p3',
      surface: 'cli',
      configurationId: 'daily-herdr',
      modelObservation: { model: null, provider: null, reasoning: null },
    },
    handoff: {
      claims: claims.map((claim) => ({
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
      ...handoffOverrides,
    },
  });
  assert.ok(saved.ok, `bundle fixture must publish: ${JSON.stringify(saved)}`);
  return {
    root,
    continuity_task_id: CONTINUITY_TASK,
    bundle_id: saved.value.bundleId,
    digest: saved.value.digest,
  };
}

async function makeFixture(
  label: string,
  collaboration: Record<string, unknown> = {},
  handoffOverrides: Record<string, unknown> = {},
): Promise<Fixture> {
  const domain = makeTaskDomain(`rollover-app-${label}`, [TASK]);
  const task = domain.tasks[TASK]!;
  let clock = Date.parse('2026-10-22T00:00:00Z');
  const messages: Message[] = [];
  let counter = 0;
  const tick = (): number => (clock += 1000);
  const send = (input: MessageInput): Message => {
    const message = buildMessage(input, { clock: tick() });
    const outcome = submitMessage(task, message, { clock: tick() });
    assert.equal(
      outcome.ok,
      true,
      `submit ${input.type}: ${JSON.stringify(outcome)}`,
    );
    messages.push(message);
    return message;
  };
  const claimed = claimResources(task, {
    resources: [{ kind: 'path', path: join(domain.root, 'work-a') }],
    holder: OLD,
    subtaskId: SUBTASK,
    attempt: 1,
  });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  const claims = claimed.ok
    ? claimed.claims.map((claim) => claim.claim_id)
    : [];
  send({
    message_id: 'msg-assign-work',
    type: 'ASSIGN',
    task_id: TASK,
    from: COORD,
    to: OLD,
    subtask_id: SUBTASK,
    attempt: 1,
    owner_epoch: 1,
    body: {
      assignment_digest: `sha256:${'a'.repeat(64)}`,
      input_revision: INPUT,
    },
  });
  const bound = transact(task, {
    actor: 'fixture',
    purpose: 'bind-source-native',
    apply: (record) => {
      const outcome = bindNative(record, {
        subtaskId: SUBTASK,
        attempt: 1,
        runner: 'pi',
        sessionId: OLD.session_id,
        runId: 'run-source',
        missionId: null,
        observation: 'confirmed',
        evidenceRef: 'herdr:agent:w3:p3:settled',
        observedAt: '2026-10-22T00:30:00Z',
      });
      if (!outcome.ok) return outcome as never;
      return { record, op: 'bind-source-native', summary: {}, result: outcome };
    },
  });
  assert.equal(bound.ok, true, JSON.stringify(bound));
  const bundle = await publishBundle(
    domain.root,
    collaboration,
    claimed.ok ? claimed.claims : [],
    handoffOverrides,
  );
  return {
    domain,
    task,
    claims,
    bundle,
    messages,
    nextId: (prefix) => `${prefix}-${(counter += 1)}`,
    send,
    load: () => {
      const record = readRecord(task);
      assert.ok(record, 'task record must exist');
      return record;
    },
    write: (name, value) => {
      const file = join(domain.root, name);
      writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
      return file;
    },
    cleanup: domain.cleanup,
  };
}

function claimEpochs(record: TaskRecord): Map<string, number> {
  return new Map(
    (record.claims ?? []).map((claim) => [
      claim.claim_id,
      claim.resource_epoch ?? 0,
    ]),
  );
}

function intentInput(fixture: Fixture) {
  const epochs = claimEpochs(fixture.load());
  return {
    intent_id: INTENT,
    generation: 1,
    handoff_id: HANDOFF,
    subtask_id: SUBTASK,
    attempt: 1,
    input_revision: INPUT,
    from: OLD,
    to: NEXT,
    claims: fixture.claims.map((claimId) => ({
      claim_id: claimId,
      resource_epoch: epochs.get(claimId) ?? 0,
    })),
    bundle: {
      ref: handoffBundleRelativeRef(fixture.bundle.bundle_id),
      digest: fixture.bundle.digest,
    },
    coordinator_epoch: 1,
    clock: Date.parse('2026-10-22T01:00:00Z'),
  };
}

function recordIntent(fixture: Fixture): void {
  const outcome = transact(fixture.task, {
    actor: 'fixture',
    purpose: 'create-rollover-intent',
    apply: (record) => {
      const created = rollover.createRolloverIntent(
        record,
        intentInput(fixture),
      );
      if (!created.ok) return created as never;
      return {
        record,
        op: 'create-rollover-intent',
        summary: {},
        result: created,
      };
    },
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
}

/** Drives the accepted record reducer through succession on real, registered messages. */
function recordSuccession(fixture: Fixture): void {
  recordIntent(fixture);
  const prepared = transact(fixture.task, {
    actor: 'fixture',
    purpose: 'prepare-rollover',
    apply: (record) => {
      const outcome = rollover.prepareRolloverTransfer(record, {
        intent_id: INTENT,
        observation: 'confirmed',
        evidence_ref: 'herdr:agent:w3:p3:settled',
        inventory: COMPLETE_INVENTORY,
        clock: Date.parse('2026-10-22T01:00:01Z'),
      });
      if (!outcome.ok) return outcome as never;
      return { record, op: 'prepare-rollover', summary: {}, result: outcome };
    },
  });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const ack = fixture.send({
    message_id: 'msg-ack-successor',
    type: 'ACK',
    task_id: TASK,
    from: NEXT,
    to: COORD,
    reply_to: 'msg-assign-work',
    subtask_id: SUBTASK,
    attempt: 1,
    owner_epoch: 1,
    body: {
      handoff_id: HANDOFF,
      rollover_intent_id: INTENT,
      rollover_generation: 1,
      input_revision: INPUT,
    },
  });
  const confirmed = transact(fixture.task, {
    actor: 'fixture',
    purpose: 'confirm-rollover',
    apply: (record) => {
      const outcome = rollover.confirmRolloverReceiver(record, {
        intent_id: INTENT,
        message: ack,
        clock: Date.parse('2026-10-22T01:00:02Z'),
      });
      if (!outcome.ok) return outcome as never;
      return { record, op: 'confirm-rollover', summary: {}, result: outcome };
    },
  });
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
  const completed = transact(fixture.task, {
    actor: 'fixture',
    purpose: 'complete-rollover',
    apply: (record) => {
      const outcome = rollover.completeRolloverTransfer(record, {
        intent_id: INTENT,
        successor_native: {
          agent_id: NEXT.agent_id,
          runner: 'pi',
          session_id: NEXT.session_id,
          run_id: 'run-successor',
          mission_id: null,
          evidence_ref: 'herdr:agent:w4:p2',
          observed_at: '2026-10-22T01:00:05Z',
        },
        clock: Date.parse('2026-10-22T01:00:05Z'),
      });
      if (!outcome.ok) return outcome as never;
      return { record, op: 'complete-rollover', summary: {}, result: outcome };
    },
  });
  assert.equal(completed.ok, true, JSON.stringify(completed));
  const report = fixture.send({
    message_id: 'msg-report-first-work',
    type: 'REPORT',
    task_id: TASK,
    from: NEXT,
    to: COORD,
    subtask_id: SUBTASK,
    attempt: 1,
    body: {
      status: 'completed',
      input_revision: INPUT,
      handoff_id: HANDOFF,
      rollover_generation: 1,
    },
  });
  const firstWork = transact(fixture.task, {
    actor: 'fixture',
    purpose: 'record-first-work',
    apply: (record) => {
      const outcome = rollover.recordRolloverFirstWork(record, {
        intent_id: INTENT,
        message: report,
        clock: Date.parse('2026-10-22T01:00:06Z'),
      });
      if (!outcome.ok) return outcome as never;
      return { record, op: 'record-first-work', summary: {}, result: outcome };
    },
  });
  assert.equal(firstWork.ok, true, JSON.stringify(firstWork));
}

function proposedIntent(fixture: Fixture): Record<string, unknown> {
  const epochs = claimEpochs(fixture.load());
  return {
    intent_id: INTENT,
    generation: 1,
    handoff_id: HANDOFF,
    subtask_id: SUBTASK,
    attempt: 1,
    input_revision: INPUT,
    from: OLD,
    to: NEXT,
    claims: fixture.claims.map((claimId) => ({
      claim_id: claimId,
      resource_epoch: epochs.get(claimId) ?? 0,
    })),
    coordinator_epoch: 1,
  };
}

function requestFor(
  fixture: Fixture,
  overrides: Partial<RolloverRequest> & {
    readonly bundleOverrides?: Record<string, unknown>;
  } = {},
): RolloverRequest {
  const { bundleOverrides, ...rest } = overrides;
  return {
    schema: COLLAB_ROLLOVER_REQUEST_SCHEMA,
    action: 'plan',
    task_root: fixture.task,
    intent_id: null,
    proposed_intent: proposedIntent(fixture),
    bundle: { ...fixture.bundle, ...(bundleOverrides ?? {}) },
    evidence: { ack_message_id: null, report_message_id: null },
    ...rest,
  } as RolloverRequest;
}

function reportOf(
  result: Awaited<ReturnType<typeof inspectOrPlanRollover>>,
): RolloverReport {
  if (result.ok === false) {
    assert.fail(`expected a report, got ${result.code}: ${result.message}`);
  }
  return result.value;
}

function stepStatus(report: RolloverReport, step: string): string {
  return (
    report.steps.find((entry) => entry.step === step)?.status ?? '<missing>'
  );
}

test('a proposed plan reports reducer readiness without writing the record', async () => {
  const fixture = await makeFixture('plan');
  try {
    const before = snapshotTree(fixture.domain.root);
    const report = reportOf(await inspectOrPlanRollover(requestFor(fixture)));

    assert.equal(report.schema, COLLAB_ROLLOVER_REPORT_SCHEMA);
    assert.equal(report.action, 'plan');
    assert.equal(report.intent.found, false);
    assert.equal(report.intent.intent_id, INTENT);
    assert.equal(stepStatus(report, 'create-intent'), 'ready');
    assert.equal(stepStatus(report, 'prepare-transfer'), 'unavailable');
    assert.equal(stepStatus(report, 'confirm-receiver'), 'blocked');
    assert.equal(stepStatus(report, 'complete-transfer'), 'blocked');
    assert.equal(stepStatus(report, 'record-first-work'), 'blocked');
    assert.equal(report.plan_complete, false);
    assert.equal(report.stage, 'unknown');
    assert.equal(report.bundle.verified, true);
    assert.equal(report.bundle.execution_allowed, false);
    assert.equal(report.bundle.pinned, false);
    assert.equal(report.bundle.collaboration.matches_plan, true);
    assert.equal(report.bundle.source_session.matches_plan, true);
    assert.equal(report.bundle.handoff_snapshot.claims_match, true);
    assert.equal(report.bundle.handoff_snapshot.inventory_complete, true);
    assert.equal(report.bundle.handoff_snapshot.pending.length, 3);
    assert.equal(report.capabilities.host_stop_proof, 'unavailable');
    assert.equal(report.capabilities.native_launch, 'unavailable');
    assert.equal(report.capabilities.native_session_archive, 'unavailable');
    assert.equal(report.capabilities.routing_removal, 'pending');
    assert.ok(report.limits.includes('no_apply_or_mutation'));
    assert.ok(
      report.blockers.some(
        (blocker) => blocker.code === 'host_stop_proof_unavailable',
      ),
    );
    assert.ok(
      report.steps
        .find((entry) => entry.step === 'prepare-transfer')
        ?.blockers.some(
          (blocker) => blocker.code === 'host_stop_proof_unavailable',
        ),
    );
    assert.deepEqual(report.notify_exclusion.exclusions, []);
    assert.equal(report.notify_exclusion.effective, 'active');
    assert.deepEqual(snapshotTree(fixture.domain.root), before);
    assert.equal(fixture.load().rollover, undefined);
  } finally {
    fixture.cleanup();
  }
});

test('a recorded intent is inspected with exact attempt, claim and handoff facts', async () => {
  const fixture = await makeFixture('inspect');
  try {
    recordIntent(fixture);
    const before = snapshotTree(fixture.domain.root);
    const report = reportOf(
      await inspectOrPlanRollover(
        requestFor(fixture, {
          action: 'inspect',
          intent_id: INTENT,
          proposed_intent: null,
        }),
      ),
    );

    assert.equal(report.intent.found, true);
    assert.equal(report.intent.source_native?.session_id, OLD.session_id);
    assert.equal(report.intent.bundle?.digest, fixture.bundle.digest);
    assert.equal(
      report.intent.bundle?.ref,
      handoffBundleRelativeRef(fixture.bundle.bundle_id),
    );
    assert.equal(report.stage, 'pre-transfer');
    assert.equal(report.bundle.pinned, true);
    assert.equal(report.handoff.state, 'requested');
    assert.equal(report.attempt?.state, 'assigned');
    assert.equal(report.attempt?.native?.observation, 'confirmed');
    assert.equal(report.attempt?.native?.matches_expected, true);
    assert.equal(report.claims.length, fixture.claims.length);
    assert.equal(report.claims[0]?.holder?.agent_id, OLD.agent_id);
    assert.equal(report.claims[0]?.released_at, null);
    assert.equal(stepStatus(report, 'create-intent'), 'satisfied');
    assert.equal(report.succession.recorded, false);
    assert.equal(report.succession.valid, false);
    assert.equal(report.succession.issue, null);
    assert.equal(report.succession.routing, 'pending');
    assert.equal(report.succession.native_archive, 'unavailable');
    assert.equal(report.prepared.recorded, false);
    assert.equal(report.intent.transfer_boundary, null);
    assert.deepEqual(snapshotTree(fixture.domain.root), before);
  } finally {
    fixture.cleanup();
  }
});

test('unknown intents, wrong actions and drifted identities are reported, never applied', async () => {
  const fixture = await makeFixture('guards');
  try {
    const unknown = await inspectOrPlanRollover(
      requestFor(fixture, {
        action: 'inspect',
        intent_id: 'intent-missing',
        proposed_intent: null,
      }),
    );
    assert.equal(unknown.ok, false);
    assert.equal(unknown.ok === false && unknown.code, 'unknown_intent');
    assert.equal(unknown.ok === false && unknown.kind, 'needs_input');

    const wrongDigest = await inspectOrPlanRollover(
      requestFor(fixture, {
        bundleOverrides: { digest: `sha256:${'9'.repeat(64)}` },
      }),
    );
    assert.equal(
      wrongDigest.ok === false && wrongDigest.code,
      'bundle_digest_mismatch',
    );

    const missingBundle = await inspectOrPlanRollover(
      requestFor(fixture, {
        bundleOverrides: { bundle_id: randomUUID() },
      }),
    );
    assert.equal(
      missingBundle.ok === false && missingBundle.kind,
      'needs_input',
    );

    // A bundle whose collaboration binding names another attempt cannot match the plan.
    const mismatched = await makeFixture('association', { attempt: 2 });
    try {
      const report = reportOf(
        await inspectOrPlanRollover(
          requestFor(mismatched, { bundle: { ...mismatched.bundle } }),
        ),
      );
      assert.equal(report.bundle.collaboration.matches_plan, false);
      assert.ok(
        report.drift.some(
          (blocker) => blocker.code === 'bundle_association_mismatch',
        ),
      );
    } finally {
      mismatched.cleanup();
    }

    // A recorded intent pins one exact bundle: an alternate valid bundle is never a
    // substitute for the originally pinned checkpoint context.
    const pinnedFixture = await makeFixture('pin');
    try {
      recordIntent(pinnedFixture);
      const alternate = await publishBundle(
        pinnedFixture.domain.root,
        {},
        pinnedFixture.load().claims,
      );
      const swapped = await inspectOrPlanRollover(
        requestFor(pinnedFixture, {
          action: 'inspect',
          intent_id: INTENT,
          proposed_intent: null,
          bundle: { ...alternate },
        }),
      );
      assert.equal(swapped.ok === false && swapped.code, 'bundle_pin_mismatch');
      assert.equal(swapped.ok === false && swapped.kind, 'needs_input');
      const pinned = reportOf(
        await inspectOrPlanRollover(
          requestFor(pinnedFixture, {
            action: 'inspect',
            intent_id: INTENT,
            proposed_intent: null,
          }),
        ),
      );
      assert.equal(pinned.bundle.digest, pinnedFixture.bundle.digest);
      assert.equal(pinned.bundle.pinned, true);
    } finally {
      pinnedFixture.cleanup();
    }
  } finally {
    fixture.cleanup();
  }
});

test('a completed transfer reports post-transfer facts and no false source drift', async () => {
  const fixture = await makeFixture('completed');
  try {
    recordSuccession(fixture);
    const before = snapshotTree(fixture.domain.root);
    const report = reportOf(
      await inspectOrPlanRollover(
        requestFor(fixture, {
          action: 'plan',
          intent_id: INTENT,
          proposed_intent: null,
        }),
      ),
    );
    assert.equal(report.stage, 'completed');
    assert.deepEqual(report.drift, []);
    assert.equal(report.plan_complete, true);
    assert.equal(report.succession.recorded, true);
    assert.equal(report.succession.valid, true);
    assert.equal(report.succession.issue, null);
    assert.equal(report.intent.transfer_boundary !== null, true);
    assert.equal(report.intent.successor_native?.session_id, NEXT.session_id);
    for (const step of report.steps) assert.equal(step.status, 'satisfied');
    assert.equal(report.attempt?.assignee?.agent_id, NEXT.agent_id);
    assert.equal(report.attempt?.native?.session_id, NEXT.session_id);
    assert.equal(report.attempt?.native?.matches_expected, true);
    assert.equal(
      report.attempt?.expected?.assignee?.session_id,
      NEXT.session_id,
    );
    assert.equal(report.claims[0]?.holder?.agent_id, NEXT.agent_id);
    assert.equal(
      report.claims[0]?.expected_epoch,
      (report.claims[0]?.expected_resource_epoch ?? 0) + 1,
    );
    assert.equal(report.notify_exclusion.effective, 'excluded');
    assert.deepEqual(snapshotTree(fixture.domain.root), before);
  } finally {
    fixture.cleanup();
  }
});

test('superseded attempts stay visible as current-record drift', async () => {
  const fixture = await makeFixture('drift');
  try {
    recordIntent(fixture);
    const assign = {
      message_id: 'msg-assign-work-2',
      type: 'ASSIGN' as const,
      task_id: TASK,
      from: COORD,
      to: NEXT,
      subtask_id: SUBTASK,
      attempt: 2,
      owner_epoch: 1,
      body: {
        assignment_digest: `sha256:${'c'.repeat(64)}`,
        input_revision: OTHER_INPUT,
      },
    };
    // The reducer will refuse attempt 2 while attempt 1 is open; record it as a late
    // protocol observation instead so the inspection has a real newer attempt to report.
    const late = transact(fixture.task, {
      actor: 'fixture',
      purpose: 'record-late-assign',
      apply: (record) => {
        record.attempts = [
          ...(record.attempts ?? []),
          {
            subtask_id: SUBTASK,
            attempt: 2,
            state: 'assigned',
            owner_epoch: 1,
            assignee: NEXT,
            assignment_message_id: assign.message_id,
            assignment_ref: null,
            assignment_digest: null,
            input_revision: OTHER_INPUT,
            created_at: '2026-10-22T02:00:00Z',
            updated_at: '2026-10-22T02:00:00Z',
            native: {
              runner: null,
              session_id: null,
              run_id: null,
              mission_id: null,
              observation: 'unknown',
              observed_at: null,
              evidence_ref: null,
            },
            approval: null,
            transitions: [],
          },
        ];
        return { record, op: 'record-late-assign', summary: {}, result: null };
      },
    });
    assert.equal(late.ok, true, JSON.stringify(late));
    const report = reportOf(
      await inspectOrPlanRollover(
        requestFor(fixture, {
          action: 'inspect',
          intent_id: INTENT,
          proposed_intent: null,
        }),
      ),
    );
    assert.ok(
      report.drift.some((blocker) => blocker.code === 'attempt_superseded'),
      JSON.stringify(report.drift),
    );
    assert.equal(stepStatus(report, 'create-intent'), 'satisfied');
    assert.equal(report.plan_complete, false);
  } finally {
    fixture.cleanup();
  }
});

test('the request document is bounded, versioned and never silently applied', async () => {
  const fixture = await makeFixture('request');
  try {
    const good = fixture.write('request.json', requestFor(fixture));
    const loaded = loadRolloverRequest(good);
    assert.equal(loaded.ok, true);

    const applyAction = fixture.write('apply.json', {
      ...requestFor(fixture),
      action: 'apply',
    });
    const rejected = loadRolloverRequest(applyAction);
    assert.equal(
      rejected.ok === false && rejected.code,
      'request_action_invalid',
    );

    const wrongSchema = fixture.write('schema.json', {
      ...requestFor(fixture),
      schema: 'pappra/collaboration-rollover-request/0',
    });
    const schemaFailure = loadRolloverRequest(wrongSchema);
    assert.equal(
      schemaFailure.ok === false && schemaFailure.code,
      'request_schema_invalid',
    );

    const relativeRoot = fixture.write('relative.json', {
      ...requestFor(fixture),
      task_root: 'domain/tasks/sample',
    });
    const relativeFailure = loadRolloverRequest(relativeRoot);
    assert.equal(
      relativeFailure.ok === false && relativeFailure.code,
      'request_invalid',
    );

    const oversized = join(fixture.domain.root, 'oversized.json');
    writeFileSync(oversized, 'x'.repeat(65 * 1024));
    const tooLarge = loadRolloverRequest(oversized);
    assert.equal(tooLarge.ok === false && tooLarge.code, 'request_unreadable');

    const relativeFile = loadRolloverRequest('request.json');
    assert.equal(
      relativeFile.ok === false && relativeFile.code,
      'request_unreadable',
    );
  } finally {
    fixture.cleanup();
  }
});

test('the CLI rejects unsupported actions, unknown flags and mismatched roots', async () => {
  const fixture = await makeFixture('cli-invalid');
  try {
    const request = fixture.write('request.json', requestFor(fixture));

    const applied = runCli(
      [
        'collab',
        'rollover',
        'apply',
        '--task-root',
        fixture.task,
        '--request',
        request,
        '--json',
      ],
      fixture.domain.root,
    );
    assert.equal(applied.status, 2);
    const appliedBody = JSON.parse(applied.stdout) as Record<string, unknown>;
    assert.equal(appliedBody['ok'], false);
    assert.equal(appliedBody['code'], 'invalid_arguments');

    const unknownFlag = runCli(
      [
        'collab',
        'rollover',
        'plan',
        '--task-root',
        fixture.task,
        '--request',
        request,
        '--config',
        request,
        '--json',
      ],
      fixture.domain.root,
    );
    assert.equal(unknownFlag.status, 2);
    assert.match(unknownFlag.stdout, /collab rollover accepts only/);

    const mismatchedRoot = runCli(
      [
        'collab',
        'rollover',
        'plan',
        '--task-root',
        fixture.domain.tasks[TASK]!,
        '--request',
        fixture.write('other.json', {
          ...requestFor(fixture),
          task_root: fixture.domain.root,
        }),
        '--json',
      ],
      fixture.domain.root,
    );
    assert.equal(mismatchedRoot.status, 2);
    const mismatchBody = JSON.parse(mismatchedRoot.stdout) as Record<
      string,
      unknown
    >;
    assert.equal(mismatchBody['code'], 'task_root_mismatch');

    const missingRequest = runCli(
      ['collab', 'rollover', 'inspect', '--task-root', fixture.task, '--json'],
      fixture.domain.root,
    );
    assert.equal(missingRequest.status, 2);

    const help = runCli(['collab', 'rollover', '--help'], fixture.domain.root);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /collab rollover <inspect\|plan>/);
    assert.match(help.stdout, /There is no apply action/);

    const umbrella = runCli(['collab', '--help'], fixture.domain.root);
    assert.equal(umbrella.status, 0);
    assert.match(umbrella.stdout, /rollover <inspect\|plan>/);
    assert.match(umbrella.stdout, /read-only/i);

    const noSubAction = runCli(['collab', 'rollover'], fixture.domain.root);
    assert.equal(noSubAction.status, 2);
    assert.match(
      `${noSubAction.stdout}${noSubAction.stderr}`,
      /Missing: inspect or plan/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('the CLI inspect and plan runs are read-only and versioned', async () => {
  const fixture = await makeFixture('cli-plan');
  try {
    recordIntent(fixture);
    const request = fixture.write('request.json', {
      ...requestFor(fixture),
      action: 'inspect',
      intent_id: INTENT,
      proposed_intent: null,
    });
    const planRequest = fixture.write('plan.json', {
      ...requestFor(fixture),
      action: 'plan',
      intent_id: INTENT,
      proposed_intent: null,
    });
    const before = snapshotTree(fixture.domain.root);
    const result = runCli(
      [
        'collab',
        'rollover',
        'inspect',
        '--task-root',
        fixture.task,
        '--request',
        request,
        '--json',
      ],
      fixture.domain.root,
    );
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(body['schema'], PUBLIC_REPORT_SCHEMA);
    assert.equal(body['ok'], true);
    assert.equal(body['plan_complete'], false);
    const bundle = body['bundle'] as Record<string, unknown>;
    assert.equal(bundle['verified'], true);
    assert.equal(bundle['execution_allowed'], false);
    assert.deepEqual(snapshotTree(fixture.domain.root), before);

    const plan = runCli(
      [
        'collab',
        'rollover',
        'plan',
        '--task-root',
        fixture.task,
        '--request',
        planRequest,
      ],
      fixture.domain.root,
    );
    assert.equal(plan.status, 0, plan.stderr);
    assert.match(plan.stdout, /rollover plan/i);
    assert.match(plan.stdout, /read-only/i);
    assert.deepEqual(snapshotTree(fixture.domain.root), before);
  } finally {
    fixture.cleanup();
  }
});

test('the public app entry exposes the same read-only inspection', () => {
  assert.equal(publicInspectOrPlanRollover, inspectOrPlanRollover);
  assert.equal(PUBLIC_REPORT_SCHEMA, COLLAB_ROLLOVER_REPORT_SCHEMA);
});

test('a validated succession excludes the archived old native from notify without rewriting history', async () => {
  const fixture = await makeFixture('notify');
  try {
    recordSuccession(fixture);
    const record = fixture.load();
    assert.equal((record.successions ?? []).length, 1);
    assert.equal(routeExclusionFor(record, OLD).state, 'excluded');
    assert.equal(routeExclusionFor(record, NEXT).state, 'active');

    const archived = fixture.send({
      message_id: 'msg-old-sender',
      type: 'REPORT',
      task_id: TASK,
      from: OLD,
      to: WATCH,
      subtask_id: SUBTASK,
      attempt: 1,
      body: { status: 'completed' },
    });
    const current = fixture.send({
      message_id: 'msg-current-sender',
      type: 'REPORT',
      task_id: TASK,
      from: NEXT,
      to: WATCH,
      subtask_id: SUBTASK,
      attempt: 1,
      body: { status: 'completed' },
    });
    const bindingFile = join(fixture.domain.root, 'binding.json');
    writeFileSync(
      bindingFile,
      `${JSON.stringify(
        {
          schema: 'pappra/collab-binding/1',
          task_id: TASK,
          task_root: fixture.task,
          channel: 'herdr',
          participants: [
            {
              agent_id: OLD.agent_id,
              harness: OLD.harness,
              cwd: fixture.task,
              herdr_agent: 'pappra-implement-old',
              pane_id: 'w3:p3',
              native_session_id: OLD.session_id,
            },
            {
              agent_id: NEXT.agent_id,
              harness: NEXT.harness,
              cwd: fixture.task,
              herdr_agent: 'pappra-implement-new',
              pane_id: 'w4:p2',
              native_session_id: NEXT.session_id,
            },
            {
              agent_id: WATCH.agent_id,
              harness: WATCH.harness,
              cwd: fixture.task,
              herdr_agent: 'pappra-watcher',
              pane_id: 'w3:p4',
              native_session_id: WATCH.session_id,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const messageFile = join(
      fixture.task,
      'messages',
      `${archived.message_id}.json`,
    );
    const beforeBytes = readFileSync(messageFile);
    const before = snapshotTree(fixture.domain.root);

    for (const apply of [false, true]) {
      const notified = await notifyRegisteredMessage({
        taskRoot: fixture.task,
        messageId: archived.message_id,
        bindingFile,
        apply,
        retry: false,
      });
      assert.equal(notified.ok, false, JSON.stringify(notified));
      assert.equal(
        notified.ok === false && notified.code,
        'sender_route_excluded',
      );
    }
    assert.deepEqual(readFileSync(messageFile), beforeBytes);
    assert.equal(
      existsSync(deliveryPathFor(fixture.task, archived.message_id)),
      false,
    );
    assert.deepEqual(snapshotTree(fixture.domain.root), before);

    // A completed handoff alone proves nothing: without the matching intent, message
    // ledger and admitted result the archived identity cannot be excluded.
    const stripped = structuredClone(fixture.load());
    stripped.rollover = [];
    stripped.messages = [];
    stripped.results = [];
    const strippedLookup = routeExclusionFor(stripped, OLD);
    assert.equal(strippedLookup.state, 'unknown');
    assert.match(String(strippedLookup.conflict), /intent/);

    // The successor identity is the current route and still plans normally.
    const planned = await notifyRegisteredMessage({
      taskRoot: fixture.task,
      messageId: current.message_id,
      bindingFile,
      apply: false,
      retry: false,
    });
    if (planned.ok === false) assert.fail(JSON.stringify(planned));
    assert.equal(planned.value.status, 'planned');
    assert.equal(planned.value.target?.native_session, 'unknown');
  } finally {
    fixture.cleanup();
  }
});

test('notify rechecks succession after transport awaits and delivery reservation', async (context) => {
  for (const seam of ['caller', 'list', 'reservation'] as const) {
    for (const side of ['sender', 'recipient'] as const) {
      await context.test(`${side} archived during ${seam}`, async (subtest) => {
        const fixture = await makeFixture(`notify-race-${seam}-${side}`);
        try {
          const sender = side === 'sender' ? OLD : WATCH;
          const recipient = side === 'recipient' ? OLD : WATCH;
          const message = fixture.send({
            message_id: 'msg-before-succession',
            type: 'STATUS_QUERY',
            task_id: TASK,
            from: sender,
            to: recipient,
            body: {},
          });
          const participants = [sender, recipient].map((identity, index) => ({
            agent_id: identity.agent_id,
            harness: identity.harness ?? 'unknown',
            cwd: fixture.task,
            herdr_agent: identity.agent_id,
            pane_id: `w3:p${index + 1}`,
            native_session_id: identity.session_id,
          }));
          const bindingFile = fixture.write('notify-race-binding.json', {
            schema: 'pappra/collab-binding/1',
            task_id: TASK,
            task_root: fixture.task,
            channel: 'herdr',
            participants,
          });
          let prompts = 0;
          const transport: HerdrTransport = {
            id: 'succession-race',
            async verifyCaller() {
              if (seam === 'caller') recordSuccession(fixture);
              return {
                ok: true,
                caller: {
                  paneId: participants[0]!.pane_id,
                  workspaceId: 'w3',
                  tabId: 'w3:t1',
                  harness: sender.harness,
                  cwd: fixture.task,
                  sessionKind: 'id',
                  sessionValue: sender.session_id,
                  source: 'current',
                },
              };
            },
            async list() {
              if (seam === 'list') recordSuccession(fixture);
              return {
                ok: true,
                agents: participants.map((participant) => ({
                  name: participant.herdr_agent,
                  harness: participant.harness,
                  paneId: participant.pane_id,
                  cwd: fixture.task,
                  sessionValue: participant.native_session_id,
                  sessionKind: 'id',
                  status: 'idle',
                  focused: false,
                })),
              };
            },
            async prompt() {
              prompts += 1;
              return { status: 'submitted', detail: null };
            },
          };
          if (seam === 'reservation') {
            const originalRename = fs.renameSync;
            let changed = false;
            subtest.mock.method(
              fs,
              'renameSync',
              (from: fs.PathLike, to: fs.PathLike) => {
                originalRename(from, to);
                if (
                  !changed &&
                  to === deliveryPathFor(fixture.task, message.message_id)
                ) {
                  changed = true;
                  recordSuccession(fixture);
                }
              },
            );
          }
          const notified = await notifyRegisteredMessage({
            taskRoot: fixture.task,
            messageId: message.message_id,
            bindingFile,
            apply: true,
            retry: false,
            transport,
          });
          assert.equal(notified.ok, false, JSON.stringify(notified));
          assert.equal(!notified.ok && notified.code, `${side}_route_excluded`);
          assert.equal(prompts, 0);
          const delivery = readDeliveryRecord(fixture.task, message.message_id);
          assert.equal(
            delivery?.status ?? null,
            seam === 'reservation' ? 'failed' : null,
          );
        } finally {
          subtest.mock.restoreAll();
          fixture.cleanup();
        }
      });
    }
  }
});

test('a succession referencing a non-completed handoff never excludes a route', async () => {
  const fixture = await makeFixture('unknown');
  try {
    recordIntent(fixture);
    const forged = transact(fixture.task, {
      actor: 'fixture',
      purpose: 'forge-succession',
      apply: (record) => {
        record.successions = [
          {
            schema: 'pappra/collab-succession/1',
            intent_id: INTENT,
            handoff_id: HANDOFF,
            generation: 1,
            old_native: {
              agent_id: OLD.agent_id,
              runner: 'pi',
              session_id: OLD.session_id,
              run_id: 'run-source',
              mission_id: null,
            },
            successor_native: {
              agent_id: NEXT.agent_id,
              runner: 'pi',
              session_id: NEXT.session_id,
              run_id: 'run-successor',
              mission_id: null,
            },
            archived_at: '2026-10-22T03:00:00Z',
            history_retained: true,
            routing: 'pending',
            native_archive: 'unavailable',
            proof: {
              message_id: 'msg-report-first-work',
              digest: `sha256:${'d'.repeat(64)}`,
            },
          },
        ];
        return { record, op: 'forge-succession', summary: {}, result: null };
      },
    });
    assert.equal(forged.ok, true, JSON.stringify(forged));
    const record = fixture.load();
    const lookup = routeExclusionFor(record, OLD);
    assert.equal(lookup.state, 'unknown');
    assert.match(String(lookup.conflict), /handoff/);
    // A successor match is validated too: this identity is the named receiver, so a
    // succession that cannot prove the transfer makes the route unknown, not active.
    const successorLookup = routeExclusionFor(record, NEXT);
    assert.equal(successorLookup.state, 'unknown');
    assert.match(String(successorLookup.conflict), /handoff/);
    assert.equal(routeExclusionFor(record, WATCH).state, 'active');
  } finally {
    fixture.cleanup();
  }
});

test('evidence ids are read through the safe reader and reported when unreadable', async () => {
  const fixture = await makeFixture('evidence');
  try {
    const before = snapshotTree(fixture.domain.root);
    const report = reportOf(
      await inspectOrPlanRollover(
        requestFor(fixture, {
          evidence: {
            ack_message_id: 'msg-assign-work',
            report_message_id: '../escape',
          },
        }),
      ),
    );
    assert.equal(report.evidence.requested.length, 2);
    assert.equal(report.evidence.supplied, 1);
    assert.ok(report.evidence.raw_bytes > 0);
    assert.equal(report.evidence.over_budget, false);
    assert.deepEqual(
      report.evidence.unreadable.map((entry) => entry.message_id),
      ['../escape'],
    );
    assert.equal(report.evidence.unreadable[0]?.code, 'message_id_invalid');
    assert.equal(report.evidence.correlations.length, 1);
    // Correlation is exact: an ASSIGN without a handoff id never claims to apply.
    assert.equal(report.evidence.correlations[0]?.applies_to_intent, false);
    assert.equal(report.plan_complete, false);
    assert.ok(
      report.evidence.issues.some(
        (issue) => issue.code === 'evidence_unreadable',
      ),
    );
    assert.deepEqual(snapshotTree(fixture.domain.root), before);
  } finally {
    fixture.cleanup();
  }
});

test('a corrupt registered message is read descriptor-bounded and charged before refusal', async () => {
  const fixture = await makeFixture('corrupt');
  try {
    const message = fixture.send({
      message_id: 'msg-probe-ack',
      type: 'ACK',
      reply_to: 'msg-assign-work',
      task_id: TASK,
      from: OLD,
      to: COORD,
      subtask_id: SUBTASK,
      attempt: 1,
      body: { handoff_id: HANDOFF },
    });
    const target = join(fixture.task, 'messages', `${message.message_id}.json`);
    const padded = 'x'.repeat(900 * 1024);
    writeFileSync(target, padded);
    let preread = 0;
    const original = fs.readFileSync as unknown as (
      ...args: unknown[]
    ) => string | Buffer;
    const patched = (file: unknown, ...args: unknown[]): string | Buffer => {
      const value = original.call(fs, file, ...args);
      if (String(file) === target) preread += Buffer.byteLength(value);
      return value;
    };
    (fs as unknown as { readFileSync: unknown }).readFileSync = patched;
    let report: RolloverReport | null = null;
    try {
      report = reportOf(
        await inspectOrPlanRollover(
          requestFor(fixture, {
            evidence: {
              ack_message_id: message.message_id,
              report_message_id: null,
            },
          }),
        ),
      );
    } finally {
      (fs as unknown as { readFileSync: unknown }).readFileSync = original;
    }
    assert.equal(
      preread,
      0,
      'no helper may fully pre-read the registered file',
    );
    assert.equal(report.evidence.raw_bytes, Buffer.byteLength(padded));
    assert.equal(report.evidence.over_budget, false);
    assert.deepEqual(report.evidence.unreadable, [
      { message_id: message.message_id, code: 'message_corrupt' },
    ]);
    assert.equal(report.plan_complete, false);
    assert.ok(
      report.evidence.issues.some(
        (issue) => issue.code === 'evidence_unreadable',
      ),
    );
  } finally {
    fixture.cleanup();
  }
});

test('a verified bundle cannot grant authority and reports its exact identity', async () => {
  const fixture = await makeFixture('bundle');
  try {
    const report = reportOf(await inspectOrPlanRollover(requestFor(fixture)));
    assert.equal(report.bundle.digest, fixture.bundle.digest);
    assert.equal(report.bundle.digest_matches, true);
    assert.equal(
      report.bundle.ref,
      `${CONTINUITY_TASK}/${handoffBundleRelativeRef(fixture.bundle.bundle_id)}`,
    );
    assert.equal(report.bundle.context_integrity, 'complete');
    assert.equal(report.bundle.checkpoint_present, true);
    assert.equal(report.bundle.workspace_identity_matches, true);
    assert.equal(report.bundle.execution_allowed, false);
    assert.equal(report.bundle.collaboration.task_id, TASK);
    assert.equal(report.bundle.collaboration.association !== null, true);
    // The bundle type itself never carries an apply grant.
    const bundle = JSON.parse(
      readFileSync(
        join(
          fixture.bundle.root,
          '.pappra',
          'local',
          'tasks',
          CONTINUITY_TASK,
          'handoff-bundles',
          `${fixture.bundle.bundle_id}.json`,
        ),
        'utf8',
      ),
    ) as HandoffBundle;
    assert.equal(bundle.handoff.executionAuthority, 'none');
    assert.equal(bundle.handoff.advisory, true);
  } finally {
    fixture.cleanup();
  }
});

test('requested evidence must correlate exactly, including proof ordering', async () => {
  const fixture = await makeFixture('evidence-correlation');
  try {
    recordSuccession(fixture);
    const record = fixture.load();
    const reportMessage = (record.messages ?? []).find(
      (entry) => entry.type === 'REPORT' && entry.state === 'applied',
    );
    assert.ok(reportMessage, 'the fixture must record a first-work REPORT');
    const report = reportOf(
      await inspectOrPlanRollover(
        requestFor(fixture, {
          action: 'plan',
          intent_id: INTENT,
          proposed_intent: null,
          evidence: {
            ack_message_id: 'msg-ack-successor',
            report_message_id: reportMessage.message_id,
          },
        }),
      ),
    );
    assert.equal(report.evidence.supplied, 2);
    assert.deepEqual(report.evidence.issues, []);
    const ack = report.evidence.correlations.find(
      (entry) => entry.role === 'ack',
    );
    const firstWork = report.evidence.correlations.find(
      (entry) => entry.role === 'report',
    );
    assert.equal(ack?.applies_to_intent, true);
    assert.equal(ack?.intent_id, INTENT);
    assert.equal(firstWork?.applies_to_intent, true);
    assert.equal(firstWork?.proof_order_ok, true);
    assert.equal(report.plan_complete, true);

    // A REPORT presented as the ACK slot is a contradiction, not a report that stays complete.
    const mismatched = reportOf(
      await inspectOrPlanRollover(
        requestFor(fixture, {
          action: 'plan',
          intent_id: INTENT,
          proposed_intent: null,
          evidence: {
            ack_message_id: reportMessage.message_id,
            report_message_id: null,
          },
        }),
      ),
    );
    assert.equal(mismatched.plan_complete, false);
    assert.ok(
      mismatched.evidence.issues.some(
        (issue) => issue.code === 'evidence_type_mismatch',
      ),
    );
  } finally {
    fixture.cleanup();
  }
});

test('an incomplete handoff snapshot inventory blocks completion', async () => {
  const fixture = await makeFixture(
    'partial',
    {},
    { claimsCompleteness: 'partial' },
  );
  try {
    const report = reportOf(await inspectOrPlanRollover(requestFor(fixture)));
    assert.equal(report.bundle.handoff_snapshot.claims_completeness, 'partial');
    assert.equal(report.bundle.handoff_snapshot.inventory_complete, false);
    assert.ok(
      report.drift.some(
        (blocker) => blocker.code === 'bundle_inventory_incomplete',
      ),
    );
    assert.equal(report.plan_complete, false);
  } finally {
    fixture.cleanup();
  }
});

test('the public app entry validates a direct request object', async () => {
  const invalid = await inspectOrPlanRollover({
    schema: COLLAB_ROLLOVER_REQUEST_SCHEMA,
    action: 'apply',
    task_root: '/tmp/nowhere',
    intent_id: null,
    proposed_intent: null,
    bundle: {
      root: '/tmp/nowhere',
      continuity_task_id: 'x',
      bundle_id: 'y',
      digest: `sha256:${'f'.repeat(64)}`,
    },
    evidence: { ack_message_id: null, report_message_id: null },
  } as unknown as RolloverRequest);
  assert.equal(invalid.ok === false && invalid.kind, 'invalid');
  assert.equal(invalid.ok === false && invalid.code, 'request_action_invalid');
});

test('tampered proof or malformed successions stay unknown instead of excluding', async () => {
  const fixture = await makeFixture('tampered');
  try {
    recordSuccession(fixture);
    const tampered = transact(fixture.task, {
      actor: 'fixture',
      purpose: 'tamper-proof',
      apply: (record) => {
        const entry = (record.successions ?? [])[0];
        assert.ok(entry);
        entry.proof.digest = `sha256:${'0'.repeat(64)}`;
        return { record, op: 'tamper-proof', summary: {}, result: null };
      },
    });
    assert.equal(tampered.ok, true, JSON.stringify(tampered));
    const poisoned = routeExclusionFor(fixture.load(), OLD);
    assert.equal(poisoned.state, 'unknown');
    assert.match(String(poisoned.conflict), /digest/);

    // A malformed entry is refused by the record validator, so evaluate it in memory:
    // the route check must answer `unknown` instead of throwing.
    const malformed = structuredClone(fixture.load());
    malformed.successions = ['not-an-object' as never];
    const broken = routeExclusionFor(malformed, OLD);
    assert.equal(broken.state, 'unknown');
    assert.match(String(broken.conflict), /malformed|failed validation/);
  } finally {
    fixture.cleanup();
  }
});
