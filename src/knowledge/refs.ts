import type { Diagnostic } from '../schemas/diagnostics.js';
import { createDiagnostic } from '../schemas/diagnostics.js';
import { diagnosticCodes } from '../schemas/errors.js';
import type {
  DocumentRecord,
  DocumentSource,
  DocumentVisibility,
} from '../schemas/document.js';
import {
  isPathInside,
  resolvePortableRelativePath,
  samePath,
} from '../schemas/paths.js';
import { observePath } from '../infra/fs.js';
import type { KnowledgeContext } from './context.js';
import type { KnowledgeCatalogs } from './catalog.js';
import {
  readKnowledgeFile,
  resolveKnowledgeLocation,
  type ResolvedKnowledgeLocation,
} from './paths.js';

export type Freshness = 'current' | 'needs-review' | 'unknown';

export interface FreshnessReason {
  readonly code: string;
  readonly message: string;
}

export interface SourceCheck {
  readonly kind: DocumentSource['kind'];
  readonly ref: string;
  readonly status: 'current' | 'needs-review' | 'unknown';
  readonly message: string;
}

export interface FreshnessReport {
  readonly freshness: Freshness;
  readonly reasons: readonly FreshnessReason[];
  readonly sourceChecks: readonly SourceCheck[];
  readonly coverage: {
    readonly sources: 'checked';
    readonly pathReferences: 'unchecked';
    readonly repositoryContent: 'not-scanned';
  };
}

export function findRecord(
  catalogs: KnowledgeCatalogs,
  documentId: string,
): DocumentRecord | null {
  if (catalogs.idConflicts.has(documentId)) return null;
  return catalogs.records.get(documentId) ?? null;
}

export async function findCanonicalAlias(
  context: KnowledgeContext,
  catalogs: KnowledgeCatalogs,
  target: ResolvedKnowledgeLocation,
  ignoreDocumentId: string | null = null,
): Promise<DocumentRecord | null> {
  for (const record of catalogs.records.values()) {
    if (record.lifecycle === 'archived') continue;
    if (record.documentId === ignoreDocumentId) continue;
    const resolved = await resolveKnowledgeLocation(context, record.location);
    if (
      resolved.ok &&
      samePath(resolved.value.canonicalPath, target.canonicalPath)
    ) {
      return record;
    }
  }
  return null;
}

export function findRecordByLocation(
  catalogs: KnowledgeCatalogs,
  key: string,
): DocumentRecord | null {
  if (catalogs.locationConflicts.has(key)) return null;
  for (const record of catalogs.records.values()) {
    if (record.lifecycle === 'archived') continue;
    const recordKey =
      record.location.kind === 'workspace'
        ? `workspace:${record.location.path}`
        : `source:${record.location.sourceId}:${record.location.path}`;
    if (recordKey === key) return record;
  }
  return null;
}

function sourceRef(source: DocumentSource): string {
  return source.kind === 'document'
    ? `document:${source.documentId}`
    : `code:${source.repositoryId}:${source.path}@${source.version}`;
}

async function checkDocumentSource(
  context: KnowledgeContext,
  catalogs: KnowledgeCatalogs,
  source: Extract<DocumentSource, { kind: 'document' }>,
  maxBytes: number,
): Promise<SourceCheck> {
  const target = findRecord(catalogs, source.documentId);
  if (target === null) {
    return {
      kind: 'document',
      ref: sourceRef(source),
      status: 'needs-review',
      message: `Referenced document ${source.documentId} is missing or ambiguous.`,
    };
  }
  const resolved = await resolveKnowledgeLocation(context, target.location);
  if (!resolved.ok) {
    return {
      kind: 'document',
      ref: sourceRef(source),
      status: 'needs-review',
      message: `Referenced document cannot be read: ${resolved.message}`,
    };
  }
  const file = await readKnowledgeFile(resolved.value.absolutePath, maxBytes);
  if (!file.ok) {
    return {
      kind: 'document',
      ref: sourceRef(source),
      status: 'needs-review',
      message: `Referenced document cannot be read: ${file.message}`,
    };
  }
  return file.value.digest === source.digest
    ? {
        kind: 'document',
        ref: sourceRef(source),
        status: 'current',
        message: 'Referenced document digest matches.',
      }
    : {
        kind: 'document',
        ref: sourceRef(source),
        status: 'needs-review',
        message:
          'Referenced document digest changed since this source was recorded.',
      };
}

async function checkCodeSource(
  context: KnowledgeContext,
  source: Extract<DocumentSource, { kind: 'code' }>,
): Promise<SourceCheck> {
  const repository = context.repositories.find(
    (entry) => entry.id === source.repositoryId,
  );
  if (repository === undefined) {
    return {
      kind: 'code',
      ref: sourceRef(source),
      status: 'needs-review',
      message: `Repository ${source.repositoryId} is not available.`,
    };
  }
  const path = resolvePortableRelativePath(repository.root, source.path);
  if (!isPathInside(repository.root, path)) {
    return {
      kind: 'code',
      ref: sourceRef(source),
      status: 'needs-review',
      message: `Code source path escapes repository ${source.repositoryId}.`,
    };
  }
  const observation = await observePath(path);
  if (observation.kind !== 'file') {
    return {
      kind: 'code',
      ref: sourceRef(source),
      status: 'needs-review',
      message: `Code source is not a regular file: ${source.path}`,
    };
  }
  if (repository.git.head === null) {
    return {
      kind: 'code',
      ref: sourceRef(source),
      status: 'unknown',
      message: `Repository ${source.repositoryId} has no observable HEAD.`,
    };
  }
  return repository.git.head === source.version
    ? {
        kind: 'code',
        ref: sourceRef(source),
        status: 'current',
        message: 'Repository HEAD matches the recorded code version.',
      }
    : {
        kind: 'code',
        ref: sourceRef(source),
        status: 'needs-review',
        message: `Repository HEAD ${repository.git.head} differs from recorded version ${source.version}.`,
      };
}

export async function inspectFreshness(
  context: KnowledgeContext,
  catalogs: KnowledgeCatalogs,
  record: DocumentRecord,
  maxBytes: number,
): Promise<FreshnessReport> {
  const reasons: FreshnessReason[] = [];
  const resolved = await resolveKnowledgeLocation(context, record.location);
  let fileCheck: 'current' | 'needs-review' | 'unknown' = 'unknown';
  if (!resolved.ok) {
    reasons.push({ code: resolved.code, message: resolved.message });
  } else {
    const file = await readKnowledgeFile(resolved.value.absolutePath, maxBytes);
    if (!file.ok) {
      reasons.push({ code: file.code, message: file.message });
    } else if (file.value.digest !== record.digest) {
      fileCheck = 'needs-review';
      reasons.push({
        code: diagnosticCodes.document_file_changed,
        message: 'Document bytes differ from the registered digest.',
      });
    } else {
      fileCheck = 'current';
    }
  }
  const sourceChecks: SourceCheck[] = [];
  for (const source of record.sources) {
    const check =
      source.kind === 'document'
        ? await checkDocumentSource(context, catalogs, source, maxBytes)
        : await checkCodeSource(context, source);
    sourceChecks.push(check);
    if (check.status === 'needs-review') {
      reasons.push({
        code: diagnosticCodes.document_source_invalid,
        message: check.message,
      });
    }
  }
  const hasUnknown = sourceChecks.some((entry) => entry.status === 'unknown');
  const freshness: Freshness =
    reasons.length > 0 || fileCheck === 'needs-review'
      ? 'needs-review'
      : hasUnknown
        ? 'unknown'
        : 'current';
  return {
    freshness,
    reasons,
    sourceChecks,
    coverage: {
      sources: 'checked',
      pathReferences: 'unchecked',
      repositoryContent: 'not-scanned',
    },
  };
}

export interface RegisteredReference {
  readonly documentId: string;
  readonly relation: 'source' | 'superseded-by';
}

export function findRegisteredReferences(
  catalogs: KnowledgeCatalogs,
  targetDocumentId: string,
): readonly RegisteredReference[] {
  const references: RegisteredReference[] = [];
  for (const record of catalogs.records.values()) {
    if (record.documentId === targetDocumentId) continue;
    for (const source of record.sources) {
      if (
        source.kind === 'document' &&
        source.documentId === targetDocumentId
      ) {
        references.push({
          documentId: record.documentId,
          relation: 'source',
        });
      }
    }
    if (record.supersededBy === targetDocumentId) {
      references.push({
        documentId: record.documentId,
        relation: 'superseded-by',
      });
    }
  }
  return references;
}

export function validateSources(
  context: KnowledgeContext,
  catalogs: KnowledgeCatalogs,
  documentId: string,
  visibility: DocumentVisibility,
  sources: readonly DocumentSource[],
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const source of sources) {
    if (source.kind === 'document') {
      if (source.documentId === documentId) {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.document_source_invalid,
            severity: 'error',
            message: `Document ${documentId} cannot cite itself as a source.`,
            source: context.configPath,
            hint: 'Use an existing other document or a code version as the source.',
          }),
        );
      } else {
        const target = findRecord(catalogs, source.documentId);
        if (target === null) {
          diagnostics.push(
            createDiagnostic({
              code: diagnosticCodes.document_source_invalid,
              severity: 'error',
              message: `Document source ${source.documentId} does not exist in the catalog.`,
              source: context.configPath,
              hint: 'Register the source document first; Pappra does not invent source history.',
            }),
          );
        } else if (
          visibility === 'shareable' &&
          target.visibility === 'private'
        ) {
          diagnostics.push(
            createDiagnostic({
              code: diagnosticCodes.document_visibility_invalid,
              severity: 'error',
              message: `A shareable document cannot cite private source ${source.documentId}.`,
              source: context.configPath,
              hint: 'Keep private references out of the shared catalog or share the source explicitly.',
            }),
          );
        }
      }
    } else {
      const repository = context.repositories.find(
        (entry) => entry.id === source.repositoryId,
      );
      if (repository === undefined) {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.document_source_invalid,
            severity: 'error',
            message: `Code source repository ${source.repositoryId} is not declared or mapped.`,
            source: context.configPath,
            hint: 'Declare the repository and map external checkouts before citing code.',
          }),
        );
      } else if (
        !isPathInside(
          repository.root,
          resolvePortableRelativePath(repository.root, source.path),
        )
      ) {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.document_source_invalid,
            severity: 'error',
            message: `Code source path escapes repository ${source.repositoryId}: ${source.path}`,
            source: context.configPath,
            hint: 'Use a relative path inside the repository checkout.',
          }),
        );
      }
    }
  }
  return diagnostics;
}
