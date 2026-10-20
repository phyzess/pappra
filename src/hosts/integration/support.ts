import type { HostLifecycleEvent, HostName } from '../../schemas/host.js';

export const HOST_SUPPORT = {
  pi: {
    surface: 'pi-extension' as const,
    version: '1.3.0',
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
  return version === HOST_SUPPORT[host].version;
}

export function surfaceFor(
  host: HostName,
): (typeof HOST_SUPPORT)[HostName]['surface'] {
  return HOST_SUPPORT[host].surface;
}
