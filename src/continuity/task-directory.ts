import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmdirSync,
  type Stats,
} from 'node:fs';
import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

interface DirectoryPin {
  readonly path: string;
  readonly fd: number;
  readonly stats: Stats;
}

/** Invocation-local evidence only; an existing directory is never owned. */
export class CheckpointTaskDirectory {
  readonly #pins: DirectoryPin[] = [];
  #created = false;
  #prepared = false;

  constructor(
    readonly root: string,
    readonly path: string,
  ) {}

  prepare(beforeTaskCreate?: () => void): void {
    // Capture each newly created inode before yielding to another JS caller.
    // Keep its descriptor open until finalization to prevent inode reuse.
    for (const path of [
      this.root,
      join(this.root, '.pappra'),
      join(this.root, '.pappra', 'local'),
      dirname(this.path),
      this.path,
    ]) {
      this.assertCurrent();
      if (path === dirname(this.path) || path === this.path) {
        if (path === this.path) beforeTaskCreate?.();
        try {
          // No recursive mkdir: success proves this call created the leaf.
          mkdirSync(path, { mode: 0o700 });
          if (path === this.path) this.#created = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      const observed = lstatSync(path);
      if (!observed.isDirectory())
        throw new Error(`Not a real directory: ${path}`);
      const fd = openSync(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      let stats: Stats;
      try {
        stats = fstatSync(fd);
      } catch (error) {
        closeSync(fd);
        throw error;
      }
      this.#pins.push({ path, fd, stats });
      if (observed.dev !== stats.dev || observed.ino !== stats.ino)
        throw new Error(`Directory changed while capturing identity: ${path}`);
      this.assertCurrent();
    }
    this.#prepared = true;
  }

  assertCurrent(): void {
    for (const pin of this.#pins) {
      const current = lstatSync(pin.path);
      if (
        !current.isDirectory() ||
        current.dev !== pin.stats.dev ||
        current.ino !== pin.stats.ino
      )
        throw new Error(`Checkpoint task namespace changed: ${pin.path}`);
    }
  }

  removeIfOwnedAndEmpty(): void {
    if (!this.#created || !this.#prepared) return;
    this.assertCurrent();
    // rmdir itself checks emptiness atomically; never recursively remove state.
    // No JS callback can run between this validation and rmdirSync. Node has no
    // identity-conditional rmdir: namespace checks are still cooperative,
    // not a filesystem fence against a rename between the check and syscall.
    rmdirSync(this.path);
  }

  close(): void {
    for (const pin of this.#pins) {
      try {
        closeSync(pin.fd);
      } catch {
        /* Retain the original save result. */
      }
    }
  }
}

/** Only ENOENT proves absence; unreadable state is conservatively residual. */
export async function checkpointResidualPaths(
  paths: readonly string[],
): Promise<string[]> {
  const residual: string[] = [];
  for (const path of new Set(paths)) {
    try {
      await lstat(path);
      residual.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        residual.push(path);
    }
  }
  return residual;
}
