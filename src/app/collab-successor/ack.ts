import { buildMessage, contentDigest } from '../../collab/envelope.js';
import { findHandoff, handoffInventory } from '../../collab/handoff.js';
import { submitMessage } from '../../collab/messages.js';
import { readBoundedFile } from '../../infra/bounded-file.js';
import { readRegisteredMessageSafe } from '../collab-messages.js';
import {
  openTaskStore,
  type TaskStoreFailure,
  type TaskStoreResult,
} from '../collab-task-store.js';
import { stamp, writeJsonExclusive } from '../collab-workflow/context.js';
import {
  readSuccessorAck,
  readSuccessorIntent,
  readSuccessorOutcome,
} from './journal.js';
import { SUCCESSOR_ACK_SCHEMA, successorFile } from './types.js';

/**
 * Successor acknowledgement: the one command a freshly launched successor coordinator runs.
 *
 * The command is deliberately conservative. It proves the launch journal, the caller pane, the
 * recorded handoff and the digest-pinned briefing before anything is registered, then registers
 * exactly one HANDOFF confirmation from the successor's observed identity to the current
 * coordinator and records a task-local ack marker. The result is the briefing the successor
 * needs: the checkpoint text plus counted inventory, never message bodies.
 *
 * The task record is changed only through `submitMessage`. Confirming and completing the
 * handoff remain the coordinator's explicit decisions, so nothing here advances that state.
 */

export const SUCCESSOR_ACK_RESULT_SCHEMA =
  'pappra/collab-successor-ack-result/1';

const DEFAULT_MAX_CHECKPOINT_BYTES = 24 * 1024;

export interface SuccessorAckOptions {
  readonly taskRoot: string;
  readonly requestId: string;
  /** Pane the CLI runs in, from HERDR_PANE_ID. Never inferred; null means unverified. */
  readonly callerPane: string | null;
  /**
   * Codex session the CLI runs in, from CODEX_THREAD_ID. Codex runs tool commands in the shared
   * app-server daemon, whose HERDR_PANE_ID is the daemon's own and says nothing about the
   * session, so for a Codex successor this is what identifies the caller.
   */
  readonly callerCodexThread?: string | null;
  readonly apply: boolean;
  readonly clock?: number;
  readonly maxCheckpointBytes?: number;
}

const NEXT_STEP =
  'The current coordinator confirms and then completes the handoff; do not dispatch, accept, claim or release anything until it says dispatch is released.';

const LIMITS = [
  'checkpoint_text_is_the_only_stored_content_printed',
  'briefing_counts_only',
  'stored_state_only',
  'no_native_query',
  'no_approval_answered',
  'cooperative_record_mutation_only',
];

function refuse(
  code: string,
  message: string,
  nextAction: string,
): TaskStoreFailure {
  return { ok: false, code, message, nextAction };
}

function notRecorded(detail: string): TaskStoreFailure {
  return refuse(
    'successor_not_recorded',
    `The launcher has not finished recording the successor identity: ${detail}.`,
    'Wait a few seconds and run the same command again; nothing was registered.',
  );
}

function notReady(detail: string): TaskStoreFailure {
  return refuse(
    'handoff_not_ready',
    `The handoff is not ready for an acknowledgement: ${detail}.`,
    'The coordinator rebinds this identity and transfers the handoff; rerun the same command afterwards.',
  );
}

export async function applySuccessorAck(
  options: SuccessorAckOptions,
): Promise<TaskStoreResult<Record<string, unknown>>> {
  const cap = options.maxCheckpointBytes ?? DEFAULT_MAX_CHECKPOINT_BYTES;
  if (!Number.isSafeInteger(cap) || cap <= 0)
    return refuse(
      'invalid_options',
      'maxCheckpointBytes must be a positive integer.',
      'Use a positive byte limit; nothing was read or written.',
    );
  const clock = options.clock ?? Date.now();
  const requestId = options.requestId;

  const opened = await openTaskStore(options.taskRoot);
  if (!opened.ok) return opened;
  const taskRoot = opened.value.taskRoot;
  const record = opened.value.record;

  // 1. The launcher's journal decides who is allowed to acknowledge. A missing, invalid or
  //    mismatched document is never read as "the launch probably worked".
  const intentRead = readSuccessorIntent(taskRoot, requestId);
  if (!intentRead.ok) return notRecorded(intentRead.detail);
  const intent = intentRead.value;
  if (intent.request_id !== requestId)
    return notRecorded('the recorded intent names another request');

  const outcomeRead = readSuccessorOutcome(taskRoot, requestId);
  if (!outcomeRead.ok) return notRecorded(outcomeRead.detail);
  const outcome = outcomeRead.value;
  if (
    outcome.request_id !== requestId ||
    outcome.request_digest !== intent.request_digest
  )
    return notRecorded('the recorded outcome belongs to another request');
  const identity = outcome.identity;
  if (outcome.status !== 'launched' || identity === null)
    return notRecorded(
      `the launch outcome is ${outcome.status} with no observed identity`,
    );

  // 2. The caller must be the session whose identity the launcher recorded; nothing is inferred
  // from focus. Claude tools inherit the TUI pane's environment; Codex tools do not, so a Codex
  // successor is bound by its own thread id instead of a pane.
  if (identity.harness === 'codex') {
    const thread = options.callerCodexThread ?? null;
    if (thread === null)
      return refuse(
        'codex_thread_unverified',
        'CODEX_THREAD_ID is not set, so the recorded identity cannot be attributed to this session.',
        'Run the same command from the successor Codex session; nothing was registered.',
      );
    if (thread !== identity.session_id)
      return refuse(
        'caller_session_mismatch',
        `This command runs in Codex thread ${thread}, but the successor recorded by the launcher is ${identity.session_id}.`,
        'Run the command in the successor session the launcher recorded; nothing was registered.',
      );
  } else {
    if (options.callerPane === null)
      return refuse(
        'herdr_caller_unverified',
        'The caller pane is unknown, so the recorded identity cannot be attributed to this session.',
        'Run the same command in the successor pane with HERDR_PANE_ID set; nothing was registered.',
      );
    if (options.callerPane !== outcome.pane_id)
      return refuse(
        'caller_pane_mismatch',
        `The caller pane is ${options.callerPane}, but the successor was launched in ${outcome.pane_id}.`,
        'Run the command in the successor pane the launcher recorded; nothing was registered.',
      );
  }

  // 3. The handoff must already be the coordinator handoff that waits for this identity.
  const handoff = findHandoff(record, intent.handoff_id);
  if (handoff === null)
    return notReady(`handoff ${intent.handoff_id} is not recorded`);
  if (handoff.kind !== 'coordinator')
    return notReady(
      `handoff ${handoff.handoff_id} is a ${handoff.kind} handoff, not a coordinator handoff`,
    );
  if (handoff.state !== 'transferring')
    return notReady(
      `handoff ${handoff.handoff_id} is ${handoff.state}, not transferring`,
    );
  if (
    handoff.to === null ||
    handoff.to.agent_id !== identity.agent_id ||
    handoff.to.session_id !== identity.session_id
  )
    return notReady(
      `handoff ${handoff.handoff_id} has not been rebound to the recorded identity`,
    );
  const coordinator = record.coordinator ?? null;
  if (coordinator === null)
    return notReady('the task record names no current coordinator');
  // A confirmation is only accepted at the epoch it acts under, so an ack registered for a
  // stale handoff would be a message the coordinator can never confirm.
  if (handoff.owner_epoch !== coordinator.owner_epoch)
    return notReady(
      `handoff ${handoff.handoff_id} carries owner epoch ${String(handoff.owner_epoch)}, the current coordinator epoch is ${String(coordinator.owner_epoch)}`,
    );

  // 4. The briefing is digest-pinned. This check runs before any registration: an ack must never
  //    be produced for a checkpoint the successor did not actually receive.
  const checkpoint = readBoundedFile(intent.checkpoint.file, cap);
  if (!checkpoint.ok)
    return refuse(
      'checkpoint_unavailable',
      `The checkpoint is not a readable regular file within ${String(cap)} bytes (${checkpoint.code}).`,
      'Restore the briefing file the launcher pinned; nothing was registered.',
    );
  if (checkpoint.digest !== intent.checkpoint.digest)
    return refuse(
      'checkpoint_digest_mismatch',
      `The checkpoint digest ${checkpoint.digest} does not match the pinned ${intent.checkpoint.digest}.`,
      'Re-pin the checkpoint or restore its exact bytes; nothing was registered.',
    );

  // 5. One deterministic confirmation per request. Everything below depends only on the
  //    verified inputs, so a repeated run produces the same content.
  const message = buildMessage(
    {
      message_id: `handoff-ack-${requestId}`,
      type: 'HANDOFF',
      task_id: record.task_id,
      from: {
        agent_id: identity.agent_id,
        session_id: identity.session_id,
        harness: identity.harness,
      },
      to: {
        agent_id: coordinator.agent_id,
        session_id: coordinator.session_id,
        // An envelope requires a harness string; a legacy coordinator that recorded none keeps
        // its identity comparison on agent and session, which is what the confirm boundary
        // checks when the record has no harness.
        harness: coordinator.harness ?? 'unknown',
      },
      // A confirmation correlates through `body.handoff_id`; naming the handoff in `reply_to`
      // keeps the recorded intent ("an ack that replies to the handoff") visible as well.
      reply_to: handoff.handoff_id,
      // HANDOFF envelopes require a subtask id. A coordinator handoff has no writer subtask, so
      // the handoff it answers is carried in that slot; no non-request HANDOFF phase resolves a
      // subtask from it.
      subtask_id: handoff.subtask_id ?? `handoff:${handoff.handoff_id}`,
      owner_epoch: coordinator.owner_epoch,
      body: {
        handoff_id: handoff.handoff_id,
        phase: 'confirmation',
        successor_request: requestId,
      },
    },
    { clock },
  );
  const digest = contentDigest(message);

  // Counts only: the inventory rows stay in the task record and are never printed.
  const inventory = handoffInventory(record, {});
  const briefing = {
    checkpoint: {
      file: intent.checkpoint.file,
      digest: intent.checkpoint.digest,
      bytes: checkpoint.bytes.length,
      text: checkpoint.text,
    },
    handoff: {
      state: handoff.state,
      owner_epoch: coordinator.owner_epoch,
      counts: {
        inflight: inventory.inflight.length,
        closed: inventory.closed.length,
        pending_approvals: inventory.pending_approvals.length,
        uncertainty: inventory.uncertainty.length,
        resources: inventory.resources.length,
        results: inventory.results.length,
        handoffs: inventory.handoffs.length,
      },
    },
    next: NEXT_STEP,
  };

  const success = (
    status: string,
    duplicate: boolean,
    extra: Record<string, unknown> = {},
  ): TaskStoreResult<Record<string, unknown>> => ({
    ok: true,
    value: {
      schema: SUCCESSOR_ACK_RESULT_SCHEMA,
      ok: true,
      status,
      task_root: taskRoot,
      task_id: record.task_id,
      request_id: requestId,
      handoff_id: handoff.handoff_id,
      identity: {
        agent_id: identity.agent_id,
        session_id: identity.session_id,
        harness: identity.harness,
        cwd: identity.cwd,
      },
      message: {
        message_id: message.message_id,
        digest,
        duplicate,
      },
      briefing,
      ...extra,
      limits: LIMITS,
    },
  });

  // Read-only: does the exact confirmation already exist? `duplicate` reports this in a plan and
  // short-circuits an apply, so neither case registers a second message.
  const registered = await readRegisteredMessageSafe(
    opened.value,
    message.message_id,
  );
  const alreadyRegistered =
    registered.ok && contentDigest(registered.value.message) === digest;

  if (!options.apply) return success('planned', alreadyRegistered);

  const marker = readSuccessorAck(taskRoot, requestId);
  if (
    marker.ok &&
    marker.value.request_id === requestId &&
    marker.value.handoff_id === handoff.handoff_id &&
    marker.value.message_id === message.message_id &&
    marker.value.message_digest === digest &&
    alreadyRegistered
  )
    return success('already_acknowledged', true);

  const submitted = submitMessage(taskRoot, message, { clock });
  if (!submitted.ok)
    return refuse(
      'ack_registration_refused',
      `The acknowledgement message was refused (${submitted.reason}).`,
      'Inspect the handoff state and the message file; no ack marker was written.',
    );
  const duplicate =
    'duplicate' in submitted
      ? submitted.duplicate
      : submitted.registration.status === 'duplicate';

  // The marker is an aid for idempotence, not the acknowledgement itself: a registration that
  // succeeded is reported even when the marker cannot be written.
  const markerWrite = writeJsonExclusive(
    taskRoot,
    successorFile.ack(taskRoot, requestId),
    {
      schema: SUCCESSOR_ACK_SCHEMA,
      request_id: requestId,
      recorded_at: stamp(clock),
      message_id: message.message_id,
      message_digest: digest,
      handoff_id: handoff.handoff_id,
    },
  );
  if (markerWrite.status === 'created' || markerWrite.status === 'identical')
    return success('acknowledged', duplicate);
  return success('acknowledged', duplicate, {
    warning: {
      code: 'ack_marker_not_written',
      detail:
        markerWrite.status === 'conflict'
          ? 'a different ack marker already exists'
          : markerWrite.detail,
      message:
        'The acknowledgement is registered; the local ack marker could not be written.',
    },
  });
}
