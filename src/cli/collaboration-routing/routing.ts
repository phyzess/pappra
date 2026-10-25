import { failure } from '../options.js';
import {
  collaborationBindingUsage,
  runCollaborationBindingCommand,
} from '../commands/collaboration-binding.js';
import {
  collaborationPlanUsage,
  runCollaborationPlanCommand,
} from '../commands/collaboration-plan.js';
import {
  collaborationRolloverUsage,
  runCollaborationRolloverCommand,
} from '../commands/collaboration-rollover.js';
import {
  collaborationTransitionUsage,
  runCollaborationTransitionCommand,
} from '../commands/collaboration-transition.js';
import type { RoutingContext } from './context.js';

export async function handleBinding(
  context: RoutingContext,
): Promise<number | null> {
  const { values, args, output, json, action: collaborationAction } = context;
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
  return null;
}

export async function handleTransition(
  context: RoutingContext,
): Promise<number | null> {
  const { values, args, output, json, action: collaborationAction } = context;
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
  return null;
}

export async function handleRollover(
  context: RoutingContext,
): Promise<number | null> {
  const { values, args, output, json, action: collaborationAction } = context;
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
  return null;
}

export async function handlePlan(
  context: RoutingContext,
): Promise<number | null> {
  const { values, args, output, json, action: collaborationAction } = context;
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
  return null;
}
