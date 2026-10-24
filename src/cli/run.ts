import { parseArgs } from 'node:util';
import { getPackageInfo } from '../package-info.js';
import { initUsage, runInitCommand } from './commands/init.js';
import { onboardUsage, runOnboardCommand } from './commands/onboard.js';
import { mcpUsage, runMcpCommand } from './commands/mcp.js';
import { taskUsage, runTaskCommand } from './commands/task.js';
import { doctorUsage, runDoctorCommand } from './commands/doctor.js';
import { docsUsage, runDocsCommand } from './commands/docs.js';
import {
  checkpointUsage,
  resumeUsage,
  runCheckpointCommand,
  runResumeCommand,
} from './commands/continuity.js';
import { codeUsage, runCodeCommand } from './commands/code.js';
import {
  collaborationCommandLine,
  collaborationUsage,
  runCollaborationCommand,
} from './commands/collaboration.js';
import {
  collaborationMessageUsage,
  runCollaborationMessageCommand,
  type CollaborationMessageAction,
} from './commands/collaboration-message.js';
import {
  collaborationPreflightUsage,
  runCollaborationPreflightCommand,
} from './commands/collaboration-preflight.js';
import {
  collaborationCapabilitiesUsage,
  runCollaborationCapabilitiesCommand,
} from './commands/collaboration-capabilities.js';
import {
  collaborationStateUsage,
  runCollaborationStateCommand,
} from './commands/collaboration-state.js';
import {
  collaborationResourcesUsage,
  runCollaborationResourcesCommand,
} from './commands/collaboration-resources.js';
import {
  collaborationHandoffUsage,
  runCollaborationHandoffCommand,
} from './commands/collaboration-handoff.js';
import {
  collaborationRecoveryUsage,
  runCollaborationRecoveryCommand,
} from './commands/collaboration-recovery.js';
import {
  collaborationRecoveryRunUsage,
  parseCollaborationRecoveryRunArgs,
  runCollaborationRecoveryRunCommand,
} from './commands/collaboration-recovery-run.js';
import {
  collaborationWorkRunUsage,
  parseCollaborationWorkRunArgs,
  runCollaborationWorkRunCommand,
} from './commands/collaboration-work-run.js';
import {
  collaborationBindingUsage,
  runCollaborationBindingCommand,
} from './commands/collaboration-binding.js';
import {
  collaborationPlanUsage,
  runCollaborationPlanCommand,
} from './commands/collaboration-plan.js';
import {
  collaborationRolloverUsage,
  runCollaborationRolloverCommand,
} from './commands/collaboration-rollover.js';
import {
  collaborationBootstrapUsage,
  runCollaborationBootstrapCommand,
} from './commands/collaboration-bootstrap.js';
import {
  collaborationTransitionUsage,
  runCollaborationTransitionCommand,
} from './commands/collaboration-transition.js';
import { hostUsage, runHostCommand } from './commands/host.js';
import { sessionUsage, runSessionCommand } from './commands/session.js';
import {
  collaborationRoleRunUsage,
  runCollaborationRoleRunCommand,
} from './commands/collaboration-role-run.js';
import {
  collaborationRolePlanUsage,
  runCollaborationRolePlanCommand,
} from './commands/collaboration-role-plan.js';
import { runtimeUsage, runRuntimeCommand } from './commands/runtime.js';
import { repairUsage, runRepairCommand } from './commands/repair.js';
import { hostNameSchema } from '../schemas/host.js';
import type { CliOutput } from './output.js';

function parseOptions(args: readonly string[]) {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      json: { type: 'boolean' },
      live: { type: 'boolean' },
      config: { type: 'string' },
      apply: { type: 'boolean' },
      watch: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      'no-runtime': { type: 'boolean' },
      reconfigure: { type: 'boolean' },
      hosts: { type: 'string' },
      'apply-host': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'print-handoff': { type: 'boolean' },
      'auto-resume': { type: 'boolean' },
      from: { type: 'string' },
      tarball: { type: 'string' },
      out: { type: 'string' },
      'bootstrap-config': { type: 'string' },
      'recovery-config': { type: 'string' },
      'transition-extension': { type: 'boolean' },
      mode: { type: 'string' },
      marketplace: { type: 'boolean' },
      scope: { type: 'string' },
      bind: { type: 'boolean' },
      force: { type: 'boolean' },
      'no-interactive': { type: 'boolean' },
      'print-choices': { type: 'boolean' },
      'install-runtime': { type: 'boolean' },
      'runtime-tarball': { type: 'string' },
      'runtime-version': { type: 'string' },
      root: { type: 'string' },
      'task-id': { type: 'string' },
      record: { type: 'string' },
      roots: { type: 'string' },
      'include-private': { type: 'boolean' },
      'include-archived': { type: 'boolean' },
      task: { type: 'string' },
      objective: { type: 'string' },
      acceptance: { type: 'string', multiple: true },
      constraint: { type: 'string', multiple: true },
      decision: { type: 'string', multiple: true },
      attempted: { type: 'string', multiple: true },
      'next-action': { type: 'string', multiple: true },
      limitation: { type: 'string', multiple: true },
      artifact: { type: 'string', multiple: true },
      'collaboration-record': { type: 'string' },
      'context-completeness': { type: 'string' },
      'author-session': { type: 'string' },
      'native-harness': { type: 'string' },
      'native-session': { type: 'string' },
      session: { type: 'string' },
      repo: { type: 'string' },
      kind: { type: 'string' },
      query: { type: 'string' },
      limit: { type: 'string' },
      'max-bytes': { type: 'string' },
      rebuild: { type: 'boolean' },
      host: { type: 'string' },
      'host-root': { type: 'string' },
      'host-version': { type: 'string' },
      goal: { type: 'string' },
      prepared: { type: 'string' },
      capabilities: { type: 'string' },
      controller: { type: 'string' },
      'rpc-request-timeout-ms': { type: 'string' },
      'rpc-operation-timeout-ms': { type: 'string' },
      'domain-root': { type: 'string' },
      'task-root': { type: 'string' },
      message: { type: 'string' },
      'message-id': { type: 'string' },
      binding: { type: 'string' },
      retry: { type: 'boolean' },
      'caller-pane': { type: 'string' },
      assignment: { type: 'string' },
      'max-age-minutes': { type: 'string' },
      harness: { type: 'string' },
      template: { type: 'string' },
      execution: { type: 'string' },
      events: { type: 'string' },
      request: { type: 'string' },
      'owner-epoch': { type: 'string' },
      'subtask-id': { type: 'string' },
      attempt: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help && values.version) {
    throw new Error('Use either --help or --version, not both.');
  }
  const command = positionals[0] ?? null;
  if (command === 'task') {
    if (positionals.length > 3) {
      throw new Error('task accepts one action and an optional task id.');
    }
    return {
      values,
      command,
      docsAction: null,
      docsArgument: null,
      codeAction: null,
      hostAction: null,
      hostSubAction: null,
      collaborationAction: null,
      resumeTaskId: null,
      runtimeAction: null,
      taskAction: positionals[1] ?? null,
      taskArgument: positionals[2] ?? null,
    };
  }
  if (command === 'docs') {
    if (positionals.length > 3) {
      throw new Error(
        'Unknown command; docs accepts one action and one argument.',
      );
    }
    return {
      values,
      codeAction: null,
      command,
      docsAction: positionals[1] ?? null,
      docsArgument: positionals[2] ?? null,
      hostAction: null,
      hostSubAction: null,
      collaborationAction: null,
      resumeTaskId: null,
      runtimeAction: null,
      taskAction: null,
      taskArgument: null,
    };
  }
  if (command === 'resume') {
    if (positionals.length > 2) {
      throw new Error('resume accepts exactly one task id.');
    }
    return {
      values,
      command,
      docsAction: null,
      docsArgument: null,
      codeAction: null,
      hostAction: null,
      hostSubAction: null,
      collaborationAction: null,
      resumeTaskId: positionals[1] ?? null,
      runtimeAction: null,
      taskAction: null,
      taskArgument: null,
    };
  }
  if (command === 'code') {
    if (positionals.length > 2) {
      throw new Error('code accepts one action: status, prepare, or query.');
    }
    return {
      values,
      command,
      docsAction: null,
      docsArgument: null,
      codeAction: positionals[1] ?? null,
      hostAction: null,
      hostSubAction: null,
      collaborationAction: null,
      resumeTaskId: null,
      runtimeAction: null,
      taskAction: null,
      taskArgument: null,
    };
  }
  if (command === 'host') {
    if (positionals.length > 3) {
      throw new Error(
        'host accepts one action and an optional mcp sub-action.',
      );
    }
    return {
      values,
      command,
      docsAction: null,
      docsArgument: null,
      codeAction: null,
      hostAction: positionals[1] ?? null,
      hostSubAction: positionals[2] ?? null,
      collaborationAction: null,
      resumeTaskId: null,
      runtimeAction: null,
      taskAction: null,
      taskArgument: null,
    };
  }
  if (command === 'runtime') {
    if (positionals.length > 2) {
      throw new Error(
        'runtime accepts one action: install, status, verify, or remove.',
      );
    }
    return {
      values,
      command,
      docsAction: null,
      docsArgument: null,
      codeAction: null,
      hostAction: null,
      hostSubAction: null,
      collaborationAction: null,
      resumeTaskId: null,
      runtimeAction: positionals[1] ?? null,
      taskAction: null,
      taskArgument: null,
    };
  }
  if (command === 'collab') {
    // `collab message <action>` is the only two-level form; the action string carries
    // both segments so callers keep one parsed field.
    if (
      positionals.length > 3 ||
      (positionals.length === 3 &&
        positionals[1] !== 'transition' &&
        positionals[1] !== 'bootstrap' &&
        positionals[1] !== 'plan' &&
        positionals[1] !== 'role-plan' &&
        positionals[1] !== 'message' &&
        !(positionals[1] === 'capabilities' && positionals[2] === 'derive') &&
        !(
          (positionals[1] === 'state' ||
            positionals[1] === 'resource' ||
            positionals[1] === 'handoff' ||
            positionals[1] === 'recovery' ||
            positionals[1] === 'binding' ||
            positionals[1] === 'rollover') &&
          positionals[2] !== undefined
        ))
    ) {
      throw new Error(
        'collab accepts prepare, run, work-run, query, preflight, plan, bootstrap, rollover <inspect|plan>, transition <plan|apply>, message <send|list|read|notify>, capabilities derive, state <show|doctor|epoch-check>, resource <list|claim|release>, handoff <inventory|begin|stopped|rebind|transfer|confirm|complete|abort|release-dispatch>, recovery <inspect|reconcile|lock-break>, recovery-run, or binding <list|resolve|bind|unbind>.',
      );
    }
    return {
      values,
      command,
      docsAction: null,
      docsArgument: null,
      codeAction: null,
      hostAction: null,
      hostSubAction: null,
      collaborationAction:
        positionals[1] === undefined ? null : positionals.slice(1).join(':'),
      resumeTaskId: null,
      runtimeAction: null,
      taskAction: null,
      taskArgument: null,
    };
  }
  if (positionals.length > 1) {
    throw new Error('Only one command may be specified.');
  }
  return {
    values,
    command,
    docsAction: null,
    docsArgument: null,
    codeAction: null,
    hostAction: null,
    collaborationAction: null,
    resumeTaskId: null,
    runtimeAction: null,
  };
}

function failure(
  output: CliOutput,
  json: boolean,
  code: string,
  error: unknown,
): void {
  const message =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : 'Operation failed.';
  if (json) {
    output.stdout(`${JSON.stringify({ ok: false, code, message })}\n`);
  } else {
    output.stderr(`pappra: ${message}\n`);
  }
}

function hasContinuityOptions(
  values: ReturnType<typeof parseOptions>['values'],
  includeSession = true,
): boolean {
  return (
    values.task !== undefined ||
    values.objective !== undefined ||
    values.acceptance !== undefined ||
    values.constraint !== undefined ||
    values.decision !== undefined ||
    values.attempted !== undefined ||
    values['next-action'] !== undefined ||
    values.limitation !== undefined ||
    values.artifact !== undefined ||
    values['collaboration-record'] !== undefined ||
    values['context-completeness'] !== undefined ||
    values['author-session'] !== undefined ||
    values['native-harness'] !== undefined ||
    values['native-session'] !== undefined ||
    (includeSession && values.session !== undefined)
  );
}

const globalUsage =
  'pappra [--help | --version] [--json]\n' +
  'pappra task <pin|unpin|show> [taskId] [--auto-resume] [--json]\n' +
  'pappra mcp [--root <dir>] [--help]\n' +
  'pappra onboard [--root <dir>] [--config <file>] [--hosts <list>] [--yes]\n' +
  '               [--apply-host] [--dry-run] [--print-handoff] [--json]\n' +
  'pappra init [--config <file> | --yes] [--apply] [--json] [--print-choices]\n' +
  '              [--install-runtime (--runtime-tarball <file> | --runtime-version <version>)]\n' +
  'pappra doctor [--root <path>] [--json]\n' +
  'pappra repair [--root <path>] [--runtime-version <v>] [--install-id <uuid>] [--apply] [--json]\n' +
  'pappra docs <list|check|archive|scan> [options]\n' +
  'pappra checkpoint --task <id> [options] [--json]\n' +
  'pappra resume <taskId> [--session <id>] [--json]\n' +
  'pappra code <status|prepare|query> --repo <id> [options] [--json]\n' +
  'pappra host <detect|describe|plan|install|verify> --host <name> [options] [--json]\n' +
  'pappra runtime <install|status|verify|remove> [options] [--json]\n' +
  'pappra session <plan|start|status|fence|stop> --config <abs managed-pi.json> [--json]\n' +
  `${collaborationCommandLine}`;

export async function runCli(
  args: readonly string[],
  output: CliOutput,
): Promise<number> {
  const jsonRequested = args.includes('--json');
  if (args[0] === 'repair') {
    try {
      const parsedRepair = parseArgs({
        args: [...args.slice(1)],
        options: {
          root: { type: 'string' },
          'runtime-version': { type: 'string' },
          'install-id': { type: 'string' },
          apply: { type: 'boolean' },
          json: { type: 'boolean' },
          help: { type: 'boolean', short: 'h' },
        },
        allowPositionals: false,
        strict: true,
      });
      if (
        ['--root', '--runtime-version', '--install-id'].some(
          (flag) =>
            args.filter((arg) => arg === flag || arg.startsWith(`${flag}=`))
              .length > 1,
        )
      )
        throw new Error('Repair options must not be repeated.');
      if (parsedRepair.values.help) {
        output.stdout(repairUsage);
        return 0;
      }
      return runRepairCommand(
        {
          root: parsedRepair.values.root ?? process.cwd(),
          ...(parsedRepair.values['runtime-version'] === undefined
            ? {}
            : { runtimeVersion: parsedRepair.values['runtime-version'] }),
          ...(parsedRepair.values['install-id'] === undefined
            ? {}
            : { installId: parsedRepair.values['install-id'] }),
          apply: parsedRepair.values.apply === true,
          json: parsedRepair.values.json === true,
        },
        output,
      );
    } catch (error) {
      failure(output, jsonRequested, 'invalid_arguments', error);
      return 2;
    }
  }
  if (args[0] === 'session') {
    try {
      const parsedSession = parseArgs({
        args: [...args.slice(1)],
        options: {
          config: { type: 'string' },
          json: { type: 'boolean' },
          help: { type: 'boolean', short: 'h' },
        },
        allowPositionals: true,
        strict: true,
      });
      if (parsedSession.values.help) {
        output.stdout(`${sessionUsage}\n`);
        return 0;
      }
      if (
        parsedSession.positionals.length !== 1 ||
        args.filter((arg) => arg === '--config' || arg.startsWith('--config='))
          .length > 1
      )
        throw new Error(sessionUsage);
      return runSessionCommand(
        {
          action: parsedSession.positionals[0]!,
          config: parsedSession.values.config ?? null,
          json: parsedSession.values.json ?? false,
        },
        output,
      );
    } catch (error) {
      failure(output, jsonRequested, 'invalid_arguments', error);
      return 2;
    }
  }
  let parsed: ReturnType<typeof parseOptions>;
  try {
    parsed = parseOptions(args);
  } catch (error) {
    failure(output, jsonRequested, 'invalid_arguments', error);
    return 2;
  }
  const {
    values,
    command,
    docsAction,
    docsArgument,
    codeAction,
    hostAction,
    collaborationAction,
    resumeTaskId,
    runtimeAction,
    hostSubAction,
    taskAction,
    taskArgument,
  } = parsed;
  const json = values.json === true;
  const applyRequested = values.apply === true;

  if (command === 'collab' && collaborationAction === 'role-run') {
    const allowed = new Set(['request', 'apply', 'watch', 'json', 'help']);
    const invalid = Object.entries(values).some(
      ([key, value]) => value !== undefined && !allowed.has(key),
    );
    const duplicates =
      args.filter((arg) => arg === '--request' || arg.startsWith('--request='))
        .length > 1;
    if (invalid || duplicates) {
      failure(output, json, 'invalid_arguments', collaborationRoleRunUsage);
      return 2;
    }
    if (values.help) {
      output.stdout(`${collaborationRoleRunUsage}\n`);
      return 0;
    }
    return runCollaborationRoleRunCommand(
      {
        requestFile: values.request ?? null,
        apply: applyRequested,
        watch: values.watch === true,
        json,
      },
      output,
    );
  }

  if (values.watch !== undefined) {
    failure(
      output,
      json,
      'invalid_arguments',
      '--watch is supported only by collab role-run.',
    );
    return 2;
  }

  if (command === 'collab' && collaborationAction?.startsWith('role-plan')) {
    const allowed = new Set(['request', 'task-root', 'config', 'json', 'help']);
    const extra = Object.entries(values).filter(
      ([key, value]) => value !== undefined && !allowed.has(key),
    );
    const duplicate = ['--request', '--task-root', '--config'].some(
      (flag) =>
        args.filter((arg) => arg === flag || arg.startsWith(`${flag}=`))
          .length > 1,
    );
    if (extra.length || duplicate) {
      failure(output, json, 'invalid_arguments', collaborationRolePlanUsage);
      return 2;
    }
    if (values.help) {
      output.stdout(`${collaborationRolePlanUsage}\n`);
      return 0;
    }
    return runCollaborationRolePlanCommand(
      {
        action: collaborationAction.slice('role-plan:'.length),
        requestFile: values.request ?? null,
        taskRoot: values['task-root'] ?? null,
        planFile: values.config ?? null,
        json,
      },
      output,
    );
  }

  if (
    values.live === true &&
    !(command === 'collab' && collaborationAction === 'capabilities:derive')
  ) {
    failure(
      output,
      json,
      'invalid_arguments',
      '--live is only valid for collab capabilities derive.',
    );
    return 2;
  }

  if (
    command !== 'init' &&
    (values['no-interactive'] === true ||
      values['print-choices'] === true ||
      values['no-runtime'] === true ||
      values.reconfigure === true)
  ) {
    failure(
      output,
      json,
      'invalid_arguments',
      '--no-interactive, --print-choices, --no-runtime and --reconfigure are only valid for init.',
    );
    return 2;
  }
  if (command !== 'init' && command !== 'onboard' && values.yes === true) {
    failure(
      output,
      json,
      'invalid_arguments',
      '--yes is only valid for init and onboard.',
    );
    return 2;
  }
  if (command !== 'task' && values['auto-resume'] === true) {
    failure(
      output,
      json,
      'invalid_arguments',
      '--auto-resume is only valid for task pin.',
    );
    return 2;
  }
  if (
    command !== 'onboard' &&
    (values.hosts !== undefined ||
      values['apply-host'] === true ||
      values['dry-run'] === true ||
      values['print-handoff'] === true)
  ) {
    failure(
      output,
      json,
      'invalid_arguments',
      '--hosts, --apply-host, --dry-run and --print-handoff are only valid for onboard.',
    );
    return 2;
  }
  if (command !== 'host' && values['bootstrap-config'] !== undefined) {
    failure(
      output,
      json,
      'invalid_arguments',
      '--bootstrap-config is only valid for host bundle.',
    );
    return 2;
  }
  if (command !== 'host' && values['recovery-config'] !== undefined) {
    failure(
      output,
      json,
      'invalid_arguments',
      '--recovery-config is only valid for host bundle.',
    );
    return 2;
  }
  if (command !== 'host' && values['transition-extension'] === true) {
    failure(
      output,
      json,
      'invalid_arguments',
      '--transition-extension is only valid for host bundle.',
    );
    return 2;
  }
  if (command !== 'host' && values.out !== undefined) {
    failure(output, json, 'invalid_arguments', '--out is only valid for host.');
    return 2;
  }
  if (
    values.scope !== undefined &&
    values.scope !== 'project' &&
    values.scope !== 'user'
  ) {
    failure(
      output,
      json,
      'invalid_arguments',
      '--scope accepts project or user.',
    );
    return 2;
  }
  if (command !== 'host' && values.scope !== undefined) {
    failure(
      output,
      json,
      'invalid_arguments',
      '--scope is only valid for host.',
    );
    return 2;
  }
  if (command !== 'host' && values.marketplace === true) {
    failure(
      output,
      json,
      'invalid_arguments',
      '--marketplace is only valid for host bundle.',
    );
    return 2;
  }
  if (
    command !== 'host' &&
    values.mode !== undefined &&
    command !== 'runtime'
  ) {
    failure(
      output,
      json,
      'invalid_arguments',
      '--mode is only valid for host.',
    );
    return 2;
  }
  if (
    values.mode !== undefined &&
    values.mode !== 'project-settings' &&
    values.mode !== 'plugin'
  ) {
    failure(
      output,
      json,
      'invalid_arguments',
      '--mode accepts project-settings or plugin.',
    );
    return 2;
  }
  if (
    command !== 'runtime' &&
    command !== 'host' &&
    (values.from !== undefined ||
      values.tarball !== undefined ||
      values.bind === true ||
      values.force === true)
  ) {
    failure(
      output,
      json,
      'invalid_arguments',
      '--from, --tarball, --bind and --force are only valid for runtime.',
    );
    return 2;
  }

  const rpcRequestTimeout = values['rpc-request-timeout-ms'];
  const rpcOperationTimeout = values['rpc-operation-timeout-ms'];
  for (const [name, value, maximum] of [
    ['rpc-request-timeout-ms', rpcRequestTimeout, 60_000],
    ['rpc-operation-timeout-ms', rpcOperationTimeout, 86_400_000],
  ] as const) {
    if (value === undefined) continue;
    if (
      command !== 'collab' ||
      collaborationAction !== 'run' ||
      values.controller !== 'pi-rpc' ||
      !/^[0-9]+$/.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) < 1 ||
      Number(value) > maximum
    ) {
      failure(
        output,
        json,
        'invalid_arguments',
        `--${name} requires collab run --controller pi-rpc and an integer from 1 to ${maximum}.`,
      );
      return 2;
    }
  }

  let info: ReturnType<typeof getPackageInfo>;
  try {
    info = getPackageInfo();
  } catch (error) {
    failure(output, json, 'package_unavailable', error);
    return 3;
  }

  if (values.version) {
    if (command !== null) {
      failure(
        output,
        json,
        'invalid_arguments',
        '--version cannot be combined with a command.',
      );
      return 2;
    }
    output.stdout(json ? `${JSON.stringify(info)}\n` : `${info.version}\n`);
    return 0;
  }

  if (
    command !== 'collab' &&
    (values['task-root'] !== undefined ||
      values.message !== undefined ||
      values['message-id'] !== undefined ||
      values.binding !== undefined ||
      values.retry === true ||
      values['caller-pane'] !== undefined ||
      values.assignment !== undefined ||
      values['max-age-minutes'] !== undefined ||
      values.harness !== undefined ||
      values.template !== undefined ||
      values.execution !== undefined ||
      values.events !== undefined ||
      values.request !== undefined ||
      values['owner-epoch'] !== undefined ||
      values['subtask-id'] !== undefined ||
      values.attempt !== undefined ||
      values['task-id'] !== undefined ||
      values.record !== undefined ||
      values.roots !== undefined)
  ) {
    failure(
      output,
      json,
      'invalid_arguments',
      '--task-root, --message, --message-id, --binding, --retry, --caller-pane, --assignment, --max-age-minutes, --harness, --template, --execution, --events, --request, --owner-epoch, --subtask-id, --attempt, --task-id, --record and --roots are only valid for collab.',
    );
    return 2;
  }

  if (command === 'collab') {
    if (values.help) {
      const usage =
        collaborationAction === 'recovery-run'
          ? collaborationRecoveryRunUsage
          : collaborationAction === 'work-run'
            ? collaborationWorkRunUsage
            : collaborationAction === 'transition' ||
                collaborationAction?.startsWith('transition:') === true
              ? collaborationTransitionUsage
              : collaborationAction === 'bootstrap' ||
                  collaborationAction?.startsWith('bootstrap:') === true
                ? collaborationBootstrapUsage
                : collaborationAction === 'message' ||
                    collaborationAction?.startsWith('message:') === true
                  ? collaborationMessageUsage
                  : collaborationAction?.startsWith('capabilities:') === true
                    ? collaborationCapabilitiesUsage
                    : collaborationAction?.startsWith('state:') === true
                      ? collaborationStateUsage
                      : collaborationAction?.startsWith('resource:') === true
                        ? collaborationResourcesUsage
                        : collaborationAction?.startsWith('handoff:') === true
                          ? collaborationHandoffUsage
                          : collaborationAction?.startsWith('recovery:') ===
                              true
                            ? collaborationRecoveryUsage
                            : collaborationAction?.startsWith('binding:') ===
                                true
                              ? collaborationBindingUsage
                              : collaborationAction === 'plan'
                                ? collaborationPlanUsage
                                : collaborationAction?.startsWith(
                                      'rollover:',
                                    ) === true ||
                                    collaborationAction === 'rollover'
                                  ? collaborationRolloverUsage
                                  : collaborationAction === 'preflight'
                                    ? collaborationPreflightUsage
                                    : collaborationUsage;
      if (json) {
        output.stdout(
          `${JSON.stringify({ ...info, commands: ['collab'], usage })}\n`,
        );
      } else {
        output.stdout(usage);
      }
      return 0;
    }
    if (collaborationAction === 'work-run') {
      const allowed = new Set(['request', 'apply', 'json']);
      const extra = Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key)
        .filter((key) => !allowed.has(key));
      const parsedWork = parseCollaborationWorkRunArgs(args.slice(2));
      if (extra.length || parsedWork.errors.length) {
        failure(
          output,
          json,
          'invalid_arguments',
          `collab work-run accepts only --request, --apply and --json.${extra.length ? ` Unexpected: ${extra.join(', ')}.` : ''}${parsedWork.errors.length ? ` ${parsedWork.errors.join(' ')}` : ''}\n${collaborationWorkRunUsage}`,
        );
        return 2;
      }
      return runCollaborationWorkRunCommand(
        { ...parsedWork.options, json },
        output,
      );
    }
    if (collaborationAction === 'recovery-run') {
      const allowed = new Set(['request', 'apply', 'json']);
      const extra = Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key)
        .filter((key) => !allowed.has(key));
      const parsedRecovery = parseCollaborationRecoveryRunArgs(args.slice(2));
      if (extra.length || parsedRecovery.errors.length) {
        failure(
          output,
          json,
          'invalid_arguments',
          `collab recovery-run accepts only --request, --apply and --json.${extra.length ? ` Unexpected: ${extra.join(', ')}.` : ''}${parsedRecovery.errors.length ? ` ${parsedRecovery.errors.join(' ')}` : ''}\n${collaborationRecoveryRunUsage}`,
        );
        return 2;
      }
      return runCollaborationRecoveryRunCommand(
        { ...parsedRecovery.options, json },
        output,
      );
    }
    if (collaborationAction === 'capabilities:derive') {
      const duplicate = [
        '--live',
        '--harness',
        '--assignment',
        '--template',
        '--execution',
        '--session',
        '--events',
      ].filter(
        (flag) =>
          args.filter((arg) => arg === flag || arg.startsWith(`${flag}=`))
            .length > 1,
      );
      if (duplicate.length) {
        failure(
          output,
          json,
          'invalid_arguments',
          `collab capabilities derive rejects duplicate option(s): ${duplicate.join(', ')}.\n${collaborationCapabilitiesUsage}`,
        );
        return 2;
      }
      const allowed = new Set([
        'live',
        'assignment',
        'harness',
        'template',
        'execution',
        'session',
        'events',
        'json',
      ]);
      const extra = Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key)
        .filter((key) => !allowed.has(key));
      if (extra.length) {
        failure(
          output,
          json,
          'invalid_arguments',
          `collab capabilities derive accepts only its own options: ${extra.join(', ')}.\n${collaborationCapabilitiesUsage}`,
        );
        return 2;
      }
      return runCollaborationCapabilitiesCommand(
        {
          harness: values.harness ?? null,
          assignmentFile: values.assignment ?? null,
          templateFile: values.template ?? null,
          executionFile: values.execution ?? null,
          sessionFile: values.session ?? null,
          eventsFile: values.events ?? null,
          live: values.live ?? false,
          json,
        },
        output,
      );
    }
    if (collaborationAction?.startsWith('state:')) {
      const selected = collaborationAction.slice('state:'.length);
      const stateAction =
        selected === 'show' ||
        selected === 'doctor' ||
        selected === 'epoch-check'
          ? selected
          : null;
      const stateFlags =
        stateAction === 'epoch-check'
          ? ['--task-root', '--owner-epoch']
          : ['--task-root'];
      const duplicate = stateFlags.filter(
        (flag) =>
          args.filter((arg) => arg === flag || arg.startsWith(`${flag}=`))
            .length > 1,
      );
      const allowed = new Set([
        'task-root',
        'json',
        ...(stateAction === 'epoch-check' ? ['owner-epoch'] : []),
      ]);
      const extra = Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key)
        .filter((key) => !allowed.has(key));
      if (stateAction === null || duplicate.length || extra.length) {
        failure(
          output,
          json,
          'invalid_arguments',
          `collab state accepts only show/doctor/epoch-check and their own options.${
            duplicate.length ? ` Duplicate: ${duplicate.join(', ')}.` : ''
          }${extra.length ? ` Unexpected: ${extra.join(', ')}.` : ''}\n${collaborationStateUsage}`,
        );
        return 2;
      }
      return runCollaborationStateCommand(
        {
          action: stateAction,
          taskRoot: values['task-root'] ?? null,
          ownerEpoch: values['owner-epoch'] ?? null,
          json,
        },
        output,
      );
    }
    if (collaborationAction?.startsWith('resource:')) {
      const selected = collaborationAction.slice('resource:'.length);
      const resourceAction =
        selected === 'list' || selected === 'claim' || selected === 'release'
          ? selected
          : null;
      const resourceFlags =
        resourceAction === 'list'
          ? ['--task-root']
          : ['--task-root', '--request'];
      const duplicate = resourceFlags.filter(
        (flag) =>
          args.filter((arg) => arg === flag || arg.startsWith(`${flag}=`))
            .length > 1,
      );
      const allowed = new Set([
        'task-root',
        'json',
        ...(resourceAction === 'list' ? [] : ['request', 'apply']),
      ]);
      const extra = Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key)
        .filter((key) => !allowed.has(key));
      if (resourceAction === null || duplicate.length || extra.length) {
        failure(
          output,
          json,
          'invalid_arguments',
          `collab resource accepts only list/claim/release and their own options.${
            duplicate.length ? ` Duplicate: ${duplicate.join(', ')}.` : ''
          }${extra.length ? ` Unexpected: ${extra.join(', ')}.` : ''}\n${collaborationResourcesUsage}`,
        );
        return 2;
      }
      return runCollaborationResourcesCommand(
        {
          action: resourceAction,
          taskRoot: values['task-root'] ?? null,
          requestFile: values.request ?? null,
          apply: values.apply === true,
          json,
        },
        output,
      );
    }
    if (collaborationAction?.startsWith('handoff:')) {
      const selected = collaborationAction.slice('handoff:'.length);
      const handoffAction =
        selected === 'inventory' ||
        selected === 'begin' ||
        selected === 'stopped' ||
        selected === 'rebind' ||
        selected === 'transfer' ||
        selected === 'confirm' ||
        selected === 'complete' ||
        selected === 'abort' ||
        selected === 'release-dispatch'
          ? selected
          : null;
      const duplicateFlags =
        handoffAction === 'inventory'
          ? ['--task-root', '--subtask-id', '--attempt']
          : ['--task-root', '--request'];
      const duplicate = duplicateFlags.filter(
        (flag) =>
          args.filter((arg) => arg === flag || arg.startsWith(`${flag}=`))
            .length > 1,
      );
      const allowed = new Set([
        'task-root',
        'json',
        ...(handoffAction === 'inventory'
          ? ['subtask-id', 'attempt']
          : ['request', 'apply']),
      ]);
      const extra = Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key)
        .filter((key) => !allowed.has(key));
      if (handoffAction === null || duplicate.length || extra.length) {
        failure(
          output,
          json,
          'invalid_arguments',
          `collab handoff accepts only inventory or a handoff mutation action and their own options.${
            duplicate.length ? ` Duplicate: ${duplicate.join(', ')}.` : ''
          }${extra.length ? ` Unexpected: ${extra.join(', ')}.` : ''}\n${collaborationHandoffUsage}`,
        );
        return 2;
      }
      return runCollaborationHandoffCommand(
        {
          action: handoffAction,
          taskRoot: values['task-root'] ?? null,
          requestFile: values.request ?? null,
          subtaskId: values['subtask-id'] ?? null,
          attempt: values.attempt ?? null,
          apply: values.apply === true,
          json,
        },
        output,
      );
    }
    if (collaborationAction?.startsWith('recovery:')) {
      const selected = collaborationAction.slice('recovery:'.length);
      const recoveryAction =
        selected === 'inspect' ||
        selected === 'reconcile' ||
        selected === 'lock-break'
          ? selected
          : null;
      const duplicateFlags =
        recoveryAction === 'inspect'
          ? ['--task-root']
          : ['--task-root', '--request'];
      const duplicate = duplicateFlags.filter(
        (flag) =>
          args.filter((arg) => arg === flag || arg.startsWith(`${flag}=`))
            .length > 1,
      );
      const allowed = new Set([
        'task-root',
        'json',
        ...(recoveryAction === 'inspect' ? [] : ['request', 'apply']),
      ]);
      const extra = Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key)
        .filter((key) => !allowed.has(key));
      if (recoveryAction === null || duplicate.length || extra.length) {
        failure(
          output,
          json,
          'invalid_arguments',
          `collab recovery accepts only inspect/reconcile/lock-break and their own options.${
            duplicate.length ? ` Duplicate: ${duplicate.join(', ')}.` : ''
          }${extra.length ? ` Unexpected: ${extra.join(', ')}.` : ''}\n${collaborationRecoveryUsage}`,
        );
        return 2;
      }
      return runCollaborationRecoveryCommand(
        {
          action: recoveryAction,
          taskRoot: values['task-root'] ?? null,
          requestFile: values.request ?? null,
          apply: values.apply === true,
          json,
        },
        output,
      );
    }
    if (collaborationAction?.startsWith('binding:')) {
      const selected = collaborationAction.slice('binding:'.length);
      const bindingAction =
        selected === 'list' ||
        selected === 'resolve' ||
        selected === 'bind' ||
        selected === 'unbind'
          ? selected
          : null;
      const allowedFlags =
        bindingAction === 'list'
          ? ['root']
          : bindingAction === 'resolve'
            ? ['task-id', 'root', 'roots']
            : bindingAction === 'bind'
              ? ['task-id', 'record', 'root', 'apply']
              : bindingAction === 'unbind'
                ? ['task-id', 'root', 'apply']
                : [];
      const duplicate = allowedFlags.filter(
        (flag) =>
          args.filter(
            (arg) => arg === `--${flag}` || arg.startsWith(`--${flag}=`),
          ).length > 1,
      );
      const allowed = new Set([...allowedFlags, 'json']);
      const extra = Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key)
        .filter((key) => !allowed.has(key));
      const missing =
        bindingAction === null
          ? []
          : [
              ...(bindingAction === 'resolve' ||
              bindingAction === 'bind' ||
              bindingAction === 'unbind'
                ? ['task-id']
                : []),
              ...(bindingAction === 'bind' ? ['record'] : []),
            ].filter(
              (flag) =>
                values[flag as keyof typeof values] === undefined ||
                values[flag as keyof typeof values] === null,
            );
      if (
        bindingAction === null ||
        duplicate.length ||
        extra.length ||
        missing.length
      ) {
        failure(
          output,
          json,
          'invalid_arguments',
          `collab binding accepts only list/resolve/bind/unbind and their own options.${
            duplicate.length ? ` Duplicate: ${duplicate.join(', ')}.` : ''
          }${extra.length ? ` Unexpected: ${extra.join(', ')}.` : ''}${
            missing.length ? ` Missing: ${missing.join(', ')}.` : ''
          }\n${collaborationBindingUsage}`,
        );
        return 2;
      }
      return runCollaborationBindingCommand(
        {
          action: bindingAction,
          root: values.root ?? null,
          taskId: values['task-id'] ?? null,
          record: values.record ?? null,
          roots: values.roots ?? null,
          apply: values.apply === true,
          json,
        },
        output,
      );
    }
    if (
      collaborationAction === 'transition' ||
      collaborationAction?.startsWith('transition:') === true
    ) {
      const selected =
        collaborationAction === 'transition'
          ? null
          : collaborationAction.slice('transition:'.length);
      const transitionAction =
        selected === 'plan' || selected === 'apply' ? selected : null;
      const duplicate = ['--task-root', '--request'].filter(
        (flag) =>
          args.filter((arg) => arg === flag || arg.startsWith(`${flag}=`))
            .length > 1,
      );
      const allowed = new Set(['task-root', 'request', 'json']);
      const extra = Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key)
        .filter((key) => !allowed.has(key));
      if (transitionAction === null || duplicate.length || extra.length) {
        failure(
          output,
          json,
          'invalid_arguments',
          `collab transition accepts only plan|apply with --task-root, --request and --json.${
            duplicate.length ? ` Duplicate: ${duplicate.join(', ')}.` : ''
          }${extra.length ? ` Unexpected: ${extra.join(', ')}.` : ''}${
            transitionAction === null ? ' Missing: plan or apply.' : ''
          }\n${collaborationTransitionUsage}`,
        );
        return 2;
      }
      return runCollaborationTransitionCommand(
        {
          action: transitionAction,
          taskRoot: values['task-root'] ?? null,
          requestFile: values.request ?? null,
          json,
        },
        output,
      );
    }
    if (
      collaborationAction?.startsWith('rollover:') ||
      collaborationAction === 'rollover'
    ) {
      const selected =
        collaborationAction === 'rollover'
          ? null
          : collaborationAction.slice('rollover:'.length);
      const rolloverAction =
        selected === 'inspect' || selected === 'plan' ? selected : null;
      const duplicate = ['--task-root', '--request'].filter(
        (flag) =>
          args.filter((arg) => arg === flag || arg.startsWith(`${flag}=`))
            .length > 1,
      );
      const allowed = new Set(['task-root', 'request', 'json']);
      const extra = Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key)
        .filter((key) => !allowed.has(key));
      if (rolloverAction === null || duplicate.length || extra.length) {
        failure(
          output,
          json,
          'invalid_arguments',
          `collab rollover accepts only inspect or plan with --task-root, --request and --json.${
            duplicate.length ? ` Duplicate: ${duplicate.join(', ')}.` : ''
          }${extra.length ? ` Unexpected: ${extra.join(', ')}.` : ''}${
            rolloverAction === null ? ' Missing: inspect or plan.' : ''
          }\n${collaborationRolloverUsage}`,
        );
        return 2;
      }
      return runCollaborationRolloverCommand(
        {
          action: rolloverAction,
          taskRoot: values['task-root'] ?? null,
          requestFile: values.request ?? null,
          json,
        },
        output,
      );
    }
    if (collaborationAction === 'plan') {
      // `plan` is the only collab action that reads --config: the plan document is an
      // explicit bounded file, not a global flag other commands silently accept.
      const duplicate = ['--task-root', '--config'].filter(
        (flag) =>
          args.filter((arg) => arg === flag || arg.startsWith(`${flag}=`))
            .length > 1,
      );
      const allowed = new Set(['task-root', 'config', 'json']);
      const extra = Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key)
        .filter((key) => !allowed.has(key));
      if (duplicate.length || extra.length) {
        failure(
          output,
          json,
          'invalid_arguments',
          `collab plan accepts only --task-root, --config and --json.${
            duplicate.length ? ` Duplicate: ${duplicate.join(', ')}.` : ''
          }${extra.length ? ` Unexpected: ${extra.join(', ')}.` : ''}\n${collaborationPlanUsage}`,
        );
        return 2;
      }
      return runCollaborationPlanCommand(
        {
          taskRoot: values['task-root'] ?? null,
          planFile: values.config ?? null,
          json,
        },
        output,
      );
    }
    if (
      collaborationAction === 'bootstrap' ||
      collaborationAction?.startsWith('bootstrap:') === true
    ) {
      const selected =
        collaborationAction === 'bootstrap'
          ? null
          : collaborationAction.slice('bootstrap:'.length);
      const action =
        selected === 'plan' || selected === 'apply' ? selected : null;
      const duplicate = ['--task-root', '--request'].filter(
        (flag) =>
          args.filter((arg) => arg === flag || arg.startsWith(`${flag}=`))
            .length > 1,
      );
      const allowed = new Set(['task-root', 'request', 'json']);
      const extra = Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key)
        .filter((key) => !allowed.has(key));
      if (action === null || duplicate.length || extra.length) {
        failure(
          output,
          json,
          'invalid_arguments',
          `collab bootstrap requires plan|apply and only --task-root, --request and --json.${
            duplicate.length ? ` Duplicate: ${duplicate.join(', ')}.` : ''
          }${extra.length ? ` Unexpected: ${extra.join(', ')}.` : ''}\n${collaborationBootstrapUsage}`,
        );
        return 2;
      }
      return runCollaborationBootstrapCommand(
        {
          action,
          taskRoot: values['task-root'] ?? null,
          requestFile: values.request ?? null,
          json,
        },
        output,
      );
    }
    if (collaborationAction === 'preflight') {
      if (
        values.version ||
        values.config !== undefined ||
        values['install-runtime'] === true ||
        values['runtime-tarball'] !== undefined ||
        values['runtime-version'] !== undefined ||
        values.root !== undefined ||
        values.goal !== undefined ||
        values.prepared !== undefined ||
        values.controller !== undefined ||
        values['domain-root'] !== undefined ||
        values['task-root'] !== undefined ||
        values.message !== undefined ||
        values['message-id'] !== undefined ||
        values.binding !== undefined ||
        values.retry === true ||
        values['caller-pane'] !== undefined ||
        values.session !== undefined ||
        values.harness !== undefined ||
        values.template !== undefined ||
        values.execution !== undefined ||
        values.events !== undefined ||
        values.request !== undefined ||
        values['owner-epoch'] !== undefined ||
        values['subtask-id'] !== undefined ||
        values.attempt !== undefined ||
        values['task-id'] !== undefined ||
        values.record !== undefined ||
        values.roots !== undefined ||
        values.apply === true ||
        values['include-private'] === true ||
        values['include-archived'] === true ||
        hasContinuityOptions(values)
      ) {
        failure(
          output,
          json,
          'invalid_arguments',
          `collab preflight accepts only its own options.\n${collaborationPreflightUsage}`,
        );
        return 2;
      }
      return runCollaborationPreflightCommand(
        {
          cwd: process.cwd(),
          assignmentFile: values.assignment ?? null,
          capabilitiesFile: values.capabilities ?? null,
          maxAgeMinutes: values['max-age-minutes'] ?? null,
          json,
        },
        output,
      );
    }
    const separator = collaborationAction?.indexOf(':') ?? -1;
    if (separator >= 0) {
      const group = collaborationAction?.slice(0, separator) ?? '';
      const selected = collaborationAction?.slice(separator + 1) ?? '';
      const messageAction: CollaborationMessageAction | null =
        group === 'message' &&
        (selected === 'send' ||
          selected === 'list' ||
          selected === 'read' ||
          selected === 'notify')
          ? selected
          : null;
      const provided = new Set<string>();
      if (values.message !== undefined) provided.add('message');
      if (values['message-id'] !== undefined) provided.add('message-id');
      if (values.binding !== undefined) provided.add('binding');
      if (values.limit !== undefined) provided.add('limit');
      if (values.apply === true) provided.add('apply');
      if (values.retry === true) provided.add('retry');
      if (values['caller-pane'] !== undefined) provided.add('caller-pane');
      const allowedByAction: Record<CollaborationMessageAction, Set<string>> = {
        send: new Set(['message', 'apply']),
        list: new Set(['limit']),
        read: new Set(['message-id']),
        notify: new Set([
          'message-id',
          'binding',
          'apply',
          'retry',
          'caller-pane',
        ]),
      };
      const requiredByAction: Record<CollaborationMessageAction, string[]> = {
        send: ['message'],
        list: [],
        read: ['message-id'],
        notify: ['message-id', 'binding'],
      };
      const actionFlagsValid =
        messageAction !== null &&
        [...provided].every((flag) =>
          allowedByAction[messageAction].has(flag),
        ) &&
        requiredByAction[messageAction].every((flag) => provided.has(flag));
      if (
        messageAction === null ||
        !actionFlagsValid ||
        values.version ||
        values.config !== undefined ||
        values['install-runtime'] === true ||
        values['runtime-tarball'] !== undefined ||
        values['runtime-version'] !== undefined ||
        values.root !== undefined ||
        values.goal !== undefined ||
        values.prepared !== undefined ||
        values.capabilities !== undefined ||
        values.controller !== undefined ||
        values['domain-root'] !== undefined ||
        values.assignment !== undefined ||
        values['max-age-minutes'] !== undefined ||
        values.session !== undefined ||
        values.harness !== undefined ||
        values.template !== undefined ||
        values.execution !== undefined ||
        values.events !== undefined ||
        values.request !== undefined ||
        values['owner-epoch'] !== undefined ||
        values['subtask-id'] !== undefined ||
        values.attempt !== undefined ||
        values['task-id'] !== undefined ||
        values.record !== undefined ||
        values.roots !== undefined ||
        values['include-private'] === true ||
        values['include-archived'] === true ||
        hasContinuityOptions(values)
      ) {
        failure(
          output,
          json,
          'invalid_arguments',
          `collab message requires send/list/read/notify with only its own options.\n${collaborationMessageUsage}`,
        );
        return 2;
      }
      return runCollaborationMessageCommand(
        {
          cwd: process.cwd(),
          action: messageAction,
          json,
          taskRoot: values['task-root'] ?? null,
          messageFile: values.message ?? null,
          messageId: values['message-id'] ?? null,
          bindingFile: values.binding ?? null,
          apply: values.apply === true,
          retry: values.retry === true,
          limit: values.limit ?? null,
          callerPane: values['caller-pane'] ?? null,
        },
        output,
      );
    }

    const action =
      collaborationAction === 'prepare' ||
      collaborationAction === 'run' ||
      collaborationAction === 'query'
        ? collaborationAction
        : null;
    if (
      action === null ||
      values.version ||
      values.config !== undefined ||
      values['install-runtime'] === true ||
      values['runtime-tarball'] !== undefined ||
      values['runtime-version'] !== undefined ||
      values.root !== undefined ||
      values['include-private'] === true ||
      values['task-root'] !== undefined ||
      values.message !== undefined ||
      values['message-id'] !== undefined ||
      values.binding !== undefined ||
      values.retry === true ||
      values['caller-pane'] !== undefined ||
      values.assignment !== undefined ||
      values['max-age-minutes'] !== undefined ||
      values.session !== undefined ||
      values.harness !== undefined ||
      values.template !== undefined ||
      values.execution !== undefined ||
      values.events !== undefined ||
      values.request !== undefined ||
      values['owner-epoch'] !== undefined ||
      values['subtask-id'] !== undefined ||
      values.attempt !== undefined ||
      values['task-id'] !== undefined ||
      values.record !== undefined ||
      values.roots !== undefined ||
      values['include-archived'] === true ||
      hasContinuityOptions(values)
    ) {
      failure(
        output,
        json,
        'invalid_arguments',
        'collab requires prepare/run/query and only collab options.',
      );
      return 2;
    }
    return runCollaborationCommand(
      {
        cwd: process.cwd(),
        action,
        json,
        goalFile: values.goal ?? null,
        preparedFile: values.prepared ?? null,
        capabilitiesFile: values.capabilities ?? null,
        controller: values.controller ?? null,
        domainRoot: values['domain-root'] ?? null,
        ...(rpcRequestTimeout === undefined
          ? {}
          : { rpcRequestTimeoutMs: Number(rpcRequestTimeout) }),
        ...(rpcOperationTimeout === undefined
          ? {}
          : { rpcOperationTimeoutMs: Number(rpcOperationTimeout) }),
      },
      output,
    );
  }

  if (command === 'docs') {
    if (
      values.version ||
      values.config !== undefined ||
      values['install-runtime'] === true ||
      values['runtime-tarball'] !== undefined ||
      values['runtime-version'] !== undefined ||
      values.root !== undefined ||
      hasContinuityOptions(values)
    ) {
      failure(
        output,
        json,
        'invalid_arguments',
        'docs only accepts list/check/archive/scan, --include-private, --include-archived, --apply (scan only), --help, and --json.',
      );
      return 2;
    }
    if (values.help) {
      if (json) {
        output.stdout(
          `${JSON.stringify({ ...info, commands: ['docs'], usage: docsUsage })}\n`,
        );
      } else {
        output.stdout(docsUsage);
      }
      return 0;
    }
    return runDocsCommand(
      {
        cwd: process.cwd(),
        action: docsAction,
        argument: docsArgument,
        json,
        includePrivate: values['include-private'] === true,
        includeArchived: values['include-archived'] === true,
        apply: applyRequested,
      },
      output,
    );
  }

  if (command === 'doctor') {
    if (values.help) {
      if (json) {
        output.stdout(
          `${JSON.stringify({ ...info, commands: ['init', 'doctor', 'docs'], usage: doctorUsage })}\n`,
        );
      } else {
        output.stdout(doctorUsage);
      }
      return 0;
    }
    if (
      values.version ||
      values.config !== undefined ||
      values.apply === true ||
      values['install-runtime'] === true ||
      values['runtime-tarball'] !== undefined ||
      values['runtime-version'] !== undefined ||
      values['include-private'] === true ||
      values['include-archived'] === true ||
      hasContinuityOptions(values)
    ) {
      failure(
        output,
        json,
        'invalid_arguments',
        'doctor only accepts --root, --help, and --json.',
      );
      return 2;
    }
    return runDoctorCommand(
      {
        root: values.root ?? process.cwd(),
        json,
      },
      output,
    );
  }

  if (command === 'task') {
    const action =
      taskAction === 'pin' || taskAction === 'unpin' || taskAction === 'show'
        ? taskAction
        : null;
    if (
      values.config !== undefined ||
      values.apply === true ||
      values.yes === true ||
      values['install-runtime'] === true ||
      values['runtime-tarball'] !== undefined ||
      values['runtime-version'] !== undefined ||
      values.host !== undefined ||
      values.repo !== undefined ||
      values.kind !== undefined ||
      values.query !== undefined ||
      values.root !== undefined ||
      hasContinuityOptions(values)
    ) {
      failure(
        output,
        json,
        'invalid_arguments',
        'task accepts pin|unpin|show, an optional task id, --auto-resume, --help, and --json.',
      );
      return 2;
    }
    if (values.help) {
      if (json) {
        output.stdout(
          `${JSON.stringify({ ...info, commands: ['task'], usage: taskUsage })}\n`,
        );
      } else {
        output.stdout(taskUsage);
      }
      return 0;
    }
    if (values.version) {
      failure(
        output,
        json,
        'invalid_arguments',
        '--version cannot be combined with task.',
      );
      return 2;
    }
    return runTaskCommand(
      {
        cwd: process.cwd(),
        action,
        taskId: taskArgument ?? null,
        autoResume: values['auto-resume'] === true,
        json,
      },
      output,
    );
  }

  if (command === 'mcp') {
    if (
      values.config !== undefined ||
      values.apply === true ||
      values.yes === true ||
      values['install-runtime'] === true ||
      values['runtime-tarball'] !== undefined ||
      values['runtime-version'] !== undefined ||
      values['include-private'] === true ||
      values['include-archived'] === true ||
      values['apply-host'] === true ||
      values['dry-run'] === true ||
      values['print-handoff'] === true ||
      values.hosts !== undefined ||
      values.repo !== undefined ||
      values.kind !== undefined ||
      values.query !== undefined ||
      values.limit !== undefined ||
      values['max-bytes'] !== undefined ||
      values.rebuild === true ||
      values.host !== undefined ||
      hasContinuityOptions(values)
    ) {
      failure(
        output,
        json,
        'invalid_arguments',
        'mcp accepts only --root, --help, and --json.',
      );
      return 2;
    }
    if (values.help) {
      if (json) {
        output.stdout(
          `${JSON.stringify({ ...info, commands: ['mcp'], usage: mcpUsage })}\n`,
        );
      } else {
        output.stdout(mcpUsage);
      }
      return 0;
    }
    if (values.version) {
      failure(
        output,
        json,
        'invalid_arguments',
        '--version cannot be combined with mcp.',
      );
      return 2;
    }
    return runMcpCommand(
      { cwd: process.cwd(), root: values.root ?? null, json },
      output,
    );
  }

  if (command === 'onboard') {
    if (
      values.apply === true ||
      values['install-runtime'] === true ||
      values['runtime-tarball'] !== undefined ||
      values['runtime-version'] !== undefined ||
      values['host-root'] !== undefined ||
      values['host-version'] !== undefined ||
      values.mode !== undefined ||
      values.from !== undefined ||
      values.tarball !== undefined ||
      values.bind === true ||
      values.force === true ||
      values.marketplace === true ||
      values.scope !== undefined ||
      values.repo !== undefined ||
      values.kind !== undefined ||
      values.query !== undefined ||
      values.limit !== undefined ||
      values['max-bytes'] !== undefined ||
      values.rebuild === true ||
      values['include-private'] === true ||
      values['include-archived'] === true ||
      hasContinuityOptions(values)
    ) {
      failure(
        output,
        json,
        'invalid_arguments',
        'onboard accepts --root, --config, --hosts, --yes, --apply-host, --dry-run, --print-handoff, --help, and --json.',
      );
      return 2;
    }
    if (values.help) {
      if (json) {
        output.stdout(
          `${JSON.stringify({ ...info, commands: ['onboard'], usage: onboardUsage })}\n`,
        );
      } else {
        output.stdout(onboardUsage);
      }
      return 0;
    }
    if (values.version) {
      failure(
        output,
        json,
        'invalid_arguments',
        '--version cannot be combined with onboard.',
      );
      return 2;
    }
    return runOnboardCommand(
      {
        cwd: process.cwd(),
        root: values.root ?? null,
        configPath: values.config ?? null,
        hosts: values.hosts ?? null,
        apply: values.yes === true,
        applyHosts: values['apply-host'] === true,
        dryRun: values['dry-run'] === true,
        printHandoff: values['print-handoff'] === true,
        json,
      },
      output,
    );
  }

  if (command === 'init') {
    if (
      values.root !== undefined ||
      values['include-private'] === true ||
      values['include-archived'] === true ||
      hasContinuityOptions(values)
    ) {
      failure(
        output,
        json,
        'invalid_arguments',
        '--root, --include-private, and --include-archived are not valid for init; init uses the current directory.',
      );
      return 2;
    }
    if (values.help) {
      if (json) {
        output.stdout(
          `${JSON.stringify({ ...info, commands: ['init'], usage: initUsage })}\n`,
        );
      } else {
        output.stdout(initUsage);
      }
      return 0;
    }
    if (values.version) {
      failure(
        output,
        json,
        'invalid_arguments',
        '--version cannot be combined with init.',
      );
      return 2;
    }
    return runInitCommand(
      {
        cwd: process.cwd(),
        configPath: values.config ?? null,
        apply: values.apply === true,
        json,
        installRuntime: values['install-runtime'] === true,
        runtimeTarball: values['runtime-tarball'] ?? null,
        runtimeVersion: values['runtime-version'] ?? null,
        yes: values.yes === true || values['no-interactive'] === true,
        printChoices: values['print-choices'] === true,
        noRuntime: values['no-runtime'] === true,
        reconfigure: values.reconfigure === true,
      },
      output,
    );
  }

  if (command === 'runtime') {
    if (values.help) {
      if (json) {
        output.stdout(
          `${JSON.stringify({ ...info, commands: ['runtime'], usage: runtimeUsage })}\n`,
        );
      } else {
        output.stdout(runtimeUsage);
      }
      return 0;
    }
    if (
      values.version ||
      values.config !== undefined ||
      values['install-runtime'] === true ||
      values['runtime-tarball'] !== undefined ||
      values.root !== undefined ||
      values.host !== undefined ||
      values.repo !== undefined ||
      values.query !== undefined ||
      values.kind !== undefined ||
      hasContinuityOptions(values)
    ) {
      failure(
        output,
        json,
        'invalid_arguments',
        'runtime accepts only --from, --tarball, --version, --apply, --bind, --force, --help, and --json.',
      );
      return 2;
    }
    const action =
      runtimeAction === 'install' ||
      runtimeAction === 'status' ||
      runtimeAction === 'verify' ||
      runtimeAction === 'remove'
        ? runtimeAction
        : null;
    return runRuntimeCommand(
      {
        cwd: process.cwd(),
        action,
        json,
        from:
          values.from === 'self' ||
          values.from === 'tarball' ||
          values.from === 'registry'
            ? values.from
            : null,
        tarball: values.tarball ?? null,
        version: values['runtime-version'] ?? null,
        apply: values.apply === true,
        bind: values.bind === true,
        force: values.force === true,
      },
      output,
    );
  }

  if (command === 'checkpoint') {
    if (values.help) {
      if (json) {
        output.stdout(
          `${JSON.stringify({ ...info, commands: ['checkpoint', 'resume'], usage: checkpointUsage })}\n`,
        );
      } else {
        output.stdout(checkpointUsage);
      }
      return 0;
    }
    if (
      values.version ||
      values.config !== undefined ||
      values.apply === true ||
      values['install-runtime'] === true ||
      values['runtime-tarball'] !== undefined ||
      values['runtime-version'] !== undefined ||
      values.root !== undefined ||
      values['include-private'] === true ||
      values['include-archived'] === true ||
      values.session !== undefined ||
      values.task === undefined
    ) {
      failure(
        output,
        json,
        'invalid_arguments',
        'checkpoint requires --task and accepts only task/context options.',
      );
      return 2;
    }
    const completeness = values['context-completeness'];
    if (
      completeness !== undefined &&
      completeness !== 'complete' &&
      completeness !== 'partial'
    ) {
      failure(
        output,
        json,
        'invalid_arguments',
        '--context-completeness must be complete or partial.',
      );
      return 2;
    }
    const nativeHarnessValue = values['native-harness'];
    if (
      nativeHarnessValue !== undefined &&
      !['pi', 'codex', 'claude', 'unknown'].includes(nativeHarnessValue)
    ) {
      failure(
        output,
        json,
        'invalid_arguments',
        '--native-harness must be pi, codex, claude, or unknown.',
      );
      return 2;
    }
    const nativeHarness =
      nativeHarnessValue === 'pi' ||
      nativeHarnessValue === 'codex' ||
      nativeHarnessValue === 'claude' ||
      nativeHarnessValue === 'unknown'
        ? nativeHarnessValue
        : null;
    return runCheckpointCommand(
      {
        cwd: process.cwd(),
        json,
        task: values.task,
        objective: values.objective ?? null,
        acceptance: values.acceptance ?? [],
        constraints: values.constraint ?? [],
        decisions: values.decision ?? [],
        attempted: values.attempted ?? [],
        nextActions: values['next-action'] ?? [],
        limitations: values.limitation ?? [],
        artifacts: values.artifact ?? [],
        collaborationRecordRef: values['collaboration-record'] ?? null,
        contextCompleteness: completeness ?? null,
        authorSession:
          values['author-session'] ?? process.env.PI_SESSION_ID ?? null,
        nativeHarness: nativeHarness ?? null,
        nativeSession: values['native-session'] ?? null,
      },
      output,
    );
  }

  if (command === 'resume') {
    if (values.help) {
      if (json) {
        output.stdout(
          `${JSON.stringify({ ...info, commands: ['checkpoint', 'resume'], usage: resumeUsage })}\n`,
        );
      } else {
        output.stdout(resumeUsage);
      }
      return 0;
    }
    if (
      values.version ||
      values.config !== undefined ||
      values.apply === true ||
      values['install-runtime'] === true ||
      values['runtime-tarball'] !== undefined ||
      values['runtime-version'] !== undefined ||
      values.root !== undefined ||
      values['include-private'] === true ||
      values['include-archived'] === true ||
      hasContinuityOptions(values, false) ||
      resumeTaskId === null
    ) {
      failure(
        output,
        json,
        'invalid_arguments',
        'resume requires one task id and accepts only --session.',
      );
      return 2;
    }
    return runResumeCommand(
      {
        cwd: process.cwd(),
        json,
        taskId: resumeTaskId,
        currentSession: values.session ?? process.env.PI_SESSION_ID ?? null,
      },
      output,
    );
  }
  if (command === 'code') {
    if (values.help) {
      if (json) {
        output.stdout(
          `${JSON.stringify({ ...info, commands: ['code'], usage: codeUsage })}\n`,
        );
      } else {
        output.stdout(codeUsage);
      }
      return 0;
    }
    const allowedActions = ['status', 'prepare', 'query'] as const;
    const action = allowedActions.find((item) => item === codeAction) ?? null;
    const kindValues = [
      'explore',
      'symbol',
      'references',
      'impact',
      'text',
    ] as const;
    const kind = kindValues.find((item) => item === values.kind) ?? null;
    const operationsInvalid =
      values.version ||
      values.config !== undefined ||
      values['install-runtime'] === true ||
      values['runtime-tarball'] !== undefined ||
      values['runtime-version'] !== undefined ||
      values.root !== undefined ||
      values['include-private'] === true ||
      values['include-archived'] === true ||
      hasContinuityOptions(values);
    if (
      action === null ||
      values.repo === undefined ||
      operationsInvalid ||
      (values.apply === true && action !== 'prepare') ||
      (values.rebuild === true && action !== 'prepare') ||
      (action !== 'query' &&
        (values.kind !== undefined ||
          values.query !== undefined ||
          values.limit !== undefined ||
          values['max-bytes'] !== undefined)) ||
      (action !== 'prepare' && values.rebuild === true) ||
      (action !== 'prepare' && values.apply === true)
    ) {
      failure(
        output,
        json,
        'invalid_arguments',
        'code requires status/prepare/query, --repo, and action-compatible options.',
      );
      return 2;
    }
    if (action === 'query' && (kind === null || values.query === undefined)) {
      failure(
        output,
        json,
        'invalid_arguments',
        'code query requires --kind explore|symbol|references|impact|text and --query.',
      );
      return 2;
    }
    const numberOption = (
      raw: string | undefined,
      minimum: number,
      maximum: number,
    ): number | null | undefined => {
      if (raw === undefined) return null;
      const value = Number(raw);
      return Number.isSafeInteger(value) && value >= minimum && value <= maximum
        ? value
        : undefined;
    };
    const maxResults = numberOption(values.limit, 1, 100);
    const maxBytes = numberOption(values['max-bytes'], 1, 16 * 1024 * 1024);
    if (maxResults === undefined || maxBytes === undefined) {
      failure(
        output,
        json,
        'invalid_arguments',
        '--limit must be 1-100 and --max-bytes must be 1-16777216.',
      );
      return 2;
    }
    return runCodeCommand(
      {
        cwd: process.cwd(),
        json,
        action,
        repositoryId: values.repo,
        kind: action === 'query' ? kind : null,
        query: action === 'query' ? (values.query ?? null) : null,
        maxResults,
        maxBytes,
        apply: values.apply === true,
        rebuild: values.rebuild === true,
      },
      output,
    );
  }

  if (command === 'host') {
    const allowedActions = [
      'detect',
      'describe',
      'plan',
      'install',
      'verify',
      'bundle',
      'mcp',
      'probe',
    ] as const;
    const action = allowedActions.find((item) => item === hostAction) ?? null;
    const parsedHost = hostNameSchema.safeParse(values.host);
    const host = parsedHost.success ? parsedHost.data : null;
    const duplicatedBootstrapConfig =
      args.filter(
        (arg) =>
          arg === '--bootstrap-config' || arg.startsWith('--bootstrap-config='),
      ).length > 1;
    const duplicatedRecoveryConfig =
      args.filter(
        (arg) =>
          arg === '--recovery-config' || arg.startsWith('--recovery-config='),
      ).length > 1;
    const duplicatedTransitionExtension =
      args.filter(
        (arg) =>
          arg === '--transition-extension' ||
          arg.startsWith('--transition-extension='),
      ).length > 1;
    const invalid =
      values.version ||
      values.config !== undefined ||
      values['install-runtime'] === true ||
      values['runtime-tarball'] !== undefined ||
      values['runtime-version'] !== undefined ||
      values.root !== undefined ||
      values['include-private'] === true ||
      values['include-archived'] === true ||
      values.repo !== undefined ||
      values.kind !== undefined ||
      values.query !== undefined ||
      values.limit !== undefined ||
      values['max-bytes'] !== undefined ||
      values.rebuild === true ||
      hasContinuityOptions(values) ||
      (values.apply === true && action !== 'install' && action !== 'mcp') ||
      (values.mode !== undefined && action !== 'install') ||
      (values.marketplace === true && action !== 'bundle') ||
      (values['bootstrap-config'] !== undefined &&
        (action !== 'bundle' ||
          values.marketplace === true ||
          values.mode !== undefined ||
          values.apply === true ||
          values['recovery-config'] !== undefined ||
          values['transition-extension'] === true)) ||
      (values['recovery-config'] !== undefined &&
        (action !== 'bundle' ||
          host !== 'pi' ||
          values.marketplace === true ||
          values.mode !== undefined ||
          values.apply === true)) ||
      (values['transition-extension'] === true &&
        (action !== 'bundle' ||
          host !== 'pi' ||
          values.marketplace === true ||
          values.mode !== undefined ||
          values.apply === true ||
          values['bootstrap-config'] !== undefined)) ||
      (values.scope !== undefined &&
        action !== 'plan' &&
        action !== 'install' &&
        action !== 'verify') ||
      (values['host-root'] !== undefined && action === null) ||
      (values['host-version'] !== undefined && action === null) ||
      duplicatedBootstrapConfig ||
      duplicatedRecoveryConfig ||
      duplicatedTransitionExtension;
    if (values.help) {
      if (json) {
        output.stdout(
          `${JSON.stringify({ ...info, commands: ['host'], usage: hostUsage })}\n`,
        );
      } else {
        output.stdout(hostUsage);
      }
      return 0;
    }
    if (action === null || host === null || invalid) {
      failure(
        output,
        json,
        'invalid_arguments',
        'host requires detect/describe/plan/install/verify/bundle, --host, and action-compatible options.',
      );
      return 2;
    }
    return runHostCommand(
      {
        cwd: process.cwd(),
        json,
        action,
        host,
        hostRoot: values['host-root'] ?? null,
        hostVersion: values['host-version'] ?? null,
        apply: values.apply === true,
        force: values.force === true,
        subAction: hostSubAction ?? null,
        out: values.out ?? null,
        mode:
          values.mode === 'project-settings' || values.mode === 'plugin'
            ? values.mode
            : null,
        bootstrapConfig: values['bootstrap-config'] ?? null,
        recoveryConfig: values['recovery-config'] ?? null,
        transitionExtension: values['transition-extension'] === true,
        marketplace: values.marketplace === true,
        scope:
          values.scope === 'project' || values.scope === 'user'
            ? values.scope
            : null,
      },
      output,
    );
  }

  if (command !== null) {
    failure(output, json, 'invalid_arguments', `Unknown command: ${command}`);
    return 2;
  }
  if (
    values.config !== undefined ||
    values.apply === true ||
    values['install-runtime'] === true ||
    values['runtime-tarball'] !== undefined ||
    values['runtime-version'] !== undefined ||
    values.root !== undefined ||
    values['include-private'] === true ||
    values['include-archived'] === true ||
    hasContinuityOptions(values)
  ) {
    failure(
      output,
      json,
      'invalid_arguments',
      '--config/--apply/runtime flags require init; --root requires doctor.',
    );
    return 2;
  }
  if (values.help) {
    if (json) {
      output.stdout(
        `${JSON.stringify({ ...info, usage: globalUsage, commands: ['init', 'doctor', 'docs', 'checkpoint', 'resume', 'code', 'host', 'collab', 'session'] })}\n`,
      );
    } else {
      output.stdout(
        `${info.name} ${info.version}\n${info.description}\n\nUsage:\n  ${globalUsage.replaceAll('\n', '\n  ')}\n\nOptions:\n  -h, --help     Show help\n  -v, --version  Show version\n      --json     Output JSON\n\nCommands:\n  init           Plan workspace initialization\n  doctor         Read-only workspace and installation diagnostics\n  docs           List, check, and archive registered documents\n`,
      );
      output.stdout(
        '  checkpoint     Save a private task checkpoint\n  resume         Read a bounded recovery packet without starting an agent\n  code           Inspect or prepare selected code intelligence\n  host           Detect, plan, install, or verify a selected host integration\n  collab         Prepare, run, query, message, preflight, state, recovery and bindings\n  session        Launch and control an owned visible native Pi session\n',
      );
    }
    return 0;
  }
  if (json) {
    output.stdout(
      `${JSON.stringify({ ...info, usage: globalUsage, commands: ['init', 'doctor', 'docs', 'checkpoint', 'resume', 'code', 'host', 'collab', 'session'] })}\n`,
    );
  } else {
    output.stdout(
      `${info.name} ${info.version}\n${info.description}\n\nUsage:\n  ${globalUsage}\n\nRun pappra --help for all options.\n`,
    );
  }
  return 0;
}
