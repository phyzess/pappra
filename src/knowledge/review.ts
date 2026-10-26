import { randomUUID } from 'node:crypto';
import type { Diagnostic } from '../schemas/diagnostics.js';
import { createDiagnostic } from '../schemas/diagnostics.js';
import { diagnosticCodes } from '../schemas/errors.js';
import {
  documentReviewPlanSchema,
  type DocumentRecord,
  type DocumentReviewPlan,
  type KnowledgeJournal,
} from '../schemas/document.js';
import type { Failure } from '../schemas/outcome.js';
import { canonicalJson } from '../infra/json.js';
import {
  loadKnowledgeContext,
  sameRootIdentity,
  type KnowledgeContext,
} from './context.js';
import {
  catalogDigestFor,
  catalogScopeFor,
  loadKnowledgeCatalogs,
  recordScope,
  setCatalogRecord,
  writeCatalogFile,
  type CatalogScope,
  type KnowledgeCatalogs,
} from './catalog.js';
import {
  acquireKnowledgeLock,
  knowledgeJournalPath,
  releaseKnowledgeLock,
  writeKnowledgeJournal,
} from './journal.js';
import { readKnowledgeFile, resolveKnowledgeLocation } from './paths.js';
import { findCanonicalAlias, findRecord, inspectFreshness } from './refs.js';
import type { FreshnessReport } from './refs.js';

const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

export interface PreviewReviewInput {
  readonly documentId: string;
  readonly scope?: 'shared' | 'private';
}

export interface PreviewReviewResult {
  readonly ok: boolean;
  readonly status:
    'ready' | 'current' | 'not-found' | 'ambiguous' | 'conflict' | 'failed';
  readonly plan: DocumentReviewPlan | null;
  readonly record: DocumentRecord | null;
  readonly freshness: FreshnessReport | null;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ApplyReviewInput {
  readonly plan: DocumentReviewPlan;
  /** Digest of the exact bytes a reviewer inspected and accepted. */
  readonly expectedFileDigest: string;
}

export interface ApplyReviewResult {
  readonly ok: boolean;
  readonly status:
    | 'reviewed'
    | 'unchanged'
    | 'stale'
    | 'conflict'
    | 'locked'
    | 'failed'
    | 'partial';
  readonly record: DocumentRecord | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly residualPaths: readonly string[];
  readonly journalPath: string | null;
}

function outcomeDiagnostic(failure: Failure, source: string): Diagnostic {
  return createDiagnostic({
    code: failure.code,
    severity: 'error',
    message: failure.message,
    source,
    hint: failure.nextAction,
  });
}

function reviewDiagnostic(
  code: (typeof diagnosticCodes)[keyof typeof diagnosticCodes],
  message: string,
  source: string,
  hint: string,
): Diagnostic {
  return createDiagnostic({ code, severity: 'error', message, source, hint });
}

/** Fingerprints every field a review may not change. */
function reviewableFingerprint(record: DocumentRecord): string {
  return canonicalJson({
    ...record,
    digest: 'sha256:review',
    lastReviewedAt: 'reviewed',
  });
}

interface ReviewState {
  readonly catalogs: KnowledgeCatalogs;
  readonly current: DocumentRecord;
  readonly next: DocumentRecord;
  readonly scope: CatalogScope;
  /** The pinned effect is already present; callers must still verify the bytes. */
  readonly alreadyApplied: boolean;
}

type ReviewStateOutcome =
  | {
      readonly ok: true;
      readonly state: ReviewState;
      readonly diagnostics: readonly Diagnostic[];
    }
  | {
      readonly ok: false;
      readonly status: 'conflict' | 'stale';
      readonly diagnostics: readonly Diagnostic[];
    };

/**
 * Re-derives the record a review plan pinned and refuses concurrent catalog,
 * record-identity or metadata drift. It never writes and never reads document
 * bytes: byte verification belongs to the caller.
 */
async function reviewState(
  context: KnowledgeContext,
  plan: DocumentReviewPlan,
): Promise<ReviewStateOutcome> {
  const catalogs = await loadKnowledgeCatalogs(context);
  if (!catalogs.ok) {
    return {
      ok: false,
      status: 'conflict',
      diagnostics: [...catalogs.diagnostics],
    };
  }
  const current = findRecord(catalogs, plan.documentId);
  if (current === null) {
    return {
      ok: false,
      status: 'conflict',
      diagnostics: [
        reviewDiagnostic(
          diagnosticCodes.document_not_found,
          `Document is not registered or is ambiguous: ${plan.documentId}`,
          context.configPath,
          'Read the catalog again before applying a review plan.',
        ),
      ],
    };
  }
  const scope = recordScope(catalogs, current);
  if (scope !== plan.scope || catalogScopeFor(current) !== scope) {
    return {
      ok: false,
      status: 'conflict',
      diagnostics: [
        reviewDiagnostic(
          diagnosticCodes.document_visibility_invalid,
          `Document ${plan.documentId} moved out of the ${plan.scope} catalog after the review plan was created.`,
          context.configPath,
          'Create a new review plan from the current catalog.',
        ),
      ],
    };
  }
  const next: DocumentRecord = {
    ...current,
    digest: plan.expectedFileDigest,
    lastReviewedAt: plan.reviewedAt,
  };
  if (reviewableFingerprint(next) !== reviewableFingerprint(plan.record)) {
    return {
      ok: false,
      status: 'stale',
      diagnostics: [
        reviewDiagnostic(
          diagnosticCodes.document_write_conflict,
          `Registered metadata of ${plan.documentId} changed after the review plan was created.`,
          context.configPath,
          'Create a new review plan; a review may not overwrite unrelated metadata.',
        ),
      ],
    };
  }
  const alreadyApplied =
    current.digest === plan.expectedFileDigest &&
    current.lastReviewedAt === plan.reviewedAt;
  if (alreadyApplied) {
    return {
      ok: true,
      state: { catalogs, current, next, scope, alreadyApplied },
      diagnostics: [...catalogs.diagnostics],
    };
  }
  if (catalogDigestFor(catalogs, scope) !== plan.catalogDigest) {
    return {
      ok: false,
      status: 'stale',
      diagnostics: [
        reviewDiagnostic(
          diagnosticCodes.document_write_conflict,
          `The ${scope} catalog changed after the review plan was created.`,
          context.configPath,
          'Create a new review plan; the pinned catalog state is no longer current.',
        ),
      ],
    };
  }
  if (current.digest !== plan.recordDigest) {
    return {
      ok: false,
      status: 'stale',
      diagnostics: [
        reviewDiagnostic(
          diagnosticCodes.document_write_conflict,
          `The registered digest of ${plan.documentId} changed after the review plan was created.`,
          context.configPath,
          'Create a new review plan; the registered bytes are no longer the reviewed ones.',
        ),
      ],
    };
  }
  return {
    ok: true,
    state: { catalogs, current, next, scope, alreadyApplied },
    diagnostics: [...catalogs.diagnostics],
  };
}

type ReviewedBytesOutcome =
  | {
      readonly ok: true;
      readonly digest: string;
      readonly absolutePath: string;
    }
  | {
      readonly ok: false;
      readonly status: 'stale' | 'conflict' | 'failed';
      readonly diagnostics: readonly Diagnostic[];
    };

/**
 * Re-reads the registered path and requires the exact reviewed bytes. It runs
 * for every apply, including a repeated plan whose effect is already present,
 * so a removed, symlinked or digest-mismatched file never reports success.
 */
async function verifyReviewedBytes(
  context: KnowledgeContext,
  catalogs: KnowledgeCatalogs,
  record: DocumentRecord,
  plan: DocumentReviewPlan,
): Promise<ReviewedBytesOutcome> {
  const resolved = await resolveKnowledgeLocation(context, record.location);
  if (!resolved.ok) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [outcomeDiagnostic(resolved, context.configPath)],
    };
  }
  const alias = await findCanonicalAlias(
    context,
    catalogs,
    resolved.value,
    record.documentId,
  );
  if (alias !== null) {
    return {
      ok: false,
      status: 'conflict',
      diagnostics: [
        reviewDiagnostic(
          diagnosticCodes.document_location_conflict,
          `Canonical document path is also registered by ${alias.documentId}.`,
          resolved.value.absolutePath,
          'Keep one documentId per real file before reviewing either record.',
        ),
      ],
    };
  }
  const file = await readKnowledgeFile(
    resolved.value.absolutePath,
    MAX_DOCUMENT_BYTES,
  );
  if (!file.ok) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [outcomeDiagnostic(file, resolved.value.absolutePath)],
    };
  }
  if (file.value.digest !== plan.expectedFileDigest) {
    return {
      ok: false,
      status: 'stale',
      diagnostics: [
        reviewDiagnostic(
          diagnosticCodes.document_file_changed,
          'Document bytes no longer match the reviewed digest of this plan.',
          resolved.value.absolutePath,
          'Review the current bytes and pin their digest in a new plan.',
        ),
      ],
    };
  }
  return {
    ok: true,
    digest: file.value.digest,
    absolutePath: resolved.value.absolutePath,
  };
}

function reviewJournal(
  operationId: string,
  stage: KnowledgeJournal['stage'],
  plan: DocumentReviewPlan,
  scope: CatalogScope,
  targetPath: string,
  createdAt: string,
  updatedAt: string,
  residualPaths: readonly string[],
  detail: string | null,
  catalogDigest = plan.catalogDigest,
): KnowledgeJournal {
  return {
    schema: 'pappra/knowledge-journal/1',
    operationId,
    operation: 'review-document',
    stage,
    documentId: plan.documentId,
    targetPath,
    catalogScope: scope,
    expectedDigest: plan.recordDigest,
    fileDigest: plan.expectedFileDigest,
    catalogDigest,
    createdAt,
    updatedAt,
    residualPaths: [...residualPaths],
    detail,
  };
}

/** Builds a read-only review plan; it never writes. */
export async function previewReview(
  context: KnowledgeContext,
  input: PreviewReviewInput,
): Promise<PreviewReviewResult> {
  const catalogs = await loadKnowledgeCatalogs(context);
  const diagnostics = [...context.diagnostics, ...catalogs.diagnostics];
  if (catalogs.idConflicts.has(input.documentId)) {
    diagnostics.push(
      reviewDiagnostic(
        diagnosticCodes.document_duplicate_id,
        `Document id is registered in more than one catalog: ${input.documentId}`,
        context.configPath,
        'Resolve the duplicate registration before reviewing either record.',
      ),
    );
    return {
      ok: false,
      status: 'ambiguous',
      plan: null,
      record: null,
      freshness: null,
      diagnostics,
    };
  }
  if (!catalogs.ok) {
    return {
      ok: false,
      status: 'conflict',
      plan: null,
      record: null,
      freshness: null,
      diagnostics,
    };
  }
  const record = findRecord(catalogs, input.documentId);
  if (record === null) {
    diagnostics.push(
      reviewDiagnostic(
        diagnosticCodes.document_not_found,
        `Document is not registered: ${input.documentId}`,
        context.configPath,
        'Register the document before reviewing it.',
      ),
    );
    return {
      ok: false,
      status: 'not-found',
      plan: null,
      record: null,
      freshness: null,
      diagnostics,
    };
  }
  const scope = recordScope(catalogs, record);
  if (catalogScopeFor(record) !== scope) {
    diagnostics.push(
      reviewDiagnostic(
        diagnosticCodes.document_visibility_invalid,
        `Document ${record.documentId} visibility and catalog membership disagree.`,
        context.configPath,
        'Repair the catalog entry before reviewing it.',
      ),
    );
    return {
      ok: false,
      status: 'conflict',
      plan: null,
      record,
      freshness: null,
      diagnostics,
    };
  }
  if (input.scope !== undefined && input.scope !== scope) {
    diagnostics.push(
      reviewDiagnostic(
        diagnosticCodes.document_visibility_invalid,
        `Document ${record.documentId} is registered in the ${scope} catalog, not ${input.scope}.`,
        context.configPath,
        'Request the scope that owns the record, or share it explicitly first.',
      ),
    );
    return {
      ok: false,
      status: 'conflict',
      plan: null,
      record,
      freshness: null,
      diagnostics,
    };
  }
  const resolved = await resolveKnowledgeLocation(context, record.location);
  if (!resolved.ok) {
    diagnostics.push(outcomeDiagnostic(resolved, context.configPath));
    return {
      ok: false,
      status: 'failed',
      plan: null,
      record,
      freshness: null,
      diagnostics,
    };
  }
  const alias = await findCanonicalAlias(
    context,
    catalogs,
    resolved.value,
    record.documentId,
  );
  if (alias !== null) {
    diagnostics.push(
      reviewDiagnostic(
        diagnosticCodes.document_location_conflict,
        `Canonical document path is also registered by ${alias.documentId}.`,
        resolved.value.absolutePath,
        'Keep one documentId per real file before reviewing either record.',
      ),
    );
    return {
      ok: false,
      status: 'conflict',
      plan: null,
      record,
      freshness: null,
      diagnostics,
    };
  }
  const file = await readKnowledgeFile(
    resolved.value.absolutePath,
    MAX_DOCUMENT_BYTES,
  );
  if (!file.ok) {
    diagnostics.push(outcomeDiagnostic(file, resolved.value.absolutePath));
    return {
      ok: false,
      status: 'failed',
      plan: null,
      record,
      freshness: null,
      diagnostics,
    };
  }
  const catalogDigest = catalogDigestFor(catalogs, scope);
  if (catalogDigest === null) {
    diagnostics.push(
      reviewDiagnostic(
        diagnosticCodes.document_catalog_invalid,
        `The ${scope} catalog has no readable state digest.`,
        context.configPath,
        'Repair the catalog before reviewing a document.',
      ),
    );
    return {
      ok: false,
      status: 'failed',
      plan: null,
      record,
      freshness: null,
      diagnostics,
    };
  }
  const freshness = await inspectFreshness(
    context,
    catalogs,
    record,
    MAX_DOCUMENT_BYTES,
  );
  const reviewedAt = new Date().toISOString();
  const plan = documentReviewPlanSchema.safeParse({
    schema: 'pappra/document-review-plan/1',
    planId: randomUUID(),
    createdAt: reviewedAt,
    documentId: record.documentId,
    scope,
    location: record.location,
    catalogDigest,
    rootIdentity: context.rootIdentity,
    expectedFileDigest: file.value.digest,
    recordDigest: record.digest,
    reviewedAt,
    record: {
      ...record,
      digest: file.value.digest,
      lastReviewedAt: reviewedAt,
    },
  });
  if (!plan.success) {
    diagnostics.push(
      reviewDiagnostic(
        diagnosticCodes.document_record_invalid,
        `Review plan is invalid: ${plan.error.issues[0]?.message ?? 'unknown issue'}`,
        context.configPath,
        'Repair the registered record before reviewing it.',
      ),
    );
    return {
      ok: false,
      status: 'failed',
      plan: null,
      record,
      freshness,
      diagnostics,
    };
  }
  return {
    ok: true,
    status: file.value.digest === record.digest ? 'current' : 'ready',
    plan: plan.data,
    record,
    freshness,
    diagnostics,
  };
}

/** Applies one pinned review plan under the existing knowledge lock and journal. */
export async function applyReviewAt(
  context: KnowledgeContext,
  input: ApplyReviewInput,
): Promise<ApplyReviewResult> {
  const parsed = documentReviewPlanSchema.safeParse(input.plan);
  if (!parsed.success) {
    return {
      ok: false,
      status: 'failed',
      record: null,
      diagnostics: [
        reviewDiagnostic(
          diagnosticCodes.document_record_invalid,
          `Review plan is invalid: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`,
          'knowledge review plan',
          'Create a new review plan from the current catalog.',
        ),
      ],
      residualPaths: [],
      journalPath: null,
    };
  }
  const plan = parsed.data;
  if (input.expectedFileDigest !== plan.expectedFileDigest) {
    return {
      ok: false,
      status: 'stale',
      record: null,
      diagnostics: [
        reviewDiagnostic(
          diagnosticCodes.document_proposal_stale,
          'The reviewed digest does not match the pinned review plan.',
          'knowledge review plan',
          'Pin the digest of the bytes that were actually reviewed.',
        ),
      ],
      residualPaths: [],
      journalPath: null,
    };
  }
  if (!sameRootIdentity(context, plan.rootIdentity)) {
    return {
      ok: false,
      status: 'stale',
      record: null,
      diagnostics: [
        reviewDiagnostic(
          diagnosticCodes.document_write_conflict,
          'Workspace root identity changed after the review plan was created.',
          context.configPath,
          'Create a new review plan inside the current workspace root.',
        ),
      ],
      residualPaths: [],
      journalPath: null,
    };
  }
  const initial = await reviewState(context, plan);
  if (!initial.ok) {
    return {
      ok: false,
      status: initial.status,
      record: null,
      diagnostics: initial.diagnostics,
      residualPaths: [],
      journalPath: null,
    };
  }
  const initialBytes = await verifyReviewedBytes(
    context,
    initial.state.catalogs,
    initial.state.current,
    plan,
  );
  if (!initialBytes.ok) {
    return {
      ok: false,
      status: initialBytes.status,
      record: null,
      diagnostics: [...initial.diagnostics, ...initialBytes.diagnostics],
      residualPaths: [],
      journalPath: null,
    };
  }
  if (initial.state.alreadyApplied) {
    return {
      ok: true,
      status: 'unchanged',
      record: initial.state.current,
      diagnostics: [...initial.diagnostics],
      residualPaths: [],
      journalPath: null,
    };
  }
  const lock = await acquireKnowledgeLock(context, 'review-document');
  if (!lock.ok || lock.lock === null) {
    return {
      ok: false,
      status: lock.status === 'locked' ? 'locked' : 'failed',
      record: null,
      diagnostics: [
        ...initial.diagnostics,
        reviewDiagnostic(
          lock.status === 'locked'
            ? diagnosticCodes.document_locked
            : diagnosticCodes.document_write_conflict,
          lock.message ?? 'Knowledge state is locked.',
          lock.path,
          'Retry after the current knowledge operation finishes.',
        ),
      ],
      residualPaths: [],
      journalPath: null,
    };
  }
  const heldLock = lock.lock;
  let applied: ApplyReviewResult | null = null;
  let releaseFailure: Diagnostic | null = null;
  try {
    applied = await writeReview(context, plan);
  } finally {
    const residualPaths: string[] = [];
    try {
      const release = await releaseKnowledgeLock(heldLock, lock.path);
      if (!release.ok) {
        releaseFailure = outcomeDiagnostic(release, lock.path);
        residualPaths.push(lock.path);
      }
    } catch (error) {
      // A release error never replaces the operation's own outcome or error.
      releaseFailure = reviewDiagnostic(
        diagnosticCodes.document_locked,
        `Knowledge lock release failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        lock.path,
        'Inspect the lock manually; it remains as evidence.',
      );
      residualPaths.push(lock.path);
    }
    if (releaseFailure !== null && applied !== null) {
      applied = {
        ...applied,
        ok: false,
        status: applied.ok ? 'partial' : applied.status,
        diagnostics: [...applied.diagnostics, releaseFailure],
        residualPaths: [...applied.residualPaths, ...residualPaths],
      };
    }
  }
  if (applied === null) {
    throw new Error('Review apply ended without an outcome.');
  }
  return applied;
}

/** The locked portion: reload, revalidate the pinned root and bytes, then write. */
async function writeReview(
  baseContext: KnowledgeContext,
  plan: DocumentReviewPlan,
): Promise<ApplyReviewResult> {
  const reloaded = await loadKnowledgeContext(baseContext.root);
  if (!reloaded.ok || reloaded.context === null) {
    return {
      ok: false,
      status: 'failed',
      record: null,
      diagnostics: [...reloaded.diagnostics],
      residualPaths: [],
      journalPath: null,
    };
  }
  const context = reloaded.context;
  if (!sameRootIdentity(context, plan.rootIdentity)) {
    return {
      ok: false,
      status: 'stale',
      record: null,
      diagnostics: [
        reviewDiagnostic(
          diagnosticCodes.document_write_conflict,
          'Workspace root identity changed while the review lock was held.',
          context.configPath,
          'Create a new review plan inside the current workspace root; nothing was written.',
        ),
      ],
      residualPaths: [],
      journalPath: null,
    };
  }
  const fresh = await reviewState(context, plan);
  if (!fresh.ok) {
    return {
      ok: false,
      status: fresh.status,
      record: null,
      diagnostics: fresh.diagnostics,
      residualPaths: [],
      journalPath: null,
    };
  }
  const { catalogs, current, next, scope } = fresh.state;
  const bytes = await verifyReviewedBytes(context, catalogs, current, plan);
  if (!bytes.ok) {
    return {
      ok: false,
      status: bytes.status,
      record: null,
      diagnostics: [...fresh.diagnostics, ...bytes.diagnostics],
      residualPaths: [],
      journalPath: null,
    };
  }
  const operationId = randomUUID();
  const createdAt = new Date().toISOString();
  const journalPath = knowledgeJournalPath(context, operationId);
  const journalWritten = await writeKnowledgeJournal(
    context,
    reviewJournal(
      operationId,
      'prepared',
      plan,
      scope,
      bytes.absolutePath,
      createdAt,
      createdAt,
      [],
      null,
    ),
  );
  if (!journalWritten.ok) {
    return {
      ok: false,
      status: 'failed',
      record: null,
      diagnostics: [
        ...fresh.diagnostics,
        outcomeDiagnostic(journalWritten, journalPath),
      ],
      residualPaths: [],
      journalPath,
    };
  }
  const changed = setCatalogRecord(context, catalogs, next);
  const written = await writeCatalogFile(
    context,
    changed.scope,
    changed.catalog,
    catalogDigestFor(catalogs, changed.scope),
  );
  if (!written.ok) {
    await writeKnowledgeJournal(
      context,
      reviewJournal(
        operationId,
        'failed',
        plan,
        scope,
        bytes.absolutePath,
        createdAt,
        new Date().toISOString(),
        [],
        written.message,
      ),
    );
    return {
      ok: false,
      status: 'failed',
      record: null,
      diagnostics: [
        ...fresh.diagnostics,
        reviewDiagnostic(
          written.code,
          written.message,
          written.nextAction ?? context.configPath,
          'The document file and its review metadata were not changed.',
        ),
      ],
      residualPaths: [],
      journalPath,
    };
  }
  const completeJournal = await writeKnowledgeJournal(
    context,
    reviewJournal(
      operationId,
      'complete',
      plan,
      changed.scope,
      bytes.absolutePath,
      createdAt,
      new Date().toISOString(),
      [],
      null,
      written.value.digest,
    ),
  );
  if (!completeJournal.ok) {
    return {
      ok: false,
      status: 'partial',
      record: next,
      diagnostics: [
        ...reloaded.diagnostics,
        outcomeDiagnostic(completeJournal, journalPath),
      ],
      residualPaths: [journalPath],
      journalPath,
    };
  }
  return {
    ok: true,
    status: 'reviewed',
    record: next,
    diagnostics: [...reloaded.diagnostics],
    residualPaths: [],
    journalPath,
  };
}
