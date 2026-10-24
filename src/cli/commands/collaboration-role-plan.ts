import { readBoundedFile } from '../../app/bounded-file.js';
import {
  expandRolePlan,
  aggregateRolePlan,
  type RolePlanRequest,
} from '../../app/collab-role-plan.js';
import { inspectWorkPlan } from '../../app/collab-work-plan.js';
import { canonicalJson } from '../../collab/envelope.js';
import type { CliOutput } from '../output.js';

export const collaborationRolePlanUsage =
  'pappra collab role-plan expand --request <abs role-plan.json> [--json]\n' +
  'pappra collab role-plan aggregate --request <abs role-plan.json> --task-root <abs> --config <abs expanded-plan.json> [--json]\n\n' +
  'Read-only writer/reviewer expansion and authoritative task-result aggregation.\n' +
  'Save the returned plan, then use collab plan/work-run for existing admission and dispatch.\n' +
  'Roles never grant authority; delivery never implies acceptance.';

function loadJson(file: string | null): unknown {
  if (file === null) throw new Error('An absolute input file is required.');
  const loaded = readBoundedFile(file, 512 * 1024);
  if (!loaded.ok) throw new Error(`Input refused: ${loaded.code}.`);
  try {
    return JSON.parse(loaded.text) as unknown;
  } catch {
    throw new Error('Input must be JSON.');
  }
}

export async function runCollaborationRolePlanCommand(
  options: {
    readonly action: string;
    readonly requestFile: string | null;
    readonly taskRoot: string | null;
    readonly planFile: string | null;
    readonly json: boolean;
  },
  output: CliOutput,
): Promise<number> {
  const emit = (value: unknown): void => {
    output.stdout(
      `${JSON.stringify(value, null, options.json ? undefined : 2)}\n`,
    );
  };
  try {
    if (options.action !== 'expand' && options.action !== 'aggregate')
      throw new Error('role-plan accepts expand or aggregate.');
    if (
      options.action === 'expand' &&
      (options.taskRoot !== null || options.planFile !== null)
    )
      throw new Error('expand accepts only --request and --json.');
    const expanded = expandRolePlan(
      loadJson(options.requestFile) as RolePlanRequest,
    );
    if (!expanded.ok) {
      emit(expanded);
      return 2;
    }
    if (options.action === 'expand') {
      emit(expanded);
      return 0;
    }
    if (options.taskRoot === null || options.planFile === null)
      throw new Error('aggregate requires --task-root and --config.');
    if (
      canonicalJson(loadJson(options.planFile)) !== canonicalJson(expanded.plan)
    )
      throw new Error('Persisted plan differs from the expanded role request.');
    const report = await inspectWorkPlan({
      taskRoot: options.taskRoot,
      planFile: options.planFile,
    });
    const result = aggregateRolePlan(
      expanded,
      report.core ?? {
        ok: false,
        diagnostics: report.diagnostics.map((entry) => ({
          ...entry,
          node_id: null,
        })),
      },
    );
    emit(result);
    return result.outcome === 'unknown' || result.outcome === 'missing' ? 1 : 0;
  } catch (error) {
    emit({
      ok: false,
      status: 'invalid',
      code: 'invalid_role_plan_request',
      message:
        error instanceof Error ? error.message : 'Role plan request failed.',
    });
    return 2;
  }
}
