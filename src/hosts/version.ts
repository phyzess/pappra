import { spawnSync } from 'node:child_process';
import type { HostName } from '../schemas/host.js';
import { executableOnPath } from './detect.js';

/** Bounded executable observation only; never sends a prompt or starts a model. */
export function observeHostVersion(
  host: HostName,
  pathEnv: string,
): string | null {
  const executable = executableOnPath(host, pathEnv);
  if (!executable) return null;
  const result = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    shell: false,
    timeout: 5000,
    maxBuffer: 16 * 1024,
    env: { ...process.env, PATH: pathEnv },
  });
  if (result.error || result.status !== 0) return null;
  return (
    /(?:^|\s)([0-9]+\.[0-9]+\.[0-9]+)(?:\s|$)/.exec(
      `${result.stdout}\n${result.stderr}`,
    )?.[1] ?? null
  );
}
