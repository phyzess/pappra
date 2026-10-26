import { CodeIntelligenceService } from '../../code/service.js';
import { planHostMcp, applyHostMcp } from '../../app/host-mcp.js';
import {
  detectHosts,
  wireHost,
  type OnboardHostPlan,
  type OnboardHostResult,
} from '../../app/onboard.js';
import { runDoctor } from '../../app/doctor.js';
import { scanDiscoveredDocuments } from '../../knowledge/scan.js';
import { getPackageInfo } from '../../package-info.js';
import {
  formatDiagnostic,
  type Diagnostic,
} from '../../schemas/diagnostics.js';
import type { HostName } from '../../schemas/host.js';
import type { RuntimeLocation } from '../../schemas/machine.js';
import type { WorkspaceConfig } from '../../schemas/workspace.js';
import {
  inspectMachineConfig,
  inspectWorkspaceConfig,
} from '../../workspace/config.js';
import { resolveWorkspaceRoot } from '../../workspace/resolve.js';
import type { CliOutput } from '../output.js';
import {
  answer,
  confirmApply,
  type ProgressUi,
  type SelectOption,
  type WizardUi,
} from '../interactive.js';

const HOST_LABEL: Record<HostName, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
};

function isHostName(value: string): value is HostName {
  return value === 'claude' || value === 'codex' || value === 'pi';
}

export interface AgentSetupResult {
  readonly failed: boolean;
  /** Steps a person must still perform in the agent itself (trust, reload). */
  readonly manualSteps: readonly string[];
}

export type WorkspaceStatus =
  | {
      readonly state: 'ready';
      readonly root: string;
      readonly config: WorkspaceConfig;
      readonly runtime: RuntimeLocation | null;
    }
  | { readonly state: 'absent'; readonly root: string | null };

/** Resolves the workspace from a start path and reads its local runtime binding. */
export async function inspectWorkspaceStatus(
  startPath: string,
): Promise<WorkspaceStatus> {
  const resolution = await resolveWorkspaceRoot({ startPath });
  if (resolution.root === null) return { state: 'absent', root: null };
  const root = resolution.root;
  const config = (await inspectWorkspaceConfig(root)).value;
  if (config === null) return { state: 'absent', root };
  const machine = (await inspectMachineConfig(root)).value;
  return { state: 'ready', root, config, runtime: machine?.runtime ?? null };
}

/** Short workspace status for a guided intro: root, repositories and runtime. */
export function workspaceStatusSummary(status: {
  readonly root: string;
  readonly config: WorkspaceConfig;
  readonly runtime: RuntimeLocation | null;
}): string {
  const repositories =
    status.config.repositories.length === 0
      ? 'none'
      : status.config.repositories
          .map((repository) => `${repository.id} (${repository.path})`)
          .join(', ');
  return [
    `Workspace: ${status.config.name}`,
    `Root: ${status.root}`,
    `Repositories: ${repositories}`,
    `Runtime: ${status.runtime === null ? 'not bound' : status.runtime.version}`,
  ].join('\n');
}

function reportDiagnostics(
  output: CliOutput,
  diagnostics: readonly Diagnostic[],
): void {
  for (const diagnostic of diagnostics) {
    output.stderr(`  ${formatDiagnostic(diagnostic)}\n`);
  }
}

function hostHint(host: OnboardHostPlan): string {
  switch (host.state) {
    case 'verified':
      return `verified ${host.detectedVersion ?? ''}`.trim();
    case 'unverified':
      return 'installed, version not verified';
    case 'unsupported':
      return `${host.detectedVersion ?? 'unknown version'} is outside the supported matrix`;
    case 'missing':
      return 'not installed';
  }
}

async function runCodePreparation(
  root: string,
  config: WorkspaceConfig,
  ui: WizardUi,
  progress: ProgressUi,
  output: CliOutput,
): Promise<boolean> {
  if (config.code.graph === 'none' || config.repositories.length === 0) {
    return false;
  }
  const asked =
    config.repositories.length === 1
      ? `Prepare the ${config.code.graph} index for ${config.repositories[0]!.id}?`
      : `Prepare the ${config.code.graph} index for ${config.repositories.length} repositories?`;
  if (!(await confirmApply(ui, asked, true))) return false;
  const service = new CodeIntelligenceService(root);
  let failed = false;
  for (const repository of config.repositories) {
    progress.start(`Preparing the code index for ${repository.id}...`);
    const result = await service.prepare({
      root,
      repositoryId: repository.id,
      apply: true,
      rebuild: false,
    });
    progress.stop(`Code index ${repository.id}: ${result.health.state}`);
    if (!result.ok) {
      failed = true;
      output.stderr(
        `pappra setup: the code index for ${repository.id} is ${result.status}.\n`,
      );
      reportDiagnostics(output, result.diagnostics as readonly Diagnostic[]);
    }
  }
  return failed;
}

async function runKnowledgeRegistration(
  root: string,
  config: WorkspaceConfig,
  ui: WizardUi,
  progress: ProgressUi,
  output: CliOutput,
): Promise<boolean> {
  if (config.knowledge.sources.length === 0) return false;
  if (
    !(await confirmApply(
      ui,
      'Register the knowledge documents discovered in this workspace?',
      true,
    ))
  ) {
    return false;
  }
  progress.start('Scanning knowledge documents...');
  const result = await scanDiscoveredDocuments(root, { apply: true });
  progress.stop('Knowledge scan finished');
  if ('message' in result) {
    output.stderr(`pappra setup: ${result.message}\n`);
    return true;
  }
  reportDiagnostics(output, result.diagnostics);
  if (!result.ok) {
    output.stderr(
      'pappra setup: some knowledge documents could not be registered.\n',
    );
    return true;
  }
  output.stdout(
    `Registered ${result.registered.length} knowledge document${
      result.registered.length === 1 ? '' : 's'
    }.\n`,
  );
  return false;
}

/** Offers MCP registration for the agents that were just wired. */
async function registerMcpServers(
  root: string,
  wired: readonly OnboardHostResult[],
  ui: WizardUi,
  progress: ProgressUi,
  output: CliOutput,
): Promise<boolean> {
  const connected = wired.filter(
    (result) => result.action === 'installed' || result.action === 'unchanged',
  );
  if (connected.length === 0) return false;
  const names = connected.map((result) => HOST_LABEL[result.host]).join(', ');
  if (
    !(await confirmApply(
      ui,
      `Register the Pappra MCP server for ${names}?`,
      true,
    ))
  ) {
    return false;
  }
  let failed = false;
  for (const result of connected) {
    const label = HOST_LABEL[result.host];
    const plan = await planHostMcp(result.host, root);
    if (plan.state === 'unchanged') {
      output.stdout(`${label} MCP: already registered.\n`);
      continue;
    }
    if (plan.state === 'conflict') {
      failed = true;
      output.stderr(`${label} MCP: ${plan.message}\n`);
      continue;
    }
    if (plan.state === 'manual' && plan.command === null) {
      output.stdout(`${label} MCP: ${plan.message}\n`);
      continue;
    }
    progress.start(`Registering the Pappra MCP server for ${label}...`);
    const applied = await applyHostMcp(plan, { force: false });
    progress.stop(
      `${label} MCP: ${applied.verified ? 'verified' : 'not verified'}`,
    );
    if (!applied.applied || !applied.verified) {
      failed = true;
      output.stderr(`${label} MCP: ${applied.detail ?? plan.message}\n`);
    }
  }
  return failed;
}

/**
 * Detects the coding agents on PATH and wires the ones a person chooses. The
 * selected hosts are wired exactly like `onboard --apply-host`; MCP
 * registration is offered through the shared host MCP plan/apply functions.
 */
export async function runAgentSetup(
  root: string,
  ui: WizardUi,
  progress: ProgressUi,
  output: CliOutput,
): Promise<AgentSetupResult> {
  const hosts = detectHosts(process.env['PATH'] ?? '', null);
  const verified = hosts.filter((host) => host.state === 'verified');
  if (verified.length === 0) {
    output.stdout(
      'No supported coding agent was detected on PATH; agent wiring was skipped.\n',
    );
    return { failed: false, manualSteps: [] };
  }
  if (
    !(await confirmApply(
      ui,
      'Connect the coding agents detected on this machine?',
      true,
    ))
  ) {
    return { failed: false, manualSteps: [] };
  }
  const options: SelectOption[] = hosts.map((host) => ({
    value: host.host,
    label: HOST_LABEL[host.host],
    hint: hostHint(host),
  }));
  const selected = await answer(
    ui.multiselect(
      'Select the coding agents to connect',
      options,
      verified.map((host) => host.host),
    ),
  );
  if (selected === null) return { failed: false, manualSteps: [] };

  const packageVersion = getPackageInfo().version;
  const wired: OnboardHostResult[] = [];
  let failed = false;
  for (const name of selected) {
    if (!isHostName(name)) continue;
    const plan = hosts.find((host) => host.host === name);
    if (plan === undefined) continue;
    const label = HOST_LABEL[name];
    progress.start(`Wiring ${label}...`);
    const result = await wireHost(plan, root, packageVersion);
    progress.stop(`${label}: ${result.action}`);
    wired.push(result);
    if (result.action === 'failed') {
      failed = true;
      output.stderr(`pappra setup: wiring ${label} failed.\n`);
    }
    if (result.action === 'skipped') {
      for (const action of result.nextActions) {
        output.stdout(`${label}: ${action}\n`);
      }
    }
  }

  if (await registerMcpServers(root, wired, ui, progress, output)) {
    failed = true;
  }
  const manualSteps = wired
    .filter(
      (result) =>
        result.action === 'installed' || result.action === 'unchanged',
    )
    .flatMap((result) =>
      result.nextActions.map(
        (action) => `${HOST_LABEL[result.host]}: ${action}`,
      ),
    );
  return { failed, manualSteps };
}

async function runHealthCheck(
  root: string,
  output: CliOutput,
): Promise<boolean> {
  try {
    const report = await runDoctor({ root });
    const counts = report.summary.counts;
    output.stdout(
      `Health: ${report.summary.status} (${counts.ok} ok, ${counts.error} error, ${counts.warning} warning)\n`,
    );
    for (const check of report.checks) {
      if (check.status === 'error') {
        output.stdout(`  ${check.id}: ${check.summary}\n`);
      }
    }
    return false;
  } catch (error) {
    output.stderr(
      `pappra setup: the health check could not run: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return true;
  }
}

/**
 * Guided work that follows a successful interactive init apply: prepare the
 * declared code indexes, register discovered knowledge documents, connect the
 * chosen coding agents, then report health and the manual steps that remain.
 * Each step reports its own failure and the next step still runs.
 */
export async function runSetupFollowUps(
  root: string,
  ui: WizardUi,
  progress: ProgressUi,
  output: CliOutput,
): Promise<number> {
  const inspection = await inspectWorkspaceConfig(root);
  const config = inspection.value;
  if (config === null) {
    output.stderr(
      'pappra setup: the workspace configuration is not readable; run pappra doctor.\n',
    );
    reportDiagnostics(output, inspection.diagnostics);
    return 1;
  }
  let failed = await runCodePreparation(root, config, ui, progress, output);
  if (await runKnowledgeRegistration(root, config, ui, progress, output)) {
    failed = true;
  }
  const agents = await runAgentSetup(root, ui, progress, output);
  if (agents.failed) failed = true;
  if (await runHealthCheck(root, output)) failed = true;
  const manualSteps = [...new Set(agents.manualSteps)];
  ui.outro(
    manualSteps.length === 0
      ? 'Setup complete.'
      : `Setup complete. Still to do in the agent:\n${manualSteps.join('\n')}`,
  );
  return failed ? 1 : 0;
}
