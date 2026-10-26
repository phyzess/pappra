import type { Diagnostic } from '../../schemas/diagnostics.js';
import { formatDiagnostic } from '../../schemas/diagnostics.js';
import type { CodeQueryKind } from '../../schemas/code.js';
import { CodeIntelligenceService } from '../../code/service.js';
import { resolveWorkspaceRoot } from '../../workspace/resolve.js';
import type { CliOutput } from '../output.js';
import {
  clackProgress,
  clackWizardUi,
  confirmApply,
  pickOne,
  type ProgressUi,
  type WizardUi,
} from '../interactive.js';
import { workspaceRepositoryOptions } from '../pickers.js';

export const codeUsage =
  'pappra code status --repo <id> [--json]\n' +
  'pappra code prepare --repo <id> [--apply] [--rebuild] [--json]\n' +
  'pappra code query --repo <id> --kind explore|symbol|references|impact|text --query <text>\n' +
  '  [--limit <1-100>] [--max-bytes <bytes>] [--json]';

export interface CodeCommandOptions {
  readonly cwd: string;
  readonly json: boolean;
  readonly action: 'status' | 'prepare' | 'query' | null;
  readonly repositoryId: string | null;
  readonly kind: CodeQueryKind | null;
  readonly query: string | null;
  readonly maxResults: number | null;
  readonly maxBytes: number | null;
  readonly apply: boolean;
  readonly rebuild: boolean;
  /** A person at a terminal: plan output may be followed by a prompt. */
  readonly interactive?: boolean;
}

/** Injected terminal surfaces; the defaults are the clack implementations. */
export interface CodeCommandDeps {
  readonly ui?: WizardUi;
  readonly progress?: ProgressUi;
}

function printDiagnostics(
  output: CliOutput,
  diagnostics: readonly Diagnostic[],
): void {
  for (const diagnostic of diagnostics) {
    output.stderr(`${formatDiagnostic(diagnostic)}\n`);
  }
}

async function serviceRoot(cwd: string): Promise<string> {
  const resolution = await resolveWorkspaceRoot({ startPath: cwd });
  return resolution.root ?? cwd;
}

function statusJson(
  result: Awaited<ReturnType<CodeIntelligenceService['status']>>,
) {
  return {
    schema: 'pappra/code-status-result/1',
    ok: result.ok,
    identity: result.identity,
    health: result.health,
    registrationPath: result.registrationPath,
    registrationPresent: result.registrationPresent,
    diagnostics: result.diagnostics,
  };
}

export async function runCodeCommand(
  options: CodeCommandOptions,
  output: CliOutput,
  deps: CodeCommandDeps = {},
): Promise<number> {
  if (options.action === null) {
    output.stderr('pappra: code requires status, prepare, or query.\n');
    return 2;
  }
  let repositoryId = options.repositoryId;
  if (repositoryId === null) {
    if (
      options.interactive !== true ||
      options.json === true ||
      options.action === 'query'
    ) {
      output.stderr('pappra: code requires --repo <id>.\n');
      return 2;
    }
    const candidates = await workspaceRepositoryOptions(
      await serviceRoot(options.cwd),
    );
    if (candidates.length === 0) {
      output.stderr(
        'pappra: no repositories are declared in this workspace; declare one in workspace.json.\n',
      );
      return 1;
    }
    const picked = await pickOne(
      deps.ui ?? clackWizardUi,
      'Pick a repository',
      candidates,
    );
    if (picked === null) {
      output.stdout('Nothing selected; nothing was done.\n');
      return 0;
    }
    repositoryId = picked;
  }
  const root = await serviceRoot(options.cwd);
  const service = new CodeIntelligenceService(root);

  if (options.action === 'status') {
    const result = await service.status({ repositoryId });
    if (options.json) {
      output.stdout(`${JSON.stringify(statusJson(result))}\n`);
    } else {
      output.stdout(`Repository: ${repositoryId}\n`);
      output.stdout(
        `Identity: ${result.identity?.checkoutId ?? 'unavailable'}\n`,
      );
      output.stdout(`Index: ${result.health.state}\n`);
      output.stdout(
        `Registration: ${result.registrationPresent ? 'present' : 'missing'}\n`,
      );
      for (const reason of result.health.reasons)
        output.stdout(`Reason: ${reason}\n`);
      printDiagnostics(output, result.diagnostics);
    }
    return result.ok ? 0 : 1;
  }

  if (options.action === 'prepare') {
    const result = await service.prepare({
      root,
      repositoryId,
      apply: options.apply,
      rebuild: options.rebuild,
    });
    if (options.json) {
      output.stdout(`${JSON.stringify(result)}\n`);
    } else {
      output.stdout(`Prepare plan: ${result.plan.action}\n`);
      output.stdout(`Mutates index: ${result.plan.mutates ? 'yes' : 'no'}\n`);
      output.stdout(`Index: ${result.health.state}\n`);
      if (result.registrationPath !== null) {
        output.stdout(`Registration: ${result.registrationPath}\n`);
      }
      for (const reason of result.plan.reasons)
        output.stdout(`Reason: ${reason}\n`);
      printDiagnostics(output, result.diagnostics as readonly Diagnostic[]);
    }
    if (
      options.interactive === true &&
      options.json !== true &&
      !options.apply &&
      result.ok &&
      result.status === 'planned'
    ) {
      if (!result.plan.mutates) {
        output.stdout('Nothing to prepare; the index is ready.\n');
        return 0;
      }
      const apply = await confirmApply(
        deps.ui ?? clackWizardUi,
        `Prepare the ${repositoryId} code index now?`,
      );
      if (!apply) {
        output.stdout('Nothing was applied.\n');
        return 0;
      }
      const progress = deps.progress ?? clackProgress();
      progress.start(`Indexing ${repositoryId}...`);
      const applied = await service.prepare({
        root,
        repositoryId,
        apply: true,
        rebuild: options.rebuild,
      });
      progress.stop(`Index ${applied.health.state}.`);
      output.stdout(`Index: ${applied.health.state}\n`);
      if (applied.registrationPath !== null) {
        output.stdout(`Registration: ${applied.registrationPath}\n`);
      }
      for (const reason of applied.plan.reasons) {
        output.stdout(`Reason: ${reason}\n`);
      }
      printDiagnostics(output, applied.diagnostics as readonly Diagnostic[]);
      return applied.ok || applied.status === 'planned' ? 0 : 1;
    }
    return result.ok || result.status === 'planned' ? 0 : 1;
  }

  if (options.kind === null || options.query === null) {
    output.stderr('pappra: code query requires --kind and --query.\n');
    return 2;
  }
  const result = await service.query({
    root,
    repositoryId,
    kind: options.kind,
    query: options.query,
    ...(options.maxResults === null && options.maxBytes === null
      ? {}
      : {
          limits: {
            ...(options.maxResults === null
              ? {}
              : { maxResults: options.maxResults }),
            ...(options.maxBytes === null
              ? {}
              : { maxBytes: options.maxBytes }),
          },
        }),
  });
  if (options.json) {
    output.stdout(
      `${JSON.stringify({
        schema: 'pappra/code-query-result/1',
        ok: result.ok,
        health: result.health,
        result: result.result,
        diagnostics: result.diagnostics,
      })}\n`,
    );
  } else if (result.result !== null) {
    output.stdout(`Query: ${result.result.kind} ${result.result.query}\n`);
    output.stdout(`Coverage: ${result.result.coverage}\n`);
    output.stdout(`Provider: ${result.result.provider}\n`);
    for (const item of result.result.items) {
      output.stdout(
        `${item.path}:${item.line ?? '?'}:${item.column ?? '?'} ${item.kind} ${item.name ?? ''}\n`,
      );
      if (item.snippet !== '') output.stdout(`  ${item.snippet}\n`);
    }
    if (result.result.unsupportedReason !== null) {
      output.stdout(`Note: ${result.result.unsupportedReason}\n`);
    }
    printDiagnostics(output, result.diagnostics);
  } else {
    printDiagnostics(output, result.diagnostics);
  }
  return result.ok ? 0 : 1;
}
