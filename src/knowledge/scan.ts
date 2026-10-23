import { discoverWorkspace } from '../workspace/discover.js';
import { createDiagnostic } from '../schemas/diagnostics.js';
import type { Diagnostic } from '../schemas/diagnostics.js';
import { diagnosticCodes } from '../schemas/errors.js';
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

function scanResult(
  root: string,
  mode: 'plan' | 'apply',
  candidates: readonly DocumentScanCandidate[],
  registered: readonly unknown[],
  skipped: number,
  diagnostics: readonly Diagnostic[],
  nextActions: readonly string[],
  ok = !diagnostics.some((entry) => entry.severity === 'error'),
): DocumentScanResult {
  return {
    ok,
    schema: 'pappra/docs-scan/1',
    mode,
    workspaceRoot: root,
    candidates,
    registered,
    skipped,
    nextActions,
    diagnostics,
  };
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
  const diagnostics: Diagnostic[] = [...discovery.diagnostics];
  if (discovery.truncated) {
    diagnostics.push(
      createDiagnostic({
        code: diagnosticCodes.discoveryLimitReached,
        severity: 'warning',
        message:
          'Knowledge source discovery was truncated; scan coverage is incomplete.',
        source: root,
        pointer: null,
        hint: 'Reduce the configured sources or their size, then rerun the scan for complete coverage.',
      }),
    );
  }
  if (config === null) {
    return scanResult(
      root,
      options.apply ? 'apply' : 'plan',
      [],
      [],
      0,
      diagnostics,
      [
        'Run pappra init or repair .pappra/workspace.json before scanning knowledge sources.',
      ],
      false,
    );
  }
  const service = new KnowledgeService(root);
  const listed = await service.list({
    includePrivate: true,
    includeArchived: true,
  });
  diagnostics.push(...listed.diagnostics);
  if (!listed.ok) {
    return scanResult(
      root,
      options.apply ? 'apply' : 'plan',
      [],
      [],
      0,
      diagnostics,
      [
        'Repair the knowledge catalog diagnostics before scanning; no registration was attempted.',
      ],
      false,
    );
  }
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
  const incomplete =
    discovery.truncated ||
    diagnostics.some((entry) => entry.severity === 'error');
  const privateCommand =
    visibility === 'private' ? 'pappra docs list --include-private' : null;
  if (!options.apply) {
    const nextActions: string[] = [];
    if (candidates.length > 0) {
      nextActions.push(
        'Rerun with --apply to register these documents in the knowledge catalog.',
      );
    }
    if (incomplete || discovery.truncated) {
      nextActions.push(
        'Correct the reported knowledge-source diagnostics, then rerun the scan for complete coverage.',
      );
    }
    if (privateCommand !== null) {
      nextActions.push(
        `After applying, review private documents with: ${privateCommand}.`,
      );
    }
    return scanResult(
      root,
      'plan',
      candidates,
      [],
      candidates.length,
      diagnostics,
      nextActions,
      !incomplete,
    );
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
  const nextActions: string[] = [];
  if (
    incomplete ||
    discovery.truncated ||
    registeredNow.length < candidates.length
  ) {
    nextActions.push(
      'Coverage was incomplete or some registrations failed; correct the diagnostics and rerun the scan.',
    );
  }
  if (privateCommand !== null) {
    nextActions.push(
      `Review registered private documents with: ${privateCommand}.`,
    );
  }
  return scanResult(
    root,
    'apply',
    candidates,
    registeredNow,
    candidates.length - registeredNow.length,
    diagnostics,
    nextActions,
    !incomplete && !diagnostics.some((entry) => entry.severity === 'error'),
  );
}
