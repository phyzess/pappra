import type { TaskRecord, LockHolder, Message, Notification } from './types.js';

/** Decode external JSON as unknown; protocol validators establish the usable shape. */
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function errorCode(error: unknown): string | undefined {
  return object(error) && typeof error['code'] === 'string'
    ? error['code']
    : undefined;
}

export function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

type Fields = Record<string, unknown>;
type Predicate = (value: unknown) => boolean;
const string: Predicate = (value) => typeof value === 'string';
const number: Predicate = (value) =>
  typeof value === 'number' && Number.isSafeInteger(value);
const nullable =
  (test: Predicate): Predicate =>
  (value) =>
    value === null || test(value);
const optional =
  (test: Predicate): Predicate =>
  (value) =>
    value === undefined || test(value);
const array =
  (test: Predicate): Predicate =>
  (value) =>
    Array.isArray(value) && value.every(test);

function shape(
  value: unknown,
  fields: Record<string, Predicate>,
): value is Fields {
  return (
    object(value) &&
    Object.entries(fields).every(([key, test]) => test(value[key]))
  );
}

const identity: Predicate = (value) =>
  shape(value, {
    agent_id: string,
    session_id: string,
    harness: nullable(string),
    cwd: optional(string),
  });
const coordinator: Predicate = (value) =>
  identity(value) &&
  shape(value, {
    owner_epoch: number,
    since: string,
    previous: optional(
      nullable((item) =>
        shape(item, {
          agent_id: string,
          session_id: string,
          owner_epoch: number,
        }),
      ),
    ),
  });
const native: Predicate = (value) =>
  shape(value, {
    runner: nullable(string),
    session_id: nullable(string),
    run_id: nullable(string),
    mission_id: nullable(string),
    observation: string,
    observed_at: nullable(string),
    evidence_ref: nullable(string),
    manager: optional(string),
    launch_kind: optional(string),
    mode: optional(string),
    identity_status: optional(string),
  });
const transition: Predicate = (value) =>
  shape(value, {
    from: nullable(string),
    to: string,
    at: string,
    actor: string,
    reason: nullable(string),
  });
const approval: Predicate = (value) =>
  shape(value, { approved_by: string, reason: string });
const attempt: Predicate = (value) =>
  shape(value, {
    subtask_id: string,
    attempt: number,
    state: string,
    owner_epoch: nullable(number),
    assignee: identity,
    assignment_message_id: string,
    assignment_ref: nullable(string),
    assignment_digest: nullable(string),
    input_revision: nullable(string),
    created_at: string,
    updated_at: string,
    native,
    approval: nullable(approval),
    transitions: array(transition),
    closed_at: optional(string),
    awaiting: optional(string),
    ownership: optional(string),
    cancel_requested_at: optional(string),
    cwd: optional(string),
  });
const claim: Predicate = (value) =>
  shape(value, {
    claim_id: string,
    key: string,
    kind: string,
    scope: string,
    label: string,
    path: optional(nullable(string)),
    port: optional(nullable(number)),
    origin: optional(string),
    derived_from: optional(nullable(string)),
    access: string,
    holder: identity,
    resource_epoch: number,
    claimed_at: string,
    released_at: nullable(string),
    subtask_id: nullable(string),
    attempt: nullable(number),
    note: nullable(string),
    cancel_pending: optional((item) => typeof item === 'boolean'),
    released_by: optional(string),
    release_reason: optional(nullable(string)),
    transferred_from: optional(identity),
    transferred_at: optional(string),
  });
const appliedMessage: Predicate = (value) =>
  shape(value, {
    message_id: string,
    type: string,
    subtask_id: nullable(string),
    attempt: nullable(number),
    from: identity,
    to: nullable(identity),
    reply_to: nullable(string),
    owner_epoch: nullable(number),
    content_digest: string,
    at: string,
    applied_at: string,
    state: string,
    detail: string,
    body_kind: nullable(string),
  });
const uncertainty: Predicate = (value) =>
  shape(value, {
    uncertainty_id: string,
    kind: string,
    subtask_id: nullable(string),
    attempt: nullable(number),
    detail: nullable(string),
    evidence_ref: nullable(string),
    resolution_hint: nullable(string),
    opened_at: string,
    resolved_at: nullable(string),
    resolution: nullable(string),
    auto_restart: (item) => typeof item === 'boolean',
    resolved_by: optional(string),
    resolution_source: optional(string),
  });
const result: Predicate = (value) =>
  shape(value, {
    schema: string,
    subtask_id: string,
    attempt: number,
    status: string,
    message_id: string,
    input_revision: nullable(string),
    outputs: Array.isArray,
    recorded_at: string,
    evidence_ref: nullable(string),
    classification: string,
    reason: nullable(string),
  });
const snapshot: Predicate = (value) =>
  shape(value, {
    claim_id: string,
    holder: optional(nullable(identity)),
    resource_epoch: optional(nullable(number)),
    released_at: optional(nullable(string)),
    missing: optional((item) => typeof item === 'boolean'),
  });
const handoff: Predicate = (value) =>
  shape(value, {
    schema: string,
    handoff_id: string,
    kind: string,
    subtask_id: nullable(string),
    attempt: nullable(number),
    from: identity,
    to: identity,
    resources: array(string),
    ownership_snapshot: array(snapshot),
    state: string,
    owner_epoch: number,
    created_at: string,
    updated_at: string,
    reason: nullable(string),
    steps: array((item) =>
      shape(item, { state: string, at: string, actor: string }),
    ),
    partial_outputs: Array.isArray,
    inflight: Array.isArray,
    pending_approvals: Array.isArray,
    confirmation_message_id: nullable(string),
    snapshot_at: optional(string),
    previous_coordinator: optional(nullable(coordinator)),
    resource_transfers: optional(
      array((item) =>
        shape(item, {
          claim_id: string,
          resource_epoch: number,
          from: identity,
        }),
      ),
    ),
  });
const notificationEntry: Predicate = (value) =>
  shape(value, {
    notification_id: string,
    key: string,
    kind: string,
    task_id: string,
    subtask_id: nullable(string),
    attempt: nullable(number),
    origin_session: string,
    target_session: string,
    depth: number,
    at: string,
    decision: string,
    reason: nullable(string),
  });

const reservation: Predicate = (value) =>
  shape(value, {
    reservation_id: string,
    subtask_id: string,
    attempt: number,
    kind: string,
    mode: string,
    holder: identity,
    requested_session_id: nullable(string),
    reserved_at: string,
    released_at: nullable(string),
    outcome: nullable(string),
    phase: optional(string),
    pid: optional(number),
    resume_selector: optional(nullable(string)),
    transport: optional(string),
    exit_code: optional(nullable(number)),
    session_id: optional(nullable(string)),
    run_id: optional(nullable(string)),
    detail: optional(nullable(string)),
    identity_status: optional(string),
    expected_identity: optional(nullable(string)),
    observed_identity: optional(nullable(string)),
  });

export function isTaskRecord(value: unknown): value is TaskRecord {
  return shape(value, {
    schema: string,
    task_id: string,
    domain_id: string,
    domain_root: string,
    task_root: string,
    created_at: string,
    updated_at: string,
    state_revision: number,
    coordinator: nullable(coordinator),
    input_revision: nullable(string),
    policy: object,
    attempts: array(attempt),
    messages: array(appliedMessage),
    claims: array(claim),
    handoffs: array(handoff),
    uncertainty: array(uncertainty),
    results: array(result),
    native: Array.isArray,
    dispatch_frozen: optional((item) => typeof item === 'boolean'),
    dispatch_released_at: optional(string),
    dispatch_released_by: optional(string),
    notifications: optional(array(notificationEntry)),
    notifications_trimmed: optional(number),
    launch_reservations: optional(array(reservation)),
  });
}

export function isLockHolder(value: unknown): value is LockHolder {
  return shape(value, {
    schema: string,
    nonce: string,
    actor: string,
    purpose: string,
    pid: number,
    hostname: string,
    acquired_at: string,
  });
}

export function isMessage(value: unknown): value is Message {
  return shape(value, {
    schema: string,
    message_id: string,
    type: string,
    task_id: string,
    from: identity,
    to: identity,
    reply_to: nullable(string),
    subtask_id: nullable(string),
    attempt: nullable(number),
    owner_epoch: nullable(number),
    created_at: string,
    content_digest: nullable(string),
    body: (body) =>
      shape(body, {
        assignment_ref: optional(nullable(string)),
        assignment_digest: optional(nullable(string)),
        input_revision: optional(nullable(string)),
        approval: optional(approval),
        status: optional(string),
        kind: optional(string),
        phase: optional(string),
        handoff_id: optional(string),
        resources: optional(array(string)),
        reason: optional(nullable(string)),
        outputs: optional(Array.isArray),
        evidence_ref: optional(nullable(string)),
      }),
  });
}

export function isNotification(value: unknown): value is Notification {
  return shape(value, {
    schema: string,
    kind: string,
    origin_session: string,
    target_session: string,
    task_id: string,
    depth: optional(number),
    subtask_id: optional(nullable(string)),
    attempt: optional(nullable(number)),
  });
}
