import type { CliOutput } from '../output.js';
import {
  answer,
  clackProgress,
  clackWizardUi,
  type ProgressUi,
  type SelectOption,
  type WizardUi,
} from '../interactive.js';
import { runCodeCommand, type CodeCommandOptions } from './code.js';
import { runResumeCommand, type ResumeCommandOptions } from './continuity.js';
import { runDocsCommand, type DocsCommandOptions } from './docs.js';
import { runDoctorCommand } from './doctor.js';
import { runInitCommand } from './init.js';
import {
  inspectWorkspaceStatus,
  runAgentSetup,
  workspaceStatusSummary,
} from './setup-flow.js';

export interface HomeCommandOptions {
  readonly cwd: string;
}

export interface HomeCommandDeps {
  readonly ui?: WizardUi;
  readonly progress?: ProgressUi;
}

interface CommandDeps {
  readonly ui?: WizardUi;
  readonly progress?: ProgressUi;
}

/**
 * Forwards the injected UI to a command's optional third `deps` parameter, so
 * the menu reuses the command's own interactive behaviour and never prints a
 * "rerun with --apply" instruction a person at a terminal cannot act on.
 */
async function callCommand<Options>(
  command: (
    options: Options,
    output: CliOutput,
    deps?: CommandDeps,
  ) => Promise<number>,
  options: Options,
  output: CliOutput,
  deps: CommandDeps,
): Promise<number> {
  return await command(options, output, deps);
}

const HOME_ACTIONS: readonly SelectOption[] = [
  {
    value: 'resume',
    label: 'Resume a task',
    hint: 'Read a bounded recovery packet without starting an agent',
  },
  {
    value: 'code',
    label: 'Prepare code index',
    hint: 'Register the configured code graph for the repositories',
  },
  {
    value: 'docs',
    label: 'Scan documents',
    hint: 'Register the discovered knowledge documents',
  },
  {
    value: 'agents',
    label: 'Connect coding agents',
    hint: 'Wire Claude Code, Codex or Pi and register MCP',
  },
  {
    value: 'doctor',
    label: 'Health check',
    hint: 'Print the read-only workspace diagnostics',
  },
  {
    value: 'reconfigure',
    label: 'Reconfigure workspace',
    hint: 'Review and rewrite the represented workspace settings',
  },
  {
    value: 'exit',
    label: 'Exit',
    hint: 'Leave the guided menu',
  },
];

async function runHomeAction(
  action: string,
  root: string,
  cwd: string,
  ui: WizardUi,
  progress: ProgressUi,
  output: CliOutput,
): Promise<void> {
  if (action === 'resume') {
    const options: ResumeCommandOptions = {
      cwd,
      json: false,
      taskId: null,
      currentSession: process.env['PI_SESSION_ID'] ?? null,
      interactive: true,
    };
    await callCommand(runResumeCommand, options, output, { ui, progress });
    return;
  }
  if (action === 'code') {
    const options: CodeCommandOptions = {
      cwd,
      json: false,
      action: 'prepare',
      repositoryId: null,
      kind: null,
      query: null,
      maxResults: null,
      maxBytes: null,
      apply: false,
      rebuild: false,
      interactive: true,
    };
    await callCommand(runCodeCommand, options, output, { ui, progress });
    return;
  }
  if (action === 'docs') {
    const options: DocsCommandOptions = {
      cwd,
      action: 'scan',
      argument: null,
      targetPath: null,
      scope: null,
      json: false,
      includePrivate: false,
      includeArchived: false,
      apply: false,
      interactive: true,
    };
    await callCommand(runDocsCommand, options, output, { ui, progress });
    return;
  }
  if (action === 'agents') {
    const result = await runAgentSetup(root, ui, progress, output);
    if (result.manualSteps.length > 0) {
      ui.note(result.manualSteps.join('\n'), 'Still to do in the agent');
    }
    return;
  }
  if (action === 'doctor') {
    await runDoctorCommand({ root, json: false }, output);
    return;
  }
  if (action === 'reconfigure') {
    await runInitCommand(
      {
        cwd,
        configPath: null,
        apply: false,
        json: false,
        reconfigure: true,
      },
      output,
      { ui, progress, interactive: true },
    );
  }
}

/**
 * Entry for a bare `pappra` on a terminal: the guided setup when the directory
 * has no workspace yet, otherwise the workspace status and action menu.
 */
export async function runHomeCommand(
  options: HomeCommandOptions,
  output: CliOutput,
  deps: HomeCommandDeps = {},
): Promise<number> {
  const ui = deps.ui ?? clackWizardUi;
  const progress = deps.progress ?? clackProgress();
  const status = await inspectWorkspaceStatus(options.cwd);
  if (status.state === 'absent') {
    ui.intro('Welcome to Pappra');
    const code = await runInitCommand(
      { cwd: options.cwd, configPath: null, apply: false, json: false },
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
  for (;;) {
    const choice = await answer(
      ui.select('What would you like to do?', HOME_ACTIONS),
    );
    if (choice === null || choice === 'exit') {
      ui.outro('Done.');
      return 0;
    }
    await runHomeAction(choice, status.root, options.cwd, ui, progress, output);
  }
}
