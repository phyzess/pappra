import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  DIST_ENTRY,
  type CliDeps,
  type CliResult,
  type EntryOptions,
} from './types.ts';

/** Runs this repository's built CLI; never a global installation. */
export function runDistCli(root: string, args: readonly string[]): CliResult {
  const result = spawnSync(
    process.execPath,
    [join(root, DIST_ENTRY), ...args],
    {
      cwd: root,
      encoding: 'utf8',
      shell: false,
      timeout: 300_000,
      env: { ...process.env, NO_COLOR: '1' },
    },
  );
  if (result.error) {
    return { status: null, stdout: '', stderr: result.error.message };
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function defaultDeps(root: string): CliDeps {
  return { runCli: (args) => runDistCli(root, args) };
}

/**
 * Parses the entry's own flags. Only the documented switches are accepted, and
 * `--check` and `--apply` are mutually exclusive.
 */
export function parseEntryOptions(
  argv: readonly string[],
): EntryOptions | null {
  const allowed = new Set(['--check', '--apply', '--json']);
  const unknown = argv.find((arg) => !allowed.has(arg));
  if (unknown !== undefined) return null;
  const apply = argv.includes('--apply');
  if (apply && argv.includes('--check')) return null;
  return { apply, json: argv.includes('--json') };
}
