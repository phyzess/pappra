import type {
  CollabDeliveryAgentState,
  CollabDeliveryObservation,
  CollabDeliveryObservationReason,
} from '../schemas/collaboration.js';

/**
 * Bounded observation of what the recipient's transport did around one
 * submitted pointer.
 *
 * Herdr reports agent-level state — a status, counters, a terminal identity —
 * and nothing in that read is correlated with a specific prompt. A turn that
 * starts after a pointer is submitted may have been started by that pointer, by
 * another message, or by a human at the keyboard, and a pointer that has been
 * typed into the input without a started turn looks exactly like one that was
 * never typed at all. This module therefore never derives a message-level
 * receipt from those signals:
 *
 * - `receipt` is always `unknown`. The raw reading, the sample count, the
 *   window and a closed `reason` still record **what was observed** — a turn
 *   started on this terminal (`turn_activity_observed`) or no turn started in
 *   the window (`no_turn_activity_observed`) — but neither value claims that
 *   this pointer was or was not received.
 * - `taken` / `not_taken` stay defined in the schema for a transport that can
 *   correlate a state change with one message. No supported transport provides
 *   that evidence today, so no code path here emits either value.
 *
 * Three limits are structural, not incidental:
 *
 * - Nothing here sends, retypes or presses a key, and nothing waits for a state
 *   it hopes to see. The loop starts only while budget remains, hands the
 *   transport a timeout that never exceeds that budget, and refuses to classify
 *   a reading that arrives after the budget is spent.
 * - Activity on its own proves nothing. A moved counter, a redraw, an already
 *   working recipient, a changed terminal or a missing signal stay `unknown`
 *   instead of being folded into a receipt branch.
 * - `window_ms` is what actually elapsed. A transport that ignores the
 *   requested timeout can overrun the budget; there is no cancellation path
 *   from here into the transport, so the record states the overrun instead of
 *   claiming a hard wall-clock limit.
 *
 * Two different clocks meet here, and they are not interchangeable. `now()` is
 * the observation's own budget clock: it measures the window and is advanced by
 * the loop's sleeps. It is deliberately separate from the caller's fixed record
 * timestamp (the delivery record's `at`/`updated_at`), which says when the
 * attempt was recorded and never drives a deadline. A test that needs both to
 * agree must inject both explicitly.
 */

/** Structural problems a probe can detect before any state comparison. */
export type DeliveryObservationProblem =
  | 'target_missing'
  | 'target_identity_changed'
  | 'target_session_changed'
  | 'probe_failed';

export type DeliveryObservationProbe =
  | { readonly ok: true; readonly state: CollabDeliveryAgentState }
  | {
      readonly ok: false;
      readonly reason: DeliveryObservationProblem;
      readonly detail: string | null;
    };

export interface DeliveryObservationPolicy {
  /** Maximum number of post-submission probes; each probe is one bounded read. */
  readonly maxSamples: number;
  /** Delay between probes. */
  readonly intervalMs: number;
  /** Wall-clock budget measured from the start of the observation. */
  readonly windowMs: number;
  /**
   * Upper bound for one probe. It is further clamped to the remaining budget, so
   * a probe is never asked to wait for longer than the window has left.
   */
  readonly probeTimeoutMs: number;
}

/**
 * Default bound: three probes over about two seconds, each probe capped at four
 * seconds. Long enough to see a provider's turn start, short enough that a
 * notification stays interactive.
 */
export const DEFAULT_DELIVERY_OBSERVATION_POLICY: DeliveryObservationPolicy = {
  maxSamples: 3,
  intervalMs: 1_000,
  windowMs: 3_000,
  probeTimeoutMs: 4_000,
};

export const MAX_DELIVERY_OBSERVATION_SAMPLES = 8;
export const MAX_DELIVERY_OBSERVATION_INTERVAL_MS = 30_000;
export const MAX_DELIVERY_OBSERVATION_WINDOW_MS = 60_000;
export const MAX_DELIVERY_OBSERVATION_PROBE_TIMEOUT_MS = 30_000;

/**
 * Bound for the free-text `detail` of an observation (the persisted schema caps
 * it at 1024). Only this diagnostic is shortened: identity and state fields are
 * never truncated, because a shortened terminal id or status would look like a
 * valid different value. An observation that is otherwise outside the schema is
 * rejected by the writer instead of being trimmed into shape.
 */
export const MAX_OBSERVATION_DETAIL_CHARS = 1024;

/**
 * Shortens a detail that is over `limit`. The marker carries no number on
 * purpose: a digit count would have to be computed against the space it itself
 * consumes, so a bug there would either misreport the cut or push the result over
 * the field's limit. The result never exceeds `limit`.
 */
const TRUNCATION_MARKER = ' …[truncated]';

export function boundDetail(text: string | null, limit: number): string | null {
  if (text === null || text.length <= limit) return text;
  if (limit <= TRUNCATION_MARKER.length)
    return TRUNCATION_MARKER.slice(0, Math.max(0, limit));
  return `${text.slice(0, limit - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

/** A negative needs at least two independent samples to be a window. */
export const MIN_DELIVERY_OBSERVATION_SAMPLES = 2;

/**
 * The persisted schema bounds `window_ms` at 600 000. A transport that hangs
 * for longer is recorded at the bound with the real elapsed time in `detail`,
 * so an overrun cannot make the delivery record unreadable.
 */
const MAX_RECORDED_WINDOW_MS = 600_000;

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

export function normalizeDeliveryObservationPolicy(
  input: Partial<DeliveryObservationPolicy> = {},
): DeliveryObservationPolicy {
  return {
    maxSamples: boundedInteger(
      input.maxSamples,
      MIN_DELIVERY_OBSERVATION_SAMPLES,
      MAX_DELIVERY_OBSERVATION_SAMPLES,
      DEFAULT_DELIVERY_OBSERVATION_POLICY.maxSamples,
    ),
    intervalMs: boundedInteger(
      input.intervalMs,
      0,
      MAX_DELIVERY_OBSERVATION_INTERVAL_MS,
      DEFAULT_DELIVERY_OBSERVATION_POLICY.intervalMs,
    ),
    windowMs: boundedInteger(
      input.windowMs,
      0,
      MAX_DELIVERY_OBSERVATION_WINDOW_MS,
      DEFAULT_DELIVERY_OBSERVATION_POLICY.windowMs,
    ),
    probeTimeoutMs: boundedInteger(
      input.probeTimeoutMs,
      1,
      MAX_DELIVERY_OBSERVATION_PROBE_TIMEOUT_MS,
      DEFAULT_DELIVERY_OBSERVATION_POLICY.probeTimeoutMs,
    ),
  };
}

/**
 * Default pause between probes. It is a plain timer, not a watcher: the loop
 * owns it, the sample budget bounds it, and nothing survives the call.
 */
export function delay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export interface ObserveDeliveryReceiptInput {
  /**
   * Whether the transport outcome establishes that the pointer may have been
   * submitted. A blocked, refused or failed submission establishes nothing.
   */
  readonly submitted: boolean;
  /** The recipient reading taken while the participants were verified. */
  readonly before: CollabDeliveryAgentState;
  /**
   * One bounded read of the recipient. `budgetMs` never exceeds the remaining
   * observation budget; a transport that honours it cannot stretch the window.
   *
   * A probe that reports a problem keeps its own diagnosis even when it returns
   * late: "the read failed" and "the window is spent" are different facts. Only
   * a reading is refused after the budget, because a late state would be
   * attributed to a window that has already ended.
   */
  readonly probe: (budgetMs: number) => Promise<DeliveryObservationProbe>;
  readonly policy: DeliveryObservationPolicy;
  /** The budget clock. It measures the window and is advanced by `sleep`. */
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

/**
 * Builds the complete diagnostic first, then bounds it once. The overrun note is
 * appended after the free-text part is shortened, so both facts survive together:
 * an over-long transport error never pushes the record over the schema limit, and
 * the real elapsed time and the recorded cap stay readable in the same field.
 */
function observationDetail(
  detail: string | null,
  elapsedMs: number,
): string | null {
  if (elapsedMs <= MAX_RECORDED_WINDOW_MS)
    return boundDetail(detail, MAX_OBSERVATION_DETAIL_CHARS);
  const note = `The recorded window is capped at ${String(MAX_RECORDED_WINDOW_MS)} ms; the prober ran for ${String(elapsedMs)} ms.`;
  const room = MAX_OBSERVATION_DETAIL_CHARS - note.length - 1;
  const head = boundDetail(detail, room);
  return head === null ? note : `${head} ${note}`;
}

const REST_STATUSES: readonly string[] = ['idle', 'done'];

function notReady(state: CollabDeliveryAgentState): boolean {
  return state.launch_pending === true || state.interactive_ready === false;
}

function comparable(
  state: CollabDeliveryAgentState,
): state is CollabDeliveryAgentState & {
  readonly terminal_id: string;
  readonly state_change_seq: number;
} {
  return state.terminal_id !== null && state.state_change_seq !== null;
}

export async function observeDeliveryReceipt(
  input: ObserveDeliveryReceiptInput,
): Promise<CollabDeliveryObservation> {
  const startedAt = input.now();
  const deadline = startedAt + input.policy.windowMs;
  const before = input.before;

  /**
   * Every outcome goes through here, and every outcome is `unknown`: this
   * transport cannot correlate a state change with one prompt, so no branch may
   * claim receipt or non-receipt. `reason` carries what was actually observed.
   */
  const finish = (
    reason: CollabDeliveryObservationReason,
    fields: {
      readonly samples?: number;
      readonly after?: CollabDeliveryAgentState | null;
      readonly detail?: string | null;
    } = {},
  ): CollabDeliveryObservation => {
    const endedAt = Math.max(startedAt, input.now());
    const elapsed = endedAt - startedAt;
    const recorded = Math.min(elapsed, MAX_RECORDED_WINDOW_MS);
    return {
      schema: 'pappra/collab-delivery-observation/1',
      receipt: 'unknown',
      reason,
      source: 'herdr-agent-state',
      started_at: new Date(startedAt).toISOString(),
      ended_at: new Date(endedAt).toISOString(),
      window_ms: recorded,
      samples: fields.samples ?? 0,
      before,
      after: fields.after ?? null,
      detail: observationDetail(fields.detail ?? null, elapsed),
    };
  };

  // Nothing was established as submitted, so there is no receipt question and
  // no observation is attempted.
  if (!input.submitted)
    return finish('submission_not_established', {
      detail:
        'The transport outcome does not establish that a prompt was submitted, so nothing was observed.',
    });

  if (notReady(before))
    return finish('recipient_not_ready', {
      detail:
        'The recipient was launching or not ready for input when it was verified, so no turn could be attributed to this pointer.',
    });
  if (!comparable(before))
    return finish('signals_unavailable', {
      detail:
        'The transport reported no terminal identity or state counter for the recipient, so turn activity cannot be told apart from a redraw.',
    });
  if (before.agent_status === 'working')
    return finish('recipient_already_working', {
      detail:
        'The recipient was already mid-turn when the pointer was submitted, so any turn activity belongs to work that started before this pointer.',
    });
  if (before.agent_status === 'blocked')
    return finish('recipient_blocked', {
      detail:
        'The recipient was blocked when the pointer was submitted; a blocked native UI is never answered.',
    });
  if (!REST_STATUSES.includes(before.agent_status))
    return finish('recipient_state_unknown', {
      detail: `The recipient reported ${before.agent_status} when it was verified, which is not a rest state this observation can start from.`,
    });

  let samples = 0;
  let previous = before;

  for (let index = 0; index < input.policy.maxSamples; index += 1) {
    if (index > 0) {
      const waitBudget = deadline - input.now();
      if (waitBudget <= 0)
        return finish('window_expired', {
          samples,
          after: previous,
          detail: `The ${String(input.policy.windowMs)} ms observation budget was spent before sample ${String(samples + 1)}; nothing further was read.`,
        });
      await input.sleep(Math.min(input.policy.intervalMs, waitBudget));
    }

    // A probe is only started while budget remains, and it is never allowed to
    // wait longer than that remainder.
    const probeBudget = Math.min(
      input.policy.probeTimeoutMs,
      deadline - input.now(),
    );
    if (probeBudget <= 0)
      return finish('window_expired', {
        samples,
        after: previous,
        detail: `The ${String(input.policy.windowMs)} ms observation budget was spent before sample ${String(samples + 1)}; nothing further was read.`,
      });

    let probe: DeliveryObservationProbe;
    try {
      probe = await input.probe(probeBudget);
    } catch (error) {
      return finish('probe_failed', {
        samples,
        after: previous,
        detail: `A transport probe failed after ${String(samples)} sample(s): ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    samples += 1;
    // A late failure is still a failure diagnosis (`probe_failed`, or the
    // specific target problem); it is checked before the budget so the record
    // says what went wrong rather than only that time ran out. A late *reading*
    // is different and is refused below.
    if (!probe.ok)
      return finish(probe.reason, {
        samples,
        after: previous,
        detail: probe.detail,
      });

    const state = probe.state;
    // A reading that arrives after the budget is kept as raw evidence and never
    // classified: the window it was supposed to cover has already ended.
    if (input.now() > deadline)
      return finish('window_expired', {
        samples,
        after: state,
        detail: `Sample ${String(samples)} returned after the ${String(input.policy.windowMs)} ms budget; its reading is recorded but never classified.`,
      });

    if (!comparable(state))
      return finish('evidence_incomplete', {
        samples,
        after: state,
        detail:
          'A transport sample carried no terminal identity or state counter, so it cannot be compared with the state before submission.',
      });

    // The terminal identity is what makes the comparison meaningful: a new
    // terminal id means Herdr restarted the program under the same name.
    if (state.terminal_id !== before.terminal_id)
      return finish('terminal_changed', {
        samples,
        after: state,
        detail: `The terminal identity changed from ${String(before.terminal_id)} to ${String(state.terminal_id)}; the program was restarted.`,
      });

    if (notReady(state))
      return finish('recipient_not_ready', {
        samples,
        after: state,
        detail:
          'The recipient is launching or not ready for input, so no turn can be attributed to this pointer.',
      });

    if (state.agent_status === 'working') {
      if (state.state_change_seq <= before.state_change_seq)
        return finish('evidence_incomplete', {
          samples,
          after: state,
          detail:
            'The recipient reports a working state without a moved state counter, so the transition cannot be placed after this submission.',
        });
      // Turn activity is real and worth recording, but the roster read cannot
      // say which input started it.
      return finish('turn_activity_observed', {
        samples,
        after: state,
        detail:
          'The recipient left its rest state for a working turn on the same terminal during the window. Herdr reports no message-level correlation, so this turn may have been started by this pointer, by another input, or by a human; it is not receipt.',
      });
    }

    if (state.agent_status !== before.agent_status)
      return finish('recipient_state_changed', {
        samples,
        after: state,
        detail: `The recipient moved from ${before.agent_status} to ${state.agent_status} without an observed working turn.`,
      });

    if (state.state_change_seq !== before.state_change_seq)
      return finish('unattributed_activity', {
        samples,
        after: state,
        detail: `The state counter moved from ${String(before.state_change_seq)} to ${String(state.state_change_seq)} without an observed working turn.`,
      });

    if (
      state.completion_seq !== null &&
      before.completion_seq !== null &&
      state.completion_seq !== before.completion_seq
    )
      return finish('unattributed_activity', {
        samples,
        after: state,
        detail:
          'A turn completion was recorded without an observed working state, so it cannot be attributed to this pointer.',
      });

    if (
      state.revision !== null &&
      before.revision !== null &&
      state.revision !== before.revision
    )
      return finish('unattributed_activity', {
        samples,
        after: state,
        detail: `The recipient's revision moved from ${String(before.revision)} to ${String(state.revision)} while its state stayed at rest; a redraw is not proof of anything about this pointer.`,
      });

    previous = state;
  }

  return finish('no_turn_activity_observed', {
    samples,
    after: previous,
    detail: `No working turn was observed in ${String(samples)} sample(s) on the unchanged terminal. A pointer that never started a turn and a pointer still sitting unsubmitted in the input look identical here, so this is not non-receipt.`,
  });
}
