import type { Diagnostic } from '../../schemas/diagnostics.js';
import {
  createDiagnostic,
  formatDiagnostic,
} from '../../schemas/diagnostics.js';
import { diagnosticCodes } from '../../schemas/errors.js';
import {
  docsReviewReportSchema,
  type DocsReviewReport,
  type DocumentFreshnessReport,
} from '../../schemas/document.js';
import {
  KnowledgeService,
  type ApplyReviewResult,
  type PreviewReviewResult,
} from '../../knowledge/index.js';
import { resolveWorkspaceRoot } from '../../workspace/resolve.js';
import type { CliOutput } from '../output.js';

export const docsReviewUsage =
  'pappra docs review <documentId> [--scope private|shared] [--expected-digest <digest>] [--apply] [--json]\n' +
  '  Plan mode (no --apply) is read-only and prunes nothing.\n' +
  '  --expected-digest pins the reviewed bytes; --apply requires it and refuses changed bytes,\n' +
  '  symlinks/special files, unsafe or foreign paths, an ambiguous scope and concurrent drift.\n' +
  '  Applying changes only the observed file digest and the review timestamp of the same\n' +
  '  documentId; every other field and registration is preserved.';

interface ReviewArgs {
  readonly documentId: string;
  readonly scope: 'shared' | 'private' | null;
  readonly expectedDigest: string | null;
  readonly apply: boolean;
  readonly json: boolean;
  readonly help: boolean;
}

type ReviewArgsResult =
  | { readonly ok: true; readonly args: ReviewArgs }
  | { readonly ok: false; readonly message: string; readonly json: boolean };

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const documentIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readOptionValue(
  args: readonly string[],
  index: number,
  name: string,
): { readonly value: string | null; readonly next: number } {
  const token = args[index] ?? '';
  const inline = `${name}=`;
  if (token.startsWith(inline)) {
    return { value: token.slice(inline.length), next: index + 1 };
  }
  const following = args[index + 1];
  return { value: following ?? null, next: index + 2 };
}

/**
 * Parses the tokens that follow `docs review`. A leading `review` token is
 * tolerated so an early router may forward either form.
 */
export function parseDocsReviewArgs(args: readonly string[]): ReviewArgsResult {
  let json = false;
  let help = false;
  let apply = false;
  let scope: 'shared' | 'private' | null = null;
  let expectedDigest: string | null = null;
  let documentId: string | null = null;
  const tokens = args[0] === 'review' ? args.slice(1) : [...args];
  const usage = docsReviewUsage;
  // --json is honoured even when an earlier token is invalid.
  if (tokens.includes('--json')) json = true;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token === '--json') {
      continue;
    }
    if (token === '--apply') {
      apply = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      help = true;
      continue;
    }
    if (token === '--scope' || token.startsWith('--scope=')) {
      const option = readOptionValue(tokens, index, '--scope');
      if (option.value !== 'private' && option.value !== 'shared') {
        return {
          ok: false,
          json,
          message: 'docs review --scope accepts only private or shared.',
        };
      }
      if (scope !== null) {
        return {
          ok: false,
          json,
          message: 'docs review accepts --scope once.',
        };
      }
      scope = option.value;
      index = option.next - 1;
      continue;
    }
    if (
      token === '--expected-digest' ||
      token.startsWith('--expected-digest=')
    ) {
      const option = readOptionValue(tokens, index, '--expected-digest');
      if (option.value === null || !digestPattern.test(option.value)) {
        return {
          ok: false,
          json,
          message:
            'docs review --expected-digest requires a sha256:<64 hex> digest of the reviewed bytes.',
        };
      }
      if (expectedDigest !== null) {
        return {
          ok: false,
          json,
          message: 'docs review accepts --expected-digest once.',
        };
      }
      expectedDigest = option.value;
      index = option.next - 1;
      continue;
    }
    if (token.startsWith('-')) {
      return {
        ok: false,
        json,
        message: `docs review does not accept ${token}.\n${usage}`,
      };
    }
    if (documentId !== null) {
      return {
        ok: false,
        json,
        message: `docs review accepts exactly one documentId.\n${usage}`,
      };
    }
    documentId = token;
  }
  if (help) {
    return {
      ok: true,
      args: {
        documentId: documentId ?? '',
        scope,
        expectedDigest,
        apply,
        json,
        help,
      },
    };
  }
  if (documentId === null) {
    return {
      ok: false,
      json,
      message: `docs review requires a documentId.\n${usage}`,
    };
  }
  if (!documentIdPattern.test(documentId)) {
    return {
      ok: false,
      json,
      message: 'docs review requires a documentId in UUID form.',
    };
  }
  return {
    ok: true,
    args: { documentId, scope, expectedDigest, apply, json, help },
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

function freshnessReport(
  preview: PreviewReviewResult,
): DocumentFreshnessReport | null {
  if (preview.freshness === null) return null;
  return {
    freshness: preview.freshness.freshness,
    reasons: preview.freshness.reasons.map((reason) => ({
      code: reason.code,
      message: reason.message,
    })),
    sourceChecks: preview.freshness.sourceChecks.map((check) => ({
      kind: check.kind,
      ref: check.ref,
      status: check.status,
      message: check.message,
    })),
    coverage: {
      sources: preview.freshness.coverage.sources,
      pathReferences: preview.freshness.coverage.pathReferences,
      repositoryContent: preview.freshness.coverage.repositoryContent,
    },
  };
}

interface EmittedReport {
  readonly report: DocsReviewReport;
  readonly diagnostics: readonly Diagnostic[];
}

function staledReport(
  preview: PreviewReviewResult,
  message: string,
  hint: string,
): EmittedReport {
  const stale = createDiagnostic({
    code: diagnosticCodes.document_proposal_stale,
    severity: 'error',
    message,
    source: preview.plan?.location.path ?? 'docs review',
    hint,
  });
  const diagnostics = [...preview.diagnostics, stale];
  return {
    report: {
      schema: 'pappra/docs-review/1',
      ok: false,
      status: 'stale',
      applied: false,
      plan: preview.plan,
      document: preview.record,
      freshness: freshnessReport(preview),
      diagnostics,
      journalPath: null,
    },
    diagnostics,
  };
}

function planReport(preview: PreviewReviewResult): EmittedReport {
  return {
    report: {
      schema: 'pappra/docs-review/1',
      ok: preview.ok,
      status: preview.status,
      applied: false,
      plan: preview.plan,
      document: preview.record,
      freshness: freshnessReport(preview),
      diagnostics: [...preview.diagnostics],
      journalPath: null,
    },
    diagnostics: preview.diagnostics,
  };
}

function appliedReport(
  preview: PreviewReviewResult,
  applied: ApplyReviewResult,
): EmittedReport {
  return {
    report: {
      schema: 'pappra/docs-review/1',
      ok: applied.ok,
      status: applied.status,
      applied: true,
      plan: preview.plan,
      document: applied.record,
      freshness: freshnessReport(preview),
      diagnostics: [...applied.diagnostics],
      journalPath: applied.journalPath,
    },
    diagnostics: applied.diagnostics,
  };
}

function emit(
  output: CliOutput,
  args: ReviewArgs,
  emitted: EmittedReport,
): number {
  const { report, diagnostics } = emitted;
  if (args.json) {
    const parsed = docsReviewReportSchema.safeParse(report);
    if (!parsed.success) {
      return invalidArguments(
        output,
        true,
        `docs review report is invalid: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`,
      );
    }
    output.stdout(`${JSON.stringify(parsed.data)}\n`);
  } else {
    printReport(output, args, report, diagnostics);
  }
  return report.ok ? 0 : 1;
}

function printDiagnostics(
  output: CliOutput,
  diagnostics: readonly Diagnostic[],
): void {
  for (const diagnostic of diagnostics) {
    output.stderr(`${formatDiagnostic(diagnostic)}\n`);
  }
}

function printReport(
  output: CliOutput,
  args: ReviewArgs,
  report: DocsReviewReport,
  diagnostics: readonly Diagnostic[],
): void {
  const plan = report.plan;
  const location =
    report.document === null
      ? null
      : report.document.location.kind === 'workspace'
        ? report.document.location.path
        : `${report.document.location.sourceId}:${report.document.location.path}`;
  if (plan !== null && location !== null) {
    output.stdout(
      `${plan.documentId}  ${report.ok ? 'ok' : 'blocked'}  ${report.status}  scope=${plan.scope}\n`,
    );
    output.stdout(`location: ${location}\n`);
    output.stdout(`reviewed bytes: ${plan.expectedFileDigest}\n`);
    output.stdout(`registered bytes: ${plan.recordDigest}\n`);
    output.stdout(`reviewed at: ${plan.reviewedAt}\n`);
    for (const reason of report.freshness?.reasons ?? []) {
      output.stdout(`  ${reason.code}: ${reason.message}\n`);
    }
    if (!report.applied) {
      output.stdout(
        plan.expectedFileDigest === plan.recordDigest
          ? 'Bytes already match the registered digest; applying records only the review timestamp.\n'
          : 'No file or catalog was changed. Record the digest above, then rerun with --apply --expected-digest to accept these bytes.\n',
      );
    }
  } else {
    output.stdout(`docs review ${args.documentId}: ${report.status}\n`);
  }
  printDiagnostics(output, diagnostics);
}

export async function runDocsReviewCli(
  args: readonly string[],
  output: CliOutput,
  context: { readonly cwd?: string } = {},
): Promise<number> {
  const parsed = parseDocsReviewArgs(args);
  if (!parsed.ok) return invalidArguments(output, parsed.json, parsed.message);
  const options = parsed.args;
  if (options.help) {
    if (options.json) {
      output.stdout(
        `${JSON.stringify({ commands: ['docs'], usage: docsReviewUsage })}\n`,
      );
    } else {
      output.stdout(`${docsReviewUsage}\n`);
    }
    return 0;
  }
  const cwd = context.cwd ?? process.cwd();
  const resolution = await resolveWorkspaceRoot({ startPath: cwd });
  const service = new KnowledgeService(resolution.root ?? cwd);
  const preview = await service.previewReview({
    documentId: options.documentId,
    ...(options.scope === null ? {} : { scope: options.scope }),
  });
  if (preview.plan === null) {
    return emit(output, options, planReport(preview));
  }
  if (!options.apply) {
    return emit(output, options, planReport(preview));
  }
  if (options.expectedDigest === null) {
    return invalidArguments(
      output,
      options.json,
      'docs review --apply requires --expected-digest of the reviewed bytes.',
    );
  }
  if (options.expectedDigest !== preview.plan.expectedFileDigest) {
    return emit(
      output,
      options,
      staledReport(
        preview,
        `Reviewed digest ${options.expectedDigest} does not match the bytes on disk (${preview.plan.expectedFileDigest}).`,
        'Read the current bytes and pin the digest you actually reviewed; nothing was applied.',
      ),
    );
  }
  const applied = await service.applyReview({
    plan: preview.plan,
    expectedFileDigest: options.expectedDigest,
  });
  return emit(output, options, appliedReport(preview, applied));
}
