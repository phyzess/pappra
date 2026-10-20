import { parseArgs } from 'node:util';
import { getPackageInfo } from '../package-info.js';
import { initUsage, runInitCommand } from './commands/init.js';
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
  collaborationUsage,
  runCollaborationCommand,
} from './commands/collaboration.js';
import { hostUsage, runHostCommand } from './commands/host.js';
import { hostNameSchema } from '../schemas/host.js';
import type { CliOutput } from './output.js';

function parseOptions(args: readonly string[]) {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      json: { type: 'boolean' },
      config: { type: 'string' },
      apply: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      'no-interactive': { type: 'boolean' },
      'print-choices': { type: 'boolean' },
      'install-runtime': { type: 'boolean' },
      'runtime-tarball': { type: 'string' },
      'runtime-version': { type: 'string' },
      root: { type: 'string' },
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
      'domain-root': { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help && values.version) {
    throw new Error('Use either --help or --version, not both.');
  }
  const command = positionals[0] ?? null;
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
      collaborationAction: null,
      resumeTaskId: null,
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
      collaborationAction: null,
      resumeTaskId: positionals[1] ?? null,
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
      collaborationAction: null,
      resumeTaskId: null,
    };
  }
  if (command === 'host') {
    if (positionals.length > 2) {
      throw new Error(
        'host accepts one action: detect, describe, plan, install, or verify.',
      );
    }
    return {
      values,
      command,
      docsAction: null,
      docsArgument: null,
      codeAction: null,
      hostAction: positionals[1] ?? null,
      collaborationAction: null,
      resumeTaskId: null,
    };
  }
  if (command === 'collab') {
    if (positionals.length > 2) {
      throw new Error('collab accepts one action: prepare, run, or query.');
    }
    return {
      values,
      command,
      docsAction: null,
      docsArgument: null,
      codeAction: null,
      hostAction: null,
      collaborationAction: positionals[1] ?? null,
      resumeTaskId: null,
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
  };
}

function failure(
  output: CliOutput,
  json: boolean,
  code: string,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : 'Operation failed.';
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
  'pappra init [--config <file> | --yes] [--apply] [--json] [--print-choices]\n' +
  '              [--install-runtime (--runtime-tarball <file> | --runtime-version <version>)]\n' +
  'pappra doctor [--root <path>] [--json]\n' +
  'pappra docs <list|check|archive> [options]\n' +
  'pappra checkpoint --task <id> [options] [--json]\n' +
  'pappra resume <taskId> [--session <id>] [--json]\n' +
  'pappra code <status|prepare|query> --repo <id> [options] [--json]\n' +
  'pappra host <detect|describe|plan|install|verify> --host <name> [options] [--json]\n' +
  'pappra collab <prepare|run|query> [options]';

export async function runCli(
  args: readonly string[],
  output: CliOutput,
): Promise<number> {
  const jsonRequested = args.includes('--json');
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
  } = parsed;
  const json = values.json === true;

  if (
    command !== 'init' &&
    (values.yes === true ||
      values['no-interactive'] === true ||
      values['print-choices'] === true)
  ) {
    failure(
      output,
      json,
      'invalid_arguments',
      '--yes, --no-interactive and --print-choices are only valid for init.',
    );
    return 2;
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

  if (command === 'collab') {
    if (values.help) {
      if (json) {
        output.stdout(
          `${JSON.stringify({ ...info, commands: ['collab'], usage: collaborationUsage })}\n`,
        );
      } else {
        output.stdout(collaborationUsage);
      }
      return 0;
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
      },
      output,
    );
  }

  if (command === 'docs') {
    if (
      values.version ||
      values.config !== undefined ||
      values.apply === true ||
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
        'docs only accepts list/check/archive, --include-private, --include-archived, --help, and --json.',
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
    ] as const;
    const action = allowedActions.find((item) => item === hostAction) ?? null;
    const parsedHost = hostNameSchema.safeParse(values.host);
    const host = parsedHost.success ? parsedHost.data : null;
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
      (values.apply === true && action !== 'install') ||
      (values['host-root'] !== undefined && action === null) ||
      (values['host-version'] !== undefined && action === null);
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
        'host requires detect/describe/plan/install/verify, --host, and action-compatible options.',
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
        `${JSON.stringify({ ...info, usage: globalUsage, commands: ['init', 'doctor', 'docs', 'checkpoint', 'resume', 'code', 'host', 'collab'] })}\n`,
      );
    } else {
      output.stdout(
        `${info.name} ${info.version}\n${info.description}\n\nUsage:\n  ${globalUsage.replaceAll('\n', '\n  ')}\n\nOptions:\n  -h, --help     Show help\n  -v, --version  Show version\n      --json     Output JSON\n\nCommands:\n  init           Plan workspace initialization\n  doctor         Read-only workspace and installation diagnostics\n  docs           List, check, and archive registered documents\n`,
      );
      output.stdout(
        '  checkpoint     Save a private task checkpoint\n  resume         Read a bounded recovery packet without starting an agent\n  code           Inspect or prepare selected code intelligence\n  host           Detect, plan, install, or verify a selected host integration\n  collab         Prepare, run, or query a bounded collaboration goal\n',
      );
    }
    return 0;
  }
  if (json) {
    output.stdout(
      `${JSON.stringify({ ...info, usage: globalUsage, commands: ['init', 'doctor', 'docs', 'checkpoint', 'resume', 'code', 'host', 'collab'] })}\n`,
    );
  } else {
    output.stdout(
      `${info.name} ${info.version}\n${info.description}\n\nUsage:\n  ${globalUsage}\n\nRun pappra --help for all options.\n`,
    );
  }
  return 0;
}
