import type { Resource, ResourceInput } from './types.js';
import { errorCode } from './validation.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Resource identity and path canonicalisation. Two claims overlap only when their
// canonical paths are equal or one contains the other on a path-segment boundary,
// so `repo-a` and `repo-ab` are never treated as nested.

const PATH_KINDS = new Set([
  'path',
  'git-index',
  'git-head',
  'git-common-dir',
  'build-cache',
  'file',
]);
const OPAQUE_KINDS = new Set(['port', 'opaque', 'process']);

export const RESOURCE_KINDS = Object.freeze(
  [...PATH_KINDS, ...OPAQUE_KINDS].sort(),
);

/**
 * Resolve the longest existing ancestor with realpath and append the not-yet-existing
 * suffix. Symlink aliases therefore collapse to one key. The suffix keeps the caller's
 * spelling, so a differently-cased non-existent target is not normalised.
 */
export function canonicalizeTarget(input: string) {
  if (typeof input !== 'string' || input.trim().length === 0)
    throw new Error('Resource path must be a non-empty string');
  if (!path.isAbsolute(input))
    throw new Error('Resource path must be absolute');
  const missing = [];
  let probe = path.normalize(input);
  for (;;) {
    try {
      const real = fs.realpathSync(probe);
      return {
        path: path.join(real, ...missing.slice().reverse()),
        existing: missing.length === 0,
        nearest_ancestor: real,
      };
    } catch (error) {
      if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'ENOTDIR')
        throw new Error(`Cannot resolve resource path: ${errorCode(error)}`);
      const parent = path.dirname(probe);
      if (parent === probe)
        throw new Error('Resource path has no existing ancestor');
      missing.push(path.basename(probe));
      probe = parent;
    }
  }
}

/** `same`, `ancestor`, `descendant` or `disjoint` on path-segment boundaries. */
export function pathRelation(left: string, right: string) {
  if (left === right) return 'same';
  const a = left.split(path.sep).filter(Boolean);
  const b = right.split(path.sep).filter(Boolean);
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    if (a[index] !== b[index]) return 'disjoint';
  }
  return a.length < b.length ? 'ancestor' : 'descendant';
}

export function pathsOverlap(left: string, right: string) {
  return pathRelation(left, right) !== 'disjoint';
}

function opaque(value: unknown) {
  return `sha256:${crypto.createHash('sha256').update(String(value)).digest('hex')}`;
}

/**
 * Build the canonical descriptor for one requested resource.
 * Input: {kind?, path?, port?, value?}. Unknown kinds are rejected rather than guessed.
 */
export function describeResource(input: ResourceInput): Resource {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Resource must be an object');
  const kind = input.kind ?? 'path';
  if (!RESOURCE_KINDS.includes(kind))
    throw new Error(`Unsupported resource kind: ${kind}`);
  if (OPAQUE_KINDS.has(kind)) {
    if (kind === 'port') {
      if (
        typeof input.port !== 'number' ||
        !Number.isSafeInteger(input.port) ||
        input.port <= 0 ||
        input.port > 65535
      )
        throw new Error('Port must be an integer between 1 and 65535');
      return {
        kind,
        scope: 'opaque',
        key: `port:${input.port}`,
        port: input.port,
        label: input.label ?? `port ${input.port}`,
      };
    }
    const value = input.value;
    if (typeof value !== 'string' || value.trim().length === 0)
      throw new Error('Opaque resources require a non-empty value');
    return {
      kind,
      scope: 'opaque',
      key: `${kind}:${value}`,
      label: input.label ?? `${kind} ${value}`,
    };
  }
  if (typeof input.path !== 'string')
    throw new Error('Resource path must be a non-empty string');
  const resolved = canonicalizeTarget(input.path);
  // A not-yet-existing target is treated conservatively as a tree: claiming it also
  // reserves anything created underneath it.
  const scope = input.scope === 'file' ? 'file' : 'tree';
  return {
    kind,
    scope,
    key: `${kind}:${resolved.path}`,
    path: resolved.path,
    existing: resolved.existing,
    label: input.label ?? `${kind} ${resolved.path}`,
  };
}

/**
 * Overlap between two claims. Path-like kinds compare on canonical paths; opaque kinds
 * (ports, processes) only on exact keys. `port:` and `path:` never overlap.
 */
export function claimsOverlap(left: Resource, right: Resource) {
  const leftOpaque = OPAQUE_KINDS.has(left.kind);
  const rightOpaque = OPAQUE_KINDS.has(right.kind);
  if (leftOpaque || rightOpaque)
    return leftOpaque && rightOpaque && left.key === right.key;
  if (!PATH_KINDS.has(left.kind) || !PATH_KINDS.has(right.kind))
    return left.key === right.key;
  if (typeof left.path !== 'string' || typeof right.path !== 'string')
    throw new Error('Path resource requires a canonical path');
  return pathsOverlap(left.path, right.path);
}

export function opaqueKey(prefix: string, value: unknown) {
  return `${prefix}:${opaque(value)}`;
}
