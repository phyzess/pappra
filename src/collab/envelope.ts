import type { Message, MessageInput } from './types.js';
import { errorCode, parseJson, object, text, isMessage } from './validation.js';
import fs from 'node:fs';
import path from 'node:path';
import { createNonce, digestText, messagesDir, nowIso } from './store.js';
import { canonicalJson } from '../infra/json.js';
export { canonicalJson } from '../infra/json.js';

// Message envelopes and their idempotency rules.
//
// Registration is an exclusive create of `messages/<message_id>.json`, which is atomic,
// so two senders racing with the same id cannot both create it. Applying a registered
// message to the record is a separate transaction: a crash between the two steps leaves
// a `message_registered_not_applied` finding instead of a silent half-effect. The two
// steps are never presented as one cross-system transaction.

export const MESSAGE_SCHEMA = 'harness-collab/message/1';

export const MESSAGE_TYPES = Object.freeze([
  'ASSIGN',
  'ACK',
  'ASK',
  'ANSWER',
  'REPORT',
  'STATUS_QUERY',
  'STATUS',
  'HANDOFF',
  'BLOCK',
  'CANCEL',
  'CANCELLED',
]);

export const REPORT_STATUSES = Object.freeze([
  'running',
  'completed',
  'needs_input',
  'failed',
  'cancelled',
  'unknown',
]);
export const BLOCK_KINDS = Object.freeze(['clarification', 'approval']);

const REQUIRE_IDENTITY = ['agent_id', 'session_id', 'harness'];

const TYPE_RULES: Record<
  string,
  {
    to?: boolean;
    subtask?: boolean;
    attempt?: boolean;
    reply_to?: boolean;
    body?: string[];
  }
> = {
  ASSIGN: {
    to: true,
    subtask: true,
    attempt: true,
    body: ['assignment_digest'],
  },
  ACK: { to: true, reply_to: true },
  ASK: { to: true },
  ANSWER: { to: true, reply_to: true },
  REPORT: { to: true, subtask: true, attempt: true, body: ['status'] },
  STATUS_QUERY: { to: true },
  STATUS: { to: true, reply_to: true, body: ['status'] },
  HANDOFF: { to: true, subtask: true, body: ['handoff_id', 'phase'] },
  BLOCK: { to: true, body: ['kind'] },
  CANCEL: { to: true, subtask: true, attempt: true },
  CANCELLED: { to: true, reply_to: true, subtask: true, attempt: true },
};

function assert(condition: unknown, field: string): asserts condition {
  if (!condition) throw new Error(`Invalid message field: ${field}`);
}

function identity(value: unknown, field: string) {
  assert(object(value), field);
  for (const key of REQUIRE_IDENTITY)
    assert(text(value[key]), `${field}.${key}`);
}

export function validateEnvelope(message: unknown): Message {
  assert(isMessage(message), 'message');
  assert(message.schema === MESSAGE_SCHEMA, 'message.schema');
  assert(
    text(message.message_id) && message.message_id.length <= 128,
    'message.message_id',
  );
  assert(MESSAGE_TYPES.includes(message.type), 'message.type');
  assert(text(message.task_id), 'message.task_id');
  identity(message.from, 'message.from');
  const rule = TYPE_RULES[message.type];
  assert(rule, 'message.type');
  if (rule.to) identity(message.to, 'message.to');
  if (rule.reply_to) assert(text(message.reply_to), 'message.reply_to');
  if (rule.subtask) assert(text(message.subtask_id), 'message.subtask_id');
  if (rule.attempt)
    assert(
      Number.isSafeInteger(message.attempt) && (message.attempt ?? 0) > 0,
      'message.attempt',
    );
  if (message.owner_epoch !== undefined && message.owner_epoch !== null) {
    assert(
      Number.isSafeInteger(message.owner_epoch) && message.owner_epoch > 0,
      'message.owner_epoch',
    );
  }
  if (message.body !== undefined) assert(object(message.body), 'message.body');
  for (const key of rule.body ?? [])
    assert(
      message.body !== undefined && message.body[key] !== undefined,
      `message.body.${key}`,
    );
  if (message.body?.status !== undefined)
    assert(
      REPORT_STATUSES.includes(message.body.status),
      'message.body.status',
    );
  // `body.kind` is scoped per message type; the same field name means different things.
  if (message.type === 'BLOCK' && message.body?.kind !== undefined)
    assert(BLOCK_KINDS.includes(message.body.kind), 'message.body.kind');
  if (message.type === 'HANDOFF' && message.body?.kind !== undefined)
    assert(
      ['writer', 'coordinator'].includes(message.body.kind),
      'message.body.kind',
    );
  if (message.body?.approval !== undefined) {
    assert(
      object(message.body.approval) &&
        text(message.body.approval.approved_by) &&
        text(message.body.approval.reason),
      'message.body.approval',
    );
  }
  // Unknown extension fields are tolerated on purpose; unknown semantics are not inferred.
  return message;
}

/**
 * Content identity of a message: everything that decides what the message means.
 * `created_at` and `content_digest` are excluded so an honest resend is still the
 * same message.
 */
export function contentDigest(message: Message) {
  const content = {
    type: message.type,
    task_id: message.task_id,
    subtask_id: message.subtask_id ?? null,
    attempt: message.attempt ?? null,
    from: message.from,
    to: message.to ?? null,
    reply_to: message.reply_to ?? null,
    owner_epoch: message.owner_epoch ?? null,
    body: message.body ?? null,
  };
  return digestText(canonicalJson(content));
}

export function buildMessage(input: MessageInput, { clock = Date.now() } = {}) {
  const message: Message = {
    schema: MESSAGE_SCHEMA,
    message_id: input.message_id ?? `msg-${createNonce()}`,
    type: input.type,
    task_id: input.task_id,
    from: input.from,
    to: input.to,
    reply_to: input.reply_to ?? null,
    subtask_id: input.subtask_id ?? null,
    attempt: input.attempt ?? null,
    owner_epoch: input.owner_epoch ?? null,
    created_at: input.created_at ?? nowIso(clock),
    content_digest: null,
    body: input.body ?? {},
  };
  validateEnvelope(message);
  message.content_digest = contentDigest(message);
  return message;
}

/**
 * Message ids are single path segments: a letter or digit followed by letters,
 * digits, dot, dash or underscore, bounded at 128 characters. Anything else
 * (`..`, separators, control characters) is rejected before any path is built.
 */
const SAFE_MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeMessageId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_MESSAGE_ID.test(value);
}

export function messageFile(taskRoot: string, messageId: string): string {
  if (!isSafeMessageId(messageId))
    throw new Error('Invalid message field: message.message_id');
  return path.join(messagesDir(taskRoot), `${messageId}.json`);
}

export function readRegisteredMessage(
  taskRoot: string,
  messageId: string,
): Message | null {
  const file = messageFile(taskRoot, messageId);
  try {
    return validateEnvelope(parseJson(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Register a message exactly once. Returns:
 *   registered            first registration; the caller may now apply it
 *   duplicate             same id and same content; no new side effect
 *   content_conflict      same id, different content; rejected
 */
export function registerMessage(
  taskRoot: string,
  message: Message,
  { clock = Date.now() } = {},
) {
  validateEnvelope(message);
  const digest = contentDigest(message);
  if (message.content_digest && message.content_digest !== digest) {
    return {
      status: 'content_conflict',
      message_id: message.message_id,
      stored_digest: message.content_digest,
      actual_digest: digest,
    };
  }
  fs.mkdirSync(messagesDir(taskRoot), { recursive: true, mode: 0o700 });
  const stored = {
    ...message,
    content_digest: digest,
    created_at: message.created_at ?? nowIso(clock),
  };
  const file = messageFile(taskRoot, message.message_id);
  try {
    fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    return {
      status: 'registered',
      message_id: message.message_id,
      content_digest: digest,
      file,
    };
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    const existing = readRegisteredMessage(taskRoot, message.message_id);
    const existingDigest = existing ? contentDigest(existing) : null;
    if (existing && existingDigest === digest) {
      return {
        status: 'duplicate',
        message_id: message.message_id,
        content_digest: digest,
        file,
      };
    }
    return {
      status: 'content_conflict',
      message_id: message.message_id,
      stored_digest: existingDigest,
      actual_digest: digest,
      file,
    };
  }
}

export function listRegisteredMessages(taskRoot: string) {
  try {
    return fs
      .readdirSync(messagesDir(taskRoot))
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort();
  } catch {
    return [];
  }
}

export function sha256File(file: string) {
  return digestText(fs.readFileSync(file));
}

export function uniqueNonce() {
  return createNonce();
}
