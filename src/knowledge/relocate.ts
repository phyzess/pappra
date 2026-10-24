import { createDiagnostic } from '../schemas/diagnostics.js';
import { diagnosticCodes } from '../schemas/errors.js';
import type { DocumentLocation } from '../schemas/document.js';
import type { KnowledgeContext } from './context.js';
import { loadKnowledgeContext, sameRootIdentity } from './context.js';
import {
  catalogDigestFor,
  catalogFor,
  loadKnowledgeCatalogs,
  recordScope,
  recordsForCatalog,
  setCatalogRecord,
  writeCatalogFile,
  type CatalogScope,
} from './catalog.js';
import { acquireKnowledgeLock, releaseKnowledgeLock } from './journal.js';
import {
  findCanonicalAlias,
  findRecord,
  findRegisteredReferences,
} from './refs.js';
import { readKnowledgeFile, resolveKnowledgeLocation } from './paths.js';
import type { RegisterDocumentResult } from './types.js';

export async function relocateOrForgetDocument(
  context: KnowledgeContext,
  documentId: string,
  location: DocumentLocation | null,
  scope?: CatalogScope,
): Promise<RegisterDocumentResult> {
  const failure = (message: string): RegisterDocumentResult => ({
    ok: false,
    status: 'conflict',
    record: null,
    diagnostics: [
      createDiagnostic({
        code: diagnosticCodes.document_write_conflict,
        severity: 'error',
        message,
        source: context.configPath,
        hint: 'No document content is changed by relocate or forget.',
      }),
    ],
  });
  if (
    scope !== undefined &&
    (!['shared', 'private'].includes(scope) || location !== null)
  )
    return failure(
      'An explicit shared/private scope is accepted only for forget.',
    );
  const held = await acquireKnowledgeLock(context, 'write-document');
  if (!held.ok || !held.lock)
    return failure(held.message ?? 'Knowledge state is locked.');
  try {
    const loaded = await loadKnowledgeContext(context.root);
    if (
      !loaded.ok ||
      !loaded.context ||
      !sameRootIdentity(loaded.context, context.rootIdentity)
    )
      return failure('Workspace identity changed.');
    context = loaded.context;
    const catalogs = await loadKnowledgeCatalogs(context);
    if (
      !catalogs.shared.valid ||
      !catalogs.private.valid ||
      (scope === undefined && catalogs.idConflicts.size > 0)
    )
      return {
        ok: false,
        status: 'conflict',
        record: null,
        diagnostics: [...catalogs.diagnostics],
      };
    const scoped =
      scope === undefined
        ? null
        : catalogFor(catalogs, scope, context).records.filter(
            (entry) => entry.documentId === documentId,
          );
    const record =
      scoped === null
        ? findRecord(catalogs, documentId)
        : scoped.length === 1
          ? scoped[0]
          : null;
    if (!record)
      return failure('Document id is not registered or is ambiguous.');
    if (record.taskId !== null)
      return failure(
        'Task-linked records require explicit task ownership review before relocating or forgetting.',
      );
    if (location === null) {
      const retainedInOtherScope =
        scope === 'private' &&
        catalogFor(catalogs, 'shared', context).records.some(
          (entry) => entry.documentId === documentId,
        );
      if (
        !retainedInOtherScope &&
        findRegisteredReferences(catalogs, documentId).length > 0
      )
        return failure(
          'Other documents reference this id; update their references before forgetting it.',
        );
      const removedScope = scope ?? recordScope(catalogs, record);
      const catalog = catalogFor(catalogs, removedScope, context);
      const written = await writeCatalogFile(
        context,
        removedScope,
        { ...catalog, records: recordsForCatalog(catalog, documentId, null) },
        catalogDigestFor(catalogs, removedScope),
      );
      return written.ok
        ? { ok: true, status: 'existing', record, diagnostics: [] }
        : failure(written.message);
    }
    const resolved = await resolveKnowledgeLocation(context, location);
    if (!resolved.ok) return failure(resolved.message);
    const file = await readKnowledgeFile(
      resolved.value.absolutePath,
      8 * 1024 * 1024,
    );
    if (!file.ok || file.value.digest !== record.digest)
      return failure(
        'Relocation target does not match the registered content digest.',
      );
    const alias = await findCanonicalAlias(
      context,
      catalogs,
      resolved.value,
      record.documentId,
    );
    if (alias)
      return failure('Relocation target is owned by another active document.');
    const next = { ...record, location: resolved.value.location };
    const update = setCatalogRecord(context, catalogs, next);
    const written = await writeCatalogFile(
      context,
      update.scope,
      update.catalog,
      catalogDigestFor(catalogs, update.scope),
    );
    return written.ok
      ? { ok: true, status: 'existing', record: next, diagnostics: [] }
      : failure(written.message);
  } finally {
    const released = await releaseKnowledgeLock(held.lock, held.path);
    if (!released.ok)
      return failure(
        'Metadata may have committed, but its lock could not be released; inspect the catalog before retrying.',
      );
  }
}
