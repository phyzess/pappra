import { createHash } from 'node:crypto';
import { isTaskRecord } from '../collab/validation.js';
import type { Identity } from '../collab/types.js';
import type { ManagedPiSdkSessionController } from '../hosts/pi/managed-sdk-session.js';
import {
  openMessageTask,
  readRegisteredMessageSafe,
  assertMessageTaskCurrent,
} from './collab-messages.js';
import { buildNotificationText } from './collab-notify.js';
import { routeExclusionFor } from './collab-route.js';
import { readBoundedFile } from './bounded-file.js';

type Runtime = Pick<
  ManagedPiSdkSessionController,
  'observe' | 'snapshot' | 'submitInput'
>;
const same = (a: Identity | null, b: Identity) =>
  a?.agent_id === b.agent_id &&
  a.session_id === b.session_id &&
  a.harness === b.harness;

/** Only registered pointers in the runtime's launch-bound namespace become native input. */
export async function deliverManagedPiMessage(
  runtime: Runtime,
  request: Readonly<Record<string, unknown>>,
  authorization: { readonly taskRoot: string; readonly agentId: string },
): Promise<Readonly<Record<string, unknown>>> {
  const refuse = (reason: string) => ({ ok: false, reason });
  if (
    request.task_root !== authorization.taskRoot ||
    typeof request.message_id !== 'string' ||
    typeof request.digest !== 'string' ||
    request.expected_session_id !== runtime.observe().native.sessionId
  )
    return refuse('delivery_scope_mismatch');
  const opened = await openMessageTask(authorization.taskRoot);
  if (!opened.ok) return refuse(opened.code);
  const registered = await readRegisteredMessageSafe(
    opened.value,
    request.message_id,
  );
  if (!registered.ok) return refuse(registered.code);
  if (registered.value.digest !== request.digest)
    return refuse('delivery_digest_mismatch');
  if (await assertMessageTaskCurrent(opened.value))
    return refuse('delivery_namespace_changed');
  // No async seam follows the last namespace/record read and the native admission.
  const latest = readBoundedFile(opened.value.recordFile, 8 * 1024 * 1024);
  if (!latest.ok) return refuse('delivery_namespace_changed');
  let record: unknown;
  try {
    record = JSON.parse(latest.text) as unknown;
  } catch {
    return refuse('delivery_record_missing');
  }
  if (
    !isTaskRecord(record) ||
    record.task_id !== opened.value.record.task_id ||
    record.task_root !== opened.value.taskRoot ||
    record.domain_root !== opened.value.record.domain_root ||
    record.domain_id !== opened.value.record.domain_id ||
    record.created_at !== opened.value.record.created_at
  )
    return refuse('delivery_record_missing');
  const latestMessage = readBoundedFile(registered.value.file, 1024 * 1024);
  if (!latestMessage.ok || latestMessage.digest !== registered.value.digest)
    return refuse('delivery_digest_mismatch');
  const message = registered.value.message;
  const live = runtime.observe();
  if (
    message.to.harness !== 'pi' ||
    message.to.agent_id !== authorization.agentId ||
    message.to.session_id !== live.native.sessionId ||
    (message.to.cwd !== undefined && message.to.cwd !== live.cwd) ||
    message.owner_epoch !== record.coordinator?.owner_epoch
  )
    return refuse('delivery_identity_stale');
  for (const side of [message.from, message.to])
    if (routeExclusionFor(record, side).state !== 'active')
      return refuse('delivery_route_excluded');
  if (message.subtask_id !== null || message.attempt !== null) {
    const attempt = record.attempts.find(
      (row) =>
        row.subtask_id === message.subtask_id &&
        row.attempt === message.attempt,
    );
    if (
      !attempt ||
      attempt.closed_at ||
      attempt.cancel_requested_at ||
      [
        'completed',
        'failed',
        'cancelled',
        'canceled',
        'awaiting_approval',
        'blocked',
      ].includes(attempt.state) ||
      attempt.awaiting === 'approval' ||
      attempt.owner_epoch !== message.owner_epoch ||
      (message.body.input_revision !== undefined &&
        message.body.input_revision !== attempt.input_revision)
    )
      return refuse('delivery_attempt_inactive');
    if (
      !same(message.from, record.coordinator!) &&
      !same(message.from, attempt.assignee)
    )
      return refuse('delivery_sender_inactive');
    if (
      record.claims.some(
        (claim) =>
          claim.subtask_id === attempt.subtask_id &&
          claim.attempt === attempt.attempt &&
          !claim.released_at &&
          claim.cancel_pending,
      )
    )
      return refuse('delivery_cancellation_pending');
  } else if (!same(message.from, record.coordinator!))
    return refuse('delivery_sender_inactive');
  const inventory = runtime.snapshot().ownedRuntime;
  if (
    inventory.extensionDialogs.completeness !== 'complete' ||
    inventory.extensionDialogs.pending.length ||
    inventory.queues.internal.activeSelector
  )
    return refuse('delivery_approval_pending');
  if (message.type === 'ASSIGN' && record.dispatch_frozen)
    return refuse('delivery_dispatch_frozen');
  const entry = record.messages.find(
    (row) => row.message_id === message.message_id,
  );
  if (
    !entry ||
    entry.content_digest !== message.content_digest ||
    !['applied', 'recorded'].includes(entry.state)
  )
    return refuse('delivery_registration_stale');
  const text = buildNotificationText({
    taskId: record.task_id,
    type: message.type,
    messagePath: registered.value.file,
    digest: registered.value.digest,
  });
  const id = `message-${createHash('sha256').update(`${authorization.taskRoot}\0${message.message_id}\0${registered.value.digest}`).digest('hex')}`;
  return { ok: true, admission: runtime.submitInput(id, text) };
}
