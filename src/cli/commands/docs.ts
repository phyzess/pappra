import type { Diagnostic } from '../../schemas/diagnostics.js';
import { resolveWorkspaceRoot } from '../../workspace/resolve.js';
import { scanDiscoveredDocuments } from '../../knowledge/scan.js';
import { formatDiagnostic } from '../../schemas/diagnostics.js';
import {
  docsArchiveReportSchema,
  docsCheckReportSchema,
  docsListReportSchema,
  type DocumentRecord,
  documentLocationSchema,
} from '../../schemas/document.js';
import {
  KnowledgeService,
  type ListDocumentsResult,
  type DocumentCheckResult,
} from '../../knowledge/index.js';
import type { CliOutput } from '../output.js';

export const docsUsage =
  'pappra docs <list|check|archive|scan|relocate|forget> [options]\n' +
  '  list   [--include-private] [--include-archived] [--json]\n' +
  '  check  [--include-private] [--json]\n' +
  '  archive <documentId> [--json]\n' +
  '  scan   [--apply] [--json]\n\n' +
  '  relocate <documentId> <workspace-relative-path> [--apply] [--json]\n' +
  '  forget <documentId> [--scope private|shared] [--apply] [--json]\n\n' +
  'scan registers existing documents discovered under knowledge.sources; newDocuments is\n' +
  'only the destination for future authored documents. Without --apply scan only reports\n' +
  'candidates.';

export interface DocsCommandOptions {
  readonly cwd: string;
  readonly action: string | null;
  readonly argument: string | null;
  readonly targetPath?: string | null;
  readonly scope?: string | null;
  readonly json: boolean;
  readonly includePrivate: boolean;
  readonly includeArchived: boolean;
  readonly apply: boolean;
}

async function runDocsScan(
  options: DocsCommandOptions,
  output: CliOutput,
  root: string,
): Promise<number> {
  const result = await scanDiscoveredDocuments(root, { apply: options.apply });
  if ('message' in result) {
    return invalidArguments(output, options.json, result.message);
  }
  if (!options.apply) {
    if (options.json) {
      output.stdout(`${JSON.stringify(result)}\n`);
    } else {
      if (result.candidates.length === 0) {
        output.stdout('No new documents found.\n');
      } else {
        output.stdout(`Scan candidates: ${result.candidates.length}\n`);
        for (const candidate of result.candidates) {
          output.stdout(`  ${candidate.kind}  ${candidate.path}\n`);
        }
      }
      printDiagnostics(output, result.diagnostics);
      for (const action of result.nextActions) {
        output.stdout(`${action}\n`);
      }
      output.stdout(
        result.ok
          ? 'Plan only; rerun with --apply to register them.\n'
          : 'Scan coverage is incomplete; no complete result is claimed.\n',
      );
    }
    return result.ok ? 0 : 1;
  }
  if (options.json) {
    output.stdout(`${JSON.stringify(result)}\n`);
  } else {
    output.stdout(`Registered ${result.registered.length} document(s).\n`);
    if (!result.ok) {
      output.stdout(
        'Scan coverage is incomplete; the registration result is not a complete scan.\n',
      );
    }
    printDiagnostics(output, result.diagnostics);
    for (const action of result.nextActions) {
      output.stdout(`${action}\n`);
    }
  }
  return result.ok ? 0 : 1;
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
          commands: ['list', 'check', 'archive', 'scan', 'relocate', 'forget'],
          usage: docsUsage,
        })}\n`,
      );
    } else {
      output.stdout(`${docsUsage}\n`);
    }
    return 0;
  }
  if (
    options.scope !== undefined &&
    options.scope !== null &&
    (options.action !== 'forget' ||
      !['private', 'shared'].includes(options.scope))
  )
    return invalidArguments(
      output,
      options.json,
      'Only docs forget accepts --scope private|shared.',
    );
  const resolution = await resolveWorkspaceRoot({ startPath: options.cwd });
  const serviceRoot = resolution.root ?? options.cwd;
  if (
    !['list', 'check', 'archive', 'scan', 'relocate', 'forget'].includes(
      options.action,
    )
  ) {
    return invalidArguments(
      output,
      options.json,
      `unknown docs action: ${options.action}`,
    );
  }
  if (
    ['archive', 'relocate', 'forget'].includes(options.action) &&
    options.argument === null
  ) {
    return invalidArguments(
      output,
      options.json,
      `docs ${options.action} requires a documentId`,
    );
  }
  if (
    !['archive', 'relocate', 'forget'].includes(options.action) &&
    options.argument !== null
  ) {
    return invalidArguments(
      output,
      options.json,
      `docs ${options.action} does not accept an argument`,
    );
  }
  if (options.action === 'scan') {
    return runDocsScan(options, output, serviceRoot);
  }
  if (
    (options.action === 'relocate' || options.action === 'forget') &&
    options.argument !== null
  ) {
    const location =
      options.action === 'relocate'
        ? documentLocationSchema.safeParse({
            kind: 'workspace',
            path: options.targetPath,
          })
        : null;
    if (location && !location.success)
      return invalidArguments(
        output,
        options.json,
        'docs relocate requires a normalized workspace-relative target path.',
      );
    if (!options.apply) {
      const plan = {
        schema: 'pappra/docs-metadata-plan/1',
        ok: true,
        action: options.action,
        documentId: options.argument,
        scope: options.scope ?? null,
        location: location?.success ? location.data : null,
        applied: false,
      };
      output.stdout(
        options.json
          ? `${JSON.stringify(plan)}\n`
          : `Plan only: ${options.action} ${options.argument}; document content is preserved. Rerun with --apply.\n`,
      );
      return 0;
    }
    const service = new KnowledgeService(serviceRoot);
    const result = location?.success
      ? await service.relocate(options.argument, location.data)
      : await service.forget(
          options.argument,
          options.scope === 'private' || options.scope === 'shared'
            ? options.scope
            : undefined,
        );
    output.stdout(
      options.json
        ? `${JSON.stringify({ schema: 'pappra/docs-metadata-result/1', action: options.action, ...result })}\n`
        : `${options.action}: ${result.ok ? 'applied' : result.status}\n`,
    );
    if (!options.json) printDiagnostics(output, result.diagnostics);
    return result.ok ? 0 : 1;
  }
  if (options.apply) {
    return invalidArguments(
      output,
      options.json,
      'only docs scan, relocate and forget accept --apply',
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
      if (result.records.length === 0 && !options.includePrivate && result.ok) {
        const command = options.includeArchived
          ? 'pappra docs list --include-private --include-archived'
          : 'pappra docs list --include-private';
        output.stdout(
          `No documents in the default view. Private documents are hidden; run: ${command}\n`,
        );
        if (!options.includeArchived) {
          output.stdout(
            'Archived documents also remain hidden; add --include-archived to include them.\n',
          );
        }
      }
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
