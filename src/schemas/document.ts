import { z } from 'zod';
import {
  isLocalProcessIdentity,
  type LocalProcessIdentity,
} from '../infra/process-identity.js';
import {
  isPortableRelativePath,
  normalizePortableRelativePath,
} from './paths.js';

export const DOCUMENT_SCHEMA = 'pappra/document/1';
export const DOCUMENT_CATALOG_SCHEMA = 'pappra/document-catalog/1';
export const DOCUMENT_WRITE_PROPOSAL_SCHEMA =
  'pappra/document-write-proposal/1';
export const KNOWLEDGE_DELETE_PLAN_SCHEMA = 'pappra/knowledge-delete-plan/1';
export const KNOWLEDGE_LOCK_SCHEMA = 'pappra/knowledge-lock/1';
export const KNOWLEDGE_JOURNAL_SCHEMA = 'pappra/knowledge-journal/1';

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const identifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

const documentPathSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (value) =>
      value !== '.' &&
      isPortableRelativePath(value) &&
      normalizePortableRelativePath(value) === value,
    'Use a normalized non-empty workspace-relative path without escaping the root.',
  );

export const documentKindSchema = z.enum([
  'rule',
  'architecture',
  'decision',
  'plan',
  'research',
  'review',
  'delivery',
  'checkpoint',
  'generated',
]);
export const documentLifecycleSchema = z.enum([
  'active',
  'archived',
  'superseded',
]);
export const documentMaturitySchema = z.enum(['draft', 'reviewed']);
export const documentOwnerSchema = z.enum(['human', 'agent', 'generator']);
export const documentVisibilitySchema = z.enum(['private', 'shareable']);

export type DocumentKind = z.infer<typeof documentKindSchema>;
export type DocumentLifecycle = z.infer<typeof documentLifecycleSchema>;
export type DocumentMaturity = z.infer<typeof documentMaturitySchema>;
export type DocumentOwner = z.infer<typeof documentOwnerSchema>;
export type DocumentVisibility = z.infer<typeof documentVisibilitySchema>;

export const documentLocationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('workspace'),
    path: documentPathSchema,
  }),
  z.strictObject({
    kind: z.literal('source'),
    sourceId: identifierSchema,
    path: documentPathSchema,
  }),
]);

export type DocumentLocation = z.infer<typeof documentLocationSchema>;

export const documentSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('document'),
    documentId: z.uuid(),
    digest: digestSchema,
  }),
  z.strictObject({
    kind: z.literal('code'),
    repositoryId: identifierSchema,
    path: documentPathSchema,
    version: z.string().min(1).max(256),
  }),
]);

export type DocumentSource = z.infer<typeof documentSourceSchema>;

const documentRecordBaseSchema = z.strictObject({
  schema: z.literal(DOCUMENT_SCHEMA),
  documentId: z.uuid(),
  location: documentLocationSchema,
  kind: documentKindSchema,
  lifecycle: documentLifecycleSchema,
  maturity: documentMaturitySchema,
  taskId: z.string().min(1).max(256).nullable(),
  owner: documentOwnerSchema,
  digest: digestSchema,
  sources: z.array(documentSourceSchema).max(64),
  supersededBy: z.uuid().nullable(),
  lastReviewedAt: z.iso.datetime({ offset: true }).nullable(),
  visibility: documentVisibilitySchema,
});

export const documentRecordSchema = documentRecordBaseSchema.superRefine(
  (record, context) => {
    if (record.lifecycle === 'superseded') {
      if (record.supersededBy === null) {
        context.addIssue({
          code: 'custom',
          path: ['supersededBy'],
          message: 'A superseded document must name its replacement.',
        });
      } else if (record.supersededBy === record.documentId) {
        context.addIssue({
          code: 'custom',
          path: ['supersededBy'],
          message: 'A document cannot supersede itself.',
        });
      }
    } else if (record.supersededBy !== null) {
      context.addIssue({
        code: 'custom',
        path: ['supersededBy'],
        message: 'Only a superseded document may name a replacement.',
      });
    }
  },
);

export type DocumentRecord = z.infer<typeof documentRecordSchema>;

export const documentRecordFileSchema = z.strictObject({
  schema: z.literal('pappra/document-record-file/1'),
  workspaceId: z.uuid(),
  record: documentRecordSchema,
});

export const documentCatalogSchema = z.strictObject({
  schema: z.literal(DOCUMENT_CATALOG_SCHEMA),
  workspaceId: z.uuid(),
  updatedAt: z.iso.datetime({ offset: true }),
  records: z.array(documentRecordSchema).max(2048),
});

export type DocumentCatalog = z.infer<typeof documentCatalogSchema>;

const fileIdentitySchema = z.strictObject({
  dev: z.number().int().nonnegative(),
  ino: z.number().int().nonnegative(),
});

export const documentWriteProposalSchema = z
  .strictObject({
    schema: z.literal(DOCUMENT_WRITE_PROPOSAL_SCHEMA),
    proposalId: z.uuid(),
    createdAt: z.iso.datetime({ offset: true }),
    mode: z.enum(['create', 'update']),
    documentId: z.uuid(),
    location: documentLocationSchema,
    expectedDigest: digestSchema.nullable(),
    nextDigest: digestSchema,
    catalogDigest: digestSchema,
    rootIdentity: fileIdentitySchema,
    record: documentRecordSchema,
    diff: z.string().max(4 * 1024 * 1024),
  })
  .superRefine((proposal, context) => {
    if (
      proposal.documentId !== proposal.record.documentId ||
      JSON.stringify(proposal.location) !==
        JSON.stringify(proposal.record.location) ||
      proposal.nextDigest !== proposal.record.digest
    ) {
      context.addIssue({
        code: 'custom',
        path: ['record'],
        message: 'Proposal identity/location/digest must match its record.',
      });
    }
    if (proposal.mode === 'create') {
      if (proposal.expectedDigest !== null) {
        context.addIssue({
          code: 'custom',
          path: ['expectedDigest'],
          message: 'A create proposal must have expectedDigest=null.',
        });
      }
      if (
        proposal.record.lifecycle !== 'active' ||
        proposal.record.supersededBy !== null
      ) {
        context.addIssue({
          code: 'custom',
          path: ['record'],
          message: 'A new document record must be active and not superseded.',
        });
      }
    } else if (proposal.expectedDigest === null) {
      context.addIssue({
        code: 'custom',
        path: ['expectedDigest'],
        message: 'An update proposal must bind the current expectedDigest.',
      });
    }
  });

export type DocumentWriteProposal = z.infer<typeof documentWriteProposalSchema>;

export const knowledgeDeleteBlockerSchema = z.strictObject({
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(1024),
});

export const knowledgeDeleteReferenceSchema = z.strictObject({
  documentId: z.uuid(),
  relation: z.enum(['source', 'superseded-by']),
});

export const knowledgeDeletePlanSchema = z.strictObject({
  schema: z.literal(KNOWLEDGE_DELETE_PLAN_SCHEMA),
  planId: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
  documentId: z.uuid(),
  removeFile: z.boolean(),
  location: documentLocationSchema,
  expectedFileDigest: digestSchema.nullable(),
  expectedFileIdentity: fileIdentitySchema.nullable(),
  catalogScope: z.enum(['shared', 'private']),
  catalogDigest: digestSchema,
  rootIdentity: fileIdentitySchema,
  references: z.array(knowledgeDeleteReferenceSchema).max(128),
  pathReferences: z.literal('unchecked'),
  coverage: z.literal('catalog-only'),
  taskState: z.enum(['not-linked', 'unknown']),
  blockers: z.array(knowledgeDeleteBlockerSchema).max(32),
  deletable: z.boolean(),
});

export type KnowledgeDeletePlan = z.infer<typeof knowledgeDeletePlanSchema>;

export const knowledgeOperationSchema = z.enum([
  'write-document',
  'archive-document',
  'supersede-document',
  'delete-document',
  'share-document',
]);

export const knowledgeLockSchema = z.strictObject({
  schema: z.literal(KNOWLEDGE_LOCK_SCHEMA),
  token: z.uuid(),
  operation: knowledgeOperationSchema,
  pid: z.number().int().positive(),
  process_identity: z
    .custom<LocalProcessIdentity>(isLocalProcessIdentity)
    .optional(),
  createdAt: z.iso.datetime({ offset: true }),
});

export type KnowledgeLock = z.infer<typeof knowledgeLockSchema>;

export const knowledgeJournalSchema = z.strictObject({
  schema: z.literal(KNOWLEDGE_JOURNAL_SCHEMA),
  operationId: z.uuid(),
  operation: knowledgeOperationSchema,
  stage: z.enum([
    'prepared',
    'file-written',
    'catalog-written',
    'file-removed',
    'complete',
    'failed',
  ]),
  documentId: z.uuid().nullable(),
  targetPath: z.string().min(1).max(4096).nullable(),
  catalogScope: z.enum(['shared', 'private']).nullable(),
  expectedDigest: digestSchema.nullable(),
  fileDigest: digestSchema.nullable(),
  catalogDigest: digestSchema.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  residualPaths: z.array(z.string().min(1).max(4096)).max(64),
  detail: z.string().max(4096).nullable(),
});

export type KnowledgeJournal = z.infer<typeof knowledgeJournalSchema>;

export const knowledgeDiagnosticSchema = z.strictObject({
  code: z.string().min(1).max(128),
  severity: z.enum(['error', 'warning', 'info']),
  message: z.string().min(1).max(4096),
  source: z.string().min(1).max(4096),
  pointer: z.string().max(2048).nullable(),
  hint: z.string().max(4096).nullable(),
});

export const docsListReportSchema = z.strictObject({
  schema: z.literal('pappra/docs-list/1'),
  ok: z.boolean(),
  includePrivate: z.boolean(),
  includeArchived: z.boolean(),
  catalogDigest: z.string(),
  documents: z.array(documentRecordSchema).max(2048),
  diagnostics: z.array(knowledgeDiagnosticSchema).max(2048),
});

export const documentCheckEntrySchema = z.strictObject({
  documentId: z.uuid(),
  scope: z.enum(['shared', 'private']),
  lifecycle: documentLifecycleSchema,
  maturity: documentMaturitySchema,
  fileDigest: digestSchema.nullable(),
  recordDigest: digestSchema,
  freshness: z.enum(['current', 'needs-review', 'unknown']),
  reasons: z
    .array(
      z.strictObject({
        code: z.string().min(1).max(128),
        message: z.string().min(1).max(4096),
      }),
    )
    .max(128),
  sourceChecks: z
    .array(
      z.strictObject({
        kind: z.enum(['document', 'code']),
        ref: z.string().min(1).max(4096),
        status: z.enum(['current', 'needs-review', 'unknown']),
        message: z.string().min(1).max(4096),
      }),
    )
    .max(128),
});

export const docsCheckReportSchema = z.strictObject({
  schema: z.literal('pappra/docs-check/1'),
  ok: z.boolean(),
  checkedAt: z.iso.datetime({ offset: true }),
  catalogDigest: z.string(),
  entries: z.array(documentCheckEntrySchema).max(2048),
  diagnostics: z.array(knowledgeDiagnosticSchema).max(2048),
  summary: z.strictObject({
    total: z.number().int().nonnegative(),
    current: z.number().int().nonnegative(),
    needsReview: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
  }),
  coverage: z.strictObject({
    catalogs: z.enum(['shared', 'shared-and-private']),
    pathReferences: z.literal('unchecked'),
    repositoryContent: z.literal('not-scanned'),
    taskExecution: z.literal('unknown'),
  }),
});

export const docsArchiveReportSchema = z.strictObject({
  schema: z.literal('pappra/docs-archive/1'),
  ok: z.boolean(),
  status: z.string().min(1).max(64),
  document: documentRecordSchema.nullable(),
  diagnostics: z.array(knowledgeDiagnosticSchema).max(2048),
});
