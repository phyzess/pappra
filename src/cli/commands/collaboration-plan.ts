import path from 'node:path';
import {
  COLLAB_WORK_PLAN_REPORT_SCHEMA,
  inspectWorkPlan,
  type WorkPlanReport,
} from '../../app/collab-work-plan.js';
import type { CliOutput } from '../output.js';

export const collaborationPlanUsage =
  'pappra collab plan --task-root <abs> --config <abs plan.json> [--json]\n\n' +
  'Read-only role and dependency evaluation of one persisted work-plan document\n' +
  'against the authoritative task record. Nothing is claimed, dispatched, launched,\n' +
  'refreshed or written, and no prompt, network call or model call is made.\n\n' +
  'Plan nodes correlate to the existing task protocol by\n' +
  'node.assignment_id == attempt.subtask_id; there is no second assignment registry.\n' +
  'A ready node is not authorization to run it.\n\n' +
  'Exit 0 evaluated snapshot (normal waiting and blocked nodes included),\n' +
  '1 incomplete or unavailable authoritative evidence, 2 invalid request/plan.';

export interface CollaborationPlanOptions {
  readonly taskRoot: string | null;
  readonly planFile: string | null;
  readonly json: boolean;
}

function invalid(
  output: CliOutput,
  options: CollaborationPlanOptions,
  errors: readonly string[],
): number {
  if (options.json) {
    output.stdout(
      `${JSON.stringify({
        schema: COLLAB_WORK_PLAN_REPORT_SCHEMA,
        ok: false,
        status: 'invalid',
        task_root: options.taskRoot,
        task_id: null,
        plan: {
          ref: options.planFile,
          digest: null,
          plan_id: null,
          owner_epoch: null,
          node_count: null,
        },
        stale: false,
        summary: null,
        nodes: [],
        core: null,
        evidence: {
          registered_decisions: 0,
          supplied: 0,
          envelope_bytes: 0,
          unreadable: [],
          truncated: false,
        },
        diagnostics: errors.map((error) => ({
          code: 'invalid_arguments',
          detail: error,
          next_action: collaborationPlanUsage,
        })),
        identity_mapping:
          'plan.nodes[].assignment_id corresponds to the existing task subtask identity (record.attempts[].subtask_id); no separate assignment registry exists.',
        limits: ['persisted_snapshot_only', 'not_an_authorization'],
      })}\n`,
    );
  } else {
    output.stdout('Plan request invalid.\n');
    for (const error of errors) output.stdout(`  - ${error}\n`);
    output.stdout(`\n${collaborationPlanUsage}\n`);
  }
  return 2;
}

function emitHuman(report: WorkPlanReport, output: CliOutput): void {
  const planLabel = report.plan.plan_id ?? '<unparsed plan>';
  const taskLabel = report.task_id ?? '<unknown task>';
  output.stdout(`Plan ${planLabel} on task ${taskLabel}: ${report.status}.\n`);
  if (report.status === 'invalid') {
    for (const entry of report.diagnostics)
      output.stdout(`  invalid: ${entry.code}: ${entry.detail}\n`);
    return;
  }
  if (report.status === 'incomplete') {
    for (const entry of report.diagnostics)
      output.stdout(`  incomplete: ${entry.code}: ${entry.detail}\n`);
  }
  if (report.stale) {
    output.stdout(
      '  note: the plan owner epoch is not the current epoch; every node is stale until it is rebuilt.\n',
    );
  }
  const summary = report.summary;
  if (summary !== null) {
    output.stdout(
      `  ready ${summary.ready}, running ${summary.running}, awaiting acceptance ${summary.awaiting_acceptance}, accepted ${summary.accepted}, blocked ${summary.blocked}\n`,
    );
  }
  for (const node of report.nodes) {
    output.stdout(
      `  ${node.role} ${node.node_id} (assignment ${node.assignment_id}#${node.attempt}): ${node.status}\n`,
    );
    for (const blocker of node.blockers)
      output.stdout(`      blocked by ${blocker.code}: ${blocker.detail}\n`);
    if (node.next_action !== null)
      output.stdout(`      next: ${node.next_action}\n`);
  }
  output.stdout(
    `  evidence: ${report.evidence.supplied}/${report.evidence.registered_decisions} relevant decision envelope(s) read from ${report.evidence.relevant_reports} planned report(s), ${report.evidence.raw_bytes} raw bytes\n`,
  );
  output.stdout(
    '  read-only: this evaluation is a persisted snapshot and grants no authority to run anything.\n',
  );
}

export async function runCollaborationPlanCommand(
  options: CollaborationPlanOptions,
  output: CliOutput,
): Promise<number> {
  const errors: string[] = [];
  if (options.taskRoot === null) errors.push('--task-root is required.');
  else if (!path.isAbsolute(options.taskRoot))
    errors.push('--task-root must be absolute.');
  if (options.planFile === null) errors.push('--config is required.');
  else if (!path.isAbsolute(options.planFile))
    errors.push('--config must be an absolute path to the plan document.');
  if (errors.length > 0) return invalid(output, options, errors);

  const report = await inspectWorkPlan({
    taskRoot: options.taskRoot!,
    planFile: options.planFile!,
  });
  if (options.json) output.stdout(`${JSON.stringify(report)}\n`);
  else emitHuman(report, output);
  if (report.status === 'evaluated') return 0;
  return report.status === 'invalid' ? 2 : 1;
}
