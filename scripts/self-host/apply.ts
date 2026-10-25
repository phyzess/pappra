import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  DIST_ENTRY,
  isRecord,
  stringOrNull,
  failureDetail,
  parseJsonObject,
  type CliDeps,
} from './types.ts';
import { admit } from './admission.ts';
import { applySkillAliases } from './aliases.ts';
import { defaultDeps } from './cli.ts';

function applyCodeIndex(
  repositoryId: string,
  deps: CliDeps,
  actions: string[],
): void {
  const plan = deps.runCli([
    'code',
    'prepare',
    '--repo',
    repositoryId,
    '--json',
  ]);
  const payload = parseJsonObject(plan.stdout);
  const body = payload?.['plan'];
  const action =
    payload !== null && payload['ok'] === true && isRecord(body)
      ? stringOrNull(body['action'])
      : null;
  if (action === null) {
    actions.push(
      `code prepare ${repositoryId}: plan not actionable, apply skipped (${failureDetail('code prepare', payload, plan)})`,
    );
    return;
  }
  if (action === 'none') return;
  const applied = deps.runCli([
    'code',
    'prepare',
    '--repo',
    repositoryId,
    '--apply',
    '--json',
  ]);
  const appliedPayload = parseJsonObject(applied.stdout);
  const status =
    appliedPayload !== null && appliedPayload['ok'] === true
      ? stringOrNull(appliedPayload['status'])
      : null;
  actions.push(
    `code prepare ${repositoryId}: ${
      status ?? failureDetail('code prepare --apply', appliedPayload, applied)
    }`,
  );
}

/**
 * Registers newly discovered documents only. Changed bytes of an existing
 * registration are never accepted here; that stays an explicit `docs review`.
 */
function applyDocs(deps: CliDeps, actions: string[]): void {
  const scan = deps.runCli(['docs', 'scan', '--json']);
  const payload = parseJsonObject(scan.stdout);
  const candidates = payload?.['candidates'];
  if (
    payload === null ||
    payload['ok'] !== true ||
    !Array.isArray(candidates)
  ) {
    actions.push(
      `docs scan: registration skipped (${failureDetail('docs scan', payload, scan)})`,
    );
    return;
  }
  if (candidates.length === 0) return;
  const applied = deps.runCli(['docs', 'scan', '--apply', '--json']);
  const appliedPayload = parseJsonObject(applied.stdout);
  const registered = appliedPayload?.['registered'];
  if (
    appliedPayload === null ||
    appliedPayload['ok'] !== true ||
    !Array.isArray(registered)
  ) {
    actions.push(
      `docs scan --apply: ${failureDetail(
        'docs scan --apply',
        appliedPayload,
        applied,
      )}`,
    );
    return;
  }
  actions.push(
    `docs scan --apply: ${registered.length} of ${candidates.length} candidate(s) registered`,
  );
}

/**
 * Converges only what this entry owns. Admission is required before the first
 * write: an unrelated root, missing or redirected source, or a workspace that
 * does not select this repository with `codegraph` performs no writes and no
 * mutating child at all.
 */
export function applyFixes(
  root: string,
  deps: CliDeps = defaultDeps(root),
): readonly string[] {
  const admission = admit(root);
  if (!admission.ok) return [];
  const actions = [...applySkillAliases(root)];
  if (!existsSync(join(root, DIST_ENTRY))) return actions;
  applyCodeIndex(admission.repositoryId, deps, actions);
  applyDocs(deps, actions);
  return actions;
}
