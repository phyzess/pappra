import type { Diagnostic } from '../schemas/diagnostics.js';
import type {
  DocumentCatalog,
  DocumentKind,
  DocumentLocation,
  DocumentMaturity,
  DocumentOwner,
  DocumentRecord,
  DocumentSource,
  DocumentVisibility,
  DocumentWriteProposal,
  KnowledgeDeletePlan,
} from '../schemas/document.js';
import type { FreshnessReason, FreshnessReport, SourceCheck } from './refs.js';

export interface RegisterDocumentInput {
  readonly location: DocumentLocation;
  readonly kind: DocumentKind;
  readonly maturity: DocumentMaturity;
  readonly owner: DocumentOwner;
  readonly taskId?: string | null;
  readonly sources?: readonly DocumentSource[];
  readonly lastReviewedAt?: string | null;
  readonly visibility?: DocumentVisibility;
  /** Advanced/migration use only; the service never derives IDs from paths. */
  readonly documentId?: string;
}

export interface RegisterDocumentResult {
  readonly ok: boolean;
  readonly status: 'registered' | 'existing' | 'conflict' | 'failed';
  readonly record: DocumentRecord | null;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ReadDocumentResult {
  readonly ok: boolean;
  readonly status: 'ok' | 'not-found' | 'conflict' | 'failed';
  readonly record: DocumentRecord | null;
  readonly content: Buffer | null;
  readonly text: string | null;
  readonly digest: string | null;
  readonly freshness: FreshnessReport | null;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ListDocumentsOptions {
  readonly includePrivate?: boolean;
  readonly includeArchived?: boolean;
}

export interface ListDocumentsResult {
  readonly ok: boolean;
  readonly records: readonly DocumentRecord[];
  readonly diagnostics: readonly Diagnostic[];
  readonly catalogDigest: string;
  readonly includePrivate: boolean;
  readonly includeArchived: boolean;
}

export interface DocumentCheckEntry {
  readonly documentId: string;
  readonly scope: 'shared' | 'private';
  readonly lifecycle: DocumentRecord['lifecycle'];
  readonly maturity: DocumentRecord['maturity'];
  readonly fileDigest: string | null;
  readonly recordDigest: string;
  readonly freshness: FreshnessReport['freshness'];
  readonly reasons: readonly FreshnessReason[];
  readonly sourceChecks: readonly SourceCheck[];
}

export interface DocumentCheckResult {
  readonly ok: boolean;
  readonly checkedAt: string;
  readonly catalogDigest: string;
  readonly entries: readonly DocumentCheckEntry[];
  readonly diagnostics: readonly Diagnostic[];
  readonly summary: {
    readonly total: number;
    readonly current: number;
    readonly needsReview: number;
    readonly unknown: number;
  };
  readonly coverage: {
    readonly catalogs: 'shared' | 'shared-and-private';
    readonly pathReferences: 'unchecked';
    readonly repositoryContent: 'not-scanned';
    readonly taskExecution: 'unknown';
  };
}

export interface CreateDocumentWriteInput {
  readonly mode: 'create';
  readonly location: DocumentLocation;
  readonly kind: DocumentKind;
  readonly maturity: DocumentMaturity;
  readonly owner: DocumentOwner;
  readonly taskId?: string | null;
  readonly sources?: readonly DocumentSource[];
  readonly lastReviewedAt?: string | null;
  readonly visibility?: DocumentVisibility;
  readonly documentId?: string;
  readonly content: Uint8Array | string;
  readonly expectedDigest: null;
}

export interface UpdateDocumentWriteInput {
  readonly mode: 'update';
  readonly documentId: string;
  readonly content: Uint8Array | string;
  readonly expectedDigest: string;
}

export type ProposeWriteInput =
  CreateDocumentWriteInput | UpdateDocumentWriteInput;

export interface ProposeWriteResult {
  readonly ok: boolean;
  readonly status: 'proposed' | 'conflict' | 'stale' | 'failed';
  readonly proposal: DocumentWriteProposal | null;
  readonly content: Buffer | null;
  readonly diagnostics: readonly Diagnostic[];
}

export interface KnowledgeServiceOptions {
  /** Test/fault-injection seam; the CLI never supplies these hooks. */
  readonly beforeFileSync?: (path: string) => Promise<void> | void;
  readonly failFileSync?: boolean;
}

export interface ApplyWriteInput {
  readonly proposal: DocumentWriteProposal;
  readonly content: Uint8Array | string;
}

export interface ApplyWriteResult {
  readonly ok: boolean;
  readonly status:
    'applied' | 'conflict' | 'stale' | 'locked' | 'partial' | 'failed';
  readonly record: DocumentRecord | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly residualPaths: readonly string[];
  readonly journalPath: string | null;
}

export interface ArchiveDocumentResult {
  readonly ok: boolean;
  readonly status:
    'archived' | 'unchanged' | 'not-found' | 'conflict' | 'locked' | 'failed';
  readonly record: DocumentRecord | null;
  readonly diagnostics: readonly Diagnostic[];
}

export interface SupersedeDocumentInput {
  readonly documentId: string;
  readonly supersededBy: string;
}

export interface SupersedeDocumentResult {
  readonly ok: boolean;
  readonly status:
    'superseded' | 'unchanged' | 'not-found' | 'conflict' | 'locked' | 'failed';
  readonly record: DocumentRecord | null;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ShareDocumentResult {
  readonly ok: boolean;
  readonly status:
    | 'shared'
    | 'unchanged'
    | 'not-found'
    | 'conflict'
    | 'locked'
    | 'partial'
    | 'failed';
  readonly record: DocumentRecord | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly residualPaths: readonly string[];
}

export interface PreviewDeleteInput {
  readonly documentId: string;
  readonly removeFile: boolean;
}

export interface PreviewDeleteResult {
  readonly ok: boolean;
  readonly status: 'ready' | 'blocked' | 'not-found' | 'stale' | 'failed';
  readonly plan: KnowledgeDeletePlan | null;
  readonly diagnostics: readonly Diagnostic[];
}

export interface DeleteExplicitInput {
  readonly plan: KnowledgeDeletePlan;
}

export interface DeleteExplicitResult {
  readonly ok: boolean;
  readonly status:
    | 'deleted'
    | 'unregistered'
    | 'blocked'
    | 'stale'
    | 'locked'
    | 'partial'
    | 'failed';
  readonly documentId: string | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly residualPaths: readonly string[];
  readonly journalPath: string | null;
}

export interface CatalogInspection {
  readonly scope: 'shared' | 'private';
  readonly path: string;
  readonly exists: boolean;
  readonly valid: boolean;
  readonly recordCount: number;
  readonly catalog: DocumentCatalog | null;
}

export type { FreshnessReport };
