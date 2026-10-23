import path from 'node:path';
import {
  applySessionTransition,
  loadSessionTransitionRequest,
  planSessionTransition,
  type SessionTransitionAction,
  type SessionTransitionDependencies,
  type SessionTransitionReport,
} from '../../app/collab-session-transition.js';
import type { CliOutput } from '../output.js';

export const collaborationTransitionUsage =
  'pappra collab transition <plan|apply> --task-root <abs> --request <abs request.json> [--json]\n\n' +
  'Plan is read-only. Apply resumes one guarded durable transition stage at a time.\n' +
  'Pi idle/settled events, a managed freeze latch and transcript data are not native\n' +
  'quiescence proof. Unsupported host proof blocks before successor launch or claim\n' +
  'transfer. ACK and first-work messages must be registered and applied; task retirement\n' +
  'writes a reversible marker only and never archives the native Pi session.';

export interface CollaborationTransitionOptions {
  readonly action: SessionTransitionAction | null;
  readonly taskRoot: string | null;
  readonly requestFile: string | null;
  readonly json: boolean;
}

function emitHuman(report: SessionTransitionReport, output: CliOutput): void {
  output.stdout(
    `Session transition ${report.action}: ${report.status}${report.code === null ? '' : ` (${report.code})`}.\n`,
  );
  if (report.message !== null) output.stdout(`  ${report.message}\n`);
  output.stdout(
    `  task: ${report.task_id ?? '<unavailable>'} (${report.task_root})\n`,
  );
  output.stdout(
    `  transition: ${report.transition_id || '<unavailable>'}; stage: ${report.stage}\n`,
  );
  if (report.next_action !== null)
    output.stdout(`  next: ${report.next_action}\n`);
  if (report.steps.length > 0) {
    output.stdout('  stages:\n');
    for (const item of report.steps)
      output.stdout(
        `    ${item.step}: ${item.status}${item.code === null ? '' : ` (${item.code})`}${item.detail === null ? '' : ` — ${item.detail}`}\n`,
      );
  }
  if (report.route_transfer !== null)
    output.stdout(`  route/claims: ${JSON.stringify(report.route_transfer)}\n`);
  if (report.first_work !== null)
    output.stdout(`  first work: ${JSON.stringify(report.first_work)}\n`);
  if (report.archive !== null)
    output.stdout(`  retirement: ${JSON.stringify(report.archive)}\n`);
  output.stdout(
    `  capabilities: quiescence ${report.capabilities.supported_quiescence}, native archive ${report.capabilities.native_session_archive}, route exclusion ${report.capabilities.notification_route_exclusion}\n`,
  );
  if (report.limits.length > 0)
    output.stdout(`  limits: ${report.limits.join('; ')}\n`);
}

function invalid(
  options: CollaborationTransitionOptions,
  output: CliOutput,
  code: string,
  message: string,
): number {
  if (options.json)
    output.stdout(
      `${JSON.stringify({ ok: false, status: 'invalid', code, message })}\n`,
    );
  else {
    output.stderr(`pappra: ${message}\n`);
    output.stderr(`${collaborationTransitionUsage}\n`);
  }
  return 2;
}

export async function runCollaborationTransitionCommand(
  options: CollaborationTransitionOptions,
  output: CliOutput,
  dependencies: SessionTransitionDependencies = {},
): Promise<number> {
  if (options.action === null)
    return invalid(
      options,
      output,
      'transition_action_required',
      'collab transition requires plan or apply.',
    );
  if (options.taskRoot === null || options.requestFile === null)
    return invalid(
      options,
      output,
      'required_option_missing',
      'collab transition requires --task-root and --request.',
    );
  if (
    !path.isAbsolute(options.taskRoot) ||
    !path.isAbsolute(options.requestFile)
  )
    return invalid(
      options,
      output,
      'absolute_path_required',
      '--task-root and --request must be absolute paths.',
    );

  const loaded = loadSessionTransitionRequest(options.requestFile);
  if (!loaded.ok) {
    if (options.json)
      output.stdout(
        `${JSON.stringify({ ok: false, status: loaded.kind, code: loaded.code, message: loaded.message, next_action: loaded.next_action })}\n`,
      );
    else {
      output.stderr(`${loaded.code}: ${loaded.message}\n`);
      if (loaded.next_action !== null) output.stderr(`${loaded.next_action}\n`);
    }
    return 2;
  }
  if (
    path.resolve(loaded.value.request.task_root) !==
    path.resolve(options.taskRoot)
  )
    return invalid(
      options,
      output,
      'task_root_mismatch',
      'The request task_root does not equal --task-root.',
    );

  const report =
    options.action === 'plan'
      ? await planSessionTransition(loaded.value, dependencies)
      : await applySessionTransition(loaded.value, dependencies);
  if (options.json) output.stdout(`${JSON.stringify(report)}\n`);
  else emitHuman(report, output);
  if (report.status === 'invalid') return 2;
  if (report.action === 'apply' && report.status === 'waiting') return 1;
  return report.ok ? 0 : 1;
}
