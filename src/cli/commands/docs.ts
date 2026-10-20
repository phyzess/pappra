import type { Diagnostic } from '../../schemas/diagnostics.js';
import { discoverWorkspace } from '../../workspace/discover.js';
import { resolveWorkspaceRoot } from '../../workspace/resolve.js';
import { formatDiagnostic } from '../../schemas/diagnostics.js';
import {
  docsArchiveReportSchema,
  docsCheckReportSchema,
  docsListReportSchema,
  type DocumentKind,
  type DocumentRecord,
} from '../../schemas/document.js';
import {
  KnowledgeService,
  type ListDocumentsResult,
  type DocumentCheckResult,
} from '../../knowledge/index.js';
import type { CliOutput } from '../output.js';

export const docsUsage =
  'pappra docs <list|check|archive|scan> [options]\n' +
  '  list   [--include-private] [--include-archived] [--json]\n' +
  '  check  [--include-private] [--json]\n' +
  '  archive <documentId> [--json]\n' +
  '  scan   [--apply] [--json]\n\n' +
  'scan registers documents discovered under the configured knowledge sources; without\n' +
  '--apply it only reports the candidates.';

export interface DocsCommandOptions {
  readonly cwd: string;
  readonly action: string | null;
  readonly argument: string | null;
  readonly json: boolean;
  readonly includePrivate: boolean;
  readonly includeArchived: boolean;
  readonly apply: boolean;
}

function classifyScanKind(path: string): DocumentKind {
  const lower = path.toLowerCase();
  if (lower.endsWith('agents.md') || lower.endsWith('claude.md')) return 'rule';
  if (lower.includes('/research/')) return 'research';
  if (lower.includes('/adr/') || lower.includes('decision')) return 'decision';
  if (lower.includes('review') || lower.includes('retro')) return 'review';
  if (lower.includes('plan')) return 'plan';
  return 'architecture';
}

async function runDocsScan(
  options: DocsCommandOptions,
  output: CliOutput,
  root: string,
): Promise<number> {
  const discovery = await discoverWorkspace(root);
  const config = discovery.config;
  if (config === null) {
    return invalidArguments(
      output,
      options.json,
      'docs scan requires a valid .pappra/workspace.json; run pappra init first.',
    );
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
  const candidates = (discovery.documents ?? []).flatMap((document) => {
    const path = document.workspaceRelativePath;
    if (path === null) return [];
    if (
      !sources.some(
        (source) => path === source || path.startsWith(`${source}/`),
      )
    ) {
      return [];
    }
    if (registered.has(path)) return [];
    return [{ path, kind: classifyScanKind(path), visibility }];
  });
  if (!options.apply) {
    if (options.json) {
      output.stdout(
        `${JSON.stringify({
          ok: true,
          schema: 'pappra/docs-scan/1',
          mode: 'plan',
          workspaceRoot: root,
          candidates,
          registered: registered.size,
          nextActions: [
            'Rerun with --apply to register these documents in the knowledge catalog.',
          ],
        })}\n`,
      );
    } else {
      output.stdout(`Scan candidates: ${candidates.length}\n`);
      for (const candidate of candidates) {
        output.stdout(`  ${candidate.kind}  ${candidate.path}\n`);
      }
      output.stdout('Plan only; rerun with --apply to register them.\n');
    }
    return 0;
  }
  const registeredNow: unknown[] = [];
  const diagnostics: Diagnostic[] = [];
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
  const ok = diagnostics.every((entry) => entry.severity !== 'error');
  if (options.json) {
    output.stdout(
      `${JSON.stringify({
        ok,
        schema: 'pappra/docs-scan/1',
        mode: 'apply',
        workspaceRoot: root,
        registered: registeredNow,
        skipped: candidates.length - registeredNow.length,
        diagnostics,
      })}\n`,
    );
  } else {
    output.stdout(`Registered ${registeredNow.length} document(s).\n`);
    printDiagnostics(output, diagnostics);
  }
  return ok ? 0 : 1;
}

function printDiagnostics(
  output: CliOutput,
  diagnostics: readonly Diagnostic[],
): void {
  for (const diagnostic of diagnostics) {
    output.stderr(`${formatDiagnostic(diagnostic)}\n`);
  }
}

function printDocument(output: CliOutput, record: DocumentRecord): void {
  output.stdout(
    `${record.documentId}  ${record.lifecycle}/${record.maturity}  ${record.visibility}  ${record.kind}  ${record.location.kind === 'workspace' ? record.location.path : `${record.location.sourceId}:${record.location.path}`}\n`,
  );
}

function listReport(result: ListDocumentsResult): Record<string, unknown> {
  return {
    schema: 'pappra/docs-list/1',
    ok: result.ok,
    includePrivate: result.includePrivate,
    includeArchived: result.includeArchived,
    catalogDigest: result.catalogDigest,
    documents: result.records,
    diagnostics: result.diagnostics,
  };
}

function checkReport(result: DocumentCheckResult): Record<string, unknown> {
  return {
    schema: 'pappra/docs-check/1',
    ...result,
  };
}

function invalidArguments(
  output: CliOutput,
  json: boolean,
  message: string,
): number {
  if (json) {
    output.stdout(
      `${JSON.stringify({ ok: false, code: 'invalid_arguments', message })}\n`,
    );
  } else {
    output.stderr(`pappra: ${message}\n`);
  }
  return 2;
}

export async function runDocsCommand(
  options: DocsCommandOptions,
  output: CliOutput,
): Promise<number> {
  if (options.action === null || options.action === 'help') {
    if (options.json) {
      output.stdout(
        `${JSON.stringify({
          commands: ['list', 'check', 'archive'],
          usage: docsUsage,
        })}\n`,
      );
    } else {
      output.stdout(`${docsUsage}\n`);
    }
    return 0;
  }
  const resolution = await resolveWorkspaceRoot({ startPath: options.cwd });
  const serviceRoot = resolution.root ?? options.cwd;
  if (!['list', 'check', 'archive', 'scan'].includes(options.action)) {
    return invalidArguments(
      output,
      options.json,
      `unknown docs action: ${options.action}`,
    );
  }
  if (options.action === 'archive' && options.argument === null) {
    return invalidArguments(
      output,
      options.json,
      'docs archive requires a documentId',
    );
  }
  if (options.action !== 'archive' && options.argument !== null) {
    return invalidArguments(
      output,
      options.json,
      `docs ${options.action} does not accept an argument`,
    );
  }
  if (options.action === 'scan') {
    return runDocsScan(options, output, serviceRoot);
  }
  if (options.apply) {
    return invalidArguments(
      output,
      options.json,
      'only docs scan accepts --apply',
    );
  }
  if (options.action === 'archive' && options.argument !== null) {
    const service = new KnowledgeService(serviceRoot);
    const result = await service.archive(options.argument);
    if (options.json) {
      const report = docsArchiveReportSchema.safeParse({
        schema: 'pappra/docs-archive/1',
        ok: result.ok,
        status: result.status,
        document: result.record,
        diagnostics: result.diagnostics,
      });
      if (!report.success) {
        return invalidArguments(
          output,
          true,
          `docs archive report is invalid: ${report.error.issues[0]?.message ?? 'unknown issue'}`,
        );
      }
      output.stdout(`${JSON.stringify(report.data)}\n`);
    } else if (result.record !== null) {
      printDocument(output, result.record);
      printDiagnostics(output, result.diagnostics);
    } else {
      printDiagnostics(output, result.diagnostics);
    }
    return result.ok ? 0 : 1;
  }
  const service = new KnowledgeService(serviceRoot);
  if (options.action === 'list') {
    const result = await service.list({
      includePrivate: options.includePrivate,
      includeArchived: options.includeArchived,
    });
    if (options.json) {
      const report = docsListReportSchema.safeParse(listReport(result));
      if (!report.success) {
        return invalidArguments(
          output,
          true,
          `docs list report is invalid: ${report.error.issues[0]?.message ?? 'unknown issue'}`,
        );
      }
      output.stdout(`${JSON.stringify(report.data)}\n`);
    } else {
      for (const record of result.records) printDocument(output, record);
      printDiagnostics(output, result.diagnostics);
    }
    return result.ok ? 0 : 1;
  }
  const result = await service.check({
    includePrivate: options.includePrivate,
  });
  if (options.json) {
    const report = docsCheckReportSchema.safeParse(checkReport(result));
    if (!report.success) {
      return invalidArguments(
        output,
        true,
        `docs check report is invalid: ${report.error.issues[0]?.message ?? 'unknown issue'}`,
      );
    }
    output.stdout(`${JSON.stringify(report.data)}\n`);
  } else {
    for (const entry of result.entries) {
      output.stdout(
        `${entry.documentId}  ${entry.freshness}  ${entry.lifecycle}/${entry.maturity}  record=${entry.recordDigest}  file=${entry.fileDigest ?? 'missing'}\n`,
      );
      for (const reason of entry.reasons) {
        output.stdout(`  ${reason.code}: ${reason.message}\n`);
      }
    }
    output.stdout(
      `total=${result.summary.total} current=${result.summary.current} needs-review=${result.summary.needsReview} unknown=${result.summary.unknown}\n`,
    );
    printDiagnostics(output, result.diagnostics);
  }
  return result.ok ? 0 : 1;
}
