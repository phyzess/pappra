import {
  COLLAB_BINDING_RESULT_SCHEMA,
  bindAlias,
  listBindings,
  resolveBinding,
  unbindAlias,
  type BindingCommandOptions,
  type BindingServiceFailure,
} from '../../app/collab-bindings.js';
import type { CliOutput } from '../output.js';

export const collaborationBindingUsage =
  'pappra collab binding list [--root <abs workspace>] [--json]\n' +
  'pappra collab binding resolve --task-id <alias> [--root <abs>] [--roots <abs roots.json>] [--json]\n' +
  'pappra collab binding bind --task-id <alias> --record <abs task.json> [--root <abs>] [--apply] [--json]\n' +
  'pappra collab binding unbind --task-id <alias> [--root <abs>] [--apply] [--json]\n\n' +
  'Workspace-local alias pointers to authoritative collaboration records. The index\n' +
  'contains pointer metadata only; it never copies protocol content,\n' +
  'starts/adopts an execution or treats a target as live. Mutations plan by default.';

export type BindingAction = 'list' | 'resolve' | 'bind' | 'unbind';

export interface CollaborationBindingOptions {
  readonly action: BindingAction | null;
  readonly root: string | null;
  readonly taskId: string | null;
  readonly record: string | null;
  readonly roots: string | null;
  readonly apply: boolean;
  readonly json: boolean;
}

function outputFailure(
  output: CliOutput,
  options: CollaborationBindingOptions,
  value: BindingServiceFailure,
  exitCode: number,
): number {
  const body = {
    schema: COLLAB_BINDING_RESULT_SCHEMA,
    ok: false,
    status: exitCode === 2 ? 'invalid' : 'needs_input',
    action: options.action,
    code: value.code,
    message: value.message,
    nextAction: value.nextAction,
    ...(value.details === undefined ? {} : { details: value.details }),
  };
  if (options.json) output.stdout(`${JSON.stringify(body)}\n`);
  else {
    output.stdout(
      `Binding ${exitCode === 2 ? 'invalid' : 'needs input'}: ${value.message}\n`,
    );
    if (value.nextAction) output.stdout(`  ${value.nextAction}\n`);
    for (const detail of value.details ?? []) output.stdout(`  - ${detail}\n`);
  }
  return exitCode;
}

function invalid(
  output: CliOutput,
  options: CollaborationBindingOptions,
  message: string,
): number {
  return outputFailure(
    output,
    options,
    {
      ok: false,
      code: 'invalid_options',
      message,
      nextAction: `Use ${collaborationBindingUsage.split('\n')[0]}.`,
    },
    2,
  );
}

function emitList(value: Record<string, unknown>, output: CliOutput): void {
  const counts = value.counts as { bindings: number; unbound: number };
  output.stdout(
    `Bindings: ${String(counts.bindings)} binding(s), ${String(counts.unbound)} tombstone(s).\n`,
  );
  for (const entry of value.bindings as Record<string, unknown>[]) {
    output.stdout(
      `  ${String(entry.alias)} -> ${String(entry.record)} [${String(entry.status)}]\n`,
    );
  }
  if (value.truncated === true) {
    const omitted = value.omitted as { bindings: number; unbound: number };
    output.stdout(
      `  omitted: ${String(omitted.bindings)} binding(s), ${String(omitted.unbound)} tombstone(s)\n`,
    );
  }
}

function emitResolve(value: Record<string, unknown>, output: CliOutput): void {
  output.stdout(
    `Alias ${String(value.alias)}: ${String(value.status)} (usable ${String(value.usable)}).\n`,
  );
  const target = value.target as Record<string, unknown> | null;
  if (target) {
    output.stdout(
      `  record: ${String(target.record)} revision ${String(target.state_revision)}; coordinator epoch ${String(target.coordinator_epoch)}; frozen ${String(target.dispatch_frozen)}\n`,
    );
    output.stdout(
      `  attempts: ${String(target.attempt_count)}; scope: ${String(value.scope)}; live status: ${String(value.liveStatus)}\n`,
    );
  }
  for (const candidate of value.candidates as string[])
    output.stdout(`  candidate: ${candidate}\n`);
  for (const error of value.errors as string[]) output.stdout(`  ! ${error}\n`);
}

function emitMutation(
  value: Record<string, unknown>,
  action: 'bind' | 'unbind',
  output: CliOutput,
): void {
  if (value.status === 'planned') {
    output.stdout(
      action === 'bind'
        ? 'Bind plan validates the alias, target and index; nothing was written.\n'
        : 'Unbind plan validates the alias and index; nothing was written.\n',
    );
    return;
  }
  output.stdout(
    `${action === 'bind' ? 'Bind' : 'Unbind'} ${String(value.status)}; applied ${String(value.applied)}.\n`,
  );
  const target = value.target as Record<string, unknown> | undefined;
  if (target) output.stdout(`  target: ${String(target.record)}\n`);
}

export async function runCollaborationBindingCommand(
  options: CollaborationBindingOptions,
  output: CliOutput,
): Promise<number> {
  if (options.action === null)
    return invalid(
      output,
      options,
      'binding requires list/resolve/bind/unbind.',
    );
  const serviceOptions: BindingCommandOptions = {
    root: options.root,
    taskId: options.taskId,
    record: options.record,
    roots: options.roots,
    apply: options.apply,
  };
  const result =
    options.action === 'list'
      ? await listBindings(serviceOptions)
      : options.action === 'resolve'
        ? await resolveBinding(serviceOptions)
        : options.action === 'bind'
          ? await bindAlias(serviceOptions)
          : await unbindAlias(serviceOptions);
  if (!result.ok) {
    const exitCode =
      result.code === 'invalid_options' ||
      result.code === 'workspace_unavailable' ||
      result.code === 'bindings_invalid' ||
      result.code === 'roots_invalid'
        ? 2
        : 1;
    return outputFailure(output, options, result, exitCode);
  }
  if (options.json) output.stdout(`${JSON.stringify(result.value)}\n`);
  else if (options.action === 'list') emitList(result.value, output);
  else if (options.action === 'resolve') emitResolve(result.value, output);
  else emitMutation(result.value, options.action, output);
  if (options.action === 'resolve') {
    const status = result.value.status;
    return status === 'binding' ||
      status === 'discovery-unique' ||
      status === 'unbound' ||
      status === 'none'
      ? 0
      : 1;
  }
  return 0;
}
