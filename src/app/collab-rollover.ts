import path from 'node:path';
import {
  contentDigest,
  isSafeMessageId,
  validateEnvelope,
} from '../collab/envelope.js';
import { findHandoff } from '../collab/handoff.js';
import { findAttempt } from '../collab/lifecycle.js';
import * as rollover from '../collab/rollover.js';
import type {
  AppliedMessage,
  Identity,
  Message,
  RolloverIntent,
  TaskRecord,
} from '../collab/types.js';
import { isTaskRecord } from '../collab/validation.js';
import {
  handoffBundleRelativeRef,
  readHandoffBundle,
  verifyHandoffBundle,
} from '../continuity/index.js';
import type { HandoffBundle } from '../continuity/index.js';
import { resolveRealpath } from '../infra/fs.js';
import { isPathInside } from '../schemas/paths.js';
import { readBoundedFile } from './bounded-file.js';
import type { OpenedMessageTask } from './collab-messages.js';
import {
  routeExclusionFor,
  validateSuccession,
  type RouteExclusion,
  type RouteExclusionLookup,
} from './collab-route.js';
import { assertTaskStoreCurrent, openTaskStore } from './collab-task-store.js';

/**
 * Public read-only rollover inspection and planning.
 *
 * The entry reads the exact authoritative task record and the one exact linked continuity
 * handoff bundle, then reports the current rollover facts and the steps a later execution
 * would need. It never mutates the task, claims, bundle, binding, notification or delivery
 * files, and it exposes no apply path: a caller-supplied stop observation or producer label
 * is not authenticated native proof, so host stop/freeze evidence, native launch, native
 * session archive and routing removal are reported as unavailable.
 */

export const COLLAB_ROLLOVER_REQUEST_SCHEMA =
  'pappra/collaboration-rollover-request/1';
export const COLLAB_ROLLOVER_REPORT_SCHEMA =
  'pappra/collaboration-rollover-report/1';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_STRING = 2048;
const MAX_ID = 256;
const MAX_EVIDENCE_FILES = 2;
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const MAX_EVIDENCE_FILE_BYTES = 1024 * 1024;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export type RolloverAction = 'inspect' | 'plan';

export type RolloverStage =
  | 'unknown'
  | 'pre-transfer'
  | 'old-writer-stopped'
  | 'transferring'
  | 'receiver-confirmed'
  | 'completed'
  | 'aborted';

export interface RolloverIntentRequest {
  readonly intent_id: string;
  readonly generation: number;
  readonly handoff_id: string;
  readonly subtask_id: string;
  readonly attempt: number;
  readonly input_revision: string;
  readonly from: Identity;
  readonly to: Identity;
  readonly claims: readonly {
    readonly claim_id: string;
    readonly resource_epoch: number;
  }[];
  readonly coordinator_epoch: number;
}

export interface RolloverBundleRequest {
  readonly root: string;
  readonly continuity_task_id: string;
  readonly bundle_id: string;
  readonly digest: string;
}

export interface RolloverEvidenceRequest {
  readonly ack_message_id: string | null;
  readonly report_message_id: string | null;
}

export interface RolloverRequest {
  readonly schema: typeof COLLAB_ROLLOVER_REQUEST_SCHEMA;
  readonly action: RolloverAction;
  readonly task_root: string;
  readonly intent_id: string | null;
  readonly proposed_intent: RolloverIntentRequest | null;
  readonly bundle: RolloverBundleRequest;
  readonly evidence: RolloverEvidenceRequest;
}

export interface RolloverBlocker {
  readonly code: string;
  readonly detail: string;
}

export type RolloverStepStatus =
  'satisfied' | 'ready' | 'blocked' | 'unavailable';

export interface RolloverStepReport {
  readonly step:
    | 'create-intent'
    | 'prepare-transfer'
    | 'confirm-receiver'
    | 'complete-transfer'
    | 'record-first-work';
  readonly status: RolloverStepStatus;
  readonly requires: string;
  readonly blockers: readonly RolloverBlocker[];
}

export interface RolloverClaimsReport {
  readonly claim_id: string;
  readonly holder: Identity | null;
  readonly resource_epoch: number | null;
  readonly expected_resource_epoch: number;
  readonly expected_holder: Identity | null;
  readonly expected_epoch: number | null;
  readonly released_at: string | null;
}

export interface RolloverNativeReport {
  readonly observation: string | null;
  readonly session_id: string | null;
  readonly run_id: string | null;
  readonly runner: string | null;
  readonly matches_expected: boolean | null;
}

export interface RolloverSnapshotClaim {
  readonly claim_id: string;
  readonly resource: string;
  readonly resource_epoch: number;
  readonly holder: string | null;
}

export interface RolloverEvidenceCorrelation {
  readonly message_id: string;
  readonly role: 'ack' | 'report';
  readonly type: string;
  readonly digest: string;
  readonly sender: Identity;
  readonly recipient: Identity | null;
  readonly task_id: string;
  readonly subtask_id: string | null;
  readonly attempt: number | null;
  readonly input_revision: string | null;
  readonly intent_id: string | null;
  readonly generation: number | null;
  readonly owner_epoch: number | null;
  readonly ledger_index: number;
  readonly proof_order_ok: boolean | null;
  readonly applies_to_intent: boolean;
  readonly issues: readonly string[];
}

export interface RolloverReport {
  readonly schema: typeof COLLAB_ROLLOVER_REPORT_SCHEMA;
  readonly action: RolloverAction;
  readonly ok: true;
  readonly task_root: string;
  readonly task_id: string;
  readonly state_revision: number;
  readonly owner_epoch: number | null;
  readonly stage: RolloverStage;
  readonly intent: {
    readonly found: boolean;
    readonly intent_id: string | null;
    readonly generation: number | null;
    readonly handoff_id: string | null;
    readonly subtask_id: string | null;
    readonly attempt: number | null;
    readonly input_revision: string | null;
    readonly from: Identity | null;
    readonly to: Identity | null;
    readonly source_native: rollover.RolloverNativeIdentity | null;
    readonly bundle: rollover.RolloverBundleReference | null;
    readonly transfer_boundary: rollover.RolloverTransferBoundary | null;
    readonly successor_native: rollover.RolloverNativeIdentity | null;
  };
  readonly handoff: {
    readonly state: string | null;
    readonly from: Identity | null;
    readonly to: Identity | null;
    readonly owner_epoch: number | null;
  };
  readonly prepared: {
    readonly recorded: boolean;
    readonly evidence_ref: string | null;
    readonly inventory: string | null;
    readonly at: string | null;
  };
  readonly attempt: {
    readonly state: string | null;
    readonly assignee: Identity | null;
    readonly input_revision: string | null;
    readonly latest_attempt: number | null;
    readonly native: RolloverNativeReport | null;
    readonly expected: {
      readonly assignee: Identity | null;
      readonly input_revision: string | null;
      readonly native: {
        readonly session_id: string | null;
        readonly run_id: string | null;
        readonly runner: string | null;
      } | null;
    } | null;
  } | null;
  readonly claims: readonly RolloverClaimsReport[];
  readonly succession: {
    readonly recorded: boolean;
    readonly valid: boolean;
    readonly issue: string | null;
    readonly intent_id: string | null;
    readonly handoff_id: string | null;
    readonly generation: number | null;
    readonly archived_at: string | null;
    readonly proof_message_id: string | null;
    readonly proof_digest: string | null;
    readonly routing: 'pending';
    readonly native_archive: 'unavailable';
  };
  readonly bundle: {
    readonly ref: string;
    readonly continuity_task_id: string;
    readonly digest: string;
    readonly digest_matches: true;
    readonly pinned: boolean;
    readonly verified: true;
    readonly context_integrity: 'complete' | 'incomplete' | 'unknown';
    readonly checkpoint_present: true;
    readonly workspace_identity_matches: true;
    readonly execution_allowed: false;
    readonly source_session: {
      readonly harness: string;
      readonly session_id: string;
      readonly agent_id: string | null;
      readonly matches_plan: boolean;
    };
    readonly collaboration: {
      readonly task_id: string;
      readonly subtask_id: string | null;
      readonly attempt: number;
      readonly owner_epoch: number;
      readonly input_revision: string | null;
      readonly association: string | null;
      readonly matches_plan: boolean;
    };
    readonly handoff_snapshot: {
      readonly claims: readonly RolloverSnapshotClaim[];
      readonly claims_completeness: string;
      readonly claims_match: boolean;
      readonly inventory_complete: boolean;
      readonly pending: readonly {
        readonly kind: string;
        readonly items: number;
        readonly completeness: string;
      }[];
    };
  };
  readonly drift: readonly RolloverBlocker[];
  readonly steps: readonly RolloverStepReport[];
  readonly blockers: readonly RolloverBlocker[];
  readonly notify_exclusion: {
    readonly sender: RouteExclusionLookup;
    readonly recipient: RouteExclusionLookup;
    readonly exclusions: readonly RouteExclusion[];
    readonly effective: 'excluded' | 'active' | 'unknown';
  };
  readonly capabilities: {
    readonly record_reducer: 'available';
    readonly bundle_verification: 'available';
    readonly notify_exclusion: 'available';
    readonly host_stop_proof: 'unavailable';
    readonly native_launch: 'unavailable';
    readonly native_session_archive: 'unavailable';
    readonly routing_removal: 'pending';
  };
  readonly evidence: {
    readonly requested: readonly string[];
    readonly supplied: number;
    readonly raw_bytes: number;
    readonly over_budget: boolean;
    readonly unreadable: readonly {
      readonly message_id: string;
      readonly code: string;
    }[];
    readonly issues: readonly RolloverBlocker[];
    readonly correlations: readonly RolloverEvidenceCorrelation[];
  };
  readonly plan_complete: boolean;
  readonly limits: readonly string[];
}

export interface RolloverFailure {
  readonly ok: false;
  readonly kind: 'invalid' | 'needs_input';
  readonly code: string;
  readonly message: string;
  readonly nextAction: string | null;
}

export type RolloverRequestResult =
  { readonly ok: true; readonly value: RolloverRequest } | RolloverFailure;

export type RolloverResult =
  { readonly ok: true; readonly value: RolloverReport } | RolloverFailure;

const failure = (
  kind: 'invalid' | 'needs_input',
  code: string,
  message: string,
  nextAction: string | null,
): RolloverFailure => ({ ok: false, kind, code, message, nextAction });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value: unknown, max = MAX_STRING): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !value.includes('\u0000');

const isCount = (value: unknown, minimum = 0): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;

const isIdentity = (value: unknown): value is Identity =>
  isRecord(value) &&
  isText(value['agent_id'], MAX_ID) &&
  isText(value['session_id'], MAX_ID);

const sameIdentity = (
  left: { agent_id?: string | null; session_id?: string | null } | null,
  right: { agent_id: string; session_id: string },
): boolean =>
  left !== null &&
  left.agent_id === right.agent_id &&
  left.session_id === right.session_id;

const invalidRequest = (message: string): RolloverFailure =>
  failure('invalid', 'request_invalid', message, null);

type ProposedIntentResult =
  | { readonly ok: true; readonly value: RolloverIntentRequest }
  | RolloverFailure;

function readIntent(value: unknown): ProposedIntentResult {
  if (!isRecord(value))
    return invalidRequest('proposed_intent must be an object');
  const intentId = value['intent_id'];
  const generation = value['generation'];
  const handoffId = value['handoff_id'];
  const subtaskId = value['subtask_id'];
  const attempt = value['attempt'];
  const inputRevision = value['input_revision'];
  const from = value['from'];
  const to = value['to'];
  const coordinatorEpoch = value['coordinator_epoch'];
  if (
    !isText(intentId, MAX_ID) ||
    !isCount(generation, 1) ||
    !isText(handoffId, MAX_ID) ||
    !isText(subtaskId, MAX_ID) ||
    !isCount(attempt, 1) ||
    !isText(inputRevision) ||
    !isIdentity(from) ||
    !isIdentity(to) ||
    !isCount(coordinatorEpoch, 1)
  )
    return invalidRequest(
      'proposed_intent needs intent, handoff, subtask, attempt, input revision, identities and a positive coordinator epoch',
    );
  const claimsRaw = value['claims'];
  if (!Array.isArray(claimsRaw))
    return invalidRequest('proposed_intent.claims must be an array');
  if (claimsRaw.length > 64)
    return invalidRequest('proposed_intent.claims exceeds the claim limit');
  const claims: { claim_id: string; resource_epoch: number }[] = [];
  for (const claim of claimsRaw) {
    if (!isRecord(claim))
      return invalidRequest('each claim reference must be an object');
    const claimId = claim['claim_id'];
    const resourceEpoch = claim['resource_epoch'];
    if (!isText(claimId, MAX_ID) || !isCount(resourceEpoch, 1))
      return invalidRequest(
        'each claim reference needs an id and a positive epoch',
      );
    claims.push({ claim_id: claimId, resource_epoch: resourceEpoch });
  }
  return {
    ok: true,
    value: {
      intent_id: intentId,
      generation,
      handoff_id: handoffId,
      subtask_id: subtaskId,
      attempt,
      input_revision: inputRevision,
      from,
      to,
      claims,
      coordinator_epoch: coordinatorEpoch,
    },
  };
}

/**
 * Validates one request value. The CLI loader and the public app entry both call this, so a
 * direct caller cannot skip the documented shape by constructing an object in memory.
 */
export function validateRolloverRequest(
  parsed: unknown,
): RolloverRequestResult {
  if (!isRecord(parsed)) return invalidRequest('request must be an object');
  if (parsed['schema'] !== COLLAB_ROLLOVER_REQUEST_SCHEMA)
    return failure(
      'invalid',
      'request_schema_invalid',
      `request.schema must be ${COLLAB_ROLLOVER_REQUEST_SCHEMA}`,
      'Use the documented request schema.',
    );
  const action = parsed['action'];
  if (action !== 'inspect' && action !== 'plan')
    return failure(
      'invalid',
      'request_action_invalid',
      'action must be inspect or plan',
      'This entry never applies a rollover.',
    );
  const taskRoot = parsed['task_root'];
  if (!isText(taskRoot)) return invalidRequest('task_root is required');
  if (!path.isAbsolute(taskRoot))
    return failure(
      'invalid',
      'request_invalid',
      'task_root must be absolute',
      'Pass the absolute task root that contains task.json.',
    );
  const bundleRaw = parsed['bundle'];
  if (!isRecord(bundleRaw)) return invalidRequest('bundle is required');
  const bundleRoot = bundleRaw['root'];
  const continuityTaskId = bundleRaw['continuity_task_id'];
  const bundleId = bundleRaw['bundle_id'];
  const bundleDigest = bundleRaw['digest'];
  if (
    !isText(bundleRoot) ||
    !path.isAbsolute(bundleRoot) ||
    !isText(continuityTaskId, MAX_ID) ||
    !isText(bundleId, MAX_ID) ||
    typeof bundleDigest !== 'string' ||
    !DIGEST.test(bundleDigest)
  )
    return invalidRequest(
      'bundle needs an absolute root, continuity_task_id, bundle_id and sha256 digest',
    );
  const intentIdRaw = parsed['intent_id'];
  if (
    intentIdRaw !== undefined &&
    intentIdRaw !== null &&
    !isText(intentIdRaw, MAX_ID)
  )
    return invalidRequest('intent_id is invalid');
  const intentId = isText(intentIdRaw, MAX_ID) ? intentIdRaw : null;
  const proposedRaw = parsed['proposed_intent'];
  let proposed: RolloverIntentRequest | null = null;
  if (proposedRaw !== undefined && proposedRaw !== null) {
    const readProposed = readIntent(proposedRaw);
    if (readProposed.ok === false) return readProposed;
    proposed = readProposed.value;
  }
  if (action === 'inspect' && intentId === null)
    return failure(
      'invalid',
      'request_invalid',
      'inspect requires intent_id',
      'Pass the recorded intent id to inspect.',
    );
  if (action === 'plan' && proposed === null && intentId === null)
    return failure(
      'invalid',
      'request_invalid',
      'plan requires intent_id or proposed_intent',
      'Describe the intended rollover.',
    );
  const evidenceRaw = parsed['evidence'];
  if (
    evidenceRaw !== undefined &&
    evidenceRaw !== null &&
    !isRecord(evidenceRaw)
  )
    return invalidRequest('evidence must be an object');
  const ackRaw = isRecord(evidenceRaw) ? evidenceRaw['ack_message_id'] : null;
  const reportRaw = isRecord(evidenceRaw)
    ? evidenceRaw['report_message_id']
    : null;
  for (const [key, value] of [
    ['ack_message_id', ackRaw],
    ['report_message_id', reportRaw],
  ] as const) {
    if (value !== undefined && value !== null && !isText(value, MAX_ID))
      return invalidRequest(`${key} is invalid`);
  }
  return {
    ok: true,
    value: {
      schema: COLLAB_ROLLOVER_REQUEST_SCHEMA,
      action,
      task_root: taskRoot,
      intent_id: intentId,
      proposed_intent: proposed,
      bundle: {
        root: bundleRoot,
        continuity_task_id: continuityTaskId,
        bundle_id: bundleId,
        digest: bundleDigest,
      },
      evidence: {
        ack_message_id: isText(ackRaw, MAX_ID) ? ackRaw : null,
        report_message_id: isText(reportRaw, MAX_ID) ? reportRaw : null,
      },
    },
  };
}

/** Loads one bounded request document; unsafe or oversized input is invalid, never read. */
export function loadRolloverRequest(file: string): RolloverRequestResult {
  const read = readBoundedFile(file, MAX_REQUEST_BYTES);
  if (!read.ok)
    return failure(
      'invalid',
      'request_unreadable',
      `The rollover request could not be read as a bounded regular file (${read.code}).`,
      'Pass an absolute path to a regular JSON request file.',
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text) as unknown;
  } catch {
    return failure(
      'invalid',
      'request_invalid_json',
      'The rollover request is not valid JSON.',
      'Fix the request document syntax.',
    );
  }
  return validateRolloverRequest(parsed);
}

interface LoadedEvidence {
  readonly messages: Message[];
  readonly entries: Map<string, AppliedMessage>;
  readonly indices: Map<string, number>;
  readonly rawBytes: number;
  readonly unreadable: { message_id: string; code: string }[];
  readonly overBudget: boolean;
}

/**
 * Bounded evidence loading for the requested ids only.
 *
 * There is no helper pre-read: the id is validated, the path is contained in the opened
 * task namespace, and the file's parent is re-proved by realpath before `readBoundedFile`
 * opens it descriptor-safely (nonblocking, no-follow, regular-file, size-capped). Actual raw
 * bytes are charged immediately after a successful read, before JSON or envelope refusal, so
 * a corrupt or padded file can never be inspected for free.
 */
async function loadEvidence(
  task: OpenedMessageTask,
  ids: readonly string[],
): Promise<LoadedEvidence> {
  const messages: Message[] = [];
  const entries = new Map<string, AppliedMessage>();
  const indices = new Map<string, number>();
  const unreadable: { message_id: string; code: string }[] = [];
  const ledger = task.record.messages ?? [];
  const byId = new Map(ledger.map((entry, index) => [entry.message_id, index]));
  let rawBytes = 0;
  let overBudget = false;
  for (const messageId of ids) {
    if (!isSafeMessageId(messageId)) {
      unreadable.push({ message_id: messageId, code: 'message_id_invalid' });
      continue;
    }
    const file = path.join(task.messagesDirectory, `${messageId}.json`);
    if (!isPathInside(task.messagesDirectory, file)) {
      unreadable.push({ message_id: messageId, code: 'message_id_invalid' });
      continue;
    }
    const index = byId.get(messageId);
    if (index === undefined) {
      unreadable.push({
        message_id: messageId,
        code: 'message_not_registered',
      });
      continue;
    }
    const resolvedDirectory = await resolveRealpath(path.dirname(file)).catch(
      () => null,
    );
    if (
      resolvedDirectory === null ||
      resolvedDirectory !== task.messagesDirectory
    ) {
      unreadable.push({
        message_id: messageId,
        code: 'message_registration_invalid',
      });
      continue;
    }
    const remaining = Math.min(
      MAX_EVIDENCE_FILE_BYTES,
      MAX_EVIDENCE_BYTES - rawBytes,
    );
    if (remaining <= 0) {
      overBudget = true;
      break;
    }
    const read = readBoundedFile(file, remaining);
    if (read.ok === false) {
      if (read.code === 'too_large') {
        overBudget = true;
        break;
      }
      unreadable.push({ message_id: messageId, code: read.code });
      continue;
    }
    // The bytes are consumed before any later refusal, including rejected content.
    rawBytes += read.bytes.length;
    let payload: unknown;
    try {
      payload = JSON.parse(read.text) as unknown;
    } catch {
      unreadable.push({ message_id: messageId, code: 'message_corrupt' });
      continue;
    }
    let message: Message;
    try {
      message = validateEnvelope(payload);
    } catch {
      unreadable.push({ message_id: messageId, code: 'message_invalid' });
      continue;
    }
    if (message.message_id !== messageId) {
      unreadable.push({
        message_id: messageId,
        code: 'message_identity_mismatch',
      });
      continue;
    }
    const entry = ledger[index]!;
    if (entry.state !== 'applied') {
      unreadable.push({ message_id: messageId, code: 'message_not_applied' });
      continue;
    }
    if (entry.content_digest !== contentDigest(message)) {
      unreadable.push({ message_id: messageId, code: 'content_mismatch' });
      continue;
    }
    messages.push(message);
    entries.set(messageId, entry);
    indices.set(messageId, index);
  }
  return { messages, entries, indices, rawBytes, unreadable, overBudget };
}

interface PlanIntent {
  readonly intent_id: string;
  readonly generation: number;
  readonly handoff_id: string;
  readonly subtask_id: string;
  readonly attempt: number;
  readonly input_revision: string;
  readonly from: Identity;
  readonly to: Identity;
  readonly claims: readonly rollover.RolloverClaimReference[];
  readonly coordinator_epoch: number;
}

const planIntentOf = (input: RolloverIntentRequest): PlanIntent => ({
  intent_id: input.intent_id,
  generation: input.generation,
  handoff_id: input.handoff_id,
  subtask_id: input.subtask_id,
  attempt: input.attempt,
  input_revision: input.input_revision,
  from: input.from,
  to: input.to,
  claims: input.claims,
  coordinator_epoch: input.coordinator_epoch,
});

const intentOf = (intent: RolloverIntent): PlanIntent => ({
  intent_id: intent.intent_id,
  generation: intent.generation,
  handoff_id: intent.handoff_id,
  subtask_id: intent.subtask_id,
  attempt: intent.attempt,
  input_revision: intent.input_revision,
  from: intent.from,
  to: intent.to,
  claims: intent.claims,
  coordinator_epoch: intent.coordinator_epoch,
});

const STAGE_BY_HANDOFF: Record<string, RolloverStage> = {
  requested: 'pre-transfer',
  old_writer_stopped: 'old-writer-stopped',
  transferring: 'transferring',
  receiver_confirmed: 'receiver-confirmed',
  completed: 'completed',
  aborted: 'aborted',
};

const STAGE_OF = (state: string | null): RolloverStage =>
  state === null ? 'unknown' : (STAGE_BY_HANDOFF[state] ?? 'unknown');

const PREPARED_STAGES: readonly RolloverStage[] = [
  'old-writer-stopped',
  'transferring',
  'receiver-confirmed',
  'completed',
];

const CONFIRMED_STAGES: readonly RolloverStage[] = [
  'receiver-confirmed',
  'completed',
];

const isComplete = (value: string): boolean => value === 'complete';

/**
 * Compares the verified bundle against the record and the plan. Bundle context is evidence
 * about a workspace snapshot; it never grants authority to apply anything.
 */
function bundleAssociation(options: {
  readonly bundle: HandoffBundle;
  readonly record: TaskRecord;
  readonly plan: PlanIntent;
  readonly pinnedSource: rollover.RolloverNativeIdentity | null;
}) {
  const collaboration = options.bundle.collaboration;
  const sourceSession = options.bundle.sourceNativeSession;
  const sourceAgent =
    options.pinnedSource?.agent_id ?? options.plan.from.agent_id;
  const sourceSessionId =
    options.pinnedSource?.session_id ?? options.plan.from.session_id;
  const sourceHarness = options.plan.from.harness;
  const sessionMatches =
    sourceSession.sessionId === sourceSessionId &&
    sourceSession.agentId === sourceAgent &&
    (sourceHarness === undefined || sourceSession.harness === sourceHarness);
  const collaborationMatches =
    collaboration.taskId === options.record.task_id &&
    collaboration.subtaskId === options.plan.subtask_id &&
    collaboration.attempt === options.plan.attempt &&
    collaboration.ownerEpoch === options.plan.coordinator_epoch &&
    collaboration.inputRevision === options.plan.input_revision;
  const snapshot = options.bundle.handoff;
  const claimMismatches: string[] = [];
  for (const reference of options.plan.claims) {
    const snapshotClaim = snapshot.claims.find(
      (claim) => claim.claimId === reference.claim_id,
    );
    if (snapshotClaim === undefined) {
      if (isComplete(snapshot.claimsCompleteness))
        claimMismatches.push(
          `claim ${reference.claim_id} missing from snapshot`,
        );
      continue;
    }
    if (snapshotClaim.resourceEpoch !== reference.resource_epoch)
      claimMismatches.push(`claim ${reference.claim_id} epoch differs`);
    if (snapshotClaim.holder !== options.plan.from.agent_id)
      claimMismatches.push(`claim ${reference.claim_id} holder differs`);
  }
  const pending = [
    {
      kind: 'pending_tools',
      items: snapshot.pendingTools.items.length,
      completeness: snapshot.pendingTools.completeness,
    },
    {
      kind: 'pending_messages',
      items: snapshot.pendingMessages.items.length,
      completeness: snapshot.pendingMessages.completeness,
    },
    {
      kind: 'pending_approvals',
      items: snapshot.pendingApprovals.items.length,
      completeness: snapshot.pendingApprovals.completeness,
    },
  ];
  return {
    source_session: {
      harness: sourceSession.harness,
      session_id: sourceSession.sessionId,
      agent_id: sourceSession.agentId,
      matches_plan: sessionMatches,
    },
    collaboration: {
      task_id: collaboration.taskId,
      subtask_id: collaboration.subtaskId,
      attempt: collaboration.attempt,
      owner_epoch: collaboration.ownerEpoch,
      input_revision: collaboration.inputRevision,
      association: collaboration.association,
      matches_plan: collaborationMatches,
    },
    handoff_snapshot: {
      claims: snapshot.claims.map((claim) => ({
        claim_id: claim.claimId,
        resource: claim.resource,
        resource_epoch: claim.resourceEpoch,
        holder: claim.holder,
      })),
      claims_completeness: snapshot.claimsCompleteness,
      claims_match: claimMismatches.length === 0,
      inventory_complete:
        isComplete(snapshot.claimsCompleteness) &&
        pending.every(
          (entry) => isComplete(entry.completeness) && entry.items === 0,
        ),
      pending,
    },
    claimMismatches,
  };
}

const STOP_PROOF_BLOCKER: RolloverBlocker = {
  code: 'host_stop_proof_unavailable',
  detail:
    'No accepted host adapter produces authenticated quiescence evidence; caller JSON is never accepted as stop proof.',
};

const predecessorBlocked = (detail: string): RolloverBlocker => ({
  code: 'predecessor_step_unavailable',
  detail,
});

/** Stable de-duplication: one blocker code is reported once, in first-seen order. */
const dedupeBlockers = (
  blockers: readonly RolloverBlocker[],
): RolloverBlocker[] => {
  const seen = new Set<string>();
  const unique: RolloverBlocker[] = [];
  for (const blocker of blockers) {
    if (seen.has(blocker.code)) continue;
    seen.add(blocker.code);
    unique.push(blocker);
  }
  return unique;
};

function buildSteps(options: {
  readonly intentFound: boolean;
  readonly createBlockers: readonly RolloverBlocker[];
  readonly stage: RolloverStage;
  readonly prepared: boolean;
  readonly successionValid: boolean;
  readonly successionIssue: string | null;
}): RolloverStepReport[] {
  const aborted = options.stage === 'aborted';
  const prepareSatisfied =
    options.prepared || PREPARED_STAGES.includes(options.stage);
  const confirmSatisfied = CONFIRMED_STAGES.includes(options.stage);
  const completeSatisfied = options.stage === 'completed';
  const abortBlocker: RolloverBlocker[] = aborted
    ? [
        {
          code: 'handoff_aborted',
          detail:
            'The recorded handoff is aborted; an aborted handoff never executes.',
        },
      ]
    : [];
  return [
    {
      step: 'create-intent',
      status: options.intentFound
        ? 'satisfied'
        : options.createBlockers.length > 0
          ? 'blocked'
          : 'ready',
      requires:
        'validated intent inputs, current coordinator epoch, latest active source attempt and source-held claims',
      blockers: options.intentFound ? [] : options.createBlockers,
    },
    {
      step: 'prepare-transfer',
      status: aborted
        ? 'blocked'
        : prepareSatisfied
          ? 'satisfied'
          : 'unavailable',
      requires:
        'authenticated host stop/freeze evidence plus a complete quiescence inventory',
      blockers: aborted
        ? abortBlocker
        : prepareSatisfied
          ? []
          : [STOP_PROOF_BLOCKER],
    },
    {
      step: 'confirm-receiver',
      status: aborted
        ? 'blocked'
        : confirmSatisfied
          ? 'satisfied'
          : prepareSatisfied
            ? 'ready'
            : 'blocked',
      requires:
        'registered successor ACK correlated to the handoff, generation, epoch and pinned input',
      blockers: aborted
        ? abortBlocker
        : confirmSatisfied || prepareSatisfied
          ? []
          : [
              predecessorBlocked(
                'The receiver cannot be confirmed before transfer preparation, which requires host stop evidence.',
              ),
            ],
    },
    {
      step: 'complete-transfer',
      status: aborted
        ? 'blocked'
        : completeSatisfied
          ? 'satisfied'
          : confirmSatisfied
            ? 'ready'
            : 'blocked',
      requires:
        'receiver confirmation, exact claim epochs and an observed successor native identity',
      blockers: aborted
        ? abortBlocker
        : completeSatisfied || confirmSatisfied
          ? []
          : [
              predecessorBlocked(
                'Ownership cannot transfer before the receiver confirms the handoff.',
              ),
            ],
    },
    {
      step: 'record-first-work',
      status: aborted
        ? 'blocked'
        : options.successionValid
          ? 'satisfied'
          : completeSatisfied
            ? 'ready'
            : 'blocked',
      requires:
        'validated succession: stored successor REPORT applied after the recorded transfer boundary and admitted as a completed result',
      blockers: aborted
        ? abortBlocker
        : options.successionValid
          ? []
          : options.successionIssue !== null
            ? [
                {
                  code: 'succession_invalid',
                  detail: options.successionIssue,
                },
              ]
            : completeSatisfied
              ? []
              : [
                  predecessorBlocked(
                    'First successor work cannot be proven before ownership transfers.',
                  ),
                ],
    },
  ];
}

interface CorrelationResult {
  readonly correlation: RolloverEvidenceCorrelation;
  readonly issues: RolloverBlocker[];
}

function correlateEvidence(options: {
  readonly role: 'ack' | 'report';
  readonly message: Message;
  readonly entry: AppliedMessage;
  readonly index: number;
  readonly plan: PlanIntent;
  readonly record: TaskRecord;
  readonly boundary: rollover.RolloverTransferBoundary | null;
}): CorrelationResult {
  const { message, entry, index, plan, role } = options;
  const issues: string[] = [];
  const coordinator = options.record.coordinator ?? null;
  const expectedType = role === 'ack' ? 'ACK' : 'REPORT';
  const expectedIntentId = role === 'ack' ? plan.intent_id : null;
  const inputRevision =
    typeof message.body.input_revision === 'string'
      ? message.body.input_revision
      : null;
  const intentId =
    typeof message.body.rollover_intent_id === 'string'
      ? message.body.rollover_intent_id
      : null;
  const generation =
    typeof message.body.rollover_generation === 'number'
      ? message.body.rollover_generation
      : null;
  if (message.task_id !== options.record.task_id)
    issues.push('evidence_task_mismatch');
  if (message.type !== expectedType) issues.push('evidence_type_mismatch');
  if (!sameIdentity(message.from, plan.to))
    issues.push('evidence_sender_mismatch');
  if (coordinator === null || !sameIdentity(message.to, coordinator))
    issues.push('evidence_recipient_mismatch');
  if (
    message.subtask_id !== plan.subtask_id ||
    message.attempt !== plan.attempt
  )
    issues.push('evidence_attempt_mismatch');
  if (message.body.handoff_id !== plan.handoff_id)
    issues.push('evidence_handoff_mismatch');
  if (generation !== plan.generation)
    issues.push('evidence_generation_mismatch');
  if (inputRevision !== plan.input_revision)
    issues.push('evidence_input_mismatch');
  if (role === 'ack') {
    if (intentId !== expectedIntentId) issues.push('evidence_intent_mismatch');
    if (message.owner_epoch !== plan.coordinator_epoch)
      issues.push('evidence_epoch_mismatch');
  } else if (
    message.owner_epoch !== null &&
    message.owner_epoch !== undefined
  ) {
    if (message.owner_epoch !== plan.coordinator_epoch)
      issues.push('evidence_epoch_mismatch');
  }
  const proofOrderOk =
    role === 'report'
      ? options.boundary === null
        ? null
        : index >= options.boundary.message_count
      : null;
  if (proofOrderOk === false) issues.push('evidence_pre_transfer');
  if (role === 'report') {
    const result = (options.record.results ?? []).find(
      (item) => item.message_id === message.message_id,
    );
    if (result === undefined) issues.push('evidence_result_missing');
    else if (
      result.status !== 'completed' ||
      result.classification !== 'applied'
    )
      issues.push('evidence_result_not_admitted');
    else if (
      result.subtask_id !== plan.subtask_id ||
      result.attempt !== plan.attempt ||
      result.input_revision !== plan.input_revision
    )
      issues.push('evidence_result_mismatch');
    else if (message.body.status !== result.status)
      issues.push('evidence_result_status_mismatch');
  }
  if (
    entry.from.agent_id !== message.from.agent_id ||
    entry.from.session_id !== message.from.session_id
  )
    issues.push('evidence_ledger_sender_mismatch');
  if (
    entry.to !== null &&
    (entry.to.agent_id !== message.to.agent_id ||
      entry.to.session_id !== message.to.session_id)
  )
    issues.push('evidence_ledger_recipient_mismatch');
  if (
    entry.subtask_id !== message.subtask_id ||
    entry.attempt !== message.attempt
  )
    issues.push('evidence_ledger_attempt_mismatch');
  return {
    correlation: {
      message_id: message.message_id,
      role,
      type: message.type,
      digest: contentDigest(message),
      sender: message.from,
      recipient: message.to,
      task_id: message.task_id,
      subtask_id: message.subtask_id,
      attempt: message.attempt,
      input_revision: inputRevision,
      intent_id: intentId,
      generation,
      owner_epoch: message.owner_epoch,
      ledger_index: index,
      proof_order_ok: proofOrderOk,
      applies_to_intent: issues.length === 0,
      issues,
    },
    issues: issues.map((code) => ({
      code,
      detail: `Requested ${role} evidence ${message.message_id} does not satisfy this correlation.`,
    })),
  };
}

export async function inspectOrPlanRollover(
  input: unknown,
): Promise<RolloverResult> {
  const validated = validateRolloverRequest(input);
  if (validated.ok === false) return validated;
  const request = validated.value;

  const opened = await openTaskStore(request.task_root);
  if (opened.ok === false) {
    const invalid =
      opened.code === 'task_root_required' ||
      opened.code === 'task_root_layout_invalid';
    return failure(
      invalid ? 'invalid' : 'needs_input',
      opened.code,
      opened.message,
      opened.nextAction,
    );
  }
  const task = opened.value;
  const record = task.record;
  if (!isTaskRecord(record))
    return failure(
      'needs_input',
      'record_invalid',
      'The task record does not satisfy the authoritative record shape.',
      'Inspect and repair the task record before planning.',
    );

  const recordedIntent =
    request.intent_id === null
      ? null
      : ((record.rollover ?? []).find(
          (item) => item.intent_id === request.intent_id,
        ) ?? null);
  if (
    request.action === 'inspect' &&
    request.intent_id !== null &&
    recordedIntent === null
  )
    return failure(
      'needs_input',
      'unknown_intent',
      `No recorded rollover intent ${request.intent_id} in this task.`,
      'Inspect the record or pass an existing intent id.',
    );

  const proposed = request.proposed_intent;
  const plan =
    recordedIntent !== null
      ? intentOf(recordedIntent)
      : proposed !== null
        ? planIntentOf(proposed)
        : null;
  if (plan === null)
    return failure(
      'needs_input',
      'unknown_intent',
      `No recorded rollover intent ${String(request.intent_id)} in this task.`,
      'Pass an existing intent id or a proposed intent.',
    );

  // The canonical bundle reference convention is one documented form: the continuity task
  // namespace plus `handoff-bundles/<bundleId>.json`. A recorded intent's pin is immutable.
  const canonicalRef = handoffBundleRelativeRef(request.bundle.bundle_id);
  if (recordedIntent !== null) {
    const pinned = recordedIntent.bundle;
    if (pinned.digest !== request.bundle.digest || pinned.ref !== canonicalRef)
      return failure(
        'needs_input',
        'bundle_pin_mismatch',
        `The recorded intent pins ${pinned.ref} (${pinned.digest}); the request names ${canonicalRef} (${request.bundle.digest}).`,
        'Reference the exact bundle recorded at intent creation; a different valid bundle is not a substitute.',
      );
  }

  const bundleRead = await readHandoffBundle({
    root: request.bundle.root,
    continuityTaskId: request.bundle.continuity_task_id,
    bundleId: request.bundle.bundle_id,
  });
  if (bundleRead.ok === false)
    return failure(
      'needs_input',
      'bundle_unreadable',
      bundleRead.message,
      bundleRead.nextAction,
    );
  if (bundleRead.value.digest !== request.bundle.digest)
    return failure(
      'needs_input',
      'bundle_digest_mismatch',
      `The stored bundle digest is ${bundleRead.value.digest}; the request pins ${request.bundle.digest}.`,
      'Re-pin the exact linked bundle digest.',
    );
  const verified = await verifyHandoffBundle({
    root: request.bundle.root,
    bundle: bundleRead.value.bundle,
  });
  if (verified.ok === false)
    return failure(
      'needs_input',
      'bundle_unverified',
      verified.message,
      verified.nextAction,
    );

  const handoff = findHandoff(record, plan.handoff_id);
  const attempt = findAttempt(record, plan.subtask_id, plan.attempt);
  const currentEpoch = record.coordinator?.owner_epoch ?? null;
  const pinnedSource = recordedIntent?.source_native ?? null;
  const stage = STAGE_OF(handoff?.state ?? null);
  const postTransfer = stage === 'completed';
  const successorNative = recordedIntent?.successor_native ?? null;
  const boundary = recordedIntent?.transfer_boundary ?? null;
  const drift: RolloverBlocker[] = [];

  if (currentEpoch !== plan.coordinator_epoch)
    drift.push({
      code: 'stale_epoch',
      detail: `The plan pins coordinator epoch ${plan.coordinator_epoch}; the current epoch is ${String(currentEpoch)}.`,
    });
  if (handoff === null)
    drift.push({
      code: 'unknown_handoff',
      detail: 'The planned handoff is not recorded in this task.',
    });
  if (postTransfer && boundary === null)
    drift.push({
      code: 'transfer_boundary_missing',
      detail:
        'The handoff is completed but the intent records no transfer boundary; post-transfer facts cannot be correlated.',
    });
  if (attempt === null)
    drift.push({
      code: 'unknown_attempt',
      detail: 'The planned attempt is not recorded in this task.',
    });
  else {
    const latest = (record.attempts ?? [])
      .filter((item) => item.subtask_id === plan.subtask_id)
      .reduce((max, item) => Math.max(max, item.attempt), 0);
    if (latest !== plan.attempt && !postTransfer)
      drift.push({
        code: 'attempt_superseded',
        detail: `The latest attempt is ${latest}; the plan pins ${plan.attempt}.`,
      });
    const expectedAssignee = postTransfer ? plan.to : plan.from;
    if (!sameIdentity(attempt.assignee, expectedAssignee))
      drift.push({
        code: 'assignee_mismatch',
        detail: postTransfer
          ? 'The completed transfer did not reassign the attempt to the successor identity.'
          : 'The recorded assignee is not the planned source identity.',
      });
    if (attempt.input_revision !== plan.input_revision)
      drift.push({
        code: 'input_changed',
        detail: `The attempt is pinned to ${String(attempt.input_revision)}; the plan to ${plan.input_revision}.`,
      });
    if (attempt.awaiting !== undefined && !postTransfer)
      drift.push({
        code: 'writer_blocked',
        detail: `The recorded attempt is waiting for ${attempt.awaiting}.`,
      });
    for (const reference of plan.claims) {
      const claim = (record.claims ?? []).find(
        (item) => item.claim_id === reference.claim_id,
      );
      const expectedEpoch = postTransfer
        ? reference.resource_epoch + 1
        : reference.resource_epoch;
      if (claim === undefined || claim.released_at !== null) {
        drift.push({
          code: 'claim_unavailable',
          detail: `Claim ${reference.claim_id} is missing or already released.`,
        });
        continue;
      }
      if (
        claim.holder === null ||
        !sameIdentity(claim.holder, expectedAssignee)
      ) {
        drift.push({
          code: 'claim_holder_mismatch',
          detail: postTransfer
            ? `Claim ${reference.claim_id} is not held by the successor after the completed transfer.`
            : `Claim ${reference.claim_id} is not held by the planned source.`,
        });
        continue;
      }
      if ((claim.resource_epoch ?? 0) !== expectedEpoch)
        drift.push({
          code: 'claim_epoch_mismatch',
          detail: `Claim ${reference.claim_id} is at epoch ${String(claim.resource_epoch)}; the ${postTransfer ? 'post-transfer' : 'pre-transfer'} expectation is ${expectedEpoch}.`,
        });
      if (
        postTransfer &&
        claim.transferred_from !== undefined &&
        !sameIdentity(claim.transferred_from, plan.from)
      )
        drift.push({
          code: 'claim_transfer_source_mismatch',
          detail: `Claim ${reference.claim_id} was not transferred from the planned source identity.`,
        });
    }
    const native = attempt.native;
    const expectedNative = postTransfer ? successorNative : pinnedSource;
    if (native.observation !== 'confirmed')
      drift.push({
        code: 'native_unconfirmed',
        detail: `The recorded attempt native observation is ${native.observation}.`,
      });
    else if (expectedNative !== null) {
      if (
        expectedNative.session_id !== native.session_id ||
        expectedNative.runner !== native.runner ||
        expectedNative.run_id !== native.run_id
      )
        drift.push({
          code: postTransfer ? 'successor_native_drift' : 'source_native_drift',
          detail: postTransfer
            ? 'The recorded native identity no longer matches the pinned successor.'
            : 'The recorded source native identity no longer matches the identity pinned at intent creation.',
        });
    }
  }

  // The accepted reducer is the authority on refusals; it runs on a clone and never persists.
  const createBlockers: RolloverBlocker[] = [];
  if (recordedIntent === null && proposed !== null) {
    const simulated = rollover.createRolloverIntent(structuredClone(record), {
      intent_id: plan.intent_id,
      generation: plan.generation,
      handoff_id: plan.handoff_id,
      subtask_id: plan.subtask_id,
      attempt: plan.attempt,
      input_revision: plan.input_revision,
      from: plan.from,
      to: plan.to,
      claims: [...plan.claims],
      bundle: { ref: canonicalRef, digest: request.bundle.digest },
      coordinator_epoch: plan.coordinator_epoch,
    });
    if (simulated.ok === false)
      createBlockers.push({
        code: simulated.reason,
        detail: `The accepted reducer refuses the planned intent (${simulated.reason}).`,
      });
  }

  const association = bundleAssociation({
    bundle: bundleRead.value.bundle,
    record,
    plan,
    pinnedSource,
  });
  if (!association.collaboration.matches_plan)
    drift.push({
      code: 'bundle_association_mismatch',
      detail:
        'The verified bundle collaboration binding does not match this record and plan.',
    });
  if (!association.source_session.matches_plan)
    drift.push({
      code: 'bundle_source_native_mismatch',
      detail:
        'The verified bundle source native session/agent/harness does not match the planned source identity.',
    });
  if (!association.handoff_snapshot.claims_match)
    drift.push({
      code: 'bundle_claim_mismatch',
      detail: `The bundle snapshot claims contradict the intent: ${association.claimMismatches.join('; ')}.`,
    });
  if (!association.handoff_snapshot.inventory_complete)
    drift.push({
      code: 'bundle_inventory_incomplete',
      detail:
        'The bundle snapshot does not prove a complete quiescence inventory (claims/pending completeness).',
    });
  if (verified.value.contextIntegrity !== 'complete')
    drift.push({
      code: 'bundle_context_incomplete',
      detail: `The verified bundle context integrity is ${verified.value.contextIntegrity}.`,
    });

  const requestedEvidence = [
    request.evidence.ack_message_id,
    request.evidence.report_message_id,
  ].filter((value): value is string => value !== null);
  const evidence = await loadEvidence(task, requestedEvidence);
  if (evidence.overBudget)
    return failure(
      'needs_input',
      'evidence_over_budget',
      `Evidence exceeds the bounded read budget (${MAX_EVIDENCE_FILES} files, ${MAX_EVIDENCE_BYTES} raw bytes).`,
      'Inspect the oversized registered message explicitly; it was not parsed.',
    );
  const changed = await assertTaskStoreCurrent(task);
  if (changed !== null)
    return failure(
      'needs_input',
      changed.code,
      changed.message,
      changed.nextAction,
    );

  const evidenceIssues: RolloverBlocker[] = [];
  const correlations: RolloverEvidenceCorrelation[] = [];
  for (const message of evidence.messages) {
    const role =
      message.message_id === request.evidence.ack_message_id ? 'ack' : 'report';
    const entry = evidence.entries.get(message.message_id);
    const index = evidence.indices.get(message.message_id);
    if (entry === undefined || index === undefined) continue;
    const correlated = correlateEvidence({
      role,
      message,
      entry,
      index,
      plan,
      record,
      boundary,
    });
    correlations.push(correlated.correlation);
    evidenceIssues.push(...correlated.issues);
  }
  const supplied = new Set(correlations.map((entry) => entry.message_id));
  for (const messageId of requestedEvidence) {
    if (supplied.has(messageId)) continue;
    const unread = evidence.unreadable.find(
      (entry) => entry.message_id === messageId,
    );
    evidenceIssues.push({
      code: unread === undefined ? 'evidence_missing' : 'evidence_unreadable',
      detail:
        unread === undefined
          ? `Requested evidence ${messageId} was not read into the report.`
          : `Requested evidence ${messageId} is ${unread.code}; it is never treated as valid proof.`,
    });
  }

  const successionEntry =
    recordedIntent === null
      ? null
      : ((record.successions ?? []).find(
          (item) =>
            item.handoff_id === recordedIntent.handoff_id &&
            item.generation === recordedIntent.generation,
        ) ?? null);
  const successionCheck =
    successionEntry === null
      ? null
      : validateSuccession(record, successionEntry);
  const successorIssue =
    successionEntry === null
      ? null
      : successionCheck !== null && successionCheck.ok === false
        ? `${successionCheck.code}: ${successionCheck.detail}`
        : null;
  const steps = buildSteps({
    intentFound: recordedIntent !== null,
    createBlockers,
    stage,
    prepared: recordedIntent?.prepared != null,
    successionValid: successionCheck !== null && successionCheck.ok,
    successionIssue: successorIssue,
  });
  const blockers = dedupeBlockers([
    ...drift,
    ...evidenceIssues,
    ...steps.flatMap((step) =>
      step.status === 'blocked' || step.status === 'unavailable'
        ? step.blockers
        : [],
    ),
  ]);
  const senderLookup = routeExclusionFor(record, plan.from);
  const recipientLookup = routeExclusionFor(record, plan.to);
  const exclusions = [senderLookup, recipientLookup]
    .flatMap((lookup) => (lookup.exclusion === null ? [] : [lookup.exclusion]))
    .filter(
      (exclusion, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.handoff_id === exclusion.handoff_id &&
            candidate.generation === exclusion.generation,
        ) === index,
    );
  const effective: 'excluded' | 'active' | 'unknown' =
    senderLookup.state === 'unknown' || recipientLookup.state === 'unknown'
      ? 'unknown'
      : senderLookup.state === 'excluded' ||
          recipientLookup.state === 'excluded'
        ? 'excluded'
        : 'active';

  const planComplete =
    steps.every((step) => step.status === 'satisfied') &&
    drift.length === 0 &&
    evidenceIssues.length === 0 &&
    association.collaboration.matches_plan &&
    association.source_session.matches_plan &&
    association.handoff_snapshot.claims_match &&
    association.handoff_snapshot.inventory_complete &&
    verified.value.contextIntegrity === 'complete';

  return {
    ok: true,
    value: {
      schema: COLLAB_ROLLOVER_REPORT_SCHEMA,
      action: request.action,
      ok: true,
      task_root: task.taskRoot,
      task_id: record.task_id,
      state_revision: record.state_revision,
      owner_epoch: currentEpoch,
      stage,
      intent: {
        found: recordedIntent !== null,
        intent_id: plan.intent_id,
        generation: plan.generation,
        handoff_id: plan.handoff_id,
        subtask_id: plan.subtask_id,
        attempt: plan.attempt,
        input_revision: plan.input_revision,
        from: plan.from,
        to: plan.to,
        source_native: pinnedSource,
        bundle: recordedIntent?.bundle ?? {
          ref: canonicalRef,
          digest: request.bundle.digest,
        },
        transfer_boundary: boundary,
        successor_native: successorNative,
      },
      handoff: {
        state: handoff?.state ?? null,
        from: handoff?.from ?? null,
        to: handoff?.to ?? null,
        owner_epoch: handoff?.owner_epoch ?? null,
      },
      prepared: {
        recorded: recordedIntent?.prepared != null,
        evidence_ref: recordedIntent?.prepared?.evidence_ref ?? null,
        inventory: recordedIntent?.prepared?.inventory ?? null,
        at: recordedIntent?.prepared?.at ?? null,
      },
      attempt:
        attempt === null
          ? null
          : {
              state: attempt.state,
              assignee: attempt.assignee,
              input_revision: attempt.input_revision,
              latest_attempt: (record.attempts ?? [])
                .filter((item) => item.subtask_id === attempt.subtask_id)
                .reduce((max, item) => Math.max(max, item.attempt), 0),
              native: {
                observation: attempt.native.observation,
                session_id: attempt.native.session_id,
                run_id: attempt.native.run_id,
                runner: attempt.native.runner,
                matches_expected:
                  (postTransfer ? successorNative : pinnedSource) === null
                    ? null
                    : (postTransfer ? successorNative : pinnedSource)!
                        .session_id === attempt.native.session_id &&
                      (postTransfer ? successorNative : pinnedSource)!
                        .run_id === attempt.native.run_id &&
                      (postTransfer ? successorNative : pinnedSource)!
                        .runner === attempt.native.runner,
              },
              expected: {
                assignee: postTransfer ? plan.to : plan.from,
                input_revision: plan.input_revision,
                native:
                  (postTransfer ? successorNative : pinnedSource) === null
                    ? null
                    : {
                        session_id: (postTransfer
                          ? successorNative
                          : pinnedSource)!.session_id,
                        run_id: (postTransfer ? successorNative : pinnedSource)!
                          .run_id,
                        runner: (postTransfer ? successorNative : pinnedSource)!
                          .runner,
                      },
              },
            },
      claims: plan.claims.map((reference) => {
        const claim = (record.claims ?? []).find(
          (item) => item.claim_id === reference.claim_id,
        );
        return {
          claim_id: reference.claim_id,
          holder: claim?.holder ?? null,
          resource_epoch: claim?.resource_epoch ?? null,
          expected_resource_epoch: reference.resource_epoch,
          expected_holder: postTransfer ? plan.to : plan.from,
          expected_epoch: postTransfer
            ? reference.resource_epoch + 1
            : reference.resource_epoch,
          released_at: claim?.released_at ?? null,
        };
      }),
      succession: {
        recorded: successionEntry !== null,
        valid: successionCheck !== null && successionCheck.ok,
        issue: successorIssue,
        intent_id: successionEntry?.intent_id ?? null,
        handoff_id: successionEntry?.handoff_id ?? null,
        generation: successionEntry?.generation ?? null,
        archived_at: successionEntry?.archived_at ?? null,
        proof_message_id: successionEntry?.proof.message_id ?? null,
        proof_digest: successionEntry?.proof.digest ?? null,
        routing: 'pending',
        native_archive: 'unavailable',
      },
      bundle: {
        ref: `${request.bundle.continuity_task_id}/${canonicalRef}`,
        continuity_task_id: request.bundle.continuity_task_id,
        digest: bundleRead.value.digest,
        digest_matches: true,
        pinned: recordedIntent !== null,
        verified: true,
        context_integrity: verified.value.contextIntegrity,
        checkpoint_present: verified.value.checkpointPresent,
        workspace_identity_matches: verified.value.workspaceIdentityMatches,
        execution_allowed: false,
        source_session: association.source_session,
        collaboration: association.collaboration,
        handoff_snapshot: association.handoff_snapshot,
      },
      drift,
      steps,
      blockers,
      notify_exclusion: {
        sender: senderLookup,
        recipient: recipientLookup,
        exclusions,
        effective,
      },
      capabilities: {
        record_reducer: 'available',
        bundle_verification: 'available',
        notify_exclusion: 'available',
        host_stop_proof: 'unavailable',
        native_launch: 'unavailable',
        native_session_archive: 'unavailable',
        routing_removal: 'pending',
      },
      evidence: {
        requested: requestedEvidence,
        supplied: correlations.length,
        raw_bytes: evidence.rawBytes,
        over_budget: evidence.overBudget,
        unreadable: evidence.unreadable,
        issues: evidenceIssues,
        correlations,
      },
      plan_complete: planComplete,
      limits: [
        'read_only_inspection',
        'no_apply_or_mutation',
        'host_stop_proof_unavailable',
        'native_launch_unavailable',
        'native_session_archive_unavailable',
        'routing_removal_pending',
        'bundle_context_is_not_authority',
      ],
    },
  };
}
