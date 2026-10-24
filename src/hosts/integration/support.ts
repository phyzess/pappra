import type { HostLifecycleEvent, HostName } from '../../schemas/host.js';

export const HOST_SUPPORT = {
  pi: {
    surface: 'pi-extension' as const,
    version: '1.3.0',
    hookScope: 'project' as const,
    events: {
      startup: 'session_start',
      resume: 'session_start',
      compact: 'session_before_compact',
      'checkpoint-request': 'pappra-checkpoint',
    },
  },
  codex: {
    surface: 'codex-hooks' as const,
    version: '0.163.0',
    // Codex 0.163.0 loads lifecycle hooks only from its user configuration
    // directory (CODEX_HOME); project `.codex/hooks.json` is not loaded.
    hookScope: 'user' as const,
    events: {
      startup: 'SessionStart',
      resume: 'SessionStart',
      compact: null,
      'checkpoint-request': null,
    },
  },
  claude: {
    surface: 'claude-hooks' as const,
    version: '2.1.292',
    hookScope: 'project' as const,
    events: {
      startup: 'SessionStart',
      resume: 'SessionStart',
      compact: 'PostCompact',
      'checkpoint-request': null,
    },
  },
} as const;

export function nativeEventFor(
  host: HostName,
  event: HostLifecycleEvent,
): string | null {
  return HOST_SUPPORT[host].events[event];
}

export function isSupportedVersion(
  host: HostName,
  version: string | null,
): boolean {
  return (
    version !== null &&
    HOST_EVENT_VERSIONS[host].some((observed) => observed === version)
  );
}

/** Only versions with bounded local event/loader evidence are admitted here.
 * The owned SDK adapter has a separate exact version/private-source contract. */
export const HOST_EVENT_VERSIONS = {
  pi: ['1.3.0', '1.4.0'],
  codex: ['0.163.0', '0.164.0'],
  claude: ['2.1.292', '2.1.308'],
} as const;

export function surfaceFor(
  host: HostName,
): (typeof HOST_SUPPORT)[HostName]['surface'] {
  return HOST_SUPPORT[host].surface;
}

/**
 * Observed plugin-hook support. `verified` means a real host session produced a
 * `.pappra/local/host-events/<host>` record; `unsupported` means a control hook
 * fired while the bundled plugin hook did not; `unverified` means no
 * authenticated session was available. See docs/host-plugin-validation.md.
 */
export const HOST_PLUGIN_HOOKS = {
  pi: {
    state: 'verified',
    evidence:
      'Pi 1.3.0 fires the packaged extension: `pi install <dir> -l -a` plus `pi -p -a` wrote a session_start event.',
  },
  codex: {
    state: 'unsupported',
    evidence:
      'Codex 0.163.0 does not load plugin hooks: a control hook in CODEX_HOME fired during `codex exec --dangerously-bypass-hook-trust` while the bundled plugin hook never ran, including with a .codex-plugin/plugin.json copy.',
  },
  claude: {
    state: 'verified',
    evidence:
      'Claude Code 2.1.292 passed `claude plugin validate`, then a project-scope marketplace install and `claude -p` wrote a SessionStart event from ${CLAUDE_PLUGIN_ROOT}/hooks/pappra-hook.mjs.',
  },
} as const;
