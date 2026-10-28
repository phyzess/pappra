import type {
  AttemptTransferability,
  HandoffReadinessFinding,
} from '../../collab/handoff.js';
import type { Attempt, TaskRecord } from '../../collab/types.js';
import { shellQuote } from '../../infra/shell-quote.js';
import { COLLAB_RECOVERY_REQUEST_SCHEMA } from '../../schemas/collaboration.js';
import { openTaskStore } from '../collab-task-store.js';

/**
 * Remediation for the one mid-cohort blocker an operator clears with `collab recovery reconcile`:
 * an attempt that only acknowledged. Its ACK is the worker's own statement, not a native
 * observation, so `collab handoff check-mid-cohort` keeps blocking until the
 * `registered_not_started` uncertainty is resolved (docs/mid-cohort-succession-spec.md,
 * section 9). This module only names the request that resolves it, with the assertions only the
 * operator can make left null, and the ACK to cite. It reads stored state, resolves nothing and
 * grants nothing.
 */
export interface ReconcileGuidance {
  readonly subtask_id: string;
  readonly attempt: number;
  readonly state: string;
  /** The open `registered_not_started` uncertainty the request resolves. */
  readonly uncertainty_id: string;
  /** The applied worker ACK to cite; null when the record holds none, never invented. */
  readonly ack_message_id: string | null;
  /**
   * The request fields only the operator can state. They are `null` in `request` on purpose: the
   * strict recovery schema refuses the document until each one is replaced, so copying it
   * unchanged records nothing and clears nothing.
   */
  readonly operator_fields: readonly string[];
  readonly prerequisites: readonly string[];
  /** The request document, field for field: what the record gives is filled, the operator's is null. */
  readonly request: {
    readonly schema: typeof COLLAB_RECOVERY_REQUEST_SCHEMA;
    readonly action: 'reconcile';
    readonly actor: null;
    readonly owner_epoch: number;
    readonly uncertainty_id: string;
    readonly resolution: null;
    readonly resolution_evidence: null;
  };
  readonly command: string;
}

/** The assertions only the operator can make; the schema requires each and the request carries none. */
const OPERATOR_FIELDS = ['actor', 'resolution', 'resolution_evidence'] as const;

const label = (item: { subtask_id: string; attempt: number }): string =>
  `${item.subtask_id}#${String(item.attempt)}`;

/**
 * The applied ACK the assignee registered for this attempt. The one that moved the attempt to
 * `accepted` names itself in the transition reason and wins; any other applied ACK from the
 * assignee is the fallback.
 */
function ackFor(record: TaskRecord, attempt: Attempt): string | null {
  const acks = (record.messages ?? []).filter(
    (entry) =>
      entry.type === 'ACK' &&
      entry.state === 'applied' &&
      entry.subtask_id === attempt.subtask_id &&
      entry.attempt === attempt.attempt &&
      entry.from.agent_id === attempt.assignee.agent_id &&
      entry.from.session_id === attempt.assignee.session_id,
  );
  const moved = (attempt.transitions ?? [])
    .find((item) => item.to === 'accepted')
    ?.reason?.match(/^ack (.+)$/)?.[1];
  return (
    acks.find((entry) => entry.message_id === moved)?.message_id ??
    acks[0]?.message_id ??
    null
  );
}

/**
 * Guidance for every attempt in `blocking` (the attempts the check blocked, keyed to the state it
 * saw) that is held back only by its open `registered_not_started` uncertainty: acknowledged or
 * running, so a worker that can carry on once the successor takes over. An `assigned`,
 * `needs_input` or `unknown` attempt has a different remedy and gets none, and neither does one
 * whose state changed since the verdict: guidance never describes another state than the blocker
 * it sits beside.
 */
export function reconcileGuidance(
  record: TaskRecord,
  taskRoot: string,
  blocking: ReadonlyMap<string, string>,
): ReconcileGuidance[] {
  const coordinator = record.coordinator ?? null;
  if (coordinator === null) return [];
  const guidance: ReconcileGuidance[] = [];
  for (const attempt of record.attempts ?? []) {
    if (
      (attempt.state !== 'accepted' && attempt.state !== 'running') ||
      blocking.get(label(attempt)) !== attempt.state
    )
      continue;
    const ack = ackFor(record, attempt);
    for (const entry of (record.uncertainty ?? []).filter(
      (item) =>
        !item.resolved_at &&
        item.kind === 'registered_not_started' &&
        item.subtask_id === attempt.subtask_id &&
        item.attempt === attempt.attempt,
    ))
      guidance.push({
        subtask_id: attempt.subtask_id,
        attempt: attempt.attempt,
        state: attempt.state,
        uncertainty_id: entry.uncertainty_id,
        ack_message_id: ack,
        operator_fields: [...OPERATOR_FIELDS],
        prerequisites: [
          `The worker must really be running (${attempt.assignee.agent_id}'s pane or native session is alive). The ACK only shows it received the assignment, so the check keeps blocking until this uncertainty is resolved or native evidence is bound.`,
          `Fill in ${OPERATOR_FIELDS.join(', ')} yourself. They are null in the request on purpose, and the request is refused until you replace each one. Say what you observed in resolution. ${ack === null ? 'Name the evidence you actually hold in resolution_evidence (the record has no applied ACK for this attempt).' : `Begin resolution_evidence with "ACK ${ack};" and add what else you observed.`}`,
          `owner_epoch must equal the current coordinator epoch (${String(coordinator.owner_epoch)}); a stale epoch is refused. Do not pass set_state: the attempt is already ${attempt.state}.`,
          'Run the command without --apply to validate, then with --apply to record it. The resolution is your recorded conclusion, not native proof; re-run collab handoff check-mid-cohort afterwards.',
        ],
        request: {
          schema: COLLAB_RECOVERY_REQUEST_SCHEMA,
          action: 'reconcile',
          actor: null,
          owner_epoch: coordinator.owner_epoch,
          uncertainty_id: entry.uncertainty_id,
          resolution: null,
          resolution_evidence: null,
        },
        command: `collab recovery reconcile --task-root ${shellQuote(taskRoot)} --request <abs request.json> [--apply] [--json]`,
      });
  }
  return guidance;
}

/**
 * Adds `reconcile` to a mid-cohort check result and points each matching
 * `attempt_not_transferable` blocker at its request. It adds guidance only: the status, the
 * blocker codes and every other field stay as the check produced them, and the rule that an ACK
 * is not a native observation is untouched. The record is read once more, read-only, so the
 * guidance is built from a record at least as new as the verdict and only for attempts still in
 * the state the verdict saw; when that read fails the blockers stand and a warning says the
 * guidance is missing.
 */
export async function withReconcileGuidance(
  check: Record<string, unknown>,
  taskRoot: string,
): Promise<Record<string, unknown>> {
  const rows = Array.isArray(check['attempts'])
    ? (check['attempts'] as readonly AttemptTransferability[])
    : [];
  const blocking = new Map<string, string>(
    rows
      .filter((row) => !row.transferable)
      .map((row): [string, string] => [label(row), row.state]),
  );
  if (blocking.size === 0) return { ...check, reconcile: [] };
  const opened = await openTaskStore(taskRoot);
  if (!opened.ok)
    return {
      ...check,
      reconcile: [],
      warnings: [
        ...((check['warnings'] as readonly HandoffReadinessFinding[]) ?? []),
        {
          code: 'reconcile_guidance_unavailable',
          detail: `The task record could not be read again to build the reconcile guidance: ${opened.message}`,
          next_action:
            'Re-run the check; the blockers are unchanged and still apply.',
        },
      ],
    };
  const guidance = reconcileGuidance(
    opened.value.record,
    opened.value.taskRoot,
    blocking,
  );
  const blockers = (
    (check['blockers'] as readonly HandoffReadinessFinding[]) ?? []
  ).map((item) => {
    if (item.code !== 'attempt_not_transferable') return item;
    // The check words each blocker "<subtask>#<n> is <state> ..." (src/collab/handoff.ts); a test
    // pins that the pointer lands, so a change of wording fails there instead of dropping it.
    const match = guidance.find((entry) =>
      item.detail.startsWith(`${label(entry)} is `),
    );
    return match === undefined
      ? item
      : {
          ...item,
          next_action: `${item.next_action} Resolve it with collab recovery reconcile (uncertainty ${match.uncertainty_id}, cite ${match.ack_message_id === null ? 'the evidence you hold' : `ACK ${match.ack_message_id}`}); the request to complete is listed under reconcile.`,
        };
  });
  return { ...check, blockers, reconcile: guidance };
}
