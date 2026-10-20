import { createHash } from 'node:crypto';
import { open, lstat, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import type { Outcome } from '../schemas/outcome.js';
import { errorMessage, failed, succeeded } from '../schemas/outcome.js';
import { diagnosticCodes } from '../schemas/errors.js';

export const DEFAULT_CONFIG_MAX_BYTES = 1024 * 1024;

export interface BoundedFile {
  readonly bytes: Buffer;
  readonly digest: string;
  readonly size: number;
}

export interface BoundedTextFile extends BoundedFile {
  readonly text: string;
}

export function sha256Digest(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function filesystemFailure(path: string, error: unknown): Outcome<never> {
  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : null;
  if (code === 'ENOENT') {
    return failed(diagnosticCodes.fileNotFound, `File not found: ${path}`, {
      nextAction: 'Create the file or correct the path.',
    });
  }
  return failed(
    diagnosticCodes.fileUnreadable,
    `Cannot read ${path}: ${errorMessage(error)}`,
    { nextAction: 'Check file permissions and the path.' },
  );
}

/**
 * Reads at most `maxBytes + 1` bytes from a regular file. The implementation
 * never loads a larger file into memory just to report that it is too large.
 */
export async function readFileBounded(
  path: string,
  maxBytes = DEFAULT_CONFIG_MAX_BYTES,
): Promise<Outcome<BoundedFile>> {
  // Check the type before opening: opening a FIFO for reading can block until
  // a writer appears. O_NONBLOCK also covers a file replaced after this stat.
  let pathStats;
  try {
    pathStats = await stat(path);
  } catch (error) {
    return filesystemFailure(path, error);
  }
  if (!pathStats.isFile()) {
    return failed(
      diagnosticCodes.fileNotRegular,
      `Not a regular file: ${path}`,
      { nextAction: 'Replace it with a regular file.' },
    );
  }

  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY |
        (process.platform === 'win32' ? 0 : constants.O_NONBLOCK),
    );
  } catch (error) {
    return filesystemFailure(path, error);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return failed(
        diagnosticCodes.fileNotRegular,
        `Not a regular file: ${path}`,
        { nextAction: 'Replace it with a regular file.' },
      );
    }
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        total,
        buffer.length - total,
        null,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) {
      return failed(
        diagnosticCodes.fileTooLarge,
        `File exceeds the ${maxBytes}-byte limit: ${path}`,
        {
          nextAction:
            'Reduce the file size; Pappra does not truncate configuration.',
        },
      );
    }
    const bytes = buffer.subarray(0, total);
    return succeeded({
      bytes,
      digest: sha256Digest(bytes),
      size: total,
    });
  } catch (error) {
    return filesystemFailure(path, error);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readTextFileBounded(
  path: string,
  maxBytes = DEFAULT_CONFIG_MAX_BYTES,
): Promise<Outcome<BoundedTextFile>> {
  const read = await readFileBounded(path, maxBytes);
  if (!read.ok) return read;
  let text: string;
  try {
    text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(read.value.bytes);
  } catch (error) {
    return failed(
      diagnosticCodes.fileInvalidEncoding,
      `File is not valid UTF-8: ${path} (${errorMessage(error)})`,
      { nextAction: 'Re-save the file as UTF-8 without invalid bytes.' },
    );
  }
  return succeeded({ ...read.value, text });
}

export type PathKind = 'missing' | 'file' | 'directory' | 'symlink' | 'other';

export interface PathObservation {
  readonly kind: PathKind;
  readonly path: string;
  readonly stats: Stats | null;
}

/** Observes one path segment without following a final symlink. */
export async function observePath(path: string): Promise<PathObservation> {
  try {
    const stats = await lstat(path);
    const kind: PathKind = stats.isSymbolicLink()
      ? 'symlink'
      : stats.isDirectory()
        ? 'directory'
        : stats.isFile()
          ? 'file'
          : 'other';
    return { kind, path, stats };
  } catch (error) {
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : null;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { kind: 'missing', path, stats: null };
    }
    throw error;
  }
}

export async function resolveRealpath(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}
