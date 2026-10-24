// Pi recovery adapter: composes the opt-in recovery extension above `src/app`
// and `src/hosts`.
//
// Loading this extension installs supported startup/settled/manual
// reconciliation triggers that each run the durable recovery executor once per
// observed trigger, gated by the ACTUAL host session (not a configuration
// assertion) and deduplicated by the executor's durable canonical cause. It does
// not touch the accepted observation-only native-event producer, never spawns a
// session or a hidden daemon, never polls for model/worker completion, and never
// answers approval automatically. There is no known reconnect event: if no
// supported trigger fires, nothing is reconciled, and a missing host observation
// stays explicit rather than being manufactured to unblock an enqueue. An initial
// no-op does not suppress a later genuine cause, and recovery's own settled event
// cannot re-issue an already-reserved cause (no self-loop).
//
// Composition lives here rather than in `src/hosts/integration`: the host layer
// must not depend on application orchestration. The configuration format is owned
// by the lower-layer reader re-exported below, so bundle export inside `src/hosts`
// validates the same bytes without reaching this module.
import { fileURLToPath } from 'node:url';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  createHerdrRecoveryController,
  executeRecovery,
  type RecoveryController,
  type RecoveryExecutionMode,
  type RecoveryExecutionResult,
  type RecoveryExpectedSession,
} from '../../app/collab-recovery-executor.js';
import {
  readPiRecoveryConfig,
  type PiRecoveryConfig,
} from '../../hosts/integration/recovery-config.js';

export {
  PI_RECOVERY_CONFIG_SCHEMA,
  readPiRecoveryConfig,
  type PiRecoveryConfig,
  type PiRecoveryConfigLoad,
  type PiRecoveryExpected,
} from '../../hosts/integration/recovery-config.js';

export const PI_RECOVERY_STATUS_SCHEMA = 'pappra/pi-recovery-status/1' as const;

export type RecoveryTrigger = 'session_start' | 'agent_settled' | 'manual';

/** Genuine host facts observed at a supported event/manual boundary; never fabricated. */
export interface RecoveryHostFacts {
  readonly session_id: string;
  readonly cwd: string | null;
}

const LIMITATIONS: readonly string[] = Object.freeze([
  'opt_in_explicit_configuration_only_no_ambient_task_discovery',
  'actual_host_session_gated_not_a_configuration_assertion',
  'no_known_reconnect_event_missing_observation_stays_explicit',
  'cause_aware_durable_dedup_prevents_self_wake_loops',
  'no_new_session_hidden_daemon_completion_poll_or_approval_auto',
  'submission_or_queue_acceptance_is_not_consumption_or_completion',
]);

export type ReconcileOutcome =
  | {
      readonly trigger: RecoveryTrigger;
      readonly skipped: true;
      readonly reason: string;
    }
  | {
      readonly trigger: RecoveryTrigger;
      readonly skipped: false;
      readonly result: RecoveryExecutionResult;
    };

export interface PiRecoveryStatus {
  readonly schema: typeof PI_RECOVERY_STATUS_SCHEMA;
  readonly registered: boolean;
  readonly mode: RecoveryExecutionMode | null;
  readonly task_root: string | null;
  readonly config_digest: string | null;
  readonly reconcile_count: number;
  readonly issued_causes: readonly string[];
  readonly last: ReconcileOutcome | null;
  readonly limitations: readonly string[];
}

export interface RecoveryReconcilerDeps {
  readonly controller: RecoveryController;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injectable executor for tests; defaults to the real durable executor. */
  readonly execute?: typeof executeRecovery;
}

export interface RecoveryReconciler {
  reconcile(
    trigger: RecoveryTrigger,
    hostFacts: RecoveryHostFacts | null,
  ): Promise<ReconcileOutcome>;
  status(): PiRecoveryStatus;
}

/**
 * Build a single-flight reconciler. Every supported trigger may run; a reconcile never overlaps another.
 * The ACTUAL observed host session must match the configured expected session before any work — a config
 * loaded in a foreign session is skipped. Re-issuing the same cause is prevented durably by the executor's
 * canonical-cause reservation, so a later new cause can still progress while recovery's own settled event
 * cannot repeatedly wake itself.
 */
export function createRecoveryReconciler(
  config: PiRecoveryConfig,
  deps: RecoveryReconcilerDeps,
  configDigest: string | null = null,
): RecoveryReconciler {
  const execute = deps.execute ?? executeRecovery;
  const expectedSession: RecoveryExpectedSession = {
    session_id: config.expected.session_id,
    cwd: config.expected.cwd,
    binding_digest: config.expected.binding_digest,
    binding_ref: config.expected.binding_ref,
    target_agent: config.target.agent,
    pane_id: config.expected.pane_id,
    harness: config.expected.harness,
  };
  const issued = new Set<string>();
  let reconcileCount = 0;
  let running = false;
  let last: ReconcileOutcome | null = null;

  const record = (outcome: ReconcileOutcome): ReconcileOutcome => {
    last = outcome;
    return outcome;
  };

  return {
    async reconcile(trigger, hostFacts) {
      if (running)
        return record({
          trigger,
          skipped: true,
          reason: 'a reconciliation is already in progress; not overlapping.',
        });
      if (hostFacts === null)
        return record({
          trigger,
          skipped: true,
          reason:
            'the actual host session could not be observed; refusing to reconcile without host evidence.',
        });
      if (hostFacts.session_id !== config.expected.session_id)
        return record({
          trigger,
          skipped: true,
          reason:
            'the actual host session does not match the configured expected session; refusing to reconcile.',
        });
      if (hostFacts.cwd !== config.expected.cwd)
        return record({
          trigger,
          skipped: true,
          reason:
            'the actual host cwd does not match the configured expected cwd; refusing to reconcile.',
        });
      running = true;
      try {
        const result = await execute(
          {
            taskRoot: config.taskRoot,
            planFile: config.planFile,
            self: config.self,
            policy: config.policy,
            requestId: config.requestId,
            mode: config.mode,
            expectedSession,
          },
          {
            controller: deps.controller,
            ...(deps.now ? { now: deps.now } : {}),
            ...(deps.sleep ? { sleep: deps.sleep } : {}),
          },
        );
        reconcileCount += 1;
        if (
          result.reservation &&
          (result.status === 'applied' || result.status === 'deferred')
        )
          issued.add(result.reservation.key);
        return record({ trigger, skipped: false, result });
      } finally {
        running = false;
      }
    },
    status() {
      return {
        schema: PI_RECOVERY_STATUS_SCHEMA,
        registered: true,
        mode: config.mode,
        task_root: config.taskRoot,
        config_digest: configDigest,
        reconcile_count: reconcileCount,
        issued_causes: [...issued],
        last,
        limitations: LIMITATIONS,
      };
    },
  };
}

interface RecoveryExtensionHost {
  on(
    event: 'session_start' | 'agent_settled',
    handler: (event: unknown, context: unknown) => Promise<void> | void,
  ): void;
  registerCommand(
    name: string,
    options: {
      readonly description: string;
      readonly handler: (
        args: string,
        context: unknown,
      ) => Promise<void> | void;
    },
  ): void;
}

const MAX_HOST_ID_LENGTH = 512;

function isSafeHostId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_HOST_ID_LENGTH
  );
}

/**
 * Pinned installed Pi API (matching the accepted native-event producer): the running session id is read
 * from `ctx.sessionManager.getSessionId()` with its receiver preserved. Any throwing/missing/invalid access
 * stays null. This is the supported host shape, not a fabricated event field.
 */
function readHostSessionId(context: unknown): string | null {
  try {
    if (typeof context !== 'object' || context === null) return null;
    const manager = (context as { sessionManager?: unknown }).sessionManager;
    if (typeof manager !== 'object' || manager === null) return null;
    const getter = (manager as { getSessionId?: unknown }).getSessionId;
    if (typeof getter !== 'function') return null;
    const value = (getter as () => unknown).call(manager);
    return isSafeHostId(value) ? value : null;
  } catch {
    return null;
  }
}

/** Pinned installed Pi API: the working directory is `ctx.cwd`. A throw or non-string stays null. */
function readHostCwd(context: unknown): string | null {
  try {
    if (typeof context !== 'object' || context === null) return null;
    const value = (context as { cwd?: unknown }).cwd;
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Observe genuine host facts from the supported installed Pi context
 * (`ctx.sessionManager.getSessionId()` and `ctx.cwd`). Returns null when no actual session can be read, so
 * a missing observation stays explicit and is never synthesized.
 */
export function observeHostFacts(
  event: unknown,
  context: unknown,
): RecoveryHostFacts | null {
  void event;
  const session_id = readHostSessionId(context);
  if (session_id === null) return null;
  return { session_id, cwd: readHostCwd(context) };
}

function notify(context: unknown, message: string): void {
  if (typeof context !== 'object' || context === null) return;
  if (
    'ui' in context &&
    typeof context.ui === 'object' &&
    context.ui !== null &&
    'notify' in context.ui &&
    typeof context.ui.notify === 'function'
  ) {
    (context.ui.notify as (text: string, level: string) => void)(
      message,
      'info',
    );
  }
}

function configPath(): string {
  return fileURLToPath(new URL('./recovery.json', import.meta.url));
}

/**
 * Opt-in extension entry. Loads the sibling `recovery.json`, builds a live-target-verifying Herdr
 * controller for `apply` mode (a no-op controller for `plan` mode, which never issues an effect), and
 * installs startup/settled triggers plus a manual `pappra-recovery` command. Each trigger observes the
 * ACTUAL host session and reconciles through the durable, cause-deduplicated executor. A load or validation
 * failure disables reconciliation and reports it through the status command; it never throws into the
 * loader and never substitutes a hidden fresh Pi process for the visible workflow.
 */
export default function recoveryExtension(pi: ExtensionAPI): void {
  const host = pi as unknown as RecoveryExtensionHost;
  const load = readPiRecoveryConfig(configPath());

  if (!load.ok) {
    host.registerCommand('pappra-recovery', {
      description:
        'Opt-in recovery reconciliation (disabled: config not loaded).',
      handler: (_args, context) => {
        notify(
          context,
          JSON.stringify({
            schema: PI_RECOVERY_STATUS_SCHEMA,
            registered: false,
            reason: `${load.code}`,
            limitations: LIMITATIONS,
          }),
        );
      },
    });
    return;
  }

  const controller: RecoveryController =
    load.config.mode === 'apply'
      ? createHerdrRecoveryController(
          { env: process.env },
          { agent: load.config.target.agent },
        )
      : {
          id: 'recovery-plan-noop',
          perform: async () => ({
            disposition: 'unknown',
            detail: 'plan mode issues no effect',
            observation: 'none',
          }),
        };

  const reconciler = createRecoveryReconciler(
    load.config,
    { controller },
    load.digest,
  );

  const run = async (
    trigger: RecoveryTrigger,
    event: unknown,
    context: unknown,
  ): Promise<void> => {
    const facts = observeHostFacts(event, context);
    const outcome = await reconciler.reconcile(trigger, facts);
    notify(context, JSON.stringify(outcome));
  };

  host.on('session_start', (event, context) =>
    run('session_start', event, context),
  );
  host.on('agent_settled', (event, context) =>
    run('agent_settled', event, context),
  );
  host.registerCommand('pappra-recovery', {
    description:
      'Reconcile durable recovery for the configured task (plan or apply per config).',
    handler: (_args, context) => run('manual', null, context),
  });
}
