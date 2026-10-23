import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NATIVE_EVENT_LIMITATIONS,
  registerPiNativeEvents,
  type NativeEventProducer,
  type NativeFactsSnapshot,
  type PiNativeCallbackHandler,
  type PiNativeEventHost,
  type SupportedCallback,
} from '../../src/hosts/integration/pi-native-events.js';

const SESSION_A = 'sess-A';
const SESSION_B = 'sess-B';

/** A host that records subscribed handlers and replays callbacks with real (event, context) args. */
class FakeHost implements PiNativeEventHost {
  readonly #handlers = new Map<SupportedCallback, PiNativeCallbackHandler[]>();

  on(event: SupportedCallback, handler: PiNativeCallbackHandler): void {
    const list = this.#handlers.get(event) ?? [];
    list.push(handler);
    this.#handlers.set(event, list);
  }

  fire(event: SupportedCallback, payload: unknown, context: unknown): void {
    for (const handler of this.#handlers.get(event) ?? [])
      handler(payload, context);
  }
}

interface ContextOptions {
  readonly idle?: boolean;
  readonly throwSession?: boolean;
  readonly throwIdle?: boolean;
  readonly noSessionManager?: boolean;
  readonly noIsIdle?: boolean;
}

/** Build a host-shaped context exposing sessionManager.getSessionId() and isIdle(). */
function hostContext(
  sessionId: string | null,
  options: ContextOptions = {},
): unknown {
  const sessionManager = options.noSessionManager
    ? undefined
    : {
        getSessionId: (): string | null => {
          if (options.throwSession) throw new Error('getSessionId failed');
          return sessionId;
        },
      };
  const isIdle = options.noIsIdle
    ? undefined
    : (): boolean => {
        if (options.throwIdle) throw new Error('isIdle failed');
        return options.idle ?? true;
      };
  return { sessionManager, isIdle };
}

function toolEvent(toolCallId: unknown): unknown {
  return { toolCallId };
}

function setup(
  sessionId = SESSION_A,
  options?: {
    maxTrackedTools?: number;
    maxSequence?: number;
    maxNotifyQueue?: number;
  },
): {
  host: FakeHost;
  producer: NativeEventProducer;
} {
  const host = new FakeHost();
  const producer = registerPiNativeEvents(host, {
    sessionId,
    ...(options?.maxTrackedTools !== undefined
      ? { maxTrackedTools: options.maxTrackedTools }
      : {}),
    ...(options?.maxSequence !== undefined
      ? { maxSequence: options.maxSequence }
      : {}),
    ...(options?.maxNotifyQueue !== undefined
      ? { maxNotifyQueue: options.maxNotifyQueue }
      : {}),
  });
  return { host, producer };
}

function assertNonAuthority(snapshot: NativeFactsSnapshot): void {
  assert.equal(snapshot.queue, 'unknown');
  assert.equal(snapshot.approvals, 'unknown');
  assert.equal(snapshot.nativeStop, false);
  assert.equal(snapshot.inFlightCompleteness, 'unknown');
}

test('initial registration is conservative with no falsely complete zero', () => {
  const { producer } = setup();
  const snapshot = producer.snapshot();
  assert.equal(snapshot.sessionKnown, true);
  assert.equal(snapshot.sessionId, SESSION_A);
  assert.equal(snapshot.settled, 'unknown');
  assert.equal(snapshot.idle, 'unknown');
  assert.equal(snapshot.observedOpenToolCount, 0);
  // A zero observed count is paired with unknown completeness, never presented as complete.
  assertNonAuthority(snapshot);
  assert.equal(snapshot.sequence, 0);
  assert.equal(snapshot.sequenceSaturated, false);
});

test('event ordering: sequence bumps once per callback and settled toggles on boundaries', () => {
  const { host, producer } = setup();
  host.fire('session_start', {}, hostContext(SESSION_A));
  assert.equal(producer.snapshot().sequence, 1);
  host.fire('before_agent_start', {}, hostContext(SESSION_A, { idle: false }));
  let snapshot = producer.snapshot();
  assert.equal(snapshot.sequence, 2);
  assert.equal(snapshot.settled, false);
  assert.equal(snapshot.idle, false);
  host.fire(
    'tool_execution_start',
    toolEvent('call-1'),
    hostContext(SESSION_A, { idle: false }),
  );
  assert.equal(producer.snapshot().observedOpenToolCount, 1);
  host.fire('agent_settled', {}, hostContext(SESSION_A, { idle: true }));
  snapshot = producer.snapshot();
  assert.equal(snapshot.sequence, 4);
  assert.equal(snapshot.settled, true);
  assert.equal(snapshot.idle, true);
  host.fire('tool_execution_end', toolEvent('call-1'), hostContext(SESSION_A));
  snapshot = producer.snapshot();
  assert.equal(snapshot.observedOpenToolCount, 0);
  assert.equal(snapshot.toolTrackingHealthy, true);
  assertNonAuthority(snapshot);
});

test('sequence is strictly monotonic across a native session change and is never reset', () => {
  const { host, producer } = setup();
  host.fire('before_agent_start', {}, hostContext(SESSION_A));
  host.fire('agent_settled', {}, hostContext(SESSION_A));
  const before = producer.snapshot();
  assert.equal(before.sequence, 2);
  assert.equal(before.settled, true);
  host.fire('session_start', {}, hostContext(SESSION_B));
  const after = producer.snapshot();
  assert.equal(after.sequence, 3); // continued, not reset
  assert.equal(after.sessionId, SESSION_B);
  assert.equal(after.settled, 'unknown'); // prior session facts cleared
});

test('session drift clears tracked tools but keeps the monotonic sequence', () => {
  const { host, producer } = setup();
  host.fire('tool_execution_start', toolEvent('a'), hostContext(SESSION_A));
  host.fire('tool_execution_start', toolEvent('b'), hostContext(SESSION_A));
  assert.equal(producer.snapshot().observedOpenToolCount, 2);
  const seqBefore = producer.snapshot().sequence;
  host.fire('before_agent_start', {}, hostContext(SESSION_B));
  const snapshot = producer.snapshot();
  assert.equal(snapshot.observedOpenToolCount, 0); // cleared on drift
  assert.equal(snapshot.toolTrackingHealthy, true); // reset clean for the new session
  assert.equal(snapshot.sequence, seqBefore + 1);
  assert.equal(snapshot.sessionId, SESSION_B);
});

test('a late settled boundary records settled while in-flight completeness stays unknown', () => {
  const { host, producer } = setup();
  // No prior before_agent_start/tool history: completeness cannot be established.
  host.fire('agent_settled', {}, hostContext(SESSION_A));
  const snapshot = producer.snapshot();
  assert.equal(snapshot.settled, true);
  assert.equal(snapshot.inFlightCompleteness, 'unknown');
  assert.equal(snapshot.observedOpenToolCount, 0);
  assertNonAuthority(snapshot);
});

test('tools are keyed by id, supporting concurrent and nested ids', () => {
  const { host, producer } = setup();
  host.fire(
    'tool_execution_start',
    toolEvent('parent'),
    hostContext(SESSION_A),
  );
  host.fire('tool_execution_start', toolEvent('other'), hostContext(SESSION_A));
  host.fire(
    'tool_execution_start',
    toolEvent('parent/0'),
    hostContext(SESSION_A),
  ); // nested id
  host.fire('tool_execution_end', toolEvent('other'), hostContext(SESSION_A));
  const snapshot = producer.snapshot();
  assert.equal(snapshot.observedOpenToolCount, 2); // parent and parent/0 remain open
  assert.equal(snapshot.toolTrackingHealthy, true);
});

test('duplicate starts and unmatched ends mark tracking unhealthy without a false zero', () => {
  const dup = setup();
  dup.host.fire('tool_execution_start', toolEvent('x'), hostContext(SESSION_A));
  dup.host.fire('tool_execution_start', toolEvent('x'), hostContext(SESSION_A));
  let snapshot = dup.producer.snapshot();
  assert.equal(snapshot.toolTrackingHealthy, false);
  assert.equal(snapshot.observedOpenToolCount, 1);

  const unmatched = setup();
  unmatched.host.fire(
    'tool_execution_end',
    toolEvent('never-started'),
    hostContext(SESSION_A),
  );
  snapshot = unmatched.producer.snapshot();
  assert.equal(snapshot.toolTrackingHealthy, false);
  assert.equal(snapshot.observedOpenToolCount, 0);
  assertNonAuthority(snapshot);
});

test('malformed and oversized tool ids are untracked and lower tracking health; sequence still bumps', () => {
  const { host, producer } = setup();
  const oversized = 'o'.repeat(300);
  for (const bad of [undefined, 42, '', oversized, null]) {
    host.fire('tool_execution_start', toolEvent(bad), hostContext(SESSION_A));
  }
  host.fire('tool_execution_start', {}, hostContext(SESSION_A)); // missing toolCallId entirely
  const snapshot = producer.snapshot();
  assert.equal(snapshot.observedOpenToolCount, 0);
  assert.equal(snapshot.toolTrackingHealthy, false);
  assert.equal(snapshot.sequence, 6); // every malformed callback still advanced the sequence
});

test('tracking overflow is bounded and marks health, never growing past the bound', () => {
  const { host, producer } = setup(SESSION_A, { maxTrackedTools: 2 });
  host.fire('tool_execution_start', toolEvent('a'), hostContext(SESSION_A));
  host.fire('tool_execution_start', toolEvent('b'), hostContext(SESSION_A));
  assert.equal(producer.snapshot().toolTrackingHealthy, true);
  host.fire('tool_execution_start', toolEvent('c'), hostContext(SESSION_A)); // overflow
  const snapshot = producer.snapshot();
  assert.equal(snapshot.observedOpenToolCount, 2); // c not added
  assert.equal(snapshot.toolTrackingHealthy, false);
});

test('sequence saturates at its bound and does not wrap into a replayable value', () => {
  const { host, producer } = setup(SESSION_A, { maxSequence: 3 });
  for (let i = 0; i < 3; i += 1)
    host.fire('session_start', {}, hostContext(SESSION_A));
  let snapshot = producer.snapshot();
  assert.equal(snapshot.sequence, 3);
  assert.equal(snapshot.sequenceSaturated, true);
  host.fire('session_start', {}, hostContext(SESSION_A));
  host.fire('before_agent_start', {}, hostContext(SESSION_A));
  snapshot = producer.snapshot();
  assert.equal(snapshot.sequence, 3); // fixed, not reused or wrapped
  assert.equal(snapshot.sequenceSaturated, true);
});

test('throwing or missing context methods stay unknown and are never coerced to idle/settled', () => {
  const { host, producer } = setup();
  host.fire('before_agent_start', {}, hostContext(SESSION_A)); // settled becomes false, session known
  host.fire('agent_settled', {}, hostContext(SESSION_A, { throwIdle: true }));
  let snapshot = producer.snapshot();
  assert.equal(snapshot.settled, true); // a clean settled boundary still recorded
  assert.equal(snapshot.idle, 'unknown'); // throwing isIdle is not coerced to a boolean

  host.fire(
    'tool_execution_start',
    toolEvent('z'),
    hostContext(SESSION_A, { throwSession: true }),
  );
  snapshot = producer.snapshot();
  assert.equal(snapshot.sessionKnown, false); // failed session read lowers confidence
  assert.equal(snapshot.sequence, 3); // malformed context still advanced the sequence

  const missing = setup();
  missing.host.fire(
    'agent_settled',
    {},
    hostContext(SESSION_A, { noSessionManager: true, noIsIdle: true }),
  );
  snapshot = missing.producer.snapshot();
  assert.equal(snapshot.sessionKnown, false);
  assert.equal(snapshot.idle, 'unknown');
  assert.equal(snapshot.settled, 'unknown'); // never coerced to settled without a known session
  assertNonAuthority(snapshot);
});

test('snapshots are frozen point-in-time copies independent of later events', () => {
  const { host, producer } = setup();
  host.fire('session_start', {}, hostContext(SESSION_A));
  const first = producer.snapshot();
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.limitations), true);
  host.fire('session_start', {}, hostContext(SESSION_A));
  const second = producer.snapshot();
  assert.equal(first.sequence, 1); // the earlier snapshot is unaffected
  assert.equal(second.sequence, 2);
  assert.notEqual(first, second);
});

test('limitations express the non-authority and no-stop contract', () => {
  const snapshot = setup().producer.snapshot();
  assert.ok(snapshot.limitations.length > 0);
  assert.equal(snapshot.limitations, NATIVE_EVENT_LIMITATIONS);
  assert.ok(
    snapshot.limitations.some((item) => item.includes('not_authority')),
  );
  assert.ok(
    snapshot.limitations.some((item) => item.includes('not_a_native_stop')),
  );
  assert.ok(
    snapshot.limitations.some((item) =>
      item.includes('never_calls_controller_observe'),
    ),
  );
});

test('listeners are isolated and reentrancy-safe, and every callback invalidates', () => {
  const { host, producer } = setup();
  const seen: number[] = [];
  let unsubscribeSecond = (): void => {};
  producer.onInvalidate(() => {
    throw new Error('first listener always throws');
  });
  producer.onInvalidate((facts) => {
    seen.push(facts.sequence);
  });
  // A reentrant listener that unsubscribes itself mid-notification must not corrupt the walk.
  unsubscribeSecond = producer.onInvalidate(() => {
    unsubscribeSecond();
  });
  host.fire('session_start', {}, hostContext(SESSION_A));
  host.fire('before_agent_start', {}, hostContext(SESSION_A));
  // Despite the throwing first listener, the recording listener received both invalidations.
  assert.deepEqual(seen, [1, 2]);
});

test('unsubscribe stops further invalidations for that listener only', () => {
  const { host, producer } = setup();
  const kept: number[] = [];
  const dropped: number[] = [];
  producer.onInvalidate((facts) => kept.push(facts.sequence));
  const stop = producer.onInvalidate((facts) => dropped.push(facts.sequence));
  host.fire('session_start', {}, hostContext(SESSION_A));
  stop();
  stop(); // idempotent
  host.fire('session_start', {}, hostContext(SESSION_A));
  assert.deepEqual(kept, [1, 2]);
  assert.deepEqual(dropped, [1]);
});

test('queue, approvals, native stop and completeness stay unknown or false in every state', () => {
  const { host, producer } = setup(SESSION_A, { maxSequence: 2 });
  assertNonAuthority(producer.snapshot()); // initial
  host.fire('tool_execution_start', toolEvent('a'), hostContext(SESSION_A));
  assertNonAuthority(producer.snapshot()); // with an open tool
  host.fire('tool_execution_end', toolEvent('missing'), hostContext(SESSION_A)); // anomaly
  assertNonAuthority(producer.snapshot());
  host.fire('agent_settled', {}, hostContext(SESSION_A)); // settled + saturated
  const snapshot = producer.snapshot();
  assert.equal(snapshot.sequenceSaturated, true);
  assertNonAuthority(snapshot); // balanced/settled events never imply a stop or completeness
});

// --- R1 repair regressions: the four independent callback counterexamples ---

test('settled does not resurrect after an unknown-session interval; sequence stays monotonic', () => {
  const { host, producer } = setup();
  host.fire('agent_settled', {}, hostContext(SESSION_A));
  assert.equal(producer.snapshot().settled, true);
  const seqSettled = producer.snapshot().sequence;
  // Unknown-identity interval: settled confidence and tracking health are invalidated.
  host.fire(
    'before_agent_start',
    {},
    hostContext(SESSION_A, { throwSession: true }),
  );
  let snapshot = producer.snapshot();
  assert.equal(snapshot.sessionKnown, false);
  assert.equal(snapshot.settled, 'unknown');
  assert.equal(snapshot.toolTrackingHealthy, false);
  assert.equal(snapshot.sequence, seqSettled + 1); // monotonic across the identity failure
  // A later matching identity read alone must NOT revalidate the old settled fact.
  host.fire('session_start', {}, hostContext(SESSION_A));
  snapshot = producer.snapshot();
  assert.equal(snapshot.sessionKnown, true);
  assert.equal(snapshot.settled, 'unknown'); // no resurrection without a fresh boundary
  // Only a later trustworthy supported boundary re-establishes settled.
  host.fire('agent_settled', {}, hostContext(SESSION_A));
  assert.equal(producer.snapshot().settled, true);
});

test('unknown-session tool events never mutate the last session inventory', () => {
  const { host, producer } = setup();
  host.fire('tool_execution_start', toolEvent('a'), hostContext(SESSION_A));
  assert.equal(producer.snapshot().observedOpenToolCount, 1);
  // A start and an end observed under an unknown session must not touch the tracked ids.
  host.fire(
    'tool_execution_start',
    toolEvent('b'),
    hostContext(SESSION_A, { throwSession: true }),
  );
  host.fire(
    'tool_execution_end',
    toolEvent('a'),
    hostContext(SESSION_A, { throwSession: true }),
  );
  const snapshot = producer.snapshot();
  assert.equal(snapshot.observedOpenToolCount, 1); // 'b' not added, 'a' not removed
  assert.equal(snapshot.sessionKnown, false);
  assert.equal(snapshot.toolTrackingHealthy, false); // confidence invalidated, not retained healthy
});

test('a throwing toolCallId getter is caught at the boundary and still notifies subscribers', () => {
  const { host, producer } = setup();
  const seen: number[] = [];
  producer.onInvalidate((facts) => seen.push(facts.sequence));
  const evil = {};
  Object.defineProperty(evil, 'toolCallId', {
    enumerable: true,
    get() {
      throw new Error('accessor explodes');
    },
  });
  host.fire('tool_execution_start', evil, hostContext(SESSION_A));
  const snapshot = producer.snapshot();
  assert.equal(snapshot.toolTrackingHealthy, false); // malformed accessor invalidates tool confidence
  assert.equal(snapshot.observedOpenToolCount, 0);
  assert.deepEqual(seen, [1]); // the notification was delivered, not skipped
});

test('reentrant callbacks deliver notifications to every subscriber in chronological order', () => {
  const { host, producer } = setup();
  const order: number[] = [];
  let reentered = false;
  // Listener one triggers a second host event while the first notification is being delivered.
  producer.onInvalidate(() => {
    if (!reentered) {
      reentered = true;
      host.fire('before_agent_start', {}, hostContext(SESSION_A));
    }
  });
  // Listener two must observe sequence 1 before sequence 2, never the reverse.
  producer.onInvalidate((facts) => {
    order.push(facts.sequence);
  });
  host.fire('session_start', {}, hostContext(SESSION_A));
  assert.deepEqual(order, [1, 2]);
});

test('a bounded reentrant flood overflows the buffer and invalidates confidence, not stale facts', () => {
  const { host, producer } = setup(SESSION_A, { maxNotifyQueue: 3 });
  host.fire('agent_settled', {}, hostContext(SESSION_A)); // settled true before any listener/flood
  assert.equal(producer.snapshot().settled, true);
  let fires = 0;
  producer.onInvalidate(() => {
    if (fires < 12) {
      fires += 1;
      host.fire('session_start', {}, hostContext(SESSION_A));
    }
  });
  host.fire('session_start', {}, hostContext(SESSION_A)); // kicks off a bounded reentrant flood
  const snapshot = producer.snapshot();
  assert.equal(snapshot.notificationBacklogOverflow, true);
  assert.equal(snapshot.toolTrackingHealthy, false); // confidence invalidated
  assert.equal(snapshot.settled, 'unknown'); // not left as a stale healthy fact
  assertNonAuthority(snapshot);
});

// --- R2 repair regressions: subscriber-visible delivery-gap invalidation ---

test('a queue-capacity gap ends every subscriber on a visible invalidation, not a stale healthy fact', () => {
  const { host, producer } = setup(SESSION_A, { maxNotifyQueue: 2 });
  const received: NativeFactsSnapshot[] = [];
  let burst = false;
  // Listener one bursts several events in a single call while sequence 1 is being delivered.
  producer.onInvalidate(() => {
    if (!burst) {
      burst = true;
      for (let i = 0; i < 6; i += 1) {
        host.fire('agent_settled', {}, hostContext(SESSION_A));
      }
    }
  });
  // Listener two records every fact it receives; its final fact must be the gap invalidation.
  producer.onInvalidate((facts) => {
    received.push(facts);
  });
  host.fire('agent_settled', {}, hostContext(SESSION_A));
  const last = received.at(-1);
  assert.ok(last);
  assert.equal(last.notificationBacklogOverflow, true);
  assert.equal(last.toolTrackingHealthy, false);
  assert.equal(last.settled, 'unknown');
});

test('a per-drain budget gap ends every subscriber on a visible invalidation', () => {
  const { host, producer } = setup(SESSION_A, { maxNotifyQueue: 3 });
  const received: NativeFactsSnapshot[] = [];
  let fires = 0;
  // One next event per callback, a finite total — the per-drain budget drops the remainder.
  producer.onInvalidate((facts) => {
    received.push(facts);
    if (fires < 5) {
      fires += 1;
      host.fire('session_start', {}, hostContext(SESSION_A));
    }
  });
  host.fire('session_start', {}, hostContext(SESSION_A));
  const last = received.at(-1);
  assert.ok(last);
  assert.equal(last.notificationBacklogOverflow, true);
  assert.equal(last.toolTrackingHealthy, false);
  assert.equal(last.settled, 'unknown');
});

test('reentrant events during the terminal loss notification stay bounded and end invalid', () => {
  const { host, producer } = setup(SESSION_A, { maxNotifyQueue: 2 });
  let lossDeliveries = 0;
  let totalCalls = 0;
  producer.onInvalidate((facts) => {
    totalCalls += 1;
    if (facts.notificationBacklogOverflow) {
      lossDeliveries += 1;
      // Firing during the loss notification must not cause an unbounded re-notification loop.
      host.fire('session_start', {}, hostContext(SESSION_A));
    } else if (totalCalls === 1) {
      // Burst beyond the bounded buffer on the first healthy delivery to force a gap.
      for (let i = 0; i < 4; i += 1) {
        host.fire('agent_settled', {}, hostContext(SESSION_A));
      }
    }
  });
  host.fire('agent_settled', {}, hostContext(SESSION_A));
  assert.ok(lossDeliveries >= 1); // the invalidation was delivered
  assert.ok(totalCalls < 50); // bounded work, no infinite recursion
  const snapshot = producer.snapshot();
  assert.equal(snapshot.notificationBacklogOverflow, true);
  assert.equal(snapshot.toolTrackingHealthy, false);
  assert.equal(snapshot.settled, 'unknown');
});

test('a delivery gap is sticky: a later ordinary event does not restore healthy confidence', () => {
  const { host, producer } = setup(SESSION_A, { maxNotifyQueue: 2 });
  let burst = false;
  producer.onInvalidate(() => {
    if (!burst) {
      burst = true;
      for (let i = 0; i < 5; i += 1) {
        host.fire('agent_settled', {}, hostContext(SESSION_A));
      }
    }
  });
  host.fire('agent_settled', {}, hostContext(SESSION_A)); // triggers a gap
  assert.equal(producer.snapshot().notificationBacklogOverflow, true);
  // A clean session change plus a fresh settled boundary must NOT clear the sticky gap.
  host.fire('session_start', {}, hostContext(SESSION_B));
  host.fire('agent_settled', {}, hostContext(SESSION_B));
  const snapshot = producer.snapshot();
  assert.equal(snapshot.notificationBacklogOverflow, true); // sticky
  assert.equal(snapshot.toolTrackingHealthy, false); // not restored
  assert.equal(snapshot.settled, 'unknown'); // not restored to true
});
