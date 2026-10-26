/**
 * Opt-in in-session Pi managed-tool freeze (rollover prerequisite).
 *
 * A separately opt-in Pi extension/controller: a later explicit integration calls
 * `registerPiRolloverFreeze(pi, …)` inside a managed interactive session. This module does NOT
 * activate in the current session, install itself, change default lifecycle hooks or touch user
 * settings. It is self-contained: no subprocess, model, network, transcript, file watcher, timer,
 * automatic handoff or successor launch, and no imports of the rollover orchestrator.
 *
 * What it is: a fail-closed managed Pi tool barrier. While latched it BLOCKS every tool except an
 * explicit, vetted native read allowlist. Only tools in a fixed vetted read-tool universe can be
 * allow-listed; bash/write/edit and every unknown/custom tool are blocked regardless of
 * configuration. It never parses shell commands or tool paths and never calls a shell.
 *
 * What it is NOT: an OS sandbox, a stop proof, or an authority control. Pre-existing/background
 * processes and external writers are outside it. A freeze latch alone is not "confirmed stopped".
 * Native settled/queue/in-flight/approval facts are caller-supplied, UNAUTHENTICATED observations,
 * never host-verified; any unknown/busy/pending condition and any session change or tool activity
 * yield not-ready. Each readiness snapshot must be a complete coherent observation; absent facts are
 * unknown, never an inherited historical all-clear. The latch is memory-only: a restart/reload loses
 * it. There is intentionally NO thaw: recovery/release is a later, separately scoped,
 * authority-checked integration.
 *
 * Installed Pi 1.3.0 API pinned from the Pi package's own example extensions (the package ships no .d.ts):
 *   permission-gate.ts (sha256:e32086ba9dd9b4ba0fd308b65241d9affa0b5ecd3f90ef7ea1b9f2b30cab8cc1),
 *   protected-paths.ts (sha256:9ca66b1f3b1b9a61cc5ddc660f92cca2ea66c4264a1bdb6b00e0da5844399fe2),
 *   commands.ts        (sha256:36716b53da169936c7e1360a4fde1e2fc0c3356a6505f177235f09c5538c6e4f),
 *   docs/extensions.md (sha256:a2b5ff0f95e7e470ed0846d7c4fbfc5781fe7e694b8e7f51ea08859f3ad7325d):
 *   `pi.on("tool_call", async (event, ctx) => { … return { block: true, reason }; }` [allow: return
 *   undefined] with `event.toolName: string` and `event.input: Record<string, unknown>`;
 *   `pi.registerCommand(name, { description, handler })`; and the running session is read from
 *   `ctx.sessionManager.getSessionId()`. The narrow structural `PiFreezeHost` interface matches that
 *   shape. Structural compatibility checks are NOT a shipped-declaration or live-load proof.
 */

export const PI_ROLLOVER_FREEZE_STATUS_SCHEMA =
  'pappra/pi-rollover-freeze-status/1';

/**
 * The fixed vetted native read-tool universe. Only these may ever be allow-listed while latched.
 * Pi 1.3.0 built-in tools are read/bash/edit/write; `read` is the only read-only one. `bash` can
 * read but also write, so it is deliberately excluded; write/edit/unknown/custom are never allowed.
 */
export const VETTED_NATIVE_READ_TOOLS: readonly string[] = Object.freeze([
  'read',
]);

/** Default allowlist (the full vetted read universe). A caller may only narrow within the vetted set. */
export const DEFAULT_READ_TOOL_ALLOWLIST: readonly string[] = Object.freeze([
  ...VETTED_NATIVE_READ_TOOLS,
]);

const MAX_ID_LENGTH = 256;
const MAX_OBSERVED_COUNT = 1_000_000;

export interface FreezeToken {
  readonly sessionId: string;
  readonly taskId: string;
  readonly handoffId: string;
  readonly generation: number;
}

export type FreezeOutcome =
  | {
      readonly ok: true;
      readonly state: 'frozen' | 'already_frozen';
      readonly idempotent: boolean;
      readonly token: FreezeToken;
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'invalid_token'
        | 'wrong_session'
        | 'conflicting_freeze'
        | 'stale_generation';
      readonly detail: string;
    };

export interface ToolDecision {
  readonly block: boolean;
  readonly reason: string | null;
}

/**
 * One caller-supplied, UNAUTHENTICATED native observation. It must carry the full freeze token and
 * is a COMPLETE snapshot; an omitted count/flag is treated as unknown, never an inherited fact.
 */
export interface NativeObservation {
  readonly token: FreezeToken;
  readonly sequence: number;
  readonly settled?: boolean;
  readonly queuedMessages?: number;
  readonly inFlightTools?: number;
  readonly pendingApprovals?: number;
}

export type ObserveOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | 'not_frozen'
        | 'token_mismatch'
        | 'invalid_observation'
        | 'stale_sequence';
      readonly detail: string;
    };

export interface FreezeNativeStatus {
  readonly settled: 'yes' | 'no' | 'unknown';
  readonly queuedMessages: number | 'unknown';
  readonly inFlightTools: number | 'unknown';
  readonly pendingApprovals: number | 'unknown';
  readonly observedSequence: number | null;
}

export interface FreezeStatus {
  readonly schema: typeof PI_ROLLOVER_FREEZE_STATUS_SCHEMA;
  readonly sessionId: string;
  readonly frozen: boolean;
  readonly token: FreezeToken | null;
  readonly native: FreezeNativeStatus;
  /** The replay fence: the last accepted observation sequence, surviving readiness invalidation. */
  readonly lastAcceptedSequence: number | null;
  /** True only when frozen AND every native fact is a fresh caller-supplied advisory all-clear snapshot (not authoritative live-native facts). */
  readonly ready: boolean;
  readonly readyBlockers: readonly string[];
  /** Readiness is advisory: observations are caller-supplied and unauthenticated, not a stop proof. */
  readonly observationSource: 'caller-supplied-unauthenticated';
  readonly readinessIsNativeStopProof: false;
  readonly thawSupported: false;
  readonly limitations: readonly string[];
}

export interface RolloverFreezeOptions {
  /** The native session this controller is bound to; freeze tokens and callbacks must match it. */
  readonly sessionId: string;
  /** Narrowing selection within the vetted read universe; unsafe names are dropped conservatively. */
  readonly readAllowlist?: readonly string[];
}

const LIMITATIONS: readonly string[] = Object.freeze([
  'memory_only_latch_lost_on_restart_or_reload',
  'managed_pi_tool_barrier_not_os_sandbox',
  'preexisting_or_background_or_external_writers_not_fenced',
  'observations_caller_supplied_unauthenticated_not_a_native_stop_proof',
  'readiness_from_persistent_caller_data_is_not_live_quiescence_revalidation_required',
  'freeze_latch_alone_is_not_confirmed_stopped',
  'no_thaw_recovery_pending_separate_authority_checked_integration',
]);

function isSafeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH
  );
}

function isSafeGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isValidToken(value: unknown): value is FreezeToken {
  if (value === null || typeof value !== 'object') return false;
  const t = value as Record<string, unknown>;
  return (
    isSafeId(t['sessionId']) &&
    isSafeId(t['taskId']) &&
    isSafeId(t['handoffId']) &&
    isSafeGeneration(t['generation'])
  );
}

function isSafeCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_OBSERVED_COUNT
  );
}

function sameToken(a: FreezeToken, b: FreezeToken): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.taskId === b.taskId &&
    a.handoffId === b.handoffId &&
    a.generation === b.generation
  );
}

function copyToken(token: FreezeToken): FreezeToken {
  return Object.freeze({
    sessionId: token.sessionId,
    taskId: token.taskId,
    handoffId: token.handoffId,
    generation: token.generation,
  });
}

function unknownNative(): FreezeNativeStatus {
  return {
    settled: 'unknown',
    queuedMessages: 'unknown',
    inFlightTools: 'unknown',
    pendingApprovals: 'unknown',
    observedSequence: null,
  };
}

/**
 * In-memory, no-I/O freeze controller. One instance per managed session; the `pi` registration
 * wires it to `tool_call` and the freeze/status commands. A fresh instance starts UNPROVEN
 * (not frozen, not ready). There is no thaw.
 */
export class RolloverFreezeController {
  readonly #sessionId: string;
  readonly #allow: ReadonlySet<string>;
  #active: FreezeToken | null = null;
  #native: FreezeNativeStatus = unknownNative();
  /** Monotonic last-accepted observation sequence: the replay fence. Readiness invalidation,
   * tool activity, a session mismatch and an idempotent freeze reuse never reset it. */
  #lastAcceptedSequence: number | null = null;

  constructor(options: RolloverFreezeOptions) {
    if (!isSafeId(options.sessionId)) {
      throw new RangeError(
        'RolloverFreezeController requires a non-empty session id',
      );
    }
    this.#sessionId = options.sessionId;
    // Vet the allowlist against the fixed read universe; unsafe names are dropped.
    const requested = options.readAllowlist ?? DEFAULT_READ_TOOL_ALLOWLIST;
    const vetted = new Set(VETTED_NATIVE_READ_TOOLS);
    this.#allow = new Set(requested.filter((name) => vetted.has(name)));
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get frozen(): boolean {
    return this.#active !== null;
  }

  freeze(token: FreezeToken): FreezeOutcome {
    if (!isValidToken(token)) {
      return {
        ok: false,
        reason: 'invalid_token',
        detail: 'token fields are invalid',
      };
    }
    if (token.sessionId !== this.#sessionId) {
      return {
        ok: false,
        reason: 'wrong_session',
        detail: `token session ${token.sessionId} is not the bound session ${this.#sessionId}`,
      };
    }
    if (this.#active) {
      if (sameToken(this.#active, token)) {
        return {
          ok: true,
          state: 'already_frozen',
          idempotent: true,
          token: copyToken(this.#active),
        };
      }
      if (
        token.handoffId === this.#active.handoffId &&
        token.generation < this.#active.generation
      ) {
        return {
          ok: false,
          reason: 'stale_generation',
          detail: `generation ${token.generation} is older than active ${this.#active.generation}`,
        };
      }
      return {
        ok: false,
        reason: 'conflicting_freeze',
        detail: `an active freeze (${this.#active.handoffId}#${this.#active.generation}) already holds this session`,
      };
    }
    this.#active = copyToken(token);
    this.#native = unknownNative();
    this.#lastAcceptedSequence = null;
    return {
      ok: true,
      state: 'frozen',
      idempotent: false,
      token: copyToken(this.#active),
    };
  }

  /**
   * The fail-closed tool barrier, revalidating the live session on every call. A wrong/missing/
   * changed context session invalidates readiness and fails closed while latched; any tool activity
   * invalidates a prior all-clear so it cannot be reused without a fresh observation.
   */
  decideToolCall(
    toolName: unknown,
    contextSessionId: string | null,
  ): ToolDecision {
    if (contextSessionId !== this.#sessionId) {
      this.invalidateReadiness();
      if (this.#active) {
        return {
          block: true,
          reason: `rollover freeze active (${this.#active.handoffId}#${this.#active.generation}): blocked (context session ${contextSessionId ?? 'missing'} != bound ${this.#sessionId})`,
        };
      }
      return { block: false, reason: null };
    }
    if (!this.#active) return { block: false, reason: null };
    // Any tool activity means the session is not settled; invalidate prior readiness.
    this.invalidateReadiness();
    if (typeof toolName === 'string' && this.#allow.has(toolName)) {
      return { block: false, reason: null };
    }
    const name = typeof toolName === 'string' ? toolName : 'unknown-tool';
    return {
      block: true,
      reason: `rollover freeze active (${this.#active.handoffId}#${this.#active.generation}): ${name} blocked until ownership transfer`,
    };
  }

  /** Reset readiness to unknown (on session change or activity). Does not clear the latch. */
  invalidateReadiness(): void {
    this.#native = unknownNative();
  }

  /**
   * Apply one caller-supplied, unauthenticated complete native snapshot correlated to the active
   * freeze. Validates the full token and every field type; a malformed or stale observation never
   * changes readiness. Omitted fields become unknown (no inherited all-clear).
   */
  observe(observation: NativeObservation): ObserveOutcome {
    if (!this.#active) {
      return {
        ok: false,
        reason: 'not_frozen',
        detail: 'no active freeze to correlate against',
      };
    }
    if (
      observation === null ||
      typeof observation !== 'object' ||
      !isValidToken(observation.token)
    ) {
      return {
        ok: false,
        reason: 'invalid_observation',
        detail: 'observation token is malformed',
      };
    }
    if (!sameToken(this.#active, observation.token)) {
      return {
        ok: false,
        reason: 'token_mismatch',
        detail: 'observation token does not fully match the active freeze',
      };
    }
    if (!isSafeGeneration(observation.sequence)) {
      return {
        ok: false,
        reason: 'invalid_observation',
        detail: 'sequence is not a safe non-negative integer',
      };
    }
    if (
      observation.settled !== undefined &&
      typeof observation.settled !== 'boolean'
    ) {
      return {
        ok: false,
        reason: 'invalid_observation',
        detail: 'settled must be a boolean',
      };
    }
    for (const count of [
      observation.queuedMessages,
      observation.inFlightTools,
      observation.pendingApprovals,
    ]) {
      if (count !== undefined && !isSafeCount(count)) {
        return {
          ok: false,
          reason: 'invalid_observation',
          detail: 'counts must be safe non-negative bounded integers',
        };
      }
    }
    if (
      this.#lastAcceptedSequence !== null &&
      observation.sequence <= this.#lastAcceptedSequence
    ) {
      return {
        ok: false,
        reason: 'stale_sequence',
        detail: 'observation sequence is not newer than the last accepted',
      };
    }
    this.#native = {
      settled:
        observation.settled === undefined
          ? 'unknown'
          : observation.settled
            ? 'yes'
            : 'no',
      queuedMessages:
        observation.queuedMessages === undefined
          ? 'unknown'
          : observation.queuedMessages,
      inFlightTools:
        observation.inFlightTools === undefined
          ? 'unknown'
          : observation.inFlightTools,
      pendingApprovals:
        observation.pendingApprovals === undefined
          ? 'unknown'
          : observation.pendingApprovals,
      observedSequence: observation.sequence,
    };
    this.#lastAcceptedSequence = observation.sequence;
    return { ok: true };
  }

  /** A defensive, frozen in-memory status snapshot; mutating it cannot change the controller. */
  status(): FreezeStatus {
    const blockers: string[] = [];
    if (!this.#active) blockers.push('not_frozen');
    if (this.#native.settled !== 'yes') {
      blockers.push(
        this.#native.settled === 'unknown' ? 'settled_unknown' : 'not_settled',
      );
    }
    if (this.#native.queuedMessages !== 0) {
      blockers.push(
        this.#native.queuedMessages === 'unknown'
          ? 'queue_unknown'
          : 'queue_nonempty',
      );
    }
    if (this.#native.inFlightTools !== 0) {
      blockers.push(
        this.#native.inFlightTools === 'unknown'
          ? 'inflight_unknown'
          : 'inflight_present',
      );
    }
    if (this.#native.pendingApprovals !== 0) {
      blockers.push(
        this.#native.pendingApprovals === 'unknown'
          ? 'approvals_unknown'
          : 'approvals_pending',
      );
    }
    return Object.freeze({
      schema: PI_ROLLOVER_FREEZE_STATUS_SCHEMA,
      sessionId: this.#sessionId,
      frozen: this.#active !== null,
      token: this.#active ? copyToken(this.#active) : null,
      native: Object.freeze({ ...this.#native }),
      lastAcceptedSequence: this.#lastAcceptedSequence,
      ready: blockers.length === 0,
      readyBlockers: Object.freeze(blockers),
      observationSource: 'caller-supplied-unauthenticated',
      readinessIsNativeStopProof: false,
      thawSupported: false,
      limitations: LIMITATIONS,
    });
  }
}

/** Narrow structural view of the installed Pi 1.3.0 extension host (see header). */
export interface PiToolCallEvent {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
}
export interface PiToolBlockDecision {
  readonly block: true;
  readonly reason: string;
}
export interface PiCommandOptions {
  readonly description: string;
  readonly handler: (args: string, context: unknown) => void | Promise<void>;
}
export interface PiFreezeHost {
  on(
    event: 'tool_call',
    handler: (
      event: PiToolCallEvent,
      context: unknown,
    ) => Promise<PiToolBlockDecision | undefined>,
  ): void;
  registerCommand(name: string, options: PiCommandOptions): void;
}

/** Pinned installed API: the running session id is read from `ctx.sessionManager.getSessionId()`. */
function getContextSessionId(context: unknown): string | null {
  if (typeof context !== 'object' || context === null) return null;
  const manager = (context as { sessionManager?: unknown }).sessionManager;
  if (
    typeof manager === 'object' &&
    manager !== null &&
    'getSessionId' in manager &&
    typeof (manager as { getSessionId?: unknown }).getSessionId === 'function'
  ) {
    const value = (manager as { getSessionId: () => unknown }).getSessionId();
    return typeof value === 'string' ? value : null;
  }
  return null;
}

function notify(context: unknown, message: string): void {
  if (
    typeof context === 'object' &&
    context !== null &&
    'ui' in context &&
    typeof (context as { ui?: unknown }).ui === 'object' &&
    (context as { ui: unknown }).ui !== null
  ) {
    const ui = (context as { ui: { notify?: unknown } }).ui;
    if (typeof ui.notify === 'function') {
      (ui.notify as (text: string, level?: string) => void)(message, 'info');
    }
  }
}

function parseFreezeToken(
  args: string,
):
  | { readonly ok: true; readonly token: FreezeToken }
  | { readonly ok: false; readonly detail: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(args);
  } catch {
    return { ok: false, detail: 'freeze argument must be a JSON token object' };
  }
  if (!isValidToken(raw)) {
    return {
      ok: false,
      detail:
        'freeze token requires sessionId, taskId, handoffId and an integer generation',
    };
  }
  return { ok: true, token: copyToken(raw) };
}

/**
 * Concrete registration entry for a later explicit integration. Wires the controller to the Pi
 * `tool_call` barrier (revalidating the live session on every call) and to validated
 * `/rollover-freeze` and `/rollover-status` commands. There is intentionally NO thaw command.
 * Returns the controller (the no-I/O orchestration surface). It only touches the supplied `pi`.
 */
export function registerPiRolloverFreeze(
  pi: PiFreezeHost,
  options: RolloverFreezeOptions & {
    readonly controller?: RolloverFreezeController;
  },
): RolloverFreezeController {
  if (
    options.controller &&
    options.controller.sessionId !== options.sessionId
  ) {
    throw new RangeError(
      'injected controller session does not match the registration session',
    );
  }
  const controller =
    options.controller ?? new RolloverFreezeController(options);

  pi.on('tool_call', async (event, context) => {
    const decision = controller.decideToolCall(
      event.toolName,
      getContextSessionId(context),
    );
    if (decision.block && decision.reason !== null) {
      return { block: true, reason: decision.reason };
    }
    return undefined;
  });

  pi.registerCommand('rollover-freeze', {
    description:
      'Latch a managed-tool freeze for a rollover handoff (JSON token: sessionId, taskId, handoffId, generation).',
    handler: (args, context) => {
      const parsed = parseFreezeToken(args);
      if (!parsed.ok) {
        notify(context, `rollover-freeze rejected: ${parsed.detail}`);
        return;
      }
      const contextSession = getContextSessionId(context);
      if (
        contextSession !== controller.sessionId ||
        contextSession !== parsed.token.sessionId
      ) {
        controller.invalidateReadiness();
        notify(
          context,
          `rollover-freeze rejected: session mismatch (context ${contextSession ?? 'missing'})`,
        );
        return;
      }
      const outcome = controller.freeze(parsed.token);
      notify(
        context,
        outcome.ok
          ? `rollover-freeze ${outcome.state}${outcome.idempotent ? ' (idempotent)' : ''}`
          : `rollover-freeze rejected: ${outcome.reason} (${outcome.detail})`,
      );
    },
  });

  pi.registerCommand('rollover-status', {
    description:
      'Report the in-memory managed-tool freeze and advisory readiness status.',
    handler: (_args, context) => {
      if (getContextSessionId(context) !== controller.sessionId) {
        controller.invalidateReadiness();
      }
      notify(context, JSON.stringify(controller.status()));
    },
  });

  return controller;
}
