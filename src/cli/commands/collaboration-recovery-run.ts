import path from 'node:path';

import { readBoundedFile } from '../../app/bounded-file.js';
import {
  createHerdrRecoveryController,
  executeRecovery,
  type RecoveryController,
  type RecoveryExecutionMode,
  type RecoveryExecutionRequest,
} from '../../app/collab-recovery-executor.js';
import type { RecoveryPolicy } from '../../app/collab-recovery-projection.js';
import type { Identity } from '../../collab/types.js';
import type { CliOutput } from '../output.js';

export const COLLAB_RECOVERY_RUN_SCHEMA =
  'pappra/collab-recovery-run/1' as const;

const MAX_REQUEST_BYTES = 64 * 1024;

export const collaborationRecoveryRunUsage =
  'pappra collab recovery-run --request <abs recovery-run.json> [--apply] [--json]\n\n' +
  'Durable recovery execution for a single task. Without --apply this is a strict dry\n' +
  'plan: it reads the current task and recommendation and writes nothing. With --apply,\n' +
  'the request must pin the exact session, cwd, harness, pane and bounded task-local\n' +
  'binding path/digest for the admitted current task participant; no identity or\n' +
  'participant fallback is accepted. The live target and current authority are rechecked\n' +
  'before prompting. It never spawns a session, overrides a model, installs anything or\n' +
  'auto-approves.';
/** Typed options for the handler; a parser rejects duplicate and unknown flags at the boundary. */
export interface CollaborationRecoveryRunOptions {
  readonly requestFile: string | null;
  readonly apply: boolean;
  readonly json: boolean;
}

export interface CollaborationRecoveryRunParse {
  readonly options: CollaborationRecoveryRunOptions;
  readonly errors: readonly string[];
}

/** The request file supplied to the handler; mode is derived from the --apply flag, not the file. */
export interface RecoveryRunRequestFile {
  readonly schema: 'pappra/collab-recovery-run-request/1';
  readonly taskRoot: string;
  readonly planFile: string;
  readonly self: Identity;
  readonly policy: RecoveryPolicy;
  readonly expected?: {
    readonly session_id: string;
    readonly cwd?: string | null;
    readonly binding_ref?: string | null;
    readonly binding_digest?: string | null;
    readonly pane_id?: string | null;
    readonly harness?: string | null;
  } | null;
  readonly requestId: string;
  readonly target?: { readonly agent: string } | null;
}

/** Parse argv for the recovery-run command, rejecting duplicate and unknown options. */
export function parseCollaborationRecoveryRunArgs(
  argv: readonly string[],
): CollaborationRecoveryRunParse {
  const errors: string[] = [];
  let requestFile: string | null = null;
  let apply = false;
  let json = false;
  let sawApply = false;
  let sawJson = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--request') {
      if (requestFile !== null)
        errors.push('--request may be given only once.');
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--'))
        errors.push('--request requires a value.');
      else {
        requestFile = value;
        i += 1;
      }
    } else if (arg === '--apply') {
      if (sawApply) errors.push('--apply may be given only once.');
      sawApply = true;
      apply = true;
    } else if (arg === '--json') {
      if (sawJson) errors.push('--json may be given only once.');
      sawJson = true;
      json = true;
    } else {
      errors.push(`unknown option: ${String(arg)}`);
    }
  }
  return { options: { requestFile, apply, json }, errors };
}

function isIdentity(value: unknown): value is Identity {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Identity).agent_id === 'string' &&
    typeof (value as Identity).session_id === 'string' &&
    (typeof (value as Identity).harness === 'string' ||
      (value as Identity).harness === null)
  );
}
function isPinnedExpected(value: unknown): value is {
  readonly session_id: string;
  readonly cwd: string;
  readonly binding_ref: string;
  readonly binding_digest: string;
  readonly pane_id: string;
  readonly harness: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const expected = value as Record<string, unknown>;
  const keys = Object.keys(expected).sort();
  return (
    keys.join('|') ===
      'binding_digest|binding_ref|cwd|harness|pane_id|session_id' &&
    typeof expected.session_id === 'string' &&
    expected.session_id.length > 0 &&
    typeof expected.cwd === 'string' &&
    path.isAbsolute(expected.cwd) &&
    typeof expected.binding_ref === 'string' &&
    path.isAbsolute(expected.binding_ref) &&
    typeof expected.binding_digest === 'string' &&
    /^sha256:[0-9a-f]{64}$/.test(expected.binding_digest) &&
    typeof expected.pane_id === 'string' &&
    /^[A-Za-z0-9]+:p[A-Za-z0-9]+$/.test(expected.pane_id) &&
    typeof expected.harness === 'string' &&
    expected.harness.length > 0
  );
}

function loadRequestFile(
  file: string,
): { ok: true; value: RecoveryRunRequestFile } | { ok: false; error: string } {
  const read = readBoundedFile(file, MAX_REQUEST_BYTES);
  if (!read.ok)
    return { ok: false, error: `request file unreadable (${read.code}).` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { ok: false, error: 'request file is not valid JSON.' };
  }
  if (typeof parsed !== 'object' || parsed === null)
    return { ok: false, error: 'request must be an object.' };
  const raw = parsed as Record<string, unknown>;
  if (raw.schema !== 'pappra/collab-recovery-run-request/1')
    return { ok: false, error: 'unsupported request schema.' };
  if (typeof raw.taskRoot !== 'string' || !path.isAbsolute(raw.taskRoot))
    return { ok: false, error: 'taskRoot must be an absolute path.' };
  if (typeof raw.planFile !== 'string' || !path.isAbsolute(raw.planFile))
    return { ok: false, error: 'planFile must be an absolute path.' };
  if (!isIdentity(raw.self))
    return { ok: false, error: 'self must be a valid identity.' };
  const policy = raw.policy as RecoveryPolicy | undefined;
  if (
    typeof policy !== 'object' ||
    policy === null ||
    (policy.role !== 'writer' &&
      policy.role !== 'coordinator' &&
      policy.role !== 'reviewer')
  )
    return {
      ok: false,
      error: 'policy.role must be writer, coordinator or reviewer.',
    };
  if (typeof raw.requestId !== 'string' || raw.requestId.length === 0)
    return { ok: false, error: 'requestId must be a non-empty string.' };
  if (
    raw.expected !== undefined &&
    raw.expected !== null &&
    !isPinnedExpected(raw.expected)
  )
    return {
      ok: false,
      error:
        'expected must pin session, cwd, harness, pane, binding_ref and binding_digest exactly.',
    };
  if (
    raw.target !== undefined &&
    raw.target !== null &&
    (typeof raw.target !== 'object' ||
      Array.isArray(raw.target) ||
      typeof (raw.target as Record<string, unknown>).agent !== 'string' ||
      !(raw.target as Record<string, unknown>).agent)
  )
    return {
      ok: false,
      error: 'target.agent must be a non-empty Herdr agent name.',
    };
  return { ok: true, value: raw as unknown as RecoveryRunRequestFile };
}

function invalid(
  output: CliOutput,
  options: CollaborationRecoveryRunOptions,
  errors: readonly string[],
): number {
  if (options.json)
    output.stdout(
      `${JSON.stringify({ schema: COLLAB_RECOVERY_RUN_SCHEMA, ok: false, status: 'invalid', errors })}\n`,
    );
  else {
    output.stdout('Recovery run request invalid.\n');
    for (const error of errors) output.stdout(`  - ${error}\n`);
  }
  return 2;
}

/**
 * Durable recovery execution handler, exported for the integration router. It builds a Herdr-backed
 * controller only for an `--apply` request that names a target agent; a dry plan needs no controller
 * and issues no effect.
 */
export async function runCollaborationRecoveryRunCommand(
  options: CollaborationRecoveryRunOptions,
  output: CliOutput,
  deps: { readonly controller?: RecoveryController } = {},
): Promise<number> {
  if (options.requestFile === null)
    return invalid(output, options, ['--request is required.']);
  if (!path.isAbsolute(options.requestFile))
    return invalid(output, options, ['--request must be absolute.']);
  const loaded = loadRequestFile(options.requestFile);
  if (!loaded.ok) return invalid(output, options, [loaded.error]);

  const request = loaded.value;
  const mode: RecoveryExecutionMode = options.apply ? 'apply' : 'plan';

  if (
    mode === 'apply' &&
    (!isPinnedExpected(request.expected) ||
      typeof request.target?.agent !== 'string' ||
      request.target.agent.length === 0)
  )
    return invalid(output, options, [
      'apply requires a complete expected session/cwd/harness/pane plus a task-local binding_ref and binding_digest, and request.target.agent.',
    ]);
  let controller: RecoveryController;
  if (deps.controller) controller = deps.controller;
  else if (mode === 'apply') {
    if (!request.target || typeof request.target.agent !== 'string')
      return invalid(output, options, [
        'apply requires request.target.agent for the continuation wake.',
      ]);
    controller = createHerdrRecoveryController(
      { env: process.env },
      { agent: request.target.agent },
    );
  } else {
    controller = {
      id: 'recovery-plan-noop',
      perform: async () => ({
        disposition: 'unknown',
        detail: 'plan mode issues no effect',
        observation: 'none',
      }),
    };
  }

  const executorRequest: RecoveryExecutionRequest = {
    taskRoot: request.taskRoot,
    planFile: request.planFile,
    self: request.self,
    policy: request.policy,
    requestId: request.requestId,
    mode,
    ...(isPinnedExpected(request.expected)
      ? {
          expectedSession: {
            session_id: request.expected.session_id,
            cwd: request.expected.cwd,
            binding_digest: request.expected.binding_digest,
            binding_ref: request.expected.binding_ref,
            target_agent: request.target?.agent ?? null,
            pane_id: request.expected.pane_id,
            harness: request.expected.harness,
          },
        }
      : {}),
  };

  const result = await executeRecovery(executorRequest, { controller });

  if (options.json) {
    output.stdout(
      `${JSON.stringify({ schema: COLLAB_RECOVERY_RUN_SCHEMA, ok: result.ok, executor: result })}\n`,
    );
  } else {
    output.stdout(
      `Recovery ${mode}: ${result.status}${result.action ? ` (${result.action.kind} ${result.action.subtask_id ?? '-'})` : ''}.\n`,
    );
    for (const note of result.notes) output.stdout(`  - ${note}\n`);
    if (result.reservation)
      output.stdout(
        `  reservation: ${result.reservation.created ? 'created' : 'existing'} ${result.reservation.key.slice(0, 12)} outcome=${result.reservation.outcome ?? 'none'}\n`,
      );
  }
  // Exit success for a clean plan or a positively issued/deferred apply; block otherwise.
  const good =
    result.status === 'planned' ||
    result.status === 'applied' ||
    result.status === 'deferred' ||
    result.status === 'noop';
  return good ? 0 : 1;
}
