import { randomUUID } from 'node:crypto';
import { link, mkdir, open, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Outcome } from '../schemas/outcome.js';
import { errorMessage, failed, succeeded } from '../schemas/outcome.js';
import { diagnosticCodes } from '../schemas/errors.js';
import {
  isPathInside,
  resolvePortableRelativePath,
  samePath,
} from '../schemas/paths.js';
import {
  observePath,
  readFileBounded,
  readTextFileBounded,
  resolveRealpath,
  sha256Digest,
} from '../infra/fs.js';
import { resolveWorkspaceRoot } from '../workspace/resolve.js';

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Shared bound for private recovery payloads. Capture, durable writes and
 * resume reads all use this value; a payload over the bound is captured only
 * partially and must never be reported as complete.
 */
export const CONTINUITY_PAYLOAD_MAX_BYTES = 16 * 1024 * 1024;

export interface ContinuityWriteOptions {
  /** Test/fault-injection seam immediately before an exclusive publication. */
  readonly beforeExclusivePublish?: () => Promise<void>;
}

export interface ContinuityTaskPaths {
  readonly taskDir: string;
  readonly contextPath: string;
  readonly latestPath: string;
  readonly checkpointsDir: string;
  readonly patchesDir: string;
  readonly lockPath: string;
}

export function continuityTaskPaths(
  root: string,
  taskId: string,
): ContinuityTaskPaths {
  if (!TASK_ID.test(taskId) || taskId.length > 64) {
    throw new RangeError(`Invalid task id: ${taskId}`);
  }
  const taskDir = join(root, '.pappra', 'local', 'tasks', taskId);
  return {
    taskDir,
    contextPath: join(taskDir, 'task-context.json'),
    latestPath: join(taskDir, 'latest.json'),
    checkpointsDir: join(taskDir, 'checkpoints'),
    patchesDir: join(taskDir, 'patches'),
    lockPath: join(taskDir, 'checkpoint.lock'),
  };
}

async function checkCanonicalAncestor(
  realRoot: string,
  target: string,
  path: string,
): Promise<Outcome<null>> {
  let current = path;
  for (;;) {
    let observation;
    try {
      observation = await observePath(current);
    } catch (error) {
      return failed(
        diagnosticCodes.fileUnreadable,
        `Cannot inspect continuity path ${current}: ${errorMessage(error)}`,
        {
          nextAction:
            'Inspect permissions; no private state was read or written.',
        },
      );
    }
    if (observation.kind !== 'missing') {
      const isFinal = samePath(current, path);
      if (observation.kind === 'symlink') {
        return failed(
          diagnosticCodes.document_path_unsafe,
          `Continuity path is a symlink: ${current}`,
          {
            nextAction:
              'Use regular private state files; symlinked continuity state is not followed.',
          },
        );
      }
      if (!isFinal && observation.kind !== 'directory') {
        return failed(
          diagnosticCodes.document_path_unsafe,
          `Continuity parent is not a directory: ${current}`,
          {
            nextAction:
              'Inspect the private task directory; no write was made.',
          },
        );
      }
      const real = await resolveRealpath(current);
      if (
        real === null ||
        !isPathInside(realRoot, real) ||
        (!isPathInside(real, target) && !isPathInside(target, real))
      ) {
        return failed(
          diagnosticCodes.document_path_unsafe,
          `Continuity path resolves outside the private task namespace: ${current}`,
          {
            nextAction:
              'Inspect or remove the redirected state path explicitly; Pappra does not repair it.',
          },
        );
      }
      return succeeded(null);
    }
    const parent = dirname(current);
    if (samePath(parent, current)) {
      return failed(
        diagnosticCodes.document_path_unsafe,
        `Cannot find an existing ancestor for ${path}`,
        { nextAction: 'Use a workspace-local private task directory.' },
      );
    }
    current = parent;
  }
}

export async function ensureContinuityBoundary(
  root: string,
  path: string,
): Promise<Outcome<null>> {
  if (!isPathInside(root, path)) {
    return failed(
      diagnosticCodes.document_path_unsafe,
      `Continuity path escapes workspace: ${path}`,
      {
        nextAction:
          'Use only the private task directory and current workspace.',
      },
    );
  }
  const realRoot = await resolveRealpath(root);
  if (realRoot === null) {
    return failed(
      diagnosticCodes.document_path_unsafe,
      `Cannot resolve workspace root: ${root}`,
      { nextAction: 'Use an existing readable workspace root.' },
    );
  }
  const current = await resolveRealpath(path);
  if (current !== null) {
    return isPathInside(realRoot, current)
      ? succeeded(null)
      : failed(
          diagnosticCodes.document_path_unsafe,
          `Continuity path resolves outside workspace: ${path}`,
          { nextAction: 'Inspect symlinked state paths; no write was made.' },
        );
  }
  return checkCanonicalAncestor(realRoot, path, path);
}

export async function ensurePrivateTaskBoundary(
  root: string,
  taskId: string,
  path: string,
): Promise<Outcome<null>> {
  const paths = continuityTaskPaths(root, taskId);
  if (!isPathInside(paths.taskDir, path)) {
    return failed(
      diagnosticCodes.document_path_unsafe,
      `Continuity path is outside the private task directory: ${path}`,
      {
        nextAction:
          'Use only .pappra/local/tasks/<taskId> for checkpoints, pointers and patches.',
      },
    );
  }
  const realRoot = await resolveRealpath(root);
  if (realRoot === null) {
    return failed(
      diagnosticCodes.document_path_unsafe,
      `Cannot resolve workspace root: ${root}`,
      { nextAction: 'Use an existing readable workspace root.' },
    );
  }
  const canonicalTask = join(realRoot, '.pappra', 'local', 'tasks', taskId);
  return checkCanonicalAncestor(realRoot, canonicalTask, path);
}

async function writeTemporary(
  path: string,
  bytes: Buffer,
): Promise<
  | { readonly ok: true; readonly temporary: string }
  | { readonly ok: false; readonly message: string }
> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
    }
    return { ok: true, temporary };
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    return {
      ok: false,
      message: `Cannot write continuity file ${path}: ${errorMessage(error)}`,
    };
  }
}

function errorCode(error: unknown): string | null {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : null;
}

export async function writeContinuityBytes(
  root: string,
  taskId: string,
  path: string,
  bytes: Buffer,
  exclusive: boolean,
  options: ContinuityWriteOptions = {},
): Promise<Outcome<{ readonly digest: string }>> {
  const boundary = await ensurePrivateTaskBoundary(root, taskId, path);
  if (!boundary.ok) return boundary;
  const temporary = await writeTemporary(path, bytes);
  if (!temporary.ok) {
    return failed(diagnosticCodes.fileUnreadable, temporary.message, {
      nextAction:
        'Inspect permissions and available disk space; no success was claimed.',
    });
  }
  try {
    if (exclusive) {
      await options.beforeExclusivePublish?.();
      // link(2) publishes atomically and fails with EEXIST if any target,
      // including a concurrently created one, already exists. A precheck
      // followed by rename would replace that target.
      try {
        await link(temporary.temporary, path);
      } catch (error) {
        if (errorCode(error) === 'EEXIST') {
          return failed(
            diagnosticCodes.document_write_conflict,
            `Continuity target already exists: ${path}`,
            {
              nextAction:
                'Use a fresh checkpoint revision; existing state is never replaced.',
            },
          );
        }
        return failed(
          diagnosticCodes.fileUnreadable,
          `Cannot publish exclusive continuity file ${path}: ${errorMessage(error)}`,
          {
            nextAction:
              'Use a filesystem that supports atomic no-replace publication; no fallback replaced the target.',
          },
        );
      }
      return succeeded({ digest: sha256Digest(bytes) });
    }
    await rename(temporary.temporary, path);
    return succeeded({ digest: sha256Digest(bytes) });
  } catch (error) {
    return failed(
      diagnosticCodes.fileUnreadable,
      `Cannot commit continuity file ${path}: ${errorMessage(error)}`,
      { nextAction: 'Inspect permissions; no success was claimed.' },
    );
  } finally {
    await rm(temporary.temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Replaces a file only if its current bytes still have the expected digest.
 * The comparison happens after the temporary bytes are durable and immediately
 * before rename; it is cooperative CAS, not a filesystem-wide transaction.
 */
export async function replaceContinuityBytesIfDigest(
  root: string,
  taskId: string,
  path: string,
  bytes: Buffer,
  expectedDigest: string | null,
): Promise<Outcome<{ readonly digest: string }>> {
  const boundary = await ensurePrivateTaskBoundary(root, taskId, path);
  if (!boundary.ok) return boundary;
  const temporary = await writeTemporary(path, bytes);
  if (!temporary.ok) {
    return failed(diagnosticCodes.fileUnreadable, temporary.message, {
      nextAction:
        'Inspect permissions and available disk space; no success was claimed.',
    });
  }
  try {
    const current = await readFileBounded(path, CONTINUITY_PAYLOAD_MAX_BYTES);
    const currentDigest = current.ok ? current.value.digest : null;
    if (
      (!current.ok && current.code !== diagnosticCodes.fileNotFound) ||
      currentDigest !== expectedDigest
    ) {
      return failed(
        current.ok || current.code === diagnosticCodes.fileNotFound
          ? diagnosticCodes.document_proposal_stale
          : current.code,
        `Continuity file changed before commit: ${path}`,
        {
          nextAction:
            'Reload the pointer and retry explicitly; concurrent bytes were preserved.',
        },
      );
    }
    await rename(temporary.temporary, path);
    return succeeded({ digest: sha256Digest(bytes) });
  } catch (error) {
    return failed(
      diagnosticCodes.fileUnreadable,
      `Cannot commit continuity file ${path}: ${errorMessage(error)}`,
      { nextAction: 'Inspect permissions; no success was claimed.' },
    );
  } finally {
    await rm(temporary.temporary, { force: true }).catch(() => undefined);
  }
}

export async function readContinuityText(
  root: string,
  taskId: string,
  path: string,
): Promise<Outcome<string>> {
  const boundary = await ensurePrivateTaskBoundary(root, taskId, path);
  if (!boundary.ok) return boundary;
  const read = await readTextFileBounded(path);
  return read.ok ? succeeded(read.value.text) : read;
}

export async function readContinuityBytes(
  root: string,
  taskId: string,
  path: string,
): Promise<Outcome<Buffer>> {
  const boundary = await ensurePrivateTaskBoundary(root, taskId, path);
  if (!boundary.ok) return boundary;
  const read = await readFileBounded(path, CONTINUITY_PAYLOAD_MAX_BYTES);
  return read.ok ? succeeded(read.value.bytes) : read;
}

export async function removeContinuityFile(
  root: string,
  taskId: string,
  path: string,
): Promise<void> {
  const boundary = await ensurePrivateTaskBoundary(root, taskId, path);
  if (!boundary.ok) return;
  await unlink(path).catch(() => undefined);
}

export async function readArtifactPath(
  root: string,
  artifactPath: string,
): Promise<Outcome<string>> {
  let absolute: string;
  try {
    absolute = artifactPath.startsWith('/')
      ? artifactPath
      : resolvePortableRelativePath(root, artifactPath);
  } catch {
    return failed(
      diagnosticCodes.document_path_unsafe,
      `Invalid artifact path: ${artifactPath}`,
      { nextAction: 'Use a workspace-relative artifact path.' },
    );
  }
  if (!isPathInside(root, absolute)) {
    return failed(
      diagnosticCodes.document_path_unsafe,
      `Artifact path escapes workspace: ${artifactPath}`,
      { nextAction: 'Keep checkpoint artifacts inside the workspace.' },
    );
  }
  const boundary = await ensureContinuityBoundary(root, absolute);
  if (!boundary.ok) return boundary;
  const resolution = await resolveWorkspaceRoot({
    startPath: dirname(absolute),
  });
  const realRoot = await resolveRealpath(root);
  const realNested =
    resolution.root === null ? null : await resolveRealpath(resolution.root);
  if (
    resolution.state === 'registered' &&
    realNested !== null &&
    realRoot !== null &&
    !samePath(realNested, realRoot)
  ) {
    return failed(
      diagnosticCodes.document_nested_workspace,
      `Artifact is inside nested workspace ${resolution.root}: ${artifactPath}`,
      { nextAction: 'Use an artifact from the current workspace.' },
    );
  }
  return succeeded(absolute);
}
