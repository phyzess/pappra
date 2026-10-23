/**
 * In-process native Pi event-fact capture (rollover observation source).
 *
 * A small, bounded, opt-in producer that subscribes to a fixed set of supported installed Pi 1.3.0
 * extension callbacks and derives conservative in-process facts plus invalidation notifications. It is
 * NOT authority, external control, writer fencing, or a native-stop/quiescence/transfer proof. It never
 * calls the accepted freeze controller's `observe()`, never synthesizes queue/approval numbers, and
 * never infers a stop from balanced tool events. Facts come only from live callback contexts, never from
 * caller-supplied fact JSON.
 *
 * It holds no resources: no timer, watcher, filesystem, process, transcript, network, controller, or
 * rollover import. In-memory only: a restart or reload loses every fact. There is no thaw and no
 * transfer behavior.
 *
 * Conservative identity handling: an unknown, throwing, or malformed session read invalidates the prior
 * session-derived facts (settled confidence and tool-tracking health) and never revalidates them on the
 * next matching identity read; only a later trustworthy supported boundary can re-establish settled, and
 * only a native session change starts fresh tool tracking. Payload reads are guarded so a throwing or
 * proxy accessor is treated as malformed and still notifies subscribers.
 *
 * Notifications are delivered in chronological order under bounded reentrancy. If the bounded buffer or
 * per-drain budget is exceeded, delivery is lost; this is a sticky delivery gap. Rather than ending any
 * subscriber on an older healthy snapshot, the drain discards stale buffered facts and delivers one
 * terminal, conservative gap invalidation to every still-subscribed listener. The gap is sticky: while it
 * is unresolved every snapshot reports `notificationBacklogOverflow`, `settled: 'unknown'` and
 * `toolTrackingHealthy: false`, and no ordinary later event restores healthy confidence.
 *
 * Installed Pi 1.3.0 API pinned from the installed docs/examples (the package ships no .d.ts):
 *   docs/extensions.md (sha256:a2b5ff0f95e7e470ed0846d7c4fbfc5781fe7e694b8e7f51ea08859f3ad7325d):
 *   lifecycle events `session_start`, `before_agent_start` (a run becomes busy), `agent_settled`
 *   (final, "Pi will not continue automatically"), and nested `tool_execution_start` /
 *   `tool_execution_end` carrying a string `toolCallId` (`<parent id>/<n>` for nested calls); the
 *   running session is read from `ctx.sessionManager.getSessionId()` and idleness from `ctx.isIdle()`
 *   (examples/extensions/send-user-message.ts
 *   sha256:9261e433c782f354530105e1c9723a19798868f72fd1f5d68af3a4624ad7e446). The narrow structural
 *   host interface below matches that shape; structural compatibility is not a shipped-declaration or
 *   live-load proof.
 */

export const PI_NATIVE_EVENTS_SCHEMA = 'pappra/pi-native-events/1';

/** The only installed callbacks this producer subscribes. Nothing else is observed. */
export const SUPPORTED_CALLBACKS = Object.freeze([
  'session_start',
  'before_agent_start',
  'agent_settled',
  'tool_execution_start',
  'tool_execution_end',
] as const);

export type SupportedCallback = (typeof SUPPORTED_CALLBACKS)[number];

/** Explicit, non-inferable facts: there is no supported extension API for either. */
export type UnknownFact = 'unknown';

const MAX_ID_LENGTH = 256;
const DEFAULT_MAX_TRACKED_TOOLS = 4096;
const DEFAULT_MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
const DEFAULT_MAX_NOTIFY_QUEUE = 1024;

/**
 * Honest boundaries of these facts. Shared frozen; a snapshot exposes the same immutable array.
 */
export const NATIVE_EVENT_LIMITATIONS: readonly string[] = Object.freeze([
  'in_process_observations_only_not_authority_external_control_or_writer_fencing',
  'not_a_native_stop_quiescence_or_transfer_proof',
  'queue_depth_and_global_approvals_unknown_no_supported_extension_api',
  'in_flight_tool_completeness_unknown_observed_open_count_is_not_authoritative',
  'unknown_session_identity_invalidates_settled_and_tool_tracking_confidence',
  'notification_delivery_gap_delivers_a_terminal_invalidation_to_every_listener_and_stays_sticky',
  'does_not_observe_background_or_external_non_managed_tool_activity',
  'memory_only_facts_lost_on_restart_or_reload_no_thaw_no_transfer',
  'produces_facts_only_never_calls_controller_observe_or_asserts_readiness',
]);

/** A single subscribed callback handler, shaped like the installed `pi.on(event, handler)`. */
export type PiNativeCallbackHandler = (
  event: unknown,
  context: unknown,
) => void;

/** Narrow structural host: only `on` for the five supported callbacks is required. */
export interface PiNativeEventHost {
  on(event: SupportedCallback, handler: PiNativeCallbackHandler): void;
}

export interface NativeEventProducerOptions {
  /** The native session expected at registration; every callback re-derives identity from context. */
  readonly sessionId: string;
  /** Bound on tracked open tool ids; exceeding it marks tracking unhealthy (default 4096). */
  readonly maxTrackedTools?: number;
  /** Sequence saturation bound; reaching it stops advancement to avoid a replayable wrap. */
  readonly maxSequence?: number;
  /** Bound on buffered/drained reentrant notifications; exceeding it is a delivery gap (default 1024). */
  readonly maxNotifyQueue?: number;
}

/**
 * An immutable snapshot of derived facts. `settled`/`idle` are tri-state: a boolean only when cleanly
 * observed, else `'unknown'`. `observedOpenToolCount` is a local, non-authoritative observation; true
 * in-flight completeness is never established, so it is reported as `inFlightCompleteness: 'unknown'`.
 * Once `notificationBacklogOverflow` is set (a delivery gap), `settled` is forced to `'unknown'` and
 * `toolTrackingHealthy` to `false` and stays so for every later snapshot.
 */
export interface NativeFactsSnapshot {
  readonly schema: typeof PI_NATIVE_EVENTS_SCHEMA;
  /** Last identity read from a callback context; trust it only when `sessionKnown` is true. */
  readonly sessionId: string | null;
  readonly sessionKnown: boolean;
  readonly settled: boolean | UnknownFact;
  readonly idle: boolean | UnknownFact;
  /** Always `'unknown'`: no supported invariant establishes complete in-flight knowledge. */
  readonly inFlightCompleteness: UnknownFact;
  /** Count of tool ids observed open since the last clean session start; NOT a complete count. */
  readonly observedOpenToolCount: number;
  /**
   * False after any duplicate start, unmatched end, malformed/oversized id, tracking overflow, an
   * unknown-session interval, or a notification delivery gap. Only a native session change can reset the
   * tool-tracking causes; a delivery gap keeps it false.
   */
  readonly toolTrackingHealthy: boolean;
  readonly queue: UnknownFact;
  readonly approvals: UnknownFact;
  /** Never inferred from events; always false. */
  readonly nativeStop: false;
  /** Strictly increasing across every subscribed callback and session change until saturation. */
  readonly sequence: number;
  /** True once the sequence bound is reached; the sequence then stays fixed (no replayable wrap). */
  readonly sequenceSaturated: boolean;
  /** Sticky: true once notification delivery was lost; confidence is then permanently suspect. */
  readonly notificationBacklogOverflow: boolean;
  readonly limitations: readonly string[];
}

export interface NativeEventProducer {
  /** Current derived facts as an immutable snapshot. Never fed blindly into a controller. */
  snapshot(): NativeFactsSnapshot;
  /** Subscribe to invalidation; fires in chronological order after every callback. Returns unsubscribe. */
  onInvalidate(listener: (facts: NativeFactsSnapshot) => void): () => void;
}

function isSafeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH
  );
}

/** Pinned: the running session id is `ctx.sessionManager.getSessionId()`. Any failure stays unknown. */
function readSessionId(context: unknown): string | null {
  try {
    if (typeof context !== 'object' || context === null) return null;
    const manager = (context as { sessionManager?: unknown }).sessionManager;
    if (typeof manager !== 'object' || manager === null) return null;
    const getter = (manager as { getSessionId?: unknown }).getSessionId;
    if (typeof getter !== 'function') return null;
    const value = (getter as () => unknown).call(manager);
    return isSafeId(value) ? value : null;
  } catch {
    return null;
  }
}

/** Pinned: idleness is `ctx.isIdle()`. A throw, a missing method, or a non-boolean stays unknown. */
function readIdle(context: unknown): boolean | UnknownFact {
  try {
    if (typeof context !== 'object' || context === null) return 'unknown';
    const getter = (context as { isIdle?: unknown }).isIdle;
    if (typeof getter !== 'function') return 'unknown';
    const value = (getter as () => unknown).call(context);
    return typeof value === 'boolean' ? value : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * A tool event carries a string `toolCallId`. The property read is guarded: a throwing/proxy accessor or
 * any non-string is treated as malformed (returns null), never propagated into the host event path.
 */
function readToolCallId(event: unknown): string | null {
  try {
    if (typeof event !== 'object' || event === null) return null;
    const raw = (event as { toolCallId?: unknown }).toolCallId;
    return isSafeId(raw) ? raw : null;
  } catch {
    return null;
  }
}

class Producer implements NativeEventProducer {
  readonly #maxTrackedTools: number;
  readonly #maxSequence: number;
  readonly #maxNotifyQueue: number;
  readonly #openTools = new Set<string>();
  readonly #listeners = new Set<(facts: NativeFactsSnapshot) => void>();
  readonly #notifyQueue: NativeFactsSnapshot[] = [];

  #sessionId: string | null;
  #sessionKnown: boolean;
  #settled: boolean | UnknownFact = 'unknown';
  #idle: boolean | UnknownFact = 'unknown';
  #toolTrackingHealthy = true;
  #sequence = 0;
  #sequenceSaturated = false;
  #notificationOverflow = false;
  #overflowPending = false;
  #draining = false;

  constructor(options: NativeEventProducerOptions) {
    const seeded = isSafeId(options.sessionId) ? options.sessionId : null;
    this.#sessionId = seeded;
    this.#sessionKnown = seeded !== null;
    this.#maxTrackedTools = positiveIntOr(
      options.maxTrackedTools,
      DEFAULT_MAX_TRACKED_TOOLS,
    );
    this.#maxSequence = positiveIntOr(
      options.maxSequence,
      DEFAULT_MAX_SEQUENCE,
    );
    this.#maxNotifyQueue = positiveIntOr(
      options.maxNotifyQueue,
      DEFAULT_MAX_NOTIFY_QUEUE,
    );
  }

  handle(kind: SupportedCallback, event: unknown, context: unknown): void {
    // Every subscribed callback advances the sequence first, including malformed events, identity
    // failures, and session changes; the monotonic sequence is never reset by any of them.
    this.#advance();
    this.#applySession(context);
    this.#idle = readIdle(context);
    // Boundary and tool facts are applied only under a known, trustworthy identity. An unknown session
    // already invalidated settled and tool-tracking confidence in #applySession, so nothing is applied
    // and no unassociated event mutates the last session's tracked ids.
    if (this.#sessionKnown) {
      switch (kind) {
        case 'before_agent_start':
          this.#settled = false;
          break;
        case 'agent_settled':
          this.#settled = true;
          break;
        case 'tool_execution_start':
          this.#trackStart(event);
          break;
        case 'tool_execution_end':
          this.#trackEnd(event);
          break;
        case 'session_start':
          break;
      }
    }
    this.#enqueueNotify();
  }

  #advance(): void {
    if (this.#sequenceSaturated) return;
    if (this.#sequence >= this.#maxSequence) {
      this.#sequenceSaturated = true;
      return;
    }
    this.#sequence += 1;
    if (this.#sequence >= this.#maxSequence) this.#sequenceSaturated = true;
  }

  #applySession(context: unknown): void {
    const id = readSessionId(context);
    if (id === null) {
      // Unknown identity: invalidate prior session-derived facts rather than resurrecting them on a
      // later matching read. The last known id is retained only so a recovery is not mistaken for a
      // change; confidence stays invalidated until a trustworthy boundary or a real session change.
      this.#sessionKnown = false;
      this.#settled = 'unknown';
      this.#toolTrackingHealthy = false;
      return;
    }
    this.#sessionKnown = true;
    if (this.#sessionId !== id) {
      // Native session change: clear this session's facts and tracked ids, but never the sequence. A new
      // session is the only trustworthy reset of tracking health (a delivery gap, if any, stays sticky).
      this.#sessionId = id;
      this.#settled = 'unknown';
      this.#openTools.clear();
      this.#toolTrackingHealthy = true;
    }
  }

  #trackStart(event: unknown): void {
    const id = readToolCallId(event);
    if (id === null) {
      this.#toolTrackingHealthy = false;
      return;
    }
    if (this.#openTools.has(id)) {
      this.#toolTrackingHealthy = false;
      return;
    }
    if (this.#openTools.size >= this.#maxTrackedTools) {
      this.#toolTrackingHealthy = false;
      return;
    }
    this.#openTools.add(id);
  }

  #trackEnd(event: unknown): void {
    const id = readToolCallId(event);
    if (id === null) {
      this.#toolTrackingHealthy = false;
      return;
    }
    if (!this.#openTools.has(id)) {
      this.#toolTrackingHealthy = false;
      return;
    }
    this.#openTools.delete(id);
  }

  #markDeliveryGap(): void {
    // A delivery gap is sticky and owes a terminal, subscriber-visible loss notification this drain.
    this.#notificationOverflow = true;
    this.#overflowPending = true;
  }

  #deliver(facts: NativeFactsSnapshot): void {
    // Copy the listener set so subscription changes during delivery cannot corrupt the walk, and isolate
    // each listener so one throwing listener cannot starve the others or the producer.
    for (const listener of [...this.#listeners]) {
      try {
        listener(facts);
      } catch {
        // Listener isolation: swallow and continue.
      }
    }
  }

  #enqueueNotify(): void {
    if (this.#notifyQueue.length >= this.#maxNotifyQueue) {
      this.#markDeliveryGap();
    } else {
      this.#notifyQueue.push(this.snapshot());
    }
    if (this.#draining) return;
    this.#drain();
  }

  #drain(): void {
    this.#draining = true;
    try {
      // Serialize delivery so reentrant events do not interleave: each subscriber sees snapshots in
      // chronological sequence order. Delivery per drain is bounded to guarantee termination.
      let delivered = 0;
      while (this.#notifyQueue.length > 0) {
        // Once a gap exists, stop delivering stale buffered healthy facts.
        if (this.#overflowPending) break;
        if (delivered >= this.#maxNotifyQueue) {
          this.#markDeliveryGap();
          break;
        }
        const facts = this.#notifyQueue.shift();
        if (facts === undefined) break;
        this.#deliver(facts);
        delivered += 1;
      }
      if (this.#overflowPending) {
        // Terminal, subscriber-visible loss: discard stale buffered facts and deliver exactly one
        // conservative invalidation so every still-subscribed listener's final fact is the gap, never an
        // older healthy snapshot. Events fired reentrantly during this delivery are dropped (bounded);
        // the sticky overflow keeps every later snapshot invalid, so no further drain is started here.
        this.#overflowPending = false;
        this.#notifyQueue.length = 0;
        this.#deliver(this.snapshot());
        this.#notifyQueue.length = 0;
        this.#overflowPending = false;
      }
    } finally {
      this.#draining = false;
    }
  }

  snapshot(): NativeFactsSnapshot {
    // A sticky delivery gap forces conservative confidence; no ordinary later event restores it.
    const gap = this.#notificationOverflow;
    const facts: NativeFactsSnapshot = {
      schema: PI_NATIVE_EVENTS_SCHEMA,
      sessionId: this.#sessionId,
      sessionKnown: this.#sessionKnown,
      settled: gap ? 'unknown' : this.#settled,
      idle: this.#idle,
      inFlightCompleteness: 'unknown',
      observedOpenToolCount: this.#openTools.size,
      toolTrackingHealthy: this.#toolTrackingHealthy && !gap,
      queue: 'unknown',
      approvals: 'unknown',
      nativeStop: false,
      sequence: this.#sequence,
      sequenceSaturated: this.#sequenceSaturated,
      notificationBacklogOverflow: gap,
      limitations: NATIVE_EVENT_LIMITATIONS,
    };
    return Object.freeze(facts);
  }

  onInvalidate(listener: (facts: NativeFactsSnapshot) => void): () => void {
    this.#listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#listeners.delete(listener);
    };
  }
}

function positiveIntOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

/**
 * Subscribe a fresh producer to the five supported callbacks on `pi`. It only touches the supplied
 * host (`pi.on`); it starts, installs, exports, and wires nothing else. The returned producer yields
 * observations and invalidation notifications only — never authority, control, or a stop proof.
 */
export function registerPiNativeEvents(
  pi: PiNativeEventHost,
  options: NativeEventProducerOptions,
): NativeEventProducer {
  const producer = new Producer(options);
  for (const callback of SUPPORTED_CALLBACKS) {
    pi.on(callback, (event, context) => {
      producer.handle(callback, event, context);
    });
  }
  return producer;
}
