import {
  checkpointUsage,
  resumeUsage,
  runCheckpointCommand,
  runResumeCommand,
} from '../commands/continuity.js';
import { failure, hasContinuityOptions } from '../options.js';
import type { CliRouteResult, CliRoutingContext } from './context.js';

export function routeContinuity({
  parsed,
  info,
  json,
  interactive,
  output,
}: CliRoutingContext): CliRouteResult {
  const { values, command, resumeTaskId } = parsed;
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
      (resumeTaskId === null && (!interactive || values.takeover === true))
    ) {
      failure(
        output,
        json,
        'invalid_arguments',
        values.takeover
          ? 'resume --takeover requires one task id and accepts --session.'
          : 'resume requires one task id and accepts only --session.',
      );
      return 2;
    }
    return runResumeCommand(
      {
        cwd: process.cwd(),
        json,
        taskId: resumeTaskId,
        currentSession: values.session ?? process.env.PI_SESSION_ID ?? null,
        interactive,
        takeover: values.takeover === true,
      },
      output,
    );
  }
  return null;
}
