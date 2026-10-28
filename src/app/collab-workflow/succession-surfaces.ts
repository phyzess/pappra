import fs from 'node:fs';
import path from 'node:path';
import type { TaskRecord } from '../../collab/types.js';

/**
 * Surfaces that keep current-epoch equality and gain no lineage awareness
 * (docs/mid-cohort-succession-spec.md, section 8). They fail closed after a coordinator
 * succession, so a task that uses one must not hand off mid-cohort and `adopt` refuses it.
 */
export interface SurfaceFinding {
  readonly code: 'adopt_unsupported_surface' | 'adopt_role_artifact';
  readonly detail: string;
  readonly next_action: string;
}

const RECORD_SURFACES = [
  'managed_pi_source_admissions',
  'managed_pi_resume_admissions',
  'managed_pi_runtime_registry',
  'rollover',
  'successions',
] as const;

/** Role subsystem files that live next to a task; others sit at caller-chosen paths. */
const ROLE_ARTIFACT = /role/i;

export function roleArtifacts(taskRoot: string): string[] {
  const found: string[] = [];
  for (const directory of [taskRoot, path.join(taskRoot, 'workflow')]) {
    let names: string[];
    try {
      names = fs.readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of names)
      if (ROLE_ARTIFACT.test(name)) found.push(path.join(directory, name));
  }
  return found;
}

export function unsupportedSurfaces(
  record: TaskRecord,
  taskRoot: string,
): SurfaceFinding[] {
  const findings: SurfaceFinding[] = [];
  const values = record as unknown as Record<string, unknown>;
  for (const key of RECORD_SURFACES) {
    const value = values[key];
    if (Array.isArray(value) ? value.length > 0 : value != null)
      findings.push({
        code: 'adopt_unsupported_surface',
        detail: `The task uses ${key}, which does not follow a coordinator succession.`,
        next_action:
          'Finish or cancel that work before the handoff; it fails closed after succession.',
      });
  }
  const roles = roleArtifacts(taskRoot);
  if (roles.length > 0)
    findings.push({
      code: 'adopt_role_artifact',
      detail: `Role subsystem artifacts exist next to the task: ${roles.join(', ')}.`,
      next_action: 'Role plans do not follow a coordinator succession.',
    });
  return findings;
}
