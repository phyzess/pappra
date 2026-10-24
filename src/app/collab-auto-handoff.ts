import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../collab/envelope.js';
import { findAttempt } from '../collab/lifecycle.js';
import { transact } from '../collab/store.js';
import type { RolloverInventory } from '../collab/rollover.js';
import type { TaskRecord } from '../collab/types.js';
import {
  CheckpointService,
  saveHandoffBundle,
  type SaveCheckpointInput,
  type HandoffSourceNativeSession,
} from '../continuity/index.js';
import {
  continuityTaskPaths,
  writeContinuityBytes,
} from '../continuity/paths.js';
import { readBoundedFile } from './bounded-file.js';
import type { ManagedPiReadinessConfig } from './managed-pi-readiness.js';
import { prepareManagedHandoffContextReference } from './managed-pi-handoff-reference.js';
import {
  openTaskStore,
  assertTaskStoreCurrent,
  type OpenedTaskStore,
} from './collab-task-store.js';
import {
  openMessageTask,
  readRegisteredMessageSafe,
} from './collab-messages.js';
import {
  applySessionTransition,
  type SessionTransitionDependencies,
  type SessionTransitionReport,
  type SessionTransitionRequest,
} from './collab-session-transition.js';

export const AUTO_HANDOFF_SCHEMA = 'pappra/automatic-handoff/1';
const JOURNAL = 'automatic_handoff_journal';
const MAX_ENTRIES = 32;

export interface AutomaticHandoffConfig {
  readonly schema: typeof AUTO_HANDOFF_SCHEMA;
  readonly id: string;
  readonly thresholdPercent: number;
  readonly workspaceRoot: string;
  readonly checkpoint: SaveCheckpointInput & {
    readonly objective: string;
    readonly acceptance: readonly string[];
  };
  readonly bundleId: string;
  readonly nextAction: string;
  /** Approved output locations for this source's independently observed admission. */
  readonly sourceReadiness?: ManagedPiReadinessConfig;
  readonly transition: Omit<SessionTransitionRequest, 'bundle'>;
}

/** Provided by an owned runtime, never deserialized from a claimed proof file. */
export interface AutomaticHandoffRuntime {
  /** Native eligibility is checked before reserving a provider call or fencing input. */
  canCaptureSummary?(): boolean;
  /** Trusted app callback; refreshes only the source capability pin after native compaction. */
  prepareBootstrapAdmission?(original: {
    readonly ref: string;
    readonly digest: string;
  }): Promise<{
    readonly ref: string;
    readonly digest: string;
  }>;
  observe(): {
    readonly native: HandoffSourceNativeSession;
    readonly cwd: string;
    readonly contextPercent: number | null;
  };
  /** Real native model summary; an absent/failed summary must never be filled in. */
  captureSummary(causeId: string): Promise<{
    readonly summary: string;
    readonly complete: boolean;
    readonly sessionFile?: string | null;
  }>;
  inventory(): Promise<RolloverInventory>;
}

interface Entry {
  readonly id: string;
  readonly config_digest: string;
  stage:
    | 'capture_reserved'
    | 'prepared'
    | 'active'
    | 'complete'
    | 'reconcile_required';
  request: SessionTransitionRequest | null;
  code: string | null;
}

export interface AutomaticHandoffResult {
  readonly schema: typeof AUTO_HANDOFF_SCHEMA;
  readonly status:
    | 'below-threshold'
    | 'waiting'
    | 'progressed'
    | 'complete'
    | 'blocked'
    | 'reconcile_required';
  readonly code: string | null;
  readonly transition: SessionTransitionReport | null;
  /** Exact revalidated request used for the guarded transition, including admitted evidence. */
  readonly request?: SessionTransitionRequest;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function entries(record: TaskRecord): Entry[] {
  const value = record[JOURNAL];
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > MAX_ENTRIES ||
    !value.every(
      (row) =>
        object(row) &&
        typeof row.id === 'string' &&
        typeof row.config_digest === 'string' &&
        [
          'capture_reserved',
          'prepared',
          'active',
          'complete',
          'reconcile_required',
        ].includes(String(row.stage)) &&
        (row.request === null || object(row.request)) &&
        (row.code === null || typeof row.code === 'string'),
    )
  )
    throw new Error('automatic_handoff_journal_invalid');
  return value as Entry[];
}

async function storeEntry(
  task: OpenedTaskStore,
  next: Entry,
  create: boolean,
  authorize?: (record: TaskRecord) => boolean,
): Promise<OpenedTaskStore> {
  const unsafe = await assertTaskStoreCurrent(task);
  if (unsafe) throw new Error(unsafe.code);
  const result = transact(task.taskRoot, {
    actor: 'automatic-handoff',
    purpose: next.stage,
    apply(record) {
      if (create && (!authorize || !authorize(record)))
        return { ok: false, reason: 'automatic_handoff_authority_changed' };
      const rows = entries(record);
      const index = rows.findIndex((row) => row.id === next.id);
      if (create && index >= 0)
        return { ok: false, reason: 'automatic_handoff_already_reserved' };
      if (
        !create &&
        (index < 0 || rows[index]?.config_digest !== next.config_digest)
      )
        return { ok: false, reason: 'automatic_handoff_reservation_changed' };
      if (index < 0) {
        if (rows.length >= MAX_ENTRIES)
          return { ok: false, reason: 'automatic_handoff_limit' };
        rows.push(next);
      } else rows[index] = next;
      record[JOURNAL] = rows;
      return {
        record,
        op: 'automatic-handoff',
        summary: { id: next.id, stage: next.stage },
        result: null,
      };
    },
  });
  if (!result.ok) throw new Error(result.reason);
  return reopenTask(task);
}

async function reopenTask(previous: OpenedTaskStore): Promise<OpenedTaskStore> {
  const current = await openTaskStore(previous.taskRoot);
  if (!current.ok) throw new Error(current.code);
  for (const key of ['taskRoot', 'messagesDirectory'] as const) {
    const before = previous.identity[key];
    const after = current.value.identity[key];
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.path !== after.path
    )
      throw new Error('automatic_handoff_namespace_changed');
  }
  return current.value;
}

function pending(
  items: readonly unknown[],
  completeness: RolloverInventory['completeness'],
) {
  const values = items.map((item) =>
    typeof item === 'string' ? item : JSON.stringify(item),
  );
  if (values.length > 64 || values.some((item) => !item || item.length > 2048))
    throw new Error('handoff_pending_inventory_exceeds_bound');
  return { items: values, completeness };
}

function captureIdentityMatches(
  record: TaskRecord,
  config: AutomaticHandoffConfig,
  runtime: AutomaticHandoffRuntime,
) {
  const intent = config.transition.intent;
  const observed = runtime.observe();
  const attempt = findAttempt(record, intent.subtask_id, intent.attempt);
  return (
    observed.native.sessionId === intent.from.session_id &&
    observed.cwd === intent.from.cwd &&
    record.task_root === config.transition.task_root &&
    record.coordinator?.owner_epoch === intent.coordinator_epoch &&
    attempt?.assignee.agent_id === intent.from.agent_id &&
    attempt.assignee.session_id === intent.from.session_id &&
    attempt.input_revision === intent.input_revision &&
    ['assigned', 'accepted', 'running'].includes(attempt.state) &&
    intent.claims.every((expected) =>
      record.claims.some(
        (claim) =>
          claim.claim_id === expected.claim_id &&
          claim.released_at === null &&
          claim.resource_epoch === expected.resource_epoch &&
          claim.holder.agent_id === intent.from.agent_id &&
          claim.holder.session_id === intent.from.session_id,
      ),
    )
  );
}

/** Resolve only digest-verified, applied evidence for this exact handoff; the core rechecks it. */
async function transitionEvidence(
  request: SessionTransitionRequest,
): Promise<SessionTransitionRequest> {
  const task = await openMessageTask(request.task_root);
  if (!task.ok) throw new Error(task.code);
  let ack: string | null = null;
  let report: string | null = null;
  for (const row of task.value.record.messages) {
    if (
      row.state !== 'applied' ||
      (row.type !== 'ACK' && row.type !== 'REPORT') ||
      row.from.agent_id !== request.intent.to.agent_id ||
      row.from.session_id !== request.intent.to.session_id ||
      row.subtask_id !== request.intent.subtask_id ||
      row.attempt !== request.intent.attempt
    )
      continue;
    const loaded = await readRegisteredMessageSafe(task.value, row.message_id);
    if (!loaded.ok) continue;
    const message = loaded.value.message;
    if (
      message.body?.['handoff_id'] !== request.intent.handoff_id ||
      message.body?.['rollover_intent_id'] !== request.intent.intent_id ||
      message.body?.['rollover_generation'] !== request.intent.generation ||
      message.body?.['input_revision'] !== request.intent.input_revision
    )
      continue;
    if (row.type === 'ACK') ack = row.message_id;
    else report = row.message_id;
  }
  return {
    ...request,
    evidence: { ack_message_id: ack, first_work_report_id: report },
  };
}

/** One supported event advances one bounded transition. Existing transition effects remain authoritative. */
export async function tickAutomaticHandoff(
  config: AutomaticHandoffConfig,
  runtime: AutomaticHandoffRuntime,
  dependencies: SessionTransitionDependencies = {},
): Promise<AutomaticHandoffResult> {
  const result = (
    status: AutomaticHandoffResult['status'],
    code: string | null,
    transition: SessionTransitionReport | null = null,
    request?: SessionTransitionRequest,
  ): AutomaticHandoffResult => ({
    schema: AUTO_HANDOFF_SCHEMA,
    status,
    code,
    transition,
    ...(request ? { request } : {}),
  });
  let task: OpenedTaskStore | null = null;
  let entry: Entry | null = null;
  try {
    if (
      config.schema !== AUTO_HANDOFF_SCHEMA ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(config.id) ||
      !Number.isFinite(config.thresholdPercent) ||
      config.thresholdPercent <= 0 ||
      config.thresholdPercent >= 100 ||
      !path.isAbsolute(config.workspaceRoot) ||
      !config.nextAction ||
      !config.checkpoint.objective ||
      !Array.isArray(config.checkpoint.acceptance) ||
      config.checkpoint.acceptance.length === 0 ||
      config.checkpoint.acceptance.some(
        (item) => typeof item !== 'string' || !item.trim(),
      )
    )
      return result('blocked', 'automatic_handoff_config_invalid');
    const loaded = await openTaskStore(config.transition.task_root);
    if (!loaded.ok) return result('blocked', loaded.code);
    task = loaded.value;
    const digest = `sha256:${crypto.createHash('sha256').update(canonicalJson(config)).digest('hex')}`;
    entry = entries(task.record).find((row) => row.id === config.id) ?? null;
    if (entry && entry.config_digest !== digest)
      return result('blocked', 'automatic_handoff_config_conflict');
    if (
      entry?.stage === 'capture_reserved' ||
      entry?.stage === 'reconcile_required'
    )
      return result(
        'reconcile_required',
        entry.code ?? 'summary_capture_outcome_unknown',
      );
    if (!entry) {
      const observed = runtime.observe();
      if (observed.contextPercent === null)
        return result('waiting', 'native_context_usage_unavailable');
      if (
        !Number.isFinite(observed.contextPercent) ||
        observed.contextPercent < 0 ||
        observed.contextPercent > 100
      )
        return result('blocked', 'native_context_usage_invalid');
      if (observed.contextPercent < config.thresholdPercent)
        return result('below-threshold', null);
      if (!captureIdentityMatches(task.record, config, runtime))
        return result('blocked', 'automatic_handoff_source_mismatch');
      if (runtime.canCaptureSummary && !runtime.canCaptureSummary())
        return result('waiting', 'native_compaction_not_ready');
      entry = {
        id: config.id,
        config_digest: digest,
        stage: 'capture_reserved',
        request: null,
        code: null,
      };
      task = await storeEntry(task, entry, true, (record) =>
        captureIdentityMatches(record, config, runtime),
      );
      const captured = await runtime.captureSummary(config.id);
      if (!captured.summary.trim() || captured.summary.length > 128 * 1024)
        throw new Error('native_handoff_summary_missing_or_oversized');
      let transcriptArtifact: string | null = null;
      if (captured.sessionFile) {
        const before = fs.lstatSync(captured.sessionFile);
        const source = readBoundedFile(captured.sessionFile, 8 * 1024 * 1024);
        const after = fs.lstatSync(captured.sessionFile);
        if (
          !source.ok ||
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs
        )
          throw new Error('native_transcript_capture_unstable');
        const header = JSON.parse(source.text.split('\n', 1)[0]!);
        if (
          header.type !== 'session' ||
          header.id !== observed.native.sessionId ||
          header.cwd !== observed.cwd
        )
          throw new Error('native_transcript_identity_mismatch');
        const destination = path.join(
          continuityTaskPaths(config.workspaceRoot, config.checkpoint.taskId)
            .taskDir,
          'native-context',
          `${config.id}.jsonl`,
        );
        const written = await writeContinuityBytes(
          config.workspaceRoot,
          config.checkpoint.taskId,
          destination,
          Buffer.from(source.text),
          true,
        );
        if (!written.ok) throw new Error(written.code);
        transcriptArtifact = path
          .relative(config.workspaceRoot, destination)
          .split(path.sep)
          .join('/');
      }
      const summaryParts = captured.summary.match(/[\s\S]{1,4000}/g) ?? [];
      const checkpoint = await new CheckpointService(config.workspaceRoot).save(
        {
          ...config.checkpoint,
          authorSession: observed.native.sessionId,
          attempted: [
            ...(config.checkpoint.attempted ?? []),
            ...summaryParts.map(
              (part, i) =>
                `Native handoff context summary (${i + 1}/${summaryParts.length}): ${part}`,
            ),
          ],
          // Native compaction is lossy. Retain its complete source as a private,
          // digest-verified checkpoint artifact instead of relabeling the summary.
          artifacts: [
            ...(config.checkpoint.artifacts ?? []),
            ...(transcriptArtifact ? [transcriptArtifact] : []),
          ],
          contextCompleteness:
            captured.complete || transcriptArtifact ? 'complete' : 'partial',
          nativeRefs: [
            {
              harness: 'pi',
              sessionId: observed.native.sessionId,
              runId: config.id,
            },
          ],
        },
      );
      if (
        !checkpoint.ok ||
        !checkpoint.checkpoint ||
        !checkpoint.checkpointPath
      )
        throw new Error('automatic_checkpoint_capture_incomplete');
      const inventory = await runtime.inventory();
      const checkpointBytes = readBoundedFile(
        checkpoint.checkpointPath,
        16 * 1024 * 1024,
      );
      if (!checkpointBytes.ok)
        throw new Error('automatic_checkpoint_unreadable');
      const current = await openTaskStore(config.transition.task_root);
      if (
        !current.ok ||
        !captureIdentityMatches(current.value.record, config, runtime)
      )
        throw new Error('automatic_handoff_authority_changed');
      task = current.value;
      const intent = config.transition.intent;
      const bundle = await saveHandoffBundle({
        root: config.workspaceRoot,
        continuityTaskId: config.checkpoint.taskId,
        bundleId: config.bundleId,
        checkpoint: {
          checkpointId: checkpoint.checkpoint.checkpointId,
          taskId: checkpoint.checkpoint.taskId,
          workspaceId: checkpoint.checkpoint.workspaceId,
          ref: path
            .relative(
              continuityTaskPaths(
                config.workspaceRoot,
                config.checkpoint.taskId,
              ).taskDir,
              checkpoint.checkpointPath,
            )
            .split(path.sep)
            .join('/'),
          digest: checkpointBytes.digest,
          authorSession: observed.native.sessionId,
          contextCompleteness: checkpoint.checkpoint.contextCompleteness,
        },
        collaboration: {
          taskId: task.record.task_id,
          attempt: intent.attempt,
          ownerEpoch: intent.coordinator_epoch,
          subtaskId: intent.subtask_id,
          inputRevision: intent.input_revision,
          association:
            task.record.task_id === config.checkpoint.taskId
              ? null
              : `Explicit automatic-handoff configuration ${config.id}`,
        },
        sourceNativeSession: observed.native,
        handoff: {
          claims: intent.claims.map((expected) => {
            const claim = task!.record.claims.find(
              (candidate) => candidate.claim_id === expected.claim_id,
            )!;
            return {
              claimId: claim.claim_id,
              resource: claim.key,
              resourceEpoch: expected.resource_epoch,
              holder: claim.holder.agent_id,
            };
          }),
          claimsCompleteness: 'complete',
          pendingTools: pending(inventory.inflight, inventory.completeness),
          pendingMessages: pending(
            inventory.pending_messages ?? [],
            inventory.pending_messages ? inventory.completeness : 'unknown',
          ),
          pendingApprovals: pending(
            inventory.pending_approvals,
            inventory.completeness,
          ),
          nextAction: config.nextAction,
          recovery: [
            'Resume only through the registered transition and verified task authority.',
          ],
          executionAuthority: 'none',
          advisory: true,
        },
        limitations: [
          'Native model summaries are lossy; saved context does not grant execution.',
        ],
      });
      if (!bundle.ok) throw new Error(bundle.code);
      entry = {
        ...entry,
        stage: 'prepared',
        request: {
          ...config.transition,
          ...(runtime.prepareBootstrapAdmission
            ? {
                bootstrap_request: await runtime.prepareBootstrapAdmission(
                  config.transition.bootstrap_request,
                ),
              }
            : {}),
          bundle: {
            root: config.workspaceRoot,
            continuity_task_id: config.checkpoint.taskId,
            bundle_id: bundle.value.bundleId,
            digest: bundle.value.digest,
          },
        },
      };
      task = await storeEntry(task, entry, false);
    }
    if (!entry.request)
      return result('reconcile_required', 'automatic_handoff_request_missing');
    const request = await transitionEvidence(entry.request);
    prepareManagedHandoffContextReference(request);
    const transition = await applySessionTransition(request, dependencies);
    task = await reopenTask(task);
    entry = {
      ...entry,
      stage:
        transition.ok && transition.stage === 'task_retired'
          ? 'complete'
          : 'active',
      code: transition.code,
    };
    task = await storeEntry(task, entry, false);
    return result(
      entry.stage === 'complete'
        ? 'complete'
        : transition.ok
          ? 'progressed'
          : 'waiting',
      transition.code,
      transition,
      request,
    );
  } catch (error) {
    if (task && entry?.stage === 'capture_reserved') {
      try {
        await storeEntry(
          task,
          {
            ...entry,
            stage: 'reconcile_required',
            code: 'summary_or_checkpoint_outcome_unknown',
          },
          false,
        );
      } catch {
        /* retained reservation still prevents recapture */
      }
    }
    return result(
      'reconcile_required',
      error instanceof Error && /^[A-Za-z0-9_-]+$/.test(error.message)
        ? error.message
        : 'automatic_handoff_failed',
    );
  }
}
