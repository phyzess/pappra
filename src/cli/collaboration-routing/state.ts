import { failure } from '../options.js';
import {
  collaborationStateUsage,
  runCollaborationStateCommand,
} from '../commands/collaboration-state.js';
import type { RoutingContext } from './context.js';

export async function handleState(
  context: RoutingContext,
): Promise<number | null> {
  const { values, args, output, json, action: collaborationAction } = context;
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
  return null;
}
