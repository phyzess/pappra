import { join } from 'node:path';
import type { Diagnostic } from '../schemas/diagnostics.js';
import { createDiagnostic } from '../schemas/diagnostics.js';
import { diagnosticCodes } from '../schemas/errors.js';
import type { Checkpoint } from '../schemas/continuity.js';
import type { MachineConfig } from '../schemas/machine.js';
import type { WorkspaceConfig } from '../schemas/workspace.js';
import {
  inspectMachineConfig,
  inspectWorkspaceConfig,
} from '../workspace/config.js';
import { discoverRepositories } from '../workspace/repositories.js';
import type {
  DiscoveredRepository,
  UnresolvedRepository,
} from '../workspace/types.js';
import { runGit } from '../infra/git.js';
import { observePath, readFileBounded, sha256Digest } from '../infra/fs.js';
import { readlink } from 'node:fs/promises';
import { isPathInside } from '../schemas/paths.js';
import { CONTINUITY_PAYLOAD_MAX_BYTES } from './paths.js';

const discoveryOptions = {
  scanDepth: 0,
  maxDirectories: 1,
  maxDocuments: 1,
  maxEntriesPerDirectory: 1,
  gitTimeoutMs: 5_000,
} as const;

export interface ContinuityWorkspace {
  readonly root: string;
  readonly config: WorkspaceConfig;
  readonly machine: MachineConfig | null;
  readonly repositories: readonly DiscoveredRepository[];
  readonly unresolvedRepositories: readonly UnresolvedRepository[];
  readonly discoveryTruncated: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ContinuityWorkspaceResult {
  readonly ok: boolean;
  readonly workspace: ContinuityWorkspace | null;
  readonly diagnostics: readonly Diagnostic[];
}

export interface RepositorySnapshot {
  readonly record: Checkpoint['repositories'][number];
  readonly patchBytes: Buffer | null;
}

export async function loadContinuityWorkspace(
  root: string,
): Promise<ContinuityWorkspaceResult> {
  const config = await inspectWorkspaceConfig(root);
  const diagnostics: Diagnostic[] = [...config.diagnostics];
  if (config.value === null) {
    return { ok: false, workspace: null, diagnostics };
  }
  const machine = await inspectMachineConfig(config.root);
  diagnostics.push(...machine.diagnostics);
  const repositories = await discoverRepositories({
    root: config.root,
    config: config.value,
    machine: machine.value,
    configPath: config.path,
    options: discoveryOptions,
  });
  diagnostics.push(...repositories.diagnostics);
  return {
    ok: true,
    workspace: {
      root: config.root,
      config: config.value,
      machine: machine.value,
      repositories: repositories.repositories,
      unresolvedRepositories: repositories.unresolved,
      discoveryTruncated: repositories.truncated,
      diagnostics,
    },
    diagnostics,
  };
}

function repoId(repository: DiscoveredRepository, index: number): string {
  return (
    repository.id ?? (index === 0 ? 'workspace' : `workspace-${index + 1}`)
  );
}

/**
 * Assigns stable identities that never shadow a configured logical ID. The
 * normal fallback remains unchanged when collision-free; an automatic
 * repository whose preferred fallback is reserved receives the first free
 * `workspace-N` identity instead. Capture and resume must use the same list.
 */
export function repositoryIdentities(
  repositories: readonly DiscoveredRepository[],
  reservedIds: readonly string[] = [],
): readonly string[] {
  const used = new Set([
    ...reservedIds,
    ...repositories.flatMap((repository) =>
      repository.id === null ? [] : [repository.id],
    ),
  ]);
  return repositories.map((repository, index) => {
    if (repository.id !== null) return repository.id;
    const preferred = index === 0 ? 'workspace' : `workspace-${index + 1}`;
    let candidate = preferred;
    let suffix = 1;
    while (used.has(candidate)) {
      candidate = `workspace-${suffix}`;
      suffix += 1;
    }
    used.add(candidate);
    return candidate;
  });
}

function repoScope(repository: DiscoveredRepository): 'workspace' | 'external' {
  return repository.external ? 'external' : 'workspace';
}

/**
 * Parses `git status --porcelain=v1 -z` untracked paths without display
 * unquoting. Rename/copy records carry a second NUL-delimited original path;
 * that continuation is skipped so it can never be treated as a status row.
 */
function untrackedPathsFromNulStatus(
  statusText: string,
): readonly string[] | null {
  if (statusText === '') return [];
  if (!statusText.endsWith('\0')) return null;
  const fields = statusText.split('\0');
  fields.pop();
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (entry === undefined || entry.length < 3 || entry[2] !== ' ') {
      return null;
    }
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path.length === 0) return null;
    if (code === '??') paths.push(path);
    if (code[0] === 'R' || code[0] === 'C') {
      const continuation = fields[index + 1];
      if (continuation === undefined || continuation.length === 0) return null;
      index += 1;
    }
  }
  return paths;
}
export async function snapshotRepository(
  workspace: ContinuityWorkspace,
  repository: DiscoveredRepository,
  index: number,
  assignedId?: string,
): Promise<RepositorySnapshot> {
  const status = await runGit({
    cwd: repository.root,
    args: [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--',
      '.',
      ':(exclude).pappra/local',
      ':(exclude).pappra/generated',
    ],
    timeoutMs: 5_000,
    maxOutputBytes: 2 * 1024 * 1024,
  });
  const diff = await runGit({
    cwd: repository.root,
    args: [
      'diff',
      '--binary',
      'HEAD',
      '--',
      '.',
      ':(exclude).pappra/local',
      ':(exclude).pappra/generated',
    ],
    timeoutMs: 5_000,
    maxOutputBytes: 4 * 1024 * 1024,
  });
  const statusText = status.ok ? status.value.stdout : '';
  const diffText = diff.ok ? diff.value.stdout : '';
  const dirty = status.ok ? statusText.trim().length > 0 : repository.git.dirty;
  let captureStatus: 'complete' | 'partial' | 'unknown' =
    status.ok && diff.ok ? 'complete' : 'unknown';
  const untracked = status.ok ? untrackedPathsFromNulStatus(statusText) : null;
  if (status.ok && untracked === null) captureStatus = 'partial';
  let patchBytes: Buffer | null = null;
  if (dirty === true && status.ok && diff.ok) {
    const statusBytes = Buffer.from(statusText, 'utf8');
    const diffBytes = Buffer.from(diffText, 'utf8');
    const parts: Buffer[] = [
      Buffer.from(
        `PAPPRA-UNTRACKED/2\nP ${statusBytes.length} ${diffBytes.length}\n`,
        'utf8',
      ),
      statusBytes,
      diffBytes,
    ];
    let total = parts.reduce((sum, part) => sum + part.length, 0);
    if (total > CONTINUITY_PAYLOAD_MAX_BYTES) {
      captureStatus = 'partial';
    }
    for (const path of untracked ?? []) {
      if (total > CONTINUITY_PAYLOAD_MAX_BYTES) break;
      const absolute = join(repository.root, path);
      if (!isPathInside(repository.root, absolute)) {
        captureStatus = 'partial';
        continue;
      }
      const observation = await observePath(absolute).catch(() => null);
      if (observation === null) {
        captureStatus = 'partial';
        continue;
      }
      let body: Buffer;
      let entryKind: 'F' | 'L';
      if (observation.kind === 'file') {
        const read = await readFileBounded(
          absolute,
          CONTINUITY_PAYLOAD_MAX_BYTES,
        );
        if (!read.ok) {
          captureStatus = 'partial';
          continue;
        }
        body = read.value.bytes;
        entryKind = 'F';
      } else if (observation.kind === 'symlink') {
        const target = await readlink(absolute).catch(() => null);
        if (target === null) {
          captureStatus = 'partial';
          continue;
        }
        body = Buffer.from(target, 'utf8');
        entryKind = 'L';
      } else {
        captureStatus = 'partial';
        continue;
      }
      const pathBytes = Buffer.from(path, 'utf8');
      // F/L is part of the identity: a regular file body and a symlink target
      // with identical bytes are still different source objects. The target
      // text is read with readlink and never resolved or opened.
      const header = Buffer.from(
        `${entryKind} ${pathBytes.length} ${body.length}\n`,
        'utf8',
      );
      if (
        total + header.length + pathBytes.length + body.length >
        CONTINUITY_PAYLOAD_MAX_BYTES
      ) {
        captureStatus = 'partial';
        break;
      }
      parts.push(header, pathBytes, body);
      total += header.length + pathBytes.length + body.length;
    }
    patchBytes = Buffer.concat(parts);
  }
  const patchDigest = patchBytes === null ? null : sha256Digest(patchBytes);
  const checkoutId =
    workspace.machine?.checkoutId ?? sha256Digest(repository.root);
  return {
    record: {
      repoId: assignedId ?? repoId(repository, index),
      checkoutId,
      root: repository.root,
      head: repository.git.head,
      branch: repository.git.branch,
      dirty,
      patchDigest,
      captureStatus,
      scope: repoScope(repository),
    },
    patchBytes,
  };
}

export function continuityDiagnostic(
  message: string,
  source: string,
  hint: string,
): Diagnostic {
  return createDiagnostic({
    code: diagnosticCodes.document_path_unsafe,
    severity: 'error',
    message,
    source,
    hint,
  });
}
