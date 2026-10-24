import { dirname, join } from 'node:path';
import { readdir } from 'node:fs/promises';
import type { Diagnostic } from '../schemas/diagnostics.js';
import { createDiagnostic, pointer } from '../schemas/diagnostics.js';
import { diagnosticCodes } from '../schemas/errors.js';
import type { Failure } from '../schemas/outcome.js';
import {
  externalRepositoryId,
  isExternalRepositoryPath,
  isPathInside,
  resolvePortableRelativePath,
  samePath,
  toWorkspaceRelativePath,
} from '../schemas/paths.js';
import {
  normalizedExcludes,
  type WorkspaceConfig,
} from '../schemas/workspace.js';
import type { MachineConfig } from '../schemas/machine.js';
import {
  createGitObservationScope,
  type GitObservationScope,
  type GitRepositoryObservation,
} from '../infra/git.js';
import { observePath, resolveRealpath } from '../infra/fs.js';
import { isExcludedPath, isHiddenSegment } from './ignore.js';
import type {
  DiscoveredRepository,
  NormalizedDiscoveryOptions,
  UnresolvedRepository,
} from './types.js';

export interface RepositoryDiscoveryInput {
  readonly root: string;
  readonly config: WorkspaceConfig | null;
  readonly machine: MachineConfig | null;
  readonly configPath: string;
  readonly options: NormalizedDiscoveryOptions;
  /**
   * One operation's Git probe scope. Discovery and a later identity probe of the
   * same checkout must share it, otherwise identical repository probes are
   * spawned twice. Callers that omit it get a scope scoped to this discovery.
   */
  readonly observations?: GitObservationScope;
}

function probeScope(input: RepositoryDiscoveryInput): GitObservationScope {
  return input.observations ?? createGitObservationScope();
}

export interface RepositoryDiscoveryOutput {
  readonly repositories: readonly DiscoveredRepository[];
  readonly unresolved: readonly UnresolvedRepository[];
  readonly boundaries: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
  readonly truncated: boolean;
}

function failureDiagnostic(
  failure: Failure,
  source: string,
  location: string | null,
): Diagnostic {
  return createDiagnostic({
    code: failure.code,
    severity: 'error',
    message: failure.message,
    source,
    pointer: location,
    hint: failure.nextAction,
  });
}

async function findNestedWorkspace(
  root: string,
  target: string,
): Promise<string | null> {
  if (!isPathInside(root, target)) return null;
  let directory = target;
  for (;;) {
    if (!samePath(directory, root)) {
      const marker = await observePath(join(directory, '.pappra'));
      if (marker.kind !== 'missing') return directory;
    }
    if (samePath(directory, root)) return null;
    const parent = dirname(directory);
    if (!isPathInside(root, parent) || samePath(parent, directory)) return null;
    directory = parent;
  }
}

async function resolveConfiguredRepository(
  input: RepositoryDiscoveryInput,
  repositoryIndex: number,
): Promise<{
  readonly repository: DiscoveredRepository | null;
  readonly unresolved: UnresolvedRepository | null;
  readonly diagnostics: readonly Diagnostic[];
}> {
  const { config, machine, root, configPath, options } = input;
  if (config === null)
    return { repository: null, unresolved: null, diagnostics: [] };
  const entry = config.repositories[repositoryIndex];
  if (entry === undefined) {
    return { repository: null, unresolved: null, diagnostics: [] };
  }
  const location = pointer('repositories', repositoryIndex, 'path');
  const diagnostics: Diagnostic[] = [];
  const unresolved = (): UnresolvedRepository => ({
    id: entry.id,
    configuredPath: entry.path,
    diagnostics,
  });

  let candidateRoot: string;
  let external = false;

  if (isExternalRepositoryPath(entry.path)) {
    external = true;
    const logicalId = externalRepositoryId(entry.path);
    if (logicalId === null) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.configPathInvalid,
          severity: 'error',
          message: `Repository "${entry.id}" has a malformed external reference: ${entry.path}`,
          source: configPath,
          pointer: location,
          hint: 'Use external:<logical-id> exactly.',
        }),
      );
      return { repository: null, unresolved: unresolved(), diagnostics };
    }
    const mapping = machine?.externalRepositories.find(
      (item) => item.id === logicalId,
    );
    if (mapping === undefined) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.externalRepositoryUnmapped,
          severity: 'error',
          message: `External repository "${logicalId}" has no machine-local mapping.`,
          source: configPath,
          pointer: location,
          hint:
            machine === null
              ? 'Create or repair .pappra/local/machine.json on this checkout; Pappra will not guess an absolute path.'
              : 'Add exactly one externalRepositories mapping in .pappra/local/machine.json.',
        }),
      );
      return { repository: null, unresolved: unresolved(), diagnostics };
    }
    const observed = await observePath(mapping.path);
    if (observed.kind === 'missing') {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.externalRepositoryInvalid,
          severity: 'error',
          message: `Mapped external repository does not exist: ${mapping.path}`,
          source: configPath,
          pointer: location,
          hint: 'Correct the local mapping; the shared workspace.json stores only the logical id.',
        }),
      );
      return { repository: null, unresolved: unresolved(), diagnostics };
    }
    const real = await resolveRealpath(mapping.path);
    if (real === null) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.externalRepositoryInvalid,
          severity: 'error',
          message: `Cannot resolve mapped external repository: ${mapping.path}`,
          source: configPath,
          pointer: location,
          hint: 'Correct the local mapping path and permissions.',
        }),
      );
      return { repository: null, unresolved: unresolved(), diagnostics };
    }
    candidateRoot = real;
  } else {
    if (!entry.path.startsWith('/') && !/^[A-Za-z]:/.test(entry.path)) {
      candidateRoot = resolvePortableRelativePath(root, entry.path);
    } else {
      candidateRoot = entry.path;
    }
    if (!isPathInside(root, candidateRoot)) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.configPathEscapesRoot,
          severity: 'error',
          message: `Repository "${entry.id}" resolves outside the workspace root: ${candidateRoot}`,
          source: configPath,
          pointer: location,
          hint: 'Use a relative path, or declare the checkout explicitly as external:<id> in machine.json.',
        }),
      );
      return { repository: null, unresolved: unresolved(), diagnostics };
    }
    const observed = await observePath(candidateRoot);
    if (observed.kind === 'missing') {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.repositoryPathMissing,
          severity: 'error',
          message: `Repository path does not exist: ${candidateRoot}`,
          source: configPath,
          pointer: location,
          hint: 'Correct the path or remove the declaration; Pappra does not create or clone repositories.',
        }),
      );
      return { repository: null, unresolved: unresolved(), diagnostics };
    }
    const real = await resolveRealpath(candidateRoot);
    if (real === null) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.repositoryPathMissing,
          severity: 'error',
          message: `Cannot resolve repository path: ${candidateRoot}`,
          source: configPath,
          pointer: location,
          hint: 'Check permissions and the path.',
        }),
      );
      return { repository: null, unresolved: unresolved(), diagnostics };
    }
    if (!isPathInside(root, real)) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.repositorySymlinkEscape,
          severity: 'error',
          message: `Repository path resolves outside the workspace through a symlink: ${real}`,
          source: configPath,
          pointer: location,
          hint: 'Keep workspace repositories inside the root, or use an explicit external:<id> mapping.',
        }),
      );
      return { repository: null, unresolved: unresolved(), diagnostics };
    }
    const nested = await findNestedWorkspace(root, real);
    if (nested !== null) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.repositoryNestedWorkspace,
          severity: 'error',
          message: `Repository "${entry.id}" is inside nested workspace ${nested}.`,
          source: configPath,
          pointer: location,
          hint: 'Do not swallow a nested workspace. Configure the inner workspace separately or map a read-only external checkout.',
        }),
      );
      return { repository: null, unresolved: unresolved(), diagnostics };
    }
    candidateRoot = real;
  }

  const candidateObservation = await observePath(candidateRoot);
  if (candidateObservation.kind !== 'directory') {
    diagnostics.push(
      createDiagnostic({
        code: diagnosticCodes.repositoryNotGit,
        severity: 'error',
        message: `Repository path is not a directory: ${candidateRoot}`,
        source: configPath,
        pointer: location,
        hint: 'Declare a checkout directory; Pappra does not create, clone, or guess repositories.',
      }),
    );
    return { repository: null, unresolved: unresolved(), diagnostics };
  }

  const inspected = await probeScope(input).repository(candidateRoot, {
    timeoutMs: options.gitTimeoutMs,
  });
  if (!inspected.ok) {
    diagnostics.push(failureDiagnostic(inspected, configPath, location));
    return { repository: null, unresolved: unresolved(), diagnostics };
  }
  const git = inspected.value;
  return {
    repository: {
      id: entry.id,
      origin: 'workspace-config',
      external,
      access: entry.access,
      root: git.root,
      relativePath: toWorkspaceRelativePath(root, git.root),
      configuredPath: entry.path,
      git,
      kind: git.kind,
      diagnostics,
    },
    unresolved: null,
    diagnostics,
  };
}

function scanRepository(
  input: RepositoryDiscoveryInput,
  git: GitRepositoryObservation,
): DiscoveredRepository {
  return {
    id: null,
    origin: 'scan',
    external: false,
    access: 'read',
    root: git.root,
    relativePath: toWorkspaceRelativePath(input.root, git.root),
    configuredPath: null,
    git,
    kind: git.kind,
    diagnostics: [],
  };
}

/**
 * Resolves explicit repository declarations first, then performs a bounded
 * scan when the workspace root is not itself a repository. A scan never
 * descends into a repository, so source files are not enumerated.
 */
export async function discoverRepositories(
  input: RepositoryDiscoveryInput,
): Promise<RepositoryDiscoveryOutput> {
  const { config, configPath, options, root } = input;
  // One scope per discovery: explicit declarations, the root probe and any scan
  // share the same immutable repository observations.
  const decorated: RepositoryDiscoveryInput = {
    ...input,
    observations: input.observations ?? createGitObservationScope(),
  };
  const diagnostics: Diagnostic[] = [];
  const repositories: DiscoveredRepository[] = [];
  const unresolved: UnresolvedRepository[] = [];
  const boundaries = new Set<string>();
  const byRoot = new Map<string, DiscoveredRepository>();
  let truncated = false;
  let stopsAtRepositories = false;

  const excluded = config === null ? [] : normalizedExcludes(config);

  const addRepository = (repository: DiscoveredRepository): void => {
    const existing = byRoot.get(repository.root);
    if (existing !== undefined) {
      if (
        existing.origin === 'workspace-config' &&
        repository.origin === 'workspace-config'
      ) {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.repositoryDuplicatePath,
            severity: 'warning',
            message: `Repositories "${existing.id ?? existing.root}" and "${repository.id ?? repository.root}" resolve to the same checkout: ${repository.root}`,
            source: configPath,
            pointer: null,
            hint: 'Keep one logical repository id per checkout.',
          }),
        );
      }
      return;
    }
    byRoot.set(repository.root, repository);
    repositories.push(repository);
  };

  if (config !== null) {
    for (const index of config.repositories.keys()) {
      const resolved = await resolveConfiguredRepository(decorated, index);
      diagnostics.push(...resolved.diagnostics);
      if (resolved.repository !== null) addRepository(resolved.repository);
      if (resolved.unresolved !== null) unresolved.push(resolved.unresolved);
    }
  }

  const rootGitEntry = await observePath(join(root, '.git'));
  if (rootGitEntry.kind === 'directory' || rootGitEntry.kind === 'file') {
    stopsAtRepositories = true;
    const inspected = await probeScope(decorated).repository(root, {
      timeoutMs: options.gitTimeoutMs,
    });
    if (inspected.ok) {
      addRepository(scanRepository(input, inspected.value));
    } else {
      diagnostics.push(failureDiagnostic(inspected, root, null));
    }
  } else if (rootGitEntry.kind === 'symlink') {
    diagnostics.push(
      createDiagnostic({
        code: diagnosticCodes.discoverySymlinkSkipped,
        severity: 'warning',
        message: `Workspace root .git is a symlink and was not followed: ${join(root, '.git')}`,
        source: root,
        hint: 'Use a regular .git directory or file; discovery does not follow repository metadata symlinks.',
      }),
    );
    stopsAtRepositories = true;
  }

  if (!stopsAtRepositories && options.scanDepth > 0) {
    let visited = 0;
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (visited >= options.maxDirectories) {
        if (!truncated) {
          diagnostics.push(
            createDiagnostic({
              code: diagnosticCodes.discoveryLimitReached,
              severity: 'warning',
              message: `Repository scan stopped after ${options.maxDirectories} directories.`,
              source: root,
              hint: 'Increase the scan bound explicitly or declare repositories in workspace.json.',
            }),
          );
          truncated = true;
        }
        return;
      }
      visited += 1;

      if (depth > 0) {
        const marker = await observePath(join(directory, '.pappra'));
        if (marker.kind !== 'missing') {
          boundaries.add(directory);
          diagnostics.push(
            createDiagnostic({
              code: diagnosticCodes.discoveryNestedWorkspace,
              severity: 'info',
              message: `Nested workspace boundary observed: ${directory}`,
              source: directory,
              hint: 'The outer discovery does not enter or absorb a nested workspace.',
            }),
          );
          return;
        }
      }

      const gitEntry = await observePath(join(directory, '.git'));
      if (gitEntry.kind === 'directory' || gitEntry.kind === 'file') {
        const inspected = await probeScope(decorated).repository(directory, {
          timeoutMs: options.gitTimeoutMs,
        });
        if (inspected.ok) {
          addRepository(scanRepository(input, inspected.value));
        } else {
          diagnostics.push(failureDiagnostic(inspected, directory, null));
        }
        return;
      }
      if (gitEntry.kind === 'symlink') {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.discoverySymlinkSkipped,
            severity: 'warning',
            message: `Repository metadata symlink was not followed: ${join(directory, '.git')}`,
            source: directory,
            hint: 'Use a regular .git directory or file.',
          }),
        );
        return;
      }

      if (depth >= options.scanDepth) return;

      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.fileUnreadable,
            severity: 'warning',
            message: `Cannot read directory ${directory}: ${error instanceof Error ? error.message : String(error)}`,
            source: directory,
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
            message: `Directory has ${entries.length} entries; only the first ${limited.length} were inspected.`,
            source: directory,
            hint: 'Narrow the workspace scope or declare repositories explicitly.',
          }),
        );
        truncated = true;
      }

      for (const entry of limited) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (isHiddenSegment(entry.name)) continue;
        const child = join(directory, entry.name);
        const relative = toWorkspaceRelativePath(root, child);
        if (relative === null) continue;
        if (isExcludedPath(relative, excluded)) continue;
        if (entry.isSymbolicLink()) {
          const real = await resolveRealpath(child);
          const outside = real === null || !isPathInside(root, real);
          diagnostics.push(
            createDiagnostic({
              code: diagnosticCodes.discoverySymlinkSkipped,
              severity: outside ? 'warning' : 'info',
              message: `Symlinked directory was not followed: ${child}${real === null ? '' : ` -> ${real}`}`,
              source: directory,
              hint: 'Replace it with a real directory or declare an explicit external repository mapping.',
            }),
          );
          continue;
        }
        await visit(child, depth + 1);
      }
    };

    await visit(root, 0);
  }

  return {
    repositories,
    unresolved,
    boundaries: [...boundaries],
    diagnostics,
    truncated,
  };
}
