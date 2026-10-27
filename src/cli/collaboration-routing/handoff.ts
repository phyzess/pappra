import { failure } from '../options.js';
import {
  collaborationHandoffUsage,
  runCollaborationHandoffCommand,
} from '../commands/collaboration-handoff.js';
import type { RoutingContext } from './context.js';

export async function handleHandoff(
  context: RoutingContext,
): Promise<number | null> {
  const { values, args, output, json, action: collaborationAction } = context;
  if (collaborationAction?.startsWith('handoff:')) {
    const selected = collaborationAction.slice('handoff:'.length);
    const handoffAction =
      selected === 'inventory' ||
      selected === 'check' ||
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
        : handoffAction === 'check'
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
      ...(handoffAction === 'inventory'
        ? ['subtask-id', 'attempt']
        : handoffAction === 'check'
          ? []
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
        `collab handoff accepts only inventory, check or a handoff mutation action and their own options.${
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
  return null;
}
