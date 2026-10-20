import type { ChildProcess } from 'node:child_process';
import type { TaskRecord } from '../../collab/types.js';
import { errorCode, object, parseJson } from '../../collab/validation.js';
export interface ClaudeOptions {
  taskRoot: string;
  subtaskId: string;
  attempt: number;
  ownerEpoch: number;
  agentId: string;
  sessionId: string;
  cwd: string;
  claudeBin?: string;
  env?: NodeJS.ProcessEnv;
  nativeSessionId?: string;
  expectedPid?: number;
  expectedStartedAt?: number;
  evidenceDir?: string;
  timeoutMs?: number;
  pollMs?: number;
  stopTimeoutMs?: number;
  maxBytes?: number;
  streamGraceMs?: number;
  reason?: string;
}
interface Normalized extends Omit<
  ClaudeOptions,
  | 'nativeSessionId'
  | 'expectedPid'
  | 'expectedStartedAt'
  | 'evidenceDir'
  | 'env'
> {
  schema: string;
  claudeBin: string;
  env: NodeJS.ProcessEnv | undefined;
  nativeSessionId: string | null;
  expectedPid: number | null;
  expectedStartedAt: number | null;
  evidenceDir: string | null;
  timeoutMs: number;
  pollMs: number;
  stopTimeoutMs: number;
  maxBytes: number;
  streamGraceMs: number;
  record?: TaskRecord;
  taskId?: string;
  assigneeAgent?: string;
  assigneeSession?: string;
  assigneeHarness?: string | null;
}
interface CaptureOptions {
  timeoutMs?: number;
  maxBytes?: number;
  streamGraceMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv | undefined;
}
export interface CaptureResult {
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  parent_exited: boolean;
  stream_closed: boolean;
  streams_detached: boolean;
  timed_out: boolean;
  killed_after_eof_timeout: boolean;
  spawn_failed: boolean;
  spawn_error: string | null;
  truncated: boolean;
  stdout: Buffer;
  stderr: Buffer;
}
interface CancelContext {
  cancel_message_id: string | null;
  intent_recorded: boolean;
  intent_error: string | null;
  native_command_key: string | null;
  before: Record<string, unknown> | null;
  stop_command: Record<string, unknown> | null;
  last_observation: Record<string, unknown> | null;
  evidence_error: string | null;
}
export interface ClaudeObservation {
  schema: string;
  status: string;
  blockers: string[];
  claims_retained: boolean;
  reconciliation_required?: boolean;
  cancelled_message_sent?: boolean;
  task_result_claimed?: boolean;
  [key: string]: unknown;
}
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildMessage } from '../../collab/envelope.js';
import { submitMessage } from '../../collab/messages.js';
import { readRecord } from '../../collab/store.js';

// Native background-session query/cancel for Claude Code 2.1.292 as installed.
//
// Observed installed shape (evidence: claude-background-agents.json,
// claude-raw-stop-proof.json, task completion-20261016-a9f2):
//   active row:   {pid, id, cwd, kind:'background', startedAt, sessionId, name,
//                  status:'idle'|'busy', state:'blocked'|'working'}
//   terminal row: {id, cwd, kind:'background', startedAt, sessionId, name, state:'stopped'|'done'}
//
// Terminal shape observed on 2.1.292 after a real model reply plus native stop: `claude agents
// --json --all --cwd` returns `state:'done'` (not `stopped`) with the same id/sessionId/cwd/kind
// and no pid/status. `done` is a terminal lifecycle observation only; it is never a completed
// business result (evidence/claude-model-recovery.json).
//
//   * `sessionId` is the canonical native UUID; `id` (8 hex) is the CLI command key.
//     `claude logs <UUID>` exits 1 while `claude logs <id>` succeeds, so logs/stop always use
//     the exact associated command key, and the UUID is matched exactly (never a name/prefix).
//   * `--bg` ignores `--session-id` and picks its own UUID, so a requested UUID is never
//     treated as the observed one.
//   * `status:'idle'` is a live background process, not terminal task completion.
//   * The post-stop row keeps id/sessionId/cwd/kind with `state:'stopped'` and exposes no
//     pid/status; its `startedAt` is a service start time, not the process start time, so it is
//     never compared against the active row's `startedAt`. Absence of a terminal row is
//     `unknown`, not proof.
//
// It is deliberately NOT a print-session takeover: it never prompts, resumes, removes,
// respawns or attaches. It never uses the shared record as native status.

const SCHEMA = 'harness-collab/claude-native-session/1';
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_POLL_MS = 500;
const DEFAULT_STOP_TIMEOUT_MS = 15000;
const DEFAULT_STREAM_GRACE_MS = 500;
const ACCEPTED_HARNESSES = new Set(['claude', 'claude-code']);
const EXPECTED_RUNNER = 'claude-background-cli';
const COMMAND_KEY = /^[0-9a-f]{8}$/;
const ACTIVE_STATUS = new Set(['idle', 'busy', 'running', 'active', 'working']);
const ACTIVE_STATE = new Set(['blocked', 'working']);
// `done` is the observed post-stop shape after a real model reply (2.1.292). It is terminal for
// lifecycle purposes only and is never mapped to a completed task result.
const TERMINAL_STATE = new Set([
  'done',
  'stopped',
  'exited',
  'dead',
  'ended',
  'finished',
  'completed',
  'cancelled',
]);

export class ClaudeNativeRefusal extends Error {
  constructor(
    public readonly status: string,
    public readonly code: string,
    public readonly detail: string | null = null,
  ) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function refuse(
  code: string,
  status = 'invalid',
  detail: string | null = null,
): never {
  throw new ClaudeNativeRefusal(status, code, detail);
}
const sha256 = (bytes: Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();
const realpath = (file: string) => {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
};
const resolvePath = (file: string) => realpath(file) ?? path.resolve(file);

function absolute(value: unknown, code: string) {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    value.includes('\0')
  )
    refuse(code);
  return value;
}

function bounded(
  value: number | undefined,
  fallback: number,
  code: string,
  cap = MAX_TIMEOUT_MS,
) {
  const chosen = value ?? fallback;
  if (!Number.isSafeInteger(chosen) || chosen < 1 || chosen > cap) refuse(code);
  return chosen;
}

function normalize(options: ClaudeOptions): Normalized {
  const timeoutMs = bounded(
    options.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    'timeout_out_of_range',
  );
  if (!Number.isSafeInteger(options.attempt) || options.attempt < 1)
    refuse('invalid_attempt');
  if (!Number.isSafeInteger(options.ownerEpoch) || options.ownerEpoch < 1)
    refuse('invalid_owner_epoch');
  for (const key of ['taskRoot', 'agentId', 'sessionId'] as const) {
    if (typeof options[key] !== 'string' || !options[key].trim())
      refuse(`${key}_required`);
  }
  return {
    schema: SCHEMA,
    claudeBin:
      typeof options.claudeBin === 'string' && options.claudeBin
        ? options.claudeBin
        : 'claude',
    env: options.env ?? undefined,
    taskRoot: absolute(options.taskRoot, 'task_root_must_be_absolute'),
    subtaskId:
      typeof options.subtaskId === 'string' && options.subtaskId.trim()
        ? options.subtaskId
        : refuse('subtask_required'),
    attempt: options.attempt,
    ownerEpoch: options.ownerEpoch,
    agentId: options.agentId,
    sessionId: options.sessionId,
    nativeSessionId: options.nativeSessionId ?? null,
    cwd: absolute(options.cwd, 'cwd_must_be_absolute'),
    expectedPid: options.expectedPid ?? null,
    expectedStartedAt: options.expectedStartedAt ?? null,
    evidenceDir:
      options.evidenceDir === undefined || options.evidenceDir === null
        ? null
        : absolute(options.evidenceDir, 'evidence_dir_must_be_absolute'),
    timeoutMs,
    pollMs: bounded(options.pollMs, DEFAULT_POLL_MS, 'poll_ms_out_of_range'),
    stopTimeoutMs: bounded(
      options.stopTimeoutMs,
      DEFAULT_STOP_TIMEOUT_MS,
      'stop_timeout_out_of_range',
    ),
    maxBytes: bounded(
      options.maxBytes,
      MAX_BYTES,
      'max_bytes_out_of_range',
      MAX_BYTES,
    ),
    streamGraceMs: bounded(
      options.streamGraceMs,
      DEFAULT_STREAM_GRACE_MS,
      'stream_grace_out_of_range',
    ),
  };
}

/**
 * Bounded local subprocess capture. Parent exit is separate from stream close: after the parent
 * exits, only this module's own pipe handles are detached after a bounded grace, so a descendant
 * that inherited stdout cannot hold the promise open past its deadline. No descendant is
 * signalled. `streams_detached: true` means the output may be incomplete.
 */
export function runBounded(
  bin: string,
  args: string[],
  options: CaptureOptions = {},
): Promise<CaptureResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const streamGraceMs = options.streamGraceMs ?? DEFAULT_STREAM_GRACE_MS;
  return new Promise<CaptureResult>((resolve) => {
    const settle = (payload: CaptureResult) => resolve(payload);
    let child: ChildProcess;
    try {
      child = spawn(bin, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      settle({
        exit_code: null,
        signal: null,
        parent_exited: false,
        stream_closed: false,
        streams_detached: false,
        timed_out: false,
        killed_after_eof_timeout: false,
        spawn_failed: true,
        spawn_error: error instanceof Error ? error.message : String(error),
        truncated: false,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let killed = false;
    let spawnError: Error | null = null;
    let parentExited = false;
    let streamClosed = false;
    let streamsDetached = false;
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      settle({
        exit_code: exitCode,
        signal,
        parent_exited: parentExited,
        stream_closed: streamClosed,
        streams_detached: streamsDetached,
        timed_out: timedOut,
        killed_after_eof_timeout: killed,
        spawn_failed: spawnError !== null,
        spawn_error: spawnError?.message ?? null,
        truncated,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
      });
    };
    const collect = (list: Buffer[]) => (chunk: Buffer) => {
      const room = Math.max(0, maxBytes - bytes);
      if (room > 0) list.push(chunk.subarray(0, room));
      bytes += Math.min(room, chunk.length);
      if (chunk.length > room) truncated = true;
    };
    for (const [stream, list] of [
      [child.stdout, out],
      [child.stderr, err],
    ] as const) {
      stream?.on('data', collect(list));
      stream?.on('error', () => {
        /* drained; the exit path reports the outcome */
      });
    }
    child.stdin?.on('error', () => {
      /* drained */
    });
    child.on('error', (error) => {
      spawnError ??= error;
    });
    child.on('exit', (code, sig) => {
      parentExited = true;
      exitCode = code;
      signal = sig;
      grace = setTimeout(() => {
        if (streamClosed) return;
        streamsDetached = true;
        for (const stream of [child.stdin, child.stdout, child.stderr]) {
          try {
            stream?.destroy();
          } catch {
            /* already gone */
          }
        }
        setTimeout(finish, 25);
      }, streamGraceMs);
    });
    child.on('close', (code, sig) => {
      parentExited = true;
      if (exitCode === null) {
        exitCode = code;
        signal = sig;
      }
      streamClosed = true;
      clearTimeout(grace);
      finish();
    });
    timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
  });
}

/** The record supplies the expected identity only; it never supplies queried execution facts. */
function requireRecordTarget(opts: Normalized) {
  const record = readRecord(opts.taskRoot);
  if (!record) refuse('task_record_unavailable', 'needs_input');
  if (record.coordinator?.owner_epoch !== opts.ownerEpoch)
    refuse('stale_epoch', 'needs_input');
  const target = (record.attempts ?? []).find(
    (item) =>
      item.subtask_id === opts.subtaskId && item.attempt === opts.attempt,
  );
  if (!target) refuse('unknown_attempt', 'needs_input');
  const assignee = target.assignee ?? {};
  if (
    assignee.agent_id !== opts.agentId ||
    assignee.session_id !== opts.sessionId
  )
    refuse('wrong_assignee', 'needs_input');
  if (!ACCEPTED_HARNESSES.has(assignee.harness ?? ''))
    refuse(
      'native_harness_mismatch',
      'needs_input',
      `assignee harness ${assignee.harness ?? 'unknown'}`,
    );
  const native = target.native ?? {};
  if (native.runner !== EXPECTED_RUNNER)
    refuse(
      'native_runner_mismatch',
      'needs_input',
      `native runner ${native.runner ?? 'unknown'}`,
    );
  const nativeSessionId = native.session_id ?? null;
  const commandKey = native.run_id ?? null;
  if (nativeSessionId === null)
    refuse('native_session_unrecorded', 'needs_input');
  if (opts.nativeSessionId !== null && opts.nativeSessionId !== nativeSessionId)
    refuse('native_session_ref_mismatch', 'needs_input');
  if (typeof commandKey !== 'string' || !COMMAND_KEY.test(commandKey))
    refuse('native_command_key_unrecorded', 'needs_input');
  const recordedCwd = target.cwd ?? assignee.cwd ?? null;
  if (
    recordedCwd !== null &&
    resolvePath(recordedCwd) !== resolvePath(opts.cwd)
  )
    refuse('native_cwd_mismatch', 'needs_input');
  opts.record = record;
  opts.assigneeAgent = assignee.agent_id;
  opts.assigneeSession = assignee.session_id;
  opts.assigneeHarness = assignee.harness;
  return { record, target, nativeSessionId, commandKey };
}

async function listSessions(opts: Normalized) {
  const result = await runBounded(
    opts.claudeBin,
    ['agents', '--json', '--all', '--cwd', opts.cwd],
    {
      cwd: opts.cwd,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      maxBytes: opts.maxBytes,
      streamGraceMs: opts.streamGraceMs,
    },
  );
  if (result.spawn_failed)
    refuse('spawn_failed', 'needs_input', result.spawn_error);
  if (result.timed_out) refuse('native_discovery_timeout', 'needs_input');
  if (!result.parent_exited)
    refuse('native_discovery_parent_not_exited', 'needs_input');
  if (result.streams_detached)
    refuse('native_discovery_stream_unproven', 'needs_input');
  if (result.exit_code !== 0)
    refuse(
      'native_discovery_failed',
      'needs_input',
      `agents exited ${result.exit_code}`,
    );
  if (result.truncated) refuse('native_discovery_truncated', 'needs_input');
  const text = result.stdout.toString('utf8').trim();
  let parsed: unknown;
  try {
    parsed = parseJson(text);
  } catch {
    refuse('native_agents_json_invalid', 'needs_input');
  }
  if (!Array.isArray(parsed))
    refuse('native_agents_json_invalid', 'needs_input');
  if (!parsed.every(object))
    refuse('native_agents_json_invalid', 'needs_input');
  return { rows: parsed, exit_code: result.exit_code, captured_at: nowIso() };
}

function classifyRow(row: Record<string, unknown>) {
  if (typeof row.state === 'string' && TERMINAL_STATE.has(row.state))
    return {
      observation: 'terminal',
      native_state: row.state,
      native_status: typeof row.status === 'string' ? row.status : null,
    };
  if (typeof row.status === 'string' && ACTIVE_STATUS.has(row.status))
    return {
      observation: 'active',
      native_state: typeof row.state === 'string' ? row.state : null,
      native_status: row.status,
    };
  if (typeof row.state === 'string' && ACTIVE_STATE.has(row.state))
    return {
      observation: 'active',
      native_state: row.state,
      native_status: typeof row.status === 'string' ? row.status : null,
    };
  refuse(
    'native_status_unsupported',
    'needs_input',
    `status=${row.status ?? 'null'} state=${row.state ?? 'null'}`,
  );
}

/**
 * Exact canonical UUID + exact cwd + exact CLI command key + background kind. Pins (pid and the
 * active-row startedAt) are only applied to a live row, because the post-stop row deliberately
 * has no pid/status and its startedAt is a different thing entirely.
 */
function matchRow(
  rows: Record<string, unknown>[],
  {
    nativeSessionId,
    commandKey,
    cwd,
    expectedPid,
    expectedStartedAt,
  }: {
    nativeSessionId: string;
    commandKey: string;
    cwd: string;
    expectedPid: number | null;
    expectedStartedAt: number | null;
  },
) {
  const matches = rows.filter((row) => row.sessionId === nativeSessionId);
  if (matches.length === 0) refuse('native_session_absent', 'needs_input');
  if (matches.length > 1) refuse('native_session_ambiguous', 'needs_input');
  const row = matches[0]!;
  if (row.kind !== 'background')
    refuse(
      'native_kind_unsupported',
      'needs_input',
      String(row.kind ?? 'unknown'),
    );
  if (row.id !== commandKey)
    refuse(
      'native_command_key_mismatch',
      'needs_input',
      `row id ${row.id ?? 'unknown'}`,
    );
  if (typeof row.cwd !== 'string' || resolvePath(row.cwd) !== resolvePath(cwd))
    refuse('native_cwd_mismatch', 'needs_input');
  const classified = classifyRow(row);
  if (classified.observation === 'active') {
    if (
      expectedPid !== null &&
      row.pid !== undefined &&
      row.pid !== expectedPid
    )
      refuse('native_pid_mismatch', 'needs_input');
    if (expectedPid !== null && row.pid === undefined)
      refuse('native_pid_unsupported', 'needs_input');
    if (expectedStartedAt !== null && row.startedAt !== expectedStartedAt)
      refuse('native_started_at_mismatch', 'needs_input');
  }
  return {
    row,
    observation: classified.observation,
    native_state: classified.native_state,
    native_status: classified.native_status,
    command_key: row.id,
  };
}

function tryWritePrivate(file: string, bytes: Uint8Array) {
  try {
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    return { ref: file, digest: sha256(bytes), bytes: bytes.length };
  } catch (error) {
    return {
      error:
        errorCode(error) === 'EEXIST'
          ? 'evidence_exists'
          : 'evidence_write_failed',
    };
  }
}

/** Bounded exact `logs <command-key>` read; raw output is only persisted privately. */
async function readLogs(opts: Normalized, commandKey: string) {
  const result = await runBounded(opts.claudeBin, ['logs', commandKey], {
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    maxBytes: opts.maxBytes,
    streamGraceMs: opts.streamGraceMs,
  });
  if (result.spawn_failed)
    refuse('spawn_failed', 'needs_input', result.spawn_error);
  if (result.timed_out) refuse('native_logs_timeout', 'needs_input');
  const body = result.stdout;
  const evidence: Record<string, unknown> = {
    command_key: commandKey,
    exit_code: result.exit_code,
    parent_exited: result.parent_exited,
    stream_closed: result.stream_closed,
    streams_detached: result.streams_detached,
    timed_out: result.timed_out,
    truncated: result.truncated,
    lines: body
      .toString('utf8')
      .split('\n')
      .filter((line) => line.length > 0).length,
    bytes: body.length,
    digest: sha256(body),
    // Native terminal output commonly carries ANSI control sequences; the raw bytes are kept
    // private and never interpreted into a model receipt.
    ansi_sequences_present: body.includes(0x1b),
    captured_at: nowIso(),
  };
  if (opts.evidenceDir) {
    try {
      fs.mkdirSync(opts.evidenceDir, { recursive: true, mode: 0o700 });
    } catch {
      /* reported below */
    }
    const written = tryWritePrivate(
      path.join(opts.evidenceDir, 'claude-native-logs.txt'),
      body,
    );
    if (written.error) evidence.evidence_error = written.error;
    else evidence.raw_evidence = written;
  }
  return evidence;
}

function ids(opts: Normalized) {
  if (!opts.record?.coordinator || !opts.assigneeAgent || !opts.assigneeSession)
    refuse('protocol_identity_unavailable');
  const coordinator = opts.record.coordinator;
  return {
    taskId: opts.record.task_id,
    from: {
      agent_id: coordinator.agent_id,
      session_id: coordinator.session_id,
      harness: coordinator.harness ?? 'pi',
    },
    to: {
      agent_id: opts.assigneeAgent,
      session_id: opts.assigneeSession,
      harness: opts.assigneeHarness ?? 'claude',
    },
  };
}

/** Registers the query intent before any native read; returns the message id. */
function registerStatusQuery(opts: Normalized) {
  const { taskId, from, to } = ids(opts);
  const query = submitMessage(
    opts.taskRoot,
    buildMessage({
      type: 'STATUS_QUERY',
      task_id: taskId,
      from,
      to,
      owner_epoch: opts.ownerEpoch,
      body: { reason: 'native background-session observation' },
    }),
  );
  if (query.ok !== true)
    refuse('status_query_not_recorded', 'invalid', query.reason ?? null);
  return query.registration.message_id;
}

/** Reports the factual native observation; never maps a terminal session to task completion. */
function reportStatus(
  opts: Normalized,
  queryId: string,
  observed: Record<string, unknown>,
) {
  const { taskId, from, to } = ids(opts);
  const status = submitMessage(
    opts.taskRoot,
    buildMessage({
      type: 'STATUS',
      task_id: taskId,
      from: to,
      to: from,
      owner_epoch: opts.ownerEpoch,
      reply_to: queryId,
      subtask_id: opts.subtaskId,
      attempt: opts.attempt,
      body: {
        status: observed.observation === 'active' ? 'running' : 'unknown',
        native_session_id: observed.native_session_id,
        native_command_key: observed.command_key,
        native_state: observed.native_state,
        native_status: observed.native_status,
        native_cwd: observed.cwd,
        observation: observed.observation,
        evidence_ref:
          typeof observed.evidence_ref === 'string'
            ? observed.evidence_ref
            : null,
      },
    }),
  );
  if (status.ok !== true)
    refuse('status_not_recorded', 'invalid', status.reason ?? null);
  return status.registration.message_id;
}

function nativePayload<T extends Record<string, unknown>>(
  opts: Normalized,
  nativeSessionId: string,
  matched: ReturnType<typeof matchRow>,
  extra: T,
) {
  return {
    schema: SCHEMA,
    task_id: opts.taskId ?? undefined,
    subtask_id: opts.subtaskId,
    attempt: opts.attempt,
    owner_epoch: opts.ownerEpoch,
    native: {
      session_id: nativeSessionId,
      command_key: matched.command_key,
      cwd: matched.row.cwd,
      kind: matched.row.kind,
      status: matched.row.status ?? null,
      state: matched.row.state ?? null,
      pid: Number.isSafeInteger(matched.row.pid) ? matched.row.pid : null,
      started_at: Number.isSafeInteger(matched.row.startedAt)
        ? matched.row.startedAt
        : null,
    },
    ...extra,
  };
}

function refusalResult(
  schema: string,
  error: unknown,
  extra: Record<string, unknown> = {},
): ClaudeObservation {
  const known = error instanceof ClaudeNativeRefusal;
  return {
    schema,
    status: known ? error.status : 'invalid',
    blockers: [known ? error.code : 'internal_error'],
    detail: known
      ? error.detail
      : String(error instanceof Error ? error.message : error),
    ...extra,
    claims_retained: true,
  };
}

/**
 * Read-only observation of one exact recorded background session. Registers the intent first,
 * then reads native state; a missing/unknown row is `unknown`, never `stopped`.
 */
export async function queryClaudeSession(
  options: ClaudeOptions,
): Promise<ClaudeObservation> {
  const schema = SCHEMA;
  let statusQueryId: string | null = null;
  try {
    const opts = normalize(options);
    const target = requireRecordTarget(opts);
    opts.taskId = target.record.task_id ?? null;
    opts.record = target.record;
    opts.assigneeAgent = target.target.assignee?.agent_id ?? opts.agentId;
    opts.assigneeSession = target.target.assignee?.session_id ?? opts.sessionId;
    opts.assigneeHarness = target.target.assignee?.harness ?? 'claude';
    statusQueryId = registerStatusQuery(opts);
    const listed = await listSessions(opts);
    const matched = matchRow(listed.rows, {
      nativeSessionId: target.nativeSessionId,
      commandKey: target.commandKey,
      cwd: opts.cwd,
      expectedPid: opts.expectedPid,
      expectedStartedAt: opts.expectedStartedAt,
    });
    const logs = await readLogs(opts, target.commandKey);
    const result: ClaudeObservation = {
      ...nativePayload(opts, target.nativeSessionId, matched, {
        status: matched.observation,
        blockers: [],
        observation: matched.observation,
        task_result_claimed: false,
        transport: {
          kind: 'claude-cli-agents-json',
          queried_at: listed.captured_at,
          agents_exit_code: listed.exit_code,
          session_count: listed.rows.length,
        },
        logs,
      }),
      evidence: {
        request: ['agents --json --all --cwd', 'logs <command-key>'],
        observed_ids: {
          session_id: target.nativeSessionId,
          command_key: target.commandKey,
        },
        queried_at: listed.captured_at,
      },
      reconciliation_required: false,
      claims_retained: true,
    };
    try {
      const statusId = reportStatus(opts, statusQueryId, {
        observation: matched.observation,
        native_session_id: target.nativeSessionId,
        command_key: matched.command_key,
        native_state: matched.native_state,
        native_status: matched.native_status,
        cwd: matched.row.cwd,
        evidence_ref: object(logs.raw_evidence)
          ? (logs.raw_evidence['digest'] ?? logs.digest)
          : logs.digest,
      });
      result.protocol = { status_query: statusQueryId, status: statusId };
    } catch (error) {
      result.record_error =
        error instanceof ClaudeNativeRefusal
          ? errorCode(error)
          : 'internal_error';
      result.protocol = { status_query: statusQueryId, status: null };
    }
    return result;
  } catch (error) {
    return refusalResult(schema, error, { status_query: statusQueryId });
  }
}

/**
 * Request a stop of one exact recorded background session. A fresh active observation is
 * required first, the CANCEL intent is recorded, and only the matching command key is stopped.
 * The command's exit code is never the proof: the polled terminal native row is. Claims are
 * retained, no CANCELLED is sent, and any failure after the recorded intent still returns
 * `reconciliation_required: true` together with the known native observation.
 */
export async function cancelClaudeSession(
  options: ClaudeOptions,
): Promise<ClaudeObservation> {
  const schema = SCHEMA;
  const ctx: CancelContext = {
    cancel_message_id: null,
    intent_recorded: false,
    intent_error: null,
    native_command_key: null,
    before: null,
    stop_command: null,
    last_observation: null,
    evidence_error: null,
  };
  try {
    const opts = normalize(options);
    const target = requireRecordTarget(opts);
    opts.taskId = target.record.task_id ?? null;
    opts.record = target.record;
    opts.assigneeAgent = target.target.assignee?.agent_id ?? opts.agentId;
    opts.assigneeSession = target.target.assignee?.session_id ?? opts.sessionId;
    opts.assigneeHarness = target.target.assignee?.harness ?? 'claude';
    ctx.native_command_key = target.commandKey;
    const before = await listSessions(opts);
    const matched = matchRow(before.rows, {
      nativeSessionId: target.nativeSessionId,
      commandKey: target.commandKey,
      cwd: opts.cwd,
      expectedPid: opts.expectedPid,
      expectedStartedAt: opts.expectedStartedAt,
    });
    ctx.before = {
      observation: matched.observation,
      status: matched.row.status ?? null,
      state: matched.row.state ?? null,
      pid: Number.isSafeInteger(matched.row.pid) ? matched.row.pid : null,
      at: before.captured_at,
    };
    if (matched.observation !== 'active') {
      return {
        ...nativePayload(opts, target.nativeSessionId, matched, {
          status: 'not_cancellable',
          blockers: ['native_not_active'],
          observation: matched.observation,
          task_result_claimed: false,
        }),
        reconciliation_required: false,
        claims_retained: true,
        cancelled_message_sent: false,
      };
    }
    const { taskId, from, to } = ids(opts);
    const intent = submitMessage(
      opts.taskRoot,
      buildMessage({
        type: 'CANCEL',
        task_id: taskId,
        from,
        to,
        subtask_id: opts.subtaskId,
        attempt: opts.attempt,
        owner_epoch: opts.ownerEpoch,
        body: {
          reason: options.reason ?? 'native background-session cancellation',
          native_session_id: target.nativeSessionId,
          native_command_key: target.commandKey,
          native_status: matched.native_status,
        },
      }),
    );
    if (intent.ok !== true) {
      ctx.intent_error = intent.reason ?? 'cancel_intent_not_recorded';
      return {
        ...nativePayload(opts, target.nativeSessionId, matched, {
          status: 'invalid',
          blockers: ['cancel_intent_not_recorded'],
          intent_error: ctx.intent_error,
        }),
        reconciliation_required: false,
        claims_retained: true,
        cancelled_message_sent: false,
      };
    }
    ctx.cancel_message_id = intent.registration.message_id;
    ctx.intent_recorded = true;
    const stop = await runBounded(opts.claudeBin, ['stop', target.commandKey], {
      cwd: opts.cwd,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      maxBytes: opts.maxBytes,
      streamGraceMs: opts.streamGraceMs,
    });
    ctx.stop_command = {
      exit_code: stop.exit_code,
      signal: stop.signal,
      timed_out: stop.timed_out,
      parent_exited: stop.parent_exited,
      streams_detached: stop.streams_detached,
      spawn_failed: stop.spawn_failed,
      spawn_error: stop.spawn_error,
      note: 'exit 0 alone is not stop proof',
    };
    const deadline = Date.now() + opts.stopTimeoutMs;
    let terminal: Record<string, unknown> | null = null;
    for (;;) {
      try {
        const listed = await listSessions(opts);
        const current = matchRow(listed.rows, {
          nativeSessionId: target.nativeSessionId,
          commandKey: target.commandKey,
          cwd: opts.cwd,
          expectedPid: null,
          expectedStartedAt: null,
        });
        ctx.last_observation = {
          observation: current.observation,
          state: current.native_state,
          status: current.native_status,
          at: listed.captured_at,
        };
        if (current.observation === 'terminal') {
          terminal = ctx.last_observation;
          break;
        }
      } catch (error) {
        if (!(error instanceof ClaudeNativeRefusal)) throw error;
        ctx.last_observation = {
          observation: 'unknown',
          blocker: errorCode(error),
          at: nowIso(),
        };
      }
      if (Date.now() >= deadline) break;
      await delay(Math.min(opts.pollMs, Math.max(1, deadline - Date.now())));
    }
    const evidence: Record<string, unknown> = {
      request: ['agents --json --all --cwd', 'stop <command-key>'],
      observed_ids: {
        session_id: target.nativeSessionId,
        command_key: target.commandKey,
      },
      cancel_message_id: ctx.cancel_message_id,
      before: ctx.before,
      stop_command: ctx.stop_command,
      last_observation: ctx.last_observation,
      queried_at: nowIso(),
    };
    if (opts.evidenceDir) {
      try {
        fs.mkdirSync(opts.evidenceDir, { recursive: true, mode: 0o700 });
      } catch {
        /* reported below */
      }
      const written = tryWritePrivate(
        path.join(opts.evidenceDir, 'claude-native-cancel.json'),
        Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`),
      );
      if (written.error) ctx.evidence_error = written.error;
      else evidence.evidence_ref = written;
    }
    if (terminal) {
      return {
        ...nativePayload(opts, target.nativeSessionId, matched, {
          status: 'terminal',
          blockers: [],
          observation: 'terminal',
          task_result_claimed: false,
        }),
        native_terminal: terminal,
        evidence,
        evidence_error: ctx.evidence_error,
        cancel_message_id: ctx.cancel_message_id,
        intent_recorded: ctx.intent_recorded,
        reconciliation_required: true,
        claims_retained: true,
        cancelled_message_sent: false,
      };
    }
    return {
      ...nativePayload(opts, target.nativeSessionId, matched, {
        status: 'needs_input',
        blockers: ['native_terminal_state_not_observed'],
        observation: 'unknown',
        task_result_claimed: false,
      }),
      evidence,
      evidence_error: ctx.evidence_error,
      cancel_message_id: ctx.cancel_message_id,
      intent_recorded: ctx.intent_recorded,
      reconciliation_required: true,
      claims_retained: true,
      cancelled_message_sent: false,
    };
  } catch (error) {
    return refusalResult(schema, error, {
      cancel_message_id: ctx.cancel_message_id,
      intent_recorded: ctx.intent_recorded,
      intent_error: ctx.intent_error,
      native_command_key: ctx.native_command_key,
      before: ctx.before,
      stop_command: ctx.stop_command,
      last_observation: ctx.last_observation,
      evidence_error: ctx.evidence_error,
      reconciliation_required: ctx.intent_recorded,
      cancelled_message_sent: false,
    });
  }
}
