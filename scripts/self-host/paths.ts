import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import type { Stats } from 'node:fs';

export function errorCodeOrUnknown(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return 'unknown';
  }
  const code = error.code;
  return typeof code === 'string' ? code : 'unknown';
}

export type LstatOutcome =
  | { readonly kind: 'present'; readonly stats: Stats }
  | { readonly kind: 'missing' }
  | { readonly kind: 'error'; readonly code: string };

/**
 * `missing` means ENOENT and nothing else. Any other failure stays an explicit
 * error so it can never be read as an absent path that authorizes a write.
 */
export function lstatOutcome(path: string): LstatOutcome {
  try {
    return { kind: 'present', stats: lstatSync(path) };
  } catch (error) {
    const code = errorCodeOrUnknown(error);
    return code === 'ENOENT' ? { kind: 'missing' } : { kind: 'error', code };
  }
}

export function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function readlinkOrNull(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

export function parentRefusal(
  path: string,
  label: string,
): { readonly detail: string } | null {
  const outcome = lstatOutcome(path);
  if (outcome.kind === 'missing') return null;
  if (outcome.kind === 'error') {
    return { detail: `cannot inspect ${label} (${outcome.code})` };
  }
  if (outcome.stats.isSymbolicLink()) {
    return { detail: `${label} is a symlink; refusing to write through it` };
  }
  if (!outcome.stats.isDirectory()) {
    return { detail: `${label} is not a directory` };
  }
  return null;
}
