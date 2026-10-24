import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));

export function listFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = join(root, entry.name);
    return entry.isDirectory() ? listFiles(file) : [file];
  });
}

export function runNode(
  args: readonly string[],
  cwd = projectRoot,
  timeoutMs = 360_000,
  env?: NodeJS.ProcessEnv,
): void {
  const result = spawnSync(process.execPath, [...args], {
    cwd,
    stdio: 'inherit',
    shell: false,
    // P08 real-engine fixtures and the P10 integration/CLI matrix add bounded
    // process time; keep a finite ceiling rather than allowing a wedged test
    // process to hang.
    timeout: timeoutMs,
    ...(env === undefined ? {} : { env }),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Node command failed (${result.status ?? result.signal}).`);
  }
}

export function npmCli(): string {
  const bin = dirname(process.execPath);
  const candidates = [
    resolve(bin, '../lib/node_modules/npm/bin/npm-cli.js'),
    resolve(bin, 'node_modules/npm/bin/npm-cli.js'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('npm must be installed alongside Node.js.');
  return found;
}

export interface PnpmCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

/**
 * Locates the pnpm that is running this check. A runtime dependency means the
 * package smoke test must install from the same content-addressable store as
 * the lockfile install instead of relying on the npm cache.
 */
export function pnpmCommand(): PnpmCommand {
  const execpath = process.env.npm_execpath;
  if (execpath !== undefined) {
    const lower = execpath.toLowerCase();
    if (lower.includes('pnpm')) {
      if (/\.(?:c|m)?js$/.test(lower)) {
        return { executable: process.execPath, args: [execpath] };
      }
      return { executable: execpath, args: [] };
    }
  }
  return {
    executable: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    args: [],
  };
}
