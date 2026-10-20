import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import type { Diagnostic } from '../schemas/diagnostics.js';
import { createDiagnostic } from '../schemas/diagnostics.js';
import { diagnosticCodes } from '../schemas/errors.js';
import {
  knowledgeDeletePlanSchema,
  type DocumentRecord,
  type KnowledgeDeletePlan,
  type KnowledgeJournal,
} from '../schemas/document.js';
import { observePath } from '../infra/fs.js';
import type { Failure } from '../schemas/outcome.js';
import type { KnowledgeContext } from './context.js';
import { loadKnowledgeContext, sameRootIdentity } from './context.js';
import {
  catalogDigestFor,
  catalogFor,
  loadKnowledgeCatalogs,
  recordScope,
  removeCatalogRecord,
  setCatalogRecord,
  writeCatalogFile,
  type KnowledgeCatalogs,
} from './catalog.js';
import {
  acquireKnowledgeLock,
  knowledgeJournalPath,
  releaseKnowledgeLock,
  writeKnowledgeJournal,
} from './journal.js';
import { readKnowledgeFile, resolveKnowledgeLocation } from './paths.js';
import {
  findCanonicalAlias,
  findRecord,
  findRegisteredReferences,
} from './refs.js';
import type {
  ArchiveDocumentResult,
  DeleteExplicitResult,
  PreviewDeleteInput,
  PreviewDeleteResult,
  ShareDocumentResult,
  SupersedeDocumentInput,
  SupersedeDocumentResult,
} from './types.js';

const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const DELETE_PLAN_MAX_AGE_MS = 15 * 60 * 1000;

function diag(
  code: (typeof diagnosticCodes)[keyof typeof diagnosticCodes],
  message: string,
  source: string,
  hint: string,
): Diagnostic {
  return createDiagnostic({ code, severity: 'error', message, source, hint });
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

interface LockFailure {
  readonly ok: false;
  readonly status: 'locked' | 'failed';
  readonly diagnostics: readonly Diagnostic[];
}

async function withLock(
  context: KnowledgeContext,
  operation: KnowledgeJournal['operation'],
): Promise<
  | {
      readonly ok: true;
      readonly lock: NonNullable<
        Awaited<ReturnType<typeof acquireKnowledgeLock>>['lock']
      >;
      readonly path: string;
    }
  | LockFailure
> {
  const lock = await acquireKnowledgeLock(context, operation);
  if (!lock.ok || lock.lock === null) {
    return {
      ok: false,
      status: lock.status === 'locked' ? 'locked' : 'failed',
      diagnostics: [
        diag(
          lock.status === 'locked'
            ? diagnosticCodes.document_locked
            : diagnosticCodes.document_write_conflict,
          lock.message ?? 'Knowledge state is locked.',
          lock.path,
          'Retry after the current knowledge operation finishes.',
        ),
      ],
    };
  }
  return { ok: true, lock: lock.lock, path: lock.path };
}

export async function archiveDocument(
  context: KnowledgeContext,
  documentId: string,
): Promise<ArchiveDocumentResult> {
  const catalogs = await loadKnowledgeCatalogs(context);
  if (!catalogs.ok) {
    return {
      ok: false,
      status: 'conflict',
      record: null,
      diagnostics: [...catalogs.diagnostics],
    };
  }
  const record = findRecord(catalogs, documentId);
  if (record === null) {
    return {
      ok: false,
      status: 'not-found',
      record: null,
      diagnostics: [
        diag(
          diagnosticCodes.document_not_found,
          `Document is not registered or is ambiguous: ${documentId}`,
          context.configPath,
          'Read the catalog before retrying.',
        ),
      ],
    };
  }
  if (record.lifecycle === 'archived') {
    return { ok: true, status: 'unchanged', record, diagnostics: [] };
  }
  if (record.lifecycle === 'superseded') {
    return {
      ok: false,
      status: 'conflict',
      record,
      diagnostics: [
        diag(
          diagnosticCodes.document_supersede_invalid,
          'A superseded document cannot be archived with the archive operation.',
          context.configPath,
          'Preserve the supersession chain; archive only active documents.',
        ),
      ],
    };
  }
  const lock = await withLock(context, 'archive-document');
  if (!lock.ok) {
    return {
      ok: false,
      status: lock.status,
      record: null,
      diagnostics: [...lock.diagnostics],
    };
  }
  const heldLock = lock.lock;
  const archiveResult = await (async (): Promise<ArchiveDocumentResult> => {
    const reloaded = await loadKnowledgeContext(context.root);
    if (!reloaded.ok || reloaded.context === null) {
      return {
        ok: false,
        status: 'failed',
        record: null,
        diagnostics: [...reloaded.diagnostics],
      };
    }
    const fresh = await loadKnowledgeCatalogs(reloaded.context);
    const current = fresh.ok ? findRecord(fresh, documentId) : null;
    if (!fresh.ok || current === null) {
      return {
        ok: false,
        status: 'conflict',
        record: null,
        diagnostics: fresh.ok
          ? [
              diag(
                diagnosticCodes.document_not_found,
                'Document disappeared before archive.',
                reloaded.context.configPath,
                'Read the catalog again.',
              ),
            ]
          : [...fresh.diagnostics],
      };
    }
    if (current.lifecycle !== 'active') {
      return {
        ok: true,
        status: 'unchanged',
        record: current,
        diagnostics: [...fresh.diagnostics],
      };
    }
    const next: DocumentRecord = { ...current, lifecycle: 'archived' };
    const changed = setCatalogRecord(reloaded.context, fresh, next);
    const written = await writeCatalogFile(
      reloaded.context,
      changed.scope,
      changed.catalog,
      catalogDigestFor(fresh, changed.scope),
    );
    if (!written.ok) {
      return {
        ok: false,
        status: 'failed',
        record: null,
        diagnostics: [
          ...fresh.diagnostics,
          diag(
            written.code,
            written.message,
            written.nextAction ?? reloaded.context.configPath,
            'The document file and path were not changed.',
          ),
        ],
      };
    }
    return {
      ok: true,
      status: 'archived',
      record: next,
      diagnostics: [...fresh.diagnostics],
    };
  })();
  const release = await releaseKnowledgeLock(heldLock, lock.path);
  if (!release.ok) {
    return {
      ...archiveResult,
      ok: false,
      status: 'failed',
      diagnostics: [
        ...archiveResult.diagnostics,
        outcomeDiagnostic(release, lock.path),
      ],
    };
  }
  return archiveResult;
}

export async function supersedeDocument(
  context: KnowledgeContext,
  input: SupersedeDocumentInput,
): Promise<SupersedeDocumentResult> {
  const catalogs = await loadKnowledgeCatalogs(context);
  if (!catalogs.ok) {
    return {
      ok: false,
      status: 'conflict',
      record: null,
      diagnostics: [...catalogs.diagnostics],
    };
  }
  const source = findRecord(catalogs, input.documentId);
  const target = findRecord(catalogs, input.supersededBy);
  if (source === null || target === null) {
    return {
      ok: false,
      status: 'not-found',
      record: null,
      diagnostics: [
        diag(
          diagnosticCodes.document_supersede_invalid,
          'Both the source and replacement document must exist.',
          context.configPath,
          'Register the replacement first; supersede never creates a dangling target.',
        ),
      ],
    };
  }
  const validate = async (
    currentCatalogs: KnowledgeCatalogs,
  ): Promise<
    | { readonly source: DocumentRecord; readonly target: DocumentRecord }
    | Diagnostic
  > => {
    const currentSource = findRecord(currentCatalogs, input.documentId);
    const currentTarget = findRecord(currentCatalogs, input.supersededBy);
    if (currentSource === null || currentTarget === null) {
      return diag(
        diagnosticCodes.document_supersede_invalid,
        'A supersede endpoint disappeared before the operation.',
        context.configPath,
        'Read the catalog again.',
      );
    }
    if (input.documentId === input.supersededBy) {
      return diag(
        diagnosticCodes.document_supersede_invalid,
        'A document cannot supersede itself.',
        context.configPath,
        'Choose a different replacement document.',
      );
    }
    if (
      currentSource.visibility === 'shareable' &&
      currentTarget.visibility === 'private'
    ) {
      return diag(
        diagnosticCodes.document_visibility_invalid,
        'A shareable document cannot point to a private replacement.',
        context.configPath,
        'Keep the supersession chain within the same visibility boundary.',
      );
    }
    if (currentSource.lifecycle === 'archived') {
      return diag(
        diagnosticCodes.document_supersede_invalid,
        'An archived document cannot be superseded.',
        context.configPath,
        'Preserve the archived record; supersede active documents.',
      );
    }
    let current: DocumentRecord | null = currentTarget;
    const seen = new Set<string>([currentSource.documentId]);
    while (current !== null) {
      if (seen.has(current.documentId)) {
        return diag(
          diagnosticCodes.document_supersede_invalid,
          'The proposed replacement chain contains a cycle or returns to the source.',
          context.configPath,
          'Choose a replacement outside the existing chain.',
        );
      }
      seen.add(current.documentId);
      if (current.supersededBy === null) break;
      current = findRecord(currentCatalogs, current.supersededBy);
      if (current === null) {
        return diag(
          diagnosticCodes.document_supersede_invalid,
          'The existing supersession chain has a dangling replacement.',
          context.configPath,
          'Repair the dangling chain before adding another supersession.',
        );
      }
    }
    return { source: currentSource, target: currentTarget };
  };
  const initial = await validate(catalogs);
  if ('code' in initial) {
    return {
      ok: false,
      status: 'conflict',
      record: null,
      diagnostics: [initial],
    };
  }
  if (
    initial.source.lifecycle === 'superseded' &&
    initial.source.supersededBy === input.supersededBy
  ) {
    return {
      ok: true,
      status: 'unchanged',
      record: initial.source,
      diagnostics: [],
    };
  }
  if (initial.source.lifecycle === 'superseded') {
    return {
      ok: false,
      status: 'conflict',
      record: initial.source,
      diagnostics: [
        diag(
          diagnosticCodes.document_supersede_invalid,
          'The document already points to a different replacement.',
          context.configPath,
          'Preserve the existing chain; do not repoint historical supersessions.',
        ),
      ],
    };
  }
  const lock = await withLock(context, 'supersede-document');
  if (!lock.ok) {
    return {
      ok: false,
      status: lock.status,
      record: null,
      diagnostics: [...lock.diagnostics],
    };
  }
  const heldLock = lock.lock;
  const supersedeResult = await (async (): Promise<SupersedeDocumentResult> => {
    const reloaded = await loadKnowledgeContext(context.root);
    if (!reloaded.ok || reloaded.context === null) {
      return {
        ok: false,
        status: 'failed',
        record: null,
        diagnostics: [...reloaded.diagnostics],
      };
    }
    const fresh = await loadKnowledgeCatalogs(reloaded.context);
    if (!fresh.ok) {
      return {
        ok: false,
        status: 'conflict',
        record: null,
        diagnostics: [...fresh.diagnostics],
      };
    }
    const current = await validate(fresh);
    if ('code' in current) {
      return {
        ok: false,
        status: 'conflict',
        record: null,
        diagnostics: [current],
      };
    }
    const next: DocumentRecord = {
      ...current.source,
      lifecycle: 'superseded',
      supersededBy: current.target.documentId,
    };
    const changed = setCatalogRecord(reloaded.context, fresh, next);
    const written = await writeCatalogFile(
      reloaded.context,
      changed.scope,
      changed.catalog,
      catalogDigestFor(fresh, changed.scope),
    );
    if (!written.ok) {
      return {
        ok: false,
        status: 'failed',
        record: null,
        diagnostics: [
          ...fresh.diagnostics,
          outcomeDiagnostic(written, reloaded.context.configPath),
        ],
      };
    }
    return {
      ok: true,
      status: 'superseded',
      record: next,
      diagnostics: [...fresh.diagnostics],
    };
  })();
  const release = await releaseKnowledgeLock(heldLock, lock.path);
  if (!release.ok) {
    return {
      ...supersedeResult,
      ok: false,
      status: 'failed',
      diagnostics: [
        ...supersedeResult.diagnostics,
        outcomeDiagnostic(release, lock.path),
      ],
    };
  }
  return supersedeResult;
}

export async function shareDocument(
  context: KnowledgeContext,
  documentId: string,
): Promise<ShareDocumentResult> {
  const catalogs = await loadKnowledgeCatalogs(context);
  if (!catalogs.ok) {
    return {
      ok: false,
      status: 'conflict',
      record: null,
      diagnostics: [...catalogs.diagnostics],
      residualPaths: [],
    };
  }
  const record = findRecord(catalogs, documentId);
  if (record === null) {
    return {
      ok: false,
      status: 'not-found',
      record: null,
      diagnostics: [
        diag(
          diagnosticCodes.document_not_found,
          `Document is not registered or is ambiguous: ${documentId}`,
          context.configPath,
          'Read the catalog before retrying.',
        ),
      ],
      residualPaths: [],
    };
  }
  if (record.visibility === 'shareable') {
    return {
      ok: true,
      status: 'unchanged',
      record,
      diagnostics: [],
      residualPaths: [],
    };
  }
  if (record.taskId !== null) {
    return {
      ok: false,
      status: 'conflict',
      record,
      diagnostics: [
        diag(
          diagnosticCodes.document_task_state_unknown,
          'A private task-linked document cannot be moved to the shared catalog automatically.',
          context.configPath,
          'Review task ownership and remove the private task link explicitly before sharing.',
        ),
      ],
      residualPaths: [],
    };
  }
  const lock = await withLock(context, 'share-document');
  if (!lock.ok) {
    return {
      ok: false,
      status: lock.status,
      record: null,
      diagnostics: [...lock.diagnostics],
      residualPaths: [],
    };
  }
  const heldLock = lock.lock;
  const shareResult = await (async (): Promise<ShareDocumentResult> => {
    const reloaded = await loadKnowledgeContext(context.root);
    if (!reloaded.ok || reloaded.context === null) {
      return {
        ok: false,
        status: 'failed',
        record: null,
        diagnostics: [...reloaded.diagnostics],
        residualPaths: [],
      };
    }
    const fresh = await loadKnowledgeCatalogs(reloaded.context);
    const current = fresh.ok ? findRecord(fresh, documentId) : null;
    if (!fresh.ok || current === null) {
      return {
        ok: false,
        status: 'conflict',
        record: null,
        diagnostics: fresh.ok
          ? [
              diag(
                diagnosticCodes.document_not_found,
                'Document disappeared before sharing.',
                reloaded.context.configPath,
                'Read the catalog again.',
              ),
            ]
          : [...fresh.diagnostics],
        residualPaths: [],
      };
    }
    if (current.taskId !== null) {
      return {
        ok: false,
        status: 'conflict',
        record: current,
        diagnostics: [
          diag(
            diagnosticCodes.document_task_state_unknown,
            'Task-linked documents require explicit task ownership review before sharing.',
            reloaded.context.configPath,
            'No catalog or file was changed.',
          ),
        ],
        residualPaths: [],
      };
    }
    const supersessionTarget =
      current.supersededBy === null
        ? null
        : findRecord(fresh, current.supersededBy);
    if (
      current.supersededBy !== null &&
      (supersessionTarget === null ||
        supersessionTarget.visibility === 'private')
    ) {
      return {
        ok: false,
        status: 'conflict',
        record: current,
        diagnostics: [
          diag(
            diagnosticCodes.document_visibility_invalid,
            'A private supersession target would enter the shared catalog.',
            reloaded.context.configPath,
            'Review or share the replacement document explicitly first.',
          ),
        ],
        residualPaths: [],
      };
    }
    const privateReference = current.sources.find(
      (source) =>
        source.kind === 'document' &&
        findRecord(fresh, source.documentId)?.visibility === 'private',
    );
    if (privateReference !== undefined) {
      return {
        ok: false,
        status: 'conflict',
        record: current,
        diagnostics: [
          diag(
            diagnosticCodes.document_visibility_invalid,
            'A private source reference would enter the shared catalog.',
            reloaded.context.configPath,
            'Review the referenced documents and share them explicitly first.',
          ),
        ],
        residualPaths: [],
      };
    }
    const next: DocumentRecord = { ...current, visibility: 'shareable' };
    const sharedCatalog = catalogFor(fresh, 'shared', reloaded.context);
    const sharedWrite = await writeCatalogFile(
      reloaded.context,
      'shared',
      {
        ...sharedCatalog,
        updatedAt: new Date().toISOString(),
        records: [...sharedCatalog.records, next].sort((left, right) =>
          left.documentId.localeCompare(right.documentId),
        ),
      },
      catalogDigestFor(fresh, 'shared'),
    );
    if (!sharedWrite.ok) {
      return {
        ok: false,
        status: 'failed',
        record: null,
        diagnostics: [
          ...fresh.diagnostics,
          outcomeDiagnostic(sharedWrite, reloaded.context.configPath),
        ],
        residualPaths: [],
      };
    }
    const privateCatalog = catalogFor(fresh, 'private', reloaded.context);
    const privateWrite = await writeCatalogFile(
      reloaded.context,
      'private',
      {
        ...privateCatalog,
        updatedAt: new Date().toISOString(),
        records: privateCatalog.records.filter(
          (entry) => entry.documentId !== documentId,
        ),
      },
      catalogDigestFor(fresh, 'private'),
    );
    if (!privateWrite.ok) {
      const rollback = await writeCatalogFile(
        reloaded.context,
        'shared',
        sharedCatalog,
        sharedWrite.value.digest,
      );
      const privatePath =
        reloaded.context.root + '/.pappra/local/knowledge/catalog.json';
      if (rollback.ok) {
        return {
          ok: false,
          status: 'failed',
          record: null,
          diagnostics: [
            ...fresh.diagnostics,
            outcomeDiagnostic(privateWrite, privatePath),
            diag(
              diagnosticCodes.document_visibility_invalid,
              'The shared catalog update was rolled back because the private catalog could not be updated.',
              reloaded.context.configPath,
              'The record remains private; retry the explicit share operation.',
            ),
          ],
          residualPaths: [],
        };
      }
      return {
        ok: false,
        status: 'partial',
        record: null,
        diagnostics: [
          ...fresh.diagnostics,
          outcomeDiagnostic(privateWrite, privatePath),
          diag(
            diagnosticCodes.document_visibility_invalid,
            'Sharing is partially applied and the private catalog could not be updated; duplicate-id conflict is possible.',
            reloaded.context.configPath,
            'Inspect both catalogs and the journal state manually; no auto-repair is attempted.',
          ),
        ],
        residualPaths: [privatePath],
      };
    }
    return {
      ok: true,
      status: 'shared',
      record: next,
      diagnostics: [...fresh.diagnostics],
      residualPaths: [],
    };
  })();
  const release = await releaseKnowledgeLock(heldLock, lock.path);
  if (!release.ok) {
    return {
      ...shareResult,
      ok: false,
      status: shareResult.ok ? 'partial' : shareResult.status,
      diagnostics: [
        ...shareResult.diagnostics,
        outcomeDiagnostic(release, lock.path),
      ],
      residualPaths: [...shareResult.residualPaths, lock.path],
    };
  }
  return shareResult;
}

async function inspectDelete(
  context: KnowledgeContext,
  input: PreviewDeleteInput,
): Promise<PreviewDeleteResult> {
  const catalogs = await loadKnowledgeCatalogs(context);
  if (!catalogs.ok) {
    return {
      ok: false,
      status: 'failed',
      plan: null,
      diagnostics: [...catalogs.diagnostics],
    };
  }
  const record = findRecord(catalogs, input.documentId);
  if (record === null) {
    return {
      ok: false,
      status: 'not-found',
      plan: null,
      diagnostics: [
        diag(
          diagnosticCodes.document_not_found,
          `Document is not registered or is ambiguous: ${input.documentId}`,
          context.configPath,
          'Read the catalog before deleting.',
        ),
      ],
    };
  }
  const blockers: {
    code: string;
    message: string;
  }[] = [];
  const references = findRegisteredReferences(catalogs, record.documentId);
  for (const reference of references) {
    blockers.push({
      code: diagnosticCodes.document_delete_blocked,
      message: `Document is referenced by ${reference.documentId} (${reference.relation}).`,
    });
  }
  if (record.taskId !== null) {
    blockers.push({
      code: diagnosticCodes.document_task_state_unknown,
      message: `Document is linked to task ${record.taskId}; execution state is unknown without P07/P10 evidence.`,
    });
  }
  const recordLocation = await resolveKnowledgeLocation(
    context,
    record.location,
  );
  if (recordLocation.ok) {
    const alias = await findCanonicalAlias(
      context,
      catalogs,
      recordLocation.value,
      record.documentId,
    );
    if (alias !== null) {
      blockers.push({
        code: diagnosticCodes.document_location_conflict,
        message: `Canonical document path is also registered by ${alias.documentId}.`,
      });
    }
  }
  let expectedFileDigest: string | null = null;
  let expectedFileIdentity: { dev: number; ino: number } | null = null;
  if (input.removeFile) {
    const resolved = await resolveKnowledgeLocation(context, record.location);
    if (!resolved.ok) {
      blockers.push({
        code: resolved.code,
        message: resolved.message,
      });
    } else {
      if (resolved.value.access !== 'write') {
        blockers.push({
          code: diagnosticCodes.document_access_denied,
          message: 'Document file belongs to a read-only repository.',
        });
        expectedFileDigest = null;
        expectedFileIdentity = null;
      } else {
        const file = await readKnowledgeFile(
          resolved.value.absolutePath,
          MAX_DOCUMENT_BYTES,
        );
        if (!file.ok) {
          blockers.push({ code: file.code, message: file.message });
        } else if (file.value.digest !== record.digest) {
          blockers.push({
            code: diagnosticCodes.document_file_changed,
            message: 'Document bytes no longer match the registered digest.',
          });
        } else {
          const observation = await observePath(resolved.value.absolutePath);
          if (observation.stats === null) {
            blockers.push({
              code: diagnosticCodes.document_path_unsafe,
              message: 'Cannot observe document file identity.',
            });
          } else {
            expectedFileDigest = file.value.digest;
            expectedFileIdentity = {
              dev: observation.stats.dev,
              ino: observation.stats.ino,
            };
          }
        }
      }
    }
  }
  const plan: KnowledgeDeletePlan = {
    schema: 'pappra/knowledge-delete-plan/1',
    planId: randomUUID(),
    createdAt: new Date().toISOString(),
    documentId: record.documentId,
    removeFile: input.removeFile,
    location: record.location,
    expectedFileDigest,
    expectedFileIdentity,
    catalogScope: recordScope(catalogs, record),
    catalogDigest: catalogs.catalogDigest,
    rootIdentity: context.rootIdentity,
    references: [...references],
    pathReferences: 'unchecked',
    coverage: 'catalog-only',
    taskState: record.taskId === null ? 'not-linked' : 'unknown',
    blockers,
    deletable: blockers.length === 0,
  };
  const parsed = knowledgeDeletePlanSchema.safeParse(plan);
  if (!parsed.success) {
    return {
      ok: false,
      status: 'failed',
      plan: null,
      diagnostics: [
        diag(
          diagnosticCodes.document_delete_blocked,
          `Delete plan is invalid: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`,
          context.configPath,
          'Inspect the record; no file was deleted.',
        ),
      ],
    };
  }
  const diagnostics = [...catalogs.diagnostics];
  for (const blocker of blockers) {
    diagnostics.push({
      code: diagnosticCodes.document_delete_blocked,
      severity: 'warning',
      message: blocker.message,
      source: context.configPath,
      pointer: null,
      hint: 'Delete is blocked; resolve the reference/task/file state explicitly.',
    });
  }
  return {
    ok: true,
    status: plan.deletable ? 'ready' : 'blocked',
    plan: parsed.data,
    diagnostics,
  };
}

export async function previewDelete(
  context: KnowledgeContext,
  input: PreviewDeleteInput,
): Promise<PreviewDeleteResult> {
  return inspectDelete(context, input);
}

function sameFileIdentity(
  left: KnowledgeDeletePlan['expectedFileIdentity'],
  right: KnowledgeDeletePlan['expectedFileIdentity'],
): boolean {
  if (left === null || right === null) return left === right;
  return left.dev === right.dev && left.ino === right.ino;
}

function planMismatch(
  plan: KnowledgeDeletePlan,
  next: KnowledgeDeletePlan,
): boolean {
  return (
    plan.documentId !== next.documentId ||
    plan.removeFile !== next.removeFile ||
    JSON.stringify(plan.location) !== JSON.stringify(next.location) ||
    plan.catalogDigest !== next.catalogDigest ||
    plan.expectedFileDigest !== next.expectedFileDigest ||
    !sameFileIdentity(plan.expectedFileIdentity, next.expectedFileIdentity) ||
    plan.catalogScope !== next.catalogScope ||
    plan.taskState !== next.taskState ||
    plan.deletable !== next.deletable ||
    plan.references.length !== next.references.length
  );
}

export async function deleteExplicit(
  context: KnowledgeContext,
  plan: KnowledgeDeletePlan,
): Promise<DeleteExplicitResult> {
  const parsedPlan = knowledgeDeletePlanSchema.safeParse(plan);
  if (!parsedPlan.success) {
    return {
      ok: false,
      status: 'stale',
      documentId: null,
      diagnostics: [
        diag(
          diagnosticCodes.document_delete_stale,
          `Delete plan is invalid: ${parsedPlan.error.issues[0]?.message ?? 'unknown issue'}`,
          context.configPath,
          'Generate a fresh preview.',
        ),
      ],
      residualPaths: [],
      journalPath: null,
    };
  }
  const planAge = Date.now() - Date.parse(plan.createdAt);
  if (
    !Number.isFinite(planAge) ||
    planAge < 0 ||
    planAge > DELETE_PLAN_MAX_AGE_MS
  ) {
    return {
      ok: false,
      status: 'stale',
      documentId: plan.documentId,
      diagnostics: [
        diag(
          diagnosticCodes.document_delete_stale,
          'Delete preview has expired; generate and confirm a fresh plan.',
          context.configPath,
          'No file or catalog was removed.',
        ),
      ],
      residualPaths: [],
      journalPath: null,
    };
  }
  if (!plan.deletable || plan.blockers.length > 0) {
    return {
      ok: false,
      status: 'blocked',
      documentId: plan.documentId,
      diagnostics: [
        diag(
          diagnosticCodes.document_delete_blocked,
          'Delete plan has unresolved blockers.',
          context.configPath,
          'Resolve references/task/file blockers and preview again.',
        ),
      ],
      residualPaths: [],
      journalPath: null,
    };
  }
  const lock = await acquireKnowledgeLock(context, 'delete-document');
  if (!lock.ok || lock.lock === null) {
    return {
      ok: false,
      status: lock.status === 'locked' ? 'locked' : 'failed',
      documentId: plan.documentId,
      diagnostics: [
        diag(
          lock.status === 'locked'
            ? diagnosticCodes.document_locked
            : diagnosticCodes.document_delete_blocked,
          lock.message ?? 'Knowledge state is locked.',
          lock.path,
          'Retry after the current knowledge operation finishes.',
        ),
      ],
      residualPaths: [],
      journalPath: null,
    };
  }
  const operationId = randomUUID();
  const journalPath = knowledgeJournalPath(context, operationId);
  let residualPaths: string[] = [];
  const deleteResult = await (async (): Promise<DeleteExplicitResult> => {
    const reloaded = await loadKnowledgeContext(context.root);
    if (!reloaded.ok || reloaded.context === null) {
      return {
        ok: false,
        status: 'failed',
        documentId: plan.documentId,
        diagnostics: [...reloaded.diagnostics],
        residualPaths: [],
        journalPath,
      };
    }
    const currentContext = reloaded.context;
    if (
      !sameRootIdentity(currentContext, plan.rootIdentity) ||
      plan.planId.length === 0
    ) {
      return {
        ok: false,
        status: 'stale',
        documentId: plan.documentId,
        diagnostics: [
          diag(
            diagnosticCodes.document_delete_stale,
            'Workspace root identity changed since the delete preview.',
            currentContext.configPath,
            'Generate a fresh preview.',
          ),
        ],
        residualPaths: [],
        journalPath,
      };
    }
    const fresh = await inspectDelete(currentContext, {
      documentId: plan.documentId,
      removeFile: plan.removeFile,
    });
    if (
      !fresh.ok ||
      fresh.plan === null ||
      !fresh.plan.deletable ||
      planMismatch(plan, fresh.plan) ||
      fresh.plan.catalogDigest !== plan.catalogDigest
    ) {
      return {
        ok: false,
        status: 'stale',
        documentId: plan.documentId,
        diagnostics: [
          ...fresh.diagnostics,
          diag(
            diagnosticCodes.document_delete_stale,
            'Delete preview is no longer current; no file or catalog was removed.',
            currentContext.configPath,
            'Generate a fresh preview and confirm it again.',
          ),
        ],
        residualPaths: [],
        journalPath,
      };
    }
    const catalogs = await loadKnowledgeCatalogs(currentContext);
    if (!catalogs.ok || catalogs.catalogDigest !== plan.catalogDigest) {
      return {
        ok: false,
        status: 'stale',
        documentId: plan.documentId,
        diagnostics: [
          ...catalogs.diagnostics,
          diag(
            diagnosticCodes.document_delete_stale,
            'Catalog changed after the delete preview; no file or catalog was removed.',
            currentContext.configPath,
            'Generate a fresh preview and confirm it again.',
          ),
        ],
        residualPaths: [],
        journalPath,
      };
    }
    const record = findRecord(catalogs, plan.documentId);
    if (record === null) {
      return {
        ok: false,
        status: 'stale',
        documentId: plan.documentId,
        diagnostics: [
          diag(
            diagnosticCodes.document_delete_stale,
            'Document disappeared before delete.',
            currentContext.configPath,
            'No file or catalog was removed.',
          ),
        ],
        residualPaths: [],
        journalPath,
      };
    }
    const removed = removeCatalogRecord(currentContext, catalogs, record);
    const initialJournal: KnowledgeJournal = {
      schema: 'pappra/knowledge-journal/1',
      operationId,
      operation: 'delete-document',
      stage: 'prepared',
      documentId: record.documentId,
      targetPath: null,
      catalogScope: removed.scope,
      expectedDigest: plan.expectedFileDigest,
      fileDigest: plan.expectedFileDigest,
      catalogDigest: catalogs.catalogDigest,
      createdAt: plan.createdAt,
      updatedAt: new Date().toISOString(),
      residualPaths: [],
      detail: plan.removeFile
        ? 'Deleting document file and record.'
        : 'Removing catalog record only.',
    };
    const journalWritten = await writeKnowledgeJournal(
      currentContext,
      initialJournal,
    );
    if (!journalWritten.ok) {
      return {
        ok: false,
        status: 'failed',
        documentId: record.documentId,
        diagnostics: [outcomeDiagnostic(journalWritten, journalPath)],
        residualPaths: [],
        journalPath,
      };
    }
    const catalogWritten = await writeCatalogFile(
      currentContext,
      removed.scope,
      removed.catalog,
      catalogDigestFor(catalogs, removed.scope),
    );
    if (!catalogWritten.ok) {
      return {
        ok: false,
        status: 'failed',
        documentId: record.documentId,
        diagnostics: [outcomeDiagnostic(catalogWritten, journalPath)],
        residualPaths: [],
        journalPath,
      };
    }
    const catalogStage: KnowledgeJournal = {
      ...initialJournal,
      stage: 'catalog-written',
      updatedAt: new Date().toISOString(),
      detail: plan.removeFile
        ? 'Catalog record removed; file deletion is pending.'
        : 'Catalog record removed; file retained.',
    };
    const catalogStageWritten = await writeKnowledgeJournal(
      currentContext,
      catalogStage,
    );
    if (!catalogStageWritten.ok) {
      return {
        ok: false,
        status: 'partial',
        documentId: record.documentId,
        diagnostics: [
          ...currentContext.diagnostics,
          outcomeDiagnostic(catalogStageWritten, journalPath),
        ],
        residualPaths: [journalPath],
        journalPath,
      };
    }
    if (!plan.removeFile) {
      const complete = await writeKnowledgeJournal(currentContext, {
        ...catalogStage,
        stage: 'complete',
        updatedAt: new Date().toISOString(),
        detail: 'Catalog record removed; file retained by explicit plan.',
      });
      if (!complete.ok) {
        return {
          ok: false,
          status: 'partial',
          documentId: record.documentId,
          diagnostics: [
            ...currentContext.diagnostics,
            outcomeDiagnostic(complete, journalPath),
          ],
          residualPaths: [journalPath],
          journalPath,
        };
      }
      return {
        ok: true,
        status: 'unregistered',
        documentId: record.documentId,
        diagnostics: [...currentContext.diagnostics],
        residualPaths: [],
        journalPath,
      };
    }
    const resolved = await resolveKnowledgeLocation(
      currentContext,
      record.location,
      { forWrite: plan.removeFile },
    );
    if (!resolved.ok) {
      residualPaths = [];
      return {
        ok: false,
        status: 'partial',
        documentId: record.documentId,
        diagnostics: [
          diag(
            resolved.code,
            resolved.message,
            resolved.nextAction ?? currentContext.configPath,
            'Catalog record was removed; the file path could not be resolved and was preserved.',
          ),
        ],
        residualPaths,
        journalPath,
      };
    }
    residualPaths = [resolved.value.absolutePath];
    const file = await readKnowledgeFile(
      resolved.value.absolutePath,
      MAX_DOCUMENT_BYTES,
    );
    const observation = await observePath(resolved.value.absolutePath);
    if (
      !file.ok ||
      file.value.digest !== plan.expectedFileDigest ||
      observation.stats === null ||
      plan.expectedFileIdentity === null ||
      observation.stats.dev !== plan.expectedFileIdentity.dev ||
      observation.stats.ino !== plan.expectedFileIdentity.ino
    ) {
      await writeKnowledgeJournal(currentContext, {
        ...catalogStage,
        stage: 'failed',
        residualPaths,
        updatedAt: new Date().toISOString(),
        detail:
          'Catalog record removed, but the document file changed; file preserved.',
      });
      return {
        ok: false,
        status: 'partial',
        documentId: record.documentId,
        diagnostics: [
          diag(
            diagnosticCodes.document_delete_stale,
            'Document file changed after preview; catalog was removed but the file was preserved.',
            resolved.value.absolutePath,
            'Inspect the journal and re-register or remove the file explicitly.',
          ),
        ],
        residualPaths,
        journalPath,
      };
    }
    try {
      await unlink(resolved.value.absolutePath);
    } catch (error) {
      await writeKnowledgeJournal(currentContext, {
        ...catalogStage,
        stage: 'failed',
        residualPaths,
        updatedAt: new Date().toISOString(),
        detail:
          'Catalog record removed, but file deletion failed; file preserved.',
      });
      return {
        ok: false,
        status: 'partial',
        documentId: record.documentId,
        diagnostics: [
          diag(
            diagnosticCodes.document_delete_stale,
            `Catalog record removed, but file deletion failed: ${error instanceof Error ? error.message : String(error)}`,
            resolved.value.absolutePath,
            'Inspect the journal and permissions; the file was preserved.',
          ),
        ],
        residualPaths,
        journalPath,
      };
    }
    residualPaths = [];
    const complete = await writeKnowledgeJournal(currentContext, {
      ...catalogStage,
      stage: 'complete',
      residualPaths: [],
      updatedAt: new Date().toISOString(),
      detail: 'Catalog record and document file removed by explicit plan.',
    });
    if (!complete.ok) {
      return {
        ok: false,
        status: 'partial',
        documentId: record.documentId,
        diagnostics: [
          ...currentContext.diagnostics,
          outcomeDiagnostic(complete, journalPath),
        ],
        residualPaths: [journalPath],
        journalPath,
      };
    }
    return {
      ok: true,
      status: 'deleted',
      documentId: record.documentId,
      diagnostics: [...currentContext.diagnostics],
      residualPaths: [],
      journalPath,
    };
  })();
  const release = await releaseKnowledgeLock(lock.lock, lock.path);
  if (!release.ok) {
    return {
      ...deleteResult,
      ok: false,
      status: deleteResult.ok ? 'partial' : deleteResult.status,
      diagnostics: [
        ...deleteResult.diagnostics,
        outcomeDiagnostic(release, lock.path),
      ],
      residualPaths: [...deleteResult.residualPaths, lock.path],
    };
  }
  return deleteResult;
}
