import fs from 'node:fs';
import path from 'node:path';
import { object as isRecord } from '../../infra/validation.js';
import { isPathInside } from '../../schemas/paths.js';
import { collabBindingSchema } from '../../schemas/collaboration.js';
import type {
  Identity,
  LaunchReservation,
  TaskRecord,
} from '../../collab/types.js';
import { verifyManagedPiSdkInstallation } from '../../hosts/pi/managed-sdk-session.js';
import { readBoundedFile } from '../bounded-file.js';
import {
  loadVisibleBootstrapRequest,
  type LoadedVisibleBootstrapRequest,
} from '../collab-bootstrap.js';
import {
  openMessageTask,
  readRegisteredMessageSafe,
  type RegisteredMessage,
} from '../collab-messages.js';
import { assertTaskStoreCurrent, openTaskStore } from '../collab-task-store.js';
import {
  immutableDigest,
  type LoadedSessionTransitionRequest,
  type SessionTransitionRequest,
} from '../collab-session-transition-request.js';
import {
  digestText,
  safePathEqual,
  sameIdentity,
} from '../collab-session-transition-validation.js';
import type { TransitionContext, TransitionFailure } from './types.js';

export function failure(
  kind: TransitionFailure['kind'],
  code: string,
  message: string,
  nextAction: string | null,
): TransitionFailure {
  return { ok: false, kind, code, message, nextAction };
}

export function sameHarnessIdentity(
  left: Identity | null | undefined,
  right: Identity,
): boolean {
  if (!sameIdentity(left, right)) return false;
  // Task claim/assignee records may omit optional harness/cwd fields; compare them exactly when present.
  if (
    left?.harness !== undefined &&
    left.harness !== null &&
    left.harness !== right.harness
  )
    return false;
  if (
    left?.cwd !== undefined &&
    right.cwd !== undefined &&
    left.cwd !== right.cwd
  )
    return false;
  return true;
}

export function nowIso(clock: () => number): string {
  return new Date(clock()).toISOString();
}

export function requestOf(
  value: LoadedSessionTransitionRequest | SessionTransitionRequest,
): SessionTransitionRequest {
  return 'request' in value ? value.request : value;
}

export function immutableDigestOf(
  value: LoadedSessionTransitionRequest | SessionTransitionRequest,
): string {
  return 'immutable_digest' in value
    ? value.immutable_digest
    : immutableDigest(value);
}
export async function loadContext(
  input: LoadedSessionTransitionRequest | SessionTransitionRequest,
): Promise<
  { readonly ok: true; readonly value: TransitionContext } | TransitionFailure
> {
  const request = requestOf(input);
  const requestDigest = immutableDigestOf(input);
  const task = await openTaskStore(request.task_root);
  if (!task.ok)
    return failure('needs_input', task.code, task.message, task.nextAction);
  if (!safePathEqual(task.value.taskRoot, request.task_root))
    return failure(
      'invalid',
      'task_root_mismatch',
      'Request task_root is not the canonical task root.',
      'Use the canonical task root.',
    );
  const loadedBootstrap = loadVisibleBootstrapRequest(
    request.bootstrap_request.ref,
  );
  if (!loadedBootstrap.ok)
    return failure(
      'invalid',
      loadedBootstrap.code,
      loadedBootstrap.message,
      null,
    );
  if (loadedBootstrap.value.digest !== request.bootstrap_request.digest)
    return failure(
      'invalid',
      'bootstrap_request_digest_mismatch',
      'The pinned bootstrap request digest changed.',
      null,
    );
  if (loadedBootstrap.value.request.managed_runtime) {
    try {
      verifyManagedPiSdkInstallation(
        loadedBootstrap.value.request.managed_runtime.sdk_module_path,
      );
    } catch {
      return failure(
        'needs_input',
        'successor_sdk_incompatible',
        'The successor SDK is unavailable or incompatible; no source freeze was attempted.',
        'Select a supported SDK installation and re-plan before freezing the source.',
      );
    }
  }
  const messageTask = await openMessageTask(task.value.taskRoot);
  if (!messageTask.ok)
    return failure(
      'needs_input',
      messageTask.code,
      messageTask.message,
      messageTask.nextAction,
    );
  const contact = await readRegisteredMessageSafe(
    messageTask.value,
    loadedBootstrap.value.request.message_pointer.message_id,
  );
  if (!contact.ok)
    return failure(
      'needs_input',
      contact.code,
      contact.message,
      contact.nextAction,
    );
  const transitionCheck = validateBootstrapTransition(
    request,
    loadedBootstrap.value,
    contact.value,
    task.value.record,
  );
  if (transitionCheck !== null) return transitionCheck;
  const changed = await assertTaskStoreCurrent(task.value);
  if (changed !== null)
    return failure(
      'needs_input',
      changed.code,
      changed.message,
      changed.nextAction,
    );
  return {
    ok: true,
    value: {
      request,
      requestDigest,
      task: task.value,
      bootstrap: loadedBootstrap.value,
      contactMessage: contact.value,
    },
  };
}
export function validateBootstrapTransition(
  request: SessionTransitionRequest,
  bootstrap: LoadedVisibleBootstrapRequest,
  contact: RegisteredMessage,
  record: TaskRecord,
): TransitionFailure | null {
  const next = bootstrap.request;
  if (
    !safePathEqual(next.task_root, request.task_root) ||
    next.target.choice !== 'sibling' ||
    next.participant.agent_id !== request.intent.to.agent_id ||
    next.participant.native_session_selector !== request.intent.to.session_id ||
    next.participant.harness !== request.intent.to.harness ||
    next.target.cwd !== request.intent.to.cwd ||
    next.admission.subtask_id !== request.intent.subtask_id ||
    next.admission.attempt !== request.intent.attempt ||
    next.admission.input_revision !== request.intent.input_revision ||
    next.binding_ref === undefined
  )
    return failure(
      'invalid',
      'bootstrap_transition_mismatch',
      'Successor bootstrap identity, attempt, cwd or binding does not match the transition.',
      null,
    );
  const bindingFile = readTaskLocalFile(
    next.binding_ref,
    record.task_root,
    64 * 1024,
  );
  if (!bindingFile.ok)
    return failure(
      'needs_input',
      'bootstrap_binding_unavailable',
      'The exact source routing binding is missing, unreadable or outside the task root.',
      'Provide one bounded task-local pappra/collab-binding/1 file; no focus-based fallback is allowed.',
    );
  let bindingValue: unknown;
  try {
    bindingValue = JSON.parse(bindingFile.bytes.toString('utf8')) as unknown;
  } catch {
    return failure(
      'invalid',
      'bootstrap_binding_invalid',
      'The source routing binding is not valid JSON.',
      null,
    );
  }
  const binding = collabBindingSchema.safeParse(bindingValue);
  if (
    !binding.success ||
    binding.data.task_id !== record.task_id ||
    !safePathEqual(binding.data.task_root, record.task_root)
  )
    return failure(
      'needs_input',
      'bootstrap_binding_invalid',
      'The source routing binding schema or task identity does not match.',
      'Reconcile the task-local binding before transition.',
    );
  const sourceParticipants = binding.data.participants.filter(
    (participant) => participant.agent_id === request.intent.from.agent_id,
  );
  if (
    sourceParticipants.length !== 1 ||
    sourceParticipants[0]!.harness !== request.intent.from.harness ||
    sourceParticipants[0]!.native_session_id !==
      request.intent.from.session_id ||
    !safePathEqual(sourceParticipants[0]!.cwd, request.intent.from.cwd ?? '') ||
    (next.caller.pane_id !== null &&
      sourceParticipants[0]!.pane_id !== next.caller.pane_id) ||
    binding.data.participants.some(
      (participant) => participant.agent_id === request.intent.to.agent_id,
    )
  )
    return failure(
      'needs_input',
      'bootstrap_source_binding_mismatch',
      'The task-local binding does not uniquely identify the pinned caller or already contains the sibling successor.',
      'Reconcile the exact source/successor binding; no focus or silent reuse fallback is allowed.',
    );
  const message = contact.message;
  if (
    contact.digest !== next.message_pointer.content_digest ||
    contact.file !== next.message_pointer.content_ref ||
    !parseRegisteredMessageEntry(record, contact)
  )
    return failure(
      'needs_input',
      'bootstrap_pointer_not_registered',
      'Bootstrap pointer is not the exact registered message file/content.',
      'Register and apply a task-local transition status pointer before launching the successor.',
    );
  if (
    message.type !== 'STATUS' ||
    message.task_id !== record.task_id ||
    message.subtask_id !== request.intent.subtask_id ||
    message.attempt !== request.intent.attempt ||
    message.owner_epoch !== request.intent.coordinator_epoch ||
    !sameHarnessIdentity(message.from, request.intent.from) ||
    !sameHarnessIdentity(message.to, request.intent.to) ||
    message.body?.['handoff_id'] !== request.intent.handoff_id ||
    message.body?.['rollover_intent_id'] !== request.intent.intent_id ||
    message.body?.['rollover_generation'] !== request.intent.generation ||
    message.body?.['input_revision'] !== request.intent.input_revision
  )
    return failure(
      'needs_input',
      'bootstrap_pointer_correlation_mismatch',
      'Registered STATUS pointer does not correlate to the exact transition.',
      'Register a STATUS pointer with matching identities, handoff, generation and input.',
    );
  return null;
}
export function parseRegisteredMessageEntry(
  record: TaskRecord,
  registered: RegisteredMessage,
): boolean {
  return (record.messages ?? []).some(
    (entry) =>
      entry.message_id === registered.message.message_id &&
      entry.content_digest === registered.message.content_digest &&
      ['applied', 'recorded'].includes(entry.state),
  );
}
export interface TaskLocalFileRead {
  readonly ok: true;
  readonly bytes: Buffer;
  readonly digest: string;
  readonly file: string;
}

export type TaskLocalFileReadResult =
  TaskLocalFileRead | { readonly ok: false; readonly code: string };

export function ensureTaskLocalDirectory(
  taskRoot: string,
  directory: string,
  create: boolean,
):
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly code: string } {
  try {
    const root = fs.realpathSync(taskRoot);
    if (root !== path.resolve(taskRoot) || !isPathInside(root, directory))
      return { ok: false, code: 'artifact_path_escape' };
    let current = root;
    const relative = path.relative(root, directory);
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        const stat = fs.lstatSync(current);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          fs.realpathSync(current) !== current
        )
          return { ok: false, code: 'artifact_directory_unsafe' };
      } catch (error) {
        const code = isRecord(error) ? error['code'] : null;
        if (code !== 'ENOENT' || !create)
          return {
            ok: false,
            code:
              code === 'ENOENT'
                ? 'artifact_missing'
                : 'artifact_directory_unavailable',
          };
        fs.mkdirSync(current, { mode: 0o700 });
        const stat = fs.lstatSync(current);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          fs.realpathSync(current) !== current
        )
          return { ok: false, code: 'artifact_directory_unsafe' };
      }
    }
    return { ok: true, root };
  } catch {
    return { ok: false, code: 'artifact_directory_unavailable' };
  }
}

export function readTaskLocalFile(
  file: string,
  taskRoot: string,
  maxBytes: number,
): TaskLocalFileReadResult {
  if (!path.isAbsolute(file) || path.resolve(file) !== file)
    return { ok: false, code: 'artifact_path_invalid' };
  const directory = path.dirname(file);
  const safeDirectory = ensureTaskLocalDirectory(taskRoot, directory, false);
  if (!safeDirectory.ok)
    return safeDirectory.code === 'artifact_missing'
      ? { ok: false, code: 'missing' }
      : { ok: false, code: safeDirectory.code };
  try {
    const stat = fs.lstatSync(file);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      fs.realpathSync(file) !== file
    )
      return { ok: false, code: 'artifact_file_unsafe' };
  } catch (error) {
    const code = isRecord(error) ? error['code'] : null;
    return {
      ok: false,
      code: code === 'ENOENT' ? 'missing' : 'artifact_unreadable',
    };
  }
  const read = readBoundedFile(file, maxBytes);
  if (!read.ok) return { ok: false, code: `artifact_${read.code}` };
  try {
    if (!isPathInside(safeDirectory.root, fs.realpathSync(file)))
      return { ok: false, code: 'artifact_path_escape' };
  } catch {
    return { ok: false, code: 'artifact_unreadable' };
  }
  return { ok: true, bytes: read.bytes, digest: read.digest, file };
}

export function writeTaskLocalExclusive(
  file: string,
  taskRoot: string,
  bytes: Buffer,
  maxBytes: number,
):
  | { readonly ok: true; readonly digest: string }
  | { readonly ok: false; readonly code: string } {
  if (bytes.length > maxBytes) return { ok: false, code: 'artifact_too_large' };
  const expectedDigest = digestText(bytes);
  const prior = readTaskLocalFile(file, taskRoot, maxBytes);
  if (prior.ok)
    return prior.bytes.equals(bytes)
      ? { ok: true, digest: prior.digest }
      : { ok: false, code: 'artifact_conflict' };
  if (prior.code !== 'missing') return { ok: false, code: prior.code };
  const directory = ensureTaskLocalDirectory(
    taskRoot,
    path.dirname(file),
    true,
  );
  if (!directory.ok) return { ok: false, code: directory.code };
  let fd: number | null = null;
  try {
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    fd = fs.openSync(
      file,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        noFollow,
      0o600,
    );
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(
        fd,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (written <= 0) throw new Error('short_write');
      offset += written;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    const directoryFd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* Preserve the original write outcome. */
      }
    }
    const code = isRecord(error) ? error['code'] : null;
    if (code === 'EEXIST') {
      const raced = readTaskLocalFile(file, taskRoot, maxBytes);
      return raced.ok && raced.bytes.equals(bytes)
        ? { ok: true, digest: raced.digest }
        : { ok: false, code: raced.ok ? 'artifact_conflict' : raced.code };
    }
    return { ok: false, code: 'artifact_write_unknown' };
  }
  const written = readTaskLocalFile(file, taskRoot, maxBytes);
  if (!written.ok) return { ok: false, code: 'artifact_write_unconfirmed' };
  return written.digest === expectedDigest && written.bytes.equals(bytes)
    ? { ok: true, digest: written.digest }
    : { ok: false, code: 'artifact_write_conflict' };
}
export function bootstrapData(
  entry: LaunchReservation,
): Record<string, unknown> {
  const value = (entry as LaunchReservation & { readonly bootstrap?: unknown })
    .bootstrap;
  return isRecord(value) ? value : {};
}
