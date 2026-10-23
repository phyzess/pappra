import path from 'node:path';
import {
  loadSessionTransitionRequest,
  planSessionTransition,
  applySessionTransition,
  type SessionTransitionHost,
  type SessionTransitionHostObservation,
} from '../../app/collab-session-transition.js';
import {
  registerPiNativeEvents,
  type NativeEventProducer,
  type PiNativeEventHost,
} from './pi-native-events.js';
import {
  registerPiRolloverFreeze,
  type FreezeOutcome,
  type FreezeToken,
  type PiFreezeHost,
  type RolloverFreezeController,
} from './pi-rollover-extension.js';

export const PI_SESSION_TRANSITION_EXTENSION_ID =
  'pappra/pi-session-transition-host/1';

export const PI_SESSION_TRANSITION_LIMITATIONS: readonly string[] =
  Object.freeze([
    'no_supported_complete_native_message_queue_or_pending_approval_inventory',
    'pi_native_event_in_flight_tracking_is_incomplete_and_never_proves_writer_stop',
    'managed_tool_freeze_is_not_native_process_or_external_writer_stop_proof',
    'herdr_session_metadata_is_not_process_affiliation',
    'native_pi_session_archive_is_unavailable',
  ]);

export interface PiSessionTransitionContext {
  readonly cwd?: unknown;
  readonly sessionManager?: unknown;
  readonly ui?: unknown;
}

interface PiSessionTransitionHostState {
  readonly host: SessionTransitionHost;
  readonly controller: RolloverFreezeController;
  readonly producer: NativeEventProducer;
  readonly sessionId: string;
  readonly cwd: string;
}

interface PiCommandHost {
  registerCommand(
    name: string,
    options: {
      readonly description: string;
      readonly handler: (
        args: string,
        context: unknown,
      ) => void | Promise<void>;
    },
  ): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contextSessionId(context: unknown): string | null {
  try {
    if (!isRecord(context) || !isRecord(context['sessionManager'])) return null;
    const manager = context['sessionManager'];
    const getter = manager['getSessionId'];
    if (typeof getter !== 'function') return null;
    const value = getter.call(manager) as unknown;
    return typeof value === 'string' && value.length > 0 && value.length <= 256
      ? value
      : null;
  } catch {
    return null;
  }
}

function contextCwd(context: unknown): string | null {
  if (!isRecord(context)) return null;
  const value = context['cwd'];
  return typeof value === 'string' &&
    path.isAbsolute(value) &&
    value.length <= 4096
    ? value
    : null;
}

function paneFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const value = env['HERDR_PANE_ID'];
  return typeof value === 'string' && /^[A-Za-z0-9]+:p[A-Za-z0-9]+$/.test(value)
    ? value
    : null;
}

function freezeFailure(token: FreezeToken, sessionId: string): FreezeOutcome {
  return {
    ok: false,
    reason:
      token.sessionId === sessionId ? 'conflicting_freeze' : 'wrong_session',
    detail:
      'The Pi session-transition adapter does not authorize native stop or ownership transfer.',
  };
}

/**
 * Build the opt-in in-process host adapter from one exact Pi command context. The adapter reports
 * native quiescence as unavailable: supported Pi events cannot provide a complete queue/approval/
 * external-writer inventory or authenticated native stop receipt. Its freeze method is retained
 * only as the existing managed-tool barrier and is never promoted to stop proof.
 */
export function createPiSessionTransitionHost(
  pi: unknown,
  context: unknown,
  env: NodeJS.ProcessEnv = process.env,
): PiSessionTransitionHostState | null {
  const sessionId = contextSessionId(context);
  const cwd = contextCwd(context);
  if (sessionId === null || cwd === null) return null;

  const controller = registerPiRolloverFreeze(pi as PiFreezeHost, {
    sessionId,
  });
  const producer = registerPiNativeEvents(pi as PiNativeEventHost, {
    sessionId,
  });
  const host: SessionTransitionHost = {
    id: PI_SESSION_TRANSITION_EXTENSION_ID,
    async observe(): Promise<SessionTransitionHostObservation> {
      const currentSession = contextSessionId(context);
      const currentCwd = contextCwd(context);
      const status = controller.status();
      const facts = producer.snapshot();
      return {
        session_id: currentSession,
        cwd: currentCwd,
        pane_id: paneFromEnvironment(env),
        proof_support: 'unavailable',
        proof: null,
        freeze_status: status,
        native_facts: facts,
        unavailable_code: 'pi_native_quiescence_proof_unavailable',
        detail:
          'Installed Pi events expose only advisory idle/settled and incomplete in-flight observations. Complete queued messages, approvals, external writers and authenticated native stop are unsupported; a managed freeze latch is not quiescence proof.',
      };
    },
    async freeze(token: FreezeToken): Promise<FreezeOutcome> {
      const currentSession = contextSessionId(context);
      if (currentSession !== sessionId || currentSession !== token.sessionId)
        return freezeFailure(token, currentSession ?? '');
      return controller.freeze(token);
    },
  };
  return { host, controller, producer, sessionId, cwd };
}

function tokenizeCommandArgs(input: string): string[] | null {
  if (input.length > 8192 || input.includes('\u0000')) return null;
  const tokens: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  let escaped = false;
  let started = false;
  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === '\\' && quote !== 'single') {
      escaped = true;
      started = true;
      continue;
    }
    if (quote === null && char === "'") {
      quote = 'single';
      started = true;
      continue;
    }
    if (quote === 'single' && char === "'") {
      quote = null;
      continue;
    }
    if (quote === null && char === '"') {
      quote = 'double';
      started = true;
      continue;
    }
    if (quote === 'double' && char === '"') {
      quote = null;
      continue;
    }
    if (quote === null && /\s/.test(char)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (escaped || quote !== null) return null;
  if (started) tokens.push(current);
  return tokens;
}

function parseExtensionCommand(input: string):
  | {
      readonly ok: true;
      readonly action: 'plan' | 'apply';
      readonly requestFile: string;
    }
  | { readonly ok: false; readonly message: string } {
  const tokens = tokenizeCommandArgs(input);
  if (tokens === null)
    return {
      ok: false,
      message: 'Arguments must be balanced and contain no NUL bytes.',
    };
  const action = tokens[0];
  const requestFile =
    tokens.length === 2
      ? tokens[1]
      : tokens.length === 3 && tokens[1] === '--request'
        ? tokens[2]
        : undefined;
  if (
    (action !== 'plan' && action !== 'apply') ||
    requestFile === undefined ||
    !path.isAbsolute(requestFile)
  )
    return {
      ok: false,
      message:
        'Use /collab-transition <plan|apply> <absolute-request.json> (or --request <absolute-request.json>).',
    };
  return { ok: true, action, requestFile };
}

function notify(
  context: unknown,
  message: string,
  level: 'info' | 'warning' = 'info',
): void {
  if (!isRecord(context) || !isRecord(context['ui'])) return;
  const ui = context['ui'];
  const method = ui['notify'];
  if (typeof method !== 'function') return;
  try {
    method.call(ui, message, level);
  } catch {
    // A UI notification is diagnostic only and never changes transition state.
  }
}

function summaryLine(report: {
  readonly status: string;
  readonly code: string | null;
  readonly stage: string;
  readonly next_action: string | null;
}): string {
  return [
    `pappra transition ${report.status}${report.code === null ? '' : ` (${report.code})`}: ${report.stage}.`,
    report.next_action,
  ]
    .filter((part): part is string => part !== null)
    .join(' ');
}

/**
 * Explicit Pi extension entry. Loading registers one command; it does not start a successor,
 * mutate settings, query a model, send a prompt or claim that the host has stop-proof capability.
 */
export default function piSessionTransitionExtension(pi: unknown): void {
  const commandHost = pi as PiCommandHost;
  let runtime: PiSessionTransitionHostState | null = null;
  let rejectedSessionChange = false;
  commandHost.registerCommand('collab-transition', {
    description:
      'Plan/apply one guarded collaboration transition. Native quiescence is blocked unless an accepted proof API exists.',
    handler: async (args, context) => {
      const parsed = parseExtensionCommand(args);
      if (!parsed.ok) {
        notify(context, parsed.message, 'warning');
        return;
      }
      const sessionId = contextSessionId(context);
      const cwd = contextCwd(context);
      if (sessionId === null || cwd === null) {
        notify(
          context,
          'Pi transition requires an exact live session id and absolute cwd.',
          'warning',
        );
        return;
      }
      if (runtime === null) {
        try {
          runtime = createPiSessionTransitionHost(pi, context);
        } catch {
          notify(
            context,
            'Pi transition host registration failed; reconcile the extension load before retrying.',
            'warning',
          );
          return;
        }
        if (runtime === null) {
          notify(
            context,
            'Pi transition host could not bind the current session/cwd.',
            'warning',
          );
          return;
        }
      } else if (runtime.sessionId !== sessionId || runtime.cwd !== cwd) {
        rejectedSessionChange = true;
        notify(
          context,
          'Pi transition host identity changed; reload in the exact source session before continuing.',
          'warning',
        );
        return;
      }
      if (rejectedSessionChange) {
        notify(
          context,
          'Pi transition host remains blocked after a session identity change.',
          'warning',
        );
        return;
      }
      const loaded = loadSessionTransitionRequest(parsed.requestFile);
      if (!loaded.ok) {
        notify(context, `${loaded.code}: ${loaded.message}`, 'warning');
        return;
      }
      try {
        const report =
          parsed.action === 'plan'
            ? await planSessionTransition(loaded.value, { host: runtime.host })
            : await applySessionTransition(loaded.value, {
                host: runtime.host,
              });
        notify(context, summaryLine(report), report.ok ? 'info' : 'warning');
      } catch {
        notify(
          context,
          'Transition execution returned an unknown outcome; inspect the task journal and host state before resuming.',
          'warning',
        );
      }
    },
  });
}
