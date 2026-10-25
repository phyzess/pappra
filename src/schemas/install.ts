import { z } from 'zod';
import {
  isLocalProcessIdentity,
  type LocalProcessIdentity,
} from '../infra/process-identity.js';

export const RUNTIME_MANIFEST_SCHEMA = 'pappra/runtime-manifest/3';
export const RUNTIME_DIGEST_SCHEME = 'sha256-utf8-byte-order-v1';
export const WORKSPACE_MANIFEST_SCHEMA = 'pappra/install-manifest/1';
export const INSTALL_JOURNAL_SCHEMA = 'pappra/install-journal/1';
export const LOCK_SCHEMA = 'pappra/install-lock/1';

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const versionSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[0-9A-Za-z][0-9A-Za-z0-9._+-]*$/);
const pathSchema = z.string().min(1).max(4096);

export const fileIdentitySchema = z.strictObject({
  dev: z.number().int().nonnegative(),
  ino: z.number().int().nonnegative(),
});

export const installLockSchema = z.strictObject({
  schema: z.literal(LOCK_SCHEMA),
  token: z.uuid(),
  operation: z.enum([
    'install-runtime',
    'apply-workspace-files',
    'rollback-workspace-files',
    'uninstall-workspace-files',
    'remove-runtime',
    'archive-runtime',
    'update-machine-runtime',
    // Private hook preference toggle guarded by the workspace lock; shared
    // configuration is never rewritten by this operation.
    'set-auto-resume',
  ]),
  target: z.string().min(1).max(4096),
  pid: z.number().int().positive(),
  process_identity: z
    .custom<LocalProcessIdentity>(isLocalProcessIdentity)
    .optional(),
  createdAt: z.iso.datetime({ offset: true }),
});

export type InstallLock = z.infer<typeof installLockSchema>;

export const runtimeSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('version'),
    packageName: z.string().min(1).max(256),
    version: versionSchema,
    ref: z.string().min(1).max(512),
  }),
  z.strictObject({
    kind: z.literal('tarball'),
    packageName: z.string().min(1).max(256),
    version: versionSchema,
    path: pathSchema,
    digest: digestSchema,
  }),
  z.strictObject({
    kind: z.literal('self'),
    packageName: z.string().min(1).max(256),
    version: versionSchema,
    packageRoot: pathSchema,
    tarball: pathSchema,
    digest: digestSchema,
  }),
]);

export type RuntimeSource = z.infer<typeof runtimeSourceSchema>;

export const runtimeManifestSchema = z.strictObject({
  schema: z.literal(RUNTIME_MANIFEST_SCHEMA),
  installId: z.uuid(),
  packageName: z.string().min(1).max(256),
  runtimeVersion: versionSchema,
  runtimeRoot: pathSchema,
  executable: pathSchema,
  source: runtimeSourceSchema,
  packageDigest: digestSchema,
  digestScheme: z.literal(RUNTIME_DIGEST_SCHEME),
  sourceFingerprint: digestSchema,
  smoke: z.strictObject({
    argv: z.array(z.string().max(4096)).max(16),
    exitCode: z.number().int(),
    stdoutDigest: digestSchema,
  }),
  verifiedAt: z.iso.datetime({ offset: true }),
});

export type RuntimeManifest = z.infer<typeof runtimeManifestSchema>;

export const journalStatusSchema = z.enum([
  'prepared',
  'applying',
  'applied',
  'verified',
  'rollback-required',
  'rolled-back',
]);

export type JournalStatus = z.infer<typeof journalStatusSchema>;

export const journalStepSchema = z.strictObject({
  name: z.string().min(1).max(256),
  status: z.enum(['ok', 'failed']),
  at: z.iso.datetime({ offset: true }),
  detail: z.string().max(4096).nullable(),
});

export const journalEntrySchema = z.strictObject({
  path: z.string().min(1).max(2048),
  status: z.enum(['pending', 'created', 'verified', 'removed', 'residual']),
  digest: digestSchema,
  identity: fileIdentitySchema.nullable(),
  backupRef: z.string().min(1).max(4096).nullable(),
  backupDigest: digestSchema.nullable(),
  detail: z.string().max(4096).nullable(),
});

export const installJournalSchema = z.strictObject({
  schema: z.literal(INSTALL_JOURNAL_SCHEMA),
  installId: z.uuid(),
  operation: z.enum([
    'install-runtime',
    'apply-workspace-files',
    'rollback-workspace-files',
    'uninstall-workspace-files',
    'remove-runtime',
    'update-machine-runtime',
  ]),
  target: z.string().min(1).max(4096),
  workspaceRoot: pathSchema.nullable(),
  runtimeVersion: versionSchema.nullable(),
  status: journalStatusSchema,
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  steps: z.array(journalStepSchema).max(256),
  entries: z.array(journalEntrySchema).max(256),
  residuals: z.array(z.string().min(1).max(2048)).max(256),
  manifestRef: z.string().max(4096).nullable(),
});

export type InstallJournal = z.infer<typeof installJournalSchema>;

export const managedFileEntrySchema = z.strictObject({
  path: z.string().min(1).max(2048),
  installId: z.uuid(),
  operation: z.enum(['create', 'replace-managed']),
  beforeDigest: digestSchema.nullable(),
  afterDigest: digestSchema,
  backupRef: z.string().min(1).max(4096).nullable(),
  backupDigest: digestSchema.nullable(),
  identity: fileIdentitySchema,
  owner: z.literal('pappra'),
  verifiedAt: z.iso.datetime({ offset: true }),
});

export type ManagedFileEntry = z.infer<typeof managedFileEntrySchema>;

export const workspaceInstallManifestSchema = z.strictObject({
  schema: z.literal(WORKSPACE_MANIFEST_SCHEMA),
  workspaceRoot: pathSchema,
  rootIdentity: fileIdentitySchema,
  entries: z.array(managedFileEntrySchema).max(512),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});

export type WorkspaceInstallManifest = z.infer<
  typeof workspaceInstallManifestSchema
>;

export const runtimePackageManifestSchema = z.object({
  name: z.string().min(1).max(256),
  version: versionSchema,
  bin: z
    .union([
      z.string().min(1).max(2048),
      z.record(z.string().min(1).max(256), z.string().min(1).max(2048)),
    ])
    .optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  scripts: z.record(z.string(), z.string()).optional(),
});

export type RuntimePackageManifest = z.infer<
  typeof runtimePackageManifestSchema
>;
