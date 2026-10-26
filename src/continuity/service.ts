import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import {
  CheckpointTaskDirectory,
  checkpointResidualPaths,
} from './task-directory.js';
import { ensurePrivateState } from '../infra/private-state.js';
import { publishPrivateLock } from '../infra/private-lock.js';
import { captureProcessIdentity } from '../infra/process-identity.js';
import { isAbsolute, join, resolve } from 'node:path';
import type { Diagnostic } from '../schemas/diagnostics.js';
import { createDiagnostic } from '../schemas/diagnostics.js';
import { diagnosticCodes, type DiagnosticCode } from '../schemas/errors.js';
import {
  checkpointPointerSchema,
  checkpointSchema,
  resumePacketSchema,
  taskContextSchema,
  type Checkpoint,
  type CheckpointPointer,
  type ResumePacket,
  type TaskContext,
} from '../schemas/continuity.js';
import {
  errorMessage,
  type Failure,
  type Outcome,
} from '../schemas/outcome.js';
import { isPathInside } from '../schemas/paths.js';
import { isTaskRecord } from '../schemas/collaboration-state-validation.js';
import {
  observePath,
  readFileBounded,
  readTextFileBounded,
  sha256Digest,
} from '../infra/fs.js';
import {
  loadContinuityWorkspace,
  repositoryIdentities,
  snapshotRepository,
  type ContinuityWorkspace,
} from './context.js';
import {
  continuityTaskPaths,
  ensureContinuityBoundary,
  ensurePrivateTaskBoundary,
  readArtifactPath,
  readContinuityBytes,
  replaceContinuityBytesIfDigest,
  writeContinuityBytes,
} from './paths.js';

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;

export interface NativeRefInput {
  readonly harness: 'pi' | 'codex' | 'claude' | 'unknown';
  readonly sessionId?: string | null;
  readonly turnId?: string | null;
  readonly runId?: string | null;
}

export interface ValidationInput {
  readonly id: string;
  readonly result: 'passed' | 'failed' | 'not-run' | 'unknown';
  readonly inputVersion?: string | null;
}

export interface SaveCheckpointInput {
  readonly taskId: string;
  readonly objective?: string;
  readonly acceptance?: readonly string[];
  readonly constraints?: readonly string[];
  readonly artifacts?: readonly string[];
  readonly collaborationRecordRef?: string | null;
  readonly decisions?: readonly string[];
  readonly attempted?: readonly string[];
  readonly nextActions?: readonly string[];
  readonly limitations?: readonly string[];
  readonly contextCompleteness?: 'complete' | 'partial';
  readonly authorSession?: string | null;
  readonly nativeRefs?: readonly NativeRefInput[];
  readonly validations?: readonly ValidationInput[];
}

export interface SaveCheckpointResult {
  readonly ok: boolean;
  readonly status: 'saved' | 'partial' | 'conflict' | 'failed';
  readonly checkpoint: Checkpoint | null;
  readonly checkpointPath: string | null;
  readonly latestPath: string | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly residualPaths: readonly string[];
}

export interface ResumeCheckpointInput {
  readonly taskId: string;
  readonly currentSession?: string | null;
}

export interface ResumeCheckpointResult {
  readonly ok: boolean;
  readonly status: 'ready' | 'blocked' | 'not-found' | 'invalid' | 'failed';
  readonly packet: ResumePacket | null;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ContinuityServiceOptions {
  /** Test seam: schedule namespace mutation at the directory-creation boundary. */
  readonly beforeTaskDirectoryCreate?: () => void;
  /** Test seam: directory identity is pinned, before lock publication. */
  readonly beforeTaskLockPublish?: () => Promise<void> | void;
  /** Test seam: after failure and lock release, before guarded empty cleanup. */
  readonly beforeFailedTaskCleanup?: () => Promise<void> | void;
  /** Test seam: runs after checkpoint bytes are durable, before latest pointer. */
  readonly beforeLatestPointerPersist?: () => Promise<void> | void;
}

interface JsonRead<T> {
  readonly exists: boolean;
  readonly value: T | null;
  readonly raw: Buffer | null;
  readonly digest: string | null;
  readonly diagnostics: readonly Diagnostic[];
}

function diag(
  code: DiagnosticCode,
  message: string,
  source: string,
  hint: string,
): Diagnostic {
  return createDiagnostic({ code, severity: 'error', message, source, hint });
}
function outcomeDiagnostic(failure: Failure, source: string): Diagnostic {
  return createDiagnostic({
    code: failure.code,
    severity: 'error',
    message: failure.message,
    source,
    hint: failure.nextAction,
  });
}

function parseJsonFile<T>(
  root: string,
  taskId: string,
  path: string,
  schema: {
    safeParse(value: unknown): {
      success: boolean;
      error?: { issues: Array<{ message: string }> };
      data?: T;
    };
  },
): Promise<JsonRead<T>> {
  return (async () => {
    const boundary = await ensurePrivateTaskBoundary(root, taskId, path);
    if (!boundary.ok) {
      return {
        exists: true,
        value: null,
        raw: null,
        digest: null,
        diagnostics: [outcomeDiagnostic(boundary, path)],
      };
    }
    const read = await readTextFileBounded(path, MAX_RECORD_BYTES);
    if (!read.ok) {
      if (read.code === diagnosticCodes.fileNotFound) {
        return {
          exists: false,
          value: null,
          raw: null,
          digest: null,
          diagnostics: [],
        };
      }
      return {
        exists: true,
        value: null,
        raw: null,
        digest: null,
        diagnostics: [
          diag(
            read.code,
            read.message,
            path,
            read.nextAction ?? 'Inspect the record.',
          ),
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
        raw: read.value.bytes,
        digest: read.value.digest,
        diagnostics: [
          diag(
            diagnosticCodes.configInvalidJson,
            `Invalid JSON: ${errorMessage(error)}`,
            path,
            'Repair the private continuity record; it is not overwritten.',
          ),
        ],
      };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return {
        exists: true,
        value: null,
        raw: read.value.bytes,
        digest: read.value.digest,
        diagnostics: [
          diag(
            diagnosticCodes.configSchemaInvalid,
            `Invalid continuity record: ${parsed.error?.issues[0]?.message ?? 'unknown issue'}`,
            path,
            'Inspect the private continuity record; no recovery is guessed.',
          ),
        ],
      };
    }
    return {
      exists: true,
      value: parsed.data ?? null,
      raw: read.value.bytes,
      digest: read.value.digest,
      diagnostics: [],
    };
  })();
}

async function readTaskContext(
  root: string,
  taskId: string,
): Promise<JsonRead<TaskContext>> {
  const paths = continuityTaskPaths(root, taskId);
  return parseJsonFile(root, taskId, paths.contextPath, taskContextSchema);
}

async function readPointer(
  root: string,
  taskId: string,
): Promise<JsonRead<CheckpointPointer>> {
  const paths = continuityTaskPaths(root, taskId);
  return parseJsonFile(root, taskId, paths.latestPath, checkpointPointerSchema);
}

function checkpointAbsolutePath(
  root: string,
  taskId: string,
  ref: string,
): string | null {
  const paths = continuityTaskPaths(root, taskId);
  const candidate = isAbsolute(ref)
    ? resolve(ref)
    : resolve(paths.taskDir, ref);
  return isPathInside(paths.taskDir, candidate) ? candidate : null;
}

async function readCheckpoint(
  root: string,
  taskId: string,
  pointer: CheckpointPointer,
): Promise<JsonRead<Checkpoint>> {
  const path = checkpointAbsolutePath(root, taskId, pointer.checkpointRef);
  if (path === null) {
    return {
      exists: true,
      value: null,
      raw: null,
      digest: null,
      diagnostics: [
        diag(
          diagnosticCodes.document_path_unsafe,
          `Checkpoint pointer escapes the private task directory: ${pointer.checkpointRef}`,
          pointer.checkpointRef,
          'Inspect the latest pointer; it is not followed.',
        ),
      ],
    };
  }
  const read = await parseJsonFile(root, taskId, path, checkpointSchema);
  if (read.exists && read.digest !== pointer.checkpointDigest) {
    return {
      ...read,
      value: null,
      diagnostics: [
        ...read.diagnostics,
        diag(
          diagnosticCodes.configSchemaInvalid,
          'Checkpoint bytes do not match the latest pointer digest.',
          path,
          'Inspect the pointer/checkpoint; Pappra does not guess another task or checkpoint.',
        ),
      ],
    };
  }
  return read;
}

async function acquireTaskLock(
  root: string,
  taskId: string,
  directory: CheckpointTaskDirectory,
  beforePublish?: () => Promise<void> | void,
  beforeDirectoryCreate?: () => void,
): Promise<
  | { ok: true; path: string; token: string }
  | { ok: false; path: string; message: string }
> {
  const paths = continuityTaskPaths(root, taskId);
  const boundary = await ensurePrivateTaskBoundary(
    root,
    taskId,
    paths.lockPath,
  );
  if (!boundary.ok) {
    return { ok: false, path: paths.lockPath, message: boundary.message };
  }
  const privateState = await ensurePrivateState(root);
  if (!privateState.ok)
    return { ok: false, path: paths.lockPath, message: privateState.message };
  try {
    directory.prepare(beforeDirectoryCreate);
  } catch (error) {
    return {
      ok: false,
      path: paths.lockPath,
      message: `Cannot create private task directory: ${errorMessage(error)}`,
    };
  }
  const token = randomUUID();
  try {
    await beforePublish?.();
    directory.assertCurrent();
    await publishPrivateLock(
      paths.lockPath,
      Buffer.from(
        `${JSON.stringify({ token, pid: process.pid, process_identity: captureProcessIdentity() ?? undefined, createdAt: new Date().toISOString() })}\n`,
      ),
      async () => {
        directory.assertCurrent();
        const current = await ensurePrivateTaskBoundary(
          root,
          taskId,
          paths.lockPath,
        );
        if (!current.ok) throw new Error(current.message);
      },
    );
    return { ok: true, path: paths.lockPath, token };
  } catch (error) {
    return {
      ok: false,
      path: paths.lockPath,
      message: `Checkpoint writer is already locked or unavailable: ${errorMessage(error)}`,
    };
  }
}

async function releaseTaskLock(
  path: string,
  token: string,
  directory: CheckpointTaskDirectory,
): Promise<Outcome<null>> {
  try {
    directory.assertCurrent();
  } catch (error) {
    return {
      ok: false,
      code: diagnosticCodes.document_locked,
      message: `Cannot verify checkpoint lock namespace: ${errorMessage(error)}`,
      retryable: false,
      nextAction: 'Inspect the private task namespace; no lock was removed.',
    };
  }
  const read = await readTextFileBounded(path);
  if (!read.ok) {
    return {
      ok: false,
      code: diagnosticCodes.document_locked,
      message: `Cannot verify checkpoint lock: ${read.message}`,
      retryable: false,
      nextAction: 'Inspect the private task lock; it was not removed.',
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(read.value.text);
  } catch {
    return {
      ok: false,
      code: diagnosticCodes.document_locked,
      message: 'Checkpoint lock is not valid JSON.',
      retryable: false,
      nextAction: 'Inspect the private task lock; it was not removed.',
    };
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('token' in value) ||
    value.token !== token
  ) {
    return {
      ok: false,
      code: diagnosticCodes.document_locked,
      message: 'Checkpoint lock ownership changed.',
      retryable: false,
      nextAction: 'Inspect the private task lock; it was not removed.',
    };
  }
  try {
    directory.assertCurrent();
    await unlink(path);
    return { ok: true, value: null };
  } catch (error) {
    return {
      ok: false,
      code: diagnosticCodes.document_locked,
      message: `Cannot release checkpoint lock: ${errorMessage(error)}`,
      retryable: false,
      nextAction: 'Inspect the private task lock; it remains as evidence.',
    };
  }
}

async function ensureTaskContext(
  workspace: ContinuityWorkspace,
  input: SaveCheckpointInput,
  now: string,
): Promise<
  { ok: true; context: TaskContext } | { ok: false; diagnostics: Diagnostic[] }
> {
  const read = await readTaskContext(workspace.root, input.taskId);
  if (read.exists) {
    if (read.value === null) {
      return { ok: false, diagnostics: [...read.diagnostics] };
    }
    if (
      read.value.taskId !== input.taskId ||
      read.value.workspaceId !== workspace.config.workspaceId
    ) {
      return {
        ok: false,
        diagnostics: [
          diag(
            diagnosticCodes.document_catalog_conflict,
            'Task context identity does not match the requested task/workspace.',
            continuityTaskPaths(workspace.root, input.taskId).contextPath,
            'Use the exact task identity; Pappra does not reuse a context from another task.',
          ),
        ],
      };
    }
    if (
      input.objective !== undefined &&
      input.objective !== read.value.objective
    ) {
      return {
        ok: false,
        diagnostics: [
          diag(
            diagnosticCodes.document_write_conflict,
            'Task context objective is immutable for an existing task.',
            continuityTaskPaths(workspace.root, input.taskId).contextPath,
            'Reuse the existing task or choose a new task id.',
          ),
        ],
      };
    }
    return { ok: true, context: read.value };
  }
  if (input.objective === undefined || input.acceptance === undefined) {
    return {
      ok: false,
      diagnostics: [
        diag(
          diagnosticCodes.initInputRequired,
          'A new task context requires objective and acceptance.',
          continuityTaskPaths(workspace.root, input.taskId).contextPath,
          'Provide the task goal and acceptance criteria on the first checkpoint.',
        ),
      ],
    };
  }
  const paths = continuityTaskPaths(workspace.root, input.taskId);
  const context: TaskContext = {
    schema: 'pappra/task-context/1',
    taskId: input.taskId,
    workspaceId: workspace.config.workspaceId,
    objective: input.objective,
    acceptance: [...input.acceptance],
    constraints: [...(input.constraints ?? [])],
    artifacts: [...(input.artifacts ?? [])],
    collaborationRecordRef: input.collaborationRecordRef ?? null,
    createdAt: now,
    updatedAt: now,
  };
  const parsed = taskContextSchema.safeParse(context);
  if (!parsed.success) {
    return {
      ok: false,
      diagnostics: [
        diag(
          diagnosticCodes.document_record_invalid,
          `Task context is invalid: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`,
          paths.contextPath,
          'Fix the task context inputs.',
        ),
      ],
    };
  }
  const written = await writeContinuityBytes(
    workspace.root,
    input.taskId,
    paths.contextPath,
    Buffer.from(`${JSON.stringify(parsed.data, null, 2)}\n`),
    true,
  );
  if (!written.ok)
    return {
      ok: false,
      diagnostics: [outcomeDiagnostic(written, paths.contextPath)],
    };
  return { ok: true, context: parsed.data };
}

async function writePrivatePatch(
  workspace: ContinuityWorkspace,
  taskId: string,
  bytes: Buffer,
  digest: string,
): Promise<Outcome<string>> {
  const paths = continuityTaskPaths(workspace.root, taskId);
  const ref = `patches/${digest.slice('sha256:'.length)}.patch`;
  const path = join(paths.taskDir, ref);
  const existing = await observePath(path);
  if (existing.kind === 'file') {
    const read = await readContinuityBytes(workspace.root, taskId, path);
    if (read.ok && sha256Digest(read.value) === digest)
      return { ok: true, value: path };
    return {
      ok: false,
      code: diagnosticCodes.document_write_conflict,
      message: `Existing private patch does not match its digest: ${path}`,
      retryable: false,
      nextAction:
        'Inspect the private patch; it is not replaced automatically.',
    };
  }
  const written = await writeContinuityBytes(
    workspace.root,
    taskId,
    path,
    bytes,
    true,
  );
  return written.ok ? { ok: true, value: path } : written;
}

async function collectArtifacts(
  workspace: ContinuityWorkspace,
  context: TaskContext,
  input: SaveCheckpointInput,
): Promise<
  | { ok: true; artifacts: Checkpoint['artifacts'] }
  | { ok: false; diagnostics: Diagnostic[] }
> {
  const paths = input.artifacts ?? context.artifacts;
  const artifacts: Checkpoint['artifacts'] = [];
  const observedAt = new Date().toISOString();
  for (const artifactPath of paths) {
    const resolved = await readArtifactPath(workspace.root, artifactPath);
    if (!resolved.ok)
      return {
        ok: false,
        diagnostics: [outcomeDiagnostic(resolved, artifactPath)],
      };
    const read = await readFileBounded(resolved.value, MAX_ARTIFACT_BYTES);
    if (!read.ok)
      return {
        ok: false,
        diagnostics: [outcomeDiagnostic(read, artifactPath)],
      };
    artifacts.push({
      path: artifactPath,
      digest: read.value.digest,
      inputVersion: null,
      observedAt,
    });
  }
  return { ok: true, artifacts };
}

function nativeRefs(
  input: SaveCheckpointInput,
  now: string,
): Checkpoint['nativeRefs'] {
  return (input.nativeRefs ?? []).map((ref) => ({
    harness: ref.harness,
    sessionId: ref.sessionId ?? null,
    turnId: ref.turnId ?? null,
    runId: ref.runId ?? null,
    scope: 'stored-snapshot' as const,
    observedAt: now,
  }));
}

async function observeCollaboration(
  checkpoint: Checkpoint,
  workspaceRoot: string,
): Promise<ResumePacket['collaborationObservation']> {
  const ref = checkpoint.collaborationRecordRef;
  const emptyAuthority = {
    valid: false,
    stateRevision: null,
    ownerEpoch: null,
    dispatchFrozen: null,
    activeAttempts: null,
    unreleasedClaims: null,
    unresolvedUncertainty: null,
    pendingApprovals: null,
    blockerCodes: [],
  } as const;
  if (ref === null) {
    return {
      ref: null,
      status: 'not-referenced',
      digest: null,
      authority: { ...emptyAuthority, blockerCodes: [] },
      scope: 'persisted-history',
      liveStatus: 'unknown',
    };
  }
  let path: string;
  if (isAbsolute(ref)) {
    path = ref;
  } else {
    path = resolve(workspaceRoot, ref);
    const boundary = await ensureContinuityBoundary(workspaceRoot, path);
    if (!boundary.ok) {
      return {
        ref,
        status: 'unreadable',
        digest: null,
        authority: { ...emptyAuthority, blockerCodes: [] },
        scope: 'persisted-history',
        liveStatus: 'unknown',
      };
    }
  }
  const observation = await observePath(path).catch(() => null);
  if (observation?.kind === 'directory') path = join(path, 'task.json');
  const read = await readTextFileBounded(path, MAX_RECORD_BYTES);
  if (!read.ok) {
    return {
      ref,
      status:
        read.code === diagnosticCodes.fileNotFound ? 'missing' : 'unreadable',
      digest: null,
      authority: { ...emptyAuthority, blockerCodes: [] },
      scope: 'persisted-history',
      liveStatus: 'unknown',
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(read.value.text);
  } catch {
    return {
      ref,
      status: 'unreadable',
      digest: read.value.digest,
      authority: { ...emptyAuthority, blockerCodes: [] },
      scope: 'persisted-history',
      liveStatus: 'unknown',
    };
  }
  if (!isTaskRecord(raw)) {
    return {
      ref,
      status: 'unsupported',
      digest: read.value.digest,
      authority: {
        ...emptyAuthority,
        blockerCodes: ['collaboration_authority_invalid'],
      },
      scope: 'persisted-history',
      liveStatus: 'unknown',
    };
  }
  const record = raw;
  const activeAttempts = record.attempts.filter((attempt) =>
    ['assigned', 'accepted', 'running', 'unknown'].includes(attempt.state),
  ).length;
  const pendingApprovals = record.attempts.filter(
    (attempt) =>
      attempt.state === 'needs_input' && attempt.awaiting === 'approval',
  ).length;
  const unreleasedClaims = record.claims.filter(
    (claim) => claim.released_at === null,
  ).length;
  const unresolvedUncertainty = record.uncertainty.filter(
    (entry) => entry.resolved_at === null,
  ).length;
  const blockerCodes: string[] = [];
  if (record.dispatch_frozen === true) blockerCodes.push('dispatch_frozen');
  if (activeAttempts > 0) blockerCodes.push('active_attempt');
  if (pendingApprovals > 0) blockerCodes.push('pending_approval');
  if (unreleasedClaims > 0) blockerCodes.push('active_claim');
  if (unresolvedUncertainty > 0) blockerCodes.push('unresolved_uncertainty');
  return {
    ref,
    status: 'read',
    digest: read.value.digest,
    authority: {
      valid: true,
      stateRevision: record.state_revision,
      ownerEpoch: record.coordinator?.owner_epoch ?? null,
      dispatchFrozen: record.dispatch_frozen ?? null,
      activeAttempts,
      unreleasedClaims,
      unresolvedUncertainty,
      pendingApprovals,
      blockerCodes,
    },
    scope: 'persisted-history',
    liveStatus: 'unknown',
  };
}

function boundedArray<T>(values: readonly T[]): {
  values: T[];
  truncated: boolean;
} {
  return values.length > 16
    ? { values: values.slice(0, 16), truncated: true }
    : { values: [...values], truncated: false };
}

function boundedCoverageIds(values: readonly string[]): string {
  const unique = [...new Set(values)].sort();
  const shown = unique
    .slice(0, 8)
    .map((value) => (value.length > 200 ? `${value.slice(0, 197)}...` : value));
  const text = `${shown.join(', ')}${unique.length > shown.length ? `, ... (${unique.length - shown.length} more)` : ''}`;
  return text.length > 900 ? `${text.slice(0, 897)}...` : text;
}

function repositoryCoverageLimitations(
  workspace: ContinuityWorkspace,
): readonly string[] {
  const limitations: string[] = [];
  if (workspace.unresolvedRepositories.length > 0) {
    const entries = workspace.unresolvedRepositories.map(
      (entry) => `${entry.id} (${entry.configuredPath})`,
    );
    limitations.push(
      `Repository coverage incomplete: ${entries.length} configured repositories unresolved: ${boundedCoverageIds(entries)}.`,
    );
  }
  if (workspace.discoveryTruncated) {
    limitations.push(
      'Repository discovery was truncated; configured/resolved coverage is incomplete.',
    );
  }
  return limitations;
}

export class CheckpointService {
  readonly root: string;
  readonly #options: ContinuityServiceOptions;

  constructor(root: string, options: ContinuityServiceOptions = {}) {
    this.root = root;
    this.#options = options;
  }

  async save(input: SaveCheckpointInput): Promise<SaveCheckpointResult> {
    const loaded = await loadContinuityWorkspace(this.root);
    if (!loaded.ok || loaded.workspace === null) {
      return {
        ok: false,
        status: 'failed',
        checkpoint: null,
        checkpointPath: null,
        latestPath: null,
        diagnostics: [...loaded.diagnostics],
        residualPaths: [],
      };
    }
    const workspace = loaded.workspace;
    let directory: CheckpointTaskDirectory;
    try {
      directory = new CheckpointTaskDirectory(
        workspace.root,
        continuityTaskPaths(workspace.root, input.taskId).taskDir,
      );
    } catch (error) {
      return {
        ok: false,
        status: 'failed',
        checkpoint: null,
        checkpointPath: null,
        latestPath: null,
        residualPaths: [],
        diagnostics: [
          diag(
            diagnosticCodes.document_record_invalid,
            `Invalid task id: ${errorMessage(error)}`,
            workspace.root,
            'Use a stable task id with letters, digits, dot, underscore, or dash.',
          ),
        ],
      };
    }
    try {
      const result = await this.#save(workspace, input, directory);
      if (result.ok) return result;
      const diagnostics = [...result.diagnostics];
      try {
        await this.#options.beforeFailedTaskCleanup?.();
        directory.removeIfOwnedAndEmpty();
      } catch (error) {
        // ENOTEMPTY is expected when a context, checkpoint, or concurrent write remains.
        if (
          !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          )
        ) {
          diagnostics.push(
            diag(
              diagnosticCodes.document_write_partial,
              `Task directory cleanup refused: ${errorMessage(error)}`,
              directory.path,
              'Inspect the residual private task state; uncertain ownership is preserved.',
            ),
          );
        }
      }
      return {
        ...result,
        diagnostics,
        residualPaths: await checkpointResidualPaths([
          ...result.residualPaths,
          directory.path,
        ]),
      };
    } finally {
      directory.close();
    }
  }

  async #save(
    workspace: ContinuityWorkspace,
    input: SaveCheckpointInput,
    directory: CheckpointTaskDirectory,
  ): Promise<SaveCheckpointResult> {
    let lock: Awaited<ReturnType<typeof acquireTaskLock>>;
    try {
      lock = await acquireTaskLock(
        workspace.root,
        input.taskId,
        directory,
        this.#options.beforeTaskLockPublish,
        this.#options.beforeTaskDirectoryCreate,
      );
    } catch (error) {
      return {
        ok: false,
        status: 'failed',
        checkpoint: null,
        checkpointPath: null,
        latestPath: null,
        diagnostics: [
          diag(
            diagnosticCodes.document_record_invalid,
            `Invalid task id: ${errorMessage(error)}`,
            workspace.root,
            'Use a stable task id with letters, digits, dot, underscore, or dash.',
          ),
        ],
        residualPaths: [],
      };
    }
    if (!lock.ok) {
      return {
        ok: false,
        status: 'conflict',
        checkpoint: null,
        checkpointPath: null,
        latestPath: null,
        diagnostics: [
          diag(
            diagnosticCodes.document_locked,
            lock.message,
            lock.path,
            'Retry after the current checkpoint writer finishes.',
          ),
        ],
        residualPaths: [],
      };
    }
    const paths = continuityTaskPaths(workspace.root, input.taskId);
    if (workspace.repositories.length > 64) {
      const released = await releaseTaskLock(lock.path, lock.token, directory);
      return {
        ok: false,
        status: 'failed',
        checkpoint: null,
        checkpointPath: null,
        latestPath: paths.latestPath,
        diagnostics: [
          diag(
            diagnosticCodes.document_record_invalid,
            `Repository coverage has ${workspace.repositories.length} resolved entries; the checkpoint schema supports at most 64. No checkpoint pointer was advanced.`,
            paths.contextPath,
            'Reduce the configured/resolved repository set or declare a later coverage scope; semantic context was not dropped silently.',
          ),
        ],
        residualPaths: released.ok ? [] : [lock.path],
      };
    }
    const now = new Date().toISOString();
    let checkpointPath: string | null = null;
    let result: SaveCheckpointResult | undefined;
    const saveDiagnostics: Diagnostic[] = [...workspace.diagnostics];
    try {
      const contextResult = await ensureTaskContext(workspace, input, now);
      if (!contextResult.ok) {
        result = {
          ok: false,
          status: 'conflict',
          checkpoint: null,
          checkpointPath: null,
          latestPath: null,
          diagnostics: contextResult.diagnostics,
          residualPaths: [],
        };
      } else {
        const context = contextResult.context;
        const pointerRead = await readPointer(workspace.root, input.taskId);
        if (pointerRead.diagnostics.length > 0) {
          result = {
            ok: false,
            status: 'failed',
            checkpoint: null,
            checkpointPath: null,
            latestPath: paths.latestPath,
            diagnostics: [...pointerRead.diagnostics],
            residualPaths: [],
          };
        } else {
          const pointer = pointerRead.value;
          let previous: Checkpoint | null = null;
          if (pointer !== null) {
            if (
              pointer.taskId !== input.taskId ||
              pointer.workspaceId !== workspace.config.workspaceId
            ) {
              result = {
                ok: false,
                status: 'failed',
                checkpoint: null,
                checkpointPath: null,
                latestPath: paths.latestPath,
                diagnostics: [
                  diag(
                    diagnosticCodes.document_proposal_stale,
                    'Latest pointer belongs to another task or workspace.',
                    paths.latestPath,
                    'Inspect the pointer; Pappra does not reuse another task state.',
                  ),
                ],
                residualPaths: [],
              };
            } else {
              const previousRead = await readCheckpoint(
                workspace.root,
                input.taskId,
                pointer,
              );
              if (
                previousRead.value === null ||
                previousRead.diagnostics.length > 0
              ) {
                result = {
                  ok: false,
                  status: 'failed',
                  checkpoint: null,
                  checkpointPath: null,
                  latestPath: paths.latestPath,
                  diagnostics: [
                    ...previousRead.diagnostics,
                    diag(
                      diagnosticCodes.document_proposal_stale,
                      'Latest checkpoint is unreadable; Pappra does not guess a previous state.',
                      paths.latestPath,
                      'Repair or explicitly remove the pointer only after inspection.',
                    ),
                  ],
                  residualPaths: [],
                };
              } else if (
                previousRead.value.taskId !== input.taskId ||
                previousRead.value.workspaceId !==
                  workspace.config.workspaceId ||
                previousRead.value.revision !== pointer.revision
              ) {
                result = {
                  ok: false,
                  status: 'failed',
                  checkpoint: null,
                  checkpointPath: null,
                  latestPath: paths.latestPath,
                  diagnostics: [
                    diag(
                      diagnosticCodes.document_proposal_stale,
                      'Latest checkpoint identity or revision does not match its pointer.',
                      paths.latestPath,
                      'Inspect the private checkpoint/pointer; no new checkpoint was written.',
                    ),
                  ],
                  residualPaths: [],
                };
              } else {
                previous = previousRead.value;
              }
            }
          }
          if (result === undefined) {
            const observedRepositories: Checkpoint['repositories'] = [];
            const identities = repositoryIdentities(
              workspace.repositories,
              workspace.config.repositories.map((repository) => repository.id),
            );
            for (const [
              index,
              repository,
            ] of workspace.repositories.entries()) {
              const snapshot = await snapshotRepository(
                workspace,
                repository,
                index,
                identities[index],
              );
              if (
                snapshot.patchBytes !== null &&
                snapshot.record.patchDigest !== null
              ) {
                const patch = await writePrivatePatch(
                  workspace,
                  input.taskId,
                  snapshot.patchBytes,
                  snapshot.record.patchDigest,
                );
                if (!patch.ok) {
                  result = {
                    ok: false,
                    status: 'failed',
                    checkpoint: null,
                    checkpointPath: null,
                    latestPath: paths.latestPath,
                    diagnostics: [outcomeDiagnostic(patch, paths.latestPath)],
                    residualPaths: [],
                  };
                  break;
                }
              }
              observedRepositories.push(snapshot.record);
            }
            if (result === undefined) {
              const artifacts = await collectArtifacts(
                workspace,
                context,
                input,
              );
              if (!artifacts.ok) {
                result = {
                  ok: false,
                  status: 'failed',
                  checkpoint: null,
                  checkpointPath: null,
                  latestPath: paths.latestPath,
                  diagnostics: artifacts.diagnostics,
                  residualPaths: [],
                };
              } else {
                const revision = (previous?.revision ?? 0) + 1;
                const checkpointId = randomUUID();
                const semanticPresent =
                  [
                    ...(input.decisions ?? []),
                    ...(input.attempted ?? []),
                    ...(input.nextActions ?? []),
                  ].length > 0;
                const coverageLimitations =
                  repositoryCoverageLimitations(workspace);
                const coverageIncomplete = coverageLimitations.length > 0;
                const combinedLimitations = [
                  ...(input.limitations ?? []),
                  ...coverageLimitations,
                ];
                const contextCompleteness: 'complete' | 'partial' =
                  semanticPresent &&
                  input.contextCompleteness !== 'partial' &&
                  !coverageIncomplete
                    ? 'complete'
                    : 'partial';
                if (!semanticPresent) {
                  saveDiagnostics.push(
                    diag(
                      diagnosticCodes.document_write_partial,
                      input.contextCompleteness === 'complete'
                        ? 'Checkpoint was requested as complete without decisions, attempted work or next actions; stored as partial.'
                        : 'Checkpoint has no semantic decisions, attempted work or next actions; stored as partial.',
                      continuityTaskPaths(workspace.root, input.taskId)
                        .contextPath,
                      'Add an explicit semantic summary before claiming complete recovery context.',
                    ),
                  );
                }
                if (coverageIncomplete) {
                  saveDiagnostics.push(
                    diag(
                      diagnosticCodes.document_write_partial,
                      `Checkpoint capture has incomplete repository coverage: ${boundedCoverageIds(
                        workspace.unresolvedRepositories.map(
                          (entry) => `${entry.id} (${entry.configuredPath})`,
                        ),
                      )}${workspace.discoveryTruncated ? '; discovery was truncated' : ''}.`,
                      continuityTaskPaths(workspace.root, input.taskId)
                        .contextPath,
                      'Inspect configured repositories; the checkpoint is partial and does not claim complete coverage.',
                    ),
                  );
                }
                const checkpoint: Checkpoint = {
                  schema: 'pappra/checkpoint/1',
                  checkpointId,
                  taskId: input.taskId,
                  workspaceId: workspace.config.workspaceId,
                  revision,
                  previousDigest:
                    previous === null
                      ? null
                      : (pointerRead.value?.checkpointDigest ?? null),
                  createdAt: now,
                  authorSession: input.authorSession ?? null,
                  objective: context.objective,
                  acceptance: [...context.acceptance],
                  constraints: [...context.constraints],
                  decisions: [...(input.decisions ?? [])],
                  attempted: [...(input.attempted ?? [])],
                  nextActions: [...(input.nextActions ?? [])],
                  limitations: combinedLimitations,
                  repositories: observedRepositories,
                  artifacts: artifacts.artifacts,
                  validations: (input.validations ?? []).map((validation) => ({
                    id: validation.id,
                    result: validation.result,
                    inputVersion: validation.inputVersion ?? null,
                    observedAt: now,
                  })),
                  nativeRefs: nativeRefs(input, now),
                  collaborationRecordRef: context.collaborationRecordRef,
                  contextCompleteness,
                };
                const parsed = checkpointSchema.safeParse(checkpoint);
                const ref = `checkpoints/${String(revision).padStart(4, '0')}-${checkpointId}.json`;
                checkpointPath = join(paths.taskDir, ref);
                if (!parsed.success) {
                  result = {
                    ok: false,
                    status: 'failed',
                    checkpoint: null,
                    checkpointPath: null,
                    latestPath: paths.latestPath,
                    diagnostics: [
                      diag(
                        diagnosticCodes.document_record_invalid,
                        `Checkpoint is invalid: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`,
                        paths.contextPath,
                        'Fix the checkpoint inputs; no pointer was changed.',
                      ),
                    ],
                    residualPaths: [],
                  };
                } else {
                  const written = await writeContinuityBytes(
                    workspace.root,
                    input.taskId,
                    checkpointPath,
                    Buffer.from(`${JSON.stringify(parsed.data, null, 2)}\n`),
                    true,
                  );
                  if (!written.ok) {
                    result = {
                      ok: false,
                      status: 'failed',
                      checkpoint: null,
                      checkpointPath: null,
                      latestPath: paths.latestPath,
                      diagnostics: [
                        outcomeDiagnostic(
                          written,
                          checkpointPath ?? paths.taskDir,
                        ),
                      ],
                      residualPaths: [],
                    };
                  } else {
                    const readBack = await readContinuityBytes(
                      workspace.root,
                      input.taskId,
                      checkpointPath,
                    );
                    if (
                      !readBack.ok ||
                      sha256Digest(readBack.value) !== written.value.digest
                    ) {
                      result = {
                        ok: false,
                        status: 'partial',
                        checkpoint: null,
                        checkpointPath,
                        latestPath: paths.latestPath,
                        diagnostics: [
                          diag(
                            diagnosticCodes.fileUnreadable,
                            'Checkpoint bytes could not be verified after write.',
                            checkpointPath,
                            'Inspect the private checkpoint; the latest pointer was not changed.',
                          ),
                        ],
                        residualPaths: [checkpointPath],
                      };
                    } else {
                      const pointerNow = await readPointer(
                        workspace.root,
                        input.taskId,
                      );
                      if (pointerNow.digest !== pointerRead.digest) {
                        result = {
                          ok: false,
                          status: 'conflict',
                          checkpoint: null,
                          checkpointPath,
                          latestPath: paths.latestPath,
                          diagnostics: [
                            diag(
                              diagnosticCodes.document_proposal_stale,
                              'Latest checkpoint changed while this checkpoint was being written.',
                              paths.latestPath,
                              'The old pointer remains; inspect the residual checkpoint before retrying.',
                            ),
                          ],
                          residualPaths: [checkpointPath],
                        };
                      } else {
                        try {
                          await this.#options.beforeLatestPointerPersist?.();
                        } catch (error) {
                          result = {
                            ok: false,
                            status: 'partial',
                            checkpoint: parsed.data,
                            checkpointPath,
                            latestPath: paths.latestPath,
                            diagnostics: [
                              diag(
                                diagnosticCodes.fileUnreadable,
                                `Latest pointer write interrupted: ${errorMessage(error)}`,
                                paths.latestPath,
                                'The previous readable checkpoint remains authoritative; inspect the residual checkpoint.',
                              ),
                            ],
                            residualPaths: [checkpointPath],
                          };
                        }
                        if (result === undefined) {
                          const pointerValue: CheckpointPointer = {
                            schema: 'pappra/checkpoint-pointer/1',
                            taskId: input.taskId,
                            workspaceId: workspace.config.workspaceId,
                            revision,
                            checkpointRef: ref,
                            checkpointDigest: written.value.digest,
                            updatedAt: new Date().toISOString(),
                          };
                          const pointerWritten =
                            await replaceContinuityBytesIfDigest(
                              workspace.root,
                              input.taskId,
                              paths.latestPath,
                              Buffer.from(
                                `${JSON.stringify(pointerValue, null, 2)}\n`,
                              ),
                              pointerRead.digest,
                            );
                          if (!pointerWritten.ok) {
                            result = {
                              ok: false,
                              status:
                                pointerWritten.code ===
                                diagnosticCodes.document_proposal_stale
                                  ? 'conflict'
                                  : 'partial',
                              checkpoint: parsed.data,
                              checkpointPath,
                              latestPath: paths.latestPath,
                              diagnostics: [
                                diag(
                                  pointerWritten.code,
                                  pointerWritten.message,
                                  paths.latestPath,
                                  'The previous/concurrent pointer was preserved; inspect the residual checkpoint.',
                                ),
                              ],
                              residualPaths: [checkpointPath],
                            };
                          } else {
                            result = {
                              ok: true,
                              status: 'saved',
                              checkpoint: parsed.data,
                              checkpointPath,
                              latestPath: paths.latestPath,
                              diagnostics: saveDiagnostics,
                              residualPaths: [],
                            };
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    } catch (error) {
      result = {
        ok: false,
        status: 'failed',
        checkpoint: null,
        checkpointPath,
        latestPath: paths.latestPath,
        diagnostics: [
          diag(
            diagnosticCodes.initApplyFailed,
            `Checkpoint write failed: ${errorMessage(error)}`,
            paths.taskDir,
            'Inspect the private task state; no pointer was intentionally changed.',
          ),
        ],
        residualPaths: checkpointPath === null ? [] : [checkpointPath],
      };
    }
    const release = await releaseTaskLock(lock.path, lock.token, directory);
    if (result === undefined) {
      result = {
        ok: false,
        status: 'failed',
        checkpoint: null,
        checkpointPath,
        latestPath: paths.latestPath,
        diagnostics: [
          diag(
            diagnosticCodes.initApplyFailed,
            'Checkpoint writer ended without a result.',
            paths.taskDir,
            'Inspect the private task state; no pointer was intentionally changed.',
          ),
        ],
        residualPaths: checkpointPath === null ? [] : [checkpointPath],
      };
    }
    if (!release.ok) {
      return {
        ...result,
        ok: false,
        status: result.status === 'saved' ? 'partial' : result.status,
        diagnostics: [
          ...result.diagnostics,
          outcomeDiagnostic(release, lock.path),
        ],
        residualPaths: [...result.residualPaths, lock.path],
      };
    }
    return result;
  }

  async resume(input: ResumeCheckpointInput): Promise<ResumeCheckpointResult> {
    const loaded = await loadContinuityWorkspace(this.root);
    if (!loaded.ok || loaded.workspace === null) {
      return {
        ok: false,
        status: 'failed',
        packet: null,
        diagnostics: [...loaded.diagnostics],
      };
    }
    const workspace = loaded.workspace;
    try {
      continuityTaskPaths(workspace.root, input.taskId);
    } catch (error) {
      return {
        ok: false,
        status: 'invalid',
        packet: null,
        diagnostics: [
          diag(
            diagnosticCodes.document_record_invalid,
            `Invalid task id: ${errorMessage(error)}`,
            workspace.root,
            'Use a stable task id with letters, digits, dot, underscore, or dash.',
          ),
        ],
      };
    }
    const contextRead = await readTaskContext(workspace.root, input.taskId);
    if (!contextRead.exists) {
      return {
        ok: false,
        status: 'not-found',
        packet: null,
        diagnostics: [
          diag(
            diagnosticCodes.document_not_found,
            `Task context not found: ${input.taskId}`,
            continuityTaskPaths(workspace.root, input.taskId).contextPath,
            'Use an exact existing task id; Pappra does not guess the latest task.',
          ),
        ],
      };
    }
    if (contextRead.value === null) {
      return {
        ok: false,
        status: 'invalid',
        packet: null,
        diagnostics: [...contextRead.diagnostics],
      };
    }
    if (
      contextRead.value.taskId !== input.taskId ||
      contextRead.value.workspaceId !== workspace.config.workspaceId
    ) {
      return {
        ok: false,
        status: 'invalid',
        packet: null,
        diagnostics: [
          diag(
            diagnosticCodes.document_catalog_conflict,
            'Task context belongs to another workspace.',
            workspace.root,
            'Use the matching workspace; Pappra does not reuse another workspace task.',
          ),
        ],
      };
    }
    const pointerRead = await readPointer(workspace.root, input.taskId);
    if (!pointerRead.exists) {
      return {
        ok: false,
        status: 'not-found',
        packet: null,
        diagnostics: [
          diag(
            diagnosticCodes.document_not_found,
            `No checkpoint pointer for task: ${input.taskId}`,
            continuityTaskPaths(workspace.root, input.taskId).latestPath,
            'Pappra does not scan other tasks or infer a latest checkpoint.',
          ),
        ],
      };
    }
    if (pointerRead.value === null) {
      return {
        ok: false,
        status: 'invalid',
        packet: null,
        diagnostics: [...pointerRead.diagnostics],
      };
    }
    if (
      pointerRead.value.taskId !== input.taskId ||
      pointerRead.value.workspaceId !== workspace.config.workspaceId
    ) {
      return {
        ok: false,
        status: 'invalid',
        packet: null,
        diagnostics: [
          diag(
            diagnosticCodes.document_proposal_stale,
            'Latest pointer belongs to another task or workspace.',
            continuityTaskPaths(workspace.root, input.taskId).latestPath,
            'Inspect the pointer; Pappra does not reuse another task state.',
          ),
        ],
      };
    }
    const checkpointRead = await readCheckpoint(
      workspace.root,
      input.taskId,
      pointerRead.value,
    );
    if (checkpointRead.value === null) {
      return {
        ok: false,
        status: 'invalid',
        packet: null,
        diagnostics: [...checkpointRead.diagnostics],
      };
    }
    if (
      checkpointRead.value.taskId !== input.taskId ||
      checkpointRead.value.workspaceId !== workspace.config.workspaceId ||
      checkpointRead.value.revision !== pointerRead.value.revision
    ) {
      return {
        ok: false,
        status: 'invalid',
        packet: null,
        diagnostics: [
          diag(
            diagnosticCodes.document_proposal_stale,
            'Checkpoint identity does not match the requested task, workspace, or pointer revision.',
            workspace.root,
            'Inspect the private checkpoint/pointer; no recovery was guessed.',
          ),
        ],
      };
    }
    const checkpoint = checkpointRead.value;
    const diagnostics: Diagnostic[] = [...workspace.diagnostics];
    const identityChecks: ResumePacket['identityChecks'] = [
      {
        name: 'task-id',
        status: checkpoint.taskId === input.taskId ? 'ok' : 'changed',
        detail: checkpoint.taskId,
      },
      {
        name: 'workspace-id',
        status:
          checkpoint.workspaceId === workspace.config.workspaceId
            ? 'ok'
            : 'changed',
        detail: checkpoint.workspaceId,
      },
      {
        name: 'pointer-revision',
        status:
          pointerRead.value.revision === checkpoint.revision ? 'ok' : 'changed',
        detail: `${pointerRead.value.revision}/${checkpoint.revision}`,
      },
    ];
    const currentRepositories = new Map<
      string,
      Checkpoint['repositories'][number]
    >();
    const currentIdentities = repositoryIdentities(
      workspace.repositories,
      workspace.config.repositories.map((repository) => repository.id),
    );
    for (const [index, repository] of workspace.repositories.entries()) {
      const snapshot = await snapshotRepository(
        workspace,
        repository,
        index,
        currentIdentities[index],
      );
      currentRepositories.set(snapshot.record.repoId, snapshot.record);
    }
    const storedRepositoryIds = new Set(
      checkpoint.repositories.map((repository) => repository.repoId),
    );
    const currentOnly = [...currentRepositories.keys()]
      .filter((repoId) => !storedRepositoryIds.has(repoId))
      .sort();
    const unresolvedIds = workspace.unresolvedRepositories.map(
      (entry) => `${entry.id} (${entry.configuredPath})`,
    );
    const coverageParts: string[] = [];
    if (unresolvedIds.length > 0) {
      coverageParts.push(
        `configured but unresolved: ${boundedCoverageIds(unresolvedIds)}`,
      );
    }
    if (currentOnly.length > 0) {
      coverageParts.push(`current-only: ${boundedCoverageIds(currentOnly)}`);
    }
    if (workspace.discoveryTruncated) {
      coverageParts.push('discovery was truncated');
    }
    const coverageMessage =
      coverageParts.length === 0
        ? null
        : `Repository coverage is incomplete: ${coverageParts.join('; ')}.`;
    const coverageUnknown = coverageMessage !== null;
    const repositoryDrift: ResumePacket['codeDrift']['repositories'] = [];
    for (const stored of checkpoint.repositories) {
      const patchPath =
        stored.patchDigest === null
          ? null
          : join(
              continuityTaskPaths(workspace.root, input.taskId).patchesDir,
              `${stored.patchDigest.slice('sha256:'.length)}.patch`,
            );
      let patchStatus: ResumePacket['codeDrift']['repositories'][number]['patchStatus'] =
        'not-applicable';
      let patchDetail: string | null = null;
      if (patchPath !== null) {
        const patchRead = await readContinuityBytes(
          workspace.root,
          input.taskId,
          patchPath,
        );
        if (!patchRead.ok) {
          patchStatus =
            patchRead.code === diagnosticCodes.fileNotFound
              ? 'missing'
              : 'unsafe';
          patchDetail = patchRead.message;
        } else if (sha256Digest(patchRead.value) !== stored.patchDigest) {
          patchStatus = 'changed';
          patchDetail =
            'Private patch bytes do not match the checkpoint digest.';
        } else {
          patchStatus = 'unchanged';
        }
      }
      const current = currentRepositories.get(stored.repoId);
      if (current === undefined) {
        repositoryDrift.push({
          repoId: stored.repoId,
          status: 'missing',
          storedHead: stored.head,
          currentHead: null,
          storedDirty: stored.dirty,
          currentDirty: null,
          storedPatchDigest: stored.patchDigest,
          currentPatchDigest: null,
          storedCheckoutId: stored.checkoutId,
          currentCheckoutId: null,
          storedCaptureStatus: stored.captureStatus,
          currentCaptureStatus: 'unknown',
          patchStatus,
          patchDetail,
          detail: `Repository ${stored.repoId} is no longer present.`,
        });
        continue;
      }
      const relocated = current.root !== stored.root;
      const checkoutChanged = current.checkoutId !== stored.checkoutId;
      const changed =
        current.head !== stored.head ||
        current.dirty !== stored.dirty ||
        current.patchDigest !== stored.patchDigest ||
        checkoutChanged;
      const unknownCapture =
        stored.captureStatus !== 'complete' ||
        current.captureStatus !== 'complete' ||
        patchStatus === 'missing' ||
        patchStatus === 'changed' ||
        patchStatus === 'unsafe';
      const detail = relocated
        ? `Repository path moved from ${stored.root} to ${current.root}${stored.root.includes(' ') || current.root.includes(' ') ? ' (space-containing path)' : ''}.`
        : checkoutChanged
          ? 'Repository checkout identity changed since the checkpoint.'
          : changed
            ? 'HEAD/dirty/patch state changed since the checkpoint.'
            : patchDetail;
      repositoryDrift.push({
        repoId: stored.repoId,
        status: relocated
          ? 'relocated'
          : unknownCapture
            ? 'unknown'
            : changed
              ? 'changed'
              : stored.head === null || stored.dirty === null
                ? 'unknown'
                : 'unchanged',
        storedHead: stored.head,
        currentHead: current.head,
        storedDirty: stored.dirty,
        currentDirty: current.dirty,
        storedPatchDigest: stored.patchDigest,
        currentPatchDigest: current.patchDigest,
        storedCheckoutId: stored.checkoutId,
        currentCheckoutId: current.checkoutId,
        storedCaptureStatus: stored.captureStatus,
        currentCaptureStatus: current.captureStatus,
        patchStatus,
        patchDetail,
        detail,
      });
    }
    const driftStatus: ResumePacket['codeDrift']['status'] =
      repositoryDrift.some((entry) => entry.status === 'relocated')
        ? 'relocated'
        : repositoryDrift.some((entry) => entry.status === 'changed')
          ? 'changed'
          : repositoryDrift.some(
                (entry) =>
                  entry.status === 'missing' || entry.status === 'unknown',
              )
            ? 'unknown'
            : 'unchanged';
    const codeStatus: ResumePacket['codeDrift']['status'] = coverageUnknown
      ? 'unknown'
      : driftStatus;
    const artifactChecks: ResumePacket['artifactChecks'] = [];
    for (const artifact of checkpoint.artifacts) {
      const resolved = await readArtifactPath(workspace.root, artifact.path);
      if (!resolved.ok) {
        artifactChecks.push({
          path: artifact.path,
          status: 'unsafe',
          detail: resolved.message,
        });
        continue;
      }
      const read = await readFileBounded(resolved.value, MAX_ARTIFACT_BYTES);
      if (!read.ok) {
        artifactChecks.push({
          path: artifact.path,
          status:
            read.code === diagnosticCodes.fileNotFound ? 'missing' : 'unknown',
          detail: read.message,
        });
      } else {
        artifactChecks.push({
          path: artifact.path,
          status:
            read.value.digest === artifact.digest ? 'unchanged' : 'changed',
          detail:
            read.value.digest === artifact.digest
              ? null
              : 'Artifact digest changed since the checkpoint.',
        });
      }
    }
    const collaborationObservation = await observeCollaboration(
      checkpoint,
      workspace.root,
    );
    const blockingReasons: NonNullable<
      ResumePacket['blockingReasons'][number]
    >[] = [];
    const pushBlock = (code: string, message: string): void => {
      if (!blockingReasons.some((entry) => entry.code === code)) {
        blockingReasons.push({ code, message });
      }
    };
    pushBlock(
      'live_writer_unverified',
      'A stored checkpoint cannot prove which session is still writing or has stopped; execution remains blocked.',
    );
    if (collaborationObservation.status === 'unsupported') {
      pushBlock(
        'collaboration_authority_invalid',
        'The referenced record is not a supported authoritative collaboration task record.',
      );
    }
    for (const code of collaborationObservation.authority.blockerCodes) {
      pushBlock(
        code,
        `The authoritative collaboration record reports ${code}; execution remains blocked.`,
      );
    }
    if (
      repositoryDrift.some(
        (entry) => entry.storedCheckoutId !== entry.currentCheckoutId,
      )
    ) {
      pushBlock(
        'checkout_identity_changed',
        'Repository checkout identity changed since the checkpoint; execution is blocked.',
      );
    }
    if (
      repositoryDrift.some(
        (entry) =>
          entry.patchStatus !== 'unchanged' &&
          entry.patchStatus !== 'not-applicable',
      )
    ) {
      pushBlock(
        'private_patch_unavailable',
        'A private patch is missing, changed or unsafe; verification is not current.',
      );
    }
    if (coverageMessage !== null) {
      pushBlock('repository_coverage_incomplete', coverageMessage);
    }
    if (
      repositoryDrift.some(
        (entry) =>
          entry.storedCaptureStatus !== 'complete' ||
          entry.currentCaptureStatus !== 'complete',
      )
    ) {
      pushBlock(
        'snapshot_incomplete',
        'Repository capture was partial or unknown; current verification is not established.',
      );
    }
    if (checkpoint.workspaceId !== workspace.config.workspaceId) {
      pushBlock(
        'workspace_identity_changed',
        'Checkpoint workspace identity differs from the current workspace.',
      );
    }
    if (checkpoint.authorSession === null) {
      pushBlock(
        'unknown_writer',
        'Checkpoint author session is unknown; execution is blocked.',
      );
    } else if (
      input.currentSession === undefined ||
      input.currentSession === null
    ) {
      pushBlock(
        'writer_not_confirmed',
        'Current writer session was not supplied; execution is blocked.',
      );
    } else if (input.currentSession !== checkpoint.authorSession) {
      pushBlock(
        'writer_mismatch',
        'Current writer session differs from the checkpoint author; execution is blocked.',
      );
    }
    if (checkpoint.contextCompleteness === 'partial') {
      pushBlock(
        'context_partial',
        'Semantic context is incomplete; execution is blocked.',
      );
    }
    if (
      collaborationObservation.status === 'missing' ||
      collaborationObservation.status === 'unreadable'
    ) {
      pushBlock(
        'collaboration_record_unavailable',
        'The referenced collaboration record could not be read; execution is blocked.',
      );
    }
    if (codeStatus === 'relocated' || codeStatus === 'unknown') {
      pushBlock(
        'code_identity_changed',
        'Repository identity/path changed or is unknown; inspect before execution.',
      );
    }
    const privatePayloadChanged = repositoryDrift.some(
      (entry) => entry.patchStatus === 'changed',
    );
    const verificationStatus: ResumePacket['verificationStatus'] =
      codeStatus === 'changed' ||
      privatePayloadChanged ||
      artifactChecks.some((entry) => entry.status === 'changed')
        ? 'stale'
        : codeStatus === 'relocated' ||
            codeStatus === 'unknown' ||
            artifactChecks.some((entry) => entry.status !== 'unchanged')
          ? 'unknown'
          : 'current';
    const acceptance = boundedArray(checkpoint.acceptance);
    const constraints = boundedArray(checkpoint.constraints);
    const decisions = boundedArray(checkpoint.decisions);
    const attempted = boundedArray(checkpoint.attempted);
    const nextActions = boundedArray(checkpoint.nextActions);
    const limitations = boundedArray(checkpoint.limitations);
    const repositoriesBounded = boundedArray(checkpoint.repositories);
    const artifactsBounded = boundedArray(checkpoint.artifacts);
    const truncated =
      acceptance.truncated ||
      constraints.truncated ||
      decisions.truncated ||
      attempted.truncated ||
      nextActions.truncated ||
      limitations.truncated ||
      repositoriesBounded.truncated ||
      artifactsBounded.truncated;
    const packet: ResumePacket = {
      schema: 'pappra/resume-packet/1',
      generatedAt: new Date().toISOString(),
      taskId: checkpoint.taskId,
      workspaceId: checkpoint.workspaceId,
      checkpoint: {
        ref: pointerRead.value.checkpointRef,
        digest: pointerRead.value.checkpointDigest,
        revision: pointerRead.value.revision,
      },
      identityChecks,
      codeDrift: { status: codeStatus, repositories: repositoryDrift },
      artifactChecks,
      executionObservations: checkpoint.nativeRefs.map((ref) => ({
        harness: ref.harness,
        sessionId: ref.sessionId,
        turnId: ref.turnId,
        runId: ref.runId,
        scope: 'stored-snapshot',
        liveStatus: 'unknown',
        observedAt: ref.observedAt,
      })),
      collaborationObservation,
      blockingReasons,
      executionAllowed: blockingReasons.length === 0,
      contextCompleteness: checkpoint.contextCompleteness,
      verificationStatus,
      boundedContext: {
        objective: checkpoint.objective,
        acceptance: acceptance.values,
        constraints: constraints.values,
        decisions: decisions.values,
        attempted: attempted.values,
        nextActions: nextActions.values,
        limitations: limitations.values,
        repositories: repositoriesBounded.values,
        artifacts: artifactsBounded.values,
        truncated,
      },
    };
    const parsed = resumePacketSchema.safeParse(packet);
    if (!parsed.success) {
      return {
        ok: false,
        status: 'invalid',
        packet: null,
        diagnostics: [
          diag(
            diagnosticCodes.configSchemaInvalid,
            `Resume packet is invalid: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`,
            checkpointPath(workspace.root, input.taskId, pointerRead.value),
            'Inspect the private checkpoint; no recovery was guessed.',
          ),
        ],
      };
    }
    const nowDiagnostics = [...diagnostics];
    for (const reason of blockingReasons) {
      nowDiagnostics.push({
        code: diagnosticCodes.resume_execution_blocked,
        severity: 'warning',
        message: reason.message,
        source: continuityTaskPaths(workspace.root, input.taskId).latestPath,
        pointer: null,
        hint: 'This is a read-only diagnostic; no execution was started.',
      });
    }
    return {
      ok: true,
      status: blockingReasons.length === 0 ? 'ready' : 'blocked',
      packet: parsed.data,
      diagnostics: nowDiagnostics,
    };
  }
}

function checkpointPath(
  root: string,
  taskId: string,
  pointer: CheckpointPointer,
): string {
  return (
    checkpointAbsolutePath(root, taskId, pointer.checkpointRef) ??
    pointer.checkpointRef
  );
}
