import { z } from 'zod';
import { evidenceRefSchema } from './evidence.js';

export const DOCTOR_REPORT_SCHEMA = 'pappra/doctor-report/1';

export const doctorCheckStatusSchema = z.enum([
  'ok',
  'warning',
  'error',
  'unknown',
  'partial',
  'unsupported',
]);

export const doctorSeveritySchema = z.enum(['info', 'warning', 'error']);

export const doctorCheckSchema = z.strictObject({
  id: z.string().min(1).max(128),
  code: z.string().min(1).max(128),
  status: doctorCheckStatusSchema,
  severity: doctorSeveritySchema,
  title: z.string().min(1).max(256),
  summary: z.string().min(1).max(4096),
  source: z.string().min(1).max(4096),
  observedAt: z.iso.datetime({ offset: true }),
  coverage: z.string().min(1).max(256).nullable(),
  evidence: z.array(evidenceRefSchema).max(32),
  nextActions: z.array(z.string().min(1).max(1024)).max(16),
});

export type DoctorCheckStatus = z.infer<typeof doctorCheckStatusSchema>;
export type DoctorSeverity = z.infer<typeof doctorSeveritySchema>;
export type DoctorCheck = z.infer<typeof doctorCheckSchema>;

export const doctorMachineRuntimeSchema = z.strictObject({
  version: z.string().min(1).max(128),
  executable: z.string().min(1).max(4096),
  verifiedAt: z.iso.datetime({ offset: true }),
});

export const doctorReportSchema = z.strictObject({
  schema: z.literal(DOCTOR_REPORT_SCHEMA),
  generatedAt: z.iso.datetime({ offset: true }),
  requestedRoot: z.string().min(1).max(4096),
  workspace: z.strictObject({
    root: z.string().min(1).max(4096).nullable(),
    state: z.enum(['registered', 'missing', 'incomplete', 'unavailable']),
    configPath: z.string().min(1).max(4096).nullable(),
    machinePath: z.string().min(1).max(4096).nullable(),
  }),
  runtime: z.strictObject({
    targetVersion: z.string().min(1).max(128).nullable(),
    machineRuntime: doctorMachineRuntimeSchema.nullable(),
    dataDir: z.string().min(1).max(4096),
    passiveStatus: z
      .enum([
        'missing',
        'content-match',
        'version-mismatch',
        'corrupt',
        'locked',
        'partial',
        'unreadable',
        'incompatible',
      ])
      .nullable(),
  }),
  scope: z.strictObject({
    checked: z.array(z.string().min(1).max(512)).max(64),
    notChecked: z.array(z.string().min(1).max(512)).max(64),
  }),
  checks: z.array(doctorCheckSchema).max(128),
  summary: z.strictObject({
    status: z.enum(['ok', 'needs_attention', 'blocked']),
    exitCode: z.union([z.literal(0), z.literal(1)]),
    counts: z.strictObject({
      ok: z.number().int().nonnegative(),
      warning: z.number().int().nonnegative(),
      error: z.number().int().nonnegative(),
      unknown: z.number().int().nonnegative(),
      partial: z.number().int().nonnegative(),
      unsupported: z.number().int().nonnegative(),
    }),
    nextActions: z.array(z.string().min(1).max(1024)).max(16),
  }),
});

export type DoctorReport = z.infer<typeof doctorReportSchema>;
