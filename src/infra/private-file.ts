import fs, { type Stats } from 'node:fs';
import path from 'node:path';

function writeExclusive(
  file: string,
  content: string | Uint8Array,
  onOpen?: (descriptor: number) => void,
): void {
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {
    onOpen?.(descriptor);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Create and sync a new private file. The caller owns any staged recovery. */
export function writeExclusivePrivateFile(
  file: string,
  content: string | Uint8Array,
): void {
  writeExclusive(file, content);
}

function isOwnedTemporary(file: string, owned: Stats): boolean {
  const current = fs.lstatSync(file, { throwIfNoEntry: false });
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
  let owned: Stats | undefined;
  try {
    writeExclusive(temporary, content, (descriptor) => {
      owned = fs.fstatSync(descriptor);
    });
    if (options.beforePublish?.() === false) return false;
    if (owned === undefined || !isOwnedTemporary(temporary, owned)) {
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
  }
}
