import { resolveWorkspaceRoot } from '../../workspace/resolve.js';
import {
  pinTask,
  readAutoResume,
  readTaskPin,
  setAutoResume,
  unpinTask,
} from '../../app/task-pin.js';
import type { CliOutput } from '../output.js';

export const taskUsage =
  'pappra task <pin|unpin|show> [taskId] [--auto-resume] [--json]\n\n' +
  'pin records the current task in .pappra/local/current-task. Hooks inject a resume\n' +
  'packet only when the workspace continuity.autoResume switch is on (--auto-resume).';

export interface TaskCommandOptions {
  readonly cwd: string;
  readonly action: 'pin' | 'unpin' | 'show' | null;
  readonly taskId: string | null;
  readonly autoResume: boolean;
  readonly json: boolean;
}

function failure(
  output: CliOutput,
  options: TaskCommandOptions,
  message: string,
): number {
  if (options.json) {
    output.stdout(
      `${JSON.stringify({ ok: false, code: 'task_invalid', message })}\n`,
    );
  } else {
    output.stderr(`pappra task: ${message}\n`);
  }
  return 2;
}

export async function runTaskCommand(
  options: TaskCommandOptions,
  output: CliOutput,
): Promise<number> {
  const resolution = await resolveWorkspaceRoot({ startPath: options.cwd });
  const root = resolution.root;
  if (root === null) {
    return failure(
      output,
      options,
      'task requires a registered Pappra workspace above the current directory.',
    );
  }
  if (options.action === 'pin') {
    if (options.taskId === null) {
      return failure(output, options, 'task pin requires a task id.');
    }
    const pinned = await pinTask(root, options.taskId);
    if ('message' in pinned) {
      return failure(output, options, pinned.message);
    }
    if (options.autoResume) {
      const switched = await setAutoResume(root, true);
      if ('message' in switched) {
        return failure(output, options, switched.message);
      }
    }
    const report = {
      ok: true,
      action: 'pin',
      task: pinned.taskId,
      autoResume: options.autoResume ? true : await readAutoResume(root),
    };
    output.stdout(
      options.json
        ? `${JSON.stringify(report)}\n`
        : `Pinned task ${report.task}; autoResume ${report.autoResume ? 'on' : 'off'}.\n`,
    );
    return 0;
  }
  if (options.action === 'unpin') {
    await unpinTask(root);
    const report = { ok: true, action: 'unpin' };
    output.stdout(
      options.json
        ? `${JSON.stringify(report)}\n`
        : 'Task pin removed; autoResume stays unchanged.\n',
    );
    return 0;
  }
  if (options.action === 'show') {
    const pin = await readTaskPin(root);
    const report = {
      ok: true,
      action: 'show',
      pin,
      autoResume: await readAutoResume(root),
    };
    output.stdout(
      options.json
        ? `${JSON.stringify(report)}\n`
        : pin === null
          ? `No task pin; autoResume ${report.autoResume ? 'on' : 'off'}.\n`
          : `Pinned task ${pin.taskId} at ${pin.pinnedAt}; autoResume ${report.autoResume ? 'on' : 'off'}.\n`,
    );
    return 0;
  }
  if (options.json) {
    output.stdout(
      `${JSON.stringify({ commands: ['pin', 'unpin', 'show'], usage: taskUsage })}\n`,
    );
  } else {
    output.stdout(taskUsage);
  }
  return 0;
}
