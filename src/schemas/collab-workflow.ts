import path from 'node:path';
import { z } from 'zod';

/**
 * Typed orchestration facade documents.
 *
 * These schemas describe caller input only. They never describe authority: attempts, claims,
 * messages, capability cards and acceptances stay in the task record and are reached through
 * the existing engines. Validation is a Zod `strictObject` contract so the facade does not
 * grow a second, weaker validator next to the shared schemas.
 */

export const WORKFLOW_PREPARE_REQUEST_SCHEMA =
  'pappra/collab-workflow-prepare-request/1';
export const WORKFLOW_DISPATCH_REQUEST_SCHEMA =
  'pappra/collab-workflow-dispatch-request/1';
export const WORKFLOW_PARTICIPANT_REQUEST_SCHEMA =
  'pappra/collab-workflow-participant-request/1';
export const WORKFLOW_RECLAIM_REQUEST_SCHEMA =
  'pappra/collab-workflow-reclaim-request/1';
export const WORKFLOW_ADOPT_REQUEST_SCHEMA =
  'pappra/collab-workflow-adopt-request/1';
export const WORKFLOW_ACCEPT_REQUEST_SCHEMA =
  'pappra/collab-workflow-accept-request/1';
export const WORKFLOW_ACCEPT_BATCH_REQUEST_SCHEMA =
  'pappra/collab-workflow-accept-batch-request/1';
/** A batch is N explicit decisions in one invocation, not a blanket approval. */
export const WORKFLOW_MAX_ACCEPT_BATCH = 32;
export const WORKFLOW_MANIFEST_SCHEMA = 'pappra/collab-workflow-manifest/1';
export const WORKFLOW_PLAN_SCHEMA = 'pappra/collab-workflow-plan/1';
export const WORKFLOW_RESULT_SCHEMA = 'pappra/collab-workflow-result/1';
export const WORKFLOW_MANIFEST_VERSION = 1;
export const WORKFLOW_WORK_PLAN_FILE = 'work-plan.json';

/** Work-plan nodes cap at 16 resources; a sealed assignment must fit that bound. */
export const WORKFLOW_MAX_DECLARED_RESOURCES = 16;
export const WORKFLOW_MAX_ASSIGNMENTS = 64;
export const WORKFLOW_MAX_PARTICIPANTS = 64;
export const WORKFLOW_MAX_BINDINGS = 64;
export const WORKFLOW_MAX_STRING = 2048;
export const WORKFLOW_MAX_OBJECTIVE = 8192;
export const WORKFLOW_MAX_ACCEPTANCE = 32;
export const WORKFLOW_MAX_CARDS = 64;
/** Never widened past the shared preflight default; a caller may only tighten it. */
export const WORKFLOW_MAX_CARD_AGE_MINUTES = 30;

export const WORKFLOW_ROLES = ['writer', 'reviewer'] as const;
export type WorkflowRole = (typeof WORKFLOW_ROLES)[number];

export const WORKFLOW_RESOURCE_ACCESS = ['read', 'write'] as const;
export type WorkflowAccess = (typeof WORKFLOW_RESOURCE_ACCESS)[number];

export const WORKFLOW_REPORT_STATUSES = [
  'running',
  'completed',
  'needs_input',
  'failed',
  'cancelled',
] as const;
export type WorkflowReportStatus = (typeof WORKFLOW_REPORT_STATUSES)[number];

/**
 * Protocol-specific typed failure: it reuses the shared `Outcome` generic but keeps the
 * workflow's own detail fields instead of widening the global diagnostic union.
 */
export interface WorkflowFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly nextAction: string | null;
}

export type WorkflowValid<T> =
  { readonly ok: true; readonly value: T } | WorkflowFailure;

const safeId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must be a safe identifier');
const digest = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, 'must be a sha256 digest');
const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value), 'must be an absolute path')
  .refine((value) => !value.includes('\u0000'), 'must not contain NUL');
const agentId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must be a safe agent id');
const sessionId = z
  .string()
  .min(1)
  .max(192)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'must be a safe session id');
const paneId = z
  .string()
  .regex(/^[A-Za-z0-9]+:p[A-Za-z0-9]+$/, 'must look like w3:p3K');
const boundedText = (max = WORKFLOW_MAX_STRING) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !value.includes('\u0000'), 'must not contain NUL');
const uniqueStrings = (max: number) =>
  z
    .array(boundedText())
    .max(max)
    .refine(
      (items) => new Set(items).size === items.length,
      'entries must be unique',
    );

export const workflowCallerSchema = z.strictObject({
  agent_id: agentId,
  session_id: sessionId,
  harness: boundedText(64),
  cwd: absolutePath,
});

export const workflowParticipantSchema = workflowCallerSchema.extend({
  surface: boundedText(64),
  configuration_id: boundedText(128),
});

export const workflowCoordinatorSchema = workflowParticipantSchema.extend({
  owner_epoch: z.number().int().min(1),
  since: boundedText(64).optional(),
});

const herdrAgentName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must be a safe Herdr agent name');

export const workflowBindingSchema = z.strictObject({
  agent_id: agentId,
  pane_id: paneId,
  native_session_id: sessionId.nullable(),
  /**
   * Optional live Herdr agent name when it differs from the agent id. An absent name
   * keeps the sealed default (the agent id itself), so existing requests and their
   * derived sealed bytes stay byte-identical.
   */
  herdr_agent: herdrAgentName.optional(),
});

export const WORKFLOW_RESOURCE_SCOPES = ['file', 'tree'] as const;
export type WorkflowResourceScope = (typeof WORKFLOW_RESOURCE_SCOPES)[number];

export const workflowResourceDeclarationSchema = z.strictObject({
  path: absolutePath,
  access: z.enum(WORKFLOW_RESOURCE_ACCESS),
  /**
   * Optional and conservative: an absent scope stays a tree claim (and therefore keeps the
   * derived Git index/HEAD reservation). `file` claims exactly that path when the caller
   * explicitly asserts it is a single file.
   */
  scope: z.enum(WORKFLOW_RESOURCE_SCOPES).optional(),
});

export const workflowSkillRequirementSchema = z.strictObject({
  id: safeId,
  bundle_digest: digest,
});

export const workflowNativeEvidenceSchema = z.strictObject({
  kind: boundedText(64),
  ref: boundedText(4096),
});

export const workflowAssignmentDeclarationSchema = z.strictObject({
  subtask_id: safeId,
  role: z.enum(WORKFLOW_ROLES),
  assignee: agentId,
  objective: boundedText(WORKFLOW_MAX_OBJECTIVE),
  acceptance: uniqueStrings(WORKFLOW_MAX_ACCEPTANCE).refine(
    (items) => items.length > 0,
    'acceptance must state at least one criterion',
  ),
  resources: z
    .array(workflowResourceDeclarationSchema)
    .min(1)
    .max(WORKFLOW_MAX_DECLARED_RESOURCES * 4),
  required_skills: z
    .array(workflowSkillRequirementSchema)
    .max(WORKFLOW_MAX_DECLARED_RESOURCES),
  required_tools: uniqueStrings(WORKFLOW_MAX_DECLARED_RESOURCES),
  native_evidence: z
    .array(workflowNativeEvidenceSchema)
    .max(WORKFLOW_MAX_DECLARED_RESOURCES),
  depends_on: uniqueStrings(WORKFLOW_MAX_ASSIGNMENTS).optional(),
});

export const workflowRunnerSchema = z.strictObject({
  name: boundedText(64),
  mode: boundedText(64),
  profile: boundedText(64).optional(),
});

export const workflowGoalSchema = z.strictObject({
  objective: boundedText(WORKFLOW_MAX_OBJECTIVE),
  input_ref: absolutePath.nullable(),
  input_digest: digest.nullable(),
});

export const workflowPrepareRequestSchema = z
  .strictObject({
    schema: z.literal(WORKFLOW_PREPARE_REQUEST_SCHEMA),
    domain_root: absolutePath,
    task_id: safeId,
    goal: workflowGoalSchema,
    coordinator: workflowCoordinatorSchema,
    participants: z
      .array(workflowParticipantSchema)
      .min(1)
      .max(WORKFLOW_MAX_PARTICIPANTS),
    bindings: z.array(workflowBindingSchema).max(WORKFLOW_MAX_BINDINGS),
    assignments: z
      .array(workflowAssignmentDeclarationSchema)
      .min(1)
      .max(WORKFLOW_MAX_ASSIGNMENTS),
    runner: workflowRunnerSchema,
  })
  .superRefine((value, context) => {
    const participants = new Set(
      value.participants.map((item) => item.agent_id),
    );
    if (participants.size !== value.participants.length)
      context.addIssue({
        code: 'custom',
        path: ['participants'],
        message: 'a participant is declared twice',
      });
    for (const binding of value.bindings) {
      if (
        !participants.has(binding.agent_id) &&
        binding.agent_id !== value.coordinator.agent_id
      )
        context.addIssue({
          code: 'custom',
          path: ['bindings'],
          message: `binding names ${binding.agent_id}, which is neither a declared participant nor the coordinator`,
        });
    }
    const seenBindings = new Set<string>();
    for (const binding of value.bindings) {
      if (seenBindings.has(binding.agent_id))
        context.addIssue({
          code: 'custom',
          path: ['bindings'],
          message: `binding declared twice for ${binding.agent_id}`,
        });
      seenBindings.add(binding.agent_id);
    }
    const subtasks = new Set(value.assignments.map((item) => item.subtask_id));
    if (subtasks.size !== value.assignments.length)
      context.addIssue({
        code: 'custom',
        path: ['assignments'],
        message: 'an assignment subtask_id is declared twice',
      });
    for (const assignment of value.assignments) {
      if (!participants.has(assignment.assignee))
        context.addIssue({
          code: 'custom',
          path: ['assignments'],
          message: `assignment ${assignment.subtask_id} names an undeclared assignee`,
        });
      // A deferred reviewer is sealed without real resource epochs, so a write footprint
      // could never be activated later; refuse it at request validation, not at dispatch.
      if (assignment.role === 'reviewer') {
        const writes = assignment.resources
          .filter((resource) => resource.access === 'write')
          .map((resource) => resource.path);
        if (writes.length > 0)
          context.addIssue({
            code: 'custom',
            path: ['assignments'],
            message: `reviewer ${assignment.subtask_id} declares write resources (${writes.join(', ')}); declare the reviewer read-only, or use a writer role for an assignee that must write`,
          });
      }
      for (const dependency of assignment.depends_on ?? []) {
        if (dependency === assignment.subtask_id || !subtasks.has(dependency))
          context.addIssue({
            code: 'custom',
            path: ['assignments'],
            message: `assignment ${assignment.subtask_id} has an invalid dependency ${dependency}`,
          });
      }
    }
    if ((value.goal.input_ref === null) !== (value.goal.input_digest === null))
      context.addIssue({
        code: 'custom',
        path: ['goal'],
        message: 'goal.input_ref and goal.input_digest are pinned together',
      });
  });

/**
 * One dispatch target. Exactly one source form is accepted:
 *   explicit card        `capabilities_file`
 *   fresh derivation     `template_file` plus the observed native source
 *                        (`session_file` for pi, `events_file` for codex)
 */
export const workflowDispatchTargetSchema = z
  .strictObject({
    subtask_id: safeId,
    attempt: z.number().int().min(1).max(1000),
    capabilities_file: absolutePath.nullable().default(null),
    template_file: absolutePath.nullable().default(null),
    session_file: absolutePath.nullable().default(null),
    events_file: absolutePath.nullable().default(null),
    execution_file: absolutePath.nullable().default(null),
  })
  .superRefine((value, context) => {
    const derived =
      value.template_file !== null &&
      (value.session_file !== null || value.events_file !== null);
    if (value.capabilities_file !== null && derived)
      context.addIssue({
        code: 'custom',
        message:
          'declare either an explicit card or a derivation source, not both',
      });
    if (value.capabilities_file === null && !derived)
      context.addIssue({
        code: 'custom',
        message:
          'declare capabilities_file, or template_file with session_file/events_file so the card is derived from observed native evidence',
      });
    if (value.session_file !== null && value.events_file !== null)
      context.addIssue({
        code: 'custom',
        message: 'declare one native evidence source per target',
      });
    if (value.execution_file !== null && value.capabilities_file !== null)
      context.addIssue({
        code: 'custom',
        message: 'execution_file only applies to a derived card',
      });
  });

export const workflowDispatchRequestSchema = z.strictObject({
  schema: z.literal(WORKFLOW_DISPATCH_REQUEST_SCHEMA),
  task_root: absolutePath,
  caller: workflowCallerSchema,
  caller_pane: paneId,
  capability_targets: z
    .array(workflowDispatchTargetSchema)
    .max(WORKFLOW_MAX_CARDS),
  subtasks: uniqueStrings(WORKFLOW_MAX_ASSIGNMENTS).default([]),
  activate_deferred: z.boolean().default(false),
  max_age_minutes: z
    .number()
    .int()
    .min(1)
    .max(WORKFLOW_MAX_CARD_AGE_MINUTES)
    .default(WORKFLOW_MAX_CARD_AGE_MINUTES),
});

const reportDeclarationSchema = z
  .strictObject({
    status: z.enum(WORKFLOW_REPORT_STATUSES),
    summary: boundedText(WORKFLOW_MAX_OBJECTIVE),
    blockers: uniqueStrings(WORKFLOW_MAX_ACCEPTANCE),
    outputs: uniqueStrings(WORKFLOW_MAX_DECLARED_RESOURCES * 4),
  })
  .superRefine((value, context) => {
    if (value.status === 'needs_input' && value.blockers.length === 0)
      context.addIssue({
        code: 'custom',
        path: ['blockers'],
        message:
          'a needs_input report must state at least one concrete blocker',
      });
    if (value.status !== 'needs_input' && value.blockers.length > 0)
      context.addIssue({
        code: 'custom',
        path: ['blockers'],
        message: 'blockers are only valid with status needs_input',
      });
  });

const releaseDeclarationSchema = z.strictObject({
  reason: boundedText(WORKFLOW_MAX_OBJECTIVE),
  cancel_attempt: z.boolean(),
  /**
   * The registered coordinator ASK/ANSWER this release answers. It is verified against the
   * record before any claim effect, so a release can never be correlated to an invented id.
   */
  correlates_to: safeId.nullable().default(null),
});

export const workflowParticipantRequestSchema = z
  .strictObject({
    schema: z.literal(WORKFLOW_PARTICIPANT_REQUEST_SCHEMA),
    action: z.enum(['ack', 'report', 'release']),
    task_root: absolutePath,
    caller: workflowCallerSchema,
    subtask_id: safeId,
    attempt: z.number().int().min(1).max(1000),
    /** Observed caller pane for notification routing; never an invented identity. */
    caller_pane: paneId.nullable().default(null),
    report: reportDeclarationSchema.nullable(),
    release: releaseDeclarationSchema.nullable(),
  })
  .superRefine((value, context) => {
    if (value.action === 'report') {
      if (value.report === null)
        context.addIssue({
          code: 'custom',
          path: ['report'],
          message: 'a report action requires a report declaration',
        });
      if (value.release !== null)
        context.addIssue({
          code: 'custom',
          path: ['release'],
          message: 'a report must not carry a release declaration',
        });
    } else if (value.action === 'release') {
      if (value.release === null)
        context.addIssue({
          code: 'custom',
          path: ['release'],
          message: 'a release action requires a release declaration',
        });
      if (value.report !== null)
        context.addIssue({
          code: 'custom',
          path: ['report'],
          message: 'a release must not carry a report declaration',
        });
    } else if (value.report !== null || value.release !== null)
      context.addIssue({
        code: 'custom',
        message: 'an ack carries neither a report nor a release declaration',
      });
  });

/**
 * Acceptance deliberately carries no plan or node id: both are resolved from the persisted
 * work plan, so a caller cannot name a node that the plan does not contain.
 */
export const workflowAcceptRequestSchema = z.strictObject({
  schema: z.literal(WORKFLOW_ACCEPT_REQUEST_SCHEMA),
  task_root: absolutePath,
  caller: workflowCallerSchema,
  subtask_id: safeId,
  attempt: z.number().int().min(1).max(1000),
  report_message_id: safeId,
  /** Observed coordinator pane; acceptance notifies through the sealed binding. */
  caller_pane: paneId.nullable().default(null),
  reason: boundedText(WORKFLOW_MAX_OBJECTIVE),
});

/**
 * Several acceptances in one invocation. Every entry names its own report and reason and is
 * validated exactly like a single accept; nothing is inferred from a status or a count.
 */
export const workflowAcceptBatchRequestSchema = z
  .strictObject({
    schema: z.literal(WORKFLOW_ACCEPT_BATCH_REQUEST_SCHEMA),
    task_root: absolutePath,
    caller: workflowCallerSchema,
    caller_pane: paneId.nullable().default(null),
    accepts: z
      .array(
        z.strictObject({
          subtask_id: safeId,
          attempt: z.number().int().min(1).max(1000),
          report_message_id: safeId,
          reason: boundedText(WORKFLOW_MAX_OBJECTIVE),
        }),
      )
      .min(1)
      .max(WORKFLOW_MAX_ACCEPT_BATCH),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const item of value.accepts) {
      const key = `${item.subtask_id}#${item.attempt}`;
      if (seen.has(key))
        ctx.addIssue({
          code: 'custom',
          message: `${key} is accepted more than once in one batch`,
        });
      seen.add(key);
    }
  });

/**
 * Coordinator-only sweep of Pappra-created panes that belong to accepted, released work.
 * It names no pane: eligibility comes only from the task record and live pane identity.
 */
export const workflowReclaimRequestSchema = z.strictObject({
  schema: z.literal(WORKFLOW_RECLAIM_REQUEST_SCHEMA),
  task_root: absolutePath,
  caller: workflowCallerSchema,
  /** Observed coordinator pane; it is never closed. */
  caller_pane: paneId.nullable().default(null),
});

/**
 * The successor coordinator adopts a task after a coordinator succession: it names the pane it
 * runs in, and the facade writes the next binding generation. It changes nothing else.
 */
export const workflowAdoptRequestSchema = z.strictObject({
  schema: z.literal(WORKFLOW_ADOPT_REQUEST_SCHEMA),
  task_root: absolutePath,
  caller: workflowCallerSchema,
  /** The coordinator's own pane; it must be observed through Herdr as this session. */
  caller_pane: paneId,
  /**
   * Optional explicit role plans, role orchestration requests and journals. They live at
   * caller-chosen paths, so adopt can only check the ones named here.
   */
  extra_paths: z
    .array(absolutePath)
    .max(16)
    .refine(
      (items) => new Set(items).size === items.length,
      'entries must be unique',
    )
    .optional(),
});

export type WorkflowCaller = z.infer<typeof workflowCallerSchema>;
export type WorkflowParticipant = z.infer<typeof workflowParticipantSchema>;
export type WorkflowCoordinator = z.infer<typeof workflowCoordinatorSchema>;
export type WorkflowBinding = z.infer<typeof workflowBindingSchema>;
export type WorkflowResourceDeclaration = z.infer<
  typeof workflowResourceDeclarationSchema
>;
export type WorkflowSkillRequirement = z.infer<
  typeof workflowSkillRequirementSchema
>;
export type WorkflowNativeEvidence = z.infer<
  typeof workflowNativeEvidenceSchema
>;
export type WorkflowAssignmentDeclaration = z.infer<
  typeof workflowAssignmentDeclarationSchema
>;
export type WorkflowRunnerDeclaration = z.infer<typeof workflowRunnerSchema>;
export type WorkflowGoal = z.infer<typeof workflowGoalSchema>;
export type WorkflowPrepareRequest = z.infer<
  typeof workflowPrepareRequestSchema
>;
export type WorkflowDispatchTarget = z.infer<
  typeof workflowDispatchTargetSchema
>;
export type WorkflowDispatchRequest = z.infer<
  typeof workflowDispatchRequestSchema
>;
export type WorkflowReportDeclaration = z.infer<typeof reportDeclarationSchema>;
export type WorkflowReleaseDeclaration = z.infer<
  typeof releaseDeclarationSchema
>;
export type WorkflowParticipantRequest = z.infer<
  typeof workflowParticipantRequestSchema
>;
export type WorkflowAcceptRequest = z.infer<typeof workflowAcceptRequestSchema>;
export type WorkflowAcceptBatchRequest = z.infer<
  typeof workflowAcceptBatchRequestSchema
>;
export type WorkflowAdoptRequest = z.infer<typeof workflowAdoptRequestSchema>;
export type WorkflowReclaimRequest = z.infer<
  typeof workflowReclaimRequestSchema
>;

function invalid(
  message: string,
  nextAction: string | null = null,
): WorkflowFailure {
  return {
    ok: false,
    code: 'request_invalid',
    message,
    retryable: false,
    nextAction,
  };
}

function parseWith<T>(
  schema: z.ZodType<T>,
  input: unknown,
  label: string,
): WorkflowValid<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = parsed.error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.join('.') || label}: ${issue.message}`)
    .join('; ');
  return invalid(`${label} is invalid: ${issues}`);
}

/**
 * Duplicate declarations of one target are a caller duplication, not a second resource. They
 * are canonicalized here, preserving first-occurrence order, so the sealed assignment stays
 * the single-entry multiset the work plan compares against. The same target declared with
 * two different access levels is refused: that is a conflict, not a duplicate.
 */
function canonicalizeAssignments(
  value: WorkflowPrepareRequest,
): WorkflowValid<WorkflowPrepareRequest> {
  const assignments: WorkflowAssignmentDeclaration[] = [];
  for (const assignment of value.assignments) {
    const byPath = new Map<string, WorkflowAccess>();
    const resources: WorkflowResourceDeclaration[] = [];
    for (const resource of assignment.resources) {
      const existing = byPath.get(resource.path);
      if (existing !== undefined) {
        if (existing !== resource.access)
          return {
            ok: false,
            code: 'resource_declaration_conflict',
            message: `Assignment ${assignment.subtask_id} declares ${resource.path} as both ${existing} and ${resource.access}.`,
            retryable: false,
            nextAction:
              'Declare one access level per target; conflicting declarations are refused before any effect.',
          };
        continue;
      }
      byPath.set(resource.path, resource.access);
      resources.push(resource);
    }
    if (resources.length > WORKFLOW_MAX_DECLARED_RESOURCES)
      return {
        ok: false,
        code: 'resource_limit_exceeded',
        message: `Assignment ${assignment.subtask_id} declares ${resources.length} unique resources; the work plan supports ${WORKFLOW_MAX_DECLARED_RESOURCES}.`,
        retryable: false,
        nextAction:
          'Split the subtask or drop unrelated targets; the request is refused before any effect.',
      };
    assignments.push({ ...assignment, resources });
  }
  return { ok: true, value: { ...value, assignments } };
}

export function parseWorkflowPrepareRequest(
  input: unknown,
): WorkflowValid<WorkflowPrepareRequest> {
  const parsed = parseWith(
    workflowPrepareRequestSchema,
    input,
    'prepare request',
  );
  if (!parsed.ok) return parsed;
  return canonicalizeAssignments(parsed.value);
}

export function parseWorkflowDispatchRequest(
  input: unknown,
): WorkflowValid<WorkflowDispatchRequest> {
  return parseWith(workflowDispatchRequestSchema, input, 'dispatch request');
}

export function parseWorkflowParticipantRequest(
  input: unknown,
): WorkflowValid<WorkflowParticipantRequest> {
  return parseWith(
    workflowParticipantRequestSchema,
    input,
    'participant request',
  );
}

export function parseWorkflowAcceptRequest(
  input: unknown,
): WorkflowValid<WorkflowAcceptRequest> {
  return parseWith(workflowAcceptRequestSchema, input, 'accept request');
}

export function parseWorkflowAcceptBatchRequest(
  input: unknown,
): WorkflowValid<WorkflowAcceptBatchRequest> {
  return parseWith(
    workflowAcceptBatchRequestSchema,
    input,
    'accept batch request',
  );
}

export function parseWorkflowAdoptRequest(
  input: unknown,
): WorkflowValid<WorkflowAdoptRequest> {
  return parseWith(workflowAdoptRequestSchema, input, 'adopt request');
}

export function parseWorkflowReclaimRequest(
  input: unknown,
): WorkflowValid<WorkflowReclaimRequest> {
  return parseWith(workflowReclaimRequestSchema, input, 'reclaim request');
}

function safePathSegment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value))
    throw new Error('Invalid subtask id for a workflow path');
  return value;
}

export function workflowAssignmentsDir(taskRoot: string): string {
  return path.join(taskRoot, 'workflow', 'assignments');
}

export function workflowAssignmentPath(
  taskRoot: string,
  subtaskId: string,
): string {
  return path.join(
    workflowAssignmentsDir(taskRoot),
    `${safePathSegment(subtaskId)}.json`,
  );
}

export function workflowManifestPath(taskRoot: string): string {
  return path.join(taskRoot, 'workflow', 'manifest.json');
}

export function workflowWorkPlanPath(taskRoot: string): string {
  return path.join(taskRoot, 'workflow', WORKFLOW_WORK_PLAN_FILE);
}

export function workflowBindingPath(taskRoot: string): string {
  return path.join(taskRoot, 'binding.json');
}

export function workflowIntentsDir(taskRoot: string): string {
  return path.join(taskRoot, 'workflow', 'intents');
}
