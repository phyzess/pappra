import type { Assignment, CapabilityCard } from '../../collab/contracts.js';
import { readBoundedFile } from '../bounded-file.js';
import { deriveClaudeCard } from './claude.js';
import { deriveCodexCard } from './codex.js';
import { derivePiCard } from './pi.js';
import { MAX_ASSIGNMENT_BYTES, type CapabilityDerivation } from './shared.js';

/**
 * Read-only native capability evidence derivation.
 *
 * A derived runtime card is a claim derived from the supplied evidence only; no
 * authentication, process ownership, admission or task completion is implied.
 * Deriving never writes a file, launches a process or calls a model.
 */
export const CAPABILITIES_SCHEMA = 'pappra/collaboration-capabilities/1';

export type EvidenceHarness = 'pi' | 'codex' | 'claude';

export interface DeriveCapabilitiesOptions {
  readonly harness: EvidenceHarness;
  readonly assignmentFile: string;
  readonly templateFile: string;
  readonly executionFile?: string | null;
  readonly live?: boolean;
  readonly sessionFile?: string | null;
  readonly eventsFile?: string | null;
}

export interface CapabilityEvidenceResult {
  readonly schema: typeof CAPABILITIES_SCHEMA;
  readonly ok: boolean;
  readonly status: CapabilityDerivation['status'];
  readonly harness: EvidenceHarness;
  readonly card?: CapabilityCard;
  readonly blockers?: readonly string[];
  readonly limitations?: readonly string[];
  readonly errors?: readonly string[];
  readonly limits: readonly string[];
}

export const CAPABILITY_LIMITS = [
  'reported_native_evidence_only',
  'evidence_not_authenticated',
  'no_dispatch',
] as const;

type ConfigurationRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

function readConfiguration(
  file: string,
  kind: 'assignment' | 'template',
): ConfigurationRead {
  const read = readBoundedFile(file, MAX_ASSIGNMENT_BYTES);
  if (!read.ok) {
    switch (read.code) {
      case 'path_not_absolute':
        return { ok: false, error: `${kind}_path_must_be_absolute` };
      case 'symlink':
      case 'not_regular':
        return { ok: false, error: `${kind}_must_be_regular_file` };
      case 'too_large':
        return { ok: false, error: `${kind}_exceeds_1_mib` };
      default:
        return { ok: false, error: `${kind}_unreadable` };
    }
  }
  try {
    return { ok: true, value: JSON.parse(read.text) as unknown };
  } catch {
    return { ok: false, error: `${kind}_invalid_json` };
  }
}

function invalid(
  harness: EvidenceHarness,
  errors: readonly string[],
): CapabilityEvidenceResult {
  return {
    schema: CAPABILITIES_SCHEMA,
    ok: false,
    status: 'invalid',
    harness,
    errors,
    limits: CAPABILITY_LIMITS,
  };
}

export function deriveCapabilityCard(
  options: DeriveCapabilitiesOptions,
): CapabilityEvidenceResult {
  if (options.live && options.harness !== 'pi')
    return invalid(options.harness, ['live_only_supported_for_pi']);
  if (options.live && options.executionFile)
    return invalid(options.harness, ['live_execution_conflict']);
  if (!options.live && !options.executionFile)
    return invalid(options.harness, ['execution_required']);
  const assignment = readConfiguration(options.assignmentFile, 'assignment');
  if (!assignment.ok) return invalid(options.harness, [assignment.error]);
  const template = readConfiguration(options.templateFile, 'template');
  if (!template.ok) return invalid(options.harness, [template.error]);

  let outcome: CapabilityDerivation;
  if (options.harness === 'pi') {
    if (!options.sessionFile)
      return invalid(options.harness, ['session_required_for_pi']);
    outcome = derivePiCard({
      assignment: assignment.value as Assignment,
      template: template.value as CapabilityCard,
      sessionFile: options.sessionFile,
      executionFile: options.executionFile ?? null,
      live: options.live ?? false,
    });
  } else if (options.harness === 'codex') {
    if (!options.eventsFile)
      return invalid(options.harness, ['events_required_for_codex']);
    outcome = deriveCodexCard({
      assignment: assignment.value as Assignment,
      template: template.value as CapabilityCard,
      eventsFile: options.eventsFile,
      executionFile: options.executionFile!,
    });
  } else {
    if (!options.eventsFile)
      return invalid(options.harness, ['events_required_for_claude']);
    outcome = deriveClaudeCard({
      assignment: assignment.value as Assignment,
      template: template.value as CapabilityCard,
      eventsFile: options.eventsFile,
      executionFile: options.executionFile!,
    });
  }

  if (outcome.status === 'derived') {
    return {
      schema: CAPABILITIES_SCHEMA,
      ok: true,
      status: 'derived',
      harness: options.harness,
      card: outcome.card,
      limits: CAPABILITY_LIMITS,
      ...(outcome.limitations === undefined
        ? {}
        : { limitations: outcome.limitations }),
    };
  }
  return {
    schema: CAPABILITIES_SCHEMA,
    ok: false,
    status: outcome.status,
    harness: options.harness,
    blockers: outcome.blockers,
    limits: CAPABILITY_LIMITS,
  };
}
