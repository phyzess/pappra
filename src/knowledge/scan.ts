import { discoverWorkspace } from '../workspace/discover.js';
import type { Diagnostic } from '../schemas/diagnostics.js';
import type { DocumentKind } from '../schemas/document.js';
import { KnowledgeService } from './index.js';

export interface DocumentScanCandidate {
  readonly path: string;
  readonly kind: DocumentKind;
  readonly visibility: 'private' | 'shareable';
}

export interface DocumentScanResult {
  readonly ok: boolean;
  readonly schema: 'pappra/docs-scan/1';
  readonly mode: 'plan' | 'apply';
  readonly workspaceRoot: string;
  readonly candidates: readonly DocumentScanCandidate[];
  readonly registered: readonly unknown[];
  readonly skipped: number;
  readonly nextActions: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

export type DocumentScanFailure =
  { readonly ok: false; readonly message: string } | DocumentScanResult;

export function classifyScannedDocumentKind(path: string): DocumentKind {
  const lower = path.toLowerCase();
  if (lower.endsWith('agents.md') || lower.endsWith('claude.md')) return 'rule';
  if (lower.includes('/research/')) return 'research';
  if (lower.includes('/adr/') || lower.includes('decision')) return 'decision';
  if (lower.includes('review') || lower.includes('retro')) return 'review';
  if (lower.includes('plan')) return 'plan';
  return 'architecture';
}

/**
 * Registers documents discovered under the configured knowledge sources.
 * Without apply this is read-only and reports the candidates.
 */
export async function scanDiscoveredDocuments(
  root: string,
  options: { readonly apply: boolean },
): Promise<DocumentScanFailure> {
  const discovery = await discoverWorkspace(root);
  const config = discovery.config;
  if (config === null) {
    return {
      ok: false,
      message:
        'docs scan requires a valid .pappra/workspace.json; run pappra init first.',
    };
  }
  const service = new KnowledgeService(root);
  const listed = await service.list({ includePrivate: true });
  const registered = new Set(
    listed.records.flatMap((record) =>
      record.location.kind === 'workspace' ? [record.location.path] : [],
    ),
  );
  const sources = config.knowledge.sources;
  const visibility: 'private' | 'shareable' =
    config.knowledge.taskVisibility === 'shared' ? 'shareable' : 'private';
  const candidates: DocumentScanCandidate[] = [];
  for (const document of discovery.documents ?? []) {
    const path = document.workspaceRelativePath;
    if (path === null) continue;
    if (
      !sources.some(
        (source) => path === source || path.startsWith(`${source}/`),
      )
    ) {
      continue;
    }
    if (registered.has(path)) continue;
    candidates.push({
      path,
      kind: classifyScannedDocumentKind(path),
      visibility,
    });
  }
  const diagnostics: Diagnostic[] = [...listed.diagnostics];
  if (!options.apply) {
    return {
      ok: true,
      schema: 'pappra/docs-scan/1',
      mode: 'plan',
      workspaceRoot: root,
      candidates,
      registered: [],
      skipped: candidates.length,
      nextActions: [
        'Rerun with apply: true to register these documents in the knowledge catalog.',
      ],
      diagnostics,
    };
  }
  const registeredNow: unknown[] = [];
  for (const candidate of candidates) {
    const result = await service.register({
      location: { kind: 'workspace', path: candidate.path },
      kind: candidate.kind,
      maturity: 'draft',
      owner: 'human',
      visibility: candidate.visibility,
    });
    diagnostics.push(...result.diagnostics);
    if (result.ok) registeredNow.push(result.record);
  }
  return {
    ok: diagnostics.every((entry) => entry.severity !== 'error'),
    schema: 'pappra/docs-scan/1',
    mode: 'apply',
    workspaceRoot: root,
    candidates,
    registered: registeredNow,
    skipped: candidates.length - registeredNow.length,
    nextActions: [],
    diagnostics,
  };
}
