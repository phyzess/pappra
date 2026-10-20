import { isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path';

export const externalRepositoryPrefix = 'external:';

const portableIdentifier = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function hasNul(value: string): boolean {
  return value.includes('\0');
}

/**
 * Shared workspace paths are portable and relative: forward slashes only, no
 * drive or UNC prefix, and no lexical escape above the configuration root.
 */
export function isPortableRelativePath(value: string): boolean {
  if (value.length === 0 || hasNul(value) || value.includes('\\')) return false;
  if (posix.isAbsolute(value) || win32.isAbsolute(value)) return false;
  const normalized = posix.normalize(value);
  return (
    normalized !== '..' &&
    !normalized.startsWith('../') &&
    !normalized.startsWith('/')
  );
}

/** Normalizes a portable relative path to a stable, slash-separated form. */
export function normalizePortableRelativePath(value: string): string {
  const normalized = posix.normalize(value);
  if (normalized === '.') return '.';
  return normalized.replace(/\/+$/, '');
}

/** Resolves a portable relative path against a host-native root. */
export function resolvePortableRelativePath(
  root: string,
  value: string,
): string {
  const normalized = normalizePortableRelativePath(value);
  if (normalized === '.') return resolve(root);
  return resolve(root, ...normalized.split('/'));
}

/** Returns a slash-separated path relative to root, or null when outside. */
export function toWorkspaceRelativePath(
  root: string,
  target: string,
): string | null {
  if (!isPathInside(root, target)) return null;
  const path = relative(root, target);
  return path === '' ? '.' : path.split(sep).join('/');
}

export function isPathInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return (
    path === '' ||
    (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

/** Compares already-normalized paths; Windows comparisons are case-insensitive. */
export function samePath(left: string, right: string): boolean {
  if (process.platform === 'win32') {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

export function isExternalRepositoryPath(value: string): boolean {
  return value.startsWith(externalRepositoryPrefix);
}

/** Returns the logical ID in `external:<id>`, or null when malformed. */
export function externalRepositoryId(value: string): string | null {
  if (!isExternalRepositoryPath(value)) return null;
  const id = value.slice(externalRepositoryPrefix.length);
  return portableIdentifier.test(id) ? id : null;
}
