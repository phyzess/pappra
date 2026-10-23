import path from 'node:path';
import {
  COLLAB_ROLLOVER_REPORT_SCHEMA,
  inspectOrPlanRollover,
  loadRolloverRequest,
  type RolloverAction,
  type RolloverReport,
} from '../../app/collab-rollover.js';
import type { CliOutput } from '../output.js';

export const collaborationRolloverUsage =
  'pappra collab rollover <inspect|plan> --task-root <abs> --request <abs request.json> [--json]\n\n' +
  'Read-only rollover inspection and planning against the authoritative task record\n' +
  'and one exact linked continuity handoff bundle. Nothing is claimed, transferred,\n' +
  'launched, archived, routed, notified or written, and no native query is made.\n\n' +
  'The request document is bounded (64 KiB) and separately versioned\n' +
  '(schema pappra/collaboration-rollover-request/1). It names the absolute task root,\n' +
  'the exact bundle reference and digest, and either a recorded intent id or a\n' +
  'proposed intent. --task-root must equal the request task_root.\n\n' +
  'There is no apply action. A caller-supplied stop observation, exit code or\n' +
  'producer label is never authenticated native proof, so prepare-transfer stays\n' +
  'unavailable until an accepted host adapter produces quiescence evidence.\n\n' +
  'Exit 0 inspected (blocked steps included, plan_complete reports completion),\n' +
  '1 the exact record or bundle cannot support the inspection, 2 invalid request.';

export interface CollaborationRolloverOptions {
  readonly action: RolloverAction;
  readonly taskRoot: string | null;
  readonly requestFile: string | null;
  readonly json: boolean;
}

function emitFailure(
  output: CliOutput,
  options: CollaborationRolloverOptions,
  kind: 'invalid' | 'needs_input',
  code: string,
  message: string,
  nextAction: string | null,
  details: readonly string[],
): number {
  if (options.json) {
    output.stdout(
      `${JSON.stringify({
        schema: COLLAB_ROLLOVER_REPORT_SCHEMA,
        action: options.action,
        ok: false,
        kind,
        code,
        message,
        next_action: nextAction,
        task_root: options.taskRoot,
        request: options.requestFile,
        details,
        limits: [
          'read_only_inspection',
          'no_apply_or_mutation',
          'host_stop_proof_unavailable',
          'native_launch_unavailable',
          'native_session_archive_unavailable',
          'routing_removal_pending',
        ],
      })}\n`,
    );
  } else {
    output.stdout(`Rollover ${options.action} rejected (${code}).\n`);
    output.stdout(`  ${message}\n`);
    for (const detail of details) output.stdout(`  - ${detail}\n`);
    if (nextAction !== null) output.stdout(`  next: ${nextAction}\n`);
  }
  return kind === 'invalid' ? 2 : 1;
}

function emitHuman(report: RolloverReport, output: CliOutput): void {
  const intentLabel = report.intent.intent_id ?? '<unrecorded intent>';
  output.stdout(
    `Rollover ${report.action} on task ${report.task_id} (revision ${report.state_revision}, epoch ${String(report.owner_epoch)}): intent ${intentLabel}.\n`,
  );
  output.stdout(
    `  record: ${report.intent.found ? 'recorded intent' : 'proposed intent'}, handoff ${report.handoff.state ?? '<none>'}, attempt ${report.attempt?.state ?? '<none>'}\n`,
  );
  for (const claim of report.claims) {
    output.stdout(
      `  claim ${claim.claim_id}: holder ${claim.holder?.agent_id ?? '<none>'}, epoch ${String(claim.resource_epoch)} (expected ${claim.expected_resource_epoch})${claim.released_at === null ? '' : ', released'}\n`,
    );
  }
  output.stdout(
    `  bundle ${report.bundle.ref}: verified, context ${report.bundle.context_integrity}, association ${report.bundle.collaboration.matches_plan ? 'matches' : 'differs'}, execution ${String(report.bundle.execution_allowed)}\n`,
  );
  for (const step of report.steps) {
    output.stdout(`  ${step.step}: ${step.status}\n`);
    for (const blocker of step.blockers)
      output.stdout(`      blocked by ${blocker.code}: ${blocker.detail}\n`);
  }
  if (report.drift.length > 0) {
    output.stdout('  current-record drift:\n');
    for (const blocker of report.drift)
      output.stdout(`      ${blocker.code}: ${blocker.detail}\n`);
  }
  output.stdout(
    `  notify exclusion for the planned identities: ${report.notify_exclusion.effective}\n`,
  );
  if (report.evidence.requested.length > 0)
    output.stdout(
      `  evidence: ${report.evidence.supplied}/${report.evidence.requested.length} correlated envelope(s), ${report.evidence.raw_bytes} raw bytes\n`,
    );
  for (const entry of report.evidence.unreadable)
    output.stdout(`      unreadable ${entry.message_id}: ${entry.code}\n`);
  output.stdout(
    `  plan complete: ${String(report.plan_complete)} (host stop proof ${report.capabilities.host_stop_proof}, native launch ${report.capabilities.native_launch}, routing removal ${report.capabilities.routing_removal})\n`,
  );
  output.stdout(
    '  read-only: no intent, claim, handoff, bundle, binding, notification or delivery file was written and nothing was applied.\n',
  );
}

export async function runCollaborationRolloverCommand(
  options: CollaborationRolloverOptions,
  output: CliOutput,
): Promise<number> {
  const errors: string[] = [];
  if (options.taskRoot === null) errors.push('--task-root is required.');
  else if (!path.isAbsolute(options.taskRoot))
    errors.push('--task-root must be absolute.');
  if (options.requestFile === null) errors.push('--request is required.');
  else if (!path.isAbsolute(options.requestFile))
    errors.push('--request must be an absolute path to the request document.');
  if (errors.length > 0)
    return emitFailure(
      output,
      options,
      'invalid',
      'invalid_arguments',
      'The rollover request is incomplete.',
      collaborationRolloverUsage,
      errors,
    );

  const loaded = loadRolloverRequest(options.requestFile as string);
  if (loaded.ok === false)
    return emitFailure(
      output,
      options,
      loaded.kind,
      loaded.code,
      loaded.message,
      loaded.nextAction,
      [],
    );
  const request = loaded.value;
  if (options.action !== request.action)
    return emitFailure(
      output,
      options,
      'invalid',
      'request_action_mismatch',
      `The command asks for ${options.action} but the request document declares ${request.action}.`,
      'Use one action in both the command and the request document.',
      [],
    );
  if (
    path.resolve(request.task_root) !== path.resolve(options.taskRoot as string)
  )
    return emitFailure(
      output,
      options,
      'invalid',
      'task_root_mismatch',
      'The request task_root is not the --task-root passed on the command line.',
      'Use one absolute task root; the cwd is never used to infer it.',
      [],
    );

  const report = await inspectOrPlanRollover(request);
  if (report.ok === false)
    return emitFailure(
      output,
      options,
      report.kind,
      report.code,
      report.message,
      report.nextAction,
      [],
    );
  if (options.json) output.stdout(`${JSON.stringify(report.value)}\n`);
  else emitHuman(report.value, output);
  return 0;
}
