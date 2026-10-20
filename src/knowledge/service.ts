import type { Diagnostic } from '../schemas/diagnostics.js';
import { createDiagnostic } from '../schemas/diagnostics.js';
import { diagnosticCodes } from '../schemas/errors.js';
import type { DocumentRecord } from '../schemas/document.js';
import type { Failure } from '../schemas/outcome.js';
import { loadKnowledgeContext, type KnowledgeContext } from './context.js';
import { loadKnowledgeCatalogs } from './catalog.js';
import { inspectFreshness, findRecord, type FreshnessReport } from './refs.js';
import { resolveKnowledgeLocation, readKnowledgeFile } from './paths.js';
import { applyWrite, proposeWrite, registerDocument } from './write.js';
import {
  archiveDocument,
  deleteExplicit,
  previewDelete,
  shareDocument,
  supersedeDocument,
} from './lifecycle.js';
import type {
  ApplyWriteInput,
  ApplyWriteResult,
  ArchiveDocumentResult,
  DeleteExplicitInput,
  DeleteExplicitResult,
  DocumentCheckEntry,
  DocumentCheckResult,
  ListDocumentsOptions,
  ListDocumentsResult,
  PreviewDeleteInput,
  PreviewDeleteResult,
  ProposeWriteInput,
  ProposeWriteResult,
  ReadDocumentResult,
  RegisterDocumentInput,
  RegisterDocumentResult,
  ShareDocumentResult,
  SupersedeDocumentInput,
  SupersedeDocumentResult,
  KnowledgeServiceOptions,
} from './types.js';

const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

function outcomeDiagnostic(failure: Failure, source: string): Diagnostic {
  return createDiagnostic({
    code: failure.code,
    severity: 'error',
    message: failure.message,
    source,
    hint: failure.nextAction,
  });
}

function contextFailure(
  diagnostics: readonly Diagnostic[],
): KnowledgeContextFailure {
  return { ok: false, diagnostics };
}

interface KnowledgeContextFailure {
  readonly ok: false;
  readonly diagnostics: readonly Diagnostic[];
}

async function getContext(
  root: string,
): Promise<
  | { readonly ok: true; readonly context: KnowledgeContext }
  | KnowledgeContextFailure
> {
  const loaded = await loadKnowledgeContext(root);
  if (!loaded.ok || loaded.context === null) {
    return contextFailure(loaded.diagnostics);
  }
  return { ok: true, context: loaded.context };
}

function supersessionDiagnostics(
  records: readonly DocumentRecord[],
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const byId = new Map(records.map((record) => [record.documentId, record]));
  for (const record of records) {
    if (record.supersededBy === null) continue;
    const seen = new Set<string>([record.documentId]);
    let current: DocumentRecord | null = record;
    while (current !== null && current.supersededBy !== null) {
      if (
        seen.has(current.supersededBy) &&
        current.documentId !== record.documentId
      ) {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.document_supersede_invalid,
            severity: 'error',
            message: `Supersession chain contains a cycle at ${current.supersededBy}.`,
            source: 'knowledge catalog',
            hint: 'Repair the chain manually; Pappra does not rewrite historical decisions.',
          }),
        );
        break;
      }
      seen.add(current.supersededBy);
      const next: DocumentRecord | undefined = byId.get(current.supersededBy);
      if (next === undefined) {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.document_supersede_invalid,
            severity: 'error',
            message: `Supersession target ${current.supersededBy} is missing.`,
            source: 'knowledge catalog',
            hint: 'Keep superseded documents until their replacement is registered.',
          }),
        );
        break;
      }
      if (current.visibility === 'shareable' && next.visibility === 'private') {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.document_visibility_invalid,
            severity: 'error',
            message:
              'A shareable supersession record points to a private document.',
            source: 'knowledge catalog',
            hint: 'Keep shared supersession chains within the shared catalog.',
          }),
        );
      }
      current = next;
    }
  }
  return diagnostics;
}

function filteredDiagnostics(
  context: KnowledgeContext,
  catalogs: Awaited<ReturnType<typeof loadKnowledgeCatalogs>>,
  includePrivate: boolean,
): Diagnostic[] {
  const diagnostics = [...context.diagnostics, ...catalogs.diagnostics];
  if (includePrivate) return diagnostics;
  const privatePrefix = `${context.root}/.pappra/local/knowledge`;
  return diagnostics.filter(
    (entry) =>
      entry.source !== privatePrefix &&
      !entry.source.startsWith(`${privatePrefix}/`),
  );
}

export class KnowledgeService {
  readonly root: string;
  readonly #options: KnowledgeServiceOptions;

  constructor(root: string, options: KnowledgeServiceOptions = {}) {
    this.root = root;
    this.#options = options;
  }

  async register(
    input: RegisterDocumentInput,
  ): Promise<RegisterDocumentResult> {
    const loaded = await getContext(this.root);
    if (!loaded.ok) {
      return {
        ok: false,
        status: 'failed',
        record: null,
        diagnostics: [...loaded.diagnostics],
      };
    }
    return registerDocument(loaded.context, input);
  }

  async read(documentId: string): Promise<ReadDocumentResult> {
    const loaded = await getContext(this.root);
    if (!loaded.ok) {
      return {
        ok: false,
        status: 'failed',
        record: null,
        content: null,
        text: null,
        digest: null,
        freshness: null,
        diagnostics: [...loaded.diagnostics],
      };
    }
    const context = loaded.context;
    const catalogs = await loadKnowledgeCatalogs(context);
    const diagnostics = filteredDiagnostics(context, catalogs, true);
    if (!catalogs.ok) {
      return {
        ok: false,
        status: 'conflict',
        record: null,
        content: null,
        text: null,
        digest: null,
        freshness: null,
        diagnostics,
      };
    }
    const record = findRecord(catalogs, documentId);
    if (record === null) {
      return {
        ok: false,
        status: 'not-found',
        record: null,
        content: null,
        text: null,
        digest: null,
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
        record,
        content: null,
        text: null,
        digest: null,
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
        record,
        content: null,
        text: null,
        digest: null,
        freshness: null,
        diagnostics,
      };
    }
    let text: string | null = null;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(file.value.bytes);
    } catch {
      text = null;
    }
    const freshness = await inspectFreshness(
      context,
      catalogs,
      record,
      MAX_DOCUMENT_BYTES,
    );
    return {
      ok: true,
      status: 'ok',
      record,
      content: file.value.bytes,
      text,
      digest: file.value.digest,
      freshness,
      diagnostics,
    };
  }

  async list(options: ListDocumentsOptions = {}): Promise<ListDocumentsResult> {
    const includePrivate = options.includePrivate === true;
    const includeArchived = options.includeArchived === true;
    const loaded = await getContext(this.root);
    if (!loaded.ok) {
      return {
        ok: false,
        records: [],
        diagnostics: [...loaded.diagnostics],
        catalogDigest: '',
        includePrivate,
        includeArchived,
      };
    }
    const context = loaded.context;
    const catalogs = await loadKnowledgeCatalogs(context);
    const diagnostics = filteredDiagnostics(context, catalogs, includePrivate);
    const records = [...catalogs.records.values()]
      .filter(
        (record) =>
          (includePrivate || record.visibility === 'shareable') &&
          (includeArchived || record.lifecycle === 'active'),
      )
      .sort((left, right) => left.documentId.localeCompare(right.documentId));
    return {
      ok: catalogs.ok,
      records,
      diagnostics,
      catalogDigest: catalogs.catalogDigest,
      includePrivate,
      includeArchived,
    };
  }

  async check(
    options: { readonly includePrivate?: boolean } = {},
  ): Promise<DocumentCheckResult> {
    const includePrivate = options.includePrivate === true;
    const loaded = await getContext(this.root);
    if (!loaded.ok) {
      return {
        ok: false,
        checkedAt: new Date().toISOString(),
        catalogDigest: '',
        entries: [],
        diagnostics: [...loaded.diagnostics],
        summary: { total: 0, current: 0, needsReview: 0, unknown: 0 },
        coverage: {
          catalogs: includePrivate ? 'shared-and-private' : 'shared',
          pathReferences: 'unchecked',
          repositoryContent: 'not-scanned',
          taskExecution: 'unknown',
        },
      };
    }
    const context = loaded.context;
    const catalogs = await loadKnowledgeCatalogs(context);
    const diagnostics = filteredDiagnostics(context, catalogs, includePrivate);
    const selected = [...catalogs.records.values()].filter(
      (record) => includePrivate || record.visibility === 'shareable',
    );
    diagnostics.push(...supersessionDiagnostics(selected));
    const entries: DocumentCheckEntry[] = [];
    const canonicalPaths = new Map<string, string>();
    for (const record of selected) {
      const resolved = await resolveKnowledgeLocation(context, record.location);
      let fileDigest: string | null = null;
      if (resolved.ok) {
        const canonicalKey =
          process.platform === 'win32'
            ? resolved.value.canonicalPath.toLowerCase()
            : resolved.value.canonicalPath;
        const existing = canonicalPaths.get(canonicalKey);
        if (existing !== undefined && existing !== record.documentId) {
          diagnostics.push(
            createDiagnostic({
              code: diagnosticCodes.document_location_conflict,
              severity: 'error',
              message: `Canonical document path is registered by both ${existing} and ${record.documentId}.`,
              source: resolved.value.absolutePath,
              hint: 'Keep one documentId per real file; representation aliases are a location conflict.',
            }),
          );
        } else {
          canonicalPaths.set(canonicalKey, record.documentId);
        }
        const file = await readKnowledgeFile(
          resolved.value.absolutePath,
          MAX_DOCUMENT_BYTES,
        );
        if (file.ok) fileDigest = file.value.digest;
        else
          diagnostics.push(
            outcomeDiagnostic(file, resolved.value.absolutePath),
          );
      } else {
        diagnostics.push(outcomeDiagnostic(resolved, context.configPath));
      }
      const freshness = await inspectFreshness(
        context,
        catalogs,
        record,
        MAX_DOCUMENT_BYTES,
      );
      entries.push({
        documentId: record.documentId,
        scope: record.visibility === 'shareable' ? 'shared' : 'private',
        lifecycle: record.lifecycle,
        maturity: record.maturity,
        fileDigest,
        recordDigest: record.digest,
        freshness: freshness.freshness,
        reasons: freshness.reasons,
        sourceChecks: freshness.sourceChecks,
      });
    }
    const current = entries.filter(
      (entry) => entry.freshness === 'current',
    ).length;
    const needsReview = entries.filter(
      (entry) => entry.freshness === 'needs-review',
    ).length;
    const unknown = entries.filter(
      (entry) => entry.freshness === 'unknown',
    ).length;
    const ok =
      diagnostics.every((entry) => entry.severity !== 'error') &&
      current === entries.length;
    return {
      ok,
      checkedAt: new Date().toISOString(),
      catalogDigest: catalogs.catalogDigest,
      entries,
      diagnostics,
      summary: {
        total: entries.length,
        current,
        needsReview,
        unknown,
      },
      coverage: {
        catalogs: includePrivate ? 'shared-and-private' : 'shared',
        pathReferences: 'unchecked',
        repositoryContent: 'not-scanned',
        taskExecution: 'unknown',
      },
    };
  }

  async proposeWrite(input: ProposeWriteInput): Promise<ProposeWriteResult> {
    const loaded = await getContext(this.root);
    if (!loaded.ok) {
      return {
        ok: false,
        status: 'failed',
        proposal: null,
        content: null,
        diagnostics: [...loaded.diagnostics],
      };
    }
    return proposeWrite(loaded.context, input);
  }

  async applyWrite(input: ApplyWriteInput): Promise<ApplyWriteResult> {
    return applyWrite(input, this.root, this.#options);
  }

  async archive(documentId: string): Promise<ArchiveDocumentResult> {
    const loaded = await getContext(this.root);
    if (!loaded.ok) {
      return {
        ok: false,
        status: 'failed',
        record: null,
        diagnostics: [...loaded.diagnostics],
      };
    }
    return archiveDocument(loaded.context, documentId);
  }

  async supersede(
    input: SupersedeDocumentInput,
  ): Promise<SupersedeDocumentResult> {
    const loaded = await getContext(this.root);
    if (!loaded.ok) {
      return {
        ok: false,
        status: 'failed',
        record: null,
        diagnostics: [...loaded.diagnostics],
      };
    }
    return supersedeDocument(loaded.context, input);
  }

  async share(documentId: string): Promise<ShareDocumentResult> {
    const loaded = await getContext(this.root);
    if (!loaded.ok) {
      return {
        ok: false,
        status: 'failed',
        record: null,
        diagnostics: [...loaded.diagnostics],
        residualPaths: [],
      };
    }
    return shareDocument(loaded.context, documentId);
  }

  async previewDelete(input: PreviewDeleteInput): Promise<PreviewDeleteResult> {
    const loaded = await getContext(this.root);
    if (!loaded.ok) {
      return {
        ok: false,
        status: 'failed',
        plan: null,
        diagnostics: [...loaded.diagnostics],
      };
    }
    return previewDelete(loaded.context, input);
  }

  async deleteExplicit(
    input: DeleteExplicitInput,
  ): Promise<DeleteExplicitResult> {
    const loaded = await getContext(this.root);
    if (!loaded.ok) {
      return {
        ok: false,
        status: 'failed',
        documentId: null,
        diagnostics: [...loaded.diagnostics],
        residualPaths: [],
        journalPath: null,
      };
    }
    return deleteExplicit(loaded.context, input.plan);
  }
}

export type {
  ApplyWriteResult,
  ArchiveDocumentResult,
  DeleteExplicitResult,
  DocumentCheckResult,
  ListDocumentsResult,
  PreviewDeleteResult,
  ProposeWriteResult,
  ReadDocumentResult,
  RegisterDocumentResult,
  ShareDocumentResult,
  SupersedeDocumentResult,
  FreshnessReport,
};
