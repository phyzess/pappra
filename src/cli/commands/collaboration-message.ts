import {
  listMessagesForTaskRoot,
  readMessageFromTaskRoot,
  sendMessageFromFile,
  type MessageServiceFailure,
} from '../../app/collab-messages.js';
import { notifyRegisteredMessage } from '../../app/collab-notify.js';
import type { CliOutput } from '../output.js';

export const collaborationMessageUsage =
  'pappra collab message <send|list|read|notify> --task-root <dir> [options]\n' +
  '  send   --message <abs envelope.json> [--apply]\n' +
  '  list   [--limit <1-100>]\n' +
  '  read   --message-id <id>\n' +
  '  notify --message-id <id> --binding <abs binding.json> [--caller-pane <id>] [--apply] [--retry]\n\n' +
  'send plans by default and persists only with --apply; it never notifies.\n' +
  'notify forwards one registered pointer through the Herdr CLI without --wait and\n' +
  'requires a task-local binding that matches the recipient and live agent metadata.';

export type CollaborationMessageAction = 'send' | 'list' | 'read' | 'notify';

export interface CollaborationMessageOptions {
  readonly cwd: string;
  readonly action: CollaborationMessageAction | null;
  readonly taskRoot: string | null;
  readonly messageFile: string | null;
  readonly messageId: string | null;
  readonly bindingFile: string | null;
  readonly apply: boolean;
  readonly retry: boolean;
  readonly limit: string | null;
  readonly callerPane: string | null;
  readonly json: boolean;
}

const CALLER_PANE_PATTERN = /^[A-Za-z0-9]+:p[A-Za-z0-9]+$/;

const SUCCESS_STATUSES = new Set([
  'planned',
  'accepted',
  'duplicate',
  'submitted',
  'already_recorded',
]);

function emit(
  output: CliOutput,
  json: boolean,
  payload: Record<string, unknown>,
  lines: readonly string[],
  exitCode: number,
): number {
  if (json) {
    output.stdout(`${JSON.stringify(payload)}\n`);
  } else {
    for (const line of lines) output.stdout(`${line}\n`);
  }
  return exitCode;
}

function usageFailure(
  output: CliOutput,
  options: CollaborationMessageOptions,
  code: string,
  message: string,
): number {
  return emit(
    output,
    options.json,
    { schema: 'pappra/collaboration-message/1', ok: false, code, message },
    [`pappra collab message: ${message}`],
    2,
  );
}

function serviceFailure(
  output: CliOutput,
  options: CollaborationMessageOptions,
  failure: MessageServiceFailure,
): number {
  if (options.json) {
    output.stdout(
      `${JSON.stringify({
        schema: 'pappra/collaboration-message/1',
        ok: false,
        action: options.action,
        code: failure.code,
        message: failure.message,
        nextAction: failure.nextAction,
      })}\n`,
    );
  } else {
    output.stderr(`pappra collab message: ${failure.message}\n`);
    if (failure.nextAction !== null) {
      output.stderr(`  next: ${failure.nextAction}\n`);
    }
  }
  return 1;
}

export async function runCollaborationMessageCommand(
  options: CollaborationMessageOptions,
  output: CliOutput,
): Promise<number> {
  if (options.action === null) {
    return usageFailure(
      output,
      options,
      'action_required',
      'collab message requires send, list, read, or notify.',
    );
  }
  const taskRoot = options.taskRoot;
  if (taskRoot === null) {
    return usageFailure(
      output,
      options,
      'task_root_required',
      'collab message requires an absolute --task-root.',
    );
  }

  if (options.action === 'send') {
    if (options.messageFile === null) {
      return usageFailure(
        output,
        options,
        'message_required',
        'collab message send requires --message <abs envelope.json>.',
      );
    }
    const result = await sendMessageFromFile(taskRoot, options.messageFile, {
      apply: options.apply,
    });
    if (!result.ok) return serviceFailure(output, options, result);
    const value = result.value;
    const payload = {
      schema: 'pappra/collaboration-message/1',
      ok: value.status !== 'conflict' && value.status !== 'rejected',
      action: 'send',
      applied: options.apply,
      status: value.status,
      message: value.message,
      registrationStatus: value.registrationStatus,
      stateRevision: value.stateRevision,
      messagePath: value.messagePath,
      digest: value.digest,
      detail: value.detail,
      delivery: value.delivery,
      notified: value.notified,
      taskAccepted: value.taskAccepted,
    };
    const ok = payload.ok;
    return emit(
      output,
      options.json,
      payload,
      ok
        ? [
            `Message ${value.message.message_id} ${value.status}; delivery ${value.delivery}.`,
            ...(value.messagePath === null
              ? []
              : [`  file: ${value.messagePath}`]),
            ...(value.digest === null ? [] : [`  digest: ${value.digest}`]),
          ]
        : [
            `Message ${value.message.message_id} ${value.status}: ${String(value.detail)}`,
          ],
      ok ? 0 : 1,
    );
  }

  if (options.action === 'list') {
    const parsedLimit = (() => {
      if (options.limit === null) return 20;
      const value = Number(options.limit);
      return Number.isSafeInteger(value) ? value : Number.NaN;
    })();
    if (Number.isNaN(parsedLimit)) {
      return usageFailure(
        output,
        options,
        'limit_invalid',
        '--limit must be a positive integer.',
      );
    }
    const result = await listMessagesForTaskRoot(taskRoot, {
      limit: parsedLimit,
    });
    if (!result.ok) return serviceFailure(output, options, result);
    const value = result.value;
    return emit(
      output,
      options.json,
      {
        schema: 'pappra/collaboration-message/1',
        ok: true,
        action: 'list',
        ...value,
      },
      [
        `Messages ${value.returned}/${value.total}${value.truncated ? ' (truncated)' : ''}`,
        ...value.messages.map(
          (entry) =>
            `  ${entry.message_id} ${entry.type} ${entry.state}${entry.reply_to === null ? '' : ` reply_to=${entry.reply_to}`}${entry.delivery === null ? '' : ` notification=${entry.delivery.status}`}`,
        ),
      ],
      0,
    );
  }

  if (options.action === 'read') {
    if (options.messageId === null) {
      return usageFailure(
        output,
        options,
        'message_id_required',
        'collab message read requires --message-id.',
      );
    }
    const result = await readMessageFromTaskRoot(taskRoot, options.messageId);
    if (!result.ok) return serviceFailure(output, options, result);
    const value = result.value;
    return emit(
      output,
      options.json,
      {
        schema: 'pappra/collaboration-message/1',
        ok: true,
        action: 'read',
        ...value,
      },
      [
        `${value.message.message_id} ${value.message.type} ${value.entry?.state ?? 'not-applied'}`,
        `  file: ${value.messagePath}`,
        `  digest: ${value.digest}`,
        `  notification: ${value.delivery?.status ?? 'not-notified'}`,
      ],
      0,
    );
  }

  if (
    options.callerPane !== null &&
    !CALLER_PANE_PATTERN.test(options.callerPane)
  ) {
    return usageFailure(
      output,
      options,
      'caller_pane_invalid',
      '--caller-pane must be a Herdr pane id such as w3:p1.',
    );
  }
  if (options.bindingFile === null || options.messageId === null) {
    return usageFailure(
      output,
      options,
      'notify_arguments_required',
      'collab message notify requires --message-id and --binding.',
    );
  }
  const result = await notifyRegisteredMessage({
    taskRoot,
    messageId: options.messageId,
    bindingFile: options.bindingFile,
    apply: options.apply,
    retry: options.retry,
    callerPane: options.callerPane,
  });
  if (!result.ok) return serviceFailure(output, options, result);
  const value = result.value;
  const ok = SUCCESS_STATUSES.has(value.status);
  return emit(
    output,
    options.json,
    {
      schema: 'pappra/collaboration-message/1',
      ok,
      action: 'notify',
      applied: options.apply,
      ...value,
    },
    ok
      ? [
          `Notification ${value.status}; consumed=false, taskAccepted=false.`,
          ...(value.deliveryPath === null
            ? []
            : [`  delivery: ${value.deliveryPath}`]),
        ]
      : [`Notification ${value.status}: ${String(value.detail)}`],
    ok ? 0 : 1,
  );
}
