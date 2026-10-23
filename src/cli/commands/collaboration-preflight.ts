import {
  runCollaborationPreflight,
  type CollabPreflightReport,
} from '../../app/collab-preflight.js';
import type { CliOutput } from '../output.js';

export const collaborationPreflightUsage =
  'pappra collab preflight --assignment <abs assignment.json> --capabilities <abs card.json> [--max-age-minutes <n>] [--json]\n\n' +
  'Read-only readiness check over the existing collaboration preflight. It reads the\n' +
  'two files and verifies pinned inputs/evidence; it never launches, claims, mutates\n' +
  'a task record or refreshes evidence. Exit 0 ready, 1 needs_input, 2 invalid.\n' +
  'Needs-input output groups recovery guidance for known blockers; JSON output is unchanged.';

export interface CollaborationPreflightOptions {
  readonly cwd: string;
  readonly assignmentFile: string | null;
  readonly capabilitiesFile: string | null;
  readonly maxAgeMinutes: string | null;
  readonly json: boolean;
}

function usageFailure(
  output: CliOutput,
  options: CollaborationPreflightOptions,
  code: string,
  message: string,
): number {
  if (options.json) {
    output.stdout(
      `${JSON.stringify({
        schema: 'pappra/collaboration-preflight/1',
        ok: false,
        status: 'invalid',
        errors: [message],
        blockers: [],
        warnings: [],
        limits: [],
        code,
      })}\n`,
    );
  } else {
    output.stderr(`pappra collab preflight: ${message}\n`);
  }
  return 2;
}

function describeChecks(
  checks: CollabPreflightReport['blockers'],
): readonly string[] {
  return checks.map(
    (check) =>
      `  - ${check.code}${check.capability === undefined ? '' : ` (${check.capability})`}`,
  );
}

interface RecoveryGuidance {
  readonly group: string;
  readonly action: string;
}

const FRESHNESS_RECOVERY =
  'Obtain fresh runtime evidence from the current receiving session and rerun preflight. Never retimestamp older evidence, and never revert a user-selected model or provider to recreate an earlier observation.';
const IDENTITY_RECOVERY =
  'Supply evidence for the exact assignee identity, session, cwd and configuration. A model or provider difference alone is not an identity difference, and identity fields are not relabeled to match.';
const CAPABILITY_RECOVERY =
  'Required capability readiness is not confirmed by this card: inspect the current runtime exposure and obtain actual current evidence for the required tool or skill, restoring or enabling it when it is in fact absent. Changing the requirement is an explicit scope decision for the coordinator, not a worker recovery step. Earlier successful tool use does not prove the current runtime still exposes it.';
/** Exact identity blockers emitted by the preflight core; unknown future codes get no remedy. */
const IDENTITY_BLOCKERS: ReadonlySet<string> = new Set([
  'assignee_agent_id_mismatch',
  'assignee_session_id_mismatch',
  'assignee_harness_mismatch',
  'assignee_surface_mismatch',
  'assignee_configuration_id_mismatch',
  'assignee_cwd_mismatch',
]);

/** Recovery guidance for concrete, known blockers. Unknown codes keep their code only. */
function recoveryFor(code: string): RecoveryGuidance | null {
  if (code === 'capabilities_stale')
    return { group: 'freshness', action: FRESHNESS_RECOVERY };
  if (code === 'capabilities_from_future')
    return {
      group: 'clock',
      action:
        'The evidence clock is ahead of this host clock: compare host and native timestamps and correct the clock or the evidence source. Do not edit timestamps to make evidence pass.',
    };
  if (code === 'runtime_capabilities_unconfirmed')
    return {
      group: 'evidence-level',
      action:
        'Derive a runtime card from actual native evidence for this session (pappra collab capabilities derive); a declared template is not runtime proof.',
    };
  if (code === 'required_capability_omitted_by_runner')
    return { group: 'capabilities', action: CAPABILITY_RECOVERY };
  if (
    code === 'native_evidence_changed' ||
    code === 'native_evidence_unavailable'
  )
    return {
      group: 'evidence-files',
      action:
        'The referenced native evidence changed or is unavailable: re-derive from the current native file instead of editing digests.',
    };
  if (code === 'input_changed' || code === 'input_unavailable')
    return {
      group: 'pinned-input',
      action:
        'A pinned input changed or is missing: obtain the current pinned input and update the assignment revision deliberately rather than rewriting a digest.',
    };
  if (code === 'tools_unavailable' || code === 'skills_unavailable')
    return { group: 'capabilities', action: CAPABILITY_RECOVERY };
  if (
    code === 'tools_evidence_unavailable' ||
    code === 'skills_evidence_unavailable'
  )
    return {
      group: 'capability-evidence',
      action:
        'A claimed capability has no usable evidence: re-derive the card so each capability references existing evidence.',
    };
  if (
    code === 'skill_version_mismatch' ||
    code === 'skill_files_changed' ||
    code === 'skill_files_unavailable'
  )
    return {
      group: 'skill-bundle',
      action:
        'The required skill bundle differs from the pinned fingerprint or is unreadable: restore the pinned bundle or update the requirement deliberately.',
    };
  if (code === 'assignee_cwd_unavailable')
    return {
      group: 'identity',
      action:
        'The assigned cwd is unreadable from here: run readiness from a process that can read it. cwd is part of the identity.',
    };
  if (IDENTITY_BLOCKERS.has(code))
    return { group: 'identity', action: IDENTITY_RECOVERY };
  return null;
}

function recoveryLines(
  checks: CollabPreflightReport['blockers'],
): readonly string[] {
  const groups = new Map<string, { action: string; codes: Set<string> }>();
  for (const check of checks) {
    const guidance = recoveryFor(check.code);
    if (guidance === null) continue;
    const existing = groups.get(guidance.group);
    if (existing === undefined) {
      groups.set(guidance.group, {
        action: guidance.action,
        codes: new Set([check.code]),
      });
      continue;
    }
    existing.codes.add(check.code);
  }
  return [...groups.entries()].map(
    ([group, entry]) =>
      `  ${group}: ${entry.action} (${[...entry.codes].join(', ')})`,
  );
}

function emitHuman(report: CollabPreflightReport, output: CliOutput): void {
  if (report.status === 'ready') {
    output.stdout(
      `Preflight ready${report.checked_at === undefined ? '' : ` at ${report.checked_at}`}.\n`,
    );
  } else if (report.status === 'needs_input') {
    output.stdout(
      `Preflight needs input: ${report.blockers.length} blocker(s).\n`,
    );
    for (const line of describeChecks(report.blockers))
      output.stdout(`${line}\n`);
    const recovery = recoveryLines(report.blockers);
    if (recovery.length > 0) {
      output.stdout('Recovery:\n');
      for (const line of recovery) output.stdout(`${line}\n`);
    }
  } else {
    output.stdout(
      `Preflight invalid: ${report.errors[0] ?? 'invalid input'}.\n`,
    );
    for (const error of report.errors.slice(1)) output.stdout(`  - ${error}\n`);
  }
  if (report.warnings.length > 0) {
    output.stdout(`Warnings: ${report.warnings.length}.\n`);
    for (const line of describeChecks(report.warnings))
      output.stdout(`${line}\n`);
  }
  if (report.limits.length > 0) {
    output.stdout(`Limits: ${report.limits.join(', ')}.\n`);
  }
}

export function runCollaborationPreflightCommand(
  options: CollaborationPreflightOptions,
  output: CliOutput,
): number {
  if (options.assignmentFile === null) {
    return usageFailure(
      output,
      options,
      'assignment_required',
      'preflight requires --assignment <abs assignment.json>.',
    );
  }
  if (options.capabilitiesFile === null) {
    return usageFailure(
      output,
      options,
      'capabilities_required',
      'preflight requires --capabilities <abs card.json>.',
    );
  }
  let maxAgeMinutes: number | undefined;
  if (options.maxAgeMinutes !== null) {
    const parsed = Number(options.maxAgeMinutes.trim());
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return usageFailure(
        output,
        options,
        'max_age_invalid',
        '--max-age-minutes must be a positive finite number.',
      );
    }
    maxAgeMinutes = parsed;
  }
  const report = runCollaborationPreflight({
    assignmentFile: options.assignmentFile,
    capabilitiesFile: options.capabilitiesFile,
    ...(maxAgeMinutes === undefined ? {} : { maxAgeMinutes }),
  });
  if (options.json) {
    output.stdout(`${JSON.stringify(report)}\n`);
  } else {
    emitHuman(report, output);
  }
  if (report.status === 'ready') return 0;
  return report.status === 'needs_input' ? 1 : 2;
}
