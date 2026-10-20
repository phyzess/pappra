import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { EvidenceRef } from '../schemas/evidence.js';

export type HostName = 'pi' | 'codex' | 'claude';

export interface PassiveToolObservation {
  readonly name: string;
  readonly command: string;
  readonly executablePath: string | null;
  readonly discovered: boolean;
}

export interface PassiveHostObservation {
  readonly host: HostName;
  readonly selected: boolean;
  readonly executablePath: string | null;
  readonly discovered: boolean;
  readonly configPaths: readonly string[];
  readonly configured: boolean;
  readonly callable: 'unknown';
  readonly verification: 'unsupported';
  readonly evidence: readonly EvidenceRef[];
}

export interface HostDetectionOptions {
  readonly homeDir: string;
  readonly pathEnv: string;
  readonly selectedHosts: readonly string[];
  readonly observedAt?: string;
}

function evidence(path: string, observedAt: string): EvidenceRef {
  return {
    kind: 'file',
    ref: path,
    digest: null,
    observedAt,
    scope: 'live-owned',
  };
}

export function executableOnPath(
  command: string,
  pathEnv: string,
): string | null {
  for (const directory of pathEnv.split(delimiter)) {
    if (directory === '') continue;
    const candidate = join(directory, command);
    try {
      const stats = statSync(candidate);
      if (!stats.isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue probing the remaining PATH entries.
    }
  }
  return null;
}

export function detectPassiveTool(
  command: string,
  pathEnv: string,
): PassiveToolObservation {
  const executablePath = executableOnPath(command, pathEnv);
  return {
    name: command,
    command,
    executablePath,
    discovered: executablePath !== null,
  };
}

/** Passive host discovery. It never starts a host or reads config contents. */
export function detectPassiveHosts(
  options: HostDetectionOptions,
): readonly PassiveHostObservation[] {
  const observedAt = options.observedAt ?? new Date().toISOString();
  const configs: Record<HostName, readonly string[]> = {
    pi: [join(options.homeDir, '.pi')],
    codex: [join(options.homeDir, '.codex', 'config.toml')],
    claude: [join(options.homeDir, '.claude', 'settings.json')],
  };
  const commands: Record<HostName, string> = {
    pi: 'pi',
    codex: 'codex',
    claude: 'claude',
  };
  const selected = new Set(options.selectedHosts);
  return (['pi', 'codex', 'claude'] as const).map((host) => {
    const executablePath = executableOnPath(commands[host], options.pathEnv);
    const configPaths = configs[host].filter((path) => existsSync(path));
    const evidenceRefs: EvidenceRef[] = [];
    if (executablePath !== null)
      evidenceRefs.push(evidence(executablePath, observedAt));
    for (const path of configPaths)
      evidenceRefs.push(evidence(path, observedAt));
    return {
      host,
      selected: selected.has(host),
      executablePath,
      discovered: executablePath !== null,
      configPaths,
      configured: configPaths.length > 0,
      callable: 'unknown',
      verification: 'unsupported',
      evidence: evidenceRefs,
    };
  });
}
