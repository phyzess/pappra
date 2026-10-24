import {
  loadRoleRunRequest,
  watchRoleOrchestration,
} from '../../app/collab-role-events.js';
import { tickRoleOrchestration } from '../../app/collab-role-orchestration.js';
import { expandRolePlan } from '../../app/collab-role-plan.js';
import { inspectWorkPlan } from '../../app/collab-work-plan.js';
import { readBoundedFile } from '../../app/bounded-file.js';
import { canonicalJson } from '../../collab/envelope.js';
import type { CliOutput } from '../output.js';
import { managedPiRepairDependencies } from '../../app/managed-pi-repair-stop.js';

export const collaborationRoleRunUsage =
  'pappra collab role-run --request <abs role-orchestration.json> [--apply] [--watch] [--json]\n\n' +
  'Plan reads authoritative role/dependency state without effects. Apply handles one\n' +
  'bounded event tick, reserves before dispatch and never infers acceptance.\n' +
  '--watch requires --apply and re-evaluates on relevant task/request/capability events.\n' +
  'Repeated or ambiguous effects are reconciled; rejected work requires an authorized repair attempt.';

const PUBLIC_ERRORS = new Set([
  'role_request_required',
  'role_request_invalid',
  'role_request_invalid_json',
  'role_request_path_not_absolute',
  'role_request_symlink',
  'role_request_not_regular',
  'role_request_too_large',
  'role_request_unreadable',
  'role_plan_file_mismatch',
  'watch_requires_apply',
  'role_event_request_path_not_absolute',
  'role_event_task_unavailable',
  'role_event_task_root_mismatch',
  'role_event_watch_initialization_failed',
]);

function safeErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'role_run_failed';
  return PUBLIC_ERRORS.has(error.message) ? error.message : 'role_run_failed';
}

export async function runCollaborationRoleRunCommand(
  options: {
    readonly requestFile: string | null;
    readonly apply: boolean;
    readonly watch?: boolean;
    readonly json: boolean;
  },
  output: CliOutput,
  deps: { readonly watch?: typeof watchRoleOrchestration } = {},
): Promise<number> {
  const emit = (value: unknown) =>
    output.stdout(
      `${JSON.stringify(value, null, options.json ? undefined : 2)}\n`,
    );
  try {
    if (options.watch && !options.apply)
      throw new Error('watch_requires_apply');
    if (!options.requestFile) throw new Error('role_request_required');
    if (options.watch) {
      return await runWatch(
        options.requestFile,
        emit,
        deps.watch ?? watchRoleOrchestration,
      );
    }

    const request = loadRoleRunRequest(options.requestFile);
    if (!options.apply) {
      const expanded = expandRolePlan(request.role_plan);
      if (!expanded.ok) {
        emit(expanded);
        return 2;
      }
      const plan = readBoundedFile(request.execution.plan_file, 512 * 1024);
      if (
        !plan.ok ||
        canonicalJson(JSON.parse(plan.text)) !== canonicalJson(expanded.plan)
      )
        throw new Error('role_plan_file_mismatch');
      const report = await inspectWorkPlan({
        taskRoot: request.execution.task_root,
        planFile: request.execution.plan_file,
      });
      emit({
        schema: 'pappra/collab-role-orchestration-plan/1',
        status: report.ok ? 'planned' : 'blocked',
        effect: 'none',
        inspection: report,
      });
      return report.ok ? 0 : 1;
    }
    const repair = managedPiRepairDependencies(request);
    const report = await tickRoleOrchestration(
      request,
      repair ? { repair } : {},
    );
    emit(report);
    return [
      'blocked',
      'reconciliation-required',
      'repair-required',
      'repair-exhausted',
      'budget-exhausted',
    ].includes(report.status)
      ? 1
      : 0;
  } catch (error) {
    emit({ ok: false, status: 'invalid', code: safeErrorCode(error) });
    return 2;
  }
}

async function runWatch(
  requestFile: string,
  emit: (value: unknown) => void,
  watch: typeof watchRoleOrchestration,
): Promise<number> {
  emit({
    schema: 'pappra/collab-role-orchestration-watch/1',
    status: 'watching',
  });
  let resolveStop: ((code: number) => void) | null = null;
  let stopped = false;
  const stop = new Promise<number>((resolve) => {
    resolveStop = resolve;
  });
  const onSignal = (code: number) => () => {
    if (stopped) return;
    stopped = true;
    resolveStop?.(code);
  };
  const onInterrupt = onSignal(130);
  const onTerminate = onSignal(143);
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  let watcher: Awaited<ReturnType<typeof watchRoleOrchestration>> | null = null;
  try {
    watcher = await watch(requestFile, (result) => emit(result));
    const signalCode = await stop;
    const status = watcher.status();
    emit({
      schema: 'pappra/collab-role-orchestration-watch/1',
      status: 'stopped',
      result: status.result,
      error: status.error,
    });
    return signalCode;
  } finally {
    try {
      if (watcher) await watcher.close();
    } finally {
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
    }
  }
}
