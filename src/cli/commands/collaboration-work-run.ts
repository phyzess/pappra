import path from 'node:path';
import { readBoundedFile } from '../../app/bounded-file.js';
import {
  COLLAB_WORK_EXECUTION_SCHEMA,
  runWorkExecution,
  type WorkExecutionAdapter,
  type WorkExecutionReport,
  type WorkExecutionRequest,
} from '../../app/collab-work-execution.js';
import type { CliOutput } from '../output.js';

const MAX_REQUEST_BYTES = 64 * 1024;

export const collaborationWorkRunUsage =
  'pappra collab work-run --request <abs work-execution.json> [--apply] [--json]\n\n' +
  'Without --apply this is a zero-write, zero-notification plan. Apply revalidates the\n' +
  'pinned work plan, current assignments, capability cards, coordinator epoch, resource\n' +
  'claims and visible participant binding; it records a durable per-node intent before\n' +
  'one bounded concurrent notification batch. Existing/unknown intents are reconciliation\n' +
  'only and are never automatically replayed. This command never launches sessions, merges\n' +
  'code or accepts a report.';

export interface CollaborationWorkRunOptions {
  readonly requestFile: string | null;
  readonly apply: boolean;
  readonly json: boolean;
}

export interface CollaborationWorkRunParse {
  readonly options: CollaborationWorkRunOptions;
  readonly errors: readonly string[];
}

export interface WorkExecutionRequestFile {
  readonly schema: 'pappra/collab-work-execution-request/1';
  readonly task_root: string;
  readonly plan_file: string;
  readonly binding_file: string;
  readonly caller: {
    readonly agent_id: string;
    readonly session_id: string;
    readonly harness: string;
    readonly cwd: string;
  };
  readonly caller_pane: string;
  readonly capability_cards: readonly {
    readonly assignment_id: string;
    readonly capabilities_file: string;
  }[];
  readonly max_concurrency?: number;
}

export function parseCollaborationWorkRunArgs(
  argv: readonly string[],
): CollaborationWorkRunParse {
  const errors: string[] = [];
  let requestFile: string | null = null;
  let apply = false;
  let json = false;
  let sawApply = false;
  let sawJson = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--request') {
      if (requestFile !== null)
        errors.push('--request may be given only once.');
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--'))
        errors.push('--request requires a value.');
      else {
        requestFile = value;
        index += 1;
      }
    } else if (arg === '--apply') {
      if (sawApply) errors.push('--apply may be given only once.');
      sawApply = true;
      apply = true;
    } else if (arg === '--json') {
      if (sawJson) errors.push('--json may be given only once.');
      sawJson = true;
      json = true;
    } else errors.push(`unknown option: ${String(arg)}`);
  }
  return { options: { requestFile, apply, json }, errors };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbsolute(value: unknown): value is string {
  return typeof value === 'string' && path.isAbsolute(value);
}

function loadRequest(
  file: string,
):
  | { readonly ok: true; readonly value: WorkExecutionRequest }
  | { readonly ok: false; readonly error: string } {
  const read = readBoundedFile(file, MAX_REQUEST_BYTES);
  if (!read.ok) return { ok: false, error: `request_file_${read.code}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text) as unknown;
  } catch {
    return { ok: false, error: 'request_file_invalid_json' };
  }
  if (
    !isObject(parsed) ||
    parsed.schema !== 'pappra/collab-work-execution-request/1'
  )
    return { ok: false, error: 'request_schema_invalid' };
  const keys = Object.keys(parsed).sort();
  const expected = [
    'binding_file',
    'caller',
    'caller_pane',
    'capability_cards',
    'plan_file',
    'schema',
    'task_root',
  ];
  const expectedOptional = [...expected, 'max_concurrency'].sort();
  if (
    keys.join('|') !== expected.sort().join('|') &&
    keys.join('|') !== expectedOptional.join('|')
  )
    return { ok: false, error: 'request_fields_invalid' };
  if (
    !isAbsolute(parsed.task_root) ||
    !isAbsolute(parsed.plan_file) ||
    !isAbsolute(parsed.binding_file)
  )
    return { ok: false, error: 'request_paths_must_be_absolute' };
  if (
    typeof parsed.caller_pane !== 'string' ||
    !/^[A-Za-z0-9]+:p[A-Za-z0-9]+$/.test(parsed.caller_pane)
  )
    return { ok: false, error: 'caller_pane_invalid' };
  if (
    !isObject(parsed.caller) ||
    Object.keys(parsed.caller).sort().join('|') !==
      'agent_id|cwd|harness|session_id' ||
    typeof parsed.caller.agent_id !== 'string' ||
    typeof parsed.caller.session_id !== 'string' ||
    typeof parsed.caller.harness !== 'string' ||
    !isAbsolute(parsed.caller.cwd)
  )
    return { ok: false, error: 'caller_identity_invalid' };
  if (
    !Array.isArray(parsed.capability_cards) ||
    parsed.capability_cards.length > 64
  )
    return { ok: false, error: 'capability_cards_invalid' };
  const assignmentIds = new Set<string>();
  const cards: { assignment_id: string; capabilities_file: string }[] = [];
  for (const item of parsed.capability_cards) {
    if (
      !isObject(item) ||
      Object.keys(item).sort().join('|') !==
        'assignment_id|capabilities_file' ||
      typeof item.assignment_id !== 'string' ||
      !isAbsolute(item.capabilities_file) ||
      assignmentIds.has(item.assignment_id)
    )
      return { ok: false, error: 'capability_cards_invalid' };
    assignmentIds.add(item.assignment_id);
    cards.push({
      assignment_id: item.assignment_id,
      capabilities_file: item.capabilities_file,
    });
  }
  const maxConcurrency = parsed.max_concurrency;
  if (
    maxConcurrency !== undefined &&
    (typeof maxConcurrency !== 'number' ||
      !Number.isSafeInteger(maxConcurrency) ||
      maxConcurrency < 1 ||
      maxConcurrency > 8)
  )
    return { ok: false, error: 'max_concurrency_invalid' };
  return {
    ok: true,
    value: {
      task_root: parsed.task_root,
      plan_file: parsed.plan_file,
      binding_file: parsed.binding_file,
      caller: parsed.caller as WorkExecutionRequestFile['caller'],
      caller_pane: parsed.caller_pane,
      capability_cards: cards,
      ...(maxConcurrency === undefined
        ? {}
        : { max_concurrency: maxConcurrency }),
    },
  };
}

function invalid(
  output: CliOutput,
  options: CollaborationWorkRunOptions,
  errors: readonly string[],
): number {
  if (options.json)
    output.stdout(
      `${JSON.stringify({ schema: COLLAB_WORK_EXECUTION_SCHEMA, ok: false, status: 'invalid', errors })}\n`,
    );
  else {
    output.stdout('Work execution request invalid.\n');
    for (const error of errors) output.stdout(`  - ${error}\n`);
    output.stdout(`\n${collaborationWorkRunUsage}\n`);
  }
  return 2;
}

function emitHuman(report: WorkExecutionReport, output: CliOutput): void {
  output.stdout(
    `Work execution ${report.apply ? 'apply' : 'plan'}: ${report.status}${report.task_id ? ` (${report.task_id})` : ''}.\n`,
  );
  output.stdout(
    `  nodes ${report.nodes.length}, concurrent limit ${report.concurrency.limit}, actual overlap ${report.concurrency.actual_overlap ? 'yes' : 'no'}\n`,
  );
  for (const node of report.nodes) {
    output.stdout(
      `  ${node.role} ${node.node_id} (${node.assignment_id}#${node.attempt}): ${node.execution_status}; acceptance ${node.acceptance}\n`,
    );
    for (const blocker of node.blockers) output.stdout(`    - ${blocker}\n`);
    if (node.intent_message_id)
      output.stdout(`    intent: ${node.intent_message_id}\n`);
  }
  output.stdout(
    `  immutable report pointers: ${report.reports.length}; no merge or acceptance performed\n`,
  );
}

export async function runCollaborationWorkRunCommand(
  options: CollaborationWorkRunOptions,
  output: CliOutput,
  deps: { readonly adapter?: WorkExecutionAdapter } = {},
): Promise<number> {
  if (options.requestFile === null)
    return invalid(output, options, ['--request is required.']);
  if (!path.isAbsolute(options.requestFile))
    return invalid(output, options, ['--request must be absolute.']);
  const request = loadRequest(options.requestFile);
  if (!request.ok) return invalid(output, options, [request.error]);
  const report = await runWorkExecution(
    { request: request.value, apply: options.apply },
    deps,
  );
  if (options.json) output.stdout(`${JSON.stringify(report)}\n`);
  else emitHuman(report, output);
  if (report.status === 'planned' || report.status === 'applied') return 0;
  return report.status === 'invalid' ? 2 : 1;
}
