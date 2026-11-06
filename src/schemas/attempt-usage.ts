import { z } from 'zod';

const count = z.number().int().nonnegative();
const harness = z.enum(['codex', 'claude', 'pi']);

export const attemptUsageSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('available'),
    harness,
    input_tokens: count,
    output_tokens: count,
    cache_read_input_tokens: count,
    cache_write_input_tokens: count.nullable(),
    total_tokens: count,
    evidence_digests: z
      .array(z.string().regex(/^sha256:[a-f0-9]{64}$/))
      .min(1)
      .max(2),
  }),
  z.strictObject({
    state: z.literal('unavailable'),
    reason: z.enum([
      'unsupported_harness',
      'attempt_boundary_unproven',
      'evidence_not_registered',
      'evidence_unreadable_or_changed',
      'evidence_budget_exceeded',
      'native_usage_unproven',
    ]),
  }),
]);

export type AttemptUsage = z.infer<typeof attemptUsageSchema>;

export const attemptUsageProjectionSchema = z.strictObject({
  attempts: z
    .array(
      z.strictObject({
        subtask_id: z.string(),
        attempt: count,
        token_usage: attemptUsageSchema,
      }),
    )
    .max(16),
  omitted: count,
  accounting: z.literal('completed_native_work_input_includes_cache_reads'),
});

export type AttemptUsageProjection = z.infer<
  typeof attemptUsageProjectionSchema
>;
