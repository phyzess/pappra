import path from 'node:path';
import {
  CAPABILITIES_SCHEMA,
  CAPABILITY_LIMITS,
  deriveCapabilityCard,
  type CapabilityEvidenceResult,
  type DeriveCapabilitiesOptions,
  type EvidenceHarness,
} from '../../app/capability-evidence/index.js';
import type { CliOutput } from '../output.js';

export const collaborationCapabilitiesUsage =
  'pappra collab capabilities derive --harness <pi|codex|claude> --assignment <abs assignment.json> --template <abs card.declared.json> [--execution <abs execution.json> | --live] [--session <abs pi-session.jsonl> | --events <abs events.jsonl>] [--json]\n\n' +
  'Read-only native capability evidence: Pi requires --session, Codex and Claude\n' +
  'require --events. Pi --live derives a settled saved-session snapshot without\n' +
  'an execution receipt; it does not prove live ownership, queue or approvals.\n' +
  'A derived card is a claim derived from the supplied evidence;\n' +
  'nothing is written, launched, authenticated or dispatched. Exit 0 derived,\n' +
  '1 needs_input, 2 invalid.';

export interface CollaborationCapabilitiesOptions {
  readonly harness: string | null;
  readonly assignmentFile: string | null;
  readonly templateFile: string | null;
  readonly executionFile: string | null;
  readonly sessionFile: string | null;
  readonly eventsFile: string | null;
  readonly json: boolean;
  readonly live?: boolean;
}

interface InvalidCapabilitiesResult {
  readonly schema: typeof CAPABILITIES_SCHEMA;
  readonly ok: false;
  readonly status: 'invalid';
  readonly harness: string;
  readonly errors: readonly string[];
  readonly limits: readonly string[];
}

function invalid(
  harness: EvidenceHarness | 'unknown',
  errors: readonly string[],
): InvalidCapabilitiesResult {
  return {
    schema: CAPABILITIES_SCHEMA,
    ok: false,
    status: 'invalid',
    harness,
    errors,
    limits: CAPABILITY_LIMITS,
  };
}

function emitInvalid(
  output: CliOutput,
  options: CollaborationCapabilitiesOptions,
  result: ReturnType<typeof invalid>,
): number {
  if (options.json) output.stdout(`${JSON.stringify(result)}\n`);
  else {
    output.stdout(`Capabilities invalid.\n`);
    for (const error of result.errors ?? []) output.stdout(`  - ${error}\n`);
  }
  return 2;
}

function emitHuman(result: CapabilityEvidenceResult, output: CliOutput): void {
  if (result.status === 'derived') {
    const card = result.card!;
    const tools = card.tools.map((tool) => `${tool.id}:${tool.state}`);
    const skills = card.skills.map((skill) => `${skill.id}:${skill.state}`);
    output.stdout(
      `Capabilities derived (${result.harness}) at ${card.observed_at}.\n`,
    );
    output.stdout(`  tools: ${tools.length ? tools.join(', ') : 'none'}\n`);
    output.stdout(`  skills: ${skills.length ? skills.join(', ') : 'none'}\n`);
    output.stdout(
      `  evidence: ${String(card.evidence_records?.length ?? 0)} record(s)\n`,
    );
    if (result.limitations?.length) {
      output.stdout(`  limitations: ${result.limitations.join(', ')}\n`);
    }
  } else if (result.status === 'needs_input') {
    output.stdout(
      `Capabilities need input: ${(result.blockers ?? []).join(', ') || 'none'}.\n`,
    );
  } else {
    output.stdout(`Capabilities invalid.\n`);
    for (const error of result.errors ?? []) output.stdout(`  - ${error}\n`);
    for (const blocker of result.blockers ?? [])
      output.stdout(`  - ${blocker}\n`);
  }
  output.stdout(`  limits: ${result.limits.join(', ')}\n`);
}

export function runCollaborationCapabilitiesCommand(
  options: CollaborationCapabilitiesOptions,
  output: CliOutput,
): number {
  const harness =
    options.harness === 'pi' ||
    options.harness === 'codex' ||
    options.harness === 'claude'
      ? options.harness
      : null;
  if (harness === null) {
    return emitInvalid(
      output,
      options,
      invalid('unknown', ['--harness must be pi, codex or claude.']),
    );
  }
  const missing = [
    ['--assignment', options.assignmentFile],
    ['--template', options.templateFile],
    ...(!options.live ? [['--execution', options.executionFile]] : []),
  ]
    .filter(([, value]) => value === null)
    .map(([flag]) => flag);
  if (missing.length) {
    return emitInvalid(
      output,
      options,
      invalid(harness, [`missing required option(s): ${missing.join(', ')}.`]),
    );
  }
  if (options.live && (harness !== 'pi' || options.executionFile !== null)) {
    return emitInvalid(
      output,
      options,
      invalid(harness, ['--live requires Pi and excludes --execution.']),
    );
  }
  if (harness === 'pi') {
    if (options.sessionFile === null) {
      return emitInvalid(
        output,
        options,
        invalid(harness, ['--session is required for pi.']),
      );
    }
    if (options.eventsFile !== null) {
      return emitInvalid(
        output,
        options,
        invalid(harness, ['--events is only valid for codex or claude.']),
      );
    }
  } else {
    if (options.eventsFile === null) {
      return emitInvalid(
        output,
        options,
        invalid(harness, [`--events is required for ${harness}.`]),
      );
    }
    if (options.sessionFile !== null) {
      return emitInvalid(
        output,
        options,
        invalid(harness, ['--session is only valid for pi.']),
      );
    }
  }
  const files: [string, string | null][] = [
    ['--assignment', options.assignmentFile],
    ['--template', options.templateFile],
    ['--execution', options.executionFile],
    ['--session', options.sessionFile],
    ['--events', options.eventsFile],
  ];
  const nonAbsolute = files
    .filter(([, value]) => value !== null && !path.isAbsolute(value))
    .map(([flag]) => flag);
  if (nonAbsolute.length) {
    return emitInvalid(
      output,
      options,
      invalid(harness, [
        `option(s) must be absolute: ${nonAbsolute.join(', ')}.`,
      ]),
    );
  }

  const deriveOptions: DeriveCapabilitiesOptions = {
    harness,
    assignmentFile: options.assignmentFile!,
    templateFile: options.templateFile!,
    executionFile: options.executionFile!,
    sessionFile: options.sessionFile,
    eventsFile: options.eventsFile,
    live: options.live ?? false,
  };
  const result = deriveCapabilityCard(deriveOptions);
  if (options.json) {
    output.stdout(`${JSON.stringify(result)}\n`);
  } else {
    emitHuman(result, output);
  }
  if (result.status === 'derived') return 0;
  return result.status === 'needs_input' ? 1 : 2;
}
