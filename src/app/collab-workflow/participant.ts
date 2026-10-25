import path from 'node:path';
import {
  buildMessage,
  contentDigest,
  isSafeMessageId,
  validateEnvelope,
} from '../../collab/envelope.js';
import { transitionAttempt } from '../../collab/lifecycle.js';
import { isAssignment } from '../../collab/contracts.js';
import { releaseClaim } from '../../collab/resources.js';
import { submitMessage } from '../../collab/messages.js';
import { notifyRegisteredMessage } from '../collab-notify.js';
import { workflowBindingPath } from '../../schemas/collab-workflow.js';
import { digestText, readRecord, transact } from '../../collab/store.js';
import { claimsOverlap, describeResource } from '../../collab/canonical.js';
import fs from 'node:fs';
import {
  workflowIntentsDir,
  workflowAssignmentPath,
  parseWorkflowParticipantRequest,
  type WorkflowParticipantRequest,
} from '../../schemas/collab-workflow.js';
import {
  digestFile,
  openWorkflowTask,
  readBoundedDocument,
  revalidateWorkflowTask,
  resolveAttempt,
  sameIdentity,
  writeJsonExclusive,
} from './context.js';
import {
  emptyResult,
  type WorkflowBlocker,
  type WorkflowResult,
} from './types.js';
import type { Attempt, Claim, Identity, Message } from '../../collab/types.js';

/**
 * Participant actions: ack, report and release.
 *
 * These are self-call only. The request's caller must equal the registered attempt
 * assignee, so a coordinator cannot author a peer's acknowledgement, report or release by
 * claiming to be that peer. Output digests are computed from the files that actually exist
 * inside the attempt's own write scope; nothing is summarised from prose.
 */

function identityOf(caller: {
  readonly agent_id: string;
  readonly session_id: string;
  readonly harness: string;
}): Identity {
  return {
    agent_id: caller.agent_id,
    session_id: caller.session_id,
    harness: caller.harness,
  };
}

function readReleaseMessage(taskRoot: string, id: string): Message | null {
  if (!isSafeMessageId(id)) return null;
  const read = readBoundedDocument(
    path.join(taskRoot, 'messages', `${id}.json`),
    'release correlation',
  );
  if (!read.ok) return null;
  try {
    return validateEnvelope(read.value.value);
  } catch {
    return null;
  }
}

function activeClaims(
  claims: readonly Claim[],
  attempt: Attempt,
  caller: { readonly agent_id: string; readonly session_id: string },
): Claim[] {
  return claims.filter(
    (claim) =>
      claim.released_at === null &&
      claim.subtask_id === attempt.subtask_id &&
      claim.attempt === attempt.attempt &&
      // The holder, not the attempt label, owns a claim. Another agent's claim carried on
      // this attempt is not this caller's footprint.
      claim.holder?.agent_id === caller.agent_id &&
      claim.holder?.session_id === caller.session_id,
  );
}

function writeClaims(claims: readonly Claim[]): Claim[] {
  return claims.filter(
    (claim) =>
      claim.access === 'write' &&
      typeof claim.path === 'string' &&
      (claim.scope === 'tree' || claim.scope === 'file'),
  );
}

/**
 * Decide whether a declared output really sits in this attempt's authored write footprint.
 *
 * A string prefix is not a scope: `/claimed/tree/../outside` shares the prefix and escapes it.
 * The target is canonicalised through the shared resource descriptor and compared with
 * `claimsOverlap`, so file-vs-tree semantics, canonical case and real paths decide, and a
 * symlinked ancestor that resolves outside the claim is refused.
 */
function withinScope(file: string, claims: readonly Claim[]): boolean {
  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch {
    return false;
  }
  let target;
  try {
    target = describeResource({ kind: 'path', path: real, scope: 'file' });
  } catch {
    return false;
  }
  for (const claim of writeClaims(claims)) {
    let claimPath = claim.path as string;
    try {
      claimPath = fs.realpathSync(claimPath);
    } catch {
      // A claim on a not-yet-existing tree still governs paths below it.
    }
    let resource;
    try {
      resource = describeResource({
        kind: 'path',
        path: claimPath,
        scope: claim.scope === 'file' ? 'file' : 'tree',
      });
    } catch {
      continue;
    }
    if (claimsOverlap(resource, target)) return true;
  }
  return false;
}

function resolveOutputs(
  declaration: readonly string[],
  claims: readonly Claim[],
): {
  readonly outputs: { ref: string; digest: string }[];
  readonly blockers: WorkflowBlocker[];
} {
  const blockers: WorkflowBlocker[] = [];
  const scopes = claims;
  const outputs: { ref: string; digest: string }[] = [];
  for (const ref of declaration) {
    if (!path.isAbsolute(ref)) {
      blockers.push({
        code: 'output_not_absolute',
        detail: `Declared output ${ref} is not an absolute path.`,
        next_action:
          'Declare absolute output paths inside the claimed write scope.',
      });
      continue;
    }
    if (!withinScope(ref, scopes)) {
      blockers.push({
        code: 'output_outside_claim',
        detail: `Declared output ${ref} is outside this attempt's write claims.`,
        next_action:
          'Report only files this attempt claimed; an unclaimed output has no proven authorship.',
      });
      continue;
    }
    const digest = digestFile(ref);
    if (digest === null) {
      blockers.push({
        code: 'output_missing',
        detail: `Declared output ${ref} cannot be read.`,
        next_action:
          'Write the output first; a digest is never invented for a missing file.',
      });
      continue;
    }
    outputs.push({ ref, digest });
  }
  return { outputs, blockers };
}

async function cancelForRelease(
  taskRoot: string,
  attempt: Attempt,
  caller: { readonly agent_id: string },
  reason: string,
  clock: number | undefined,
): Promise<{ ok: boolean; detail: string }> {
  const outcome = transact(taskRoot, {
    actor: caller.agent_id,
    purpose: 'workflow:release-cancel',
    ...(clock === undefined ? {} : { clock }),
    apply: (record) => {
      const transition = transitionAttempt(record, {
        subtaskId: attempt.subtask_id,
        attempt: attempt.attempt,
        to: 'cancelled',
        actor: caller.agent_id,
        reason,
        evidence: { source: 'workflow participant release' },
        ...(clock === undefined ? {} : { clock }),
      });
      if (!transition.ok)
        return { ok: false, reason: transition.reason, record };
      return {
        record,
        op: 'release-cancel',
        summary: { subtask_id: attempt.subtask_id, attempt: attempt.attempt },
      };
    },
  });
  if (outcome.ok) return { ok: true, detail: 'attempt cancelled' };
  return { ok: false, detail: String(outcome.reason) };
}

export interface DeliveryOutcome {
  readonly delivery: string;
  readonly duplicate: boolean;
  readonly blocker: WorkflowBlocker | null;
}

/**
 * Deliver one just-admitted envelope through the durable notification reservation.
 *
 * Persistence and delivery are separate facts. A duplicate resend never wakes the recipient
 * twice, an ambiguous delivery is never repeated, and a transport failure leaves the applied
 * record intact instead of pretending it was rolled back.
 */
async function deliverAdmitted(
  taskRoot: string,
  messageId: string,
  callerPane: string | null,
  submitted: { readonly ok: boolean; readonly duplicate?: boolean },
  notify: typeof notifyRegisteredMessage,
  writing: boolean,
): Promise<DeliveryOutcome> {
  // A plan is read-only: it must not wake anybody. The synthetic planned submission is not
  // a duplicate, so without this guard a plan would fall through into a real notification.
  if (!writing)
    return { delivery: 'not-attempted', duplicate: false, blocker: null };
  if (!submitted.ok)
    return { delivery: 'not-attempted', duplicate: false, blocker: null };
  if (submitted.duplicate === true)
    return { delivery: 'already-recorded', duplicate: true, blocker: null };
  const delivered = await notify({
    taskRoot,
    messageId,
    bindingFile: workflowBindingPath(taskRoot),
    apply: true,
    retry: false,
    callerPane,
  });
  if (!delivered.ok)
    return {
      delivery: 'not-notified',
      duplicate: false,
      blocker: {
        code: delivered.code,
        detail: delivered.message,
        next_action:
          delivered.nextAction ??
          'Inspect the task binding; delivery was not attempted.',
      },
    };
  const status = delivered.value.status;
  return {
    delivery: status,
    duplicate: false,
    blocker:
      status === 'submitted'
        ? null
        : {
            code: `delivery_${status}`,
            detail: `Delivery reported ${status}: ${String(delivered.value.detail ?? '')}.`,
            next_action:
              'Reconcile the recorded delivery; an ambiguous notification is never replayed automatically.',
          },
  };
}

export async function applyParticipant(
  request: WorkflowParticipantRequest,
  options: {
    readonly clock?: number;
    readonly apply?: boolean;
    readonly notify?: typeof notifyRegisteredMessage;
  } = {},
): Promise<
  WorkflowResult<{
    message_id: string | null;
    outputs: readonly { ref: string; digest: string }[];
    released: readonly string[];
  }>
> {
  type Detail = {
    message_id: string | null;
    outputs: readonly { ref: string; digest: string }[];
    released: readonly string[];
  };
  const opened = await openWorkflowTask(request.task_root);
  if (!opened.ok) {
    const base = emptyResult<Detail>(request.action, true);
    return {
      ...base,
      status: 'invalid',
      blockers: [
        {
          code: opened.code,
          detail: opened.message,
          next_action: opened.nextAction,
        },
      ],
      next_action: opened.nextAction,
    };
  }
  const task = opened.value;
  const record = task.record;
  const writing = options.apply !== false;
  const base = emptyResult<Detail>(request.action, writing);
  const attempt = resolveAttempt(record, request.subtask_id, request.attempt);
  const empty: Detail = { message_id: null, outputs: [], released: [] };
  if (attempt === null)
    return {
      ...base,
      status: 'refused',
      task_id: record.task_id,
      task_root: task.taskRoot,
      domain_root: record.domain_root,
      state_revision: record.state_revision,
      blockers: [
        {
          code: 'attempt_not_registered',
          detail: `${request.subtask_id}#${request.attempt} was never registered for this task.`,
          next_action:
            'Read the registered attempts with workflow inspect; an attempt is never assumed from a request.',
        },
      ],
      next_action: 'Inspect the task record before retrying.',
      detail: empty,
    };
  if (!sameIdentity(attempt.assignee, request.caller))
    return {
      ...base,
      status: 'refused',
      task_id: record.task_id,
      task_root: task.taskRoot,
      domain_root: record.domain_root,
      state_revision: record.state_revision,
      principal: { ...request.caller, role: 'participant' },
      blockers: [
        {
          code: 'sender_denied',
          detail: `${request.subtask_id}#${request.attempt} is assigned to ${attempt.assignee.agent_id}/${attempt.assignee.session_id}; the caller is ${request.caller.agent_id}/${request.caller.session_id}.`,
          next_action:
            'The bound participant must make this call itself; another agent cannot author it on its behalf.',
        },
      ],
      next_action: 'The bound participant must call this action.',
      detail: empty,
    };

  const changed = await revalidateWorkflowTask(task);
  if (!changed.ok)
    return {
      ...base,
      status: 'invalid',
      principal: { ...request.caller, role: 'participant' },
      blockers: [
        {
          code: changed.code,
          detail: changed.message,
          next_action: changed.nextAction,
        },
      ],
      next_action: changed.nextAction,
      detail: empty,
    };

  const sender = identityOf(request.caller);
  const recipient = {
    agent_id: record.coordinator?.agent_id ?? 'unattributed',
    session_id: record.coordinator?.session_id ?? 'unattributed',
    harness: record.coordinator?.harness ?? null,
  };
  const claims = activeClaims(record.claims ?? [], attempt, request.caller);
  const blockers: WorkflowBlocker[] = [];
  const released: string[] = [];

  if (request.action === 'ack') {
    const message = buildMessage({
      type: 'ACK',
      task_id: record.task_id,
      from: sender,
      to: recipient,
      reply_to: attempt.assignment_message_id,
      message_id: `ack-${request.subtask_id}-${request.attempt}`,
      subtask_id: request.subtask_id,
      attempt: request.attempt,
      owner_epoch: attempt.owner_epoch ?? record.coordinator?.owner_epoch ?? 1,
      body: { status: 'running', role: 'participant acknowledgement' },
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    const submitted = writing
      ? submitMessage(task.taskRoot, message, {
          ...(options.clock === undefined ? {} : { clock: options.clock }),
        })
      : {
          ok: true as const,
          registration: { status: 'planned' },
          duplicate: false,
        };
    if (!submitted.ok)
      blockers.push({
        code: String(submitted.reason),
        detail: `The protocol refused the ACK: ${String(submitted.reason)}.`,
        next_action:
          'Inspect the registered assignment message and the attempt state.',
      });
    const deliveredAck = await deliverAdmitted(
      task.taskRoot,
      message.message_id,
      request.caller_pane,
      submitted,
      options.notify ?? notifyRegisteredMessage,
      writing,
    );
    const ackWarnings: string[] = [];
    if (deliveredAck.blocker !== null)
      ackWarnings.push(
        `${deliveredAck.blocker.code}: ${deliveredAck.blocker.detail}`,
      );
    const current = readRecord(task.taskRoot);
    return {
      ...base,
      status:
        blockers.length === 0 ? (writing ? 'applied' : 'planned') : 'blocked',
      ok: blockers.length === 0,
      task_id: record.task_id,
      task_root: task.taskRoot,
      domain_root: record.domain_root,
      state_revision: current?.state_revision ?? record.state_revision,
      principal: { ...request.caller, role: 'participant' },
      messages: [
        {
          message_id: message.message_id,
          type: 'ACK',
          registration: submitted.ok
            ? String(submitted.registration?.status ?? '')
            : null,
          duplicate: submitted.ok && submitted.duplicate === true,
          delivery: deliveredAck.delivery,
          digest: message.content_digest ?? digestText(''),
        },
      ],
      blockers,
      warnings: ackWarnings,
      next_action: blockers[0]?.next_action ?? null,
      detail: { ...empty, message_id: message.message_id },
    };
  }

  if (request.action === 'report') {
    const declaration = request.report;
    if (declaration === null) {
      return {
        ...base,
        status: 'invalid',
        blockers: [
          {
            code: 'report_declaration_invalid',
            detail: 'No report declaration was supplied.',
            next_action: null,
          },
        ],
        detail: empty,
      };
    }
    const resolved = resolveOutputs(declaration.outputs, claims);
    blockers.push(...resolved.blockers);
    if (blockers.length === 0) {
      // A report id is deterministic per content, not per attempt: an honest resend is a
      // duplicate, while a legitimately different later report gets its own id instead of a
      // content conflict against the first one.
      const reportKey = digestText(
        JSON.stringify({
          status: declaration.status,
          summary: declaration.summary,
          blockers: [...declaration.blockers],
          outputs: resolved.outputs,
        }),
      )
        .replace('sha256:', '')
        .slice(0, 12);
      const message = buildMessage({
        type: 'REPORT',
        task_id: record.task_id,
        from: sender,
        to: recipient,
        message_id: `report-${request.subtask_id}-${request.attempt}-${reportKey}`,
        subtask_id: request.subtask_id,
        attempt: request.attempt,
        owner_epoch:
          attempt.owner_epoch ?? record.coordinator?.owner_epoch ?? 1,
        body: {
          status: declaration.status,
          summary: declaration.summary,
          blockers: [...declaration.blockers],
          outputs: resolved.outputs.map((item) => ({ ...item })),
          // `applyMessage` admits the result with this revision; omitting it makes a pinned
          // assignment classify the report as stale instead of completing it.
          input_revision:
            attempt.input_revision ?? record.input_revision ?? null,
          native_ref: attempt.native ?? null,
          evidence_ref:
            resolved.outputs.length === 0
              ? null
              : digestText(JSON.stringify(resolved.outputs)),
        },
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      });
      const submitted = writing
        ? submitMessage(task.taskRoot, message, {
            ...(options.clock === undefined ? {} : { clock: options.clock }),
          })
        : {
            ok: true as const,
            registration: { status: 'planned' },
            duplicate: false,
          };
      if (!submitted.ok)
        blockers.push({
          code: String(submitted.reason),
          detail: `The protocol refused the REPORT: ${String(submitted.reason)}.`,
          next_action:
            'Inspect the attempt state and any existing admitted result; a late or superseded report stays evidence.',
        });
      const classification = (() => {
        const applied =
          submitted.ok && 'applied' in submitted ? submitted.applied : null;
        if (applied === null || typeof applied !== 'object') return null;
        const result = (applied as { result?: unknown }).result;
        if (result === null || typeof result !== 'object') return null;
        const entry = (result as { entry?: { classification?: unknown } })
          .entry;
        return typeof entry?.classification === 'string'
          ? entry.classification
          : null;
      })();
      // `submitMessage.ok` means the envelope was admitted to the record, not that the result
      // is the current conclusion. Only an `applied` admission completes the attempt.
      if (
        submitted.ok &&
        classification !== null &&
        classification !== 'applied'
      )
        blockers.push({
          code: `result_${classification}`,
          detail: `The protocol admitted the report as ${classification}, not as the current result.`,
          next_action:
            'A late, superseded or duplicate result stays evidence; report against the current attempt revision instead.',
        });
      const deliveredReport = await deliverAdmitted(
        task.taskRoot,
        message.message_id,
        request.caller_pane,
        submitted,
        options.notify ?? notifyRegisteredMessage,
        writing,
      );
      const reportWarnings: string[] = [];
      if (deliveredReport.blocker !== null)
        reportWarnings.push(
          `${deliveredReport.blocker.code}: ${deliveredReport.blocker.detail}`,
        );
      const current = readRecord(task.taskRoot);
      return {
        ...base,
        status:
          blockers.length === 0 ? (writing ? 'applied' : 'planned') : 'blocked',
        ok: blockers.length === 0,
        task_id: record.task_id,
        task_root: task.taskRoot,
        domain_root: record.domain_root,
        state_revision: current?.state_revision ?? record.state_revision,
        principal: { ...request.caller, role: 'participant' },
        messages: [
          {
            message_id: message.message_id,
            type: 'REPORT',
            registration: submitted.ok
              ? String(submitted.registration?.status ?? '')
              : null,
            duplicate: submitted.ok && submitted.duplicate === true,
            delivery: deliveredReport.delivery,
            digest: message.content_digest ?? digestText(''),
          },
        ],
        blockers,
        warnings: reportWarnings,
        next_action:
          blockers[0]?.next_action ??
          'Report recorded; coordinator acceptance is separate and never implied by a report.',
        detail: {
          ...empty,
          message_id: message.message_id,
          outputs: resolved.outputs,
        },
      };
    }
    return {
      ...base,
      status: 'refused',
      task_id: record.task_id,
      task_root: task.taskRoot,
      domain_root: record.domain_root,
      state_revision: record.state_revision,
      principal: { ...request.caller, role: 'participant' },
      blockers,
      next_action: blockers[0]?.next_action ?? null,
      detail: empty,
    };
  }

  // release: free this attempt's own claims, optionally cancelling a blocked attempt.
  const declaration = request.release;
  if (declaration === null)
    return {
      ...base,
      status: 'invalid',
      blockers: [
        {
          code: 'release_declaration_invalid',
          detail: 'No release declaration was supplied.',
          next_action: null,
        },
      ],
      detail: empty,
    };
  // Primitive callers may pass a richer observed participant object as `caller`.
  // Validate the wire identity fields without rejecting that structural subtype.
  const parsedRelease = parseWorkflowParticipantRequest({
    ...request,
    caller: { ...identityOf(request.caller), cwd: request.caller.cwd },
  });
  if (!parsedRelease.ok)
    blockers.push({
      code: 'release_declaration_invalid',
      detail: parsedRelease.message,
      next_action:
        'Correct the release declaration before retrying; no intent or claim effect was recorded.',
    });
  // A release after a blocked or rejected review must answer a real coordinator decision.
  // The correlation is verified against the registered record before any claim is released.
  let correlated: { id: string; digest: string } | null = null;
  const correlatesTo = declaration.correlates_to ?? null;
  if (correlatesTo !== null) {
    const registered = isSafeMessageId(correlatesTo)
      ? readReleaseMessage(task.taskRoot, correlatesTo)
      : null;
    if (registered === null)
      blockers.push({
        code: 'release_correlation_unknown',
        detail: `Release names ${correlatesTo}, which is not a registered message.`,
        next_action:
          'Correlate the release to a real coordinator ASK/ANSWER registered in this task; an invented reply_to is refused.',
      });
    else if (registered.type !== 'ASK' && registered.type !== 'ANSWER')
      blockers.push({
        code: 'release_correlation_type',
        detail: `${correlatesTo} is a ${registered.type}, not a coordinator ASK or ANSWER.`,
        next_action:
          'Correlate the release to the decision that blocked the review.',
      });
    else if (
      record.coordinator === null ||
      registered.from.agent_id !== record.coordinator.agent_id ||
      registered.from.session_id !== record.coordinator.session_id ||
      registered.from.harness !== record.coordinator.harness
    )
      blockers.push({
        code: 'release_correlation_sender',
        detail: `${correlatesTo} was not sent by the current coordinator.`,
        next_action: 'A release answers the coordinator, not a peer.',
      });
    else if (
      registered.task_id !== record.task_id ||
      registered.to === null ||
      registered.to === undefined ||
      !sameIdentity(registered.to, request.caller) ||
      registered.owner_epoch !== record.coordinator.owner_epoch ||
      (registered.subtask_id !== null &&
        registered.subtask_id !== request.subtask_id) ||
      (registered.attempt !== null && registered.attempt !== request.attempt) ||
      !record.messages.some(
        (entry) =>
          entry.message_id === registered.message_id &&
          entry.content_digest === contentDigest(registered),
      )
    )
      blockers.push({
        code: 'release_correlation_mismatch',
        detail: `${correlatesTo} does not address this participant, task, attempt and coordinator epoch.`,
        next_action:
          'Use the registered decision for this participant and current task.',
      });
    else
      correlated = {
        id: registered.message_id,
        digest: contentDigest(registered),
      };
  }

  // A missing decision correlation answers the real ASSIGN, never an invented id.
  // Keep correlates_to null in the declaration/intent so an existing partial release
  // remains byte-identical when its missing STATUS is completed.
  const assignmentMessageId = attempt.assignment_message_id;
  const assignmentMessage = isSafeMessageId(assignmentMessageId)
    ? readReleaseMessage(task.taskRoot, assignmentMessageId)
    : null;
  if (
    correlatesTo === null &&
    (assignmentMessage === null ||
      assignmentMessage.type !== 'ASSIGN' ||
      assignmentMessage.task_id !== record.task_id ||
      assignmentMessage.subtask_id !== request.subtask_id ||
      assignmentMessage.attempt !== request.attempt ||
      assignmentMessage.to === null ||
      assignmentMessage.to === undefined ||
      !sameIdentity(assignmentMessage.to, request.caller) ||
      assignmentMessage.owner_epoch !== attempt.owner_epoch ||
      !record.messages.some(
        (entry) =>
          entry.message_id === assignmentMessage.message_id &&
          entry.content_digest === contentDigest(assignmentMessage),
      ))
  )
    blockers.push({
      code: 'release_assignment_correlation_invalid',
      detail: 'The attempt has no matching registered ASSIGN to answer.',
      next_action:
        'Inspect the registered assignment; no fallback correlation is fabricated.',
    });

  const sealed = readBoundedDocument(
    workflowAssignmentPath(task.taskRoot, request.subtask_id),
    'sealed assignment',
  );
  if (!sealed.ok)
    blockers.push({
      code: 'sealed_assignment_unreadable',
      detail: sealed.message,
      next_action:
        'Restore the exact sealed assignment before releasing claims.',
    });
  else if (
    !isAssignment(sealed.value.value) ||
    sealed.value.digest !== attempt.assignment_digest
  )
    blockers.push({
      code: 'sealed_assignment_mismatch',
      detail: 'The sealed assignment no longer matches the registered attempt.',
      next_action:
        'Inspect the sealed assignment; it is not rewritten by release.',
    });

  // Validate cancellation on a copy before intent/claim effects. An already cancelled
  // attempt is the idempotent completion of this same release, not another transition.
  if (declaration.cancel_attempt && attempt.state !== 'cancelled') {
    const cancellation = transitionAttempt(structuredClone(record), {
      subtaskId: attempt.subtask_id,
      attempt: attempt.attempt,
      to: 'cancelled',
      actor: request.caller.agent_id,
      reason: declaration.reason,
      evidence: { source: 'workflow participant release' },
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    if (!cancellation.ok)
      blockers.push({
        code: 'cancel_refused',
        detail: `Attempt cancellation was refused: ${cancellation.reason}.`,
        next_action:
          'Use a valid cancellation declaration; no claims or intent were changed.',
      });
  }

  let releaseMessage: Message | null = null;
  if (blockers.length === 0) {
    try {
      releaseMessage = buildMessage({
        type: 'STATUS',
        task_id: record.task_id,
        from: sender,
        to: recipient,
        message_id: `released-${request.subtask_id}-${request.attempt}`,
        subtask_id: request.subtask_id,
        attempt: request.attempt,
        owner_epoch:
          attempt.owner_epoch ?? record.coordinator?.owner_epoch ?? 1,
        reply_to: correlated?.id ?? assignmentMessageId,
        // Only declaration-fixed content: replay cannot change with released claim ids.
        body: {
          status: 'cancelled',
          reason: declaration.reason,
          correlates_to: correlated?.id ?? null,
          acceptance: null,
        },
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      });
      const existing = readReleaseMessage(
        task.taskRoot,
        releaseMessage.message_id,
      );
      const statusFile = path.join(
        task.taskRoot,
        'messages',
        `${releaseMessage.message_id}.json`,
      );
      let statusExists = false;
      try {
        fs.lstatSync(statusFile);
        statusExists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (statusExists) {
        const stored = readBoundedDocument(statusFile, 'release STATUS');
        if (!stored.ok || existing === null)
          blockers.push({
            code: 'release_status_invalid',
            detail: 'The existing release STATUS is unreadable or invalid.',
            next_action:
              'Inspect the existing STATUS; no intent or claims were changed.',
          });
      }
      if (
        existing !== null &&
        contentDigest(existing) !== contentDigest(releaseMessage)
      )
        blockers.push({
          code: 'release_status_conflict',
          detail: 'A different STATUS is already registered for this release.',
          next_action:
            'Inspect the existing STATUS; no release effects were performed.',
        });
    } catch (error) {
      blockers.push({
        code: 'release_status_invalid',
        detail: `Cannot construct the release STATUS: ${String(error)}`,
        next_action: 'Correct the release envelope before retrying.',
      });
    }
  }

  if (blockers.length > 0)
    return {
      ...base,
      status: 'refused',
      ok: false,
      task_id: record.task_id,
      task_root: task.taskRoot,
      domain_root: record.domain_root,
      state_revision: record.state_revision,
      principal: { ...request.caller, role: 'participant' },
      blockers,
      next_action: blockers[0]?.next_action ?? null,
      detail: empty,
    };

  const intentFile = path.join(
    workflowIntentsDir(task.taskRoot),
    `release-${request.subtask_id}-${request.attempt}.json`,
  );
  // The intent records the declared release only: no clock and no post-release claim state,
  // so an identical replay derives identical bytes and is an idempotent duplicate instead of
  // a conflict. The released ids belong to the STATUS envelope, not to this intent.
  const intent = {
    schema: 'pappra/collab-workflow-release-intent/1',
    subtask_id: request.subtask_id,
    attempt: request.attempt,
    reason: declaration.reason,
    cancel_attempt: declaration.cancel_attempt,
    correlates_to: correlated,
    sealed_assignment_digest: sealed.ok ? sealed.value.digest : null,
  };
  const written = writing
    ? writeJsonExclusive(task.taskRoot, intentFile, intent)
    : ({
        status: 'identical',
        digest: digestText(JSON.stringify(intent)),
      } as const);
  if (written.status === 'conflict')
    blockers.push({
      code: 'release_intent_conflict',
      detail:
        'A different release request is already recorded for this attempt.',
      next_action:
        'Inspect the recorded release intent; it is never rewritten.',
    });
  if (written.status === 'unsafe')
    blockers.push({
      code: 'release_intent_unsafe',
      detail: `Cannot record the release intent: ${written.detail}.`,
      next_action:
        'Inspect the workflow intents directory; no claim was released.',
    });
  if (blockers.length === 0 && writing) {
    for (const claim of claims) {
      const releasedClaim = releaseClaim(task.taskRoot, {
        claimId: claim.claim_id,
        holder: sender,
        reason: declaration.reason,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      });
      if (releasedClaim.ok) released.push(claim.claim_id);
      else
        blockers.push({
          code: String(releasedClaim.reason),
          detail: `Claim ${claim.claim_id} was not released: ${String(releasedClaim.reason)}.`,
          next_action:
            'Only the claim holder can release it; use the handoff or rollover engine for a transfer.',
        });
    }
    if (declaration.cancel_attempt && attempt.state !== 'cancelled') {
      const cancelled = await cancelForRelease(
        task.taskRoot,
        attempt,
        request.caller,
        declaration.reason,
        options.clock,
      );
      if (!cancelled.ok)
        blockers.push({
          code: 'cancel_refused',
          detail: `Attempt cancellation was refused: ${cancelled.detail}.`,
          next_action:
            'Release frees claims; a terminal attempt is not re-cancelled and acceptance is never implied.',
        });
    }
  }
  // A release states its own outcome as a registered STATUS envelope and delivers it once;
  // it still never claims acceptance.
  let releaseMessageId: string | null = null;
  let releaseDelivery = 'not-attempted';
  let releaseDuplicate = false;
  let releaseRegistration: string | null = null;
  const releaseWarnings: string[] = [];
  if (blockers.length === 0 && releaseMessage !== null) {
    const releaseSubmitted = writing
      ? submitMessage(task.taskRoot, releaseMessage, {
          ...(options.clock === undefined ? {} : { clock: options.clock }),
        })
      : {
          ok: true as const,
          registration: { status: 'planned' },
          duplicate: false,
        };
    releaseMessageId = releaseMessage.message_id;
    releaseDuplicate =
      releaseSubmitted.ok && releaseSubmitted.duplicate === true;
    releaseRegistration = releaseSubmitted.ok
      ? String(releaseSubmitted.registration?.status ?? '')
      : null;
    if (!releaseSubmitted.ok)
      blockers.push({
        code: String(releaseSubmitted.reason),
        detail: `The protocol refused the release STATUS: ${String(releaseSubmitted.reason)}.`,
        next_action:
          'Inspect the recorded intent and STATUS before retrying; release is not complete.',
      });
    const releaseDelivered = await deliverAdmitted(
      task.taskRoot,
      releaseMessage.message_id,
      request.caller_pane,
      releaseSubmitted,
      options.notify ?? notifyRegisteredMessage,
      writing,
    );
    releaseDelivery = releaseDelivered.delivery;
    if (releaseDelivered.blocker !== null)
      releaseWarnings.push(
        `${releaseDelivered.blocker.code}: ${releaseDelivered.blocker.detail}`,
      );
  }

  const current = readRecord(task.taskRoot);
  return {
    ...base,
    status:
      blockers.length === 0
        ? writing
          ? 'applied'
          : 'planned'
        : 'needs-reconciliation',
    ok: blockers.length === 0,
    task_id: record.task_id,
    task_root: task.taskRoot,
    domain_root: record.domain_root,
    state_revision: current?.state_revision ?? record.state_revision,
    principal: { ...request.caller, role: 'participant' },
    claims: released.map((claimId) => ({
      claim_id: claimId,
      key: '',
      access: '',
      action: 'released' as const,
    })),
    messages:
      releaseMessageId === null
        ? []
        : [
            {
              message_id: releaseMessageId,
              type: 'STATUS',
              registration: releaseRegistration,
              duplicate: releaseDuplicate,
              delivery: releaseDelivery,
              digest: null,
            },
          ],
    blockers,
    warnings: releaseWarnings,
    next_action:
      blockers[0]?.next_action ??
      'Claims released; acceptance is a separate coordinator decision and was not claimed here.',
    detail: {
      ...empty,
      released: writing ? released : claims.map((claim) => claim.claim_id),
    },
  };
}
