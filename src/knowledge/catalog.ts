import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { ensurePrivateState } from '../infra/private-state.js';
import { dirname } from 'node:path';
import type { Diagnostic } from '../schemas/diagnostics.js';
import { createDiagnostic } from '../schemas/diagnostics.js';
import { diagnosticCodes } from '../schemas/errors.js';
import {
  DOCUMENT_CATALOG_SCHEMA,
  documentCatalogSchema,
  type DocumentCatalog,
  type DocumentLocation,
  type DocumentRecord,
} from '../schemas/document.js';
import { failed, succeeded, type Outcome } from '../schemas/outcome.js';
import {
  observePath,
  readFileBounded,
  readTextFileBounded,
  sha256Digest,
} from '../infra/fs.js';
import type { KnowledgeContext } from './context.js';
import {
  ensureKnowledgePathBoundary,
  knowledgePaths,
  type KnowledgePaths,
} from './paths.js';

export const DEFAULT_CATALOG_MAX_BYTES = 8 * 1024 * 1024;

export type CatalogScope = 'shared' | 'private';

export interface CatalogFileState {
  readonly scope: CatalogScope;
  readonly path: string;
  readonly exists: boolean;
  readonly digest: string | null;
  readonly catalog: DocumentCatalog | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly valid: boolean;
}

export interface KnowledgeCatalogs {
  readonly paths: KnowledgePaths;
  readonly shared: CatalogFileState;
  readonly private: CatalogFileState;
  readonly records: ReadonlyMap<string, DocumentRecord>;
  readonly idConflicts: ReadonlySet<string>;
  readonly locationConflicts: ReadonlySet<string>;
  readonly diagnostics: readonly Diagnostic[];
  readonly catalogDigest: string;
  readonly ok: boolean;
}

export function emptyCatalog(
  context: KnowledgeContext,
  updatedAt = new Date().toISOString(),
): DocumentCatalog {
  return {
    schema: DOCUMENT_CATALOG_SCHEMA,
    workspaceId: context.config.workspaceId,
    updatedAt,
    records: [],
  };
}

export function catalogDigestFor(
  catalogs: KnowledgeCatalogs,
  scope: CatalogScope,
): string | null {
  return scope === 'shared' ? catalogs.shared.digest : catalogs.private.digest;
}

export function catalogScopeFor(record: DocumentRecord): CatalogScope {
  return record.visibility === 'shareable' ? 'shared' : 'private';
}

export function locationKey(location: DocumentLocation): string {
  return location.kind === 'workspace'
    ? `workspace:${location.path}`
    : `source:${location.sourceId}:${location.path}`;
}

function catalogDiagnostic(
  code: (typeof diagnosticCodes)[keyof typeof diagnosticCodes],
  message: string,
  source: string,
  hint: string,
): Diagnostic {
  return createDiagnostic({ code, severity: 'error', message, source, hint });
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function readCatalogFile(
  context: KnowledgeContext,
  scope: CatalogScope,
  path: string,
): Promise<CatalogFileState> {
  let observation;
  try {
    observation = await observePath(path);
  } catch (error) {
    return {
      scope,
      path,
      exists: true,
      digest: null,
      catalog: null,
      diagnostics: [
        catalogDiagnostic(
          diagnosticCodes.fileUnreadable,
          `Cannot inspect document catalog ${path}: ${error instanceof Error ? error.message : String(error)}`,
          path,
          'Check permissions; Pappra does not overwrite an unreadable catalog.',
        ),
      ],
      valid: false,
    };
  }
  if (observation.kind === 'missing') {
    return {
      scope,
      path,
      exists: false,
      digest: null,
      catalog: null,
      diagnostics: [],
      valid: true,
    };
  }
  if (observation.kind !== 'file') {
    return {
      scope,
      path,
      exists: true,
      digest: null,
      catalog: null,
      diagnostics: [
        catalogDiagnostic(
          diagnosticCodes.document_catalog_invalid,
          `Document catalog is not a regular file: ${path}`,
          path,
          'Inspect the catalog; Pappra does not follow or replace it automatically.',
        ),
      ],
      valid: false,
    };
  }
  const read = await readTextFileBounded(path, DEFAULT_CATALOG_MAX_BYTES);
  if (!read.ok) {
    return {
      scope,
      path,
      exists: true,
      digest: null,
      catalog: null,
      diagnostics: [
        catalogDiagnostic(
          read.code,
          read.message,
          path,
          read.nextAction ?? 'Inspect the catalog file.',
        ),
      ],
      valid: false,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(read.value.text);
  } catch (error) {
    return {
      scope,
      path,
      exists: true,
      digest: null,
      catalog: null,
      diagnostics: [
        catalogDiagnostic(
          diagnosticCodes.document_catalog_invalid,
          `Document catalog is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
          path,
          'Repair the catalog manually; Pappra does not overwrite corrupted records.',
        ),
      ],
      valid: false,
    };
  }
  if (
    isUnknownRecord(raw) &&
    'schema' in raw &&
    typeof raw.schema === 'string' &&
    raw.schema !== DOCUMENT_CATALOG_SCHEMA
  ) {
    return {
      scope,
      path,
      exists: true,
      digest: read.value.digest,
      catalog: null,
      diagnostics: [
        catalogDiagnostic(
          diagnosticCodes.document_catalog_unsupported,
          `Unsupported document catalog schema: ${raw.schema}`,
          path,
          'Keep the catalog read-only until a migration is explicitly reviewed.',
        ),
      ],
      valid: false,
    };
  }
  const parsed = documentCatalogSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      scope,
      path,
      exists: true,
      digest: read.value.digest,
      catalog: null,
      diagnostics: [
        catalogDiagnostic(
          diagnosticCodes.document_catalog_invalid,
          `Document catalog is invalid: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`,
          path,
          'Repair the catalog manually; Pappra does not migrate or overwrite it.',
        ),
      ],
      valid: false,
    };
  }
  const diagnostics: Diagnostic[] = [];
  if (parsed.data.workspaceId !== context.config.workspaceId) {
    diagnostics.push(
      catalogDiagnostic(
        diagnosticCodes.document_catalog_conflict,
        `Catalog belongs to workspace ${parsed.data.workspaceId}, not ${context.config.workspaceId}.`,
        path,
        'Inspect the catalog identity; do not reuse a catalog from another workspace.',
      ),
    );
  }
  for (const record of parsed.data.records) {
    const expectedScope = catalogScopeFor(record);
    if (expectedScope !== scope) {
      diagnostics.push(
        catalogDiagnostic(
          diagnosticCodes.document_catalog_conflict,
          `${scope} catalog contains a ${record.visibility} record ${record.documentId}.`,
          path,
          'Private and shareable records belong in their respective catalogs.',
        ),
      );
    }
  }
  return {
    scope,
    path,
    exists: true,
    digest: read.value.digest,
    catalog: parsed.data,
    diagnostics,
    valid: diagnostics.length === 0,
  };
}

function combineDiagnostics(
  shared: CatalogFileState,
  privateState: CatalogFileState,
): Diagnostic[] {
  return [...shared.diagnostics, ...privateState.diagnostics];
}

export async function loadKnowledgeCatalogs(
  context: KnowledgeContext,
): Promise<KnowledgeCatalogs> {
  const paths = knowledgePaths(context.root);
  const shared = await readCatalogFile(context, 'shared', paths.sharedCatalog);
  const privateState = await readCatalogFile(
    context,
    'private',
    paths.privateCatalog,
  );
  const diagnostics = combineDiagnostics(shared, privateState);
  const records = new Map<string, DocumentRecord>();
  const locations = new Map<string, string>();
  const idConflicts = new Set<string>();
  const locationConflicts = new Set<string>();
  for (const file of [shared, privateState]) {
    if (file.catalog === null) continue;
    for (const record of file.catalog.records) {
      const existing = records.get(record.documentId);
      if (existing !== undefined) {
        idConflicts.add(record.documentId);
        diagnostics.push(
          catalogDiagnostic(
            diagnosticCodes.document_duplicate_id,
            `Document id ${record.documentId} appears more than once.`,
            file.path,
            'Resolve the duplicate manually; Pappra does not choose a record.',
          ),
        );
      } else {
        records.set(record.documentId, record);
      }
      const key = locationKey(record.location);
      const owner = locations.get(key);
      if (owner !== undefined && owner !== record.documentId) {
        locationConflicts.add(key);
        diagnostics.push(
          catalogDiagnostic(
            diagnosticCodes.document_location_conflict,
            `Location ${key} is registered by both ${owner} and ${record.documentId}.`,
            file.path,
            'Resolve the location conflict manually; Pappra does not overwrite either record.',
          ),
        );
      } else {
        locations.set(key, record.documentId);
      }
    }
  }
  const catalogDigest = sha256Digest(
    `${shared.digest ?? 'missing'}\n${privateState.digest ?? 'missing'}\n`,
  );
  return {
    paths,
    shared,
    private: privateState,
    records,
    idConflicts,
    locationConflicts,
    diagnostics,
    catalogDigest,
    ok: diagnostics.every((entry) => entry.severity !== 'error'),
  };
}

export function recordScope(
  catalogs: KnowledgeCatalogs,
  record: DocumentRecord,
): CatalogScope {
  if (
    catalogs.shared.catalog?.records.some(
      (entry) => entry.documentId === record.documentId,
    ) === true
  ) {
    return 'shared';
  }
  return 'private';
}

export function catalogFor(
  catalogs: KnowledgeCatalogs,
  scope: CatalogScope,
  context: KnowledgeContext,
): DocumentCatalog {
  const file = scope === 'shared' ? catalogs.shared : catalogs.private;
  return file.catalog ?? emptyCatalog(context);
}

export function recordsForCatalog(
  catalog: DocumentCatalog,
  documentId: string,
  next: DocumentRecord | null,
): DocumentRecord[] {
  const records = catalog.records.filter(
    (record) => record.documentId !== documentId,
  );
  if (next !== null) records.push(next);
  return records.sort((left, right) =>
    left.documentId.localeCompare(right.documentId),
  );
}

export function setCatalogRecord(
  context: KnowledgeContext,
  catalogs: KnowledgeCatalogs,
  record: DocumentRecord,
): { readonly scope: CatalogScope; readonly catalog: DocumentCatalog } {
  const scope = catalogScopeFor(record);
  const catalog = catalogFor(catalogs, scope, context);
  return {
    scope,
    catalog: {
      ...catalog,
      updatedAt: new Date().toISOString(),
      records: recordsForCatalog(catalog, record.documentId, record),
    },
  };
}

export function removeCatalogRecord(
  context: KnowledgeContext,
  catalogs: KnowledgeCatalogs,
  record: DocumentRecord,
): { readonly scope: CatalogScope; readonly catalog: DocumentCatalog } {
  const scope = recordScope(catalogs, record);
  const catalog = catalogFor(catalogs, scope, context);
  return {
    scope,
    catalog: {
      ...catalog,
      updatedAt: new Date().toISOString(),
      records: recordsForCatalog(catalog, record.documentId, null),
    },
  };
}

export async function writeCatalogFile(
  context: KnowledgeContext,
  scope: CatalogScope,
  catalog: DocumentCatalog,
  expectedDigest: string | null,
): Promise<Outcome<{ readonly path: string; readonly digest: string }>> {
  const path =
    scope === 'shared'
      ? knowledgePaths(context.root).sharedCatalog
      : knowledgePaths(context.root).privateCatalog;
  const boundary = await ensureKnowledgePathBoundary(context.root, path);
  if (!boundary.ok) return boundary;
  const current = await observePath(path);
  if (current.kind !== 'missing' && current.kind !== 'file') {
    return failed(
      diagnosticCodes.document_path_unsafe,
      `Catalog path is not a regular file: ${path}`,
      { nextAction: 'Inspect the catalog path; it was not replaced.' },
    );
  }
  if (catalog.workspaceId !== context.config.workspaceId) {
    return failed(
      diagnosticCodes.document_catalog_conflict,
      'Refusing to write a catalog for a different workspace id.',
      { nextAction: 'Inspect the workspace and catalog identity.' },
    );
  }
  const parsed = documentCatalogSchema.safeParse(catalog);
  if (!parsed.success) {
    return failed(
      diagnosticCodes.document_record_invalid,
      `Refusing to write an invalid catalog: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`,
      { nextAction: 'Fix the record; no catalog bytes were written.' },
    );
  }
  const bytes = Buffer.from(`${JSON.stringify(parsed.data, null, 2)}\n`);
  if (scope === 'private') {
    const prepared = await ensurePrivateState(context.root);
    if (!prepared.ok) return prepared;
  }
  const temporary = `${path}.tmp-${randomUUID()}`;
  let handle;
  try {
    await mkdir(dirname(path), { recursive: true });
    handle = await open(temporary, 'wx', scope === 'shared' ? 0o644 : 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const currentObservation = await observePath(path).catch(() => null);
    let currentDigest: string | null = null;
    if (currentObservation?.kind === 'missing') {
      currentDigest = null;
    } else if (currentObservation?.kind === 'file') {
      const current = await readFileBounded(path, DEFAULT_CATALOG_MAX_BYTES);
      if (!current.ok) {
        await rm(temporary, { force: true }).catch(() => undefined);
        return current;
      }
      currentDigest = current.value.digest;
    } else {
      await rm(temporary, { force: true }).catch(() => undefined);
      return failed(
        diagnosticCodes.document_catalog_conflict,
        `Catalog path changed to a non-regular file during commit: ${path}`,
        { nextAction: 'Inspect the catalog; no replacement was committed.' },
      );
    }
    if (currentDigest !== expectedDigest) {
      await rm(temporary, { force: true }).catch(() => undefined);
      return failed(
        diagnosticCodes.document_catalog_conflict,
        `Catalog changed before commit: ${path}`,
        {
          nextAction:
            'Reload the catalog and regenerate the proposal; no catalog replacement was committed.',
        },
      );
    }
    await rename(temporary, path);
    return succeeded({ path, digest: sha256Digest(bytes) });
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    return failed(
      diagnosticCodes.fileUnreadable,
      `Cannot write document catalog ${path}: ${error instanceof Error ? error.message : String(error)}`,
      {
        nextAction:
          'Inspect permissions and available disk space; no catalog replacement was claimed.',
      },
    );
  }
}
