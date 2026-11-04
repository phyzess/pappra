import { diagnosticCodes } from '../schemas/errors.js';
import type { DoctorCheck } from '../schemas/doctor.js';
import {
  CROSS_LAYER_VALUE_COMPOSITIONS,
  inspectConfigAuthority,
  summarizeConfigAuthority,
  type ConfigAuthorityInspection,
} from '../schemas/config-authority.js';
import { fileEvidence, makeCheck } from './doctor-check.js';

export interface ConfigAuthorityCheckInput {
  readonly configPath: string;
  readonly machinePath: string | null;
  readonly workspaceDigest: string | null;
  readonly machineDigest: string | null;
  readonly observedAt: string;
  /** Defaults to the current two-file contract; a caller may pass a candidate. */
  readonly inspection?: ConfigAuthorityInspection;
}

/**
 * Reports the field-level authority classification of both configuration
 * layers.
 *
 * The summary keeps three things apart: what the classification table asserts
 * statically, what tests pin about current entrypoints, and what this check
 * observed at runtime. It observes configuration files and schema metadata
 * only — nothing is resolved, spawned or executed — so it is not an execution
 * audit of any code path.
 */
export function configAuthorityCheck(
  input: ConfigAuthorityCheckInput,
): DoctorCheck {
  const inspection = input.inspection ?? inspectConfigAuthority();
  const shared = summarizeConfigAuthority('shared');
  const machine = summarizeConfigAuthority('private');
  const compositions = CROSS_LAYER_VALUE_COMPOSITIONS.map((entry) => entry.id);
  const gaps = inspection.violations;
  const duplicateClause =
    inspection.duplicatePaths.length === 0
      ? 'No field path occurs in both files. '
      : `Field path(s) occurring in both files: ${inspection.duplicatePaths.join(', ')}; a repeated name is not by itself one effective value, and each overlap needs its own read-path evidence. `;
  const summary =
    `${gaps.length > 0 ? `Classification gaps: ${gaps.slice(0, 4).join('; ')}. ` : ''}` +
    'Static field classification of the two configuration schemas, not a runtime observation: ' +
    `shared ${shared.file} classifies ${shared.total} field path(s) — ${shared.descriptive} descriptive, ${shared.authorityBearing} authority-bearing (${shared.explicitCommand} gated by an explicit command, ${shared.localBinding} by a private binding, ${shared.noConsumer} declared but consumed by nothing today) and ${shared.openContainers} open container; ` +
    `${machine.file} classifies ${machine.total} checkout-local field path(s). ` +
    duplicateClause +
    `${compositions.length} value(s) are composed at read time from both layers and keep their own source layer (${compositions.join(', ')}). ` +
    'This check read configuration files and schema metadata only: it resolved, spawned and executed nothing, and it is not an execution audit of another code path. ' +
    'Non-execution of validation candidates is pinned by tests over current entrypoints, not observed here.';
  return makeCheck({
    id: 'workspace.authority',
    code: diagnosticCodes.doctor_config_authority,
    status: gaps.length === 0 ? 'ok' : 'warning',
    severity: gaps.length === 0 ? 'info' : 'warning',
    title: 'Configuration authority classification',
    summary,
    source: input.configPath,
    observedAt: input.observedAt,
    coverage:
      'schema field classification; nothing resolved or executed; candidate non-execution is test-pinned',
    evidence: [
      fileEvidence(input.configPath, input.observedAt, input.workspaceDigest),
      ...(input.machinePath === null
        ? []
        : [
            fileEvidence(
              input.machinePath,
              input.observedAt,
              input.machineDigest,
            ),
          ]),
    ],
    nextActions: [
      'Read docs/configuration-authority.md before giving a shared-layer authority-bearing field an execution path.',
      "Grant authority-bearing behaviour through this checkout's machine.json or an explicit command, not by editing the committed workspace.json alone.",
    ],
  });
}
