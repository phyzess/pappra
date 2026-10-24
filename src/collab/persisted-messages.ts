import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isSafeMessageId, messageFile, validateEnvelope } from './envelope.js';
import { submitMessage } from './messages.js';
import { messagesDir, notificationsDir, readRecord } from './store.js';
import type { AppliedMessage, Message, TaskRecord } from './types.js';
import {
  collabDeliverySchema,
  type CollabDelivery,
} from '../schemas/collaboration.js';
import { isPathInside } from '../schemas/paths.js';
import { observePath, resolveRealpath } from '../infra/fs.js';
import { errorMessage, type Outcome } from '../schemas/outcome.js';

/**
 * Public persisted-message operations over the existing collaboration protocol.
 *
 * These operations only read and write the authoritative task record, message
 * registration files and ledger. They never start a native process, never notify
 * anyone, and never treat protocol acceptance as task acceptance or delivery.
 */

const MAX_ENVELOPE_BYTES = 1024 * 1024;
const MAX_DELIVERY_BYTES = 64 * 1024;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

export interface MessageServiceFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly nextAction: string | null;
}

export type MessageServiceResult<T> = Outcome<T, MessageServiceFailure>;

function serviceFailure(
  code: string,
  message: string,
  nextAction: string | null,
): MessageServiceFailure {
  return { ok: false, code, message, nextAction };
}

function digestOf(bytes: Buffer | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export interface MessagePathIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

export interface MessageNamespaceIdentity {
  readonly taskRoot: MessagePathIdentity;
  readonly messagesDirectory: MessagePathIdentity;
  readonly recordFile: MessagePathIdentity;
}

export interface OpenedMessageTask {
  readonly taskRoot: string;
  readonly domainRoot: string;
  readonly record: TaskRecord;
  readonly messagesDirectory: string;
  readonly recordFile: string;
  readonly identity: MessageNamespaceIdentity;
}

function recordPathOf(taskRoot: string): string {
  return path.join(taskRoot, 'task.json');
}

/**
 * Opens one authoritative task root and proves it is the canonical private
 * namespace it claims to be. Redirected paths, mismatched records and unsafe
 * layouts fail closed before any caller writes.
 */
export async function openMessageTask(
  taskRootInput: string,
): Promise<MessageServiceResult<OpenedMessageTask>> {
  if (!path.isAbsolute(taskRootInput)) {
    return serviceFailure(
      'task_root_required',
      `collab message requires an absolute --task-root: ${taskRootInput}`,
      'Pass the absolute task root that contains task.json.',
    );
  }
  const requested = path.resolve(taskRootInput);
  const tasksCandidate = path.dirname(requested);
  const domainCandidate = path.dirname(tasksCandidate);
  const observation = await observePath(requested).catch((error: unknown) =>
    serviceFailure(
      'task_root_unreadable',
      `Cannot inspect task root ${requested}: ${errorMessage(error)}`,
      'Check permissions and the path; nothing was read or written.',
    ),
  );
  if ('ok' in observation) return observation;
  if (observation.kind === 'symlink') {
    return serviceFailure(
      'task_root_redirected',
      `Task root is a symlink: ${requested}`,
      'Pass the real task root; Pappra does not follow a redirected task namespace.',
    );
  }
  if (observation.kind !== 'directory') {
    return serviceFailure(
      'task_root_missing',
      `Task root is not an existing directory: ${requested}`,
      'Pass the absolute task root that contains task.json.',
    );
  }
  // System-level aliases above the domain (for example /var on macOS) are resolved.
  // The domain, its `tasks` parent, the task root and nested state must be real:
  // a symlinked `tasks` parent (even into another valid domain) is a redirect.
  if (path.basename(tasksCandidate) !== 'tasks') {
    return serviceFailure(
      'task_root_layout_invalid',
      `Task root is not a <domain>/tasks/<task-id> directory: ${requested}`,
      'Pass a task root created by the collaboration prepare flow.',
    );
  }
  // The domain entry itself must be a real directory. Aliases above it (for
  // example /tmp or /var) are fine; a `domain -> real-domain` link is a redirect.
  const domainObservation = await observePath(domainCandidate).catch(
    (error: unknown) =>
      serviceFailure(
        'task_root_unreadable',
        `Cannot inspect the task domain ${domainCandidate}: ${errorMessage(error)}`,
        'Inspect the path; nothing was read or written.',
      ),
  );
  if ('ok' in domainObservation) return domainObservation;
  if (domainObservation.kind === 'symlink') {
    return serviceFailure(
      'task_root_redirected',
      `Task domain is a symlink: ${domainCandidate}`,
      'Pass the real domain root; Pappra does not follow a redirected task namespace.',
    );
  }
  if (
    domainObservation.kind !== 'directory' ||
    domainObservation.stats === null
  ) {
    return serviceFailure(
      'task_root_layout_invalid',
      `Task domain is not a directory: ${domainCandidate}`,
      'Pass a task root created by the collaboration prepare flow.',
    );
  }
  const canonicalDomain = await resolveRealpath(domainCandidate);
  if (canonicalDomain === null) {
    return serviceFailure(
      'task_root_unreadable',
      `Cannot resolve the task domain: ${domainCandidate}`,
      'Inspect the path; nothing was read or written.',
    );
  }
  const tasksObservation = await observePath(tasksCandidate).catch(
    (error: unknown) =>
      serviceFailure(
        'task_root_redirected',
        `Cannot inspect the tasks parent ${tasksCandidate}: ${errorMessage(error)}`,
        'Inspect the path; nothing was read or written.',
      ),
  );
  if ('ok' in tasksObservation) return tasksObservation;
  if (
    tasksObservation.kind !== 'directory' ||
    tasksObservation.stats === null
  ) {
    return serviceFailure(
      'task_root_redirected',
      `Tasks parent is not a real directory: ${tasksCandidate}`,
      'Restore a real tasks directory under the domain; nothing was read or written.',
    );
  }
  const canonicalTasks = await resolveRealpath(tasksCandidate);
  if (canonicalTasks !== path.join(canonicalDomain, 'tasks')) {
    return serviceFailure(
      'task_root_redirected',
      `Tasks parent is redirected outside the domain: ${tasksCandidate}`,
      'Restore a real tasks directory under the domain; nothing was read or written.',
    );
  }
  const taskRoot = await resolveRealpath(requested);
  if (taskRoot === null) {
    return serviceFailure(
      'task_root_unreadable',
      `Cannot resolve task root: ${requested}`,
      'Inspect the path; nothing was read or written.',
    );
  }
  if (
    taskRoot !== path.join(canonicalDomain, 'tasks', path.basename(requested))
  ) {
    return serviceFailure(
      'task_root_redirected',
      `Task root resolves outside its domain: ${requested} -> ${taskRoot}`,
      'Pass the real task root; Pappra does not follow a redirected task namespace.',
    );
  }

  const recordFile = recordPathOf(taskRoot);
  const recordObservation = await observePath(recordFile).catch(
    (error: unknown) =>
      serviceFailure(
        'task_record_unreadable',
        `Cannot inspect task record ${recordFile}: ${errorMessage(error)}`,
        'Check permissions; nothing was read or written.',
      ),
  );
  if ('ok' in recordObservation) return recordObservation;
  if (recordObservation.kind === 'missing') {
    return serviceFailure(
      'task_record_missing',
      `No task record at ${recordFile}`,
      'Prepare the task first; a message is never sent into an unregistered task.',
    );
  }
  if (recordObservation.kind !== 'file') {
    return serviceFailure(
      'task_record_invalid',
      `Task record is not a regular file: ${recordFile}`,
      'Inspect the record; Pappra does not follow redirected task state.',
    );
  }
  const realRecord = await resolveRealpath(recordFile);
  if (realRecord === null || !isPathInside(taskRoot, realRecord)) {
    return serviceFailure(
      'task_record_unsafe',
      `Task record resolves outside the task root: ${recordFile}`,
      'Inspect or remove the redirected record; nothing was read into the protocol.',
    );
  }

  let record: TaskRecord | null;
  try {
    record = readRecord(taskRoot);
  } catch (error) {
    return serviceFailure(
      'task_record_invalid',
      `Task record is not usable: ${errorMessage(error)}`,
      'Inspect the record; Pappra does not repair or reinterpret it.',
    );
  }
  if (record === null) {
    return serviceFailure(
      'task_record_missing',
      `No task record at ${recordFile}`,
      'Prepare the task first; a message is never sent into an unregistered task.',
    );
  }
  const recordRoot = await resolveRealpath(record.task_root);
  if (
    typeof record.task_id !== 'string' ||
    !TASK_ID_PATTERN.test(record.task_id) ||
    recordRoot === null ||
    recordRoot !== taskRoot ||
    path.basename(taskRoot) !== record.task_id
  ) {
    return serviceFailure(
      'task_record_identity_mismatch',
      `Task record does not describe ${taskRoot}`,
      'Pass the task root recorded in task.json; identity is never guessed.',
    );
  }
  const domainRoot = await resolveRealpath(record.domain_root);
  if (
    !path.isAbsolute(record.domain_root) ||
    domainRoot === null ||
    domainRoot !== canonicalDomain ||
    path.dirname(path.dirname(taskRoot)) !== canonicalDomain
  ) {
    return serviceFailure(
      'task_record_identity_mismatch',
      `Task record domain does not contain ${taskRoot}`,
      'Inspect the record domain; cross-domain messages are not inferred.',
    );
  }

  const directory = messagesDir(taskRoot);
  const messagesObservation = await observePath(directory).catch(
    (error: unknown) =>
      serviceFailure(
        'task_messages_unreadable',
        `Cannot inspect ${directory}: ${errorMessage(error)}`,
        'Check permissions; nothing was read or written.',
      ),
  );
  if ('ok' in messagesObservation) return messagesObservation;
  if (messagesObservation.kind === 'missing') {
    return serviceFailure(
      'task_messages_missing',
      `Task has no messages directory: ${directory}`,
      'Inspect the task; Pappra does not recreate protocol state silently.',
    );
  }
  if (messagesObservation.kind !== 'directory') {
    return serviceFailure(
      'task_messages_unsafe',
      `Messages path is not a regular directory: ${directory}`,
      'Inspect or remove the redirected messages path; nothing was written through it.',
    );
  }
  const realMessages = await resolveRealpath(directory);
  if (realMessages === null || realMessages !== directory) {
    return serviceFailure(
      'task_messages_unsafe',
      `Messages directory is redirected: ${directory}`,
      'Restore a real messages directory inside the task root; Pappra does not follow symlinks.',
    );
  }
  if (!isPathInside(taskRoot, realMessages)) {
    return serviceFailure(
      'task_messages_unsafe',
      `Messages directory resolves outside the task root: ${directory}`,
      'Restore a real messages directory inside the task root.',
    );
  }

  return {
    ok: true,
    value: {
      taskRoot,
      domainRoot: canonicalDomain,
      record,
      messagesDirectory: directory,
      recordFile,
      identity: {
        taskRoot: {
          path: taskRoot,
          dev: observation.stats!.dev,
          ino: observation.stats!.ino,
        },
        messagesDirectory: {
          path: directory,
          dev: messagesObservation.stats!.dev,
          ino: messagesObservation.stats!.ino,
        },
        recordFile: {
          path: recordFile,
          dev: recordObservation.stats!.dev,
          ino: recordObservation.stats!.ino,
        },
      },
    },
  };
}

function sameIdentity(left: MessagePathIdentity, right: MessagePathIdentity) {
  return (
    left.path === right.path && left.dev === right.dev && left.ino === right.ino
  );
}

/**
 * Revalidates the task namespace after an async seam. A root that was renamed,
 * replaced or redirected in the meantime fails closed before any mutation or
 * native submission.
 * task.json is atomically replaced by normal store commits; its inode is not
 * namespace identity. openMessageTask still validates its type and task/domain.
 * This checks paths only. Callers must separately revalidate current authority
 * after async work, preferably inside the transaction that commits the effect.
 */
export async function assertMessageTaskCurrent(
  opened: OpenedMessageTask,
): Promise<MessageServiceFailure | null> {
  const again = await openMessageTask(opened.taskRoot);
  if (!again.ok) return again;
  const current = again.value.identity;
  if (
    !sameIdentity(current.taskRoot, opened.identity.taskRoot) ||
    !sameIdentity(
      current.messagesDirectory,
      opened.identity.messagesDirectory,
    ) ||
    again.value.record.domain_id !== opened.record.domain_id ||
    again.value.record.created_at !== opened.record.created_at
  ) {
    return serviceFailure(
      'task_namespace_changed',
      `Task namespace changed after it was opened: ${opened.taskRoot}`,
      'Inspect the task root; nothing was written or notified.',
    );
  }
  return null;
}

export interface RegisteredMessage {
  readonly message: Message;
  readonly file: string;
  readonly digest: string;
}

/**
 * The one bounded, identity-checked reader for registered messages. A final
 * symlink, non-regular file, oversized file, redirected path or id/content
 * mismatch never becomes protocol content.
 */
export async function readRegisteredMessageSafe(
  opened: OpenedMessageTask,
  messageId: string,
): Promise<MessageServiceResult<RegisteredMessage>> {
  if (!isSafeMessageId(messageId)) {
    return serviceFailure(
      'message_id_invalid',
      `Unsafe message id: ${messageId}`,
      'Use a registered message id from collab message list.',
    );
  }
  let file: string;
  try {
    file = messageFile(opened.taskRoot, messageId);
  } catch (error) {
    return serviceFailure('message_id_invalid', errorMessage(error), null);
  }
  if (!isPathInside(opened.messagesDirectory, file)) {
    return serviceFailure(
      'message_id_invalid',
      `Message path escapes the messages directory: ${file}`,
      'Use a safe single-segment message id.',
    );
  }
  const observation = await observePath(file).catch((error: unknown) =>
    serviceFailure(
      'message_registration_invalid',
      `Cannot inspect registered message ${file}: ${errorMessage(error)}`,
      'Inspect the message file; nothing was read into the protocol.',
    ),
  );
  if ('ok' in observation) return observation;
  if (observation.kind === 'missing') {
    return serviceFailure(
      'message_not_registered',
      `No registered message ${messageId} in ${opened.taskRoot}`,
      'Persist the message first; notification only forwards a registered pointer.',
    );
  }
  if (observation.kind !== 'file' || observation.stats === null) {
    return serviceFailure(
      'message_registration_invalid',
      `Registered message is not a regular file: ${file}`,
      'Restore a regular registered message; links and special files are not followed.',
    );
  }
  if (observation.stats.size > MAX_ENVELOPE_BYTES) {
    return serviceFailure(
      'message_registration_invalid',
      `Registered message exceeds ${MAX_ENVELOPE_BYTES} bytes: ${file}`,
      'Inspect the message file; oversized content is not accepted as protocol evidence.',
    );
  }
  const real = await resolveRealpath(file);
  if (
    real === null ||
    real !== file ||
    !isPathInside(opened.messagesDirectory, real)
  ) {
    return serviceFailure(
      'message_registration_invalid',
      `Registered message is redirected: ${file}`,
      'Restore a regular message file inside the task; nothing was read into the protocol.',
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return serviceFailure(
      'message_registration_invalid',
      `Registered message is not valid JSON: ${errorMessage(error)}`,
      'Inspect the message file; nothing was read into the protocol.',
    );
  }
  let message: Message;
  try {
    message = validateEnvelope(payload);
  } catch (error) {
    return serviceFailure(
      'message_registration_invalid',
      `Registered message failed protocol validation: ${errorMessage(error)}`,
      'Inspect the message file; nothing was read into the protocol.',
    );
  }
  if (
    message.message_id !== messageId ||
    message.task_id !== opened.record.task_id
  ) {
    return serviceFailure(
      'message_registration_invalid',
      `Registered message identity does not match ${messageId}`,
      'Inspect the message file; mismatched registration is not accepted as protocol content.',
    );
  }
  return {
    ok: true,
    value: { message, file, digest: digestOf(fs.readFileSync(file)) },
  };
}

export interface MessageSummary {
  readonly message_id: string;
  readonly type: string;
  readonly task_id: string;
  readonly from: Message['from'];
  readonly to: Message['to'];
  readonly reply_to: string | null;
  readonly subtask_id: string | null;
  readonly attempt: number | null;
  readonly content_digest: string | null;
}

function summarize(message: Message): MessageSummary {
  return {
    message_id: message.message_id,
    type: message.type,
    task_id: message.task_id,
    from: message.from,
    to: message.to,
    reply_to: message.reply_to,
    subtask_id: message.subtask_id,
    attempt: message.attempt,
    content_digest: message.content_digest,
  };
}

export interface MessageSendResult {
  readonly status:
    'planned' | 'accepted' | 'duplicate' | 'conflict' | 'rejected';
  readonly message: MessageSummary;
  readonly registrationStatus: string | null;
  readonly stateRevision: number | null;
  readonly messagePath: string | null;
  readonly digest: string | null;
  readonly detail: string | null;
  /** Persistence only: a successful send is not native delivery. */
  readonly delivery: 'not-attempted' | 'persisted-not-notified';
  readonly notified: false;
  readonly taskAccepted: false;
}

function readEnvelopeFile(
  file: string,
): MessageServiceResult<{ message: Message; bytes: Buffer }> {
  if (!path.isAbsolute(file)) {
    return serviceFailure(
      'message_file_required',
      `--message requires an absolute envelope file: ${file}`,
      'Write the envelope JSON to an absolute path and pass it explicitly.',
    );
  }
  const absolute = path.resolve(file);
  const stat = (() => {
    try {
      return fs.lstatSync(absolute);
    } catch (error) {
      return serviceFailure(
        'message_file_unreadable',
        `Cannot read envelope ${absolute}: ${errorMessage(error)}`,
        'Check the path; no protocol state was touched.',
      );
    }
  })();
  if ('ok' in stat) return stat;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return serviceFailure(
      'message_file_unsafe',
      `Envelope must be a regular file, not a symlink: ${absolute}`,
      'Write the envelope to a regular file; links are not followed.',
    );
  }
  if (stat.size > MAX_ENVELOPE_BYTES) {
    return serviceFailure(
      'message_file_too_large',
      `Envelope exceeds ${MAX_ENVELOPE_BYTES} bytes: ${absolute}`,
      'Send one bounded envelope per invocation.',
    );
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(absolute);
  } catch (error) {
    return serviceFailure(
      'message_file_unreadable',
      `Cannot read envelope ${absolute}: ${errorMessage(error)}`,
      'Check the path; no protocol state was touched.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    return serviceFailure(
      'message_envelope_invalid',
      `Envelope is not valid JSON: ${errorMessage(error)}`,
      'Fix the JSON envelope; no protocol state was touched.',
    );
  }
  try {
    return { ok: true, value: { message: validateEnvelope(parsed), bytes } };
  } catch (error) {
    return serviceFailure(
      'message_envelope_invalid',
      `Envelope failed protocol validation: ${errorMessage(error)}`,
      'Correct the envelope against harness-collab/message/1; nothing was registered.',
    );
  }
}

/**
 * Validates one envelope file, then (with apply) registers and applies it through
 * the existing protocol. Planning writes nothing and spawns nothing.
 */
export async function sendMessageFromFile(
  taskRootInput: string,
  envelopeFile: string,
  options: { readonly apply: boolean; readonly clock?: number },
): Promise<MessageServiceResult<MessageSendResult>> {
  const opened = await openMessageTask(taskRootInput);
  if (!opened.ok) return opened;
  const { taskRoot, record } = opened.value;
  const envelope = readEnvelopeFile(envelopeFile);
  if (!envelope.ok) return envelope;
  const message = envelope.value.message;

  if (!isSafeMessageId(message.message_id)) {
    return serviceFailure(
      'message_id_invalid',
      `Unsafe message id: ${message.message_id}`,
      'Use a letter or digit followed by letters, digits, dot, dash or underscore (max 128).',
    );
  }
  if (message.task_id !== record.task_id) {
    return serviceFailure(
      'message_task_mismatch',
      `Envelope task_id ${message.task_id} does not match record ${record.task_id}`,
      'Send only messages for this task root; cross-task messages are refused.',
    );
  }

  let target: string;
  try {
    target = messageFile(taskRoot, message.message_id);
  } catch (error) {
    return serviceFailure(
      'message_id_invalid',
      errorMessage(error),
      'Use a safe single-segment message id.',
    );
  }
  if (!isPathInside(opened.value.messagesDirectory, target)) {
    return serviceFailure(
      'message_id_invalid',
      `Message path escapes the messages directory: ${target}`,
      'Use a safe single-segment message id.',
    );
  }
  const targetObservation = await observePath(target).catch((error: unknown) =>
    serviceFailure(
      'message_file_unreadable',
      `Cannot inspect ${target}: ${errorMessage(error)}`,
      'Check permissions; nothing was registered.',
    ),
  );
  if ('ok' in targetObservation) return targetObservation;
  if (
    targetObservation.kind !== 'missing' &&
    targetObservation.kind !== 'file'
  ) {
    return serviceFailure(
      'message_registration_unsafe',
      `Message registration path is not a regular file: ${target}`,
      'Inspect or remove that path; Pappra does not replace it.',
    );
  }

  const summary = summarize(message);
  if (!options.apply) {
    return {
      ok: true,
      value: {
        status: 'planned',
        message: summary,
        registrationStatus: null,
        stateRevision: null,
        messagePath: null,
        digest: null,
        detail: 'Plan only: the envelope validates and nothing was persisted.',
        delivery: 'not-attempted',
        notified: false,
        taskAccepted: false,
      },
    };
  }

  // Revalidate the namespace immediately before the mutation; an await earlier in
  // this call may have yielded to another process.
  const changed = await assertMessageTaskCurrent(opened.value);
  if (changed !== null) return changed;
  const outcome = submitMessage(
    taskRoot,
    message,
    options.clock === undefined ? {} : { clock: options.clock },
  );
  const registrationStatus =
    typeof outcome.registration?.status === 'string'
      ? outcome.registration.status
      : null;
  if (!outcome.ok) {
    const status =
      outcome.reason === 'content_conflict' ? 'conflict' : 'rejected';
    return {
      ok: true,
      value: {
        status,
        message: summary,
        registrationStatus,
        stateRevision: null,
        messagePath: targetObservation.kind === 'file' ? target : null,
        digest:
          targetObservation.kind === 'file'
            ? digestOf(fs.readFileSync(target))
            : null,
        detail: `Protocol refused the message: ${outcome.reason}`,
        delivery: 'persisted-not-notified',
        notified: false,
        taskAccepted: false,
      },
    };
  }

  const persisted = fs.existsSync(target);
  const digest = persisted ? digestOf(fs.readFileSync(target)) : null;
  const duplicate = outcome.duplicate === true;
  return {
    ok: true,
    value: {
      status: duplicate ? 'duplicate' : 'accepted',
      message: summary,
      registrationStatus,
      stateRevision: outcome.state_revision ?? null,
      messagePath: persisted ? target : null,
      digest,
      detail: duplicate
        ? 'Protocol duplicate: the same registered message id and content already existed.'
        : 'Protocol accepted the message; no native delivery or task acceptance is implied.',
      delivery: 'persisted-not-notified',
      notified: false,
      taskAccepted: false,
    },
  };
}

export function deliveryPathFor(taskRoot: string, messageId: string): string {
  return path.join(notificationsDir(taskRoot), `${messageId}.json`);
}

/** Reads task-private delivery metadata without creating it. */
export function readDeliveryRecord(
  taskRoot: string,
  messageId: string,
): CollabDelivery | null {
  if (!isSafeMessageId(messageId)) return null;
  const file = deliveryPathFor(taskRoot, messageId);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_DELIVERY_BYTES) return null;
    const parsed = collabDeliverySchema.safeParse(
      JSON.parse(fs.readFileSync(file, 'utf8')),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface MessageReadResult {
  readonly message: Message;
  readonly entry: AppliedMessage | null;
  readonly messagePath: string;
  readonly digest: string;
  readonly delivery: CollabDelivery | null;
  readonly writes: false;
}

export async function readMessageFromTaskRoot(
  taskRootInput: string,
  messageId: string,
): Promise<MessageServiceResult<MessageReadResult>> {
  const opened = await openMessageTask(taskRootInput);
  if (!opened.ok) return opened;
  const registered = await readRegisteredMessageSafe(opened.value, messageId);
  if (!registered.ok) return registered;
  return {
    ok: true,
    value: {
      message: registered.value.message,
      entry:
        opened.value.record.messages.find(
          (item) => item.message_id === messageId,
        ) ?? null,
      messagePath: registered.value.file,
      digest: registered.value.digest,
      delivery: readDeliveryRecord(opened.value.taskRoot, messageId),
      writes: false,
    },
  };
}

export interface MessageListEntry {
  readonly message_id: string;
  readonly type: string;
  readonly state: string;
  readonly reply_to: string | null;
  readonly subtask_id: string | null;
  readonly attempt: number | null;
  readonly at: string;
  readonly applied_at: string;
  readonly content_digest: string;
  readonly registered: boolean;
  readonly delivery: CollabDelivery | null;
}

export interface MessageListResult {
  readonly total: number;
  readonly returned: number;
  readonly truncated: boolean;
  readonly messages: readonly MessageListEntry[];
  readonly writes: false;
}

/** Lists the most recent applied messages from the authoritative record. */
export async function listMessagesForTaskRoot(
  taskRootInput: string,
  options: { readonly limit?: number } = {},
): Promise<MessageServiceResult<MessageListResult>> {
  const opened = await openMessageTask(taskRootInput);
  if (!opened.ok) return opened;
  const requested = options.limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isSafeInteger(requested) || requested < 1) {
    return serviceFailure(
      'limit_invalid',
      `--limit must be a positive integer: ${String(options.limit)}`,
      `Use a value between 1 and ${MAX_LIST_LIMIT}.`,
    );
  }
  const limit = Math.min(requested, MAX_LIST_LIMIT);
  const all = opened.value.record.messages;
  const selected = all.slice(Math.max(0, all.length - limit)).reverse();
  const messages: MessageListEntry[] = selected.map((entry) => ({
    message_id: entry.message_id,
    type: entry.type,
    state: entry.state,
    reply_to: entry.reply_to,
    subtask_id: entry.subtask_id,
    attempt: entry.attempt,
    at: entry.at,
    applied_at: entry.applied_at,
    content_digest: entry.content_digest,
    registered: isSafeMessageId(entry.message_id)
      ? fs.existsSync(messageFile(opened.value.taskRoot, entry.message_id))
      : false,
    delivery: readDeliveryRecord(opened.value.taskRoot, entry.message_id),
  }));
  return {
    ok: true,
    value: {
      total: all.length,
      returned: messages.length,
      truncated: all.length > messages.length,
      messages,
      writes: false,
    },
  };
}
