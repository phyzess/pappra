/** Legacy protocol data. Unknown extension fields are preserved without being executed. */
export interface Identity {
  agent_id: string;
  session_id: string;
  harness: string | null;
  cwd?: string;
}

export interface Coordinator extends Identity {
  owner_epoch: number;
  since: string;
  previous?: Pick<
    Coordinator,
    'agent_id' | 'session_id' | 'owner_epoch'
  > | null;
}

export interface ResourceInput {
  kind?: string;
  path?: string;
  scope?: string;
  port?: number;
  value?: string;
  label?: string;
  origin?: string;
  derived?: boolean;
  shared?: boolean;
}

export interface Resource {
  kind: string;
  scope: string;
  key: string;
  path?: string | null;
  port?: number | null;
  existing?: boolean;
  label: string;
  origin?: string;
  derived_from?: string | null;
}

export interface Claim extends Resource {
  claim_id: string;
  access: string;
  holder: Identity;
  resource_epoch: number;
  claimed_at: string;
  released_at: string | null;
  subtask_id: string | null;
  attempt: number | null;
  note: string | null;
  cancel_pending?: boolean;
  released_by?: string;
  release_reason?: string | null;
  transferred_from?: Identity;
  transferred_at?: string;
}

export interface MessageBody {
  [key: string]: unknown;
  assignment_ref?: string | null;
  assignment_digest?: string | null;
  input_revision?: string | null;
  approval?: { approved_by: string; reason: string };
  status?: string;
  kind?: string;
  phase?: string;
  handoff_id?: string;
  resources?: string[];
  reason?: string | null;
  outputs?: unknown[];
  native_ref?: unknown;
  evidence_ref?: string | null;
  stop_evidence?: unknown;
}

export interface Message {
  [key: string]: unknown;
  schema: string;
  message_id: string;
  type: string;
  task_id: string;
  from: Identity;
  to: Identity;
  reply_to: string | null;
  subtask_id: string | null;
  attempt: number | null;
  owner_epoch: number | null;
  created_at: string;
  content_digest: string | null;
  body: MessageBody;
}

export type MessageInput = Pick<Message, 'type' | 'task_id' | 'from' | 'to'> &
  Partial<
    Pick<
      Message,
      | 'message_id'
      | 'reply_to'
      | 'subtask_id'
      | 'attempt'
      | 'owner_epoch'
      | 'created_at'
      | 'body'
    >
  >;

/** Reference to a registered/applied cancellation intent; it conveys no native ownership. */
export interface CancellationIntentReference {
  readonly messageId: string;
  readonly contentDigest: string;
  readonly fileDigest: string;
}

export interface Transition {
  from: string | null;
  to: string;
  at: string;
  actor: string;
  reason: string | null;
  evidence: unknown;
  forced?: boolean | undefined;
}

export interface NativeBinding {
  runner: string | null;
  session_id: string | null;
  run_id: string | null;
  mission_id: string | null;
  observation: string;
  observed_at: string | null;
  evidence_ref: string | null;
  manager?: string;
  launch_kind?: string;
  mode?: string;
  identity_status?: string;
}

export interface Attempt {
  subtask_id: string;
  attempt: number;
  state: string;
  owner_epoch: number | null;
  assignee: Identity;
  assignment_message_id: string;
  assignment_ref: string | null;
  assignment_digest: string | null;
  input_revision: string | null;
  created_at: string;
  updated_at: string;
  native: NativeBinding;
  approval: MessageBody['approval'] | null;
  transitions: Transition[];
  closed_at?: string;
  awaiting?: string;
  ownership?: string;
  cancel_requested_at?: string;
  cwd?: string;
}

export interface ResultEntry {
  schema: string;
  subtask_id: string;
  attempt: number;
  status: string;
  message_id: string;
  input_revision: string | null;
  outputs: unknown[];
  native_ref: unknown;
  recorded_at: string;
  evidence_ref: string | null;
  classification: string;
  reason: string | null;
}

export interface Uncertainty {
  uncertainty_id: string;
  kind: string;
  subtask_id: string | null;
  attempt: number | null;
  detail: string | null;
  evidence_ref: string | null;
  resolution_hint: string | null;
  opened_at: string;
  resolved_at: string | null;
  resolution: string | null;
  resolution_evidence: unknown;
  auto_restart: boolean;
  resolved_by?: string;
  resolution_source?: string;
}

export interface OwnershipSnapshot {
  claim_id: string;
  holder?: Identity | null;
  resource_epoch?: number | null;
  released_at?: string | null;
  missing?: boolean;
}

export interface HandoffStep {
  [key: string]: unknown;
  state: string;
  at: string;
  actor: string;
}

export interface Handoff {
  schema: string;
  handoff_id: string;
  kind: string;
  subtask_id: string | null;
  attempt: number | null;
  from: Identity;
  to: Identity;
  resources: string[];
  ownership_snapshot: OwnershipSnapshot[];
  state: string;
  owner_epoch: number;
  created_at: string;
  updated_at: string;
  reason: string | null;
  steps: HandoffStep[];
  partial_outputs: unknown[];
  inflight: unknown[];
  pending_approvals: unknown[];
  confirmation_message_id: string | null;
  snapshot_at?: string;
  previous_coordinator?: Coordinator | null;
  resource_transfers?: {
    claim_id: string;
    resource_epoch: number;
    from: Identity;
  }[];
}

export interface AppliedMessage {
  message_id: string;
  type: string;
  subtask_id: string | null;
  attempt: number | null;
  from: Identity;
  to: Identity | null;
  reply_to: string | null;
  owner_epoch: number | null;
  content_digest: string;
  at: string;
  applied_at: string;
  state: string;
  detail: string;
  body_kind: string | null;
}

export interface Notification {
  schema: string;
  kind: string;
  origin_session: string;
  target_session: string;
  depth?: number;
  task_id: string;
  subtask_id?: string | null;
  attempt?: number | null;
  event?: unknown;
}

export interface NotificationEntry {
  notification_id: string;
  key: string;
  kind: string;
  task_id: string;
  subtask_id: string | null;
  attempt: number | null;
  origin_session: string;
  target_session: string;
  depth: number;
  at: string;
  decision: string;
  reason: string | null;
}

/** Bounded writer-rollover records retained on the task record. */

export interface RolloverClaimReference {
  claim_id: string;
  resource_epoch: number;
}

export interface RolloverBundleReference {
  ref: string;
  digest: string;
}

/** The native session identity of one writer; never inferred from another pointer. */
export interface RolloverNativeIdentity {
  agent_id: string | null;
  runner: string | null;
  session_id: string | null;
  run_id: string | null;
  mission_id: string | null;
}

/** Explicit captured boundary for post-transfer correlation (message application order). */
export interface RolloverTransferBoundary {
  message_count: number;
  state_revision: number;
  at: string;
}

/** Recorded quiescence evidence and the exact inventory it was recorded with. */
export interface RolloverPreparedStep {
  evidence_ref: string;
  inventory: string;
  at: string;
}

/**
 * Immutable intent inputs for one writer rollover. `transfer_boundary` and `old_native` are
 * completion annotations; the intent inputs themselves are never rewritten.
 */
export interface RolloverIntent {
  schema: string;
  intent_id: string;
  generation: number;
  task_id: string;
  handoff_id: string;
  subtask_id: string;
  attempt: number;
  input_revision: string;
  coordinator_epoch: number;
  from: Identity;
  to: Identity;
  claims: RolloverClaimReference[];
  bundle: RolloverBundleReference;
  created_at: string;
  /** Confirmed source native identity pinned at intent creation. */
  source_native: RolloverNativeIdentity;
  prepared?: RolloverPreparedStep | null;
  transfer_boundary?: RolloverTransferBoundary | null;
  successor_native?: RolloverNativeIdentity | null;
}

/**
 * Source-session history marker. It archives the old native identity, never the reassigned
 * attempt, and never claims that active routing was removed.
 */
export interface SuccessionEntry {
  schema: string;
  intent_id: string;
  handoff_id: string;
  generation: number;
  old_native: RolloverNativeIdentity;
  successor_native: RolloverNativeIdentity;
  archived_at: string;
  history_retained: true;
  routing: 'pending';
  native_archive: 'unavailable';
  proof: { message_id: string; digest: string };
}

export interface TaskRecord {
  [key: string]: unknown;
  schema: string;
  task_id: string;
  domain_id: string;
  domain_root: string;
  task_root: string;
  created_at: string;
  updated_at: string;
  state_revision: number;
  coordinator: Coordinator | null;
  input_revision: string | null;
  policy: { [key: string]: unknown };
  attempts: Attempt[];
  messages: AppliedMessage[];
  claims: Claim[];
  handoffs: Handoff[];
  uncertainty: Uncertainty[];
  results: ResultEntry[];
  native: unknown[];
  dispatch_frozen?: boolean;
  dispatch_released_at?: string;
  dispatch_released_by?: string;
  notifications?: NotificationEntry[];
  notifications_trimmed?: number;
  launch_reservations?: LaunchReservation[];
  rollover?: RolloverIntent[];
  successions?: SuccessionEntry[];
}

export interface ReservationInput {
  reservation_id: string;
  subtask_id: string;
  attempt: number;
  kind: string;
  mode: string;
  holder: Identity;
  requested_session_id: string | null;
  phase?: string;
  pid?: number;
  resume_selector?: string | null;
  transport?: string;
  [key: string]: unknown;
}
export interface LaunchReservation extends ReservationInput {
  reserved_at: string;
  released_at: string | null;
  outcome: string | null;
  exit_code?: number | null;
  session_id?: string | null;
  run_id?: string | null;
  detail?: string | null;
  identity_status?: string;
  expected_identity?: string | null;
  observed_identity?: string | null;
}

export interface Failure {
  ok: false;
  reason: string;
  record?: never;
  result?: never;
  commit?: never;
  [key: string]: unknown;
}

export interface UnreadableRecord {
  task_id: string;
  __unreadable: true;
  claims: Claim[];
}

export interface Mutation<T = unknown> {
  ok?: boolean;
  commit?: boolean;
  record: TaskRecord;
  op?: string;
  summary?: unknown;
  result?: T;
  [key: string]: unknown;
}

export interface MessageEffect {
  [key: string]: unknown;
  entry?: ResultEntry;
}

export type TransactionResult<T> =
  | { ok: true; state_revision: number; result: T | null; op: string }
  | { ok: false; reason: string; [key: string]: unknown };

export interface LockHolder {
  schema: string;
  nonce: string;
  actor: string;
  purpose: string;
  pid: number;
  hostname: string;
  acquired_at: string;
}

export interface TransactionFile {
  file: string;
  revision: unknown;
  purpose: unknown;
  actor: unknown;
}

export interface Finding {
  code: string;
  severity: string;
  detail: string;
  [key: string]: unknown;
}
