import fs, { type BigIntStats } from 'node:fs';
import path from 'node:path';

function writeAndSync(descriptor: number, content: string | Uint8Array): void {
  fs.writeFileSync(descriptor, content);
  fs.fsyncSync(descriptor);
}

/** Create and sync a new private file. The caller owns any staged recovery. */
export function writeExclusivePrivateFile(
  file: string,
  content: string | Uint8Array,
): void {
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {
    writeAndSync(descriptor, content);
  } finally {
    fs.closeSync(descriptor);
  }
}

function isOwnedTemporary(file: string, owned: BigIntStats): boolean {
  const current = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  return (
    current?.isFile() === true &&
    current.dev === owned.dev &&
    current.ino === owned.ino
  );
}

/**
 * Stage a private file beside its destination and sync before renaming it.
 * A synchronous caller guard can refuse publication. The caller provides the
 * namespace and lock policy needed to make that guard meaningful.
 * A final close or parent sync can fail after the rename has succeeded.
 */
export function replacePrivateFile(
  file: string,
  temporary: string,
  content: string | Uint8Array,
  options: {
    readonly beforePublish?: () => boolean;
    readonly syncParent?: boolean;
  } = {},
): boolean {
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  let owned: BigIntStats | undefined;
  try {
    // Keep the inode alive through publication or cleanup so a recreated entry
    // cannot inherit its identity even after the original pathname is unlinked.
    owned = fs.fstatSync(descriptor, { bigint: true });
    writeAndSync(descriptor, content);
    if (options.beforePublish?.() === false) return false;
    if (!isOwnedTemporary(temporary, owned)) {
      throw new Error(
        `Private temporary file changed before publish: ${temporary}`,
      );
    }
    fs.renameSync(temporary, file);
    owned = undefined;
    if (options.syncParent) {
      const parent = fs.openSync(path.dirname(file), 'r');
      try {
        fs.fsyncSync(parent);
      } finally {
        fs.closeSync(parent);
      }
    }
    return true;
  } finally {
    if (owned !== undefined) {
      try {
        if (isOwnedTemporary(temporary, owned)) fs.unlinkSync(temporary);
      } catch {
        // Preserve the publication result when best-effort cleanup fails.
      }
    }
    fs.closeSync(descriptor);
  }
}
