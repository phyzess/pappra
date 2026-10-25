import type { CliOutput } from './output.js';
import { failure, hasContinuityOptions, type CliValues } from './options.js';
import type { getPackageInfo } from '../package-info.js';
import {
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

/** Everything the collaboration router needs from one parsed command line. */
export interface CollaborationRouteRequest {
  readonly values: CliValues;
  /** The resolved `collab` action, e.g. `message:send` or `role-run`. */
  readonly action: string | null;
  /** Raw argv, for duplicate-flag detection the parser cannot observe. */
  readonly args: readonly string[];
  readonly info: ReturnType<typeof getPackageInfo>;
  readonly rpcRequestTimeout: string | undefined;
  readonly rpcOperationTimeout: string | undefined;
  readonly output: CliOutput;
  readonly json: boolean;
}

export async function routeCollaboration(
  request: CollaborationRouteRequest,
): Promise<number> {
  const { values, args, info, output, json } = request;
  const {
    action: collaborationAction,
    rpcRequestTimeout,
    rpcOperationTimeout,
  } = request;
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
                        : collaborationAction?.startsWith('recovery:') === true
                          ? collaborationRecoveryUsage
                          : collaborationAction?.startsWith('binding:') === true
                            ? collaborationBindingUsage
                            : collaborationAction === 'plan'
                              ? collaborationPlanUsage
                              : collaborationAction?.startsWith('rollover:') ===
                                    true || collaborationAction === 'rollover'
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
      selected === 'show' || selected === 'doctor' || selected === 'epoch-check'
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
      [...provided].every((flag) => allowedByAction[messageAction].has(flag)) &&
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
