import { normalizePortableRelativePath } from '../schemas/paths.js';

/**
 * Directory names that discovery never descends into. These are conservative
 * defaults; explicit workspace.json repositories are still bounds-checked but
 * are not silently dropped by this scan filter.
 */
export const builtInExcludedSegments: ReadonlySet<string> = new Set([
  '.git',
  '.pappra',
  'node_modules',
  'dist',
  'build',
  '.build',
  'coverage',
  'target',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.codegraph',
  '.serena',
  '.idea',
  '.vscode',
]);

export function relativeSegments(relativePath: string): readonly string[] {
  if (relativePath === '.' || relativePath === '') return [];
  return relativePath.split('/');
}

/** Applies built-in segment exclusions and literal workspace-relative prefixes. */
export function isExcludedPath(
  relativePath: string,
  configExcludes: readonly string[],
): boolean {
  if (relativePath === '.' || relativePath === '') return false;
  const segments = relativeSegments(relativePath);
  if (segments.some((segment) => builtInExcludedSegments.has(segment))) {
    return true;
  }
  const normalized = normalizePortableRelativePath(relativePath);
  return configExcludes.some(
    (exclude) => normalized === exclude || normalized.startsWith(`${exclude}/`),
  );
}

export function isHiddenSegment(name: string): boolean {
  return name.startsWith('.') && name !== '.' && name !== '..';
}
