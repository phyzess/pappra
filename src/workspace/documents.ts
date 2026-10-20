import { basename, dirname, join, relative, sep } from 'node:path';
import { readdir } from 'node:fs/promises';
import type { Diagnostic } from '../schemas/diagnostics.js';
import { createDiagnostic, pointer } from '../schemas/diagnostics.js';
import { diagnosticCodes } from '../schemas/errors.js';
import {
  isPathInside,
  resolvePortableRelativePath,
  samePath,
  toWorkspaceRelativePath,
} from '../schemas/paths.js';
import {
  normalizedExcludes,
  type WorkspaceConfig,
} from '../schemas/workspace.js';
import { observePath, resolveRealpath } from '../infra/fs.js';
import { filterGitIgnored } from '../infra/git.js';
import { isExcludedPath, isHiddenSegment } from './ignore.js';
import type {
  DiscoveredDocument,
  DiscoveredRepository,
  DocumentKind,
  DocumentOrigin,
  NormalizedDiscoveryOptions,
} from './types.js';

export interface DocumentDiscoveryInput {
  readonly root: string;
  readonly config: WorkspaceConfig | null;
  readonly configPath: string;
  readonly repositories: readonly DiscoveredRepository[];
  readonly options: NormalizedDiscoveryOptions;
}

export interface DocumentDiscoveryOutput {
  readonly documents: readonly DiscoveredDocument[];
  readonly boundaries: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
  readonly truncated: boolean;
}

const ruleFileNames = new Set([
  'agents.md',
  'claude.md',
  '.cursorrules',
  'copilot-instructions.md',
]);

const documentationFileNames = new Set([
  'readme.md',
  'contributing.md',
  'architecture.md',
  'security.md',
  'context.md',
]);

function classifyDocument(path: string, root: string): DocumentKind {
  const name = basename(path).toLowerCase();
  if (ruleFileNames.has(name)) return 'rule';
  const relativePath = toWorkspaceRelativePath(root, path);
  const normalized = (
    relativePath ?? relative(root, path).split(sep).join('/')
  ).toLowerCase();
  if (
    normalized.split('/').includes('adr') ||
    normalized.includes('/decisions/') ||
    normalized.includes('/decision-records/')
  ) {
    return 'decision-record';
  }
  return 'documentation';
}

async function hasWorkspaceMarker(directory: string): Promise<boolean> {
  return (await observePath(join(directory, '.pappra'))).kind !== 'missing';
}

/**
 * Finds the nearest nested workspace on the canonical path from an allowed
 * root to a target directory. The allowed root itself is exempt, so an
 * external checkout or workspace root may own a `.pappra` marker.
 */
async function nestedWorkspaceBoundary(
  allowedRoot: string,
  startDirectory: string,
): Promise<string | null> {
  if (!isPathInside(allowedRoot, startDirectory)) return null;
  let current = startDirectory;
  while (!samePath(current, allowedRoot)) {
    if (await hasWorkspaceMarker(current)) return current;
    const parent = dirname(current);
    if (samePath(parent, current) || !isPathInside(allowedRoot, parent)) {
      return null;
    }
    current = parent;
  }
  return null;
}

function isMarkdown(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.endsWith('.md') || lower.endsWith('.mdx') || lower.endsWith('.mdc')
  );
}

/**
 * Finds existing rules and documents in place. Content is never read, moved,
 * or rewritten; only path, kind, provenance and size are reported.
 */
export async function discoverDocuments(
  input: DocumentDiscoveryInput,
): Promise<DocumentDiscoveryOutput> {
  const { root, config, configPath, repositories, options } = input;
  const diagnostics: Diagnostic[] = [];
  const documents = new Map<string, DiscoveredDocument>();
  const boundaries = new Set<string>();
  const excluded = config === null ? [] : normalizedExcludes(config);
  let truncated = false;
  let scannedDirectories = 0;

  const enclosingRepository = (path: string): DiscoveredRepository | null => {
    let match: DiscoveredRepository | null = null;
    for (const repository of repositories) {
      if (!isPathInside(repository.root, path)) continue;
      if (match === null || repository.root.length > match.root.length) {
        match = repository;
      }
    }
    return match;
  };

  const addDocument = async (
    path: string,
    origin: DocumentOrigin,
    declaredBy: string,
    containmentRoot: string,
    forcedKind: DocumentKind | null = null,
  ): Promise<void> => {
    if (documents.size >= options.maxDocuments) {
      if (!truncated) {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.discoveryLimitReached,
            severity: 'warning',
            message: `Document discovery stopped after ${options.maxDocuments} entries.`,
            source: root,
            hint: 'Reduce knowledge.sources or raise the bound explicitly.',
          }),
        );
        truncated = true;
      }
      return;
    }
    const observation = await observePath(path);
    if (observation.kind === 'missing' || observation.kind === 'other') return;
    if (observation.kind === 'symlink') {
      const target = await resolveRealpath(path);
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.discoverySymlinkSkipped,
          severity: 'info',
          message: `Document symlink was not followed: ${path}${target === null ? '' : ` -> ${target}`}`,
          source: declaredBy,
          hint: 'Keep documentation as regular files; discovery does not follow symlinks.',
        }),
      );
      return;
    }
    if (observation.kind !== 'file') return;
    const real = await resolveRealpath(path);
    if (real === null) return;
    if (!isPathInside(containmentRoot, real)) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.documentPathEscapesRoot,
          severity: 'warning',
          message: `Document resolves outside its allowed root: ${path} -> ${real}`,
          source: declaredBy,
          hint: 'Keep workspace documents inside the workspace; an explicit external repository may only contribute documents inside that checkout.',
        }),
      );
      return;
    }
    const boundary = await nestedWorkspaceBoundary(
      containmentRoot,
      dirname(real),
    );
    if (boundary !== null) {
      boundaries.add(boundary);
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.discoveryNestedWorkspace,
          severity: 'info',
          message: `Document is inside nested workspace ${boundary}: ${real}`,
          source: declaredBy,
          hint: 'The outer discovery does not enter or absorb a nested workspace.',
        }),
      );
      return;
    }
    if (documents.has(real)) return;
    const repository = enclosingRepository(real);
    documents.set(real, {
      path: real,
      workspaceRelativePath: toWorkspaceRelativePath(root, real),
      repositoryId: repository?.id ?? null,
      kind: forcedKind ?? classifyDocument(real, root),
      origin,
      declaredBy,
      sizeBytes: observation.stats?.size ?? 0,
    });
  };

  const scanDirectory = async (
    directory: string,
    depthLimit: number,
    origin: DocumentOrigin,
    declaredBy: string,
    containmentRoot: string,
    forcedKind: DocumentKind | null,
  ): Promise<void> => {
    const visit = async (current: string, depth: number): Promise<void> => {
      if (scannedDirectories >= options.maxDirectories) {
        if (!truncated) {
          diagnostics.push(
            createDiagnostic({
              code: diagnosticCodes.discoveryLimitReached,
              severity: 'warning',
              message: `Document scan stopped after ${options.maxDirectories} directories.`,
              source: current,
              hint: 'Narrow knowledge.sources or the workspace scope.',
            }),
          );
          truncated = true;
        }
        return;
      }
      scannedDirectories += 1;
      const directoryReal = await resolveRealpath(current);
      if (directoryReal === null) {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.fileUnreadable,
            severity: 'warning',
            message: `Cannot resolve document directory: ${current}`,
            source: current,
            hint: 'Check permissions; discovery skips unreadable directories.',
          }),
        );
        return;
      }
      if (!isPathInside(containmentRoot, directoryReal)) {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.documentPathEscapesRoot,
            severity: 'warning',
            message: `Document directory resolves outside its allowed root: ${current} -> ${directoryReal}`,
            source: current,
            hint: 'Keep workspace documents inside the workspace; external repository documents must stay inside that checkout.',
          }),
        );
        return;
      }
      const boundary = await nestedWorkspaceBoundary(
        containmentRoot,
        directoryReal,
      );
      if (boundary !== null) {
        boundaries.add(boundary);
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.discoveryNestedWorkspace,
            severity: 'info',
            message: `Document directory is inside nested workspace ${boundary}: ${directoryReal}`,
            source: current,
            hint: 'The outer discovery does not enter or absorb a nested workspace.',
          }),
        );
        return;
      }
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch (error) {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.fileUnreadable,
            severity: 'warning',
            message: `Cannot read document directory ${current}: ${error instanceof Error ? error.message : String(error)}`,
            source: current,
            hint: 'Check permissions; discovery skips unreadable directories.',
          }),
        );
        return;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      const limited = entries.slice(0, options.maxEntriesPerDirectory);
      if (entries.length > limited.length) {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.discoveryLimitReached,
            severity: 'warning',
            message: `Document directory has ${entries.length} entries; only the first ${limited.length} were inspected.`,
            source: current,
            hint: 'Reduce the directory scope or raise the bound explicitly.',
          }),
        );
        truncated = true;
      }
      for (const entry of limited) {
        if (isHiddenSegment(entry.name)) continue;
        const child = join(current, entry.name);
        const workspaceRelative = toWorkspaceRelativePath(root, child);
        const localRelative =
          workspaceRelative ?? relative(directory, child).split(sep).join('/');
        if (
          isExcludedPath(
            workspaceRelative ?? localRelative,
            workspaceRelative === null ? [] : excluded,
          )
        ) {
          continue;
        }
        if (entry.isSymbolicLink()) {
          const target = await resolveRealpath(child);
          const outside = target === null || !isPathInside(directory, target);
          diagnostics.push(
            createDiagnostic({
              code: diagnosticCodes.discoverySymlinkSkipped,
              severity: outside ? 'warning' : 'info',
              message: `Document symlink was not followed: ${child}${target === null ? '' : ` -> ${target}`}`,
              source: current,
              hint: 'Keep documentation inside the workspace; external symlinks are never followed.',
            }),
          );
          continue;
        }
        if (entry.isDirectory()) {
          if (depth < depthLimit) await visit(child, depth + 1);
          continue;
        }
        if (!entry.isFile() || !isMarkdown(child)) continue;
        await addDocument(
          child,
          origin,
          declaredBy,
          containmentRoot,
          forcedKind,
        );
      }
    };
    await visit(directory, 0);
  };

  const wellKnownRoots = new Map<string, DiscoveredRepository | null>();
  wellKnownRoots.set(root, enclosingRepository(root));
  for (const repository of repositories) {
    wellKnownRoots.set(repository.root, repository);
  }

  const addWellKnown = async (
    directory: string,
    repository: DiscoveredRepository | null,
  ): Promise<void> => {
    const origin: DocumentOrigin =
      repository === null ? 'well-known' : 'repository-scan';
    const declaredPrefix =
      repository === null ? 'well-known' : 'repository-scan';
    const containmentRoot = repository?.root ?? root;
    for (const name of [
      'AGENTS.md',
      'CLAUDE.md',
      '.cursorrules',
      'README.md',
      'CONTRIBUTING.md',
      'ARCHITECTURE.md',
      'SECURITY.md',
      'CONTEXT.md',
    ]) {
      const path = join(directory, name);
      await addDocument(
        path,
        origin,
        `${declaredPrefix}:${name}`,
        containmentRoot,
        ruleFileNames.has(name.toLowerCase())
          ? 'rule'
          : documentationFileNames.has(name.toLowerCase())
            ? 'documentation'
            : null,
      );
    }
    await addDocument(
      join(directory, '.github', 'copilot-instructions.md'),
      origin,
      `${declaredPrefix}:.github/copilot-instructions.md`,
      containmentRoot,
      'rule',
    );
    const cursorRules = join(directory, '.cursor', 'rules');
    const cursorObservation = await observePath(cursorRules);
    if (cursorObservation.kind === 'directory') {
      await scanDirectory(
        cursorRules,
        2,
        origin,
        `${declaredPrefix}:.cursor/rules`,
        containmentRoot,
        'rule',
      );
    }
    const docs = join(directory, 'docs');
    const docsObservation = await observePath(docs);
    if (docsObservation.kind === 'directory') {
      await scanDirectory(
        docs,
        3,
        repository === null ? 'directory-scan' : 'repository-scan',
        `${declaredPrefix}:docs`,
        containmentRoot,
        null,
      );
    }
  };

  if (config !== null) {
    for (const [index, source] of config.knowledge.sources.entries()) {
      const declaredBy = `${configPath}#${pointer('knowledge', 'sources', index)}`;
      const candidate = resolvePortableRelativePath(root, source);
      const observation = await observePath(candidate);
      if (observation.kind === 'missing') {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.knowledgeSourceMissing,
            severity: 'error',
            message: `Configured knowledge source does not exist: ${candidate}`,
            source: configPath,
            pointer: pointer('knowledge', 'sources', index),
            hint: 'Correct or remove the source; Pappra does not create or migrate documentation.',
          }),
        );
        continue;
      }
      const real = await resolveRealpath(candidate);
      if (real === null) {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.knowledgeSourceNotReadable,
            severity: 'error',
            message: `Cannot resolve configured knowledge source: ${candidate}`,
            source: configPath,
            pointer: pointer('knowledge', 'sources', index),
            hint: 'Check permissions and the path.',
          }),
        );
        continue;
      }
      const isExternalSource = !isPathInside(root, real);
      if (isExternalSource) {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.knowledgeSourceSymlinkEscape,
            severity: 'error',
            message: `Configured knowledge source resolves outside the workspace: ${real}`,
            source: configPath,
            pointer: pointer('knowledge', 'sources', index),
            hint: 'Keep knowledge inside the workspace; use an external repository mapping for external code.',
          }),
        );
        continue;
      }
      const resolvedObservation = await observePath(real);
      if (resolvedObservation.kind === 'file') {
        await addDocument(real, 'workspace-config', declaredBy, root);
      } else if (resolvedObservation.kind === 'directory') {
        await scanDirectory(
          real,
          3,
          'workspace-config',
          declaredBy,
          root,
          null,
        );
      }
    }
  }

  for (const [directory, repository] of wellKnownRoots) {
    await addWellKnown(directory, repository);
  }

  const grouped = new Map<DiscoveredRepository, string[]>();
  for (const document of documents.values()) {
    const repository = enclosingRepository(document.path);
    if (repository === null) continue;
    const group = grouped.get(repository) ?? [];
    group.push(document.path);
    grouped.set(repository, group);
  }
  for (const [repository, paths] of grouped) {
    const ignored = await filterGitIgnored(repository.root, paths, {
      timeoutMs: options.gitTimeoutMs,
    });
    if (!ignored.ok) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.ignoreFilterUnavailable,
          severity: 'warning',
          message: `Cannot evaluate .gitignore for ${repository.root}: ${ignored.message}`,
          source: repository.root,
          hint: 'Discovery keeps the candidates and reports that ignore filtering was unavailable.',
        }),
      );
      continue;
    }
    for (const path of ignored.value) {
      const document = documents.get(path);
      if (document === undefined) continue;
      documents.delete(path);
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.documentIgnored,
          severity: 'info',
          message: `Document is ignored by git: ${path}`,
          source: path,
          hint: 'Ignored documentation remains in place; discovery did not read or move it.',
        }),
      );
    }
  }

  return {
    documents: [...documents.values()],
    boundaries: [...boundaries],
    diagnostics,
    truncated,
  };
}
