import type { HostHookInput } from '../../schemas/host.js';
import { runHostHook } from './hook.js';

/**
 * Minimal structural surface used by the generated Pi extension. The host SDK
 * remains the authority for exact event payloads; this runtime validates the
 * normalized fields before any local write.
 */
export interface PiExtensionLike {
  on(
    event: string,
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

function contextCwd(context: unknown): string | null {
  if (
    typeof context === 'object' &&
    context !== null &&
    'cwd' in context &&
    typeof context.cwd === 'string'
  ) {
    return context.cwd;
  }
  return null;
}

function contextSessionId(context: unknown): string | null {
  if (typeof context !== 'object' || context === null) return null;
  if (
    'sessionManager' in context &&
    typeof context.sessionManager === 'object' &&
    context.sessionManager !== null
  ) {
    const manager = context.sessionManager;
    if (
      'getSessionId' in manager &&
      typeof manager.getSessionId === 'function'
    ) {
      const value = manager.getSessionId();
      if (typeof value === 'string') return value;
    }
  }
  return null;
}

function notifyContext(context: unknown, message: string): void {
  if (typeof context !== 'object' || context === null) return;
  if (
    'ui' in context &&
    typeof context.ui === 'object' &&
    context.ui !== null &&
    'notify' in context.ui &&
    typeof context.ui.notify === 'function'
  ) {
    context.ui.notify(message, 'info');
  }
}

async function observe(
  event: 'startup' | 'compact' | 'checkpoint-request',
  context: unknown,
  taskId: string | null = null,
): Promise<void> {
  const cwd = contextCwd(context);
  if (cwd === null) return;
  const input: HostHookInput = {
    schema: 'pappra/host-hook-input/1',
    host: 'pi',
    event,
    nativeEvent:
      event === 'startup'
        ? 'session_start'
        : event === 'compact'
          ? 'session_before_compact'
          : 'pappra-checkpoint',
    eventId: null,
    sessionId: contextSessionId(context),
    cwd,
    root: null,
    taskId,
    source: 'pi-extension',
    observedAt: new Date().toISOString(),
  };
  try {
    const result = await runHostHook(input);
    if (result.context !== null) notifyContext(context, result.context);
  } catch {
    // A hook failure must not replace the host's own lifecycle failure.
  }
}

/**
 * Registers only bounded local lifecycle observations. It deliberately does
 * not start processes, read transcripts, call models, fetch, index or continue
 * a session.
 */
export function createPiExtension(pi: PiExtensionLike): void {
  pi.on('session_start', async (_event, context) => {
    await observe('startup', context);
  });
  pi.on('session_before_compact', async (_event, context) => {
    await observe('compact', context);
  });
  pi.registerCommand('pappra-checkpoint', {
    description:
      'Record a bounded Pappra checkpoint request; manual pappra checkpoint/resume remains required.',
    handler: async (_args, context) => {
      const taskId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(_args.trim())
        ? _args.trim()
        : null;
      await observe('checkpoint-request', context, taskId);
    },
  });
}
