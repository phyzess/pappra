import path from 'node:path';
import {
  COLLAB_RESOURCES_SCHEMA,
  applyResourceRequest,
  listTaskResources,
  loadResourceRequest,
  planResourceRequest,
  type ResourceAction,
} from '../../app/collab-resources.js';
import type { TaskStoreFailure } from '../../app/collab-task-store.js';
import type { CliOutput } from '../output.js';

export const collaborationResourcesUsage =
  'pappra collab resource <list|claim|release> --task-root <abs> [options]\n' +
  '  list     --task-root <abs> [--json]\n' +
  '  claim    --task-root <abs> --request <abs request.json> [--apply] [--json]\n' +
  '  release  --task-root <abs> --request <abs request.json> [--apply] [--json]\n\n' +
  'Read/plan is non-mutating. --apply invokes the existing cooperative claim or\n' +
  'release primitive and never fences OS side effects. Exit 0 success,\n' +
  '1 conflict/uncertainty/core refusal, 2 invalid request/options.';

export interface CollaborationResourcesOptions {
  readonly action: ResourceAction | null;
  readonly taskRoot: string | null;
  readonly requestFile: string | null;
  readonly apply: boolean;
  readonly json: boolean;
}

function invalid(
  output: CliOutput,
  options: CollaborationResourcesOptions,
  errors: readonly string[],
): number {
  if (options.json) {
    output.stdout(
      `${JSON.stringify({
        schema: COLLAB_RESOURCES_SCHEMA,
        ok: false,
        status: 'invalid',
        action: options.action,
        errors,
      })}\n`,
    );
  } else {
    output.stdout(`Resource request invalid.\n`);
    for (const error of errors) output.stdout(`  - ${error}\n`);
  }
  return 2;
}

function failure(
  output: CliOutput,
  options: CollaborationResourcesOptions,
  value: TaskStoreFailure,
  exitCode: number,
): number {
  if (options.json) {
    output.stdout(
      `${JSON.stringify({
        schema: COLLAB_RESOURCES_SCHEMA,
        ok: false,
        status: exitCode === 2 ? 'invalid' : 'needs_input',
        action: options.action,
        code: value.code,
        message: value.message,
        nextAction: value.nextAction,
      })}\n`,
    );
  } else {
    output.stdout(`Resource operation needs input: ${value.message}\n`);
    if (value.nextAction) output.stdout(`  ${value.nextAction}\n`);
  }
  return exitCode;
}

function emitHuman(
  value: Record<string, unknown>,
  action: ResourceAction,
  output: CliOutput,
): void {
  if (action === 'list') {
    const counts = value.counts as { tasks: number; claims: number };
    output.stdout(
      `Domain resources: ${String(counts.tasks)} task(s), ${String(counts.claims)} claim(s), state ${String(value.state)}.\n`,
    );
    if ((value.unreadable_tasks as unknown[]).length)
      output.stdout(
        `  unreadable tasks: ${String((value.unreadable_tasks as unknown[]).length)}\n`,
      );
  } else if (value.applied === false) {
    output.stdout(
      `Resource ${action} plan validated; nothing was persisted.\n`,
    );
  } else {
    output.stdout(
      `Resource ${action} ${value.ok === true ? 'applied' : 'refused'}: ${String(value.reason ?? 'completed')}.\n`,
    );
  }
}

export async function runCollaborationResourcesCommand(
  options: CollaborationResourcesOptions,
  output: CliOutput,
): Promise<number> {
  if (options.action === null)
    return invalid(output, options, [
      'resource requires list, claim or release.',
    ]);
  if (options.taskRoot === null)
    return invalid(output, options, ['--task-root is required.']);
  if (!path.isAbsolute(options.taskRoot))
    return invalid(output, options, ['--task-root must be absolute.']);

  if (options.action === 'list') {
    const result = await listTaskResources(options.taskRoot);
    if (!result.ok) return failure(output, options, result, 1);
    if (options.json) output.stdout(`${JSON.stringify(result.value)}\n`);
    else emitHuman(result.value, options.action, output);
    return result.value.ok === true ? 0 : 1;
  }

  if (options.requestFile === null)
    return invalid(output, options, [`${options.action} requires --request.`]);
  if (!path.isAbsolute(options.requestFile))
    return invalid(output, options, ['--request must be absolute.']);
  const loaded = loadResourceRequest(options.requestFile, options.action);
  if (!loaded.ok) return failure(output, options, loaded, 2);
  const result = options.apply
    ? await applyResourceRequest(options.taskRoot, loaded.value.request)
    : await planResourceRequest(options.taskRoot, loaded.value.request);
  if (!result.ok) return failure(output, options, result, 1);
  if (options.json) output.stdout(`${JSON.stringify(result.value)}\n`);
  else emitHuman(result.value, options.action, output);
  return result.value.ok === true ? 0 : 1;
}
