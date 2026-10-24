import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import { sha256Digest } from './fs.js';
import {
  captureProcessIdentity,
  isLocalProcessIdentity,
  observeProcessIdentity,
} from './process-identity.js';

/** Publish only a complete, fsynced lock; a crash cannot expose an empty owner record. */
export async function publishPrivateLock(
  file: string,
  bytes: Buffer,
  revalidate?: () => Promise<void>,
): Promise<void> {
  const temporary = `${file}.pending-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await revalidate?.();
    await link(temporary, file);
    await revalidate?.();
    const published = await lstat(file);
    const staged = await handle.stat();
    if (
      !published.isFile() ||
      published.dev !== staged.dev ||
      published.ino !== staged.ino
    )
      throw new Error(`Published lock identity changed: ${file}`);
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => undefined);
  }
}

export interface PrivateLockObservation {
  readonly file: string;
  readonly state: 'missing' | 'alive' | 'dead' | 'unknown';
  readonly token: string | null;
  readonly digest: string | null;
  readonly identity: { readonly dev: number; readonly ino: number } | null;
}

/** An old PID-only lock is reclaimable only after ESRCH, never by its age. */
export async function inspectPrivateLock(
  file: string,
): Promise<PrivateLockObservation> {
  const empty: PrivateLockObservation = {
    file,
    state: 'unknown',
    token: null,
    digest: null,
    identity: null,
  };
  let handle;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > 64 * 1024) return empty;
    const bytes = Buffer.alloc(64 * 1024 + 1);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead > 64 * 1024) return empty;
    const content = bytes.subarray(0, read.bytesRead);
    let value: unknown;
    try {
      value = JSON.parse(content.toString('utf8'));
    } catch {
      return empty;
    }
    if (
      typeof value !== 'object' ||
      value === null ||
      !('pid' in value) ||
      !('token' in value) ||
      typeof value.pid !== 'number' ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.token !== 'string' ||
      !value.token
    )
      return empty;
    let state: PrivateLockObservation['state'] = 'unknown';
    if ('process_identity' in value && value.process_identity !== undefined) {
      state =
        isLocalProcessIdentity(value.process_identity) &&
        value.process_identity.pid === value.pid
          ? observeProcessIdentity(value.process_identity)
          : 'unknown';
    } else {
      try {
        process.kill(value.pid, 0);
        // PID existence alone cannot bind an imported lock to that process birth.
        state = 'unknown';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') state = 'dead';
      }
    }
    return {
      file,
      state,
      token: value.token,
      digest: sha256Digest(content),
      identity: { dev: stats.dev, ino: stats.ino },
    };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { ...empty, state: 'missing' }
      : empty;
  } finally {
    await handle?.close();
  }
}

function sameLock(
  a: PrivateLockObservation,
  b: PrivateLockObservation,
): boolean {
  return (
    a.state === b.state &&
    a.token === b.token &&
    a.digest === b.digest &&
    a.identity?.dev === b.identity?.dev &&
    a.identity?.ino === b.identity?.ino
  );
}

/** One immutable claim wins a stale owner boundary; interrupted claimants can be succeeded. */
export async function reclaimDeadPrivateLock(
  file: string,
  revalidate: () => Promise<void>,
): Promise<boolean> {
  await revalidate();
  const original = await inspectPrivateLock(file);
  if (original.state === 'missing') return false;
  if (original.state !== 'dead' || original.digest === null)
    throw new Error(`Lock owner is alive or unverified; preserve ${file}`);
  const base = `${file}.reclaim-${original.digest.slice(7)}`;
  let claim = base;
  for (let hop = 0; hop < 64; hop += 1) {
    await revalidate();
    const before = await inspectPrivateLock(file);
    if (before.state === 'missing') return false;
    if (!sameLock(original, before))
      throw new Error(`Lock changed during recovery: ${file}`);
    try {
      await publishPrivateLock(
        claim,
        Buffer.from(
          `${JSON.stringify({ token: randomUUID(), pid: process.pid, process_identity: captureProcessIdentity() ?? undefined })}\n`,
        ),
        revalidate,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = await inspectPrivateLock(claim);
      if (owner.state !== 'dead')
        throw new Error(`Another or unverified repair owns ${file}`);
      claim = `${base}.retry-${sha256Digest(JSON.stringify([owner.digest, owner.identity])).slice(7)}`;
      continue;
    }
    await revalidate();
    if (!sameLock(original, await inspectPrivateLock(file)))
      throw new Error(`Lock changed after recovery reservation: ${file}`);
    await unlink(file);
    return true;
  }
  throw new Error(`Too many interrupted lock repairs; preserve ${file}`);
}
