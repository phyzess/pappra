import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { ensurePrivateState } from '../infra/private-state.js';
import { dirname, join, resolve } from 'node:path';
import {
  observePath,
  readTextFileBounded,
  resolveRealpath,
} from '../infra/fs.js';
import type { Diagnostic } from '../schemas/diagnostics.js';
import { diagnosticCodes } from '../schemas/errors.js';
import { isValidTaskId } from '../schemas/continuity.js';
import {
  errorMessage,
  failed,
  succeeded,
  type Outcome,
} from '../schemas/outcome.js';
import { isPathInside, samePath } from '../schemas/paths.js';
import { workspaceConfigSchema } from '../schemas/workspace.js';
import {
  acquireInstallLock,
  backupPath,
  ensureStatePathBoundary,
  releaseInstallLock,
  workspaceInstallPaths,
} from '../install/ownership.js';
import { inspectWorkspaceConfig } from '../workspace/config.js';

export const TASK_PIN_SCHEMA = 'pappra/task-pin/1';

export interface TaskPin {
  readonly schema: typeof TASK_PIN_SCHEMA;
  readonly taskId: string;
  readonly pinnedAt: string;
}

export interface TaskPinFailure {
  readonly ok: false;
  readonly message: string;
}

interface TaskStatePaths {
  /** Canonical private task-state directory, shared with continuity. */
  readonly localDir: string;
  readonly pinPath: string;
  readonly configPath: string;
}

/** Identity of one real directory or file in the private task-state namespace. */
interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly real: string;
}

interface PrivateSnapshot {
  readonly root: FileIdentity;
  readonly pappra: FileIdentity | null;
  readonly local: FileIdentity | null;
}

function taskStatePaths(root: string): TaskStatePaths {
  const localDir = join(root, '.pappra', 'local');
  return {
    localDir,
    pinPath: join(localDir, 'current-task'),
    configPath: join(root, '.pappra', 'workspace.json'),
  };
}

/**
 * Resolves the workspace to its real path so a symlinked workspace root keeps
 * working. A root that cannot be resolved is never treated as a workspace.
 */
async function canonicalWorkspaceRoot(root: string): Promise<string | null> {
  return await resolveRealpath(resolve(root));
}

function unsafe(message: string, nextAction: string): Outcome<never> {
  return failed(diagnosticCodes.document_path_unsafe, message, { nextAction });
}

async function observe(
  path: string,
): Promise<Outcome<Awaited<ReturnType<typeof observePath>>>> {
  try {
    return succeeded(await observePath(path));
  } catch (error) {
    return failed(
      diagnosticCodes.fileUnreadable,
      `Cannot inspect task state path ${path}: ${errorMessage(error)}`,
      { nextAction: 'Check permissions; no task state was read or written.' },
    );
  }
}

/**
 * Fails closed unless `target` is the canonical private task-state location:
 * `.pappra` and `.pappra/local` are real directories inside the workspace
 * (continuity uses the same namespace and rejects redirects too), every
 * existing ancestor resolves inside the workspace, and the final entry is a
 * regular file or absent. The managed-state helper provides containment.
 */
async function privateTaskStateBoundary(
  root: string,
  target: string,
): Promise<Outcome<null>> {
  const containment = await ensureStatePathBoundary(root, target);
  if (!containment.ok) {
    return unsafe(
      `Private task state resolves outside the workspace: ${target} (${containment.message})`,
      'Restore .pappra/local as a real directory inside the workspace; no task state was read or written.',
    );
  }
  const localDir = taskStatePaths(root).localDir;
  for (const namespace of [dirname(localDir), localDir]) {
    const observation = await observe(namespace);
    if (!observation.ok) return observation;
    if (observation.value.kind === 'missing') break;
    if (observation.value.kind === 'symlink') {
      return unsafe(
        `Private task state is redirected through a symlink: ${namespace}`,
        'Restore .pappra/local as a real directory inside the workspace; Pappra does not follow redirected task state.',
      );
    }
    if (observation.value.kind !== 'directory') {
      return unsafe(
        `Private task-state parent is not a directory: ${namespace}`,
        'Inspect the private task-state path; no task state was read or written.',
      );
    }
  }
  const final = await observe(target);
  if (!final.ok) return final;
  if (final.value.kind === 'symlink') {
    return unsafe(
      `Task state path is a symlink: ${target}`,
      'Replace it with a regular file inside .pappra/local; Pappra does not follow task-state symlinks.',
    );
  }
  if (final.value.kind !== 'missing' && final.value.kind !== 'file') {
    return unsafe(
      `Task state path is not a regular file: ${target}`,
      'Inspect the private task-state path; no task state was read or written.',
    );
  }
  return succeeded(null);
}

/** The shared configuration file must not be replaced through a redirect. */
async function configBoundary(
  root: string,
  configPath: string,
): Promise<Outcome<null>> {
  const containment = await ensureStatePathBoundary(root, configPath);
  if (!containment.ok) {
    return unsafe(
      `Workspace configuration resolves outside the workspace: ${configPath} (${containment.message})`,
      'Keep .pappra/workspace.json inside the workspace; nothing was written.',
    );
  }
  const observation = await observe(configPath);
  if (!observation.ok) return observation;
  if (observation.value.kind === 'symlink') {
    return unsafe(
      `Workspace configuration is a symlink: ${configPath}`,
      'Replace it with a regular .pappra/workspace.json; Pappra does not replace redirected configuration.',
    );
  }
  if (
    observation.value.kind !== 'missing' &&
    observation.value.kind !== 'file'
  ) {
    return unsafe(
      `Workspace configuration is not a regular file: ${configPath}`,
      'Inspect the configuration path; nothing was written.',
    );
  }
  return succeeded(null);
}

function identityOf(
  observation: Awaited<ReturnType<typeof observePath>>,
  real: string,
): FileIdentity | null {
  if (observation.stats === null) return null;
  return { dev: observation.stats.dev, ino: observation.stats.ino, real };
}

function sameFile(
  left: FileIdentity | null,
  right: FileIdentity | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    samePath(left.real, right.real)
  );
}

function sameSnapshot(left: PrivateSnapshot, right: PrivateSnapshot): boolean {
  return (
    sameFile(left.root, right.root) &&
    ((left.pappra === null && right.pappra === null) ||
      sameFile(left.pappra, right.pappra)) &&
    ((left.local === null && right.local === null) ||
      sameFile(left.local, right.local))
  );
}

/**
 * Pins the real `.pappra` and `.pappra/local` directories (device/inode plus
 * real path). Node offers no `openat`-style handle-relative mutation, so these
 * checks are cooperative: they close redirects that occur at awaited seams we
 * can observe, but they are not an OS-level fence for a same-user race that
 * lands between the final check and the syscall.
 */
async function namespaceSnapshot(
  canonical: string,
): Promise<Outcome<PrivateSnapshot>> {
  const rootObservation = await observe(canonical);
  if (!rootObservation.ok) return rootObservation;
  if (rootObservation.value.kind !== 'directory') {
    return unsafe(
      `Workspace root is not a directory: ${canonical}`,
      'Run this action from a real registered workspace.',
    );
  }
  const paths = taskStatePaths(canonical);
  const entries: { pappra: FileIdentity | null; local: FileIdentity | null } = {
    pappra: null,
    local: null,
  };
  for (const key of ['pappra', 'local'] as const) {
    const path = key === 'pappra' ? dirname(paths.localDir) : paths.localDir;
    const observation = await observe(path);
    if (!observation.ok) return observation;
    if (observation.value.kind === 'missing') continue;
    if (observation.value.kind !== 'directory') {
      return unsafe(
        `Private task state is not a real directory: ${path}`,
        'Restore .pappra/local as a real directory inside the workspace; nothing was written.',
      );
    }
    const real = await resolveRealpath(path);
    if (real === null || !isPathInside(canonical, real)) {
      return unsafe(
        `Private task state resolves outside the workspace: ${path}`,
        'Restore .pappra/local inside the workspace; nothing was written.',
      );
    }
    entries[key] = identityOf(observation.value, real);
  }
  const rootReal = await resolveRealpath(canonical);
  if (rootReal === null) {
    return unsafe(
      `Cannot resolve workspace root: ${canonical}`,
      'Retry from an existing workspace root.',
    );
  }
  return succeeded({
    root: identityOf(rootObservation.value, rootReal) as FileIdentity,
    ...entries,
  });
}

async function assertSnapshot(
  canonical: string,
  expected: PrivateSnapshot,
): Promise<Outcome<null>> {
  const current = await namespaceSnapshot(canonical);
  if (!current.ok) return current;
  if (!sameSnapshot(expected, current.value)) {
    return unsafe(
      'Private task-state namespace changed during the operation.',
      'Inspect .pappra/local; no further write or cleanup was attempted through the changed path.',
    );
  }
  return succeeded(null);
}

/**
 * Verifies an entry is a regular file inside the pinned state directory
 * (`local` for pins/backups, `.pappra` for the shared configuration).
 */
async function verifyEntry(
  snapshot: PrivateSnapshot,
  path: string,
  expected: 'file' | 'missing' | 'file-or-missing',
  scope: 'local' | 'pappra' = 'local',
): Promise<Outcome<null>> {
  const observation = await observe(path);
  if (!observation.ok) return observation;
  if (observation.value.kind === 'missing') {
    return expected === 'file'
      ? unsafe(
          `Task state entry is missing: ${path}`,
          'Inspect the private task-state path; nothing was written.',
        )
      : succeeded(null);
  }
  if (observation.value.kind === 'symlink') {
    return unsafe(
      `Task state entry is a symlink: ${path}`,
      'Replace it with a regular file; Pappra does not follow redirected task state.',
    );
  }
  if (observation.value.kind !== 'file') {
    return unsafe(
      `Task state entry is not a regular file: ${path}`,
      'Inspect the private task-state path; nothing was read or written.',
    );
  }
  if (expected === 'missing') {
    return unsafe(
      `Task state entry appeared unexpectedly: ${path}`,
      'Inspect the private task-state path; nothing was written.',
    );
  }
  const allowed = scope === 'local' ? snapshot.local : snapshot.pappra;
  if (allowed === null) {
    return unsafe(
      'Private task-state directory is unavailable.',
      'Inspect .pappra/local; nothing was written.',
    );
  }
  const real = await resolveRealpath(path);
  const parent = await resolveRealpath(dirname(path));
  if (
    real === null ||
    parent === null ||
    (!samePath(parent, allowed.real) && !isPathInside(allowed.real, parent)) ||
    !isPathInside(allowed.real, real) ||
    samePath(allowed.real, real)
  ) {
    return unsafe(
      `Task state entry resolves outside the pinned private directory: ${path}`,
      'Inspect .pappra/local; nothing was written.',
    );
  }
  return succeeded(null);
}

/**
 * Removes a temporary file only while the pinned namespace is still the one we
 * wrote into. A redirected namespace leaves the residual in place for
 * inspection instead of deleting through the new path.
 */
async function cleanupTemporary(
  canonical: string,
  snapshot: PrivateSnapshot,
  temporary: string,
  scope: 'local' | 'pappra' = 'local',
): Promise<void> {
  const stable = await assertSnapshot(canonical, snapshot);
  if (!stable.ok) return;
  const inside = await verifyEntry(
    snapshot,
    temporary,
    'file-or-missing',
    scope,
  );
  if (!inside.ok) return;
  await rm(temporary, { force: true }).catch(() => undefined);
}

/**
 * Publishes one owned file with revalidation around the write and rename, and
 * reads the result back. The last check-to-syscall window is cooperative, as
 * described on `namespaceSnapshot`.
 */
async function writeTaskStateFile(
  canonical: string,
  snapshot: PrivateSnapshot,
  path: string,
  bytes: Buffer,
  scope: 'local' | 'pappra' = 'local',
  guard?: () => Promise<Outcome<null>>,
): Promise<Outcome<null>> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  const before = await assertSnapshot(canonical, snapshot);
  if (!before.ok) return before;
  if (guard !== undefined) {
    const current = await guard();
    if (!current.ok) return current;
  }
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    return failed(
      diagnosticCodes.fileUnreadable,
      `Cannot write task state: ${errorMessage(error)}`,
      { nextAction: 'Inspect permissions and the private task-state path.' },
    );
  }
  const written = await assertSnapshot(canonical, snapshot);
  if (!written.ok) {
    await cleanupTemporary(canonical, snapshot, temporary, scope);
    return written;
  }
  const placed = await verifyEntry(snapshot, temporary, 'file', scope);
  if (!placed.ok) {
    await cleanupTemporary(canonical, snapshot, temporary, scope);
    return placed;
  }
  const beforeRename = await assertSnapshot(canonical, snapshot);
  if (!beforeRename.ok) {
    await cleanupTemporary(canonical, snapshot, temporary, scope);
    return beforeRename;
  }
  if (guard !== undefined) {
    const current = await guard();
    if (!current.ok) {
      await cleanupTemporary(canonical, snapshot, temporary, scope);
      return current;
    }
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await cleanupTemporary(canonical, snapshot, temporary, scope);
    return failed(
      diagnosticCodes.fileUnreadable,
      `Cannot publish task state: ${errorMessage(error)}`,
      {
        nextAction:
          'Inspect the private task-state path; a residual may remain.',
      },
    );
  }
  const afterRename = await assertSnapshot(canonical, snapshot);
  if (!afterRename.ok) {
    return unsafe(
      'Private task-state namespace changed after publication; verify the file before relying on it.',
      'Inspect .pappra/local and the task state; no cleanup was attempted.',
    );
  }
  const published = await verifyEntry(snapshot, path, 'file', scope);
  if (!published.ok) return published;
  const readBack = await readTextFileBounded(path, 1024 * 1024);
  if (!readBack.ok || !readBack.value.bytes.equals(bytes)) {
    return failed(
      readBack.ok ? diagnosticCodes.fileUnreadable : readBack.code,
      readBack.ok
        ? 'Task state bytes changed immediately after publication.'
        : readBack.message,
      {
        nextAction: 'Inspect the private task-state file before relying on it.',
      },
    );
  }
  return succeeded(null);
}

/**
 * Revalidates the actual parent of a private backup after awaited directory
 * creation. A backup nested under a redirect must not be written even though the
 * top-level local identity is unchanged.
 */
async function verifyBackupParent(
  snapshot: PrivateSnapshot,
  backup: string,
): Promise<Outcome<null>> {
  const parent = dirname(backup);
  const observation = await observe(parent);
  if (!observation.ok) return observation;
  if (observation.value.kind !== 'directory') {
    return unsafe(
      `Configuration backup parent is not a real directory: ${parent}`,
      'Inspect .pappra/local/backups; nothing was written.',
    );
  }
  const allowed = snapshot.local;
  const real = await resolveRealpath(parent);
  if (allowed === null || real === null || !isPathInside(allowed.real, real)) {
    return unsafe(
      `Configuration backup parent resolves outside the pinned private directory: ${parent}`,
      'Inspect .pappra/local/backups; nothing was written.',
    );
  }
  return succeeded(null);
}

/** Reads the config file only while its namespace and inode stay unchanged. */
async function configIdentity(
  canonical: string,
  snapshot: PrivateSnapshot,
): Promise<Outcome<FileIdentity>> {
  const configPath = taskStatePaths(canonical).configPath;
  const observation = await observe(configPath);
  if (!observation.ok) return observation;
  if (observation.value.kind !== 'file') {
    return unsafe(
      `Workspace configuration is not a regular file: ${configPath}`,
      'Inspect the configuration path; nothing was written.',
    );
  }
  const pappra = snapshot.pappra;
  const real = await resolveRealpath(configPath);
  const parent = await resolveRealpath(dirname(configPath));
  if (
    pappra === null ||
    real === null ||
    parent === null ||
    !samePath(parent, pappra.real) ||
    !isPathInside(pappra.real, real)
  ) {
    return unsafe(
      `Workspace configuration resolves outside .pappra: ${configPath}`,
      'Keep .pappra/workspace.json inside the workspace; nothing was written.',
    );
  }
  const identity = identityOf(observation.value, real);
  if (identity === null) {
    return unsafe(
      'Cannot identify the workspace configuration file.',
      'Inspect .pappra/workspace.json; nothing was written.',
    );
  }
  return succeeded(identity);
}

function firstErrorMessage(diagnostics: readonly Diagnostic[]): string {
  const first =
    diagnostics.find((entry) => entry.severity === 'error') ?? diagnostics[0];
  return first?.message ?? 'workspace configuration is not usable.';
}

/**
 * Builds the updated configuration document from the current bytes so
 * unrelated valid fields, their values and their order are preserved.
 */
function withAutoResume(
  text: string,
  enabled: boolean,
): Outcome<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return failed(
      diagnosticCodes.configInvalidJson,
      `workspace.json is not valid JSON: ${errorMessage(error)}`,
      { nextAction: 'Correct the configuration; it was not modified.' },
    );
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return failed(
      diagnosticCodes.configSchemaInvalid,
      'workspace.json is not a JSON object.',
      { nextAction: 'Correct the configuration; it was not modified.' },
    );
  }
  const record = raw as Record<string, unknown>;
  const existing = record['continuity'];
  const continuity =
    typeof existing === 'object' &&
    existing !== null &&
    !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  const next: Record<string, unknown> = {
    ...record,
    continuity: { ...continuity, autoResume: enabled },
  };
  const parsed = workspaceConfigSchema.safeParse(next);
  if (!parsed.success) {
    return failed(
      diagnosticCodes.configSchemaInvalid,
      `workspace.json would be invalid after the update: ${
        parsed.error.issues[0]?.message ?? 'unknown issue'
      }`,
      { nextAction: 'Correct the configuration; it was not modified.' },
    );
  }
  return succeeded(next);
}

export async function readTaskPin(root: string): Promise<TaskPin | null> {
  const canonical = await canonicalWorkspaceRoot(root);
  if (canonical === null) return null;
  const snapshot = await namespaceSnapshot(canonical);
  if (!snapshot.ok) return null;
  const target = taskStatePaths(canonical).pinPath;
  const boundary = await privateTaskStateBoundary(canonical, target);
  if (!boundary.ok) return null;
  const placed = await verifyEntry(snapshot.value, target, 'file-or-missing');
  if (!placed.ok) return null;
  const read = await readTextFileBounded(target, 64 * 1024);
  if (!read.ok) return null;
  const after = await namespaceSnapshot(canonical);
  if (!after.ok || !sameSnapshot(snapshot.value, after.value)) return null;
  const stable = await verifyEntry(snapshot.value, target, 'file-or-missing');
  if (!stable.ok) return null;
  try {
    const value: unknown = JSON.parse(read.value.text);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('schema' in value) ||
      value.schema !== TASK_PIN_SCHEMA ||
      !('taskId' in value) ||
      typeof value.taskId !== 'string' ||
      !isValidTaskId(value.taskId)
    ) {
      return null;
    }
    return value as TaskPin;
  } catch {
    return null;
  }
}

export async function pinTask(
  root: string,
  taskId: string,
): Promise<TaskPin | TaskPinFailure> {
  if (!isValidTaskId(taskId)) {
    return {
      ok: false,
      message:
        'task id must be at most 64 characters: a letter or digit followed by letters, digits, dot, dash or underscore.',
    };
  }
  const canonical = await canonicalWorkspaceRoot(root);
  if (canonical === null) {
    return { ok: false, message: `Cannot resolve workspace root: ${root}` };
  }
  const target = taskStatePaths(canonical).pinPath;
  const boundary = await privateTaskStateBoundary(canonical, target);
  if (!boundary.ok) return { ok: false, message: boundary.message };
  const privateState = await ensurePrivateState(canonical);
  if (!privateState.ok) return { ok: false, message: privateState.message };
  const initial = await namespaceSnapshot(canonical);
  if (!initial.ok) return { ok: false, message: initial.message };
  try {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  } catch (error) {
    return {
      ok: false,
      message: `Cannot create task state directory: ${errorMessage(error)}`,
    };
  }
  const prepared = await namespaceSnapshot(canonical);
  if (!prepared.ok) return { ok: false, message: prepared.message };
  if (
    prepared.value.local === null ||
    (initial.value.pappra !== null &&
      !sameFile(initial.value.pappra, prepared.value.pappra)) ||
    (initial.value.local !== null &&
      !sameFile(initial.value.local, prepared.value.local))
  ) {
    return {
      ok: false,
      message:
        'Private task-state directory changed while it was being created; nothing was written.',
    };
  }
  const pin: TaskPin = {
    schema: TASK_PIN_SCHEMA,
    taskId,
    pinnedAt: new Date().toISOString(),
  };
  const written = await writeTaskStateFile(
    canonical,
    prepared.value,
    target,
    Buffer.from(`${JSON.stringify(pin, null, 2)}\n`, 'utf8'),
  );
  if (!written.ok) return { ok: false, message: written.message };
  return pin;
}

export async function unpinTask(
  root: string,
): Promise<{ ok: true } | TaskPinFailure> {
  const canonical = await canonicalWorkspaceRoot(root);
  if (canonical === null) {
    return { ok: false, message: `Cannot resolve workspace root: ${root}` };
  }
  const target = taskStatePaths(canonical).pinPath;
  const boundary = await privateTaskStateBoundary(canonical, target);
  if (!boundary.ok) return { ok: false, message: boundary.message };
  const snapshot = await namespaceSnapshot(canonical);
  if (!snapshot.ok) return { ok: false, message: snapshot.message };
  const presence = await observe(target);
  if (!presence.ok) return { ok: false, message: presence.message };
  if (presence.value.kind !== 'missing') {
    const placed = await verifyEntry(snapshot.value, target, 'file');
    if (!placed.ok) return { ok: false, message: placed.message };
  }
  const before = await assertSnapshot(canonical, snapshot.value);
  if (!before.ok) return { ok: false, message: before.message };
  if (presence.value.kind !== 'missing') {
    const quarantine = `${target}.removed-${randomUUID()}`;
    try {
      // Move the pin aside inside the pinned directory first. A redirect that
      // lands exactly at the unlink still cannot destroy an unrelated outside
      // file that already uses the pin name.
      await rename(target, quarantine);
    } catch (error) {
      return {
        ok: false,
        message: `Cannot remove task pin: ${errorMessage(error)}`,
      };
    }
    const afterMove = await namespaceSnapshot(canonical);
    if (!afterMove.ok || !sameSnapshot(snapshot.value, afterMove.value)) {
      return {
        ok: false,
        message:
          'Private task-state namespace changed while the pin was being removed; inspect .pappra/local and the quarantined pin before retrying.',
      };
    }
    const moved = await verifyEntry(snapshot.value, quarantine, 'file');
    if (!moved.ok) return { ok: false, message: moved.message };
    const beforeDelete = await assertSnapshot(canonical, snapshot.value);
    if (!beforeDelete.ok) return { ok: false, message: beforeDelete.message };
    try {
      await rm(quarantine, { force: true });
    } catch (error) {
      return {
        ok: false,
        message: `Cannot remove task pin: ${errorMessage(error)}`,
      };
    }
    const afterDelete = await namespaceSnapshot(canonical);
    if (!afterDelete.ok || !sameSnapshot(snapshot.value, afterDelete.value)) {
      return {
        ok: false,
        message:
          'Private task-state namespace changed while the pin was being removed; verify .pappra/local before retrying.',
      };
    }
  }
  return { ok: true };
}

/**
 * Toggles the workspace-level auto-resume switch. The hook only injects a resume
 * packet when this switch is on and a task pin exists; neither is inferred.
 *
 * The update reuses the managed workspace lock, keeps a private backup and
 * replaces the file atomically. Configuration that changed after it was read is
 * never overwritten, unrelated fields keep their values, and the private
 * namespace is revalidated around the awaited read, lock, backup, publication
 * and release seams. Those revalidations are cooperative, not kernel fencing.
 */
export async function setAutoResume(
  root: string,
  enabled: boolean,
): Promise<{ ok: true } | TaskPinFailure> {
  const canonical = await canonicalWorkspaceRoot(root);
  if (canonical === null) {
    return { ok: false, message: `Cannot resolve workspace root: ${root}` };
  }
  const paths = taskStatePaths(canonical);
  const boundary = await configBoundary(canonical, paths.configPath);
  if (!boundary.ok) return { ok: false, message: boundary.message };
  const privateState = await ensurePrivateState(canonical);
  if (!privateState.ok) return { ok: false, message: privateState.message };
  const initial = await namespaceSnapshot(canonical);
  if (!initial.ok) return { ok: false, message: initial.message };
  let snapshot = initial;
  if (initial.value.local === null) {
    // The workspace lock and the private backup live under .pappra/local; create
    // it once, then pin its identity before any awaited configuration work.
    try {
      await mkdir(paths.localDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      return {
        ok: false,
        message: `Cannot create the private task-state directory: ${errorMessage(error)}`,
      };
    }
    const created = await namespaceSnapshot(canonical);
    if (!created.ok) return { ok: false, message: created.message };
    if (
      created.value.local === null ||
      (initial.value.pappra !== null &&
        !sameFile(initial.value.pappra, created.value.pappra))
    ) {
      return {
        ok: false,
        message:
          'Private task-state directory changed while it was being created; nothing was written.',
      };
    }
    snapshot = created;
  }
  const identityBefore = await configIdentity(canonical, snapshot.value);
  if (!identityBefore.ok) return { ok: false, message: identityBefore.message };
  const before = await readTextFileBounded(paths.configPath);
  if (!before.ok) return { ok: false, message: before.message };
  const stableRead = await assertSnapshot(canonical, snapshot.value);
  if (!stableRead.ok) return { ok: false, message: stableRead.message };
  const identityAfterRead = await configIdentity(canonical, snapshot.value);
  if (
    !identityAfterRead.ok ||
    !sameFile(identityBefore.value, identityAfterRead.value)
  ) {
    return {
      ok: false,
      message: `workspace.json changed while it was being read; nothing was written.`,
    };
  }
  const inspection = await inspectWorkspaceConfig(canonical);
  if (inspection.value === null) {
    return {
      ok: false,
      message: `workspace.json is not usable: ${firstErrorMessage(inspection.diagnostics)}`,
    };
  }
  if (inspection.digest !== before.value.digest) {
    return {
      ok: false,
      message:
        'workspace.json changed while it was being read; nothing was written. Retry the command.',
    };
  }
  const next = withAutoResume(before.value.text, enabled);
  if (!next.ok) return { ok: false, message: next.message };
  const expectCurrentGeneration = async (): Promise<Outcome<null>> => {
    const stable = await assertSnapshot(canonical, snapshot.value);
    if (!stable.ok) return stable;
    const identity = await configIdentity(canonical, snapshot.value);
    if (!identity.ok) return identity;
    if (!sameFile(identityBefore.value, identity.value)) {
      return unsafe(
        'workspace.json was replaced before publication; the update was abandoned without writing.',
        'Inspect .pappra/workspace.json and retry the toggle.',
      );
    }
    const current = await readTextFileBounded(paths.configPath);
    if (!current.ok) return current;
    if (current.value.digest !== before.value.digest) {
      return unsafe(
        'workspace.json changed before publication; the update was abandoned without rewriting it.',
        'Inspect .pappra/workspace.json and retry the toggle.',
      );
    }
    return succeeded(null);
  };
  const lock = await acquireInstallLock(
    workspaceInstallPaths(canonical).lockPath,
    'set-auto-resume',
    '.pappra/workspace.json',
    canonical,
  );
  if (!lock.ok || lock.lock === null) {
    return {
      ok: false,
      message:
        lock.message ?? `Cannot lock workspace configuration: ${lock.path}`,
    };
  }
  const heldLock = lock.lock;
  const release = async (): Promise<TaskPinFailure | null> => {
    const stable = await assertSnapshot(canonical, snapshot.value);
    if (!stable.ok) {
      return {
        ok: false,
        message: `${stable.message} The workspace lock was left at ${lock.path} as evidence.`,
      };
    }
    const released = await releaseInstallLock(lock.path, heldLock.token);
    if (!released.ok) {
      return {
        ok: false,
        message: `autoResume may have been updated, but the workspace lock was not released: ${released.message}`,
      };
    }
    return null;
  };
  let failure: string | null = null;
  try {
    const afterLock = await assertSnapshot(canonical, snapshot.value);
    if (!afterLock.ok) {
      return {
        ok: false,
        message: `${afterLock.message} The workspace lock was left at ${lock.path} as evidence.`,
      };
    }
    const currentIdentity = await configIdentity(canonical, snapshot.value);
    if (!currentIdentity.ok) {
      failure = currentIdentity.message;
    } else if (!sameFile(identityBefore.value, currentIdentity.value)) {
      failure =
        'workspace.json was replaced while waiting for the workspace lock; the update was abandoned without writing.';
    } else {
      const current = await readTextFileBounded(paths.configPath);
      const stableCurrent = await assertSnapshot(canonical, snapshot.value);
      if (!current.ok) {
        failure = current.message;
      } else if (!stableCurrent.ok) {
        failure = stableCurrent.message;
      } else if (current.value.digest !== before.value.digest) {
        failure =
          'workspace.json changed after it was read; the update was abandoned without writing.';
      } else {
        const backup = backupPath(
          canonical,
          randomUUID(),
          '.pappra/workspace.json',
        );
        const backupBoundary = await privateTaskStateBoundary(
          canonical,
          backup,
        );
        if (!backupBoundary.ok) {
          failure = backupBoundary.message;
        } else {
          const mkdirOk = await mkdir(dirname(backup), {
            recursive: true,
            mode: 0o700,
          })
            .then(() => true)
            .catch(() => false);
          if (!mkdirOk) {
            failure = `Cannot create the private configuration backup directory: ${dirname(backup)}`;
          } else {
            const stableBackup = await assertSnapshot(
              canonical,
              snapshot.value,
            );
            if (!stableBackup.ok) {
              failure = stableBackup.message;
            } else {
              const backupParent = await verifyBackupParent(
                snapshot.value,
                backup,
              );
              if (!backupParent.ok) {
                failure = backupParent.message;
              } else {
                try {
                  await writeFile(backup, current.value.bytes, {
                    mode: 0o600,
                    flag: 'wx',
                  });
                  await assertSnapshot(canonical, snapshot.value).then(
                    (stable) => {
                      if (!stable.ok) failure = stable.message;
                    },
                  );
                  if (failure === null) {
                    const placedBackup = await verifyEntry(
                      snapshot.value,
                      backup,
                      'file',
                    );
                    if (!placedBackup.ok) failure = placedBackup.message;
                  }
                } catch (error) {
                  failure = `Cannot write the private configuration backup: ${errorMessage(error)}`;
                }
                if (failure === null) {
                  const written = await writeTaskStateFile(
                    canonical,
                    snapshot.value,
                    paths.configPath,
                    Buffer.from(
                      `${JSON.stringify(next.value, null, 2)}\n`,
                      'utf8',
                    ),
                    'pappra',
                    expectCurrentGeneration,
                  );
                  if (!written.ok) failure = written.message;
                }
              }
            }
          }
        }
      }
    }
  } catch (error) {
    failure = `Cannot update the auto-resume switch: ${errorMessage(error)}`;
  }
  const released = await release();
  if (failure !== null) return { ok: false, message: failure };
  if (released !== null) return released;
  return { ok: true };
}

export async function readAutoResume(root: string): Promise<boolean> {
  const canonical = await canonicalWorkspaceRoot(root);
  if (canonical === null) return false;
  const paths = taskStatePaths(canonical);
  const boundary = await configBoundary(canonical, paths.configPath);
  if (!boundary.ok) return false;
  const snapshot = await namespaceSnapshot(canonical);
  if (!snapshot.ok) return false;
  const identity = await configIdentity(canonical, snapshot.value);
  if (!identity.ok) return false;
  const read = await readTextFileBounded(paths.configPath, 1024 * 1024);
  if (!read.ok) return false;
  const after = await namespaceSnapshot(canonical);
  if (!after.ok || !sameSnapshot(snapshot.value, after.value)) return false;
  const identityAfter = await configIdentity(canonical, snapshot.value);
  if (!identityAfter.ok || !sameFile(identity.value, identityAfter.value)) {
    return false;
  }
  try {
    const raw: unknown = JSON.parse(read.value.text);
    if (typeof raw !== 'object' || raw === null || !('continuity' in raw)) {
      return false;
    }
    const continuity = raw.continuity;
    return (
      typeof continuity === 'object' &&
      continuity !== null &&
      'autoResume' in continuity &&
      continuity.autoResume === true
    );
  } catch {
    return false;
  }
}
