import { basename, dirname, join, resolve } from 'node:path';
import type { Outcome } from '../schemas/outcome.js';
import { failed, succeeded } from '../schemas/outcome.js';
import { diagnosticCodes } from '../schemas/errors.js';
import type { DocumentLocation } from '../schemas/document.js';
import {
  isPathInside,
  normalizePortableRelativePath,
  resolvePortableRelativePath,
  samePath,
} from '../schemas/paths.js';
import { observePath, readFileBounded, resolveRealpath } from '../infra/fs.js';
import type { KnowledgeContext } from './context.js';
import type { DiscoveredRepository } from '../workspace/types.js';

export interface KnowledgePaths {
  readonly sharedCatalog: string;
  readonly privateCatalog: string;
  readonly localDir: string;
  readonly lockPath: string;
  readonly journalsDir: string;
}

export function knowledgePaths(root: string): KnowledgePaths {
  const localDir = join(root, '.pappra', 'local', 'knowledge');
  return {
    sharedCatalog: join(root, '.pappra', 'knowledge', 'records'),
    privateCatalog: join(localDir, 'catalog.json'),
    localDir,
    lockPath: join(localDir, 'apply.lock'),
    journalsDir: join(localDir, 'journals'),
  };
}

const managedStatePrefixes = [
  '.pappra/local',
  '.pappra/generated',
  '.pappra/knowledge/catalog.json',
  '.pappra/knowledge/records',
] as const;

/**
 * Rejects a path if its final component or any existing ancestor resolves
 * outside the allowed root. Missing parents are checked at their nearest
 * existing ancestor; creation may add only descendants below that root.
 */
export async function ensureKnowledgePathBoundary(
  root: string,
  path: string,
): Promise<Outcome<null>> {
  if (!isPathInside(root, path)) {
    return failed(
      diagnosticCodes.document_path_unsafe,
      `Path is outside the allowed knowledge root: ${path}`,
      {
        nextAction:
          'Use a path inside the workspace or an explicit repository.',
      },
    );
  }
  const realRoot = await resolveRealpath(root);
  if (realRoot === null) {
    return failed(
      diagnosticCodes.document_path_unsafe,
      `Cannot resolve knowledge root: ${root}`,
      { nextAction: 'Use an existing readable workspace root.' },
    );
  }
  const candidate = await resolveRealpath(path);
  if (candidate !== null) {
    return isPathInside(realRoot, candidate)
      ? succeeded(null)
      : failed(
          diagnosticCodes.document_path_unsafe,
          `Knowledge path resolves outside its root: ${path} -> ${candidate}`,
          {
            nextAction:
              'Keep knowledge paths as regular files inside the workspace.',
          },
        );
  }
  let ancestor = dirname(path);
  for (;;) {
    let observation;
    try {
      observation = await observePath(ancestor);
    } catch (error) {
      return failed(
        diagnosticCodes.fileUnreadable,
        `Cannot inspect knowledge parent ${ancestor}: ${error instanceof Error ? error.message : String(error)}`,
        {
          nextAction:
            'Check permissions; Pappra did not write through this path.',
        },
      );
    }
    if (observation.kind !== 'missing') {
      if (observation.kind !== 'directory') {
        return failed(
          diagnosticCodes.document_path_unsafe,
          `Knowledge parent is not a directory: ${ancestor}`,
          {
            nextAction:
              'Inspect the parent path; Pappra does not write through it.',
          },
        );
      }
      const real = await resolveRealpath(ancestor);
      return real !== null && isPathInside(realRoot, real)
        ? succeeded(null)
        : failed(
            diagnosticCodes.document_path_unsafe,
            `Knowledge parent escapes its root: ${ancestor}`,
            {
              nextAction: 'Inspect or remove the symlinked parent explicitly.',
            },
          );
    }
    const parent = dirname(ancestor);
    if (samePath(parent, ancestor)) {
      return failed(
        diagnosticCodes.document_path_unsafe,
        `Cannot find an existing parent for ${path}`,
        { nextAction: 'Create the parent inside the workspace first.' },
      );
    }
    ancestor = parent;
  }
}

async function nestedWorkspaceBoundary(
  allowedRoot: string,
  startDirectory: string,
): Promise<string | null> {
  if (!isPathInside(allowedRoot, startDirectory)) return null;
  let current = startDirectory;
  while (!samePath(current, allowedRoot)) {
    if ((await observePath(join(current, '.pappra'))).kind !== 'missing') {
      return current;
    }
    const parent = dirname(current);
    if (samePath(parent, current) || !isPathInside(allowedRoot, parent)) {
      return null;
    }
    current = parent;
  }
  return null;
}

async function canonicalTargetPath(path: string): Promise<string | null> {
  let current = path;
  const missingSegments: string[] = [];
  for (;;) {
    const real = await resolveRealpath(current);
    if (real !== null) {
      return missingSegments.length === 0
        ? real
        : resolve(real, ...missingSegments.reverse());
    }
    const parent = dirname(current);
    if (samePath(parent, current)) return null;
    missingSegments.push(basename(current));
    current = parent;
  }
}

function containingRepository(
  context: KnowledgeContext,
  target: string,
): DiscoveredRepository | null {
  let match: DiscoveredRepository | null = null;
  for (const repository of context.repositories) {
    if (!isPathInside(repository.root, target)) continue;
    if (match === null || repository.root.length > match.root.length) {
      match = repository;
    }
  }
  return match;
}

export interface ResolvedKnowledgeLocation {
  readonly location: DocumentLocation;
  readonly absolutePath: string;
  readonly containmentRoot: string;
  readonly canonicalPath: string;
  readonly repository: DiscoveredRepository | null;
  readonly access: 'read' | 'write';
  readonly normalizedPath: string;
}

export interface ResolveLocationOptions {
  readonly forWrite?: boolean;
  readonly forCreate?: boolean;
}

export async function resolveKnowledgeLocation(
  context: KnowledgeContext,
  location: DocumentLocation,
  options: ResolveLocationOptions = {},
): Promise<Outcome<ResolvedKnowledgeLocation>> {
  const normalizedPath = normalizePortableRelativePath(location.path);
  if (normalizedPath === '.' || location.path !== normalizedPath) {
    return failed(
      diagnosticCodes.document_path_unsafe,
      `Document path must be a normalized non-empty relative path: ${location.path}`,
      {
        nextAction:
          'Use a forward-slash relative path such as docs/architecture.md.',
      },
    );
  }
  let containmentRoot = context.root;
  let repository: DiscoveredRepository | null = null;
  let access: 'read' | 'write' = 'write';
  if (location.kind === 'workspace') {
    if (
      managedStatePrefixes.some(
        (prefix) =>
          normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`),
      )
    ) {
      return failed(
        diagnosticCodes.document_path_unsafe,
        `Document path is Pappra-managed state: ${normalizedPath}`,
        {
          nextAction: 'Keep knowledge documents outside local/generated state.',
        },
      );
    }
  } else {
    repository =
      context.repositories.find((entry) => entry.id === location.sourceId) ??
      null;
    if (repository === null) {
      return failed(
        diagnosticCodes.document_source_invalid,
        `Unknown explicit repository source: ${location.sourceId}`,
        {
          nextAction:
            'Declare the repository and its local mapping before registering its documents.',
        },
      );
    }
    containmentRoot = repository.root;
    access = repository.access;
  }
  const absolutePath =
    location.kind === 'workspace'
      ? resolvePortableRelativePath(context.root, normalizedPath)
      : resolvePortableRelativePath(containmentRoot, normalizedPath);
  if (!isPathInside(containmentRoot, absolutePath)) {
    return failed(
      diagnosticCodes.document_path_unsafe,
      `Path is outside the allowed knowledge root: ${absolutePath}`,
      {
        nextAction: 'Use a path inside the declared workspace/repository root.',
      },
    );
  }
  const canonicalTarget = await canonicalTargetPath(absolutePath);
  if (canonicalTarget !== null) {
    const targetRepository = containingRepository(context, canonicalTarget);
    if (targetRepository !== null) {
      repository = targetRepository;
      access = targetRepository.access;
    }
  }
  if (options.forWrite === true && access !== 'write') {
    return failed(
      diagnosticCodes.document_access_denied,
      `Canonical document target is read-only: ${absolutePath}`,
      {
        nextAction:
          'Use a workspace/repository whose canonical checkout permits writes.',
      },
    );
  }
  let boundary: string | null;
  try {
    boundary = await nestedWorkspaceBoundary(
      containmentRoot,
      dirname(absolutePath),
    );
  } catch (error) {
    return failed(
      diagnosticCodes.fileUnreadable,
      `Cannot inspect nested workspace boundaries: ${error instanceof Error ? error.message : String(error)}`,
      { nextAction: 'Check permissions; no document path was written.' },
    );
  }
  if (boundary !== null) {
    return failed(
      diagnosticCodes.document_nested_workspace,
      `Document is inside nested workspace ${boundary}: ${absolutePath}`,
      { nextAction: 'Register the document in the nested workspace instead.' },
    );
  }
  const boundaryCheck = await ensureKnowledgePathBoundary(
    containmentRoot,
    absolutePath,
  );
  if (!boundaryCheck.ok) return boundaryCheck;
  if (!options.forCreate) {
    let observation;
    try {
      observation = await observePath(absolutePath);
    } catch (error) {
      return failed(
        diagnosticCodes.fileUnreadable,
        `Cannot inspect document ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
        { nextAction: 'Check permissions; the file was not read or written.' },
      );
    }
    if (observation.kind === 'missing') {
      return failed(
        diagnosticCodes.document_not_found,
        `Document file does not exist: ${absolutePath}`,
        { nextAction: 'Create or register an existing regular file.' },
      );
    }
    if (observation.kind !== 'file') {
      return failed(
        diagnosticCodes.document_path_unsafe,
        `Document path is not a regular file: ${absolutePath}`,
        {
          nextAction:
            'Symlinks, directories, FIFOs, and devices are not document files.',
        },
      );
    }
    const real = await resolveRealpath(absolutePath);
    if (real === null || !isPathInside(containmentRoot, real)) {
      return failed(
        diagnosticCodes.document_path_unsafe,
        `Document path resolves outside its root: ${absolutePath}`,
        {
          nextAction:
            'Keep documents as regular files inside the allowed root.',
        },
      );
    }
    if (options.forWrite === true && access !== 'write') {
      return failed(
        diagnosticCodes.document_access_denied,
        `Document is read-only: ${absolutePath}`,
        {
          nextAction: 'Write only through a writable workspace or repository.',
        },
      );
    }
  } else {
    let observation;
    try {
      observation = await observePath(absolutePath);
    } catch (error) {
      return failed(
        diagnosticCodes.fileUnreadable,
        `Cannot inspect new document target ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
        { nextAction: 'Check permissions; no document was written.' },
      );
    }
    if (observation.kind !== 'missing') {
      return failed(
        diagnosticCodes.document_already_registered,
        `New document target already exists: ${absolutePath}`,
        {
          nextAction:
            'Use proposeWrite to update the existing file; do not overwrite it as a new document.',
        },
      );
    }
  }
  return succeeded({
    location,
    absolutePath,
    containmentRoot,
    canonicalPath: canonicalTarget ?? absolutePath,
    repository,
    access,
    normalizedPath,
  });
}

export async function readKnowledgeFile(
  path: string,
  maxBytes: number,
): Promise<
  Outcome<{
    readonly bytes: Buffer;
    readonly digest: string;
    readonly size: number;
  }>
> {
  return readFileBounded(path, maxBytes);
}
