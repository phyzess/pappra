import { failure, hasContinuityOptions } from '../options.js';
import {
  collaborationMessageUsage,
  runCollaborationMessageCommand,
  type CollaborationMessageAction,
} from '../commands/collaboration-message.js';
import type { RoutingContext } from './context.js';

export async function handleMessages(
  context: RoutingContext,
): Promise<number | null> {
  const { values, output, json, action: collaborationAction } = context;
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
  return null;
}
