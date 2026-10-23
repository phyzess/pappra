import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Bounded, read-only access to one explicit regular file.
 *
 * The pathname is observed first so obviously unsafe entries are refused without
 * opening them. The open itself is nonblocking/no-follow on POSIX, so a regular
 * file replaced by a FIFO or symlink between inspection and open cannot block or
 * redirect the read; the descriptor is re-validated afterwards for type and size.
 */
export type BoundedFileFailureCode =
  'path_not_absolute' | 'symlink' | 'not_regular' | 'too_large' | 'unreadable';

export type BoundedFileResult =
  | {
      readonly ok: true;
      readonly bytes: Buffer;
      readonly text: string;
      readonly digest: string;
    }
  | {
      readonly ok: false;
      readonly code: BoundedFileFailureCode;
    };

const digestOf = (bytes: Buffer) =>
  `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

const nonblockingFlag = () =>
  process.platform === 'win32' ? 0 : (fs.constants.O_NONBLOCK ?? 0);

export function readBoundedFile(
  file: string,
  maxBytes: number,
): BoundedFileResult {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Bounded read limit must be a positive integer.');
  }
  if (!path.isAbsolute(file)) {
    return { ok: false, code: 'path_not_absolute' };
  }
  let observed: fs.Stats;
  try {
    observed = fs.lstatSync(file);
  } catch {
    return { ok: false, code: 'unreadable' };
  }
  if (observed.isSymbolicLink()) return { ok: false, code: 'symlink' };
  if (!observed.isFile()) return { ok: false, code: 'not_regular' };
  if (observed.size > maxBytes) return { ok: false, code: 'too_large' };

  const flags =
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | nonblockingFlag();
  let handle: number;
  try {
    handle = fs.openSync(file, flags);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : null;
    return { ok: false, code: code === 'ELOOP' ? 'symlink' : 'unreadable' };
  }
  try {
    const stat = fs.fstatSync(handle);
    if (!stat.isFile()) return { ok: false, code: 'not_regular' };
    if (stat.size > maxBytes) return { ok: false, code: 'too_large' };
    // Read at most the observed size (already bounded); never read until EOF.
    const bytes = Buffer.alloc(stat.size);
    let total = 0;
    while (total < bytes.length) {
      const read = fs.readSync(
        handle,
        bytes,
        total,
        bytes.length - total,
        total,
      );
      if (read === 0) break;
      total += read;
    }
    const content = bytes.subarray(0, total);
    return {
      ok: true,
      bytes: content,
      text: content.toString('utf8'),
      digest: digestOf(content),
    };
  } catch {
    return { ok: false, code: 'unreadable' };
  } finally {
    fs.closeSync(handle);
  }
}
