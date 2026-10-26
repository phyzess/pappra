import { readTextFileBounded } from '../../infra/fs.js';
import type { HostName } from '../../schemas/host.js';
import { parseInitChoices, type InitChoices } from '../../schemas/init.js';
import { getPackageInfo } from '../../package-info.js';
import {
  applyOnboard,
  parseHostList,
  planOnboardHost,
  planOnboard,
  type OnboardFailure,
  type OnboardHostPlan,
  type OnboardHostResult,
  type OnboardPlan,
  type OnboardResult,
} from '../../app/onboard.js';
import type { CliOutput } from '../output.js';
import {
  clackProgress,
  clackWizardUi,
  type ProgressUi,
  type WizardUi,
} from '../interactive.js';
import { runInitCommand } from './init.js';
import {
  inspectWorkspaceStatus,
  runSetupFollowUps,
  workspaceStatusSummary,
} from './setup-flow.js';

export const onboardUsage =
  'pappra onboard [--root <dir>] [--config <file>] [--hosts claude,codex,pi]\n' +
  '  [--yes] [--apply-host] [--dry-run] [--print-handoff] [--json]\n\n' +
  'Plans (default) or applies a workspace setup: init files, durable runtime, and with\n' +
  '--apply-host the verified host wiring. Trust prompts are never approved automatically.\n' +
  '--print-handoff lists the files to copy to another machine and the commands to run there.';

export interface OnboardCommandOptions {
  readonly cwd: string;
  readonly root: string | null;
  readonly configPath: string | null;
  readonly hosts: string | null;
  readonly apply: boolean;
  readonly applyHosts: boolean;
  readonly dryRun: boolean;
  readonly printHandoff: boolean;
  readonly json: boolean;
  /** A person at a terminal: plan output may be followed by a prompt. */
  readonly interactive?: boolean;
}

export interface OnboardCommandDeps {
  readonly ui?: WizardUi;
  readonly progress?: ProgressUi;
}

function printDiagnostics(
  output: CliOutput,
  diagnostics: readonly { severity: string; code: string; message: string }[],
): void {
  for (const entry of diagnostics) {
    output.stderr(`  ${entry.severity} ${entry.code}: ${entry.message}\n`);
  }
}

function failureExit(failure: OnboardFailure): number {
  return failure.reason === 'invalid'
    ? 2
    : failure.reason === 'unavailable'
      ? 3
      : 1;
}

function writeFailure(
  output: CliOutput,
  options: OnboardCommandOptions,
  failure: OnboardFailure,
): number {
  if (options.json) {
    output.stdout(
      `${JSON.stringify({
        schema: 'pappra/onboard/1',
        ok: false,
        dryRun: !options.apply,
        reason: failure.reason,
        message: failure.message,
        diagnostics: failure.diagnostics,
      })}\n`,
    );
  } else {
    output.stderr(`pappra onboard: ${failure.message}\n`);
    printDiagnostics(output, failure.diagnostics);
  }
  return failureExit(failure);
}

async function loadChoices(
  path: string,
): Promise<
  | { readonly ok: true; readonly choices: InitChoices }
  | { readonly ok: false; readonly failure: OnboardFailure }
> {
  const read = await readTextFileBounded(path);
  if (!read.ok) {
    return {
      ok: false,
      failure: {
        ok: false,
        reason: 'unavailable',
        message: read.message,
        diagnostics: [],
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
        reason: 'invalid',
        message: `Invalid onboard config JSON: ${error instanceof Error ? error.message : String(error)}`,
        diagnostics: [],
      },
    };
  }
  const parsed = parseInitChoices(raw, path);
  if (parsed.value === null) {
    return {
      ok: false,
      failure: {
        ok: false,
        reason: 'invalid',
        message:
          parsed.diagnostics[0]?.message ??
          'Onboard config does not match pappra/init-choices/1.',
        diagnostics: parsed.diagnostics,
      },
    };
  }
  return { ok: true, choices: parsed.value };
}

function plannedHosts(plan: OnboardPlan): OnboardHostResult[] {
  return plan.hosts.map(planOnboardHost);
}

function observedVersionLabel(host: OnboardHostPlan): string {
  return (
    host.detectedVersion ??
    (host.state === 'missing' ? '(missing)' : '(unknown)')
  );
}

function planReport(plan: OnboardPlan): OnboardResult {
  const nextActions: string[] = ['Rerun with --yes to apply this plan.'];
  if (plan.choices.knowledge.sources.length > 0) {
    nextActions.push('pappra docs scan --apply');
  }
  if (
    plan.choices.code.graph !== 'none' &&
    plan.choices.repositories.length > 0
  ) {
    nextActions.push(
      `pappra code prepare --repo ${plan.bundle.scope.repositories[0]?.id ?? '<repository-id>'} --apply`,
    );
  }
  return {
    schema: 'pappra/onboard/1',
    ok: true,
    dryRun: true,
    workspaceRoot: plan.bundle.scope.workspaceRoot,
    files: plan.bundle.plan.files.map((file) => ({
      path: file.path,
      operation: file.operation,
    })),
    runtime: {
      version: plan.bundle.scope.runtimeVersion,
      status: 'pending',
    },
    initComplete: false,
    hosts: plannedHosts(plan),
    manualSteps: plan.hosts.map(
      (host) =>
        `${host.command}: detected ${observedVersionLabel(host)}, pinned ${host.pinnedVersion} (${host.state})`,
    ),
    nextActions,
    diagnostics: plan.bundle.diagnostics.filter(
      (entry) => entry.severity !== 'info',
    ),
  };
}

function printResult(output: CliOutput, result: OnboardResult): void {
  output.stdout(`Workspace: ${result.workspaceRoot}\n`);
  output.stdout(`Status: ${result.initComplete ? 'complete' : 'planned'}\n`);
  for (const file of result.files) {
    output.stdout(`  ${file.operation} ${file.path}\n`);
  }
  if (result.runtime !== null) {
    output.stdout(
      `Runtime: ${result.runtime.status} ${result.runtime.version}\n`,
    );
  }
  for (const host of result.hosts) {
    output.stdout(
      `Host ${host.host}: detected ${observedVersionLabel(host)} / pinned ${host.pinnedVersion} (${host.state}) -> ${host.action}\n`,
    );
  }
  for (const step of result.manualSteps) {
    output.stdout(`  manual: ${step}\n`);
  }
  for (const action of result.nextActions) {
    output.stdout(`  next: ${action}\n`);
  }
  printDiagnostics(output, result.diagnostics);
}

function printHandoff(
  output: CliOutput,
  options: OnboardCommandOptions,
  root: string,
): number {
  const report = {
    schema: 'pappra/handoff/1',
    workspaceRoot: root,
    share: [
      '.pappra/workspace.json',
      '.pappra-choices.json (or the choices file used for onboard)',
      'repository checkouts at the same relative paths',
    ],
    doNotCopy: [
      '.pappra/local/machine.json',
      '.pappra/local/code/*.json',
      '.pappra/local/knowledge/catalog.json',
      '.pappra/local/host-events/**',
    ],
    commands: [
      `npm install -g @phyzess/pappra@${getPackageInfo().version}`,
      `cd ${root}`,
      'pappra onboard --yes --apply-host',
      'pappra doctor --json',
    ],
  };
  if (options.json) {
    output.stdout(`${JSON.stringify(report)}\n`);
  } else {
    output.stdout('Share:\n');
    for (const entry of report.share) output.stdout(`  ${entry}\n`);
    output.stdout('Do not copy:\n');
    for (const entry of report.doNotCopy) output.stdout(`  ${entry}\n`);
    output.stdout('On the new machine:\n');
    for (const entry of report.commands) output.stdout(`  ${entry}\n`);
  }
  return 0;
}

/**
 * Terminal-only onboarding: a directory without a workspace runs the same
 * guided init as a bare `pappra`; an existing workspace runs the same guided
 * setup steps (code index, documents, coding agents, health check).
 */
async function runGuidedOnboard(
  root: string,
  output: CliOutput,
  ui: WizardUi,
  progress: ProgressUi,
): Promise<number> {
  const status = await inspectWorkspaceStatus(root);
  if (status.state === 'absent') {
    ui.intro('Welcome to Pappra');
    const code = await runInitCommand(
      { cwd: root, configPath: null, apply: false, json: false },
      output,
      { ui, progress, interactive: true, introShown: true },
    );
    if (code === 130) {
      ui.outro('Setup cancelled.');
      return 0;
    }
    return code;
  }
  ui.intro(workspaceStatusSummary(status));
  return await runSetupFollowUps(status.root, ui, progress, output);
}

export async function runOnboardCommand(
  options: OnboardCommandOptions,
  output: CliOutput,
  deps: OnboardCommandDeps = {},
): Promise<number> {
  const root = options.root ?? options.cwd;
  if (options.printHandoff) {
    return printHandoff(output, options, root);
  }
  const guided =
    options.interactive === true &&
    !options.json &&
    !options.apply &&
    !options.dryRun &&
    !options.printHandoff &&
    options.configPath === null &&
    options.hosts === null;
  if (guided) {
    return await runGuidedOnboard(
      root,
      output,
      deps.ui ?? clackWizardUi,
      deps.progress ?? clackProgress(),
    );
  }
  let hosts: HostName[] | null;
  try {
    hosts = parseHostList(options.hosts);
  } catch (error) {
    return writeFailure(output, options, {
      ok: false,
      reason: 'invalid',
      message: error instanceof Error ? error.message : String(error),
      diagnostics: [],
    });
  }
  let choices: InitChoices | null = null;
  if (options.configPath !== null) {
    const loaded = await loadChoices(options.configPath);
    if (!loaded.ok) return writeFailure(output, options, loaded.failure);
    choices = loaded.choices;
  }
  const planned = await planOnboard({ root, choices, hosts });
  if ('reason' in planned) return writeFailure(output, options, planned);
  if (!options.apply || options.dryRun) {
    const report = planReport(planned);
    if (options.json) {
      output.stdout(`${JSON.stringify(report)}\n`);
    } else {
      printResult(output, report);
    }
    return 0;
  }
  const result = await applyOnboard(planned, {
    applyHosts: options.applyHosts,
  });
  if (options.json) {
    output.stdout(`${JSON.stringify(result)}\n`);
  } else {
    printResult(output, result);
  }
  return result.ok ? 0 : 1;
}
