import { basename, resolve } from 'node:path';
import * as prompts from '@clack/prompts';
import type { Diagnostic } from '../../schemas/diagnostics.js';
import { diagnosticCodes } from '../../schemas/errors.js';
import {
  INIT_CHOICES_SCHEMA,
  parseInitChoices,
  type InitChoices,
} from '../../schemas/init.js';
import { readTextFileBounded } from '../../infra/fs.js';
import { getPackageInfo } from '../../package-info.js';
import {
  installRuntime,
  type RuntimeInstallResult,
} from '../../install/runtime.js';
import { updateMachineRuntime } from '../../install/apply.js';
import {
  applyInitPlan,
  inspectInitContext,
  listKnowledgeCandidates,
  deriveInitChoices,
  listRepositoryCandidates,
  planWorkspaceInit,
  type InitApplyResult,
  type InitContext,
  type InitFailure,
  type InitPlanBundle,
} from '../../app/init.js';
import type { CliOutput } from '../output.js';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

export interface WizardUi {
  intro(message: string): void;
  outro(message: string): void;
  note(message: string, title: string): void;
  text(message: string, initialValue?: string): Promise<string | symbol>;
  select(
    message: string,
    options: readonly SelectOption[],
    initialValue?: string,
  ): Promise<string | symbol>;
  multiselect(
    message: string,
    options: readonly SelectOption[],
    initialValues?: readonly string[],
  ): Promise<readonly string[] | symbol>;
  confirm(message: string, initialValue?: boolean): Promise<boolean | symbol>;
  cancel(message: string): void;
}

export const clackWizardUi: WizardUi = {
  intro: (message) => prompts.intro(message),
  outro: (message) => prompts.outro(message),
  note: (message, title) => prompts.note(message, title),
  text: async (message, initialValue) =>
    prompts.text({
      message,
      ...(initialValue === undefined ? {} : { defaultValue: initialValue }),
    }),
  select: async (message, options, initialValue) =>
    prompts.select<string>({
      message,
      options: options.map((option) => ({ ...option })),
      ...(initialValue === undefined ? {} : { initialValue }),
    }),
  multiselect: async (message, options, initialValues) =>
    prompts.multiselect<string>({
      message,
      options: options.map((option) => ({ ...option })),
      required: false,
      ...(initialValues === undefined
        ? {}
        : { initialValues: [...initialValues] }),
    }),
  confirm: async (message, initialValue) =>
    prompts.confirm({
      message,
      ...(initialValue === undefined ? {} : { initialValue }),
    }),
  cancel: (message) => prompts.cancel(message),
};

async function promptValue<T>(
  promise: Promise<T | symbol>,
  ui: WizardUi,
): Promise<T | null> {
  const value = await promise;
  if (typeof value === 'symbol') {
    ui.cancel('Init cancelled; no files were written.');
    return null;
  }
  return value;
}

function existingChoices(
  config: InitContext['workspaceInspection']['value'],
  hosts: readonly string[],
): InitChoices | null {
  if (config === null) return null;
  return {
    schema: INIT_CHOICES_SCHEMA,
    name: config.name,
    workspaceId: config.workspaceId,
    repositories: config.repositories.map((repository) => ({
      path: repository.path,
      id: repository.id,
      access: repository.access,
    })),
    knowledge: config.knowledge,
    code: config.code,
    validation: [],
    excludes: config.excludes,
    hosts: [...new Set(hosts)] as InitChoices['hosts'],
  };
}

async function askHosts(
  ui: WizardUi,
  initial: readonly string[],
): Promise<readonly string[] | null> {
  return promptValue(
    ui.multiselect(
      'Select hosts to record (P03 records only; no installation or wiring)',
      [
        { value: 'pi', label: 'Pi', hint: 'Not detected or verified in P03' },
        {
          value: 'codex',
          label: 'Codex',
          hint: 'Not detected or verified in P03',
        },
        {
          value: 'claude',
          label: 'Claude',
          hint: 'Not detected or verified in P03',
        },
      ],
      initial,
    ),
    ui,
  );
}

/**
 * UI-only selection collection. All validation and plan generation remains in
 * the app service; cancelling this function never writes to the workspace.
 */
export async function collectInitChoices(
  context: InitContext,
  ui: WizardUi,
): Promise<InitChoices | null> {
  ui.intro('Pappra workspace init');
  const existingConfig = context.workspaceInspection.value;
  const existingMachine = context.machineInspection.value;
  if (existingConfig !== null) {
    const hosts = existingMachine?.selectedHosts ?? (await askHosts(ui, []));
    if (hosts === null) return null;
    const choices = existingChoices(existingConfig, hosts);
    if (choices !== null) {
      ui.note(
        'Existing valid workspace configuration is reused. Only missing local state is planned; no existing file is overwritten.',
        'Existing configuration',
      );
      ui.outro('Selections complete. Review the plan before applying.');
    }
    return choices;
  }

  const repositoryCandidates = listRepositoryCandidates(context.discovery);
  const selectedRepositoryKeys =
    repositoryCandidates.length === 0
      ? []
      : await promptValue(
          ui.multiselect(
            'Select repositories in this workspace',
            repositoryCandidates.map((candidate) => ({
              value: candidate.key,
              label: `${candidate.key}${candidate.external ? ' (external)' : ''}`,
              hint: `${candidate.kind}; ${candidate.external ? 'explicit external mapping' : 'discovered checkout'}${candidate.dirty === true ? '; dirty' : ''}`,
            })),
            repositoryCandidates.length === 1
              ? [repositoryCandidates[0]!.key]
              : [],
          ),
          ui,
        );
  if (selectedRepositoryKeys === null) return null;

  const repositories: InitChoices['repositories'] = [];
  for (const key of selectedRepositoryKeys) {
    const candidate = repositoryCandidates.find((entry) => entry.key === key);
    if (candidate === undefined) continue;
    const access = await promptValue(
      ui.select(
        `Repository access policy for ${candidate.key}`,
        [
          {
            value: 'read',
            label: 'read',
            hint: 'Default least-privilege policy',
          },
          {
            value: 'write',
            label: 'write',
            hint: 'Policy cap only; host permissions still apply',
          },
        ],
        candidate.access,
      ),
      ui,
    );
    if (access === null) return null;
    repositories.push({
      path: candidate.key,
      access: access as 'read' | 'write',
      ...(candidate.id === null ? {} : { id: candidate.id }),
    });
  }

  const knowledgeCandidates = listKnowledgeCandidates(context.discovery);
  const knowledgeSources =
    knowledgeCandidates.length === 0
      ? []
      : await promptValue(
          ui.multiselect(
            'Select existing rules and documents to register as knowledge sources',
            knowledgeCandidates.map((candidate) => ({
              value: candidate.path,
              label: candidate.path,
              hint: `${candidate.kind}${candidate.origin === null ? '' : `; discovered by ${candidate.origin}`}`,
            })),
            knowledgeCandidates
              .filter((candidate) =>
                ['AGENTS.md', 'CLAUDE.md', 'README.md', 'docs'].includes(
                  candidate.path,
                ),
              )
              .map((candidate) => candidate.path),
          ),
          ui,
        );
  if (knowledgeSources === null) return null;

  const newDocuments = await promptValue(
    ui.text('New knowledge directory', '.pappra/knowledge'),
    ui,
  );
  if (newDocuments === null) return null;
  const taskVisibility = await promptValue(
    ui.select(
      'Task document visibility',
      [
        {
          value: 'private',
          label: 'private',
          hint: 'Checkpoints and raw evidence remain private by default',
        },
        {
          value: 'shared',
          label: 'shared',
          hint: 'Task documents may be committed according to workspace policy',
        },
      ],
      'private',
    ),
    ui,
  );
  if (taskVisibility === null) return null;

  const graph = await promptValue(
    ui.select(
      'Code graph preference',
      [
        { value: 'none', label: 'none', hint: 'No graph provider' },
        {
          value: 'codegraph',
          label: 'codegraph',
          hint: 'Preference only; P03 does not install or index CodeGraph',
        },
      ],
      'none',
    ),
    ui,
  );
  if (graph === null) return null;
  const symbols = await promptValue(
    ui.select(
      'Symbol provider preference',
      [
        { value: 'auto', label: 'auto', hint: 'Use available existing tools' },
        {
          value: 'serena',
          label: 'serena',
          hint: 'Preference only; no installation is performed',
        },
        { value: 'none', label: 'none' },
      ],
      'auto',
    ),
    ui,
  );
  if (symbols === null) return null;
  const prepare = await promptValue(
    ui.select(
      'Index preparation preference',
      [
        {
          value: 'on-demand',
          label: 'on-demand',
          hint: 'Prepare only when a later authorized operation asks',
        },
        {
          value: 'manual',
          label: 'manual',
          hint: 'Never prepare automatically',
        },
      ],
      'on-demand',
    ),
    ui,
  );
  if (prepare === null) return null;

  const validationCandidates = context.discovery.validationCandidates;
  const selectedValidation =
    validationCandidates.length === 0
      ? []
      : await promptValue(
          ui.multiselect(
            'Select validation command candidates (none are executed or verified)',
            validationCandidates.map((candidate) => ({
              value: candidate.id,
              label: `${candidate.id}`,
              hint: `${candidate.origin}; ${candidate.executable} ${candidate.args.join(' ')}; not verified`,
            })),
            [],
          ),
          ui,
        );
  if (selectedValidation === null) return null;

  const hosts = await askHosts(ui, []);
  if (hosts === null) return null;
  const excludesText = await promptValue(
    ui.text(
      'Additional workspace-relative exclude prefixes (comma separated)',
      '',
    ),
    ui,
  );
  if (excludesText === null) return null;
  const name = await promptValue(
    ui.text('Workspace name', basename(context.root) || 'workspace'),
    ui,
  );
  if (name === null) return null;

  ui.note(
    'Validation candidates and hosts are declarations only. P03 does not resolve PATH, install providers, prepare indexes, or wire global configuration.',
    'Limits',
  );
  ui.outro('Selections complete. Review the plan before applying.');
  return {
    schema: INIT_CHOICES_SCHEMA,
    name,
    repositories,
    knowledge: {
      sources: [...knowledgeSources],
      newDocuments,
      taskVisibility: taskVisibility as 'private' | 'shared',
    },
    code: {
      graph: graph as 'codegraph' | 'none',
      symbols: symbols as 'serena' | 'auto' | 'none',
      prepare: prepare as 'on-demand' | 'manual',
    },
    validation: [...selectedValidation],
    excludes: excludesText
      .split(/[,\n]/)
      .map((value) => value.trim())
      .filter((value) => value !== ''),
    hosts: [...new Set(hosts)] as InitChoices['hosts'],
  };
}

export interface InitCommandOptions {
  readonly cwd: string;
  readonly configPath: string | null;
  readonly apply: boolean;
  readonly json: boolean;
  readonly installRuntime?: boolean;
  readonly runtimeTarball?: string | null;
  readonly runtimeVersion?: string | null;
  /** Derives deterministic selections from discovery instead of prompting. */
  readonly yes?: boolean;
  /** Prints the derived selections and writes nothing. */
  readonly printChoices?: boolean;
}

export interface RuntimeFlowResult {
  readonly ok: boolean;
  readonly completion: boolean;
  readonly runtime: RuntimeInstallResult | null;
  readonly diagnostics: readonly Diagnostic[];
}

function runtimeOptionsFailure(
  message: string,
  nextAction: string,
): InitFailure {
  return {
    ok: false,
    status: 'invalid',
    code: diagnosticCodes.initRuntimeSourceRequired,
    message,
    diagnostics: [],
    nextAction,
  };
}

async function installAndRecordRuntime(
  root: string,
  targetVersion: string,
  options: InitCommandOptions,
): Promise<RuntimeFlowResult> {
  const tarball = options.runtimeTarball ?? null;
  const requestedVersion = options.runtimeVersion ?? null;
  if (tarball !== null && requestedVersion !== null) {
    return {
      ok: false,
      completion: false,
      runtime: null,
      diagnostics: [
        {
          code: diagnosticCodes.initRuntimeSourceRequired,
          severity: 'error',
          message:
            'Use either --runtime-tarball or --runtime-version, not both.',
          source: 'init runtime',
          pointer: null,
          hint: 'Choose one explicit runtime source.',
        },
      ],
    };
  }
  if (tarball === null && requestedVersion === null) {
    return {
      ok: false,
      completion: false,
      runtime: null,
      diagnostics: [
        {
          code: diagnosticCodes.initRuntimeSourceRequired,
          severity: 'error',
          message: 'Installing the runtime requires an explicit source.',
          source: 'init runtime',
          pointer: null,
          hint: 'Pass --runtime-tarball <path> or --runtime-version <exact-version>; Pappra does not assume the package is published.',
        },
      ],
    };
  }
  const version = requestedVersion ?? targetVersion;
  if (version !== targetVersion) {
    return {
      ok: false,
      completion: false,
      runtime: null,
      diagnostics: [
        {
          code: diagnosticCodes.initRuntimeSourceRequired,
          severity: 'error',
          message: `Runtime version ${version} does not match workspace target ${targetVersion}.`,
          source: 'init runtime',
          pointer: null,
          hint: 'Use the exact runtimeVersion recorded in the workspace config.',
        },
      ],
    };
  }
  const source =
    tarball === null
      ? ({ kind: 'version' } as const)
      : ({ kind: 'tarball', path: resolve(options.cwd, tarball) } as const);
  const installed = await installRuntime({
    version,
    source,
    packageName: getPackageInfo().name,
    ...(tarball === null ? {} : { offline: false }),
  });
  if (!installed.ok || installed.manifest === null) {
    return {
      ok: false,
      completion: false,
      runtime: installed,
      diagnostics: installed.diagnostics,
    };
  }
  const updated = await updateMachineRuntime(root, installed.manifest);
  if (!updated.ok) {
    return {
      ok: false,
      completion: false,
      runtime: installed,
      diagnostics: updated.diagnostics,
    };
  }
  const followUp = await planWorkspaceInit({ root });
  if (!followUp.ok) {
    return {
      ok: false,
      completion: false,
      runtime: installed,
      diagnostics: followUp.diagnostics,
    };
  }
  if (
    followUp.bundle.plan.files.length > 0 ||
    followUp.bundle.plan.externalActions.length > 0
  ) {
    return {
      ok: false,
      completion: false,
      runtime: installed,
      diagnostics: [
        {
          code: diagnosticCodes.initRuntimeSourceRequired,
          severity: 'error',
          message:
            'Runtime installation succeeded but init still has pending file or external actions.',
          source: 'init runtime',
          pointer: null,
          hint: 'Run pappra init again to review the remaining plan; initialization is not complete.',
        },
      ],
    };
  }
  return {
    ok: true,
    completion: true,
    runtime: installed,
    diagnostics: [],
  };
}

export interface InitCommandDeps {
  readonly ui?: WizardUi;
  readonly interactive?: boolean;
}

function formatFailure(failure: InitFailure): number {
  switch (failure.status) {
    case 'invalid':
      return 2;
    case 'unavailable':
      return 3;
    case 'needs_input':
    case 'conflict':
      return 1;
  }
}

function writeFailure(
  output: CliOutput,
  options: InitCommandOptions,
  failure: InitFailure,
): number {
  if (options.json) {
    output.stdout(
      `${JSON.stringify({
        ok: false,
        command: 'init',
        status: failure.status,
        code: failure.code,
        message: failure.message,
        nextAction: failure.nextAction,
        diagnostics: failure.diagnostics,
        ...(failure.details ?? {}),
      })}\n`,
    );
  } else {
    output.stderr(`pappra init: ${failure.message}\n`);
    for (const diagnostic of failure.diagnostics) {
      output.stderr(
        `  ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}\n`,
      );
    }
    if (failure.nextAction !== null) {
      output.stderr(`  next: ${failure.nextAction}\n`);
    }
  }
  return formatFailure(failure);
}

async function loadChoices(
  configPath: string,
): Promise<
  | { readonly ok: true; readonly choices: InitChoices }
  | { readonly ok: false; readonly failure: InitFailure }
> {
  const read = await readTextFileBounded(configPath);
  if (!read.ok) {
    return {
      ok: false,
      failure: {
        ok: false,
        status: 'unavailable',
        code: read.code,
        message: read.message,
        diagnostics: [],
        nextAction: read.nextAction,
      },
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(read.value.text);
  } catch (error) {
    return {
      ok: false,
      failure: {
        ok: false,
        status: 'invalid',
        code: diagnosticCodes.initInvalidInput,
        message: `Invalid init config JSON: ${error instanceof Error ? error.message : String(error)}`,
        diagnostics: [],
        nextAction: 'Fix the JSON and retry; no target files were written.',
      },
    };
  }
  const parsed = parseInitChoices(raw, configPath);
  if (parsed.value === null) {
    return {
      ok: false,
      failure: {
        ok: false,
        status: 'invalid',
        code: parsed.diagnostics[0]?.code ?? diagnosticCodes.initInvalidInput,
        message:
          parsed.diagnostics[0]?.message ??
          'Init config does not match pappra/init-choices/1.',
        diagnostics: parsed.diagnostics,
        nextAction:
          'Correct the init selections; no target files were written.',
      },
    };
  }
  return { ok: true, choices: parsed.value };
}

function diagnosticLines(diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .map(
      (entry) =>
        `  ${entry.severity} ${entry.code}: ${entry.message}${entry.hint === null ? '' : ` (${entry.hint})`}`,
    )
    .join('\n');
}

function printPlan(output: CliOutput, bundle: InitPlanBundle): void {
  output.stdout(`Pappra init plan ${bundle.plan.planId}\n`);
  output.stdout(`Workspace: ${bundle.plan.workspaceRoot}\n`);
  output.stdout(`Config source: ${bundle.scope.configSource}\n`);
  output.stdout(
    `Repositories: ${bundle.scope.repositories.length === 0 ? '(none)' : bundle.scope.repositories.map((repository) => `${repository.id}:${repository.path}:${repository.access}`).join(', ')}\n`,
  );
  output.stdout(
    `Knowledge sources: ${bundle.scope.knowledge.sources.length === 0 ? '(none)' : bundle.scope.knowledge.sources.join(', ')}\n`,
  );
  output.stdout(
    `Validation candidates: ${bundle.scope.validation.length === 0 ? '(none)' : bundle.scope.validation.map((entry) => entry.id).join(', ')}\n`,
  );
  output.stdout(
    `Hosts: ${bundle.scope.hosts.length === 0 ? '(none)' : bundle.scope.hosts.join(', ')}\n`,
  );
  output.stdout('Files:\n');
  for (const file of bundle.plan.files) {
    output.stdout(
      `  ${file.operation} ${file.path} before=${file.expectedBeforeDigest ?? 'absent'} after=${file.nextDigest}\n`,
    );
  }
  output.stdout('External actions (not executed):\n');
  if (bundle.plan.externalActions.length === 0) {
    output.stdout('  (none)\n');
  } else {
    for (const action of bundle.plan.externalActions) {
      output.stdout(
        `  ${action.kind} ${action.target}${action.version === null ? '' : `@${action.version}`}\n`,
      );
    }
  }
  if (bundle.diagnostics.length > 0) {
    output.stderr(`${diagnosticLines(bundle.diagnostics)}\n`);
  }
  if (bundle.plan.files.length > 0) {
    output.stdout('\nDiff:\n');
    for (const write of bundle.writes) output.stdout(write.diff);
  } else {
    output.stdout('No file changes are planned.\n');
  }
}

function printApply(
  output: CliOutput,
  result: InitApplyResult,
  runtimeRequested: boolean,
): void {
  if (!result.ok) {
    output.stderr(`pappra init apply: ${result.status}\n`);
    output.stderr(`${diagnosticLines(result.diagnostics)}\n`);
    return;
  }
  output.stdout(
    `Applied files: ${result.appliedFiles.length === 0 ? '(none)' : result.appliedFiles.join(', ')}\n`,
  );
  output.stdout(`Status: ${result.status}\n`);
  if (result.residualPaths.length > 0) {
    output.stderr(
      `Residual planned files require manual inspection: ${result.residualPaths.join(', ')}\n`,
    );
  }
  if (result.pendingExternalActions.length > 0) {
    output.stderr('Pending external actions (not executed by P03):\n');
    for (const action of result.pendingExternalActions) {
      output.stderr(
        `  ${action.kind} ${action.target}${action.version === null ? '' : `@${action.version}`}\n`,
      );
    }
    output.stderr(
      runtimeRequested
        ? 'The explicit runtime action is still pending; it will be attempted next.\n'
        : 'Only planned config files were applied. Initialization is not complete until runtime/provider actions are authorized and executed.\n',
    );
  }
}

function planJson(bundle: InitPlanBundle): Record<string, unknown> {
  return {
    command: 'init',
    mode: 'plan',
    plan: bundle.plan,
    scope: bundle.scope,
    diagnostics: bundle.diagnostics,
  };
}

/**
 * CLI command entry. In JSON mode no prompt is ever opened and stdout contains
 * exactly one JSON document. Interactive selection is injected for tests.
 */
export async function runInitCommand(
  options: InitCommandOptions,
  output: CliOutput,
  deps: InitCommandDeps = {},
): Promise<number> {
  const yes = options.yes === true;
  const printChoices = options.printChoices === true;
  const interactive =
    !options.json &&
    !yes &&
    !printChoices &&
    options.configPath === null &&
    (deps.interactive ??
      (process.stdin.isTTY === true && process.stdout.isTTY === true));
  const wantsRuntime = options.installRuntime === true;
  const hasRuntimeSource =
    (options.runtimeTarball !== null && options.runtimeTarball !== undefined) ||
    (options.runtimeVersion !== null && options.runtimeVersion !== undefined);
  if (!wantsRuntime && hasRuntimeSource) {
    return writeFailure(
      output,
      options,
      runtimeOptionsFailure(
        '--runtime-tarball/--runtime-version require --install-runtime.',
        'Remove the runtime source flags or add --install-runtime (and --apply).',
      ),
    );
  }
  if (wantsRuntime && !options.apply) {
    return writeFailure(
      output,
      options,
      runtimeOptionsFailure(
        '--install-runtime requires --apply.',
        'Plan and preview first, then rerun with --apply and an explicit runtime source.',
      ),
    );
  }
  if (wantsRuntime && !hasRuntimeSource) {
    return writeFailure(
      output,
      options,
      runtimeOptionsFailure(
        'Installing the runtime requires an explicit source.',
        'Pass --runtime-tarball <path> or --runtime-version <exact-version>; Pappra does not assume the package is published.',
      ),
    );
  }
  if (
    options.runtimeTarball !== null &&
    options.runtimeTarball !== undefined &&
    options.runtimeVersion !== null &&
    options.runtimeVersion !== undefined
  ) {
    return writeFailure(
      output,
      options,
      runtimeOptionsFailure(
        'Use either --runtime-tarball or --runtime-version, not both.',
        'Choose one explicit runtime source.',
      ),
    );
  }
  if (
    printChoices &&
    (options.configPath !== null ||
      options.apply ||
      wantsRuntime ||
      hasRuntimeSource)
  ) {
    return writeFailure(output, options, {
      ok: false,
      status: 'invalid',
      code: diagnosticCodes.initInvalidInput,
      message:
        '--print-choices cannot be combined with --config, --apply, or runtime flags.',
      diagnostics: [],
      nextAction:
        'Run pappra init --print-choices on its own to print the derived selections.',
    });
  }
  if (yes && options.configPath !== null) {
    return writeFailure(output, options, {
      ok: false,
      status: 'invalid',
      code: diagnosticCodes.initInvalidInput,
      message: 'Use either --config or --yes, not both.',
      diagnostics: [],
      nextAction:
        'Pass explicit selections with --config, or derive them with --yes.',
    });
  }
  const contextResult = await inspectInitContext(options.cwd);
  if (!contextResult.ok) {
    return writeFailure(output, options, contextResult);
  }
  const context = contextResult.context;
  let choices: InitChoices | null = null;

  if (printChoices) {
    const derived = await deriveInitChoices(context.discovery);
    if (options.json) {
      output.stdout(
        `${JSON.stringify({
          ok: true,
          command: 'init',
          mode: 'choices',
          choices: derived.choices,
          rules: derived.rules,
          candidates: derived.candidates,
        })}\n`,
      );
    } else {
      output.stdout(`${JSON.stringify(derived.choices, null, 2)}\n`);
      for (const rule of derived.rules) {
        output.stderr(`  ${rule.field} = ${rule.value} (${rule.reason})\n`);
      }
    }
    return 0;
  }

  if (options.configPath !== null) {
    const loaded = await loadChoices(options.configPath);
    if (!loaded.ok) return writeFailure(output, options, loaded.failure);
    choices = loaded.choices;
  } else if (yes) {
    choices = (await deriveInitChoices(context.discovery)).choices;
  } else {
    const needsChoices =
      context.discovery.configState !== 'valid' ||
      context.discovery.machineState !== 'valid';
    if (needsChoices && !interactive) {
      const derived = await deriveInitChoices(context.discovery);
      return writeFailure(output, options, {
        ok: false,
        status: 'needs_input',
        code: diagnosticCodes.initNoTty,
        message: 'Missing init selections in a non-interactive session.',
        diagnostics: context.diagnostics,
        nextAction:
          'Rerun with --yes to apply the derived selections, provide --config with pappra/init-choices/1, or run in a TTY for the interactive wizard.',
        details: {
          candidates: derived.candidates,
          suggestedChoices: derived.choices,
          rules: derived.rules,
        },
      });
    }
    if (needsChoices && interactive) {
      choices = await collectInitChoices(context, deps.ui ?? clackWizardUi);
      if (choices === null) {
        output.stderr('Init cancelled; no files were written.\n');
        return 130;
      }
    }
  }

  const prepared = await planWorkspaceInit({
    root: context.root,
    choices,
    context,
  });
  if (!prepared.ok) return writeFailure(output, options, prepared);
  const bundle = prepared.bundle;

  if (options.json) {
    if (!options.apply) {
      output.stdout(
        `${JSON.stringify({
          ok: true,
          ...planJson(bundle),
        })}\n`,
      );
      return 0;
    }
    const applied = await applyInitPlan(bundle);
    const runtimeFlow =
      wantsRuntime && applied.ok && applied.residualPaths.length === 0
        ? await installAndRecordRuntime(
            bundle.scope.workspaceRoot,
            bundle.scope.runtimeVersion,
            options,
          )
        : null;
    const initComplete = runtimeFlow?.completion === true;
    const ok =
      applied.ok &&
      applied.residualPaths.length === 0 &&
      (!wantsRuntime || (runtimeFlow?.ok === true && initComplete));
    output.stdout(
      `${JSON.stringify({
        ok,
        command: 'init',
        mode: 'apply',
        plan: bundle.plan,
        scope: bundle.scope,
        apply: applied,
        runtime: runtimeFlow?.runtime ?? null,
        initComplete,
        diagnostics: [
          ...bundle.diagnostics,
          ...(runtimeFlow?.diagnostics ?? []),
        ],
      })}\n`,
    );
    if (!applied.ok || applied.residualPaths.length > 0) return 1;
    if (wantsRuntime) return ok ? 0 : 1;
    return applied.status === 'external-actions-pending' ? 1 : 0;
  }

  printPlan(output, bundle);
  if (!options.apply) {
    if (!interactive || bundle.plan.files.length === 0) {
      output.stdout(
        'Plan only; no files were written. Re-run with --apply to execute the file changes.\n',
      );
      return 0;
    }
    const confirmed = await promptValue(
      (deps.ui ?? clackWizardUi).confirm(
        'Apply this file plan? External actions will remain pending.',
        false,
      ),
      deps.ui ?? clackWizardUi,
    );
    if (confirmed !== true) {
      output.stderr('Init cancelled; no files were written.\n');
      return 130;
    }
  }
  const applied = await applyInitPlan(bundle);
  printApply(output, applied, wantsRuntime);
  if (!applied.ok) {
    return applied.status === 'failed' ? 3 : 1;
  }
  if (applied.residualPaths.length > 0) {
    output.stderr(
      'Managed apply state is not final; runtime actions will not be attempted.\n',
    );
    return 1;
  }
  if (wantsRuntime) {
    const runtimeFlow = await installAndRecordRuntime(
      bundle.scope.workspaceRoot,
      bundle.scope.runtimeVersion,
      options,
    );
    if (runtimeFlow.runtime !== null) {
      output.stdout(
        `Runtime: ${runtimeFlow.runtime.status} ${runtimeFlow.runtime.version}${
          runtimeFlow.runtime.runtimeRoot === null
            ? ''
            : ` at ${runtimeFlow.runtime.runtimeRoot}`
        }\n`,
      );
      if (runtimeFlow.runtime.residualPaths.length > 0) {
        output.stderr(
          `Runtime residual paths: ${runtimeFlow.runtime.residualPaths.join(', ')}\n`,
        );
      }
    }
    if (!runtimeFlow.ok || !runtimeFlow.completion) {
      output.stderr(`${diagnosticLines(runtimeFlow.diagnostics)}\n`);
      output.stderr(
        'Runtime installation or machine binding did not complete. Initialization is not complete.\n',
      );
      return 1;
    }
    output.stdout(
      'Runtime installed and verified. Initialization complete for P04 scope; provider/index preferences were not executed.\n',
    );
    return 0;
  }
  return applied.status === 'external-actions-pending' ? 1 : 0;
}

export const initUsage =
  'pappra init [--config <file>] [--apply] [--json]\n' +
  '             [--install-runtime (--runtime-tarball <file> | --runtime-version <version>)]\n\n' +
  'Without --config, a TTY opens the interactive wizard. --config reads pappra/init-choices/1 JSON.\n' +
  'Planning and preview never write. --apply creates planned files through a managed journal.\n' +
  '--install-runtime installs one explicit exact version or local tarball; provider/index/global\n' +
  'wiring remain separate pending actions.\n';
