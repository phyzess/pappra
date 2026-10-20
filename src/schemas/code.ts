import { z } from 'zod';
import { evidenceRefSchema } from './evidence.js';

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const reasonSchema = z.string().min(1).max(512);
const relativePathSchema = z.string().min(1).max(2048);

export const codeWorkingTreeSchema = z.strictObject({
  digest: digestSchema,
  completeness: z.enum(['complete', 'partial', 'unknown']),
  fileCount: z.number().int().nonnegative(),
  byteCount: z.number().int().nonnegative(),
  reasons: z.array(reasonSchema).max(16),
});

export const codeEngineSchema = z.strictObject({
  id: z.literal('codegraph'),
  version: z.string().min(1).max(64),
  configDigest: digestSchema,
  configStatus: z.enum(['default', 'observed', 'unknown']).optional(),
});

export const codeIdentitySchema = z.strictObject({
  schema: z.literal('pappra/code-identity/1'),
  repositoryId: z.string().min(1).max(64),
  checkoutId: z.string().min(1).max(128),
  root: z.string().min(1).max(4096),
  gitDir: z.string().min(1).max(4096).nullable(),
  gitCommonDir: z.string().min(1).max(4096).nullable(),
  head: z.string().max(256).nullable(),
  branch: z.string().max(512).nullable(),
  workingTree: codeWorkingTreeSchema,
  engine: codeEngineSchema,
});

export const codeIndexCoverageSchema = z.strictObject({
  scope: z.literal('selected-repository'),
  languages: z.array(z.string().min(1).max(64)).max(64),
  semantic: z.boolean(),
  callGraph: z.boolean(),
  note: z.string().min(1).max(1024),
});

export const codeIndexHealthSchema = z.strictObject({
  schema: z.literal('pappra/code-index-health/1'),
  state: z.enum([
    'missing',
    'building',
    'ready',
    'stale',
    'partial',
    'failed',
    'unsupported',
  ]),
  reasons: z.array(reasonSchema).max(32),
  evidence: z.array(evidenceRefSchema).max(32),
  coverage: codeIndexCoverageSchema,
  engineVersion: z.string().min(1).max(64),
  observedAt: z.iso.datetime({ offset: true }),
});

export const codeQueryKindSchema = z.enum([
  'explore',
  'symbol',
  'references',
  'impact',
  'text',
]);

export const codeQueryLimitsSchema = z.strictObject({
  maxResults: z.number().int().min(1).max(100),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(16 * 1024 * 1024),
  maxFiles: z.number().int().min(1).max(5000),
});

export const codeQueryRequestSchema = z.strictObject({
  schema: z.literal('pappra/code-query/1'),
  kind: codeQueryKindSchema,
  query: z.string().min(1).max(1024),
  identity: codeIdentitySchema,
  limits: codeQueryLimitsSchema,
  excludedRoots: z.array(z.string().min(1).max(4096)).max(64).optional(),
});

export const codeQueryItemSchema = z.strictObject({
  path: relativePathSchema,
  line: z.number().int().positive().nullable(),
  column: z.number().int().nonnegative().nullable(),
  kind: z.string().min(1).max(64),
  name: z.string().max(512).nullable(),
  snippet: z.string().max(4096),
  source: z.enum(['codegraph', 'text', 'structure']),
});

export const codeQueryResultSchema = z.strictObject({
  schema: z.literal('pappra/code-query-result/1'),
  provider: z.enum(['codegraph', 'text', 'structure']),
  kind: codeQueryKindSchema,
  query: z.string().min(1).max(1024),
  identityDigest: digestSchema,
  observedIdentity: codeIdentitySchema,
  coverage: z.enum(['complete', 'partial', 'fallback', 'unsupported']),
  items: z.array(codeQueryItemSchema).max(100),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  reasons: z.array(reasonSchema).max(16),
  evidence: z.array(evidenceRefSchema).max(32),
  unsupportedReason: z.string().max(1024).nullable(),
});

export const codePrepareActionSchema = z.enum([
  'none',
  'init',
  'sync',
  'rebuild',
]);

export const codePreparePlanSchema = z.strictObject({
  schema: z.literal('pappra/code-prepare-plan/1'),
  repositoryId: z.string().min(1).max(64),
  identityDigest: digestSchema,
  action: codePrepareActionSchema,
  indexPath: z.string().min(1).max(4096),
  command: z.array(z.string().max(4096)).max(16),
  mutates: z.boolean(),
  reasons: z.array(reasonSchema).max(16),
});

export const codePrepareResultSchema = z.strictObject({
  schema: z.literal('pappra/code-prepare-result/1'),
  ok: z.boolean(),
  status: z.enum([
    'planned',
    'ready',
    'partial',
    'failed',
    'conflict',
    'unsupported',
  ]),
  plan: codePreparePlanSchema,
  health: codeIndexHealthSchema,
  registrationPath: z.string().max(4096).nullable(),
  diagnostics: z.array(z.unknown()).max(32),
});

export const codeIndexRegistrationSchema = z.strictObject({
  schema: z.literal('pappra/code-index-registration/1'),
  repositoryId: z.string().min(1).max(64),
  identityDigest: digestSchema,
  checkoutId: z.string().min(1).max(128),
  root: z.string().min(1).max(4096),
  engineVersion: z.string().min(1).max(64),
  configDigest: digestSchema,
  preparedAt: z.iso.datetime({ offset: true }),
  coverage: codeIndexCoverageSchema,
});

export type CodeWorkingTree = z.infer<typeof codeWorkingTreeSchema>;
export type CodeEngine = z.infer<typeof codeEngineSchema>;
export type CodeIdentity = z.infer<typeof codeIdentitySchema>;
export type CodeIndexCoverage = z.infer<typeof codeIndexCoverageSchema>;
export type CodeIndexHealth = z.infer<typeof codeIndexHealthSchema>;
export type CodeQueryKind = z.infer<typeof codeQueryKindSchema>;
export type CodeQueryLimits = z.infer<typeof codeQueryLimitsSchema>;
export type CodeQueryRequest = z.infer<typeof codeQueryRequestSchema>;
export type CodeQueryItem = z.infer<typeof codeQueryItemSchema>;
export type CodeQueryResult = z.infer<typeof codeQueryResultSchema>;
export type CodePrepareAction = z.infer<typeof codePrepareActionSchema>;
export type CodePreparePlan = z.infer<typeof codePreparePlanSchema>;
export type CodePrepareResult = z.infer<typeof codePrepareResultSchema>;
export type CodeIndexRegistration = z.infer<typeof codeIndexRegistrationSchema>;
