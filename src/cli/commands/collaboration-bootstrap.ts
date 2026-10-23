import path from 'node:path';
import {
  applyVisibleBootstrap,
  loadVisibleBootstrapRequest,
  planVisibleBootstrap,
  type BootstrapAction,
  type VisibleBootstrapDependencies,
  type VisibleBootstrapReport,
} from '../../app/collab-bootstrap.js';
import type { CliOutput } from '../output.js';

export const collaborationBootstrapUsage =
  'pappra collab bootstrap <plan|apply> --task-root <abs> --request <abs request.json> [--json]\n\n' +
  'Plan is read-only. Apply performs one durable, visible Pi sibling launch or an\n' +
  'explicitly verified task-bound reuse. Readiness is not authorization, and a\n' +
  'submitted message is not receiver acceptance. Unknown outcomes are reconciled,\n' +
  'never retried automatically.';

export interface CollaborationBootstrapOptions {
  readonly action: BootstrapAction | null;
  readonly taskRoot: string | null;
  readonly requestFile: string | null;
  readonly json: boolean;
}

function emitHuman(report: VisibleBootstrapReport, output: CliOutput): void {
  output.stdout(
    `Bootstrap ${report.action}: ${report.status}${report.code === null ? '' : ` (${report.code})`}.\n`,
  );
  if (report.message !== null) output.stdout(`  ${report.message}\n`);
  if (report.request_id !== null)
    output.stdout(`  request: ${report.request_id}\n`);
  if (report.task_id !== null) output.stdout(`  task: ${report.task_id}\n`);
  if (report.target !== null && typeof report.target['choice'] === 'string')
    output.stdout(
      `  target: ${report.target['choice']}${typeof report.target['pane_id'] === 'string' ? ` ${report.target['pane_id']}` : ''}\n`,
    );
  if (report.next_action !== null)
    output.stdout(`  next: ${report.next_action}\n`);
  if (report.effects.length > 0) {
    output.stdout('  effects:\n');
    for (const effect of report.effects)
      output.stdout(
        `    ${effect.step}: ${effect.status}${effect.detail === null ? '' : ` — ${effect.detail}`}\n`,
      );
  }
  if (report.limits.length > 0)
    output.stdout(`  limits: ${report.limits.join(', ')}\n`);
}

function exitCode(report: VisibleBootstrapReport): number {
  if (
    report.status === 'planned' ||
    report.status === 'applied' ||
    report.status === 'already_recorded'
  )
    return 0;
  if (report.status === 'invalid') return 2;
  return 1;
}

export async function runCollaborationBootstrapCommand(
  options: CollaborationBootstrapOptions,
  output: CliOutput,
  dependencies: VisibleBootstrapDependencies = {},
): Promise<number> {
  if (options.action === null) {
    output.stderr(
      `pappra collab bootstrap requires plan or apply.\n${collaborationBootstrapUsage}\n`,
    );
    return 2;
  }
  if (options.taskRoot === null || options.requestFile === null) {
    const message =
      'collab bootstrap requires --task-root <absolute> and --request <absolute request.json>.';
    if (options.json)
      output.stdout(
        `${JSON.stringify({ ok: false, status: 'invalid', code: 'required_option_missing', message })}\n`,
      );
    else output.stderr(`${message}\n${collaborationBootstrapUsage}\n`);
    return 2;
  }
  if (
    !path.isAbsolute(options.taskRoot) ||
    !path.isAbsolute(options.requestFile)
  ) {
    const message = '--task-root and --request must be absolute paths.';
    if (options.json)
      output.stdout(
        `${JSON.stringify({ ok: false, status: 'invalid', code: 'absolute_path_required', message })}\n`,
      );
    else output.stderr(`${message}\n`);
    return 2;
  }
  const loaded = loadVisibleBootstrapRequest(options.requestFile);
  if (!loaded.ok) {
    if (options.json)
      output.stdout(
        `${JSON.stringify({ ok: false, status: 'invalid', code: loaded.code, message: loaded.message })}\n`,
      );
    else output.stderr(`${loaded.code}: ${loaded.message}\n`);
    return 2;
  }
  if (
    path.resolve(options.taskRoot) !==
    path.resolve(loaded.value.request.task_root)
  ) {
    const message = '--task-root does not match request.task_root.';
    if (options.json)
      output.stdout(
        `${JSON.stringify({ ok: false, status: 'invalid', code: 'task_root_mismatch', message })}\n`,
      );
    else output.stderr(`${message}\n`);
    return 2;
  }
  const report =
    options.action === 'plan'
      ? await planVisibleBootstrap(loaded.value, dependencies)
      : await applyVisibleBootstrap(loaded.value, dependencies);
  if (options.json) output.stdout(`${JSON.stringify(report)}\n`);
  else emitHuman(report, output);
  return exitCode(report);
}
