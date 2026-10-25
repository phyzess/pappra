import fs from 'node:fs';
import path from 'node:path';
import { readBoundedFile } from '../../infra/bounded-file.js';
import {
  assertMessageTaskCurrent,
  openMessageTask,
  type OpenedMessageTask,
} from '../../collab/persisted-messages.js';
import { digestText, nowIso, readRecord } from '../../collab/store.js';
import { findAttempt } from '../../collab/lifecycle.js';
import type { Attempt, Coordinator, TaskRecord } from '../../collab/types.js';
import type { WorkflowCaller } from '../../schemas/collab-workflow.js';
import { workflowFailure, type WorkflowOutcome } from './types.js';

/**
 * Shared opening, identity and bookkeeping helpers.
 *
 * Every helper here is either read-only or an exclusive-create write of a derived
 * document. Nothing in this module re-implements record authority: the task record stays in
 * `task.json` and is only changed through the existing store transaction.
 */

export const MAX_WORKFLOW_DOCUMENT_BYTES = 1024 * 1024;

export interface OpenedWorkflowTask {
  readonly opened: OpenedMessageTask;
  readonly taskRoot: string;
  readonly record: TaskRecord;
}

export async function openWorkflowTask(
  taskRoot: string,
): Promise<WorkflowOutcome<OpenedWorkflowTask>> {
  const opened = await openMessageTask(taskRoot);
  if (!opened.ok)
    return workflowFailure(opened.code, opened.message, opened.nextAction);
  return {
    ok: true,
    value: {
      opened: opened.value,
      taskRoot: opened.value.taskRoot,
      record: opened.value.record,
    },
  };
}

/** Revalidate the namespace immediately before a mutation in the same call. */
export async function revalidateWorkflowTask(
  task: OpenedWorkflowTask,
): Promise<WorkflowOutcome<null>> {
  const changed = await assertMessageTaskCurrent(task.opened);
  if (changed !== null)
    return workflowFailure(changed.code, changed.message, changed.nextAction);
  // Re-read the record: a long call may have yielded to another writer.
  const current = readRecord(task.taskRoot);
  if (current === null)
    return workflowFailure(
      'task_record_missing',
      'The task record disappeared during the call.',
      'Inspect the task root before retrying; nothing was written.',
    );
  return { ok: true, value: null };
}

/**
 * One bounded, no-follow read that keeps both the parsed document and the digest of the
 * exact bytes it came from. The wire pin is that byte digest; the parsed document is only
 * useful for structural checks, so a caller never re-reads to recompute the pin.
 */
export function readBoundedDocument(
  file: string,
  label: string,
): WorkflowOutcome<{ readonly value: unknown; readonly digest: string }> {
  if (!path.isAbsolute(file))
    return workflowFailure(
      'path_not_absolute',
      `${label} must be an absolute path: ${file}`,
      'Pass an absolute path; relative paths are refused.',
    );
  const read = readBoundedFile(file, MAX_WORKFLOW_DOCUMENT_BYTES);
  if (!read.ok) {
    switch (read.code) {
      case 'symlink':
        return workflowFailure(
          'file_symlink',
          `${label} must be a regular file, not a symlink: ${file}`,
          'Point at the real file; links are never followed.',
        );
      case 'too_large':
        return workflowFailure(
          'file_too_large',
          `${label} exceeds ${MAX_WORKFLOW_DOCUMENT_BYTES} bytes.`,
          'Send one bounded document per invocation.',
        );
      case 'not_regular':
        return workflowFailure(
          'file_not_regular',
          `${label} is not a regular file: ${file}`,
        );
      case 'path_not_absolute':
        return workflowFailure(
          'path_not_absolute',
          `${label} must be an absolute path: ${file}`,
        );
      default:
        return workflowFailure(
          'file_unreadable',
          `Cannot read ${label}: ${file}`,
          'Check permissions; nothing was written.',
        );
    }
  }
  try {
    return {
      ok: true,
      value: { value: JSON.parse(read.text) as unknown, digest: read.digest },
    };
  } catch {
    return workflowFailure(
      'file_invalid_json',
      `${label} is not valid JSON: ${file}`,
    );
  }
}

export function readBoundedJson(
  file: string,
  label: string,
): WorkflowOutcome<unknown> {
  const read = readBoundedDocument(file, label);
  return read.ok ? { ok: true, value: read.value.value } : read;
}

export type ExclusiveWrite =
  | { readonly status: 'created'; readonly digest: string }
  | { readonly status: 'identical'; readonly digest: string }
  | {
      readonly status: 'conflict';
      readonly existing: string;
      readonly derived: string;
    }
  | { readonly status: 'unsafe'; readonly detail: string };

/**
 * Reject a redirected ancestor chain before any workflow write.
 *
 * Checking only the leaf is insufficient: a symlinked `workflow` parent, `tasks` parent or
 * task root moves every derived document somewhere else. Every component from the trusted
 * root down to the target's parent must be a real directory.
 */
export function assertRealChain(root: string, target: string): string | null {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    return 'target_outside_root';
  let current = root;
  const parts = relative.split(path.sep).filter((part) => part.length > 0);
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return 'ancestor_unreadable';
    }
    if (stat.isSymbolicLink()) return `ancestor_symlink:${current}`;
    if (!stat.isDirectory()) return `ancestor_not_directory:${current}`;
  }
  const leaf = path.join(root, ...parts);
  try {
    const stat = fs.lstatSync(leaf);
    if (stat.isSymbolicLink()) return `leaf_symlink:${leaf}`;
    if (!stat.isFile()) return `leaf_not_regular:${leaf}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return 'leaf_unreadable';
  }
  return null;
}

/**
 * Write one derived document exactly once.
 *
 * The file is created with `wx`, so two concurrent prepares cannot both seal it. A rerun
 * whose derived bytes differ is a conflict, never a rewrite: sealed input stays sealed and
 * the caller reconciles instead of silently changing what peers were given. The read side
 * goes through the shared bounded/no-follow reader so a special entry is never slurped.
 */
export function writeJsonExclusive(
  root: string,
  file: string,
  value: unknown,
): ExclusiveWrite {
  const before = assertRealChain(root, file);
  if (before !== null) return { status: 'unsafe', detail: before };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Re-check after creating parents: a concurrent swap must not redirect the write.
  const after = assertRealChain(root, file);
  if (after !== null) return { status: 'unsafe', detail: after };
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const derived = digestText(bytes);
  try {
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    return { status: 'created', digest: derived };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
      return {
        status: 'unsafe',
        detail: (error as NodeJS.ErrnoException).code ?? 'write_failed',
      };
  }
  const read = readBoundedFile(file, MAX_WORKFLOW_DOCUMENT_BYTES);
  if (!read.ok)
    return {
      status: 'unsafe',
      detail: read.code === 'symlink' ? 'leaf_symlink' : read.code,
    };
  const existing = digestText(read.text);
  return existing === derived
    ? { status: 'identical', digest: derived }
    : { status: 'conflict', existing, derived };
}

/**
 * Digest of one regular file's exact bytes, through the shared bounded/no-follow reader.
 * A symlink, special file, oversized document or unreadable path yields null instead of an
 * unbounded `readFileSync` that could block on a FIFO or slurp an arbitrarily large file.
 */
export function digestFile(file: string): string | null {
  const read = readBoundedFile(file, MAX_WORKFLOW_DOCUMENT_BYTES);
  return read.ok ? read.digest : null;
}

export function sameIdentity(
  left: {
    readonly agent_id?: unknown;
    readonly session_id?: unknown;
    readonly harness?: unknown;
  },
  right: WorkflowCaller,
): boolean {
  return (
    left.agent_id === right.agent_id &&
    left.session_id === right.session_id &&
    (left.harness === undefined ||
      left.harness === null ||
      left.harness === right.harness)
  );
}

export function sameCoordinator(
  coordinator: Coordinator | null,
  caller: WorkflowCaller,
): boolean {
  if (coordinator === null) return false;
  return (
    coordinator.agent_id === caller.agent_id &&
    coordinator.session_id === caller.session_id &&
    (coordinator.harness === undefined ||
      coordinator.harness === null ||
      coordinator.harness === caller.harness)
  );
}

export function resolveAttempt(
  record: TaskRecord,
  subtaskId: string,
  attempt: number,
): Attempt | null {
  return findAttempt(record, subtaskId, attempt);
}

export function describeIdentity(identity: {
  readonly agent_id?: unknown;
  readonly session_id?: unknown;
}): string {
  return `${String(identity.agent_id ?? 'unknown')}/${String(identity.session_id ?? 'unknown')}`;
}

/** `input_revision` bookkeeping is derived input, not a second task authority. */
export function inputRevisionOf(record: TaskRecord): string | null {
  return record.input_revision ?? null;
}

export function stamp(clock = Date.now()): string {
  return nowIso(clock);
}
