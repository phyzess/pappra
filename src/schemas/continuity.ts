import { z } from 'zod';

export const TASK_CONTEXT_SCHEMA = 'pappra/task-context/1';
export const CHECKPOINT_SCHEMA = 'pappra/checkpoint/1';
export const CHECKPOINT_POINTER_SCHEMA = 'pappra/checkpoint-pointer/1';
export const RESUME_PACKET_SCHEMA = 'pappra/resume-packet/1';

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
/**
 * One task identifier rule for pin records, continuity paths and schemas:
 * up to 64 characters from letters, digits, dot, dash and underscore, starting
 * with a letter or digit. Invalid identifiers are rejected before any write.
 */
export const TASK_ID_MAX_LENGTH = 64;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const taskIdSchema = z
  .string()
  .min(1)
  .max(TASK_ID_MAX_LENGTH)
  .regex(
    TASK_ID_PATTERN,
    'Use a letter or digit followed by letters, digits, dot, underscore or dash.',
  );

export function isValidTaskId(value: string): boolean {
  return value.length <= TASK_ID_MAX_LENGTH && TASK_ID_PATTERN.test(value);
}
const digestOrNull = digestSchema.nullable();
const optionalString = z.string().max(4096).nullable();

export const continuityArtifactPathSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (value) => !value.includes('\0') && !value.split('/').includes('..'),
    'Artifact path must not contain NUL or parent traversal.',
  );

export const taskContextSchema = z.strictObject({
  schema: z.literal(TASK_CONTEXT_SCHEMA),
  taskId: taskIdSchema,
  workspaceId: z.uuid(),
  objective: z.string().min(1).max(4096),
  acceptance: z.array(z.string().min(1).max(4096)).max(32),
  constraints: z.array(z.string().min(1).max(4096)).max(32),
  artifacts: z.array(continuityArtifactPathSchema).max(64),
  collaborationRecordRef: optionalString,
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});

export type TaskContext = z.infer<typeof taskContextSchema>;

export const checkpointRepositorySchema = z.strictObject({
  repoId: z.string().min(1).max(64),
  checkoutId: z.string().min(1).max(128),
  root: z.string().min(1).max(4096),
  head: z.string().max(256).nullable(),
  branch: z.string().max(256).nullable(),
  dirty: z.boolean().nullable(),
  patchDigest: digestOrNull,
  captureStatus: z.enum(['complete', 'partial', 'unknown']),
  scope: z.enum(['workspace', 'external', 'unknown']),
});

export const checkpointArtifactSchema = z.strictObject({
  path: continuityArtifactPathSchema,
  digest: digestSchema,
  inputVersion: z.string().max(256).nullable(),
  observedAt: z.iso.datetime({ offset: true }),
});

export const checkpointValidationSchema = z.strictObject({
  id: z.string().min(1).max(128),
  result: z.enum(['passed', 'failed', 'not-run', 'unknown']),
  inputVersion: z.string().max(256).nullable(),
  observedAt: z.iso.datetime({ offset: true }),
});

export const checkpointNativeRefSchema = z.strictObject({
  harness: z.enum(['pi', 'codex', 'claude', 'unknown']),
  sessionId: z.string().max(256).nullable(),
  turnId: z.string().max(256).nullable(),
  runId: z.string().max(256).nullable(),
  scope: z.literal('stored-snapshot'),
  observedAt: z.iso.datetime({ offset: true }),
});

export const checkpointSchema = z.strictObject({
  schema: z.literal(CHECKPOINT_SCHEMA),
  checkpointId: z.uuid(),
  taskId: taskIdSchema,
  workspaceId: z.uuid(),
  revision: z.number().int().positive(),
  previousDigest: digestOrNull,
  createdAt: z.iso.datetime({ offset: true }),
  authorSession: z.string().max(256).nullable(),
  objective: z.string().min(1).max(4096),
  acceptance: z.array(z.string().min(1).max(4096)).max(32),
  constraints: z.array(z.string().min(1).max(4096)).max(32),
  decisions: z.array(z.string().min(1).max(4096)).max(64),
  attempted: z.array(z.string().min(1).max(4096)).max(64),
  nextActions: z.array(z.string().min(1).max(4096)).max(64),
  limitations: z.array(z.string().min(1).max(4096)).max(64),
  repositories: z.array(checkpointRepositorySchema).max(64),
  artifacts: z.array(checkpointArtifactSchema).max(64),
  validations: z.array(checkpointValidationSchema).max(64),
  nativeRefs: z.array(checkpointNativeRefSchema).max(32),
  collaborationRecordRef: optionalString,
  contextCompleteness: z.enum(['complete', 'partial']),
});

export type Checkpoint = z.infer<typeof checkpointSchema>;

export const checkpointPointerSchema = z.strictObject({
  schema: z.literal(CHECKPOINT_POINTER_SCHEMA),
  taskId: taskIdSchema,
  workspaceId: z.uuid(),
  revision: z.number().int().positive(),
  checkpointRef: z.string().min(1).max(2048),
  checkpointDigest: digestSchema,
  updatedAt: z.iso.datetime({ offset: true }),
});

export type CheckpointPointer = z.infer<typeof checkpointPointerSchema>;

const identityCheckSchema = z.strictObject({
  name: z.string().min(1).max(128),
  status: z.enum(['ok', 'changed', 'unknown']),
  detail: z.string().max(2048).nullable(),
});

const repositoryDriftSchema = z.strictObject({
  repoId: z.string().min(1).max(64),
  status: z.enum(['unchanged', 'changed', 'relocated', 'missing', 'unknown']),
  storedHead: z.string().max(256).nullable(),
  currentHead: z.string().max(256).nullable(),
  storedDirty: z.boolean().nullable(),
  currentDirty: z.boolean().nullable(),
  storedPatchDigest: digestOrNull,
  currentPatchDigest: digestOrNull,
  storedCheckoutId: z.string().min(1).max(128),
  currentCheckoutId: z.string().min(1).max(128).nullable(),
  storedCaptureStatus: z.enum(['complete', 'partial', 'unknown']),
  currentCaptureStatus: z.enum(['complete', 'partial', 'unknown']),
  patchStatus: z.enum([
    'unchanged',
    'missing',
    'changed',
    'unsafe',
    'not-applicable',
    'unknown',
  ]),
  patchDetail: z.string().max(2048).nullable(),
  detail: z.string().max(2048).nullable(),
});

const artifactCheckSchema = z.strictObject({
  path: continuityArtifactPathSchema,
  status: z.enum(['unchanged', 'changed', 'missing', 'unsafe', 'unknown']),
  detail: z.string().max(2048).nullable(),
});

const executionObservationSchema = z.strictObject({
  harness: z.enum(['pi', 'codex', 'claude', 'unknown']),
  sessionId: z.string().max(256).nullable(),
  turnId: z.string().max(256).nullable(),
  runId: z.string().max(256).nullable(),
  scope: z.literal('stored-snapshot'),
  liveStatus: z.literal('unknown'),
  observedAt: z.iso.datetime({ offset: true }),
});

const blockingReasonSchema = z.strictObject({
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(2048),
});
const collaborationObservationSchema = z.strictObject({
  ref: z.string().max(4096).nullable(),
  status: z.enum([
    'read',
    'missing',
    'unreadable',
    'unsupported',
    'not-referenced',
  ]),
  digest: digestSchema.nullable(),
  authority: z.strictObject({
    valid: z.boolean(),
    stateRevision: z.number().int().nonnegative().nullable(),
    ownerEpoch: z.number().int().nonnegative().nullable(),
    dispatchFrozen: z.boolean().nullable(),
    activeAttempts: z.number().int().nonnegative().nullable(),
    unreleasedClaims: z.number().int().nonnegative().nullable(),
    unresolvedUncertainty: z.number().int().nonnegative().nullable(),
    pendingApprovals: z.number().int().nonnegative().nullable(),
    blockerCodes: z.array(z.string().min(1).max(128)).max(32),
  }),
  scope: z.literal('persisted-history'),
  liveStatus: z.literal('unknown'),
});

export const resumePacketSchema = z.strictObject({
  schema: z.literal(RESUME_PACKET_SCHEMA),
  generatedAt: z.iso.datetime({ offset: true }),
  taskId: taskIdSchema,
  workspaceId: z.uuid(),
  checkpoint: z.strictObject({
    ref: z.string().min(1).max(2048),
    digest: digestSchema,
    revision: z.number().int().positive(),
  }),
  identityChecks: z.array(identityCheckSchema).max(16),
  codeDrift: z.strictObject({
    status: z.enum(['unchanged', 'changed', 'relocated', 'unknown']),
    repositories: z.array(repositoryDriftSchema).max(64),
  }),
  artifactChecks: z.array(artifactCheckSchema).max(64),
  executionObservations: z.array(executionObservationSchema).max(32),
  collaborationObservation: collaborationObservationSchema,
  blockingReasons: z.array(blockingReasonSchema).max(32),
  executionAllowed: z.boolean(),
  contextCompleteness: z.enum(['complete', 'partial']),
  verificationStatus: z.enum(['current', 'stale', 'unknown']),
  boundedContext: z.strictObject({
    objective: z.string().min(1).max(4096),
    acceptance: z.array(z.string().min(1).max(4096)).max(16),
    constraints: z.array(z.string().min(1).max(4096)).max(16),
    decisions: z.array(z.string().min(1).max(4096)).max(16),
    attempted: z.array(z.string().min(1).max(4096)).max(16),
    nextActions: z.array(z.string().min(1).max(4096)).max(16),
    limitations: z.array(z.string().min(1).max(4096)).max(16),
    repositories: z.array(checkpointRepositorySchema).max(16),
    artifacts: z.array(checkpointArtifactSchema).max(16),
    truncated: z.boolean(),
  }),
});

export type ResumePacket = z.infer<typeof resumePacketSchema>;
