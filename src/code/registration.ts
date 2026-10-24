import { mkdir, open, rename, rm } from 'node:fs/promises';
import { ensurePrivateState } from '../infra/private-state.js';
import { randomUUID } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import {
  observePath,
  readFileBounded,
  resolveRealpath,
  sha256Digest,
} from '../infra/fs.js';
import { diagnosticCodes } from '../schemas/errors.js';
import { isPathInside } from '../schemas/paths.js';
import { failed, succeeded, type Outcome } from '../schemas/outcome.js';
import {
  codeIndexRegistrationSchema,
  type CodeIdentity,
  type CodeIndexRegistration,
} from '../schemas/code.js';
import { codeIdentityDigest } from './identity.js';

const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function codeRegistrationPath(
  root: string,
  repositoryId: string,
): string {
  if (!REPO_ID.test(repositoryId) || repositoryId.length > 64) {
    throw new RangeError(`Invalid repository id: ${repositoryId}`);
  }
  return join(root, '.pappra', 'local', 'code', `${repositoryId}.json`);
}

export async function ensureCodeMutationBoundary(
  root: string,
  path: string,
  excludedRoots: readonly string[] = [],
): Promise<Outcome<null>> {
  if (!isPathInside(root, path)) {
    return failed(
      diagnosticCodes.code_path_unsafe,
      `Private code path escapes the selected repository: ${path}`,
      { nextAction: 'Use a private path in the selected repository.' },
    );
  }
  const realRoot = await resolveRealpath(root);
  if (realRoot === null) {
    return failed(
      diagnosticCodes.code_path_unsafe,
      `Cannot resolve selected repository: ${root}`,
      {
        nextAction:
          'Inspect the selected repository; no mutation was performed.',
      },
    );
  }
  const realExcludedRoots = await Promise.all(
    excludedRoots.map(
      async (excluded) => (await resolveRealpath(excluded)) ?? excluded,
    ),
  );
  const rel = relative(root, path);
  let current = root;
  for (const part of rel.split(sep)) {
    if (part === '') continue;
    current = join(current, part);
    const observed = await observePath(current);
    if (observed.kind === 'symlink') {
      return failed(
        diagnosticCodes.code_path_unsafe,
        `Mutation path traverses a symlink: ${current}`,
        {
          nextAction: 'Replace the redirected path; no mutation was performed.',
        },
      );
    }
    if (observed.kind === 'missing') break;
  }
  const real = await resolveRealpath(path);
  if (real !== null) {
    if (!isPathInside(realRoot, real)) {
      return failed(
        diagnosticCodes.code_path_unsafe,
        `Mutation path resolves outside the selected repository: ${path}`,
        {
          nextAction:
            'Inspect the selected repository; no mutation was performed.',
        },
      );
    }
    if (realExcludedRoots.some((excluded) => isPathInside(excluded, real))) {
      return failed(
        diagnosticCodes.code_path_unsafe,
        `Mutation path resolves into another selected repository: ${path}`,
        {
          nextAction:
            'Choose a private path in the selected repository; no mutation was performed.',
        },
      );
    }
  }
  return succeeded(null);
}

interface PrepareLease {
  readonly root: string;
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly digest: string;
  readonly excludedRoots: readonly string[];
}

const PREPARE_LEASES = new Map<string, PrepareLease>();

export async function acquireCodePrepareLock(
  root: string,
  excludedRoots: readonly string[] = [],
): Promise<Outcome<string>> {
  const directory = join(root, '.pappra', 'local', 'code');
  const path = join(directory, 'prepare.lock');
  const boundary = await ensureCodeMutationBoundary(root, path, excludedRoots);
  if (!boundary.ok) return boundary;
  const prepared = await ensurePrivateState(root);
  if (!prepared.ok) return prepared;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const content = Buffer.from(
      `${JSON.stringify({ pid: process.pid, token: randomUUID(), acquiredAt: new Date().toISOString() })}\n`,
    );
    let ownership: OwnedBytes | null = null;
    const handle = await open(path, 'wx', 0o600);
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) {
        throw new Error(`Prepare lock is not a regular file: ${path}`);
      }
      ownership = {
        dev: opened.dev,
        ino: opened.ino,
        expected: content,
      };
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
    }
    const observed = await observePath(path);
    if (
      observed.kind !== 'file' ||
      observed.stats === null ||
      ownership === null ||
      observed.stats.dev !== ownership.dev ||
      observed.stats.ino !== ownership.ino
    ) {
      await removeRegistrationTemporaryIfOwned(
        root,
        path,
        excludedRoots,
        ownership,
      );
      return failed(
        diagnosticCodes.code_prepare_failed,
        `Cannot verify owned prepare lock: ${path}`,
        { nextAction: 'Inspect the private prepare lock; no command was run.' },
      );
    }
    const lockRead = await readFileBounded(path, 4096);
    if (!lockRead.ok || !lockRead.value.bytes.equals(content)) {
      await removeRegistrationTemporaryIfOwned(
        root,
        path,
        excludedRoots,
        ownership,
      );
      return failed(
        diagnosticCodes.code_prepare_failed,
        `Prepare lock content changed before use: ${path}`,
        { nextAction: 'Inspect the private prepare lock; no command was run.' },
      );
    }
    PREPARE_LEASES.set(path, {
      root,
      path,
      dev: ownership.dev,
      ino: ownership.ino,
      digest: sha256Digest(content),
      excludedRoots,
    });
    return succeeded(path);
  } catch (error) {
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : null;
    return failed(
      code === 'EEXIST'
        ? diagnosticCodes.code_prepare_conflict
        : diagnosticCodes.code_prepare_failed,
      code === 'EEXIST'
        ? `Another prepare owns ${path}; no command was run.`
        : `Cannot acquire code prepare lock: ${error instanceof Error ? error.message : String(error)}`,
      {
        nextAction:
          'Inspect the private prepare lock; stale locks require explicit manual resolution.',
      },
    );
  }
}

export async function releaseCodePrepareLock(
  path: string,
): Promise<Outcome<null>> {
  const lease = PREPARE_LEASES.get(path);
  if (lease === undefined) {
    return failed(
      diagnosticCodes.code_prepare_conflict,
      `No owned prepare lease is recorded for ${path}; cleanup was refused.`,
      {
        nextAction:
          'Inspect the private prepare state; do not delete unknown files.',
      },
    );
  }
  const boundary = await ensureCodeMutationBoundary(
    lease.root,
    path,
    lease.excludedRoots,
  );
  if (!boundary.ok) return boundary;
  const observed = await observePath(path);
  if (observed.kind === 'missing') {
    PREPARE_LEASES.delete(path);
    return succeeded(null);
  }
  if (
    observed.kind !== 'file' ||
    observed.stats === null ||
    observed.stats.dev !== lease.dev ||
    observed.stats.ino !== lease.ino
  ) {
    return failed(
      diagnosticCodes.code_prepare_conflict,
      `Prepare lock was replaced or redirected; it was preserved: ${path}`,
      {
        nextAction:
          'Inspect the private prepare lock; no user file was deleted.',
      },
    );
  }
  const read = await readFileBounded(path, 4096);
  if (!read.ok || read.value.digest !== lease.digest) {
    return failed(
      diagnosticCodes.code_prepare_conflict,
      `Prepare lock content changed; it was preserved: ${path}`,
      {
        nextAction:
          'Inspect the private prepare lock; no user file was deleted.',
      },
    );
  }
  try {
    await rm(path);
    PREPARE_LEASES.delete(path);
    return succeeded(null);
  } catch (error) {
    return failed(
      diagnosticCodes.code_prepare_partial,
      `Cannot release owned prepare lock: ${error instanceof Error ? error.message : String(error)}`,
      {
        nextAction:
          'Inspect and remove the owned lock after confirming ownership.',
      },
    );
  }
}

export async function readCodeRegistration(
  root: string,
  repositoryId: string,
): Promise<Outcome<CodeIndexRegistration | null>> {
  const path = codeRegistrationPath(root, repositoryId);
  const boundary = await ensureCodeMutationBoundary(root, path);
  if (!boundary.ok) return boundary;
  const observation = await observePath(path);
  if (observation.kind === 'missing') return succeeded(null);
  if (observation.kind !== 'file') {
    return failed(
      diagnosticCodes.code_registration_invalid,
      `Code registration is not a regular file: ${path}`,
      {
        nextAction:
          'Inspect the private code registration; no state was accepted.',
      },
    );
  }
  const read = await readFileBounded(path, 256 * 1024);
  if (!read.ok) return read;
  let value: unknown;
  try {
    value = JSON.parse(read.value.bytes.toString('utf8'));
  } catch {
    return failed(
      diagnosticCodes.code_registration_invalid,
      `Code registration is not valid JSON: ${path}`,
      {
        nextAction:
          'Reprepare the selected repository; the registration was not trusted.',
      },
    );
  }
  const parsed = codeIndexRegistrationSchema.safeParse(value);
  if (!parsed.success) {
    return failed(
      diagnosticCodes.code_registration_invalid,
      `Code registration schema is invalid: ${path}`,
      {
        nextAction:
          'Reprepare the selected repository; the registration was not trusted.',
      },
    );
  }
  return succeeded(parsed.data);
}

export function registrationMatches(
  registration: CodeIndexRegistration,
  identity: CodeIdentity,
): boolean {
  return (
    registration.repositoryId === identity.repositoryId &&
    registration.checkoutId === identity.checkoutId &&
    registration.root === identity.root &&
    registration.engineVersion === identity.engine.version &&
    registration.configDigest === identity.engine.configDigest &&
    registration.identityDigest === codeIdentityDigest(identity)
  );
}

interface OwnedBytes {
  readonly dev: number;
  readonly ino: number;
  readonly expected: Buffer;
}

type RegistrationCleanupReason =
  | 'unknown_ownership'
  | 'boundary_refused'
  | 'not_regular_file'
  | 'identity_changed'
  | 'read_failed'
  | 'content_changed'
  | 'remove_failed';

interface RegistrationCleanupObservation {
  readonly residualPath: string | null;
  readonly reason: RegistrationCleanupReason | null;
}

function noCleanupResidual(): RegistrationCleanupObservation {
  return { residualPath: null, reason: null };
}

async function removeRegistrationTemporaryIfOwned(
  root: string,
  path: string,
  excludedRoots: readonly string[],
  identity: OwnedBytes | null,
): Promise<RegistrationCleanupObservation> {
  const observed = await observePath(path);
  if (observed.kind === 'missing') return noCleanupResidual();
  if (identity === null) {
    return { residualPath: path, reason: 'unknown_ownership' };
  }
  const boundary = await ensureCodeMutationBoundary(root, path, excludedRoots);
  if (!boundary.ok) {
    return { residualPath: path, reason: 'boundary_refused' };
  }
  if (observed.kind !== 'file' || observed.stats === null) {
    return { residualPath: path, reason: 'not_regular_file' };
  }
  if (
    observed.stats.dev !== identity.dev ||
    observed.stats.ino !== identity.ino
  ) {
    return { residualPath: path, reason: 'identity_changed' };
  }
  const read = await readFileBounded(path, 512 * 1024);
  if (!read.ok) {
    return { residualPath: path, reason: 'read_failed' };
  }
  const bytes = read.value.bytes;
  const isComplete = identity.expected.equals(bytes);
  const isSafePrefix =
    bytes.length < identity.expected.length &&
    identity.expected.subarray(0, bytes.length).equals(bytes);
  if (!isComplete && !isSafePrefix) {
    return { residualPath: path, reason: 'content_changed' };
  }
  try {
    await rm(path);
    return noCleanupResidual();
  } catch {
    return { residualPath: path, reason: 'remove_failed' };
  }
}

export async function writeCodeRegistration(
  root: string,
  registration: CodeIndexRegistration,
  excludedRoots: readonly string[] = [],
): Promise<Outcome<string>> {
  const path = codeRegistrationPath(root, registration.repositoryId);
  const boundary = await ensureCodeMutationBoundary(root, path, excludedRoots);
  if (!boundary.ok) return boundary;
  const prepared = await ensurePrivateState(root);
  if (!prepared.ok) return prepared;
  const temporary = `${path}.tmp-${randomUUID()}`;
  const content = Buffer.from(`${JSON.stringify(registration, null, 2)}\n`);
  let owned: OwnedBytes | null = null;
  try {
    await mkdir(join(root, '.pappra', 'local', 'code'), {
      recursive: true,
      mode: 0o700,
    });
    const handle = await open(temporary, 'wx', 0o600);
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) {
        throw new Error(
          `Temporary registration is not a regular file: ${temporary}`,
        );
      }
      owned = {
        dev: opened.dev,
        ino: opened.ino,
        expected: content,
      };
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
    }
    await rename(temporary, path);
    return succeeded(path);
  } catch (error) {
    const primaryMessage = `Cannot write code registration ${path}: ${error instanceof Error ? error.message : String(error)}`;
    const cleanup = await removeRegistrationTemporaryIfOwned(
      root,
      temporary,
      excludedRoots,
      owned,
    );
    if (cleanup.residualPath !== null) {
      const reason = cleanup.reason ?? 'unknown_ownership';
      return failed(
        diagnosticCodes.code_prepare_partial,
        `${primaryMessage}; registration temporary was preserved at ${cleanup.residualPath} (${reason}); inspect or remove it after confirming it is not user data.`,
        {
          nextAction: `Inspect preserved registration temporary ${cleanup.residualPath}; no ready registration was claimed and no residual path was deleted.`,
        },
      );
    }
    return failed(diagnosticCodes.code_prepare_partial, primaryMessage, {
      nextAction: 'Inspect permissions; no ready registration was claimed.',
    });
  }
}
