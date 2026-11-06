import { z } from 'zod';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const revision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0);
const evidenceRef = z.strictObject({
  ref: text(1024),
  digest: digest.optional(),
});

export const reviewerReportSchema = z.strictObject({
  schema: z.literal('pappra/reviewer-report/1'),
  candidate: z.strictObject({
    report_message_id: z
      .string()
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    report_digest: digest,
    input_revision: text(256).nullable(),
    head: revision,
    patch_digest: digest.nullable(),
    checkpoint: z.strictObject({ ref: text(1024), digest }).optional(),
  }),
  base: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('known'), revision }),
    z.strictObject({ state: z.literal('unavailable'), reason: text(512) }),
  ]),
  findings: z
    .array(
      z.strictObject({
        severity: z.enum(['critical', 'major', 'minor', 'info']),
        title: text(256),
        location: text(512),
        origin: z.enum(['introduced', 'preexisting']),
        scope: z.enum(['in_scope', 'out_of_scope']),
        proof: z.discriminatedUnion('state', [
          z.strictObject({
            state: z.literal('observed'),
            detail: text(1024),
            refs: z.array(evidenceRef).max(4).optional(),
          }),
          z.strictObject({ state: z.literal('unverified'), reason: text(512) }),
        ]),
      }),
    )
    .max(16),
});

export type ReviewerReport = z.infer<typeof reviewerReportSchema>;
