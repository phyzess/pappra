import type { Assignment, CapabilityCard } from '../collab/contracts.js';
import { preflight, type Check } from '../collab/preflight.js';
import { readBoundedFile } from './bounded-file.js';

/**
 * Public, read-only readiness preflight over the existing collaboration
 * primitive. This module only reads the two configuration files and lets the
 * primitive inspect pinned inputs/evidence; it never launches, claims, mutates a
 * task record, emits input bodies, or refreshes evidence.
 */
export const COLLAB_PREFLIGHT_SCHEMA = 'pappra/collaboration-preflight/1';
const MAX_FILE_BYTES = 1024 * 1024;

export type CollabPreflightStatus = 'ready' | 'needs_input' | 'invalid';

export interface CollabPreflightReport {
  readonly schema: typeof COLLAB_PREFLIGHT_SCHEMA;
  readonly ok: boolean;
  readonly status: CollabPreflightStatus;
  readonly task_id?: string;
  readonly assignment_id?: string;
  readonly attempt?: number;
  readonly checked_at?: string;
  readonly errors: readonly string[];
  readonly blockers: readonly Check[];
  readonly warnings: readonly Check[];
  readonly limits: readonly string[];
}

export interface CollabPreflightOptions {
  readonly assignmentFile: string;
  readonly capabilitiesFile: string;
  readonly maxAgeMinutes?: number;
  readonly now?: number;
}

type JsonRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string };

function invalidReport(errors: readonly string[]): CollabPreflightReport {
  return {
    schema: COLLAB_PREFLIGHT_SCHEMA,
    ok: false,
    status: 'invalid',
    errors,
    blockers: [],
    warnings: [],
    limits: [],
  };
}

/**
 * Reads one bounded regular JSON file through the shared bounded loader, which
 * refuses special entries from the initial observation and keeps the open
 * itself nonblocking/no-follow.
 */
function readBoundedJson(file: string, label: string): JsonRead {
  const read = readBoundedFile(file, MAX_FILE_BYTES);
  if (!read.ok) {
    const name = label.toLowerCase();
    switch (read.code) {
      case 'path_not_absolute':
        return { ok: false, message: `${label} path must be absolute.` };
      case 'symlink':
        return {
          ok: false,
          message: `${label} must be a regular file, not a symlink.`,
        };
      case 'too_large':
        return {
          ok: false,
          message: `${label} exceeds the ${MAX_FILE_BYTES}-byte limit.`,
        };
      case 'not_regular':
        return { ok: false, message: `${label} must be a regular file.` };
      default:
        return { ok: false, message: `Cannot read ${name} file.` };
    }
  }
  try {
    return { ok: true, value: JSON.parse(read.text) as unknown };
  } catch {
    return { ok: false, message: `${label} is not valid JSON.` };
  }
}

/**
 * Runs the existing preflight primitive against caller-supplied absolute files.
 * The result preserves the primitive's status, blockers, warnings and limits;
 * `ok` is true only for `ready`. This is reported readiness, not authorization.
 */
export function runCollaborationPreflight(
  options: CollabPreflightOptions,
): CollabPreflightReport {
  const maxAge = options.maxAgeMinutes ?? 30;
  if (!Number.isFinite(maxAge) || maxAge <= 0) {
    return invalidReport(['Maximum age must be a positive finite number.']);
  }
  const assignment = readBoundedJson(options.assignmentFile, 'Assignment');
  if (!assignment.ok) return invalidReport([assignment.message]);
  const capabilities = readBoundedJson(
    options.capabilitiesFile,
    'Capabilities',
  );
  if (!capabilities.ok) return invalidReport([capabilities.message]);

  const result = preflight(
    assignment.value as Assignment,
    capabilities.value as CapabilityCard,
    {
      now: options.now ?? Date.now(),
      maxAgeMinutes: maxAge,
    },
  );
  const hasTask = 'task_id' in result;
  const status = result.status as CollabPreflightStatus;
  return {
    schema: COLLAB_PREFLIGHT_SCHEMA,
    ok: status === 'ready',
    status,
    ...(hasTask
      ? {
          task_id: result.task_id,
          assignment_id: result.assignment_id,
          attempt: result.attempt,
          checked_at: result.checked_at,
        }
      : {}),
    errors: result.errors,
    blockers: result.blockers,
    warnings: result.warnings,
    limits: 'limits' in result ? result.limits : [],
  };
}
