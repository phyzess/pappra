import { failure } from '../options.js';
import {
  collaborationResourcesUsage,
  runCollaborationResourcesCommand,
} from '../commands/collaboration-resources.js';
import type { RoutingContext } from './context.js';

export async function handleResources(
  context: RoutingContext,
): Promise<number | null> {
  const { values, args, output, json, action: collaborationAction } = context;
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
  return null;
}
