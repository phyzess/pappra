import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  boundedReason,
  readPiBootstrapConfig,
  runtimeConfigOf,
  type PiBootstrapConfig,
} from './bootstrap-config.js';
import type {
  PiBootstrapGuard,
  PiBootstrapGuardHost,
} from './pi-bootstrap-guard.js';
import { registerPiBootstrapRuntime } from './pi-bootstrap-runtime.js';
import { createPiExtension } from './pi-extension-runtime.js';

/**
 * Self-contained Pi extension entry for the opt-in successor bootstrap gate.
 *
 * This file is bundled into `pappra-bootstrap-extension.mjs` and shipped next to a validated
 * `bootstrap.json` inside a private export directory. Loading it registers a default-deny
 * `tool_call` handler before any configuration, reader or lifecycle work; only a fully
 * initialized accepted guard may reach the real decision. Any failure keeps the deny handler
 * for the process lifetime and never rethrows into an unrestricted loader fallthrough.
 *
 * The status command reports registration, never write permission: `registered` only means the
 * gate and lifecycle handlers were installed, and `write_permitted` is always `not-asserted`.
 */

export const PI_BOOTSTRAP_STATUS_SCHEMA = 'pappra/pi-bootstrap-status/1';

export type PiBootstrapState = 'denied' | 'registered';

export interface PiBootstrapStatus {
  readonly schema: typeof PI_BOOTSTRAP_STATUS_SCHEMA;
  /** `registered` means handlers were installed; it is not a permission signal. */
  readonly state: PiBootstrapState;
  readonly registered: boolean;
  /** The gate never asserts current write permission; a tool call still decides per call. */
  readonly write_permitted: 'not-asserted';
  readonly mode: 'deny-until-completed-transfer' | 'default-deny';
  readonly reason: string | null;
  readonly taskId: string | null;
  readonly config_digest: string | null;
  readonly guard: ReturnType<PiBootstrapGuard['status']> | null;
  readonly limitations: readonly string[];
}

const LIMITATIONS: readonly string[] = Object.freeze([
  'registered_is_not_write_permission',
  'not_a_native_host_load_or_trust_proof',
  'no_allow_thaw_release_or_permanent_unlock',
  'check_use_gap_and_background_effects_are_not_fenced',
]);

interface ToolCallBlock {
  readonly block: true;
  readonly reason: string;
}

interface BootstrapExtensionHost {
  on(
    event: 'tool_call',
    handler: (event: unknown, context: unknown) => ToolCallBlock | undefined,
  ): void;
  registerCommand(
    name: string,
    options: {
      readonly description: string;
      readonly handler: (args: string, context: unknown) => void;
    },
  ): void;
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
    context.ui.notify(message, 'info');
  }
}

function configPath(): string {
  return fileURLToPath(new URL('./bootstrap.json', import.meta.url));
}

/**
 * Loads the sibling config, registers the accepted runtime gate and the accepted lifecycle
 * extension, and exposes a read-only status command. Returns the installed handler count only
 * for tests; the host surface itself has no allow/release API.
 */
export default function bootstrapExtension(pi: ExtensionAPI): void {
  const extensionHost = pi as unknown as BootstrapExtensionHost;
  let initialized = false;
  let deniedReason: string | null = 'bootstrap-config-not-loaded';
  let config: PiBootstrapConfig | null = null;
  let configDigest: string | null = null;
  let guard: PiBootstrapGuard | null = null;

  const status = (): PiBootstrapStatus => ({
    schema: PI_BOOTSTRAP_STATUS_SCHEMA,
    state: initialized ? 'registered' : 'denied',
    registered: initialized,
    write_permitted: 'not-asserted',
    mode: initialized ? 'deny-until-completed-transfer' : 'default-deny',
    reason: initialized ? null : deniedReason,
    taskId: config?.taskId ?? null,
    config_digest: configDigest,
    guard: guard === null ? null : guard.status(),
    limitations: LIMITATIONS,
  });

  // Fail-closed first — every tool call before full initialization is blocked here.
  // After success it returns `undefined` and the accepted guard handler makes the decision.
  extensionHost.on('tool_call', () => {
    if (initialized) return undefined;
    return {
      block: true as const,
      reason: `pappra-bootstrap: ${deniedReason ?? 'not-initialized'}`,
    };
  });

  try {
    extensionHost.registerCommand('bootstrap-status', {
      description:
        'Report bootstrap gate registration only (never write permission).',
      handler: (_args, context) => {
        notify(context, JSON.stringify(status()));
      },
    });
    const loaded = readPiBootstrapConfig(configPath());
    if (loaded.ok === false) {
      deniedReason = `${loaded.code}: ${loaded.message}`;
      return;
    }
    config = loaded.config;
    configDigest = loaded.digest;
    const registered = registerPiBootstrapRuntime(
      pi as unknown as PiBootstrapGuardHost,
      runtimeConfigOf(loaded.config),
    );
    // The accepted lifecycle extension is attached unchanged after the gate.
    createPiExtension(pi);
    guard = registered;
    initialized = true;
  } catch (error) {
    try {
      deniedReason = boundedReason(error);
    } catch {
      deniedReason = 'initialization failed';
    }
    initialized = false;
  }
}
