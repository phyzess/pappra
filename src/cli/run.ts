import { getPackageInfo } from '../package-info.js';
import { collaborationCommandLine } from './commands/collaboration.js';
import {
  collaborationRoleRunUsage,
  runCollaborationRoleRunCommand,
} from './commands/collaboration-role-run.js';
import {
  collaborationRolePlanUsage,
  runCollaborationRolePlanCommand,
} from './commands/collaboration-role-plan.js';
import type { CliOutput } from './output.js';
import { parseOptions, failure, hasContinuityOptions } from './options.js';
import { routeCollaboration } from './collaboration-router.js';
import { runHomeCommand } from './commands/home.js';
import { isInteractiveTerminal } from './interactive.js';

import { routeDirect } from './routing/direct.js';
import { routeWorkspace } from './routing/workspace.js';
import { routeContinuity } from './routing/continuity.js';
import { routeServices } from './routing/services.js';

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
  'pappra docs <list|check|review|archive|scan|relocate|forget> [options]\n' +
  'pappra checkpoint --task <id> [options] [--json]\n' +
  'pappra resume <taskId> [--session <id>] [--json | --takeover]\n' +
  'pappra code <status|prepare|query> --repo <id> [options] [--json]\n' +
  'pappra host <detect|describe|probe|plan|install|verify|uninstall|bundle|mcp> --host <name> [options] [--json]\n' +
  'pappra runtime <install|status|verify|remove|gc|archive> [options] [--json]\n' +
  'pappra session <plan|start|status|fence|stop> --config <abs managed-pi.json> [--json]\n' +
  'pappra collab workflow <prepare|dispatch|ack|report|accept|release|reclaim|adopt|await|inspect> [options]\n' +
  'pappra context <usage|statusline-plan> [options]\n' +
  `${collaborationCommandLine}`;

export async function runCli(
  args: readonly string[],
  output: CliOutput,
): Promise<number> {
  const jsonRequested = args.includes('--json');
  const direct = routeDirect(args, output);
  if (direct !== null) return direct;
  let parsed: ReturnType<typeof parseOptions>;
  try {
    parsed = parseOptions(args);
  } catch (error) {
    failure(output, jsonRequested, 'invalid_arguments', error);
    return 2;
  }
  const { values, command, collaborationAction } = parsed;
  const json = values.json === true;
  if (values.takeover && (command !== 'resume' || json)) {
    failure(
      output,
      json,
      'invalid_arguments',
      '--takeover is only available with resume and cannot be combined with --json.',
    );
    return 2;
  }
  const interactive = isInteractiveTerminal({
    json,
    noInteractive: values['no-interactive'] === true,
  });
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
    (values['print-choices'] === true ||
      values['no-runtime'] === true ||
      values.reconfigure === true)
  ) {
    failure(
      output,
      json,
      'invalid_arguments',
      '--print-choices, --no-runtime and --reconfigure are only valid for init.',
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
      values.observe === true ||
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

  const context = { parsed, info, json, interactive, output };
  const workspace = routeWorkspace(context);
  if (workspace !== null) return workspace;
  const continuity = routeContinuity(context);
  if (continuity !== null) return continuity;
  const services = routeServices(context, args);
  if (services !== null) return services;

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
  if (!values.help && interactive) {
    return runHomeCommand({ cwd: process.cwd() }, output);
  }
  if (values.help) {
    if (json) {
      output.stdout(
        `${JSON.stringify({ ...info, usage: globalUsage, commands: ['init', 'onboard', 'doctor', 'repair', 'docs', 'checkpoint', 'resume', 'code', 'host', 'runtime', 'task', 'mcp', 'collab', 'session'] })}\n`,
      );
    } else {
      output.stdout(
        `${info.name} ${info.version}\n${info.description}\n\nUsage:\n  ${globalUsage.replaceAll('\n', '\n  ')}\n\nOptions:\n  -h, --help     Show help\n  -v, --version  Show version\n      --json     Output JSON\n      --no-interactive  Never prompt (also off with --json, CI or no TTY)\n\nRun pappra with no arguments on a terminal for guided setup or the workspace menu.\n\nCommands:\n  init           Plan workspace initialization\n  onboard        Discover and connect supported hosts\n  doctor         Read-only workspace and installation diagnostics\n  repair         Inspect and repair interrupted state\n  docs           Scan, relocate, forget and inspect knowledge\n  runtime        Install, verify and remove durable runtimes\n  task           Select a private task and auto-resume preference\n  mcp            Serve workspace tools over stdio\n`,
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
