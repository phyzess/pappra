import { z } from 'zod';

const taskId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith('/'), {
    message: 'path must be absolute',
  });
const identity = z.strictObject({
  agent_id: z.string().min(1).max(128),
  session_id: z.string().min(1).max(256),
  harness: z.string().min(1).max(64),
});
const requirements = z.strictObject({
  skills: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        bundle_digest: z.string().min(1),
      }),
    )
    .max(16),
  tools: z.array(z.string().min(1).max(128)).max(32),
});
const resource = z.strictObject({
  path: absolutePath,
  access: z.enum(['read', 'write']),
});
const roles = z
  .array(z.string().min(1).max(64))
  .min(1)
  .max(8)
  .refine((entries) => new Set(entries).size === entries.length, {
    message: 'roles must be unique',
  });
export const collaborationGoalSchema = z.strictObject({
  schema: z.literal('pappra/collaboration-goal/1'),
  task_id: taskId,
  subtask_id: taskId,
  attempt: z.number().int().min(1).max(1000),
  phase: z.enum(['discovery', 'implementation', 'review', 'handoff', 'fix']),
  objective: z.string().min(1).max(4000),
  acceptance: z.array(z.string().min(1).max(1000)).min(1).max(32),
  prompt: z.string().min(1).max(20000),
  roles: roles.default(['implementer']),
  coordinator: identity.extend({ owner_epoch: z.number().int().min(1) }),
  assignee: identity.extend({
    cwd: absolutePath,
    surface: z.string().min(1).max(64),
    configuration_id: z.string().min(1).max(128),
  }),
  resources: z.array(resource).min(1).max(32),
  required: requirements,
  preferred: requirements.default({ skills: [], tools: [] }),
});
export type CollaborationGoal = z.infer<typeof collaborationGoalSchema>;

export const collaborationPreparedSchema = z.strictObject({
  schema: z.literal('pappra/collaboration-prepared/1'),
  task_id: taskId,
  subtask_id: taskId,
  attempt: z.number().int().min(1),
  phase: z.string().min(1).max(32),
  task_root: absolutePath,
  domain_root: absolutePath,
  prepared_dir: absolutePath,
  assignment_path: absolutePath,
  prompt_path: absolutePath,
  goal_path: absolutePath,
  assignment_digest: z.string().min(1),
  prompt_digest: z.string().min(1),
  resource_epochs: z.record(z.string(), z.number().int().min(1)),
  claim_ids: z.array(z.string().min(1)).max(64),
  state_revision: z.number().int().min(0),
  created_at: z.string().min(1),
});
export type CollaborationPrepared = z.infer<typeof collaborationPreparedSchema>;

export const collaborationCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({
    schema: z.literal('pappra/collaboration-command/1'),
    action: z.literal('query'),
    request_id: z.string().min(1).max(128),
  }),
  z.strictObject({
    schema: z.literal('pappra/collaboration-command/1'),
    action: z.literal('cancel'),
    request_id: z.string().min(1).max(128),
  }),
  z.strictObject({
    schema: z.literal('pappra/collaboration-command/1'),
    action: z.literal('finish'),
    request_id: z.string().min(1).max(128),
    status: z.enum([
      'completed',
      'failed',
      'cancelled',
      'needs_input',
      'unknown',
    ]),
    outputs: z.array(z.unknown()).max(32).default([]),
    native_ref: z.unknown().nullable().default(null),
    evidence_ref: z.string().max(4096).nullable().default(null),
  }),
]);
export type CollaborationCommand = z.infer<typeof collaborationCommandSchema>;

export const collaborationEventSchema = z.strictObject({
  schema: z.literal('pappra/collaboration-event/1'),
  sequence: z.number().int().min(1),
  request_id: z.string().min(1).max(128).nullable(),
  kind: z.enum(['started', 'query', 'cancel', 'finished', 'refused', 'report']),
  at: z.string().min(1),
  status: z.string().min(1).max(64),
  detail: z.string().max(4096).nullable(),
  data: z.unknown().nullable(),
});
export type CollaborationEvent = z.infer<typeof collaborationEventSchema>;

/**
 * Task-scoped resource request. Claims use the existing canonical resource
 * kinds/semantics; release names one explicit claim and holder. Free-form
 * request bodies are never echoed in diagnostics.
 */
export const COLLAB_RESOURCE_REQUEST_SCHEMA =
  'pappra/collaboration-resource-request/1';

const resourceHolder = z.strictObject({
  agent_id: z.string().min(1).max(128),
  session_id: z.string().min(1).max(256),
  harness: z.string().min(1).max(64).nullable().optional(),
});

const pathResourceKind = z.enum([
  'path',
  'git-index',
  'git-head',
  'git-common-dir',
  'build-cache',
  'file',
]);
const pathResource = z.strictObject({
  kind: pathResourceKind,
  path: absolutePath,
  scope: z.enum(['file', 'tree']).optional(),
  label: z.string().min(1).max(512).optional(),
});
const defaultPathResource = z.strictObject({
  path: absolutePath,
  scope: z.enum(['file', 'tree']).optional(),
  label: z.string().min(1).max(512).optional(),
});
const portResource = z.strictObject({
  kind: z.literal('port'),
  port: z.number().int().min(1).max(65535),
  label: z.string().min(1).max(512).optional(),
});
const opaqueResource = z.strictObject({
  kind: z.enum(['opaque', 'process']),
  value: z.string().min(1).max(4096),
  label: z.string().min(1).max(512).optional(),
});
const requestResource = z.union([
  defaultPathResource,
  pathResource,
  portResource,
  opaqueResource,
]);

export const collaborationResourceRequestSchema = z.discriminatedUnion(
  'action',
  [
    z.strictObject({
      schema: z.literal(COLLAB_RESOURCE_REQUEST_SCHEMA),
      action: z.literal('claim'),
      holder: resourceHolder,
      resources: z.array(requestResource).min(1).max(256),
      access: z.enum(['read', 'write']),
      include_shared_git: z.boolean().optional(),
      note: z.string().max(4096).nullable().optional(),
      subtask_id: z.string().min(1).max(128).nullable().optional(),
      attempt: z.number().int().min(1).optional(),
    }),
    z.strictObject({
      schema: z.literal(COLLAB_RESOURCE_REQUEST_SCHEMA),
      action: z.literal('release'),
      holder: resourceHolder,
      claim_id: z.string().min(1).max(512),
      reason: z.string().max(4096).nullable().optional(),
    }),
  ],
);
export type CollaborationResourceRequest = z.infer<
  typeof collaborationResourceRequestSchema
>;

/**
 * Recorded handoff requests. Action fields map directly to the existing
 * handoff primitives; actor/owner_epoch are editable protocol inputs, not
 * authentication. No clock or inline confirmation envelope is accepted.
 */
export const COLLAB_HANDOFF_REQUEST_SCHEMA =
  'pappra/collaboration-handoff-request/1';

const handoffIdentity = z.strictObject({
  agent_id: z.string().min(1).max(128),
  session_id: z.string().min(1).max(256),
  harness: z.string().min(1).max(64).nullable().optional(),
});
const handoffBase = {
  schema: z.literal(COLLAB_HANDOFF_REQUEST_SCHEMA),
  actor: z.string().min(1).max(128),
  owner_epoch: z.number().int().min(1),
  expect_revision: z.number().int().min(0).optional(),
};
const handoffId = z.string().min(1).max(256);
const evidenceRef = z.string().min(1).max(4096);
const handoffReason = z.string().max(4096).nullable().optional();
const handoffInventoryList = z.array(z.unknown()).max(128).optional();

export const collaborationHandoffRequestSchema = z.discriminatedUnion(
  'action',
  [
    z.strictObject({
      ...handoffBase,
      action: z.literal('begin'),
      handoff_id: handoffId,
      kind: z.enum(['writer', 'coordinator']),
      from: handoffIdentity,
      to: handoffIdentity,
      resources: z.array(z.string().min(1).max(256)).max(64).optional(),
      subtask_id: z.string().min(1).max(128).nullable().optional(),
      attempt: z.number().int().min(1).optional(),
      reason: handoffReason,
    }),
    z.strictObject({
      ...handoffBase,
      action: z.literal('stopped'),
      handoff_id: handoffId,
      observation: z.string().min(1).max(128),
      evidence_ref: evidenceRef,
      detail: z.string().max(4096).nullable().optional(),
    }),
    z.strictObject({
      ...handoffBase,
      action: z.literal('rebind'),
      handoff_id: handoffId,
      to: handoffIdentity,
      evidence_ref: evidenceRef,
    }),
    z.strictObject({
      ...handoffBase,
      action: z.literal('transfer'),
      handoff_id: handoffId,
      partial_outputs: handoffInventoryList,
      inflight: handoffInventoryList,
      pending_approvals: handoffInventoryList,
    }),
    z.strictObject({
      ...handoffBase,
      action: z.literal('confirm'),
      handoff_id: handoffId,
      confirmation_message_id: z.string().min(1).max(256),
    }),
    z.strictObject({
      ...handoffBase,
      action: z.literal('complete'),
      handoff_id: handoffId,
    }),
    z.strictObject({
      ...handoffBase,
      action: z.literal('abort'),
      handoff_id: handoffId,
      reason: handoffReason,
    }),
    z.strictObject({
      ...handoffBase,
      action: z.literal('release-dispatch'),
    }),
  ],
);
export type CollaborationHandoffRequest = z.infer<
  typeof collaborationHandoffRequestSchema
>;

/**
 * Explicit recovery requests: reconcile one uncertainty and optionally apply an
 * existing state transition atomically, or break one task write lock after an
 * operator stop assertion and an exact inspected fingerprint.
 */
export const COLLAB_RECOVERY_REQUEST_SCHEMA =
  'pappra/collaboration-recovery-request/1';

const recoveryBase = {
  schema: z.literal(COLLAB_RECOVERY_REQUEST_SCHEMA),
  actor: z.string().min(1).max(128),
  owner_epoch: z.number().int().min(1),
};
const attemptState = z.enum([
  'assigned',
  'accepted',
  'running',
  'completed',
  'needs_input',
  'failed',
  'cancelled',
  'unknown',
]);

export const collaborationRecoveryRequestSchema = z.discriminatedUnion(
  'action',
  [
    z.strictObject({
      ...recoveryBase,
      action: z.literal('reconcile'),
      uncertainty_id: z.string().min(1).max(128),
      resolution: z.string().min(1).max(4096),
      resolution_evidence: z.string().min(1).max(4096),
      expect_revision: z.number().int().min(0).optional(),
      set_state: attemptState.optional(),
    }),
    z.strictObject({
      ...recoveryBase,
      action: z.literal('lock-break'),
      reason: z.string().min(1).max(4096),
      confirm_holder_stopped: z.literal(true),
      expected_lock_fingerprint: z.string().min(1).max(128),
    }),
  ],
);
export type CollaborationRecoveryRequest = z.infer<
  typeof collaborationRecoveryRequestSchema
>;
/**
 * Task-local routing metadata for explicit notification. A binding maps exact
 * protocol participants to named Herdr agents; it grants no authority and is not
 * proof that a native session exists.
 */
export const COLLAB_BINDING_SCHEMA = 'pappra/collab-binding/1';
export const COLLAB_DELIVERY_SCHEMA = 'pappra/collab-delivery/1';

const herdrPaneId = z
  .string()
  .regex(/^[A-Za-z0-9]+:p[A-Za-z0-9]+$/, 'Use a Herdr pane id such as w3:p3.');
const participantId = z.string().min(1).max(128);

export const collabBindingParticipantSchema = z.strictObject({
  agent_id: participantId,
  harness: z.string().min(1).max(64),
  cwd: absolutePath,
  herdr_agent: z.string().min(1).max(128),
  pane_id: herdrPaneId,
  native_session_id: z.string().min(1).max(256).nullable(),
});
export type CollabBindingParticipant = z.infer<
  typeof collabBindingParticipantSchema
>;

export const collabBindingSchema = z.strictObject({
  schema: z.literal(COLLAB_BINDING_SCHEMA),
  task_id: participantId,
  task_root: absolutePath,
  channel: z.literal('herdr'),
  participants: z.array(collabBindingParticipantSchema).min(1).max(16),
});
export type CollabBinding = z.infer<typeof collabBindingSchema>;

export const collabDeliveryStatusSchema = z.enum([
  'submitting',
  'submitted',
  'blocked',
  'refused',
  'unknown',
  'failed',
]);
export type CollabDeliveryStatus = z.infer<typeof collabDeliveryStatusSchema>;

export const COLLAB_DELIVERY_OBSERVATION_SCHEMA =
  'pappra/collab-delivery-observation/1';

/**
 * What a receipt observation may conclude about *this* pointer.
 *
 * `taken` and `not_taken` are message-level receipts: they require evidence that
 * correlates an observed state change with the one message that was delivered.
 * `unknown` is everything a transport cannot attribute to this pointer.
 *
 * No supported transport provides message-level correlation — the Herdr roster
 * read reports agent-level status and counters, so a turn that starts may have
 * been started by this pointer, by another message or by a human, and a pointer
 * sitting unsubmitted looks identical to one that was never typed. The
 * observation therefore records `unknown` with the activity it did observe, and
 * never emits `taken` or `not_taken` from roster signals. None of the three
 * values is consumption, acknowledgement or acceptance.
 */
export const collabDeliveryReceiptSchema = z.enum([
  'taken',
  'not_taken',
  'unknown',
]);
export type CollabDeliveryReceipt = z.infer<typeof collabDeliveryReceiptSchema>;

/**
 * Closed reason codes. Each names the evidence that produced the receipt value,
 * so a reader never has to infer why a delivery stayed unknown.
 */
export const COLLAB_DELIVERY_OBSERVATION_REASONS = [
  /** A working turn started on the same terminal; not attributable to this pointer. */
  'turn_activity_observed',
  /** No turn started inside the window; a queued or untyped pointer looks the same. */
  'no_turn_activity_observed',
  /** The transport did not report the terminal identity or state counter. */
  'signals_unavailable',
  /** The transport outcome does not establish that anything was submitted. */
  'submission_not_established',
  /** The recipient was already mid-turn when the pointer arrived. */
  'recipient_already_working',
  /** The recipient's agent was blocked; a blocked UI is never answered. */
  'recipient_blocked',
  /** The recipient reported no usable agent state. */
  'recipient_state_unknown',
  /** The recipient was launching or not ready for input. */
  'recipient_not_ready',
  /** The named recipient is no longer in the roster. */
  'target_missing',
  /** The name now resolves to a different pane or harness. */
  'target_identity_changed',
  /** The reported native session is not the one the message targets. */
  'target_session_changed',
  /** The terminal identity changed, so the program was restarted. */
  'terminal_changed',
  /** A sample carried a state without the counters needed to compare it. */
  'evidence_incomplete',
  /** A probe failed; receipt stays unproven. */
  'probe_failed',
  /** The window ended before the planned samples were collected. */
  'window_expired',
  /** The state moved, but not into a working turn (for example blocked). */
  'recipient_state_changed',
  /** Counters moved without an observed turn; a redraw is not proof. */
  'unattributed_activity',
] as const;
export const collabDeliveryObservationReasonSchema = z.enum(
  COLLAB_DELIVERY_OBSERVATION_REASONS,
);
export type CollabDeliveryObservationReason = z.infer<
  typeof collabDeliveryObservationReasonSchema
>;

/**
 * One transport reading of the recipient. Null means the transport did not
 * report that signal for this reading; it is never treated as zero or false.
 */
export const collabDeliveryAgentStateSchema = z.strictObject({
  observed_at: z.string().min(1),
  agent_status: z.string().min(1).max(64),
  terminal_id: z.string().min(1).max(256).nullable(),
  state_change_seq: z.number().int().min(0).nullable(),
  completion_seq: z.number().int().min(0).nullable(),
  revision: z.number().int().min(0).nullable(),
  interactive_ready: z.boolean().nullable(),
  launch_pending: z.boolean().nullable(),
});
export type CollabDeliveryAgentState = z.infer<
  typeof collabDeliveryAgentStateSchema
>;

/**
 * Receipt evidence recorded beside a delivery attempt. It is an observation, not
 * a status: `submitted` keeps its meaning whatever the receipt says, including
 * the `unknown` every roster-signal observation records.
 */
export const collabDeliveryObservationSchema = z.strictObject({
  schema: z.literal(COLLAB_DELIVERY_OBSERVATION_SCHEMA),
  receipt: collabDeliveryReceiptSchema,
  reason: collabDeliveryObservationReasonSchema,
  /** Which transport signal family produced the receipt. */
  source: z.literal('herdr-agent-state'),
  started_at: z.string().min(1),
  ended_at: z.string().min(1),
  window_ms: z.number().int().min(0).max(600_000),
  samples: z.number().int().min(0).max(8),
  before: collabDeliveryAgentStateSchema,
  after: collabDeliveryAgentStateSchema.nullable(),
  detail: z.string().max(1024).nullable(),
});
export type CollabDeliveryObservation = z.infer<
  typeof collabDeliveryObservationSchema
>;

export const collabDeliveryAttemptSchema = z.strictObject({
  at: z.string().min(1),
  status: collabDeliveryStatusSchema,
  detail: z.string().max(4096).nullable(),
  /** Present for attempts reserved after the C0 repair; older evidence omits it. */
  reservation_id: z.string().min(1).max(64).optional(),
  /**
   * Present for attempts recorded after #20; older evidence omits it, and an
   * absent observation is unobserved, never retroactively `unknown`-rewritten.
   */
  observation: collabDeliveryObservationSchema.optional(),
});
export type CollabDeliveryAttempt = z.infer<typeof collabDeliveryAttemptSchema>;
/**
 * Optional caller-routing evidence. Selecting a pane (current or explicit) is
 * routing, not sender authentication: process affiliation is not established.
 */
export const collabDeliveryCallerSchema = z.strictObject({
  source: z.enum(['current', 'explicit']),
  pane_id: herdrPaneId,
  harness: z.string().min(1).max(64).nullable(),
  cwd: z.string().min(1).max(4096).nullable(),
  observed_at: z.string().min(1),
  native_session: z.enum(['match', 'unknown']),
  native_session_kind: z.string().min(1).max(64).nullable(),
  process_affiliation: z.literal('not-established'),
});
export type CollabDeliveryCaller = z.infer<typeof collabDeliveryCallerSchema>;
export const collabDeliverySchema = z.strictObject({
  schema: z.literal(COLLAB_DELIVERY_SCHEMA),
  message_id: participantId,
  message_path: z.string().min(1).max(4096),
  message_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  task_id: participantId,
  task_root: absolutePath,
  recipient: z.strictObject({
    agent_id: participantId,
    harness: z.string().min(1).max(64),
  }),
  target: z.strictObject({
    herdr_agent: z.string().min(1).max(128),
    pane_id: herdrPaneId,
    native_session: z.enum(['match', 'unknown']),
    /** Reported Herdr session kind (`path`, `id`, ...); older evidence omits it. */
    native_session_kind: z.string().min(1).max(64).nullable().optional(),
  }),
  /** Present for caller-routing evidence recorded after C1; older records omit it. */
  caller: collabDeliveryCallerSchema.optional(),
  status: collabDeliveryStatusSchema,
  attempts: z.array(collabDeliveryAttemptSchema).max(8),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});
export type CollabDelivery = z.infer<typeof collabDeliverySchema>;
