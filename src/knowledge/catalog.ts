import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import { ensurePrivateState } from '../infra/private-state.js';
import { dirname, join } from 'node:path';
import type { Diagnostic } from '../schemas/diagnostics.js';
import { createDiagnostic } from '../schemas/diagnostics.js';
import { diagnosticCodes } from '../schemas/errors.js';
import {
  DOCUMENT_CATALOG_SCHEMA,
  documentCatalogSchema,
  documentRecordFileSchema,
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
  readonly recordDigests?: ReadonlyMap<string, string>;
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
  if (scope === 'shared') return readSharedRecords(context, path);
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

async function readSharedRecords(
  context: KnowledgeContext,
  path: string,
): Promise<CatalogFileState> {
  const diagnostics: Diagnostic[] = [];
  const invalid = (message: string): CatalogFileState => ({
    scope: 'shared',
    path,
    exists: true,
    digest: null,
    catalog: null,
    diagnostics: [
      catalogDiagnostic(
        diagnosticCodes.document_catalog_invalid,
        message,
        path,
        'Inspect the per-document records; malformed state is preserved. Legacy catalog.json requires an explicit reset, not an automatic migration.',
      ),
    ],
    valid: false,
  });
  try {
    const legacy = await observePath(join(dirname(path), 'catalog.json'));
    if (legacy.kind !== 'missing')
      return invalid(
        'Legacy shared catalog.json is unsupported; preserve or export it and explicitly reset the shared catalog before using per-document records.',
      );
    const observation = await observePath(path);
    if (observation.kind === 'missing')
      return {
        scope: 'shared',
        path,
        exists: false,
        digest: null,
        catalog: null,
        diagnostics: [],
        valid: true,
      };
    if (observation.kind !== 'directory')
      return invalid('Shared document records must be a real directory.');
    const names = (await readdir(path))
      .filter((name) => name !== '.DS_Store' && name !== 'Thumbs.db')
      .sort();
    if (names.length > 2048)
      return invalid('Shared document record limit exceeded (2048).');
    const records: DocumentRecord[] = [];
    const digests: string[] = [];
    const recordDigests = new Map<string, string>();
    let totalBytes = 0;
    for (const name of names) {
      if (/^[0-9a-f-]{36}\.json\.tmp-[0-9a-f-]{36}$/i.test(name)) continue;
      if (!/^[0-9a-f-]{36}\.json$/i.test(name))
        return invalid(`Unexpected file in shared records directory: ${name}`);
      const file = join(path, name);
      const read = await readTextFileBounded(file, DEFAULT_CATALOG_MAX_BYTES);
      if (!read.ok)
        return invalid(`Cannot safely read shared document record: ${name}`);
      totalBytes += Buffer.byteLength(read.value.text);
      if (totalBytes > DEFAULT_CATALOG_MAX_BYTES)
        return invalid(
          'Shared document records exceed the catalog byte budget.',
        );
      const parsed = documentRecordFileSchema.safeParse(
        JSON.parse(read.value.text) as unknown,
      );
      if (
        !parsed.success ||
        `${parsed.data.record.documentId}.json` !== name ||
        parsed.data.workspaceId !== context.config.workspaceId ||
        parsed.data.record.visibility !== 'shareable'
      )
        return invalid(
          `Invalid document identity, scope or schema in shared record: ${name}`,
        );
      records.push(parsed.data.record);
      digests.push(`${name}:${read.value.digest}`);
      recordDigests.set(parsed.data.record.documentId, read.value.digest);
    }
    return {
      scope: 'shared',
      path,
      exists: true,
      digest: sha256Digest(digests.join('\n')),
      catalog: {
        ...emptyCatalog(context, '1970-01-01T00:00:00.000Z'),
        records,
      },
      diagnostics,
      valid: true,
      recordDigests,
    };
  } catch (error) {
    return invalid(
      `Cannot read shared document records: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
      if (record.lifecycle === 'archived') continue;
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
  const parsed = documentCatalogSchema.safeParse(catalog);
  if (!parsed.success || catalog.workspaceId !== context.config.workspaceId)
    return failed(
      diagnosticCodes.document_record_invalid,
      'Refusing to write an invalid catalog or foreign workspace identity.',
    );
  if (scope === 'shared') {
    try {
      return await writeSharedRecords(
        context,
        path,
        parsed.data,
        expectedDigest,
      );
    } catch (error) {
      return failed(
        diagnosticCodes.fileUnreadable,
        `Cannot commit shared document records: ${error instanceof Error ? error.message : String(error)}`,
        {
          nextAction:
            'Inspect permissions and any individually committed records; rerun scan to reconcile without replacing document content.',
        },
      );
    }
  }
  return writeCatalogBytes(
    context,
    path,
    Buffer.from(`${JSON.stringify(parsed.data, null, 2)}\n`),
    expectedDigest,
    scope,
  );
}

async function writeSharedRecords(
  context: KnowledgeContext,
  path: string,
  catalog: DocumentCatalog,
  expectedDigest: string | null,
): Promise<Outcome<{ readonly path: string; readonly digest: string }>> {
  const boundary = await ensureKnowledgePathBoundary(context.root, path);
  if (!boundary.ok) return boundary;
  const before = await readSharedRecords(context, path);
  if (!before.valid || before.digest !== expectedDigest)
    return failed(
      diagnosticCodes.document_catalog_conflict,
      'Shared document records changed before commit; reload before retrying.',
    );
  await mkdir(path, { recursive: true });
  const previous = new Map(
    before.catalog?.records.map((record) => [record.documentId, record]) ?? [],
  );
  for (const record of catalog.records) {
    const old = previous.get(record.documentId);
    previous.delete(record.documentId);
    if (old && JSON.stringify(old) === JSON.stringify(record)) continue;
    const recordPath = join(path, `${record.documentId}.json`);
    const bytes = Buffer.from(
      `${JSON.stringify({ schema: 'pappra/document-record-file/1', workspaceId: context.config.workspaceId, record }, null, 2)}\n`,
    );
    const written = await writeCatalogBytes(
      context,
      recordPath,
      bytes,
      before.recordDigests?.get(record.documentId) ?? null,
      'shared',
    );
    if (!written.ok) return written;
  }
  for (const record of previous.values()) {
    const file = join(path, `${record.documentId}.json`);
    const boundary = await ensureKnowledgePathBoundary(context.root, file);
    if (!boundary.ok) return boundary;
    const current = await readTextFileBounded(file, DEFAULT_CATALOG_MAX_BYTES);
    if (
      !current.ok ||
      JSON.stringify(
        (JSON.parse(current.value.text) as { record: DocumentRecord }).record,
      ) !== JSON.stringify(record)
    )
      return failed(
        diagnosticCodes.document_catalog_conflict,
        'Shared document record changed before removal.',
      );
    await unlink(file);
  }
  const after = await readSharedRecords(context, path);
  return after.valid && after.digest !== null
    ? succeeded({ path, digest: after.digest })
    : failed(
        diagnosticCodes.document_catalog_conflict,
        'Shared catalog commit is incomplete; inspect the per-document files and retry.',
      );
}

async function writeCatalogBytes(
  context: KnowledgeContext,
  path: string,
  bytes: Buffer,
  expectedDigest: string | null,
  scope: CatalogScope,
): Promise<Outcome<{ readonly path: string; readonly digest: string }>> {
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
