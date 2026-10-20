import { z } from 'zod';
import { evidenceRefSchema } from './evidence.js';

export const HOST_INTEGRATION_SCHEMA = 'pappra/host-integration/1';
export const HOST_CAPABILITIES_SCHEMA = 'pappra/host-capabilities/1';
export const HOST_BUNDLE_SCHEMA = 'pappra/host-bundle/1';
export const HOST_HOOK_INPUT_SCHEMA = 'pappra/host-hook-input/1';
export const HOST_HOOK_RESULT_SCHEMA = 'pappra/host-hook-result/1';

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const digestOrNull = digestSchema.nullable();
/** A host hook path may be absolute or a host placeholder expression. */
const hookPathSchema = z.string().min(1).max(4096);

const absolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value),
    'Expected an absolute host path.',
  );

export const hostNameSchema = z.enum(['pi', 'codex', 'claude']);
export type HostName = z.infer<typeof hostNameSchema>;

export const hostLifecycleEventSchema = z.enum([
  'startup',
  'resume',
  'compact',
  'checkpoint-request',
]);
export type HostLifecycleEvent = z.infer<typeof hostLifecycleEventSchema>;

export const hostCapabilityStateSchema = z.enum([
  'installed',
  'configured',
  'discovered',
  'callable',
  'verified',
  'unsupported',
  'unknown',
]);
export type HostCapabilityState = z.infer<typeof hostCapabilityStateSchema>;

export const hostCapabilitySchema = z.strictObject({
  event: hostLifecycleEventSchema,
  nativeEvent: z.string().min(1).max(128).nullable(),
  state: hostCapabilityStateSchema,
  reason: z.string().min(1).max(1024).nullable(),
  evidence: z.array(evidenceRefSchema).max(8),
});
export type HostCapability = z.infer<typeof hostCapabilitySchema>;

export const hostCapabilitiesSchema = z.strictObject({
  schema: z.literal(HOST_CAPABILITIES_SCHEMA),
  host: hostNameSchema,
  surface: z.enum(['pi-extension', 'codex-hooks', 'claude-hooks']),
  version: z.string().min(1).max(128).nullable(),
  observedAt: z.iso.datetime({ offset: true }),
  executablePath: absolutePathSchema.nullable(),
  configPath: absolutePathSchema.nullable(),
  capabilities: z.array(hostCapabilitySchema).max(8),
  reloadRequired: z.boolean(),
  trustRequired: z.boolean(),
  automaticHandoff: z.enum(['unsupported', 'manual']),
  limits: z.array(z.string().min(1).max(1024)).max(16),
});
export type HostCapabilities = z.infer<typeof hostCapabilitiesSchema>;

export const hostPlanFileSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .max(2048)
    .refine(
      (value) =>
        !value.startsWith('/') &&
        !value.includes('\\') &&
        !value.includes('\0') &&
        !value.split('/').includes('..'),
      'Expected a portable host-relative path.',
    ),
  kind: z.enum(['skill', 'hook-entry', 'extension', 'config', 'manifest']),
  operation: z.enum([
    'create',
    'replace-managed',
    'merge-managed',
    'unchanged',
    'conflict',
  ]),
  beforeDigest: digestOrNull,
  nextDigest: digestSchema,
});
export type HostPlanFile = z.infer<typeof hostPlanFileSchema>;

export const hostIntegrationPlanSchema = z.strictObject({
  schema: z.literal(HOST_INTEGRATION_SCHEMA),
  planId: z.uuid(),
  host: hostNameSchema,
  workspaceRoot: absolutePathSchema,
  hostRoot: absolutePathSchema,
  runtimeEntry: hookPathSchema,
  bundleDigest: digestSchema,
  files: z.array(hostPlanFileSchema).max(64),
  reloadRequired: z.boolean(),
  trustRequired: z.boolean(),
  diagnostics: z.array(z.unknown()).max(32),
});
export type HostIntegrationPlan = z.infer<typeof hostIntegrationPlanSchema>;

export const hostIntegrationResultSchema = z.strictObject({
  schema: z.literal(HOST_INTEGRATION_SCHEMA),
  ok: z.boolean(),
  status: z.enum([
    'planned',
    'applied',
    'unchanged',
    'partial',
    'conflict',
    'unsupported',
    'invalid',
    'failed',
  ]),
  plan: hostIntegrationPlanSchema.nullable(),
  appliedFiles: z.array(z.string().min(1).max(2048)).max(64),
  residualPaths: z.array(absolutePathSchema).max(32),
  diagnostics: z.array(z.unknown()).max(32),
});
export type HostIntegrationResult = z.infer<typeof hostIntegrationResultSchema>;

export const hostBundleFileSchema = z.strictObject({
  path: z.string().min(1).max(2048),
  digest: digestSchema,
  kind: z.enum(['skill', 'reference', 'hook', 'extension']),
});
export type HostBundleFile = z.infer<typeof hostBundleFileSchema>;

export const hostBundleSchema = z.strictObject({
  schema: z.literal(HOST_BUNDLE_SCHEMA),
  host: hostNameSchema,
  skillId: z.string().min(1).max(128),
  packageVersion: z.string().min(1).max(128),
  bundleDigest: digestSchema,
  files: z.array(hostBundleFileSchema).max(64),
  observedAt: z.iso.datetime({ offset: true }),
});
export type HostBundle = z.infer<typeof hostBundleSchema>;

/** Normalized event accepted by the local hook runtime. */
export const hostHookInputSchema = z.strictObject({
  schema: z.literal(HOST_HOOK_INPUT_SCHEMA),
  host: hostNameSchema,
  event: hostLifecycleEventSchema,
  nativeEvent: z.string().min(1).max(128),
  eventId: z.string().min(1).max(256).nullable(),
  sessionId: z.string().min(1).max(256).nullable(),
  cwd: absolutePathSchema,
  root: absolutePathSchema.nullable(),
  taskId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
    .nullable(),
  source: z.string().min(1).max(128).nullable(),
  observedAt: z.iso.datetime({ offset: true }),
});
export type HostHookInput = z.infer<typeof hostHookInputSchema>;

export const hostHookResultSchema = z.strictObject({
  schema: z.literal(HOST_HOOK_RESULT_SCHEMA),
  ok: z.boolean(),
  status: z.enum([
    'processed',
    'duplicate',
    'unsupported',
    'invalid',
    'timeout',
    'failed',
  ]),
  host: hostNameSchema.nullable(),
  event: hostLifecycleEventSchema.nullable(),
  eventKey: z.string().min(1).max(256).nullable(),
  duplicate: z.boolean(),
  context: z.string().max(8192).nullable(),
  diagnostics: z.array(z.unknown()).max(16),
});
export type HostHookResult = z.infer<typeof hostHookResultSchema>;

/** Observed external hook envelope; unknown keys are ignored by design. */
export const commandHookEventSchema = z.looseObject({
  hook_event_name: z.string().min(1).max(128),
  session_id: z.string().min(1).max(256).optional(),
  cwd: z.string().min(1).max(4096),
  source: z.string().min(1).max(128).optional(),
  event_id: z.string().min(1).max(256).optional(),
  pappra_task_id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
    .optional(),
});
export type CommandHookEvent = z.infer<typeof commandHookEventSchema>;
export const hostVerificationCheckSchema = z.strictObject({
  id: z.string().min(1).max(128),
  status: z.enum(['ok', 'warning', 'error', 'unknown', 'unsupported']),
  detail: z.string().min(1).max(2048),
});
export type HostVerificationCheck = z.infer<typeof hostVerificationCheckSchema>;

export const hostVerificationSchema = z.strictObject({
  schema: z.literal('pappra/host-verification/1'),
  host: hostNameSchema,
  version: z.string().min(1).max(128).nullable(),
  hostRoot: absolutePathSchema,
  status: z.enum(['verified', 'partial', 'unsupported', 'conflict']),
  bundleDigest: digestOrNull,
  checks: z.array(hostVerificationCheckSchema).max(32),
  capabilities: z.array(hostCapabilitySchema).max(8),
  diagnostics: z.array(z.unknown()).max(32),
  residualPaths: z.array(absolutePathSchema).max(32),
});
export type HostVerification = z.infer<typeof hostVerificationSchema>;
export const hostInstallManifestSchema = z.strictObject({
  schema: z.literal('pappra/host-install/1'),
  host: hostNameSchema,
  packageVersion: z.string().min(1).max(128),
  bundleDigest: digestSchema,
  installedAt: z.iso.datetime({ offset: true }),
  hostRoot: absolutePathSchema,
  runtimeEntry: hookPathSchema,
  configPath: z.string().min(1).max(2048).nullable(),
  files: z.array(
    z.strictObject({
      path: z.string().min(1).max(2048),
      digest: digestSchema,
      kind: z.enum(['skill', 'reference', 'hook', 'extension', 'config']),
    }),
  ),
  reloadRequired: z.boolean(),
  trustRequired: z.boolean(),
});
export type HostInstallManifest = z.infer<typeof hostInstallManifestSchema>;
