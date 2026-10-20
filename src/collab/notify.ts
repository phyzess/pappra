import type { TaskRecord, Notification, NotificationEntry } from './types.js';
import { text, isNotification } from './validation.js';
import { createNonce, nowIso } from './store.js';
import { canonicalJson } from './envelope.js';

// Bounded admission for hook/plugin notifications.
//
// Why this exists: a hook that fires on every event can wake a model in a loop, a
// session can notify itself, and an approval request must never be answered by another
// agent. This gate answers one question — may this notification be delivered? — and it
// records the decision in the task record. It does not send anything.

export const DEFAULT_LIMITS = Object.freeze({
  per_key: 3,
  window_ms: 60_000,
  max_depth: 2,
  max_entries: 200,
});

type Limits = { [Key in keyof typeof DEFAULT_LIMITS]?: number };

export const NOTIFICATION_KINDS = Object.freeze([
  'task_event',
  'turn_complete',
  'tool_failure',
  'approval_request',
  'status_probe',
  'handoff_note',
]);

function assert(condition: unknown, field: string): asserts condition {
  if (!condition) throw new Error(`Invalid notification field: ${field}`);
}

export function validateNotification(notification: unknown): Notification {
  assert(isNotification(notification), 'notification');
  assert(
    notification.schema === 'harness-collab/notification/1',
    'notification.schema',
  );
  assert(text(notification.kind), 'notification.kind');
  assert(
    NOTIFICATION_KINDS.includes(notification.kind),
    'notification.kind value',
  );
  assert(text(notification.origin_session), 'notification.origin_session');
  assert(text(notification.target_session), 'notification.target_session');
  assert(
    Number.isSafeInteger(notification.depth ?? 0) &&
      (notification.depth ?? 0) >= 0,
    'notification.depth',
  );
  assert(text(notification.task_id), 'notification.task_id');
  return notification;
}

/** Stable identity of a notification: everything that decides whether it is the same one. */
export function notificationKey(notification: Notification) {
  return canonicalJson({
    kind: notification.kind,
    task_id: notification.task_id,
    subtask_id: notification.subtask_id ?? null,
    attempt: notification.attempt ?? null,
    origin_session: notification.origin_session,
    event: notification.event ?? null,
  });
}

/**
 * Decide whether to deliver. Returns `{admit, reason, human_required}`. An approval
 * request is recorded but never answerable by another agent, and no decision here
 * triggers a send, a retry or a model wake.
 */
export function admitNotification(
  record: TaskRecord,
  notification: Notification,
  { clock = Date.now(), limits = {} }: { clock?: number; limits?: Limits } = {},
) {
  validateNotification(notification);
  const effective = { ...DEFAULT_LIMITS, ...limits };
  const at = nowIso(clock);
  const key = notificationKey(notification);
  const entry: NotificationEntry = {
    notification_id: `note-${createNonce()}`,
    key,
    kind: notification.kind,
    task_id: notification.task_id,
    subtask_id: notification.subtask_id ?? null,
    attempt: notification.attempt ?? null,
    origin_session: notification.origin_session,
    target_session: notification.target_session,
    depth: notification.depth ?? 0,
    at,
    decision: 'admitted',
    reason: null,
  };
  const log = record.notifications ?? (record.notifications = []);

  if (notification.kind === 'approval_request') {
    // Recorded and surfaced, never answered, and never used to wake another model.
    log.push({
      ...entry,
      decision: 'recorded',
      reason: 'approval_requests_are_not_auto_answered',
    });
    return {
      admit: false,
      reason: 'approval_requests_are_not_auto_answered',
      human_required: true,
      key,
    };
  }
  if (notification.origin_session === notification.target_session) {
    log.push({ ...entry, decision: 'dropped', reason: 'self_notification' });
    return {
      admit: false,
      reason: 'self_notification',
      human_required: false,
      key,
    };
  }
  if ((notification.depth ?? 0) > effective.max_depth) {
    log.push({
      ...entry,
      decision: 'dropped',
      reason: 'recursion_depth_exceeded',
    });
    return {
      admit: false,
      reason: 'recursion_depth_exceeded',
      human_required: false,
      key,
    };
  }
  const windowStart = clock - effective.window_ms;
  const recent = log.filter(
    (item) =>
      item.key === key &&
      item.decision === 'admitted' &&
      Number.isFinite(Date.parse(item.at)) &&
      Date.parse(item.at) >= windowStart,
  );
  if (recent.length >= effective.per_key) {
    log.push({ ...entry, decision: 'dropped', reason: 'rate_limited' });
    return {
      admit: false,
      reason: 'rate_limited',
      delivered_in_window: recent.length,
      key,
    };
  }
  log.push(entry);
  return { admit: true, reason: null, human_required: false, key };
}

/** Keep the notification log bounded; the newest entries are the ones that matter. */
export function trimNotificationLog(
  record: TaskRecord,
  { limits = {} }: { clock?: number; limits?: Limits } = {},
) {
  const effective = { ...DEFAULT_LIMITS, ...limits };
  if (!Array.isArray(record.notifications)) return 0;
  const excess = record.notifications.length - effective.max_entries;
  if (excess <= 0) return 0;
  record.notifications = record.notifications.slice(excess);
  record.notifications_trimmed = (record.notifications_trimmed ?? 0) + excess;
  return excess;
}
