import { z } from 'zod';

export const evidenceScopeSchema = z.enum([
  'persisted',
  'live-owned',
  'declared',
]);

export const evidenceRefSchema = z.strictObject({
  kind: z.enum(['file', 'native-event', 'git', 'runtime-probe']),
  ref: z.string().min(1),
  digest: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .nullable(),
  observedAt: z.iso.datetime({ offset: true }),
  scope: evidenceScopeSchema,
});

export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
export type EvidenceScope = z.infer<typeof evidenceScopeSchema>;
