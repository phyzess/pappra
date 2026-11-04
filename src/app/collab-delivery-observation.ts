import type {
  CollabDeliveryAgentState,
  CollabDeliveryObservation,
  CollabDeliveryObservationReason,
  CollabDeliveryReceipt,
} from '../schemas/collaboration.js';

/**
 * Bounded receipt observation for one submitted collaboration prompt.
 *
 * A `submitted` delivery only says the transport accepted the pointer. Whether
 * the recipient's agent started a turn is a separate, observable fact, and this
 * module states it as narrowly as the evidence allows: `taken` when the
 * recipient left its rest state for a working turn on the same terminal,
 * `not_taken` when a complete window of resting, unchanged samples shows no turn
 * start, and `unknown` for everything the signals cannot attribute.
 *
 * Three limits are structural, not incidental:
 *
 * - Nothing here sends, retypes or presses a key, and nothing waits for a state
 *   it hopes to see: the loop is bounded by a sample budget and a wall-clock
 *   window before it starts.
 * - Activity on its own proves nothing. A moved counter, a redraw, an already
 *   working recipient, a changed terminal or a missing signal stay `unknown`
 *   instead of being folded into a success or a failure branch.
 * - `taken` and `not_taken` describe observed transport state, never
 *   consumption, acknowledgement or task acceptance.
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
}

/**
 * Default bound: three probes over about two seconds. Long enough to see a
 * provider's turn start, short enough that a notification stays interactive.
 */
export const DEFAULT_DELIVERY_OBSERVATION_POLICY: DeliveryObservationPolicy = {
  maxSamples: 3,
  intervalMs: 1_000,
  windowMs: 3_000,
};

export const MAX_DELIVERY_OBSERVATION_SAMPLES = 8;
export const MAX_DELIVERY_OBSERVATION_INTERVAL_MS = 30_000;
export const MAX_DELIVERY_OBSERVATION_WINDOW_MS = 60_000;

/** A negative needs at least two independent samples to be a window. */
export const MIN_DELIVERY_OBSERVATION_SAMPLES = 2;

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
  readonly probe: () => Promise<DeliveryObservationProbe>;
  readonly policy: DeliveryObservationPolicy;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
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
  const before = input.before;

  const finish = (
    receipt: CollabDeliveryReceipt,
    reason: CollabDeliveryObservationReason,
    fields: {
      readonly samples?: number;
      readonly after?: CollabDeliveryAgentState | null;
      readonly detail?: string | null;
    } = {},
  ): CollabDeliveryObservation => {
    const endedAt = Math.max(startedAt, input.now());
    return {
      schema: 'pappra/collab-delivery-observation/1',
      receipt,
      reason,
      source: 'herdr-agent-state',
      started_at: new Date(startedAt).toISOString(),
      ended_at: new Date(endedAt).toISOString(),
      window_ms: endedAt - startedAt,
      samples: fields.samples ?? 0,
      before,
      after: fields.after ?? null,
      detail: fields.detail ?? null,
    };
  };

  // Nothing was established as submitted, so there is no receipt question at
  // all. This stays `unknown` rather than a negative: `not_taken` is reserved
  // for a complete observation window after a possible submission.
  if (!input.submitted)
    return finish('unknown', 'submission_not_established', {
      detail:
        'The transport outcome does not establish that a prompt was submitted, so no receipt was observed.',
    });

  if (notReady(before))
    return finish('unknown', 'recipient_not_ready', {
      detail:
        'The recipient was launching or not ready for input when it was verified, so a prompt could not have been taken.',
    });
  if (!comparable(before))
    return finish('unknown', 'signals_unavailable', {
      detail:
        'The transport reported no terminal identity or state counter for the recipient, so a turn start cannot be distinguished from a redraw.',
    });
  if (before.agent_status === 'working')
    return finish('unknown', 'recipient_already_working', {
      detail:
        'The recipient was already mid-turn when the pointer was submitted, so a working state proves nothing about this pointer.',
    });
  if (before.agent_status === 'blocked')
    return finish('unknown', 'recipient_blocked', {
      detail:
        'The recipient was blocked when the pointer was submitted; a blocked native UI is never answered.',
    });
  if (!REST_STATUSES.includes(before.agent_status))
    return finish('unknown', 'recipient_state_unknown', {
      detail: `The recipient reported ${before.agent_status} when it was verified, which is not a rest state this observation can start from.`,
    });

  let samples = 0;
  let previous = before;

  for (let index = 0; index < input.policy.maxSamples; index += 1) {
    if (index > 0) {
      const remaining = startedAt + input.policy.windowMs - input.now();
      if (remaining <= 0)
        return finish('unknown', 'window_expired', {
          samples,
          after: previous,
          detail: `The observation window ended after ${samples} sample(s); the receipt stays unproven.`,
        });
      await input.sleep(Math.min(input.policy.intervalMs, remaining));
    }

    let probe: DeliveryObservationProbe;
    try {
      probe = await input.probe();
    } catch (error) {
      return finish('unknown', 'probe_failed', {
        samples,
        after: previous,
        detail: `A transport probe failed after ${samples} sample(s): ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    samples += 1;
    if (!probe.ok)
      return finish('unknown', probe.reason, {
        samples,
        after: previous,
        detail: probe.detail,
      });

    const state = probe.state;
    // The terminal identity is what makes the comparison meaningful: a new
    // terminal id means Herdr restarted the program under the same name.
    if (!comparable(state))
      return finish('unknown', 'evidence_incomplete', {
        samples,
        after: state,
        detail:
          'A transport sample carried no terminal identity or state counter, so it cannot be compared with the state before submission.',
      });

    if (state.terminal_id !== before.terminal_id)
      return finish('unknown', 'terminal_changed', {
        samples,
        after: state,
        detail: `The terminal identity changed from ${String(before.terminal_id)} to ${String(state.terminal_id)}; the program was restarted.`,
      });

    if (notReady(state))
      return finish('unknown', 'recipient_not_ready', {
        samples,
        after: state,
        detail:
          'The recipient is launching or not ready for input, so no turn start can be attributed to this pointer.',
      });

    if (state.agent_status === 'working') {
      if (state.state_change_seq <= before.state_change_seq)
        return finish('unknown', 'evidence_incomplete', {
          samples,
          after: state,
          detail:
            'The recipient reports a working state without a moved state counter, so the transition cannot be placed after this submission.',
        });
      return finish('taken', 'turn_observed', {
        samples,
        after: state,
        detail:
          'The recipient left its rest state for a working turn on the same terminal after the pointer was submitted.',
      });
    }

    if (state.agent_status !== before.agent_status)
      return finish('unknown', 'recipient_state_changed', {
        samples,
        after: state,
        detail: `The recipient moved from ${before.agent_status} to ${state.agent_status} without an observed working turn.`,
      });

    if (state.state_change_seq !== before.state_change_seq)
      return finish('unknown', 'unattributed_activity', {
        samples,
        after: state,
        detail: `The state counter moved from ${String(before.state_change_seq)} to ${String(state.state_change_seq)} without an observed working turn.`,
      });

    if (
      state.completion_seq !== null &&
      before.completion_seq !== null &&
      state.completion_seq !== before.completion_seq
    )
      return finish('unknown', 'unattributed_activity', {
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
      return finish('unknown', 'unattributed_activity', {
        samples,
        after: state,
        detail: `The recipient's revision moved from ${String(before.revision)} to ${String(state.revision)} while its state stayed at rest; a redraw is not proof of receipt.`,
      });

    previous = state;
  }

  return finish('not_taken', 'no_observed_turn', {
    samples,
    after: previous,
    detail: `No working turn was observed in ${samples} sample(s) on the unchanged terminal; the pointer may still be sitting unsubmitted in the recipient's input.`,
  });
}
