import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Diagnostic } from '../schemas/diagnostics.js';
import { createDiagnostic } from '../schemas/diagnostics.js';
import { diagnosticCodes, type DiagnosticCode } from '../schemas/errors.js';
import {
  documentRecordSchema,
  documentWriteProposalSchema,
  type DocumentRecord,
  type DocumentWriteProposal,
  type KnowledgeJournal,
} from '../schemas/document.js';
import { normalizePortableRelativePath } from '../schemas/paths.js';
import {
  failed,
  succeeded,
  type Failure,
  type Outcome,
} from '../schemas/outcome.js';
import { observePath, readFileBounded, sha256Digest } from '../infra/fs.js';
import type { KnowledgeContext } from './context.js';
import { loadKnowledgeContext, sameRootIdentity } from './context.js';
import {
  catalogDigestFor,
  catalogScopeFor,
  loadKnowledgeCatalogs,
  locationKey,
  setCatalogRecord,
  writeCatalogFile,
} from './catalog.js';
import {
  acquireKnowledgeLock,
  knowledgeJournalPath,
  releaseKnowledgeLock,
  writeKnowledgeJournal,
} from './journal.js';
import {
  readKnowledgeFile,
  resolveKnowledgeLocation,
  type ResolvedKnowledgeLocation,
} from './paths.js';
import {
  findCanonicalAlias,
  findRecord,
  findRecordByLocation,
  validateSources,
} from './refs.js';
import type {
  ApplyWriteInput,
  ApplyWriteResult,
  KnowledgeServiceOptions,
  ProposeWriteInput,
  ProposeWriteResult,
  RegisterDocumentInput,
  RegisterDocumentResult,
} from './types.js';

const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

function diagnostic(
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

function contentBuffer(content: Uint8Array | string): Buffer {
  return typeof content === 'string'
    ? Buffer.from(content, 'utf8')
    : Buffer.from(content);
}

export function defaultVisibility(
  context: KnowledgeContext,
): 'private' | 'shareable' {
  return context.config.knowledge.taskVisibility === 'shared'
    ? 'shareable'
    : 'private';
}

function isWithinNewDocuments(
  context: KnowledgeContext,
  path: string,
): boolean {
  const configured = normalizePortableRelativePath(
    context.config.knowledge.newDocuments,
  );
  if (configured === '.') return true;
  return path === configured || path.startsWith(`${configured}/`);
}

function diffPreview(oldText: string | null, nextText: string): string {
  const nextLines = nextText.split('\n');
  if (oldText === null) {
    return nextLines.map((line) => `+${line}`).join('\n');
  }
  const oldLines = oldText.split('\n');
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < nextLines.length &&
    oldLines[prefix] === nextLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < nextLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] ===
      nextLines[nextLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = nextLines.slice(prefix, nextLines.length - suffix);
  if (removed.length === 0 && added.length === 0) return '';
  return [
    `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join('\n');
}

function decodeText(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function sameRecordForUpdate(
  existing: DocumentRecord,
  proposed: DocumentRecord,
): boolean {
  return (
    existing.documentId === proposed.documentId &&
    JSON.stringify(existing.location) === JSON.stringify(proposed.location) &&
    existing.kind === proposed.kind &&
    existing.lifecycle === proposed.lifecycle &&
    existing.maturity === proposed.maturity &&
    existing.taskId === proposed.taskId &&
    existing.owner === proposed.owner &&
    JSON.stringify(existing.sources) === JSON.stringify(proposed.sources) &&
    existing.supersededBy === proposed.supersededBy &&
    existing.lastReviewedAt === proposed.lastReviewedAt &&
    existing.visibility === proposed.visibility
  );
}

function recordDiagnostics(
  record: DocumentRecord,
  source: string,
): readonly Diagnostic[] {
  const parsed = documentRecordSchema.safeParse(record);
  return parsed.success
    ? []
    : [
        diagnostic(
          diagnosticCodes.document_record_invalid,
          `Document record is invalid: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`,
          source,
          'Fix the record metadata; no catalog bytes were written.',
        ),
      ];
}

async function validateAndBuildRecord(
  context: KnowledgeContext,
  input: RegisterDocumentInput,
  location: ResolvedKnowledgeLocation,
): Promise<Outcome<DocumentRecord>> {
  const documentId = input.documentId ?? randomUUID();
  const visibility = input.visibility ?? defaultVisibility(context);
  const sources = input.sources ?? [];
  const record: DocumentRecord = {
    schema: 'pappra/document/1',
    documentId,
    location: location.location,
    kind: input.kind,
    lifecycle: 'active',
    maturity: input.maturity,
    taskId: input.taskId ?? null,
    owner: input.owner,
    digest: 'sha256:' + '0'.repeat(64),
    sources: [...sources],
    supersededBy: null,
    lastReviewedAt: input.lastReviewedAt ?? null,
    visibility,
  };
  return documentRecordSchema.safeParse(record).success
    ? succeeded(record)
    : failed(
        diagnosticCodes.document_record_invalid,
        'Document record could not be constructed.',
        { nextAction: 'Check the supplied document metadata.' },
      );
}

export async function registerDocument(
  context: KnowledgeContext,
  input: RegisterDocumentInput,
): Promise<RegisterDocumentResult> {
  const diagnostics: Diagnostic[] = [];
  const catalogs = await loadKnowledgeCatalogs(context);
  diagnostics.push(...catalogs.diagnostics);
  if (!catalogs.ok) {
    return { ok: false, status: 'conflict', record: null, diagnostics };
  }
  const resolved = await resolveKnowledgeLocation(context, input.location);
  if (!resolved.ok) {
    return {
      ok: false,
      status: 'failed',
      record: null,
      diagnostics: [outcomeDiagnostic(resolved, context.configPath)],
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
      record: null,
      diagnostics: [outcomeDiagnostic(file, context.configPath)],
    };
  }
  const existingByLocation = findRecordByLocation(
    catalogs,
    locationKey(input.location),
  );
  const existingById =
    input.documentId === undefined
      ? null
      : findRecord(catalogs, input.documentId);
  const existingForAlias = existingByLocation ?? existingById;
  const aliasIgnore =
    existingForAlias !== null &&
    existingForAlias.location.kind === input.location.kind &&
    existingForAlias.location.path === input.location.path
      ? existingForAlias.documentId
      : null;
  const canonicalAlias = await findCanonicalAlias(
    context,
    catalogs,
    resolved.value,
    aliasIgnore,
  );
  if (canonicalAlias !== null) {
    diagnostics.push(
      diagnostic(
        diagnosticCodes.document_location_conflict,
        `Canonical document path is already registered by ${canonicalAlias.documentId}.`,
        resolved.value.absolutePath,
        'Use the existing record or a different real file; location representation does not create a second document.',
      ),
    );
    return { ok: false, status: 'conflict', record: null, diagnostics };
  }
  if (existingByLocation !== null || existingById !== null) {
    const existing = existingByLocation ?? existingById;
    if (
      existing !== null &&
      (input.documentId === undefined ||
        input.documentId === existing.documentId) &&
      existing.digest === file.value.digest &&
      existing.location.kind === input.location.kind &&
      existing.location.path === input.location.path
    ) {
      return {
        ok: true,
        status: 'existing',
        record: existing,
        diagnostics,
      };
    }
    diagnostics.push(
      diagnostic(
        diagnosticCodes.document_already_registered,
        'Document location or id is already registered with different content.',
        resolved.value.absolutePath,
        'Read the existing record and use proposeWrite; registration never overwrites a catalog entry.',
      ),
    );
    return { ok: false, status: 'conflict', record: null, diagnostics };
  }
  const built = await validateAndBuildRecord(context, input, resolved.value);
  if (!built.ok) {
    diagnostics.push(outcomeDiagnostic(built, resolved.value.absolutePath));
    return { ok: false, status: 'failed', record: null, diagnostics };
  }
  const record: DocumentRecord = { ...built.value, digest: file.value.digest };
  const invalid = recordDiagnostics(record, context.configPath);
  diagnostics.push(...invalid);
  if (invalid.length > 0) {
    return { ok: false, status: 'failed', record: null, diagnostics };
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
    return { ok: false, status: 'failed', record: null, diagnostics };
  }
  const lock = await acquireKnowledgeLock(context, 'write-document');
  if (!lock.ok || lock.lock === null) {
    return {
      ok: false,
      status: 'failed',
      record: null,
      diagnostics: [
        diagnostic(
          lock.status === 'locked'
            ? diagnosticCodes.document_locked
            : diagnosticCodes.document_write_conflict,
          lock.message ?? 'Knowledge catalog is locked.',
          lock.path,
          'Retry after the current knowledge operation finishes.',
        ),
      ],
    };
  }
  const heldLock = lock.lock;
  const registerResult = await (async (): Promise<RegisterDocumentResult> => {
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
        diagnostics: [...reloaded.diagnostics, ...fresh.diagnostics],
      };
    }
    if (
      findRecordByLocation(fresh, locationKey(record.location)) !== null ||
      findRecord(fresh, record.documentId) !== null
    ) {
      return {
        ok: false,
        status: 'conflict',
        record: null,
        diagnostics: [
          ...reloaded.diagnostics,
          diagnostic(
            diagnosticCodes.document_already_registered,
            'Document registration changed while the lock was acquired.',
            resolved.value.absolutePath,
            'Read the catalog again before retrying.',
          ),
        ],
      };
    }
    const freshAlias = await findCanonicalAlias(
      reloaded.context,
      fresh,
      resolved.value,
    );
    if (freshAlias !== null) {
      return {
        ok: false,
        status: 'conflict',
        record: null,
        diagnostics: [
          ...reloaded.diagnostics,
          diagnostic(
            diagnosticCodes.document_location_conflict,
            `Canonical document path is already registered by ${freshAlias.documentId}.`,
            resolved.value.absolutePath,
            'Use the existing record or a different real file.',
          ),
        ],
      };
    }
    const currentFile = await readKnowledgeFile(
      resolved.value.absolutePath,
      MAX_DOCUMENT_BYTES,
    );
    if (!currentFile.ok || currentFile.value.digest !== record.digest) {
      return {
        ok: false,
        status: 'conflict',
        record: null,
        diagnostics: [
          ...reloaded.diagnostics,
          diagnostic(
            diagnosticCodes.document_write_conflict,
            'Document content changed before registration could be committed.',
            resolved.value.absolutePath,
            'Register the current bytes explicitly after reviewing the change.',
          ),
        ],
      };
    }
    const catalogRecord = setCatalogRecord(reloaded.context, fresh, record);
    const written = await writeCatalogFile(
      reloaded.context,
      catalogRecord.scope,
      catalogRecord.catalog,
      catalogDigestFor(fresh, catalogRecord.scope),
    );
    if (!written.ok) {
      return {
        ok: false,
        status: 'failed',
        record: null,
        diagnostics: [
          ...reloaded.diagnostics,
          outcomeDiagnostic(written, reloaded.context.configPath),
        ],
      };
    }
    return {
      ok: true,
      status: 'registered',
      record,
      diagnostics: [...reloaded.diagnostics],
    };
  })();
  const release = await releaseKnowledgeLock(heldLock, lock.path);
  if (!release.ok) {
    return {
      ...registerResult,
      ok: false,
      status: 'failed',
      diagnostics: [
        ...registerResult.diagnostics,
        outcomeDiagnostic(release, lock.path),
      ],
    };
  }
  return registerResult;
}

export async function proposeWrite(
  context: KnowledgeContext,
  input: ProposeWriteInput,
): Promise<ProposeWriteResult> {
  const catalogs = await loadKnowledgeCatalogs(context);
  if (!catalogs.ok) {
    return {
      ok: false,
      status: 'conflict',
      proposal: null,
      content: null,
      diagnostics: [...catalogs.diagnostics],
    };
  }
  const content = contentBuffer(input.content);
  if (content.length > MAX_DOCUMENT_BYTES) {
    return {
      ok: false,
      status: 'failed',
      proposal: null,
      content: null,
      diagnostics: [
        diagnostic(
          diagnosticCodes.fileTooLarge,
          `Document content exceeds ${MAX_DOCUMENT_BYTES} bytes.`,
          context.configPath,
          'Reduce the document size; Pappra does not truncate knowledge.',
        ),
      ],
    };
  }
  const nextDigest = sha256Digest(content);
  if (input.mode === 'update') {
    if (input.expectedDigest === null || input.expectedDigest.length === 0) {
      return {
        ok: false,
        status: 'conflict',
        proposal: null,
        content: null,
        diagnostics: [
          diagnostic(
            diagnosticCodes.document_write_conflict,
            'Updating a document requires the current expectedDigest.',
            context.configPath,
            'Read the document and pass its actual digest.',
          ),
        ],
      };
    }
    const existing = findRecord(catalogs, input.documentId);
    if (existing === null) {
      return {
        ok: false,
        status: 'conflict',
        proposal: null,
        content: null,
        diagnostics: [
          diagnostic(
            diagnosticCodes.document_not_found,
            `Document is not registered or is ambiguous: ${input.documentId}`,
            context.configPath,
            'Register the document before proposing an update.',
          ),
        ],
      };
    }
    const resolved = await resolveKnowledgeLocation(
      context,
      existing.location,
      { forWrite: true },
    );
    if (!resolved.ok) {
      return {
        ok: false,
        status: 'conflict',
        proposal: null,
        content: null,
        diagnostics: [outcomeDiagnostic(resolved, context.configPath)],
      };
    }
    const alias = await findCanonicalAlias(
      context,
      catalogs,
      resolved.value,
      existing.documentId,
    );
    if (alias !== null) {
      return {
        ok: false,
        status: 'conflict',
        proposal: null,
        content: null,
        diagnostics: [
          diagnostic(
            diagnosticCodes.document_location_conflict,
            `Canonical document path is already registered by ${alias.documentId}.`,
            resolved.value.absolutePath,
            'Resolve the canonical location conflict before updating.',
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
        status: 'conflict',
        proposal: null,
        content: null,
        diagnostics: [outcomeDiagnostic(file, context.configPath)],
      };
    }
    if (file.value.digest !== input.expectedDigest) {
      return {
        ok: false,
        status: 'conflict',
        proposal: null,
        content: null,
        diagnostics: [
          diagnostic(
            diagnosticCodes.document_write_conflict,
            'The document bytes do not match expectedDigest.',
            resolved.value.absolutePath,
            'Read the document again; the proposal was not written.',
          ),
        ],
      };
    }
    if (
      existing.owner === 'generator' &&
      existing.digest !== file.value.digest
    ) {
      return {
        ok: false,
        status: 'conflict',
        proposal: null,
        content: null,
        diagnostics: [
          diagnostic(
            diagnosticCodes.document_generated_modified,
            'A generated document was modified by a human; automatic overwrite is blocked.',
            resolved.value.absolutePath,
            'Review the change and use an explicit human-owned document flow.',
          ),
        ],
      };
    }
    const record: DocumentRecord = {
      ...existing,
      digest: nextDigest,
    };
    const invalid = recordDiagnostics(record, context.configPath);
    if (invalid.length > 0) {
      return {
        ok: false,
        status: 'failed',
        proposal: null,
        content: null,
        diagnostics: invalid,
      };
    }
    const oldText = decodeText(file.value.bytes);
    const nextText = decodeText(content);
    const diff =
      oldText === null || nextText === null
        ? '[binary document content changed]'
        : diffPreview(oldText, nextText);
    const proposal: DocumentWriteProposal = {
      schema: 'pappra/document-write-proposal/1',
      proposalId: randomUUID(),
      createdAt: new Date().toISOString(),
      mode: 'update',
      documentId: record.documentId,
      location: record.location,
      expectedDigest: input.expectedDigest,
      nextDigest,
      catalogDigest: catalogs.catalogDigest,
      rootIdentity: context.rootIdentity,
      record,
      diff,
    };
    const parsed = documentWriteProposalSchema.safeParse(proposal);
    if (!parsed.success) {
      return {
        ok: false,
        status: 'failed',
        proposal: null,
        content: null,
        diagnostics: [
          diagnostic(
            diagnosticCodes.document_record_invalid,
            `Write proposal is invalid: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`,
            context.configPath,
            'Fix the proposal inputs.',
          ),
        ],
      };
    }
    return {
      ok: true,
      status: 'proposed',
      proposal: parsed.data,
      content,
      diagnostics: [...catalogs.diagnostics],
    };
  }

  if (input.expectedDigest !== null) {
    return {
      ok: false,
      status: 'conflict',
      proposal: null,
      content: null,
      diagnostics: [
        diagnostic(
          diagnosticCodes.document_write_conflict,
          'A new document must use expectedDigest=null.',
          context.configPath,
          'Do not supply a digest for a file that does not exist yet.',
        ),
      ],
    };
  }
  if (input.location.kind !== 'workspace') {
    return {
      ok: false,
      status: 'conflict',
      proposal: null,
      content: null,
      diagnostics: [
        diagnostic(
          diagnosticCodes.document_access_denied,
          'New documents must be created under the workspace newDocuments directory.',
          context.configPath,
          'Use a workspace location; external repositories are read/update-only by explicit mapping.',
        ),
      ],
    };
  }
  const normalized = normalizePortableRelativePath(input.location.path);
  if (!isWithinNewDocuments(context, normalized)) {
    return {
      ok: false,
      status: 'conflict',
      proposal: null,
      content: null,
      diagnostics: [
        diagnostic(
          diagnosticCodes.document_path_unsafe,
          `New document target is outside ${context.config.knowledge.newDocuments}: ${normalized}`,
          context.configPath,
          'Use the configured newDocuments directory; do not scatter files across the workspace.',
        ),
      ],
    };
  }
  const resolved = await resolveKnowledgeLocation(context, input.location, {
    forWrite: true,
    forCreate: true,
  });
  if (!resolved.ok) {
    return {
      ok: false,
      status: 'conflict',
      proposal: null,
      content: null,
      diagnostics: [outcomeDiagnostic(resolved, context.configPath)],
    };
  }
  const canonicalAlias = await findCanonicalAlias(
    context,
    catalogs,
    resolved.value,
  );
  if (canonicalAlias !== null) {
    return {
      ok: false,
      status: 'conflict',
      proposal: null,
      content: null,
      diagnostics: [
        diagnostic(
          diagnosticCodes.document_location_conflict,
          `Canonical document path is already registered by ${canonicalAlias.documentId}.`,
          resolved.value.absolutePath,
          'Use the existing record or a different real file.',
        ),
      ],
    };
  }
  const existingLocation = findRecordByLocation(
    catalogs,
    locationKey(input.location),
  );
  if (existingLocation !== null) {
    return {
      ok: false,
      status: 'conflict',
      proposal: null,
      content: null,
      diagnostics: [
        diagnostic(
          diagnosticCodes.document_location_conflict,
          `Document location is already registered: ${normalized}`,
          context.configPath,
          'Use proposeWrite with the existing document id instead of creating it again.',
        ),
      ],
    };
  }
  const documentId = input.documentId ?? randomUUID();
  if (findRecord(catalogs, documentId) !== null) {
    return {
      ok: false,
      status: 'conflict',
      proposal: null,
      content: null,
      diagnostics: [
        diagnostic(
          diagnosticCodes.document_duplicate_id,
          `Document id is already registered: ${documentId}`,
          context.configPath,
          'Use a new stable id for a new document.',
        ),
      ],
    };
  }
  const visibility = input.visibility ?? defaultVisibility(context);
  const record: DocumentRecord = {
    schema: 'pappra/document/1',
    documentId,
    location: input.location,
    kind: input.kind,
    lifecycle: 'active',
    maturity: input.maturity,
    taskId: input.taskId ?? null,
    owner: input.owner,
    digest: nextDigest,
    sources: [...(input.sources ?? [])],
    supersededBy: null,
    lastReviewedAt: input.lastReviewedAt ?? null,
    visibility,
  };
  const invalid = recordDiagnostics(record, context.configPath);
  const sourceDiagnostics = validateSources(
    context,
    catalogs,
    record.documentId,
    record.visibility,
    record.sources,
  );
  if (invalid.length > 0 || sourceDiagnostics.length > 0) {
    return {
      ok: false,
      status: 'failed',
      proposal: null,
      content: null,
      diagnostics: [...invalid, ...sourceDiagnostics],
    };
  }
  if (input.documentId !== undefined && input.documentId !== documentId) {
    return {
      ok: false,
      status: 'failed',
      proposal: null,
      content: null,
      diagnostics: [
        diagnostic(
          diagnosticCodes.document_record_invalid,
          'Document id does not match the proposal record.',
          context.configPath,
          'Check the supplied document id.',
        ),
      ],
    };
  }
  const proposal: DocumentWriteProposal = {
    schema: 'pappra/document-write-proposal/1',
    proposalId: randomUUID(),
    createdAt: new Date().toISOString(),
    mode: 'create',
    documentId: record.documentId,
    location: record.location,
    expectedDigest: null,
    nextDigest,
    catalogDigest: catalogs.catalogDigest,
    rootIdentity: context.rootIdentity,
    record,
    diff: diffPreview(null, decodeText(content) ?? '[binary document content]'),
  };
  const parsed = documentWriteProposalSchema.safeParse(proposal);
  if (!parsed.success) {
    return {
      ok: false,
      status: 'failed',
      proposal: null,
      content: null,
      diagnostics: [
        diagnostic(
          diagnosticCodes.document_record_invalid,
          `Write proposal is invalid: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`,
          context.configPath,
          'Fix the proposal inputs.',
        ),
      ],
    };
  }
  return {
    ok: true,
    status: 'proposed',
    proposal: parsed.data,
    content,
    diagnostics: [...catalogs.diagnostics],
  };
}

type FileMutationResult =
  | { readonly ok: true; readonly digest: string }
  | {
      readonly ok: false;
      readonly status: 'conflict' | 'failed' | 'partial';
      readonly code: DiagnosticCode;
      readonly message: string;
      readonly residualPaths: readonly string[];
    };

async function removeCreatedIfUnchanged(
  path: string,
  identity: { readonly dev: number; readonly ino: number },
  expectedBytes: Buffer,
): Promise<boolean> {
  const observation = await observePath(path).catch(() => null);
  if (
    observation === null ||
    observation.stats === null ||
    observation.stats.dev !== identity.dev ||
    observation.stats.ino !== identity.ino
  ) {
    return false;
  }
  const current = await readFileBounded(
    path,
    Math.max(1, expectedBytes.length),
  );
  if (
    !current.ok ||
    current.value.bytes.length > expectedBytes.length ||
    !current.value.bytes.equals(
      expectedBytes.subarray(0, current.value.bytes.length),
    )
  ) {
    return false;
  }
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

async function writeFileExclusive(
  path: string,
  bytes: Buffer,
  options: KnowledgeServiceOptions,
): Promise<FileMutationResult> {
  let handle;
  let created = false;
  let identity: { dev: number; ino: number } | null = null;
  try {
    handle = await open(path, 'wx', 0o600);
    created = true;
    const stats = await handle.stat();
    identity = { dev: stats.dev, ino: stats.ino };
    await handle.writeFile(bytes);
    await options.beforeFileSync?.(path);
    if (options.failFileSync === true) {
      throw new Error('Injected file sync failure');
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    return { ok: true, digest: sha256Digest(bytes) };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : null;
    if (identity === null) {
      return {
        ok: false,
        status: created ? 'partial' : code === 'EEXIST' ? 'conflict' : 'failed',
        code:
          code === 'EEXIST'
            ? diagnosticCodes.document_already_registered
            : diagnosticCodes.fileUnreadable,
        message:
          code === 'EEXIST'
            ? `Document target already exists: ${path}`
            : `Cannot create document ${path}: ${error instanceof Error ? error.message : String(error)}`,
        residualPaths: created ? [path] : [],
      };
    }
    const cleaned = await removeCreatedIfUnchanged(path, identity, bytes);
    return {
      ok: false,
      status: cleaned ? 'failed' : 'partial',
      code: diagnosticCodes.fileUnreadable,
      message: `Writing document ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
      residualPaths: cleaned ? [] : [path],
    };
  }
}

async function replaceFileAtomic(
  path: string,
  bytes: Buffer,
  expectedDigest: string,
): Promise<FileMutationResult> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const current = await readFileBounded(path, MAX_DOCUMENT_BYTES);
    if (!current.ok) {
      await rm(temporary, { force: true }).catch(() => undefined);
      return {
        ok: false,
        status: 'failed',
        code: current.code,
        message: current.message,
        residualPaths: [],
      };
    }
    if (current.value.digest !== expectedDigest) {
      await rm(temporary, { force: true }).catch(() => undefined);
      return {
        ok: false,
        status: 'conflict',
        code: diagnosticCodes.document_write_conflict,
        message: `Document changed before commit: ${path}`,
        residualPaths: [],
      };
    }
    await rename(temporary, path);
    return { ok: true, digest: sha256Digest(bytes) };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    return {
      ok: false,
      status: 'failed',
      code: diagnosticCodes.fileUnreadable,
      message: `Cannot replace document ${path}: ${error instanceof Error ? error.message : String(error)}`,
      residualPaths: [],
    };
  }
}

function journal(
  operationId: string,
  operation: KnowledgeJournal['operation'],
  stage: KnowledgeJournal['stage'],
  documentId: string | null,
  targetPath: string | null,
  catalogScope: KnowledgeJournal['catalogScope'],
  expectedDigest: string | null,
  fileDigest: string | null,
  catalogDigest: string | null,
  createdAt: string,
  updatedAt: string,
  residualPaths: readonly string[],
  detail: string | null,
): KnowledgeJournal {
  return {
    schema: 'pappra/knowledge-journal/1',
    operationId,
    operation,
    stage,
    documentId,
    targetPath,
    catalogScope,
    expectedDigest,
    fileDigest,
    catalogDigest,
    createdAt,
    updatedAt,
    residualPaths: [...residualPaths],
    detail,
  };
}

export async function applyWrite(
  input: ApplyWriteInput,
  root: string,
  options: KnowledgeServiceOptions = {},
): Promise<ApplyWriteResult> {
  const parsed = documentWriteProposalSchema.safeParse(input.proposal);
  if (!parsed.success) {
    return {
      ok: false,
      status: 'failed',
      record: null,
      diagnostics: [
        diagnostic(
          diagnosticCodes.document_record_invalid,
          `Write proposal is invalid: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`,
          'knowledge proposal',
          'Regenerate the proposal.',
        ),
      ],
      residualPaths: [],
      journalPath: null,
    };
  }
  const proposal = parsed.data;
  const content = contentBuffer(input.content);
  if (content.length > MAX_DOCUMENT_BYTES) {
    return {
      ok: false,
      status: 'failed',
      record: null,
      diagnostics: [
        diagnostic(
          diagnosticCodes.fileTooLarge,
          `Document content exceeds ${MAX_DOCUMENT_BYTES} bytes.`,
          'knowledge proposal',
          'Reduce the document size; Pappra does not truncate knowledge.',
        ),
      ],
      residualPaths: [],
      journalPath: null,
    };
  }
  if (sha256Digest(content) !== proposal.nextDigest) {
    return {
      ok: false,
      status: 'conflict',
      record: null,
      diagnostics: [
        diagnostic(
          diagnosticCodes.document_proposal_stale,
          'Proposal content does not match its recorded nextDigest.',
          'knowledge proposal',
          'Regenerate the proposal instead of applying modified bytes.',
        ),
      ],
      residualPaths: [],
      journalPath: null,
    };
  }
  const loaded = await loadKnowledgeContext(root);
  if (!loaded.ok || loaded.context === null) {
    return {
      ok: false,
      status: 'failed',
      record: null,
      diagnostics: [...loaded.diagnostics],
      residualPaths: [],
      journalPath: null,
    };
  }
  return applyWriteAt(loaded.context, proposal, content, options);
}

export async function applyWriteAt(
  inputContext: KnowledgeContext,
  proposal: DocumentWriteProposal,
  content: Buffer,
  options: KnowledgeServiceOptions = {},
): Promise<ApplyWriteResult> {
  const initialCatalogs = await loadKnowledgeCatalogs(inputContext);
  if (!initialCatalogs.ok) {
    return {
      ok: false,
      status: 'conflict',
      record: null,
      diagnostics: [...initialCatalogs.diagnostics],
      residualPaths: [],
      journalPath: null,
    };
  }
  if (!sameRootIdentity(inputContext, proposal.rootIdentity)) {
    return {
      ok: false,
      status: 'stale',
      record: null,
      diagnostics: [
        diagnostic(
          diagnosticCodes.document_proposal_stale,
          'Workspace root identity changed since the proposal was created.',
          inputContext.root,
          'Regenerate the proposal against the current workspace root.',
        ),
      ],
      residualPaths: [],
      journalPath: null,
    };
  }
  const lock = await acquireKnowledgeLock(inputContext, 'write-document');
  if (!lock.ok || lock.lock === null) {
    return {
      ok: false,
      status: lock.status === 'locked' ? 'locked' : 'failed',
      record: null,
      diagnostics: [
        diagnostic(
          lock.status === 'locked'
            ? diagnosticCodes.document_locked
            : diagnosticCodes.document_write_conflict,
          lock.message ?? 'Knowledge catalog is locked.',
          lock.path,
          'Retry after the current knowledge operation finishes.',
        ),
      ],
      residualPaths: [],
      journalPath: null,
    };
  }
  const operationId = randomUUID();
  const journalPath = knowledgeJournalPath(inputContext, operationId);
  let residualPaths: string[] = [];
  const createdAt = new Date().toISOString();
  const applyResult = await (async (): Promise<ApplyWriteResult> => {
    const reloaded = await loadKnowledgeContext(inputContext.root);
    if (!reloaded.ok || reloaded.context === null) {
      return {
        ok: false,
        status: 'failed',
        record: null,
        diagnostics: [...reloaded.diagnostics],
        residualPaths: [],
        journalPath,
      };
    }
    const context = reloaded.context;
    const catalogs = await loadKnowledgeCatalogs(context);
    if (!catalogs.ok) {
      return {
        ok: false,
        status: 'conflict',
        record: null,
        diagnostics: [...catalogs.diagnostics],
        residualPaths: [],
        journalPath,
      };
    }
    if (catalogs.catalogDigest !== proposal.catalogDigest) {
      return {
        ok: false,
        status: 'stale',
        record: null,
        diagnostics: [
          ...catalogs.diagnostics,
          diagnostic(
            diagnosticCodes.document_proposal_stale,
            'Document catalog changed since the proposal was created.',
            context.configPath,
            'Regenerate the proposal against the current catalog.',
          ),
        ],
        residualPaths: [],
        journalPath,
      };
    }
    if (!sameRootIdentity(context, proposal.rootIdentity)) {
      return {
        ok: false,
        status: 'stale',
        record: null,
        diagnostics: [
          diagnostic(
            diagnosticCodes.document_proposal_stale,
            'Workspace root identity changed before the proposal could be applied.',
            context.root,
            'Regenerate the proposal.',
          ),
        ],
        residualPaths: [],
        journalPath,
      };
    }
    const resolved = await resolveKnowledgeLocation(
      context,
      proposal.location,
      {
        forWrite: true,
        forCreate: proposal.mode === 'create',
      },
    );
    if (!resolved.ok) {
      return {
        ok: false,
        status: 'conflict',
        record: null,
        diagnostics: [outcomeDiagnostic(resolved, context.configPath)],
        residualPaths: [],
        journalPath,
      };
    }
    const alias = await findCanonicalAlias(
      context,
      catalogs,
      resolved.value,
      proposal.mode === 'update' ? proposal.documentId : null,
    );
    if (alias !== null) {
      return {
        ok: false,
        status: 'conflict',
        record: null,
        diagnostics: [
          diagnostic(
            diagnosticCodes.document_location_conflict,
            `Canonical document path is already registered by ${alias.documentId}.`,
            resolved.value.absolutePath,
            'Resolve the canonical location conflict before applying.',
          ),
        ],
        residualPaths: [],
        journalPath,
      };
    }
    const existing = findRecord(catalogs, proposal.documentId);
    if (proposal.mode === 'create') {
      if (existing !== null) {
        return {
          ok: false,
          status: 'conflict',
          record: null,
          diagnostics: [
            diagnostic(
              diagnosticCodes.document_duplicate_id,
              'A record with this document id already exists.',
              context.configPath,
              'Regenerate the proposal; create never overwrites an existing record.',
            ),
          ],
          residualPaths: [],
          journalPath,
        };
      }
      if (
        findRecordByLocation(catalogs, locationKey(proposal.location)) !== null
      ) {
        return {
          ok: false,
          status: 'conflict',
          record: null,
          diagnostics: [
            diagnostic(
              diagnosticCodes.document_location_conflict,
              'The location is already registered.',
              context.configPath,
              'Regenerate the proposal against the existing record.',
            ),
          ],
          residualPaths: [],
          journalPath,
        };
      }
      if (
        proposal.location.kind !== 'workspace' ||
        !isWithinNewDocuments(context, resolved.value.normalizedPath)
      ) {
        return {
          ok: false,
          status: 'conflict',
          record: null,
          diagnostics: [
            diagnostic(
              diagnosticCodes.document_path_unsafe,
              'New documents must stay under the configured newDocuments directory.',
              context.configPath,
              'Regenerate the proposal with a workspace location inside newDocuments.',
            ),
          ],
          residualPaths: [],
          journalPath,
        };
      }
    } else {
      if (existing === null || proposal.expectedDigest === null) {
        return {
          ok: false,
          status: 'conflict',
          record: null,
          diagnostics: [
            diagnostic(
              diagnosticCodes.document_not_found,
              'The document to update is missing or ambiguous.',
              context.configPath,
              'Regenerate the proposal from the current record.',
            ),
          ],
          residualPaths: [],
          journalPath,
        };
      }
      if (!sameRecordForUpdate(existing, proposal.record)) {
        return {
          ok: false,
          status: 'conflict',
          record: null,
          diagnostics: [
            diagnostic(
              diagnosticCodes.document_write_conflict,
              'The proposal changes metadata outside the controlled write path.',
              context.configPath,
              'Regenerate the proposal; visibility and lifecycle require explicit operations.',
            ),
          ],
          residualPaths: [],
          journalPath,
        };
      }
      const file = await readKnowledgeFile(
        resolved.value.absolutePath,
        MAX_DOCUMENT_BYTES,
      );
      if (!file.ok) {
        return {
          ok: false,
          status: 'conflict',
          record: null,
          diagnostics: [outcomeDiagnostic(file, context.configPath)],
          residualPaths: [],
          journalPath,
        };
      }
      if (file.value.digest !== proposal.expectedDigest) {
        return {
          ok: false,
          status: 'conflict',
          record: null,
          diagnostics: [
            diagnostic(
              diagnosticCodes.document_write_conflict,
              'Document bytes no longer match the proposal expectedDigest.',
              resolved.value.absolutePath,
              'Regenerate the proposal; no file was written.',
            ),
          ],
          residualPaths: [],
          journalPath,
        };
      }
      if (
        existing.owner === 'generator' &&
        existing.digest !== file.value.digest
      ) {
        return {
          ok: false,
          status: 'conflict',
          record: null,
          diagnostics: [
            diagnostic(
              diagnosticCodes.document_generated_modified,
              'A generated document was modified; automatic overwrite is blocked.',
              resolved.value.absolutePath,
              'Review the change and use an explicit human-owned flow.',
            ),
          ],
          residualPaths: [],
          journalPath,
        };
      }
    }
    const proposedRecord = documentRecordSchema.safeParse(proposal.record);
    if (!proposedRecord.success) {
      return {
        ok: false,
        status: 'failed',
        record: null,
        diagnostics: [
          diagnostic(
            diagnosticCodes.document_record_invalid,
            `Proposal record is invalid: ${proposedRecord.error.issues[0]?.message ?? 'unknown issue'}`,
            context.configPath,
            'Regenerate the proposal.',
          ),
        ],
        residualPaths: [],
        journalPath,
      };
    }
    const sourceDiagnostics = validateSources(
      context,
      catalogs,
      proposal.record.documentId,
      proposal.record.visibility,
      proposal.record.sources,
    );
    if (sourceDiagnostics.length > 0) {
      return {
        ok: false,
        status: 'conflict',
        record: null,
        diagnostics: [...catalogs.diagnostics, ...sourceDiagnostics],
        residualPaths: [],
        journalPath,
      };
    }
    const initialJournal = journal(
      operationId,
      'write-document',
      'prepared',
      proposal.documentId,
      resolved.value.absolutePath,
      catalogScopeFor(proposal.record),
      proposal.expectedDigest,
      proposal.nextDigest,
      catalogs.catalogDigest,
      createdAt,
      createdAt,
      [],
      null,
    );
    const journalWritten = await writeKnowledgeJournal(context, initialJournal);
    if (!journalWritten.ok) {
      return {
        ok: false,
        status: 'failed',
        record: null,
        diagnostics: [outcomeDiagnostic(journalWritten, journalPath)],
        residualPaths: [],
        journalPath,
      };
    }
    if (proposal.mode === 'create') {
      try {
        await mkdir(dirname(resolved.value.absolutePath), { recursive: true });
      } catch (error) {
        return {
          ok: false,
          status: 'failed',
          record: null,
          diagnostics: [
            diagnostic(
              diagnosticCodes.fileUnreadable,
              `Cannot create document parent directory: ${error instanceof Error ? error.message : String(error)}`,
              resolved.value.absolutePath,
              'Inspect permissions; no document file or catalog was written.',
            ),
          ],
          residualPaths: [],
          journalPath,
        };
      }
      const fileWritten = await writeFileExclusive(
        resolved.value.absolutePath,
        content,
        options,
      );
      if (!fileWritten.ok) {
        await writeKnowledgeJournal(context, {
          ...initialJournal,
          stage: 'failed',
          updatedAt: new Date().toISOString(),
          residualPaths: [...fileWritten.residualPaths],
          detail: fileWritten.message,
        });
        return {
          ok: false,
          status:
            fileWritten.status === 'partial'
              ? 'partial'
              : fileWritten.status === 'conflict'
                ? 'conflict'
                : 'failed',
          record: null,
          diagnostics: [
            diagnostic(
              fileWritten.code,
              fileWritten.message,
              resolved.value.absolutePath,
              fileWritten.status === 'partial'
                ? 'The incomplete file was preserved and must be inspected/removed explicitly.'
                : 'No document file was committed.',
            ),
          ],
          residualPaths: [...fileWritten.residualPaths],
          journalPath,
        };
      }
    } else {
      const expectedFileDigest = proposal.expectedDigest;
      if (expectedFileDigest === null) {
        return {
          ok: false,
          status: 'stale',
          record: null,
          diagnostics: [
            diagnostic(
              diagnosticCodes.document_proposal_stale,
              'Update proposal has no expected file digest.',
              resolved.value.absolutePath,
              'Regenerate the proposal.',
            ),
          ],
          residualPaths: [],
          journalPath,
        };
      }
      const fileWritten = await replaceFileAtomic(
        resolved.value.absolutePath,
        content,
        expectedFileDigest,
      );
      if (!fileWritten.ok) {
        await writeKnowledgeJournal(context, {
          ...initialJournal,
          stage: 'failed',
          updatedAt: new Date().toISOString(),
          residualPaths: [...fileWritten.residualPaths],
          detail: fileWritten.message,
        });
        return {
          ok: false,
          status: fileWritten.status === 'conflict' ? 'conflict' : 'failed',
          record: null,
          diagnostics: [
            diagnostic(
              fileWritten.code,
              fileWritten.message,
              resolved.value.absolutePath,
              'The existing document file was preserved; no catalog replacement was committed.',
            ),
          ],
          residualPaths: [...fileWritten.residualPaths],
          journalPath,
        };
      }
    }
    residualPaths = [resolved.value.absolutePath];
    const fileStage = journal(
      operationId,
      'write-document',
      'file-written',
      proposal.documentId,
      resolved.value.absolutePath,
      catalogScopeFor(proposal.record),
      proposal.expectedDigest,
      proposal.nextDigest,
      catalogs.catalogDigest,
      createdAt,
      new Date().toISOString(),
      residualPaths,
      'Document bytes were written; the catalog update is still pending.',
    );
    const fileJournal = await writeKnowledgeJournal(context, fileStage);
    if (!fileJournal.ok) {
      return {
        ok: false,
        status: 'partial',
        record: null,
        diagnostics: [outcomeDiagnostic(fileJournal, journalPath)],
        residualPaths,
        journalPath,
      };
    }
    const committedFile = await readKnowledgeFile(
      resolved.value.absolutePath,
      MAX_DOCUMENT_BYTES,
    );
    const latestCatalogs = await loadKnowledgeCatalogs(context);
    if (
      !committedFile.ok ||
      committedFile.value.digest !== proposal.nextDigest ||
      !latestCatalogs.ok ||
      latestCatalogs.catalogDigest !== proposal.catalogDigest
    ) {
      const failedStage = journal(
        operationId,
        'write-document',
        'failed',
        proposal.documentId,
        resolved.value.absolutePath,
        catalogScopeFor(proposal.record),
        proposal.expectedDigest,
        proposal.nextDigest,
        catalogs.catalogDigest,
        createdAt,
        new Date().toISOString(),
        residualPaths,
        'Document file or catalog changed before the catalog commit.',
      );
      await writeKnowledgeJournal(context, failedStage);
      return {
        ok: false,
        status: 'partial',
        record: null,
        diagnostics: [
          ...latestCatalogs.diagnostics,
          diagnostic(
            diagnosticCodes.document_write_partial,
            'Document file or catalog changed before the catalog commit; the file was preserved and the catalog was not updated.',
            resolved.value.absolutePath,
            'Inspect the journal and reconcile the file/catalog state explicitly.',
          ),
        ],
        residualPaths,
        journalPath,
      };
    }
    const nextCatalog = setCatalogRecord(
      context,
      catalogs,
      proposedRecord.data,
    );
    const catalogWritten = await writeCatalogFile(
      context,
      nextCatalog.scope,
      nextCatalog.catalog,
      catalogDigestFor(catalogs, nextCatalog.scope),
    );
    if (!catalogWritten.ok) {
      const failedStage = journal(
        operationId,
        'write-document',
        'failed',
        proposal.documentId,
        resolved.value.absolutePath,
        nextCatalog.scope,
        proposal.expectedDigest,
        proposal.nextDigest,
        catalogs.catalogDigest,
        createdAt,
        new Date().toISOString(),
        residualPaths,
        'Document file was written but the catalog update failed.',
      );
      await writeKnowledgeJournal(context, failedStage);
      return {
        ok: false,
        status: 'partial',
        record: null,
        diagnostics: [
          diagnostic(
            diagnosticCodes.document_write_partial,
            'Document file was written but the catalog update failed.',
            catalogWritten.message,
            'Inspect the journal and re-run an explicit repair; the old catalog entry may still point to the previous digest.',
          ),
        ],
        residualPaths,
        journalPath,
      };
    }
    residualPaths = [];
    const complete = journal(
      operationId,
      'write-document',
      'complete',
      proposal.documentId,
      resolved.value.absolutePath,
      nextCatalog.scope,
      proposal.expectedDigest,
      proposal.nextDigest,
      catalogWritten.value.digest,
      createdAt,
      new Date().toISOString(),
      [],
      null,
    );
    const completeJournal = await writeKnowledgeJournal(context, complete);
    if (!completeJournal.ok) {
      return {
        ok: false,
        status: 'partial',
        record: proposedRecord.data,
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
      status: 'applied',
      record: proposedRecord.data,
      diagnostics: [...reloaded.diagnostics],
      residualPaths,
      journalPath,
    };
  })();
  const release = await releaseKnowledgeLock(lock.lock, lock.path);
  if (!release.ok) {
    return {
      ...applyResult,
      ok: false,
      status: applyResult.ok ? 'partial' : applyResult.status,
      diagnostics: [
        ...applyResult.diagnostics,
        outcomeDiagnostic(release, lock.path),
      ],
      residualPaths: [...applyResult.residualPaths, lock.path],
    };
  }
  return applyResult;
}
