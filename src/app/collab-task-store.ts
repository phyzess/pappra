import fs from 'node:fs';
import path from 'node:path';
import type { Outcome } from '../schemas/outcome.js';
import {
  assertMessageTaskCurrent,
  openMessageTask,
  type MessageServiceFailure,
  type OpenedMessageTask,
} from './collab-messages.js';
import {
  abortedDir,
  brokenLocksDir,
  ledgerPath,
  lockPath,
} from '../collab/store.js';
import { isPathInside } from '../schemas/paths.js';

/**
 * Task-store namespace proof for state and resource operations.
 *
 * The message namespace validator is authoritative for the domain/tasks/task
 * root, task record and messages directory. This module additionally inspects
 * the nested paths the new routes may read or mutate: the write lock and its
 * transaction files, ledger, aborted/broken-lock directories, the resource
 * domain lock, and neighboring task records used by domain-wide scans. Symlinks
 * and special files in those paths are refused instead of being followed.
 */
export type TaskStoreFailure = MessageServiceFailure;
export type TaskStoreResult<T> = Outcome<T, TaskStoreFailure>;

class UnsafeNestedState extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly nextAction: string,
  ) {
    super(message);
    this.name = 'UnsafeNestedState';
  }
}

function failure(error: UnsafeNestedState): TaskStoreFailure {
  return {
    ok: false,
    code: error.code,
    message: error.message,
    nextAction: error.nextAction,
  };
}

const MISSING = new Set(['ENOENT', 'ENOTDIR']);

function lstatOptional(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : null;
    if (code !== null && MISSING.has(code)) return null;
    throw new UnsafeNestedState(
      'task_state_unreadable',
      `Cannot inspect nested task state: ${file}`,
      'Inspect permissions and the path; nothing was mutated.',
    );
  }
}

function requireRealDirectory(file: string, base: string, code: string): void {
  const stats = lstatOptional(file);
  if (stats === null) return;
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new UnsafeNestedState(
      code,
      `Nested task state is not a real directory: ${file}`,
      'Restore a real directory; Pappra does not follow redirected state.',
    );
  }
  const real = fs.realpathSync(file);
  if (real !== file || !isPathInside(base, real)) {
    throw new UnsafeNestedState(
      code,
      `Nested task state is redirected: ${file}`,
      'Restore the real directory inside its task/domain root.',
    );
  }
}

function requireRealRegularFile(
  file: string,
  base: string,
  code: string,
  maxBytes?: number,
): void {
  const stats = lstatOptional(file);
  if (stats === null) return;
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new UnsafeNestedState(
      code,
      `Nested task state is not a regular file: ${file}`,
      'Restore a regular file; Pappra does not follow redirected state.',
    );
  }
  if (maxBytes !== undefined && stats.size > maxBytes) {
    throw new UnsafeNestedState(
      code,
      `Nested task state exceeds the supported size: ${file}`,
      'Inspect the oversized nested state; nothing was read or mutated.',
    );
  }
  const real = fs.realpathSync(file);
  if (real !== file || !isPathInside(base, real)) {
    throw new UnsafeNestedState(
      code,
      `Nested task state is redirected: ${file}`,
      'Restore the real file inside its task/domain root.',
    );
  }
}

function inspectLockDirectory(taskRoot: string): void {
  const directory = lockPath(taskRoot);
  const stats = lstatOptional(directory);
  if (stats === null) return;
  requireRealDirectory(directory, taskRoot, 'task_lock_unsafe');
  for (const name of fs.readdirSync(directory)) {
    requireRealRegularFile(
      path.join(directory, name),
      taskRoot,
      'task_transaction_unsafe',
      8 * 1024 * 1024,
    );
  }
}

function inspectTaskPrivateState(taskRoot: string): void {
  inspectLockDirectory(taskRoot);
  requireRealDirectory(abortedDir(taskRoot), taskRoot, 'task_aborted_unsafe');
  requireRealDirectory(
    brokenLocksDir(taskRoot),
    taskRoot,
    'task_broken_locks_unsafe',
  );
  requireRealRegularFile(ledgerPath(taskRoot), taskRoot, 'task_ledger_unsafe');
}

function inspectDomainLock(domainRoot: string): void {
  const directory = path.join(domainRoot, '.domain.lock');
  const stats = lstatOptional(directory);
  if (stats === null) return;
  requireRealDirectory(directory, domainRoot, 'domain_lock_unsafe');
  for (const name of fs.readdirSync(directory)) {
    requireRealRegularFile(
      path.join(directory, name),
      domainRoot,
      'domain_lock_unsafe',
      1024 * 1024,
    );
  }
}

/**
 * Validate the neighboring task roots/records read by a domain-wide resource
 * scan. Missing or malformed regular records remain unreadable evidence for the
 * core; a symlinked root or record is a namespace redirect and is refused.
 */
function inspectDomainTasks(domainRoot: string): void {
  const tasksDirectory = path.join(domainRoot, 'tasks');
  let names: string[];
  try {
    names = fs.readdirSync(tasksDirectory).sort();
  } catch {
    throw new UnsafeNestedState(
      'task_state_unreadable',
      `Cannot inspect the domain tasks directory: ${tasksDirectory}`,
      'Inspect permissions; nothing was mutated.',
    );
  }
  for (const name of names) {
    const taskRoot = path.join(tasksDirectory, name);
    const stats = lstatOptional(taskRoot);
    if (stats === null) continue;
    if (stats.isSymbolicLink()) {
      throw new UnsafeNestedState(
        'domain_state_redirected',
        `Neighboring task root is a symlink: ${taskRoot}`,
        'Restore a real task root; Pappra does not follow redirected task state.',
      );
    }
    if (!stats.isDirectory()) continue;
    const realTask = fs.realpathSync(taskRoot);
    if (realTask !== taskRoot || !isPathInside(tasksDirectory, realTask)) {
      throw new UnsafeNestedState(
        'domain_state_redirected',
        `Neighboring task root is redirected: ${taskRoot}`,
        'Restore the real task root inside the domain.',
      );
    }
    const record = path.join(taskRoot, 'task.json');
    const recordStats = lstatOptional(record);
    if (recordStats === null) continue;
    if (recordStats.isSymbolicLink() || !recordStats.isFile()) {
      throw new UnsafeNestedState(
        'domain_state_unsafe',
        `Neighboring task record is not a regular file: ${record}`,
        'Restore a regular task record; redirected state is not scanned.',
      );
    }
    const realRecord = fs.realpathSync(record);
    if (realRecord !== record || !isPathInside(taskRoot, realRecord)) {
      throw new UnsafeNestedState(
        'domain_state_redirected',
        `Neighboring task record is redirected: ${record}`,
        'Restore the real task record inside its task root.',
      );
    }
  }
}

export type OpenedTaskStore = OpenedMessageTask;

export async function openTaskStore(
  taskRoot: string,
): Promise<TaskStoreResult<OpenedTaskStore>> {
  const opened = await openMessageTask(taskRoot);
  if (!opened.ok) return opened;
  try {
    inspectTaskPrivateState(opened.value.taskRoot);
  } catch (error) {
    if (error instanceof UnsafeNestedState) return failure(error);
    return {
      ok: false,
      code: 'task_state_unreadable',
      message: 'Nested task state could not be inspected.',
      nextAction:
        'Inspect the task lock, ledger and transaction paths; nothing was mutated.',
    };
  }
  return opened;
}

/** Revalidate namespace identity and nested state immediately before apply. */
export async function assertTaskStoreCurrent(
  opened: OpenedTaskStore,
): Promise<TaskStoreFailure | null> {
  const changed = await assertMessageTaskCurrent(opened);
  if (changed !== null) return changed;
  try {
    inspectTaskPrivateState(opened.taskRoot);
  } catch (error) {
    if (error instanceof UnsafeNestedState) return failure(error);
    return {
      ok: false,
      code: 'task_state_unreadable',
      message: 'Nested task state could not be inspected.',
      nextAction:
        'Inspect the task lock, ledger and transaction paths; nothing was mutated.',
    };
  }
  return null;
}

/** Domain-wide scan validation for `resource list` and `claim`. */
export function validateDomainTaskState(
  domainRoot: string,
): TaskStoreFailure | null {
  try {
    inspectDomainTasks(domainRoot);
  } catch (error) {
    if (error instanceof UnsafeNestedState) return failure(error);
    return {
      ok: false,
      code: 'task_state_unreadable',
      message: 'The domain task state could not be inspected.',
      nextAction:
        'Inspect the domain tasks directory and records; nothing was mutated.',
    };
  }
  return null;
}

/** Mutation-path validation for `claim` (the domain lock is never followed). */
export function validateDomainMutationPaths(
  domainRoot: string,
): TaskStoreFailure | null {
  try {
    inspectDomainLock(domainRoot);
  } catch (error) {
    if (error instanceof UnsafeNestedState) return failure(error);
    return {
      ok: false,
      code: 'task_state_unreadable',
      message: 'The domain lock path could not be inspected.',
      nextAction: 'Inspect the domain lock directory; nothing was mutated.',
    };
  }
  return null;
}
