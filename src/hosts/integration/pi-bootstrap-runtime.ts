/**
 * Concrete local task-record reader + opt-in bootstrap-guard registration (one rollover prerequisite).
 *
 * This supplies the accepted successor bootstrap guard (`pi-bootstrap-guard.ts`) with a real, bounded,
 * read-only task-record dependency and wires the actual `tool_call` gate. It is NOT old-writer stop, a
 * transfer executor, automatic rollover, or an installation; it changes no accepted guard/core/host code.
 *
 * Reader contract (fail-closed): it reads ONLY `<domainRoot>/tasks/<taskId>/task.json` for an explicit,
 * trusted, CANONICAL absolute domain root (rejected at registration if a symlink prefix means
 * `realpathSync(root) !== root`) and a short safe task id. The three ancestor directories (domain root,
 * `tasks`, task root) are pinned by device/inode once and re-checked by no-follow `lstat` both BEFORE and
 * AFTER the bounded read, so a replaced/redirected/symlinked ancestor during the read interval denies the
 * call instead of silently rebinding; it never creates directories (it does NOT use
 * `resolveDomainRoot`/`taskRootFor`, which `mkdir`) and never resolves from cwd or a cache. The record is
 * read via `src/infra/bounded-file.ts` (`readBoundedFile`): a bounded (8 MiB), regular-file,
 * no-follow, non-blocking descriptor read refusing symlink/FIFO/device/directory targets and oversized
 * content. The record file's observable identity and change metadata (inode, size, mtime, ctime) are
 * captured before and after the read; a replacement or in-place change during the read is resolved with a
 * strictly bounded coherent retry (the record inode is never pinned forever, so normal atomic store updates
 * between calls are supported). Only a stable, coherent read is parsed, schema-validated (`isTaskRecord`)
 * and identity-checked: `task_id`, `domain_id` (= `domainIdOf(domainRoot)`), `domain_root` and `task_root`
 * must all equal the selected canonical root. An in-memory revision/digest floor rejects a lower
 * `state_revision` (rollback) or different bytes at the same revision, and is NOT reset by a failed read
 * (same revision + same bytes is repeatable). Any violation/read-failure/malformed result throws, which the
 * guard turns into an explicit block; a fresh parsed object is returned and the floor/pinned identities are
 * primitives, immune to outward mutation.
 *
 * Boundaries (explicit): rollback detection is for THIS runtime only — not durable restart fencing, and not
 * authentication against arbitrary user-owned filesystem changes (explicit local-root trust boundary). The
 * reader detects a change DURING its own read; there is still an UNAVOIDABLE check/use interval AFTER
 * `read()` returns, before the tool actually runs. There is no filesystem lock, atomic global snapshot, OS
 * write fence, native-stop proof, old-writer stop, transfer executor, automatic rollover, or installation
 * here. No writes, locks, sidecars, watchers, timers, process/model/network/transcript calls, new authority
 * store, or automatic recovery. The imported guard/store/validation APIs are read-only dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readBoundedFile } from '../../infra/bounded-file.js';
import { RECORD_FILE, domainIdOf } from '../../collab/store.js';
import type { TaskRecord } from '../../collab/types.js';
import { isTaskRecord } from '../../collab/validation.js';
import {
  registerPiBootstrapGuard,
  type BootstrapGuardOptions,
  type PiBootstrapGuard,
  type PiBootstrapGuardHost,
} from './pi-bootstrap-guard.js';

const TASKS_DIRNAME = 'tasks';
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_READ_ATTEMPTS = 8;
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The accepted guard's pinned configuration, minus the reader this slice supplies. */
export type BootstrapGuardPinned = Omit<BootstrapGuardOptions, 'readRecord'>;

export interface BootstrapRuntimeConfig {
  /** Canonical, existing, absolute domain root (trusted host integration; never model-supplied). */
  readonly domainRoot: string;
  /** Exact short task id; must equal the guard's `taskId`. */
  readonly taskId: string;
  /** The accepted guard's pinned configuration (no caller reader override). */
  readonly guard: BootstrapGuardPinned;
}

/** The bounded local reader. `read()` returns the current validated record or throws (fail-closed). */
export interface LocalTaskRecordReader {
  read(): TaskRecord;
}

interface DirIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface FileObservation {
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

function pinDirectory(dir: string): DirIdentity {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    throw new Error(
      `pi-bootstrap-runtime: required directory is missing: ${dir}`,
    );
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(
      `pi-bootstrap-runtime: path is not a real directory: ${dir}`,
    );
  return { dev: stat.dev, ino: stat.ino };
}

function recheckDirectory(dir: string, pinned: DirIdentity): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    throw new Error(`pi-bootstrap-runtime: directory disappeared: ${dir}`);
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.dev !== pinned.dev ||
    stat.ino !== pinned.ino
  )
    throw new Error(
      `pi-bootstrap-runtime: directory identity changed (redirect): ${dir}`,
    );
}

function sameObservation(a: FileObservation, b: FileObservation): boolean {
  return (
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

class BoundedLocalReader implements LocalTaskRecordReader {
  readonly #domainRoot: string;
  readonly #taskId: string;
  readonly #tasksDir: string;
  readonly #taskRoot: string;
  readonly #recordPath: string;
  readonly #expectedDomainId: string;
  readonly #domainIdentity: DirIdentity;
  readonly #tasksIdentity: DirIdentity;
  readonly #taskIdentity: DirIdentity;

  #floorRevision: number | null = null;
  #floorDigest: string | null = null;

  constructor(domainRoot: string, taskId: string) {
    if (typeof domainRoot !== 'string' || !path.isAbsolute(domainRoot))
      throw new RangeError(
        'pi-bootstrap-runtime: domain root must be an absolute path',
      );
    if (typeof taskId !== 'string' || !SAFE_TASK_ID.test(taskId))
      throw new RangeError(
        'pi-bootstrap-runtime: task id must be a short safe identifier',
      );
    // Require a canonical root: a symlink anywhere in the prefix makes realpath differ from the input.
    let canonical: string;
    try {
      canonical = fs.realpathSync(domainRoot);
    } catch {
      throw new Error(
        `pi-bootstrap-runtime: domain root does not exist: ${domainRoot}`,
      );
    }
    if (canonical !== domainRoot)
      throw new RangeError(
        'pi-bootstrap-runtime: domain root must be canonical (no symlink prefix or alias)',
      );
    this.#domainRoot = domainRoot;
    this.#taskId = taskId;
    this.#tasksDir = path.join(domainRoot, TASKS_DIRNAME);
    this.#taskRoot = path.join(this.#tasksDir, taskId);
    this.#recordPath = path.join(this.#taskRoot, RECORD_FILE);
    this.#expectedDomainId = domainIdOf(domainRoot);
    // Require existing directories and pin their identities once; never create them.
    this.#domainIdentity = pinDirectory(this.#domainRoot);
    this.#tasksIdentity = pinDirectory(this.#tasksDir);
    this.#taskIdentity = pinDirectory(this.#taskRoot);
  }

  #recheckAncestors(): void {
    recheckDirectory(this.#domainRoot, this.#domainIdentity);
    recheckDirectory(this.#tasksDir, this.#tasksIdentity);
    recheckDirectory(this.#taskRoot, this.#taskIdentity);
  }

  #observeRecordFile(): FileObservation | null {
    try {
      const stat = fs.lstatSync(this.#recordPath);
      if (stat.isSymbolicLink() || !stat.isFile()) return null;
      return {
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      };
    } catch {
      return null;
    }
  }

  read(): TaskRecord {
    let lastReason = 'record unstable during read';
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
      // Pinned ancestors must still be the same real directories before the read.
      this.#recheckAncestors();
      const before = this.#observeRecordFile();
      const result = readBoundedFile(this.#recordPath, MAX_RECORD_BYTES);
      if (!result.ok)
        throw new Error(
          `pi-bootstrap-runtime: record read failed (${result.code})`,
        );
      const after = this.#observeRecordFile();
      // A pinned ancestor replaced DURING the read interval denies this call (namespace redirect).
      this.#recheckAncestors();
      // The record file replaced or changed in place during the read interval: bounded coherent retry.
      if (
        before === null ||
        after === null ||
        !sameObservation(before, after)
      ) {
        lastReason = 'record changed during read';
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(result.text);
      } catch {
        throw new Error('pi-bootstrap-runtime: record is not valid JSON');
      }
      if (!isTaskRecord(parsed))
        throw new Error(
          'pi-bootstrap-runtime: record failed schema validation',
        );
      const record: TaskRecord = parsed;
      // Complete task-domain identity against the selected canonical root (not just derived domain_id).
      if (record.task_id !== this.#taskId)
        throw new Error('pi-bootstrap-runtime: record task id mismatch');
      if (record.domain_id !== this.#expectedDomainId)
        throw new Error(
          'pi-bootstrap-runtime: record domain id does not derive from the selected root',
        );
      if (record.domain_root !== this.#domainRoot)
        throw new Error(
          'pi-bootstrap-runtime: record domain_root does not match the selected root',
        );
      if (record.task_root !== this.#taskRoot)
        throw new Error(
          'pi-bootstrap-runtime: record task_root does not match the selected task',
        );

      const revision = record.state_revision;
      if (
        typeof revision !== 'number' ||
        !Number.isSafeInteger(revision) ||
        revision < 0
      )
        throw new Error(
          'pi-bootstrap-runtime: record has an invalid state_revision',
        );
      const digest = result.digest;
      if (this.#floorRevision !== null) {
        if (revision < this.#floorRevision)
          throw new Error(
            'pi-bootstrap-runtime: record state_revision rolled back',
          );
        if (revision === this.#floorRevision && digest !== this.#floorDigest)
          throw new Error(
            'pi-bootstrap-runtime: record bytes changed at the same state_revision',
          );
      }
      // Advance the floor only after a stable, coherent, validated read; a failure never resets it.
      if (this.#floorRevision === null || revision > this.#floorRevision) {
        this.#floorRevision = revision;
        this.#floorDigest = digest;
      }
      // Fresh parsed data; the floor and pinned identities are primitives, immune to outward mutation.
      return record;
    }
    throw new Error(
      `pi-bootstrap-runtime: ${lastReason} after ${MAX_READ_ATTEMPTS} attempts`,
    );
  }
}

/**
 * Build the bounded local reader for an explicit canonical domain root + task id. Requires existing
 * directories; never creates any. Exposed for focused testing and reuse.
 */
export function createLocalTaskRecordReader(
  domainRoot: string,
  taskId: string,
): LocalTaskRecordReader {
  return new BoundedLocalReader(domainRoot, taskId);
}

/**
 * Register the opt-in successor bootstrap gate wired to the concrete local reader. Configuration is
 * trusted host integration (never model input); the reader is built here (no caller-reader override). The
 * `tool_call` gate is registered synchronously before any model work. Returns the guard's conservative
 * status handle only — no allow/release surface.
 */
export function registerPiBootstrapRuntime(
  pi: PiBootstrapGuardHost,
  config: BootstrapRuntimeConfig,
): PiBootstrapGuard {
  if (typeof config !== 'object' || config === null)
    throw new RangeError('pi-bootstrap-runtime: configuration is required');
  if (config.taskId !== config.guard.taskId)
    throw new RangeError(
      'pi-bootstrap-runtime: runtime task id must equal the guard task id',
    );
  const reader = createLocalTaskRecordReader(config.domainRoot, config.taskId);
  // registerPiBootstrapGuard copies/validates the pinned config; the reader is supplied here, not by a
  // caller, and a reader throw/malformed result becomes the guard's explicit block.
  return registerPiBootstrapGuard(pi, {
    ...config.guard,
    readRecord: () => reader.read(),
  });
}
