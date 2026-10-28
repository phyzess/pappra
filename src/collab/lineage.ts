import type { Coordinator, Handoff } from '../schemas/collaboration-state.js';
import type { TaskRecord } from './types.js';

/**
 * Coordinator epoch lineage (docs/mid-cohort-succession-spec.md, section 4).
 *
 * A coordinator handoff raises `owner_epoch`. Nothing records "the same authority line" apart
 * from the completed coordinator handoffs themselves, so the lineage is derived from them: it maps
 * every epoch of the current authority line to the coordinator that held it and to the instant it
 * ended. It is pure, reads the record only and persists nothing.
 *
 * It decides nothing by itself. Validators ask it whether an artifact's own epoch is in the line,
 * who signed for that epoch, and whether the artifact was applied before that epoch ended. A
 * lineage that cannot be established is reported as invalid and reduces to the current epoch only,
 * so every caller falls back to today's strict equality.
 */
export interface LineageIdentity {
  readonly agent_id: string;
  readonly session_id: string;
}

export interface LineageEntry {
  readonly epoch: number;
  readonly identity: LineageIdentity;
  /**
   * Completion instant (milliseconds) of the handoff that created the next epoch, or `null` for
   * the current epoch, which has not ended.
   */
  readonly until: number | null;
  /** The completed handoff that ended this epoch, or `null` for the current epoch. */
  readonly ended_by: string | null;
}

export type CoordinatorLineage =
  | {
      readonly valid: true;
      readonly current: number;
      /** Ascending by epoch; the last entry is the current epoch. */
      readonly entries: readonly LineageEntry[];
    }
  | {
      readonly valid: false;
      readonly reason: LineageInvalidReason;
      readonly detail: string;
      readonly current: number | null;
      /** The current epoch only (empty when the record has no coordinator). */
      readonly entries: readonly LineageEntry[];
    };

export type LineageInvalidReason =
  | 'no_coordinator'
  | 'handoff_order'
  | 'handoff_incomplete'
  | 'epoch_gap'
  | 'epoch_duplicate'
  | 'identity_chain'
  | 'last_handoff_not_current'
  | 'previous_disagrees'
  | 'completion_time_missing'
  | 'completion_time_unparseable';

const isIdentity = (value: unknown): value is LineageIdentity =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as LineageIdentity).agent_id === 'string' &&
  (value as LineageIdentity).agent_id.length > 0 &&
  typeof (value as LineageIdentity).session_id === 'string' &&
  (value as LineageIdentity).session_id.length > 0;

const identityOf = (value: LineageIdentity): LineageIdentity => ({
  agent_id: value.agent_id,
  session_id: value.session_id,
});

const sameIdentity = (left: LineageIdentity, right: LineageIdentity): boolean =>
  left.agent_id === right.agent_id && left.session_id === right.session_id;

/**
 * The timestamps the protocol writes are full ISO-8601 instants with an offset (`nowIso`). A looser
 * string (a bare date, a locale format) that `Date.parse` happens to accept would be read at an
 * instant nobody meant, so only the strict shape is trusted.
 */
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function parseInstant(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

const isEpoch = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

function currentOnly(
  coordinator: Coordinator | null,
  reason: LineageInvalidReason,
  detail: string,
): CoordinatorLineage {
  return {
    valid: false,
    reason,
    detail,
    current: coordinator === null ? null : coordinator.owner_epoch,
    entries:
      coordinator === null
        ? []
        : [
            {
              epoch: coordinator.owner_epoch,
              identity: identityOf(coordinator),
              until: null,
              ended_by: null,
            },
          ],
  };
}

/**
 * The instant a coordinator handoff completed: its `completed` step. A handoff reaches
 * `completed` only through `advance`, which records that step, so a missing or unparseable one
 * means the record is not what the protocol writes and the lineage is not trusted.
 */
function completionInstant(
  handoff: Handoff,
): { ok: true; at: number } | { ok: false; reason: LineageInvalidReason } {
  const steps: unknown = handoff.steps;
  const completed = Array.isArray(steps)
    ? steps.filter(
        (step): step is { state: string; at: unknown } =>
          typeof step === 'object' &&
          step !== null &&
          (step as { state?: unknown }).state === 'completed',
      )
    : [];
  const last = completed[completed.length - 1];
  if (last === undefined)
    return { ok: false, reason: 'completion_time_missing' };
  const at = parseInstant(last.at);
  return at === null
    ? { ok: false, reason: 'completion_time_unparseable' }
    : { ok: true, at };
}

export function coordinatorLineage(record: TaskRecord): CoordinatorLineage {
  // A record that is not an object, or whose shape is wrong, must never make this throw: the
  // lineage exists to fail closed, so it answers "invalid" instead.
  if (typeof record !== 'object' || record === null)
    return currentOnly(
      null,
      'no_coordinator',
      'The task record is not an object.',
    );
  const coordinator = (record.coordinator ?? null) as Coordinator | null;
  if (coordinator === null || typeof coordinator !== 'object')
    return currentOnly(
      null,
      'no_coordinator',
      'The task record names no coordinator.',
    );
  if (!isEpoch(coordinator.owner_epoch) || !isIdentity(coordinator))
    return currentOnly(
      coordinator,
      'no_coordinator',
      'The recorded coordinator has no usable identity or epoch.',
    );

  const handoffs: unknown = record.handoffs ?? [];
  if (!Array.isArray(handoffs))
    return currentOnly(
      coordinator,
      'handoff_incomplete',
      'The handoff list of the task record is not a list.',
    );
  const completed = (handoffs as unknown[]).filter(
    (item): item is Handoff =>
      typeof item === 'object' &&
      item !== null &&
      (item as Handoff).kind === 'coordinator' &&
      (item as Handoff).state === 'completed',
  );
  if (completed.length === 0)
    return {
      valid: true,
      current: coordinator.owner_epoch,
      entries: [
        {
          epoch: coordinator.owner_epoch,
          identity: identityOf(coordinator),
          until: null,
          ended_by: null,
        },
      ],
    };

  const invalid = (reason: LineageInvalidReason, detail: string) =>
    currentOnly(coordinator, reason, detail);

  // Array order must agree with epoch order: an out-of-order pair is invalid, never re-sorted.
  for (let index = 0; index < completed.length; index += 1) {
    const handoff = completed[index]!;
    if (
      !isEpoch(handoff.owner_epoch) ||
      !isIdentity(handoff.to) ||
      !isIdentity(handoff.previous_coordinator) ||
      !isEpoch(handoff.previous_coordinator.owner_epoch)
    )
      return invalid(
        'handoff_incomplete',
        `Completed coordinator handoff ${handoff.handoff_id} lacks a new epoch, a receiver or a previous coordinator.`,
      );
    if (index > 0 && handoff.owner_epoch <= completed[index - 1]!.owner_epoch)
      return invalid(
        handoff.owner_epoch === completed[index - 1]!.owner_epoch
          ? 'epoch_duplicate'
          : 'handoff_order',
        `Completed coordinator handoffs are not in strictly increasing epoch order at ${handoff.handoff_id}.`,
      );
  }

  const entries: LineageEntry[] = [];
  for (let index = 0; index < completed.length; index += 1) {
    const handoff = completed[index]!;
    const previous = handoff.previous_coordinator!;
    // completeHandoff raises the epoch by exactly one.
    if (handoff.owner_epoch !== previous.owner_epoch + 1)
      return invalid(
        'epoch_gap',
        `Handoff ${handoff.handoff_id} created epoch ${handoff.owner_epoch} from epoch ${previous.owner_epoch}.`,
      );
    if (index > 0) {
      const earlier = completed[index - 1]!;
      if (previous.owner_epoch !== earlier.owner_epoch)
        return invalid(
          'epoch_gap',
          `Handoff ${handoff.handoff_id} starts from epoch ${previous.owner_epoch}, not from ${earlier.owner_epoch}.`,
        );
      // The coordinator that handed off is the one the earlier handoff installed.
      if (!sameIdentity(previous, earlier.to))
        return invalid(
          'identity_chain',
          `Handoff ${handoff.handoff_id} was made by a coordinator the previous handoff did not install.`,
        );
    }
    const completion = completionInstant(handoff);
    if (!completion.ok)
      return invalid(
        completion.reason,
        `Handoff ${handoff.handoff_id} has no usable completion time.`,
      );
    entries.push({
      epoch: previous.owner_epoch,
      identity: identityOf(previous),
      until: completion.at,
      ended_by: handoff.handoff_id,
    });
  }

  const last = completed[completed.length - 1]!;
  if (
    last.owner_epoch !== coordinator.owner_epoch ||
    !sameIdentity(last.to, coordinator)
  )
    return invalid(
      'last_handoff_not_current',
      `The last completed coordinator handoff ${last.handoff_id} did not install the recorded coordinator.`,
    );
  // completeHandoff also keeps `previous` on the coordinator; the two must agree.
  const kept = coordinator.previous ?? null;
  const lastPrevious = last.previous_coordinator!;
  if (
    kept === null ||
    kept.owner_epoch !== lastPrevious.owner_epoch ||
    !sameIdentity(kept, lastPrevious)
  )
    return invalid(
      'previous_disagrees',
      'The coordinator record and the last completed handoff disagree about who came before.',
    );

  entries.push({
    epoch: coordinator.owner_epoch,
    identity: identityOf(coordinator),
    until: null,
    ended_by: null,
  });
  // An epoch claimed twice would make "who held it" ambiguous.
  if (new Set(entries.map((entry) => entry.epoch)).size !== entries.length)
    return invalid('epoch_duplicate', 'Two entries claim the same epoch.');
  return { valid: true, current: coordinator.owner_epoch, entries };
}

/**
 * True only when a valid lineage records at least one succession. Every caller branches on this so
 * that, with none, it runs exactly the code it ran before lineage existed.
 */
export function hasSuccession(lineage: CoordinatorLineage): boolean {
  return lineage.valid && lineage.entries.length > 1;
}

export function lineageEntry(
  lineage: CoordinatorLineage,
  epoch: number,
): LineageEntry | null {
  return lineage.entries.find((entry) => entry.epoch === epoch) ?? null;
}

export function lineageContains(
  lineage: CoordinatorLineage,
  epoch: number,
): boolean {
  return lineageEntry(lineage, epoch) !== null;
}

export interface EvidenceVerdict {
  readonly valid: boolean;
  readonly reason:
    | 'ok'
    | 'epoch_not_in_lineage'
    | 'signer_not_coordinator_of_epoch'
    | 'applied_time_unparseable'
    | 'applied_after_epoch_ended';
}

/**
 * Class E (evidence) check from the specification: an artifact is valid evidence when its own epoch
 * is in the lineage, its signer was the coordinator of that epoch, and, if that epoch is not the
 * current one, it was applied at or before the epoch ended. Authority checks (who may act now)
 * never go through here.
 */
export function judgeEvidence(
  lineage: CoordinatorLineage,
  evidence: {
    readonly epoch: number;
    readonly signer: LineageIdentity;
    /** When the artifact was applied to the record (`applied_at`). */
    readonly appliedAt: string;
  },
): EvidenceVerdict {
  const entry = lineageEntry(lineage, evidence.epoch);
  if (entry === null) return { valid: false, reason: 'epoch_not_in_lineage' };
  if (!sameIdentity(entry.identity, evidence.signer))
    return { valid: false, reason: 'signer_not_coordinator_of_epoch' };
  if (entry.until === null) return { valid: true, reason: 'ok' };
  const applied = parseInstant(evidence.appliedAt);
  if (applied === null)
    return { valid: false, reason: 'applied_time_unparseable' };
  return applied <= entry.until
    ? { valid: true, reason: 'ok' }
    : { valid: false, reason: 'applied_after_epoch_ended' };
}
