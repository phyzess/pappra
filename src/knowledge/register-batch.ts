import { randomUUID } from 'node:crypto';
import type { Diagnostic } from '../schemas/diagnostics.js';
import { createDiagnostic } from '../schemas/diagnostics.js';
import { diagnosticCodes } from '../schemas/errors.js';
import type { DocumentRecord, KnowledgeJournal } from '../schemas/document.js';
import { samePath } from '../schemas/paths.js';
import { observePath } from '../infra/fs.js';
import {
  loadKnowledgeContext,
  sameRootIdentity,
  type KnowledgeContext,
} from './context.js';
import {
  catalogDigestFor,
  catalogFor,
  catalogScopeFor,
  loadKnowledgeCatalogs,
  locationKey,
  writeCatalogFile,
} from './catalog.js';
import {
  acquireKnowledgeLock,
  releaseKnowledgeLock,
  writeKnowledgeJournal,
} from './journal.js';
import { readKnowledgeFile, resolveKnowledgeLocation } from './paths.js';
import { validateSources } from './refs.js';
import { validateAndBuildRecord } from './write.js';
import type { RegisterDocumentInput, RegisterDocumentResult } from './types.js';

/** One context, catalog snapshot and lock for a bounded discovery batch. */
export async function registerDocumentBatch(
  context: KnowledgeContext,
  inputs: readonly RegisterDocumentInput[],
): Promise<readonly RegisterDocumentResult[]> {
  if (inputs.length === 0) return [];
  const fail = (
    message: string,
    diagnostics: readonly Diagnostic[] = [],
  ): readonly RegisterDocumentResult[] =>
    inputs.map(() => ({
      ok: false,
      status: 'failed',
      record: null,
      diagnostics: [
        ...diagnostics,
        createDiagnostic({
          code: diagnosticCodes.document_write_conflict,
          severity: 'error',
          message,
          source: context.configPath,
        }),
      ],
    }));
  const held = await acquireKnowledgeLock(context, 'write-document');
  if (!held.ok || !held.lock)
    return fail(held.message ?? 'Knowledge lock is unavailable.');
  try {
    const freshContext = await loadKnowledgeContext(context.root);
    if (
      !freshContext.ok ||
      !freshContext.context ||
      !sameRootIdentity(freshContext.context, context.rootIdentity)
    )
      return fail(
        'Workspace identity changed before batch registration.',
        freshContext.diagnostics,
      );
    context = freshContext.context;
    const catalogs = await loadKnowledgeCatalogs(context);
    if (!catalogs.ok)
      return fail(
        'Catalog conflicts prevent registration.',
        catalogs.diagnostics,
      );
    const records = new Map(catalogs.records);
    const resolvedRecords: {
      record: DocumentRecord;
      canonical: string | null;
      missing: boolean;
    }[] = [];
    for (const record of records.values()) {
      if (record.lifecycle === 'archived') continue;
      const resolved = await resolveKnowledgeLocation(context, record.location);
      const observation = resolved.ok
        ? await observePath(resolved.value.absolutePath).catch(() => null)
        : null;
      resolvedRecords.push({
        record,
        canonical:
          resolved.ok && observation?.kind === 'file'
            ? resolved.value.canonicalPath
            : null,
        missing:
          (!resolved.ok &&
            resolved.code === diagnosticCodes.document_not_found) ||
          observation?.kind === 'missing',
      });
    }
    const results: RegisterDocumentResult[] = [];
    for (const input of inputs) {
      const diagnostics: Diagnostic[] = [];
      const conflict = (message: string): RegisterDocumentResult => ({
        ok: false,
        status: 'conflict',
        record: null,
        diagnostics: [
          createDiagnostic({
            code: diagnosticCodes.document_location_conflict,
            severity: 'error',
            message,
            source: input.location.path,
          }),
        ],
      });
      const resolved = await resolveKnowledgeLocation(context, input.location);
      if (!resolved.ok) {
        results.push(conflict(resolved.message));
        continue;
      }
      const file = await readKnowledgeFile(
        resolved.value.absolutePath,
        8 * 1024 * 1024,
      );
      if (!file.ok) {
        results.push(conflict(file.message));
        continue;
      }
      const existing = [...records.values()].find(
        (record) =>
          record.lifecycle !== 'archived' &&
          locationKey(record.location) === locationKey(input.location),
      );
      if (existing) {
        results.push(
          existing.digest === file.value.digest &&
            (input.documentId === undefined ||
              input.documentId === existing.documentId)
            ? { ok: true, status: 'existing', record: existing, diagnostics }
            : conflict(
                'An active registration exists with different content; review and update it explicitly.',
              ),
        );
        continue;
      }
      const aliases = resolvedRecords.filter(
        (entry) =>
          entry.canonical !== null &&
          samePath(entry.canonical, resolved.value.canonicalPath),
      );
      const moved = aliases.length === 1 ? aliases[0] : undefined;
      const byDigest = resolvedRecords.filter(
        (entry) => entry.missing && entry.record.digest === file.value.digest,
      );
      const previous =
        moved ?? (byDigest.length === 1 ? byDigest[0] : undefined);
      if (aliases.length > 1 || byDigest.length > 1) {
        results.push(
          conflict(
            'Several registrations could identify this path; use docs relocate with an explicit document id.',
          ),
        );
        continue;
      }
      if (previous) {
        if (
          previous.record.digest !== file.value.digest ||
          (input.documentId !== undefined &&
            input.documentId !== previous.record.documentId)
        ) {
          results.push(
            conflict(
              'The canonical document changed; review it before relocation.',
            ),
          );
          continue;
        }
        const record = {
          ...previous.record,
          location: resolved.value.location,
        };
        records.set(record.documentId, record);
        previous.record = record;
        previous.canonical = resolved.value.canonicalPath;
        previous.missing = false;
        results.push({ ok: true, status: 'existing', record, diagnostics });
        continue;
      }
      const built = await validateAndBuildRecord(
        context,
        input,
        resolved.value,
      );
      if (!built.ok) {
        results.push(conflict(built.message));
        continue;
      }
      const record = { ...built.value, digest: file.value.digest };
      if (records.has(record.documentId)) {
        results.push(
          conflict(
            'Document id is already registered; batch discovery never replaces another document identity.',
          ),
        );
        continue;
      }
      diagnostics.push(
        ...validateSources(
          context,
          catalogs,
          record.documentId,
          record.visibility,
          record.sources,
        ),
      );
      if (diagnostics.some((entry) => entry.severity === 'error')) {
        results.push({
          ok: false,
          status: 'failed',
          record: null,
          diagnostics,
        });
        continue;
      }
      records.set(record.documentId, record);
      resolvedRecords.push({
        record,
        canonical: resolved.value.canonicalPath,
        missing: false,
      });
      results.push({ ok: true, status: 'registered', record, diagnostics });
    }
    const changedScopes = (['shared', 'private'] as const).filter((scope) => {
      const previous = catalogFor(catalogs, scope, context);
      const next = [...records.values()]
        .filter((record) => catalogScopeFor(record) === scope)
        .sort((a, b) =>
          a.documentId < b.documentId
            ? -1
            : a.documentId > b.documentId
              ? 1
              : 0,
        );
      return JSON.stringify(previous.records) !== JSON.stringify(next);
    });
    if (changedScopes.length === 0) return results;
    const timestamp = new Date().toISOString();
    const journal: KnowledgeJournal = {
      schema: 'pappra/knowledge-journal/1',
      operationId: randomUUID(),
      operation: 'write-document',
      stage: 'prepared',
      documentId: null,
      targetPath: null,
      catalogScope: null,
      expectedDigest: null,
      fileDigest: null,
      catalogDigest: catalogs.catalogDigest,
      createdAt: timestamp,
      updatedAt: timestamp,
      residualPaths: [],
      detail: `Batch registration of ${inputs.length} discovered documents. Document content is preserved; rerun scan after interruption to reconcile committed metadata.`,
    };
    const prepared = await writeKnowledgeJournal(context, journal);
    if (!prepared.ok)
      return fail(
        `Cannot prepare batch registration journal: ${prepared.message}`,
      );
    for (const scope of changedScopes) {
      const previous = catalogFor(catalogs, scope, context);
      const next = [...records.values()]
        .filter((record) => catalogScopeFor(record) === scope)
        .sort((a, b) =>
          a.documentId < b.documentId
            ? -1
            : a.documentId > b.documentId
              ? 1
              : 0,
        );
      if (JSON.stringify(previous.records) === JSON.stringify(next)) continue;
      const written = await writeCatalogFile(
        context,
        scope,
        { ...previous, records: next },
        catalogDigestFor(catalogs, scope),
      );
      if (!written.ok) {
        await writeKnowledgeJournal(context, {
          ...journal,
          stage: 'failed',
          updatedAt: new Date().toISOString(),
          residualPaths: [
            catalogs.paths.sharedCatalog,
            catalogs.paths.privateCatalog,
          ],
        });
        return fail(
          `Batch registration was interrupted: ${written.message}. Rerun scan to reconcile already committed records; document files were not changed.`,
        );
      }
    }
    const completed = await writeKnowledgeJournal(context, {
      ...journal,
      stage: 'complete',
      updatedAt: new Date().toISOString(),
    });
    if (!completed.ok)
      return fail(
        `Registrations committed but their completion journal could not be saved: ${completed.message}. Rerun scan before treating coverage as complete.`,
      );
    return results;
  } finally {
    const released = await releaseKnowledgeLock(held.lock, held.path);
    if (!released.ok)
      return fail(
        'Registration may have committed, but its lock could not be released; inspect the catalog before retrying.',
      );
  }
}
