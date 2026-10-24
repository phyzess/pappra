import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { z } from 'zod';
import type { Diagnostic } from '../schemas/diagnostics.js';
import { createDiagnostic } from '../schemas/diagnostics.js';
import { diagnosticCodes } from '../schemas/errors.js';
import type { Outcome } from '../schemas/outcome.js';
import { errorMessage, failed, succeeded } from '../schemas/outcome.js';
import {
  fileIdentitySchema,
  installJournalSchema,
  installLockSchema,
  workspaceInstallManifestSchema,
  type InstallJournal,
  type InstallLock,
  type ManagedFileEntry,
  type WorkspaceInstallManifest,
} from '../schemas/install.js';
import { isPathInside, samePath } from '../schemas/paths.js';
import {
  observePath,
  readTextFileBounded,
  resolveRealpath,
  sha256Digest,
} from '../infra/fs.js';
import { ensurePrivateState } from '../infra/private-state.js';
import { publishPrivateLock } from '../infra/private-lock.js';
import { captureProcessIdentity } from '../infra/process-identity.js';

export interface WorkspaceInstallPaths {
  readonly root: string;
  readonly localDir: string;
  readonly manifestPath: string;
  readonly lockPath: string;
  readonly journalsDir: string;
  readonly backupsDir: string;
}

export function workspaceInstallPaths(root: string): WorkspaceInstallPaths {
  const localDir = join(root, '.pappra', 'local');
  return {
    root,
    localDir,
    manifestPath: join(localDir, 'install-manifest.json'),
    lockPath: join(localDir, 'apply.lock'),
    journalsDir: join(localDir, 'journals'),
    backupsDir: join(localDir, 'backups'),
  };
}

export function journalPath(root: string, installId: string): string {
  return join(workspaceInstallPaths(root).journalsDir, `${installId}.json`);
}

export function backupPath(
  root: string,
  installId: string,
  relativePath: string,
): string {
  return join(
    workspaceInstallPaths(root).backupsDir,
    installId,
    ...relativePath.split('/'),
  );
}

/**
 * Checks that a managed state path and every existing ancestor stay inside the
 * allowed root. Metadata writes must not follow a symlinked parent outside it.
 */
export async function ensureStatePathBoundary(
  root: string,
  path: string,
): Promise<Outcome<null>> {
  if (!isPathInside(root, path)) {
    return failed(
      diagnosticCodes.initTargetUnsafe,
      `Managed state path escapes the root: ${path}`,
      {
        nextAction:
          'Inspect or remove the symlinked state directory explicitly.',
      },
    );
  }
  const realRoot = await resolveRealpath(root);
  if (realRoot === null) {
    const rootObservation = await observePath(root);
    if (rootObservation.kind === 'missing') {
      // A user-data directory may not exist before the first install. Its
      // lexical descendants are still checked against the eventual root.
      return succeeded(null);
    }
    return failed(
      diagnosticCodes.initTargetUnsafe,
      `Cannot resolve managed state root: ${root}`,
      { nextAction: 'Retry from an existing workspace root.' },
    );
  }
  let ancestor = dirname(path);
  for (;;) {
    const observation = await observePath(ancestor);
    if (observation.kind !== 'missing') {
      if (observation.kind !== 'directory') {
        return failed(
          diagnosticCodes.initTargetUnsafe,
          `Managed state parent is not a directory: ${ancestor}`,
          {
            nextAction:
              'Inspect the state path; Pappra does not write through it.',
          },
        );
      }
      const real = await resolveRealpath(ancestor);
      if (real === null || !isPathInside(realRoot, real)) {
        return failed(
          diagnosticCodes.initTargetUnsafe,
          `Managed state parent escapes the workspace: ${ancestor}`,
          {
            nextAction:
              'Inspect or remove the symlink explicitly; no metadata was written.',
          },
        );
      }
      return succeeded(null);
    }
    if (samePath(ancestor, root)) return succeeded(null);
    const parent = dirname(ancestor);
    if (samePath(parent, ancestor)) {
      return failed(
        diagnosticCodes.initTargetUnsafe,
        `Cannot establish a managed state boundary for: ${path}`,
        { nextAction: 'Inspect the workspace path.' },
      );
    }
    ancestor = parent;
  }
}

export async function ensureWorkspaceStateBoundary(
  root: string,
): Promise<Outcome<null>> {
  return ensureStatePathBoundary(root, workspaceInstallPaths(root).localDir);
}

export interface JsonReadResult<T> {
  readonly exists: boolean;
  readonly value: T | null;
  readonly digest: string | null;
  readonly diagnostics: readonly Diagnostic[];
}

export async function readJsonDocument<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<JsonReadResult<T>> {
  const read = await readTextFileBounded(path);
  if (!read.ok) {
    if (read.code === diagnosticCodes.fileNotFound) {
      return { exists: false, value: null, digest: null, diagnostics: [] };
    }
    return {
      exists: true,
      value: null,
      digest: null,
      diagnostics: [
        createDiagnostic({
          code: read.code,
          severity: 'error',
          message: read.message,
          source: path,
          hint: read.nextAction,
        }),
      ],
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(read.value.text);
  } catch (error) {
    return {
      exists: true,
      value: null,
      digest: read.value.digest,
      diagnostics: [
        createDiagnostic({
          code: diagnosticCodes.configInvalidJson,
          severity: 'error',
          message: `Invalid JSON: ${errorMessage(error)}`,
          source: path,
          hint: 'Inspect and repair this file; Pappra will not overwrite it automatically.',
        }),
      ],
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      exists: true,
      value: null,
      digest: read.value.digest,
      diagnostics: [
        createDiagnostic({
          code: diagnosticCodes.configSchemaInvalid,
          severity: 'error',
          message:
            parsed.error.issues[0]?.message ?? 'Invalid installation state.',
          source: path,
          hint: 'Inspect the state file; Pappra fails closed instead of replacing unknown data.',
        }),
      ],
    };
  }
  return {
    exists: true,
    value: parsed.data,
    digest: read.value.digest,
    diagnostics: [],
  };
}

export async function writeBytesAtomic(
  path: string,
  bytes: Buffer,
  boundaryRoot?: string,
): Promise<Outcome<{ readonly digest: string }>> {
  if (boundaryRoot !== undefined) {
    const boundary = await ensureStatePathBoundary(boundaryRoot, path);
    if (!boundary.ok) return boundary;
    if (isPathInside(workspaceInstallPaths(boundaryRoot).localDir, path)) {
      const prepared = await ensurePrivateState(boundaryRoot);
      if (!prepared.ok) return prepared;
    }
  }
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeNewFile(temporary, bytes);
    await rename(temporary, path);
    return succeeded({ digest: sha256Digest(bytes) });
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    return failed(
      diagnosticCodes.fileUnreadable,
      `Cannot write ${path}: ${errorMessage(error)}`,
      { nextAction: 'Inspect permissions and available disk space.' },
    );
  }
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
  boundaryRoot?: string,
): Promise<Outcome<{ readonly digest: string }>> {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return writeBytesAtomic(path, bytes, boundaryRoot);
}

async function writeNewFile(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export interface LockAcquireResult {
  readonly ok: boolean;
  readonly status: 'acquired' | 'locked' | 'failed';
  readonly lock: InstallLock | null;
  readonly path: string;
  readonly message: string | null;
  readonly existing: InstallLock | null;
}

export async function acquireInstallLock(
  path: string,
  operation: InstallLock['operation'],
  target: string,
  boundaryRoot?: string,
): Promise<LockAcquireResult> {
  if (boundaryRoot !== undefined) {
    const boundary = await ensureStatePathBoundary(boundaryRoot, path);
    if (!boundary.ok) {
      return {
        ok: false,
        status: 'failed',
        lock: null,
        path,
        message: boundary.message,
        existing: null,
      };
    }
    if (isPathInside(workspaceInstallPaths(boundaryRoot).localDir, path)) {
      const prepared = await ensurePrivateState(boundaryRoot);
      if (!prepared.ok)
        return {
          ok: false,
          status: 'failed',
          lock: null,
          path,
          message: prepared.message,
          existing: null,
        };
    }
  }
  try {
    await mkdir(dirname(path), { recursive: true });
  } catch (error) {
    return {
      ok: false,
      status: 'failed',
      lock: null,
      path,
      message: `Cannot create installation lock directory: ${errorMessage(error)}`,
      existing: null,
    };
  }
  const lock: InstallLock = {
    schema: 'pappra/install-lock/1',
    token: randomUUID(),
    operation,
    target,
    pid: process.pid,
    ...(captureProcessIdentity() === null
      ? {}
      : { process_identity: captureProcessIdentity()! }),
    createdAt: new Date().toISOString(),
  };
  try {
    await publishPrivateLock(
      path,
      Buffer.from(`${JSON.stringify(lock, null, 2)}\n`),
      async () => {
        if (boundaryRoot !== undefined) {
          const boundary = await ensureStatePathBoundary(boundaryRoot, path);
          if (!boundary.ok) throw new Error(boundary.message);
        }
      },
    );
    return {
      ok: true,
      status: 'acquired',
      lock,
      path,
      message: null,
      existing: null,
    };
  } catch (error) {
    const existingRead = await readJsonDocument(path, installLockSchema);
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'EEXIST'
        ? 'locked'
        : 'failed';
    return {
      ok: false,
      status: code,
      lock: null,
      path,
      message:
        code === 'locked'
          ? `Installation lock is already held: ${path}`
          : `Cannot acquire installation lock ${path}: ${errorMessage(error)}`,
      existing: existingRead.value,
    };
  }
}

export async function releaseInstallLock(
  path: string,
  token: string,
): Promise<Outcome<null>> {
  const read = await readJsonDocument(path, installLockSchema);
  if (!read.exists) return succeeded(null);
  if (read.value === null) {
    return failed(
      diagnosticCodes.initApplyResidual,
      `Cannot verify install lock ownership: ${path}`,
      { nextAction: 'Inspect the lock manually; it was not removed.' },
    );
  }
  if (read.value.token !== token) {
    return failed(
      diagnosticCodes.initApplyResidual,
      `Install lock belongs to another owner: ${path}`,
      { nextAction: 'Inspect the lock manually; it was not removed.' },
    );
  }
  try {
    await unlink(path);
    return succeeded(null);
  } catch (error) {
    return failed(
      diagnosticCodes.initApplyResidual,
      `Cannot remove install lock ${path}: ${errorMessage(error)}`,
      { nextAction: 'Inspect the lock manually; it remains as evidence.' },
    );
  }
}

export async function readWorkspaceManifest(
  root: string,
): Promise<JsonReadResult<WorkspaceInstallManifest>> {
  return readJsonDocument(
    workspaceInstallPaths(root).manifestPath,
    workspaceInstallManifestSchema,
  );
}

export async function readInstallJournal(
  path: string,
): Promise<JsonReadResult<InstallJournal>> {
  return readJsonDocument(path, installJournalSchema);
}

export interface JournalDirectoryScan {
  readonly kind: 'missing' | 'directory' | 'unreadable';
  readonly files: readonly string[];
  readonly nonRegular: readonly string[];
  readonly error: string | null;
}

/**
 * Enumerates `.json` journal candidates without following symlinks or opening
 * them. Only regular files are returned as candidates; every other `.json`
 * entry is reported as non-regular so callers can fail closed instead of
 * treating a broken link, directory, FIFO, or device as absent.
 */
export async function scanJournalDirectory(
  directory: string,
): Promise<JournalDirectoryScan> {
  let observation;
  try {
    observation = await observePath(directory);
  } catch (error) {
    return {
      kind: 'unreadable',
      files: [],
      nonRegular: [],
      error: errorMessage(error),
    };
  }
  if (observation.kind === 'missing') {
    return { kind: 'missing', files: [], nonRegular: [], error: null };
  }
  if (observation.kind !== 'directory') {
    return {
      kind: 'unreadable',
      files: [],
      nonRegular: [],
      error: `Journal path is not a directory: ${directory}`,
    };
  }
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : null;
    if (code === 'ENOENT') {
      return { kind: 'missing', files: [], nonRegular: [], error: null };
    }
    return {
      kind: 'unreadable',
      files: [],
      nonRegular: [],
      error: errorMessage(error),
    };
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files: string[] = [];
  const nonRegular: string[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue;
    const path = join(directory, entry.name);
    if (entry.isFile()) {
      files.push(path);
    } else {
      nonRegular.push(path);
    }
  }
  return { kind: 'directory', files, nonRegular, error: null };
}

export interface FileOwnershipState {
  readonly status: 'match' | 'missing' | 'modified' | 'unsafe';
  readonly identity: { readonly dev: number; readonly ino: number } | null;
  readonly digest: string | null;
}

export async function inspectOwnedFile(
  root: string,
  entry: ManagedFileEntry,
): Promise<FileOwnershipState> {
  const absolute = join(root, ...entry.path.split('/'));
  if (!isPathInside(root, absolute)) {
    return { status: 'unsafe', identity: null, digest: null };
  }
  const observation = await observePath(absolute).catch(() => null);
  if (observation === null) {
    return { status: 'unsafe', identity: null, digest: null };
  }
  if (observation.kind === 'missing') {
    return { status: 'missing', identity: null, digest: null };
  }
  const realRoot = await resolveRealpath(root);
  const realPath = await resolveRealpath(absolute);
  if (
    realRoot === null ||
    realPath === null ||
    !isPathInside(realRoot, realPath)
  ) {
    return { status: 'unsafe', identity: null, digest: null };
  }
  if (observation.kind !== 'file' || observation.stats === null) {
    return { status: 'modified', identity: null, digest: null };
  }
  const identity = {
    dev: observation.stats.dev,
    ino: observation.stats.ino,
  };
  let bytes: Buffer;
  try {
    bytes = await readFile(absolute);
  } catch {
    return { status: 'unsafe', identity, digest: null };
  }
  const digest = sha256Digest(bytes);
  const matches =
    identity.dev === entry.identity.dev &&
    identity.ino === entry.identity.ino &&
    digest === entry.afterDigest;
  return {
    status: matches ? 'match' : 'modified',
    identity,
    digest,
  };
}

export async function removeOwnedFile(
  root: string,
  entry: ManagedFileEntry,
): Promise<Outcome<null>> {
  const state = await inspectOwnedFile(root, entry);
  if (state.status === 'missing') return succeeded(null);
  if (state.status !== 'match') {
    return failed(
      diagnosticCodes.initApplyResidual,
      `Managed file no longer matches its recorded identity/content: ${entry.path}`,
      {
        nextAction:
          'Keep the user-modified file; remove ownership only after review.',
      },
    );
  }
  try {
    await unlink(join(root, ...entry.path.split('/')));
    return succeeded(null);
  } catch (error) {
    return failed(
      diagnosticCodes.initApplyResidual,
      `Cannot remove managed file ${entry.path}: ${errorMessage(error)}`,
      { nextAction: 'Inspect the file and permissions; it was not removed.' },
    );
  }
}

export function createManifest(
  root: string,
  rootIdentity: { readonly dev: number; readonly ino: number },
): WorkspaceInstallManifest {
  const now = new Date().toISOString();
  return {
    schema: 'pappra/install-manifest/1',
    workspaceRoot: root,
    rootIdentity,
    entries: [],
    createdAt: now,
    updatedAt: now,
  };
}

export async function writeWorkspaceManifest(
  root: string,
  manifest: WorkspaceInstallManifest,
): Promise<Outcome<{ readonly digest: string }>> {
  const parsed = workspaceInstallManifestSchema.safeParse({
    ...manifest,
    updatedAt: new Date().toISOString(),
  });
  if (!parsed.success) {
    return failed(
      diagnosticCodes.initPlanInvalid,
      `Managed manifest is invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
      { nextAction: 'Inspect the workspace ownership state.' },
    );
  }
  return writeJsonAtomic(
    workspaceInstallPaths(root).manifestPath,
    parsed.data,
    root,
  );
}

export async function writeInstallJournal(
  path: string,
  journal: InstallJournal,
  boundaryRoot?: string,
): Promise<Outcome<{ readonly digest: string }>> {
  const parsed = installJournalSchema.safeParse({
    ...journal,
    updatedAt: new Date().toISOString(),
  });
  if (!parsed.success) {
    return failed(
      diagnosticCodes.initPlanInvalid,
      `Install journal is invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
      { nextAction: 'Inspect the installation state.' },
    );
  }
  return writeJsonAtomic(path, parsed.data, boundaryRoot);
}

export async function rootIdentityOf(
  root: string,
): Promise<{ readonly dev: number; readonly ino: number } | null> {
  const observation = await observePath(root);
  return observation.kind === 'directory' && observation.stats !== null
    ? { dev: observation.stats.dev, ino: observation.stats.ino }
    : null;
}

export async function resolveManagedRoot(root: string): Promise<string | null> {
  const real = await resolveRealpath(root);
  return real;
}

export { fileIdentitySchema };
