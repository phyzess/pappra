import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostName } from '../schemas/host.js';
import {
  HOST_SUPPORT,
  isSupportedVersion,
} from '../hosts/integration/support.js';

export interface HostProbeResult {
  readonly host: HostName;
  readonly command: string;
  readonly version: string | null;
  readonly pinnedVersion: string;
  readonly protocol: 'pi-rpc' | 'version-only';
  readonly ok: boolean;
  readonly details: Readonly<Record<string, unknown>>;
  readonly message: string;
}

function commandVersion(command: string): string | null {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
  });
  if (result.status !== 0) return null;
  const match = /(\d+\.\d+\.\d+)/.exec(
    `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  );
  return match?.[1] ?? null;
}

/**
 * Protocol-level probe. It never sends a prompt, starts a model, or writes workspace
 * state; the Pi path only asks for `get_state` in a throwaway session directory.
 */
export function probeHost(host: HostName): HostProbeResult {
  const pinnedVersion = HOST_SUPPORT[host].version;
  const command = host;
  const version = commandVersion(command);
  if (version === null) {
    return {
      host,
      command,
      version: null,
      pinnedVersion,
      protocol: 'version-only',
      ok: false,
      details: {},
      message: `${command} is not callable on PATH.`,
    };
  }
  if (host !== 'pi') {
    return {
      host,
      command,
      version,
      pinnedVersion,
      protocol: 'version-only',
      ok: isSupportedVersion(host, version),
      details: { matchesPinnedVersion: version === pinnedVersion },
      message: isSupportedVersion(host, version)
        ? 'Version matches an observed event contract; lifecycle callability still needs a real session.'
        : `Version ${version} does not match the pinned ${pinnedVersion}.`,
    };
  }
  const directory = mkdtempSync(join(tmpdir(), 'pappra-pi-probe-'));
  const sessionId = randomUUID();
  try {
    const probe = spawnSync(
      command,
      ['--mode', 'rpc', '--session-dir', directory, '--session-id', sessionId],
      {
        encoding: 'utf8',
        shell: false,
        timeout: 15_000,
        input: `${JSON.stringify({ id: 'probe-1', type: 'get_state' })}\n`,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const lines = `${probe.stdout ?? ''}`
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    let state: Record<string, unknown> | null = null;
    for (const line of lines) {
      try {
        const value: unknown = JSON.parse(line);
        if (
          typeof value === 'object' &&
          value !== null &&
          'id' in value &&
          value.id === 'probe-1' &&
          'data' in value &&
          typeof value.data === 'object' &&
          value.data !== null
        ) {
          state = value.data as Record<string, unknown>;
          break;
        }
      } catch {
        // Non-JSON extension UI lines are expected; keep scanning.
      }
    }
    if (state === null) {
      return {
        host,
        command,
        version,
        pinnedVersion,
        protocol: 'pi-rpc',
        ok: false,
        details: {
          exitCode: probe.status,
          stderr: `${probe.stderr ?? ''}`.slice(0, 500),
        },
        message: 'Pi RPC did not answer get_state within the probe deadline.',
      };
    }
    const reportedSessionId = state['sessionId'];
    const reportedSessionFile = state['sessionFile'];
    const sessionIdMatches = reportedSessionId === sessionId;
    const sessionFileReported =
      typeof reportedSessionFile === 'string' && reportedSessionFile !== '';
    return {
      host,
      command,
      version,
      pinnedVersion,
      protocol: 'pi-rpc',
      ok: sessionIdMatches && sessionFileReported,
      details: {
        sessionIdMatches,
        sessionFileReported,
        isStreaming: state['isStreaming'] ?? null,
        pendingMessageCount: state['pendingMessageCount'] ?? null,
      },
      message:
        sessionIdMatches && sessionFileReported
          ? 'Pi RPC answered get_state with the contracted session identity; no prompt was sent.'
          : 'Pi RPC answered, but the session identity or session file did not match.',
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
