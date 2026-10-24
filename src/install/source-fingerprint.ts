import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  observePath,
  readFileBounded,
  readTextFileBounded,
  resolveRealpath,
  sha256Digest,
} from '../infra/fs.js';
import { isPathInside } from '../schemas/paths.js';
import {
  readPackageDependencyManifest,
  resolveInstalledDependency,
} from './dependencies.js';

/** Exactly the payload entries staged by the self-package installer. */
const SELF_PAYLOAD = [
  'package.json',
  'README.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'dist',
  'assets',
  'skills',
] as const;

/** Payload bytes plus actual resolved package-manifest/edge identities; no absolute paths. */
export async function fingerprintSelfSource(
  packageRoot: string,
  packageName: string,
  version: string,
): Promise<string> {
  const canonical = await resolveRealpath(packageRoot);
  if (!canonical) throw new Error('Running package root cannot be resolved.');
  const parts: string[] = [];
  let files = 0;
  let bytes = 0;
  const active = new Set<string>();
  const visit = async (relative: string): Promise<void> => {
    const path = join(canonical, relative);
    const presence = await observePath(path);
    if (presence.kind === 'missing') {
      parts.push(`missing:${relative}`);
      return;
    }
    const real = await resolveRealpath(path);
    if (!real || !isPathInside(canonical, real))
      throw new Error(`Self payload escapes its package root: ${relative}`);
    const target = await observePath(real);
    if (target.kind === 'directory') {
      if (active.has(real))
        throw new Error('Self payload contains a directory cycle.');
      active.add(real);
      parts.push(`dir:${relative}`);
      for (const entry of (await readdir(real)).sort())
        await visit(`${relative}/${entry}`);
      active.delete(real);
    } else if (target.kind === 'file') {
      if (++files > 8192)
        throw new Error('Self payload exceeds the fingerprint file budget.');
      const read = await readFileBounded(real, 64 * 1024 * 1024);
      if (!read.ok)
        throw new Error(`Cannot fingerprint self payload: ${relative}`);
      bytes += read.value.size;
      if (bytes > 256 * 1024 * 1024)
        throw new Error('Self payload exceeds the fingerprint byte budget.');
      parts.push(`file:${relative}:${read.value.digest}`);
    } else throw new Error(`Unsupported self payload entry: ${relative}`);
  };
  const manifest = await readTextFileBounded(join(canonical, 'package.json'));
  if (!manifest.ok) throw new Error('Running package manifest is unreadable.');
  const decoded = JSON.parse(manifest.value.text) as {
    name?: unknown;
    version?: unknown;
  };
  if (decoded.name !== packageName || decoded.version !== version)
    throw new Error(
      'Running package name/version differs from the requested runtime; bump the package version before reinstalling.',
    );
  for (const entry of SELF_PAYLOAD) await visit(entry);
  const visited = new Set<string>();
  const graph = new Set<string>();
  const dependencies = async (directory: string): Promise<void> => {
    const real = await resolveRealpath(directory);
    if (!real || visited.has(real)) return;
    visited.add(real);
    if (visited.size > 512)
      throw new Error('Resolved dependency identity budget exceeded.');
    const read = await readTextFileBounded(join(real, 'package.json'));
    const declared = await readPackageDependencyManifest(real);
    if (!read.ok || !declared)
      throw new Error('Cannot read a resolved dependency manifest.');
    const value = JSON.parse(read.value.text) as {
      name?: unknown;
      version?: unknown;
    };
    const edges: string[] = [];
    for (const [kind, names] of [
      ['required', declared.required],
      ['optional', declared.optional],
    ] as const) {
      for (const name of [...names].sort()) {
        const resolved = await resolveInstalledDependency(real, name);
        if (!resolved) {
          edges.push(`${kind}:${name}:missing`);
          continue;
        }
        const resolvedManifest = await readTextFileBounded(
          join(resolved, 'package.json'),
        );
        if (!resolvedManifest.ok)
          throw new Error('Cannot read a resolved dependency identity.');
        edges.push(`${kind}:${name}:${resolvedManifest.value.digest}`);
        await dependencies(resolved);
      }
    }
    graph.add(
      `${String(value.name)}@${String(value.version)}:${read.value.digest}:${edges.join('|')}`,
    );
  };
  await dependencies(canonical);
  return sha256Digest(
    [...parts, ...[...graph].sort().map((entry) => `dependency:${entry}`)].join(
      '\n',
    ),
  );
}
