/**
 * The single shared evaluation of a persisted `attempts[].native` observation's age.
 *
 * A native observation records *when* a runtime fact was seen, and nothing compared that
 * timestamp with `now`: an old observation that still matched was accepted and never
 * downgraded to `unknown` (see `docs/transport-runtime-boundaries.md`, Known gaps). This
 * module is the one place that turns the record into a typed verdict, so the decision
 * consumers (recovery `continue`, rollover claim transfer) and the history consumers
 * (REPORT body, `workflow inspect`) cannot drift apart.
 *
 * `unknown` is the floor: this evaluation never reports "assume unchanged". A record with
 * no timestamp is `missing`, an unparseable one is `invalid`, and only `fresh` may be
 * treated as current. The bound is a native-observation bound of its own; it is neither the
 * 30-second session quiescence window (`MAX_QUIESCENCE_AGE_MS`) nor the capability card's
 * preflight rule, even though it shares that card's default number.
 *
 * A clock that cannot date anything must not read as fresh: a non-finite `now` fails closed
 * as `invalid` instead of letting every comparison fall through to `fresh`.
 */

/**
 * A native observation older than this is no longer current. Thirty minutes matches the
 * capability card's default bound, which was chosen as the shortest window in which a
 * settled runtime observation is still a useful statement about a live session.
 */
export const NATIVE_OBSERVATION_MAX_AGE_MINUTES = 30;

/**
 * A timestamp ahead of `now` is tolerated by a minute and only beyond that classified as
 * `future`, matching how the capability card bound treats clock skew
 * (`src/collab/preflight.ts`, `capabilities_from_future`).
 */
export const NATIVE_OBSERVATION_FUTURE_TOLERANCE_MS = 60_000;

export type NativeObservationAgeClassification =
  'fresh' | 'expired' | 'missing' | 'invalid' | 'future';

export interface NativeObservationAgeVerdict {
  readonly classification: NativeObservationAgeClassification;
  /** True only for `fresh`: the one value a decision consumer may rely on. */
  readonly fresh: boolean;
  /** True when the record asserts a native fact instead of the bare `unknown` placeholder. */
  readonly asserted: boolean;
  /** The recorded `observation` string, unmodified (`confirmed`, `unknown`, ...). */
  readonly recorded_observation: string | null;
  readonly observed_at: string | null;
  /** `now - observed_at`; null when nothing could be dated. */
  readonly age_ms: number | null;
  readonly max_age_ms: number;
  readonly detail: string;
}

/** The compact form the history consumers publish; it never refuses anything by itself. */
export interface NativeObservationAgeSummary {
  readonly classification: NativeObservationAgeClassification;
  readonly observed_at: string | null;
  readonly age_ms: number | null;
  readonly max_age_ms: number;
}

export interface NativeObservationAgeOptions {
  /** Injectable clock in epoch milliseconds. Defaults to `Date.now()`. */
  readonly now?: number;
  readonly maxAgeMinutes?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Whether the record claims a native fact. A fresh `assigned` attempt carries only the
 * `unknown` placeholder, which is "nothing observed yet" rather than an observation whose
 * age could be judged.
 */
function assertsObservation(native: Record<string, unknown>): boolean {
  const observation = nonEmptyText(native.observation);
  if (observation !== null && observation !== 'unknown') return true;
  return ['runner', 'session_id', 'run_id', 'mission_id', 'evidence_ref'].some(
    (key) => nonEmptyText(native[key]) !== null,
  );
}

function boundMs(maxAgeMinutes: number | undefined): number {
  const minutes =
    typeof maxAgeMinutes === 'number' &&
    Number.isFinite(maxAgeMinutes) &&
    maxAgeMinutes > 0
      ? maxAgeMinutes
      : NATIVE_OBSERVATION_MAX_AGE_MINUTES;
  // A finite bound can still overflow when scaled to milliseconds. A bound that is not a
  // positive finite number would make `age > maxAgeMs` false forever, so it falls back to
  // the default rather than widening the window without limit.
  const ms = Math.round(minutes * 60_000);
  return Number.isFinite(ms) && ms > 0
    ? ms
    : NATIVE_OBSERVATION_MAX_AGE_MINUTES * 60_000;
}

/**
 * Classify one persisted observation. Every outcome except `fresh` means "do not treat this
 * as current"; there is no unchanged-assumption fallback.
 */
export function evaluateNativeObservationAge(
  native: unknown,
  options: NativeObservationAgeOptions = {},
): NativeObservationAgeVerdict {
  const source = asRecord(native);
  const now = options.now ?? Date.now();
  const maxAgeMs = boundMs(options.maxAgeMinutes);
  const asserted = assertsObservation(source);
  const recorded = nonEmptyText(source.observation);
  const raw = source.observed_at;
  const common = {
    asserted,
    recorded_observation: recorded,
    max_age_ms: maxAgeMs,
  };

  if (raw === null || raw === undefined)
    return {
      ...common,
      classification: 'missing',
      fresh: false,
      observed_at: null,
      age_ms: null,
      detail:
        'the recorded native observation has no observed_at, so it cannot be dated and is never current.',
    };

  if (typeof raw !== 'string' || raw.length === 0)
    return {
      ...common,
      classification: 'invalid',
      fresh: false,
      observed_at: null,
      age_ms: null,
      detail:
        'the recorded native observed_at is not a timestamp string, so it is never current.',
    };

  const at = Date.parse(raw);
  if (!Number.isFinite(at))
    return {
      ...common,
      classification: 'invalid',
      fresh: false,
      observed_at: raw,
      age_ms: null,
      detail: `the recorded native observed_at ${raw} is unparseable, so it is never current.`,
    };

  // A non-finite clock dates nothing: `NaN` and both infinities make every comparison below
  // false, which would have classified an old observation as fresh. Fail closed and name the
  // clock so the cause is not mistaken for a bad record.
  if (!Number.isFinite(now))
    return {
      ...common,
      classification: 'invalid',
      fresh: false,
      observed_at: raw,
      age_ms: null,
      detail: `the injected clock is not a finite epoch millisecond value (${String(now)}), so this observation cannot be dated and is never current.`,
    };

  const age = now - at;
  if (age < -NATIVE_OBSERVATION_FUTURE_TOLERANCE_MS)
    return {
      ...common,
      classification: 'future',
      fresh: false,
      observed_at: raw,
      age_ms: age,
      detail: `the recorded native observed_at ${raw} is ${String(-age)}ms ahead of now, beyond the ${String(NATIVE_OBSERVATION_FUTURE_TOLERANCE_MS)}ms clock-skew tolerance.`,
    };

  if (age > maxAgeMs)
    return {
      ...common,
      classification: 'expired',
      fresh: false,
      observed_at: raw,
      age_ms: age,
      detail: `the recorded native observed_at ${raw} is ${String(age)}ms old; the native observation bound is ${String(maxAgeMs)}ms.`,
    };

  return {
    ...common,
    classification: 'fresh',
    fresh: true,
    observed_at: raw,
    age_ms: age,
    detail: `the recorded native observed_at ${raw} is ${String(age)}ms old, inside the ${String(maxAgeMs)}ms native observation bound.`,
  };
}

/** The reader-facing projection: the age classification without the refusal decision. */
export function nativeObservationAgeSummary(
  native: unknown,
  options: NativeObservationAgeOptions = {},
): NativeObservationAgeSummary {
  const verdict = evaluateNativeObservationAge(native, options);
  return {
    classification: verdict.classification,
    observed_at: verdict.observed_at,
    age_ms: verdict.age_ms,
    max_age_ms: verdict.max_age_ms,
  };
}

/**
 * The persisted projection: only what the record itself says, never what a clock says.
 *
 * A REPORT message id is derived from its body (`src/app/collab-workflow/participant.ts`), so
 * a body carrying `age_ms` or the age classification would change on every resend and
 * `src/collab/messages.ts` would refuse an honest resend as `content_conflict`. This
 * projection therefore publishes the recorded `observed_at`, the configured bound and whether
 * a native fact is asserted — and it takes no clock at all, so it cannot become
 * clock-dependent. Live readers that are never persisted keep
 * `nativeObservationAgeSummary`.
 */
export interface NativeObservationAgeEvidence {
  /** The recorded timestamp as stored, or null when the record holds none. */
  readonly observed_at: string | null;
  /** True when the record asserts a native fact instead of the bare `unknown` placeholder. */
  readonly asserted: boolean;
  readonly max_age_ms: number;
}

export function nativeObservationAgeEvidence(
  native: unknown,
  options: Pick<NativeObservationAgeOptions, 'maxAgeMinutes'> = {},
): NativeObservationAgeEvidence {
  const source = asRecord(native);
  const raw = source.observed_at;
  return {
    observed_at: typeof raw === 'string' && raw.length > 0 ? raw : null,
    asserted: assertsObservation(source),
    max_age_ms: boundMs(options.maxAgeMinutes),
  };
}
