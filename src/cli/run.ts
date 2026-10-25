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
import { hostUsage, runHostCommand } from './commands/host.js';
import { sessionUsage, runSessionCommand } from './commands/session.js';
import { collaborationCommandLine } from './commands/collaboration.js';
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
import { parseOptions, failure, hasContinuityOptions } from './options.js';
import { routeCollaboration } from './collaboration-router.js';

const globalUsage =
  'pappra [--help | --version] [--json]\n' +
  'pappra task <pin|unpin|show> [taskId] [--auto-resume] [--json]\n' +
  'pappra mcp [--root <dir>] [--allow-workspace-writes] [--help]\n' +
  'pappra onboard [--root <dir>] [--config <file>] [--hosts <list>] [--yes]\n' +
  '               [--apply-host] [--dry-run] [--print-handoff] [--json]\n' +
  'pappra init [--config <file> | --yes] [--apply] [--json] [--print-choices]\n' +
  '              [--install-runtime (--runtime-tarball <file> | --runtime-version <version>)]\n' +
  'pappra doctor [--root <path>] [--json]\n' +
  'pappra repair [--root <path>] [--runtime-version <v>] [--install-id <uuid>] [--apply] [--json]\n' +
  'pappra docs <list|check|archive|scan|relocate|forget> [options]\n' +
  'pappra checkpoint --task <id> [options] [--json]\n' +
  'pappra resume <taskId> [--session <id>] [--json]\n' +
  'pappra code <status|prepare|query> --repo <id> [options] [--json]\n' +
  'pappra host <detect|describe|probe|plan|install|verify|uninstall|bundle|mcp> --host <name> [options] [--json]\n' +
  'pappra runtime <install|status|verify|remove|gc> [options] [--json]\n' +
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
          'quarantine-unowned-locks': { type: 'boolean' },
          'reset-local': { type: 'boolean' },
          'all-writers-stopped': { type: 'boolean' },
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
          quarantineUnownedLocks:
            parsedRepair.values['quarantine-unowned-locks'] === true,
          resetLocal: parsedRepair.values['reset-local'] === true,
          allWritersStopped:
            parsedRepair.values['all-writers-stopped'] === true,
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
  if (values['allow-workspace-writes'] === true && command !== 'mcp') {
    failure(
      output,
      json,
      'invalid_arguments',
      '--allow-workspace-writes is a trusted MCP server startup option only.',
    );
    return 2;
  }
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
  if (values.scope !== undefined) {
    // `--scope` is command-family scoped: host wiring uses project|user, knowledge
    // documents use private|shared, and docs itself still restricts it to forget.
    if (command === 'host') {
      if (values.scope !== 'project' && values.scope !== 'user') {
        failure(
          output,
          json,
          'invalid_arguments',
          '--scope accepts project or user.',
        );
        return 2;
      }
    } else if (command === 'docs') {
      if (values.scope !== 'private' && values.scope !== 'shared') {
        failure(
          output,
          json,
          'invalid_arguments',
          '--scope accepts private or shared for docs.',
        );
        return 2;
      }
    } else {
      failure(
        output,
        json,
        'invalid_arguments',
        '--scope is only valid for host or docs.',
      );
      return 2;
    }
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
    return routeCollaboration({
      values,
      action: collaborationAction,
      args,
      info,
      rpcRequestTimeout,
      rpcOperationTimeout,
      output,
      json,
    });
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
        'docs accepts list/check/archive/scan/relocate/forget, --include-private, --include-archived, --apply, --help, and --json.',
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
        targetPath: 'docsTarget' in parsed ? parsed.docsTarget : null,
        scope: values.scope ?? null,
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
        'mcp accepts --root, --allow-workspace-writes, --help, and --json.',
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
      {
        cwd: process.cwd(),
        root: values.root ?? null,
        json,
        allowWorkspaceWrites: values['allow-workspace-writes'] === true,
      },
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
        'runtime accepts only --from, --tarball, --runtime-version, --apply, --bind, --force, --help, and --json.',
      );
      return 2;
    }
    const action =
      runtimeAction === 'install' ||
      runtimeAction === 'status' ||
      runtimeAction === 'verify' ||
      runtimeAction === 'remove' ||
      runtimeAction === 'gc'
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
      'uninstall',
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
      (values.apply === true &&
        action !== 'install' &&
        action !== 'uninstall' &&
        action !== 'mcp') ||
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
        action !== 'uninstall' &&
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
        'host requires detect/describe/probe/plan/install/verify/uninstall/bundle/mcp, --host, and action-compatible options.',
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
        `${JSON.stringify({ ...info, usage: globalUsage, commands: ['init', 'onboard', 'doctor', 'repair', 'docs', 'checkpoint', 'resume', 'code', 'host', 'runtime', 'task', 'mcp', 'collab', 'session'] })}\n`,
      );
    } else {
      output.stdout(
        `${info.name} ${info.version}\n${info.description}\n\nUsage:\n  ${globalUsage.replaceAll('\n', '\n  ')}\n\nOptions:\n  -h, --help     Show help\n  -v, --version  Show version\n      --json     Output JSON\n\nCommands:\n  init           Plan workspace initialization\n  onboard        Discover and connect supported hosts\n  doctor         Read-only workspace and installation diagnostics\n  repair         Inspect and repair interrupted state\n  docs           Scan, relocate, forget and inspect knowledge\n  runtime        Install, verify and remove durable runtimes\n  task           Select a private task and auto-resume preference\n  mcp            Serve workspace tools over stdio\n`,
      );
      output.stdout(
        '  checkpoint     Save a private task checkpoint\n  resume         Read a bounded recovery packet without starting an agent\n  code           Inspect or prepare selected code intelligence\n  host           Detect, plan, install, or verify a selected host integration\n  collab         Prepare, run, query, message, preflight, state, recovery and bindings\n  session        Launch and control an owned visible native Pi session\n',
      );
    }
    return 0;
  }
  if (json) {
    output.stdout(
      `${JSON.stringify({ ...info, usage: globalUsage, commands: ['init', 'onboard', 'doctor', 'repair', 'docs', 'checkpoint', 'resume', 'code', 'host', 'runtime', 'task', 'mcp', 'collab', 'session'] })}\n`,
    );
  } else {
    output.stdout(
      `${info.name} ${info.version}\n${info.description}\n\nUsage:\n  ${globalUsage}\n\nRun pappra --help for all options.\n`,
    );
  }
  return 0;
}
