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

export const collaborationGoalSchema = z.strictObject({
  schema: z.literal('pappra/collaboration-goal/1'),
  task_id: taskId,
  subtask_id: taskId,
  attempt: z.number().int().min(1).max(1000),
  phase: z.enum(['discovery', 'implementation', 'review', 'handoff', 'fix']),
  objective: z.string().min(1).max(4000),
  acceptance: z.array(z.string().min(1).max(1000)).min(1).max(32),
  prompt: z.string().min(1).max(20000),
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
