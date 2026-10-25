import { failure, hasContinuityOptions } from '../options.js';
import {
  collaborationRecoveryRunUsage,
  parseCollaborationRecoveryRunArgs,
  runCollaborationRecoveryRunCommand,
} from '../commands/collaboration-recovery-run.js';
import {
  collaborationWorkRunUsage,
  parseCollaborationWorkRunArgs,
  runCollaborationWorkRunCommand,
} from '../commands/collaboration-work-run.js';
import { runCollaborationCommand } from '../commands/collaboration.js';
import type { RoutingContext } from './context.js';

export async function handleWorkRun(
  context: RoutingContext,
): Promise<number | null> {
  const { values, args, output, json, action: collaborationAction } = context;
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
  return null;
}

export async function handleRecoveryRun(
  context: RoutingContext,
): Promise<number | null> {
  const { values, args, output, json, action: collaborationAction } = context;
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
  return null;
}

export async function handleDirectRun(
  context: RoutingContext,
): Promise<number | null> {
  const {
    values,
    output,
    json,
    action: collaborationAction,
    rpcRequestTimeout,
    rpcOperationTimeout,
  } = context;
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
  return null;
}
