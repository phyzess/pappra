import type { ChildProcess } from 'node:child_process';
import type { TaskRecord } from '../../collab/types.js';
import { object, parseJson, errorCode } from '../../collab/validation.js';
import {
  isRecord,
  type NativeRecord,
  type NativeReply,
  type NativeEvent,
  type NativeEntry,
} from './protocol.js';
export interface TransportOptions {
  cwd: string;
  codexBin?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  args?: never;
  deadlineMs?: number;
  maxBytes?: number | undefined;
  controlled?: boolean;
  initialize?: boolean;
  onServerRequest?: (request: {
    id: string | number;
    method: string;
    params: unknown;
  }) => Record<string, unknown>;
}
interface Pending {
  resolve: (reply: NativeReply) => void;
  reject: (error: unknown) => void;
}
interface RequestLog {
  id: string;
  method: string;
  at: string;
  ok: boolean;
  code?: string | null;
}
interface TransportState {
  partial: Buffer;
  bytes: number;
  events: NativeEvent[];
  serverRequests: { id: string | number; method: string; at: string }[];
  pending: Map<string | number, Pending>;
  fatal: CodexNativeRefusal | null;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  spawnFailed: boolean;
  requestLog: RequestLog[];
  streamClosed: boolean;
}
interface StopOptions {
  termMs?: number | undefined;
  killMs?: number | undefined;
}
export type CodexTransport = Awaited<ReturnType<typeof openCodexTransport>>;
export interface AttemptOptions {
  taskRoot: string;
  subtaskId: string;
  attempt: number;
  ownerEpoch: number;
  agentId: string;
  sessionId: string;
  threadId: string;
  turnId: string;
  cwd: string;
  transport: CodexTransport;
  timeoutMs?: number;
  reason?: string;
  evidenceDir?: string;
  stopTermMs?: number;
  stopKillMs?: number;
}
interface Normalized extends Omit<AttemptOptions, 'reason' | 'evidenceDir'> {
  reason: string | null;
  evidenceDir: string | null;
  timeoutMs: number;
  record?: TaskRecord;
  assigneeAgent?: string;
  assigneeSession?: string;
  assigneeHarness?: string | null;
}
export interface HistoryOptions extends TransportOptions {
  threadId: string;
  turnId?: string;
  timeoutMs?: number;
  requireCompleted?: boolean;
}
export interface CodexObservation {
  schema: string;
  status: string;
  claims_retained: boolean;
  blockers?: string[];
  detail?: string | null;
  evidence?: Record<string, unknown>;
  native?: { turn_status?: string | null; [key: string]: unknown };
  [key: string]: unknown;
}
interface CancelContext {
  cancel_message_id: string | null;
  intent_recorded: boolean;
  intent_error: string | null;
  interrupt_request_ids: string[];
  interrupt_response: unknown;
  interrupt_error: unknown;
  terminal_event: Record<string, unknown> | null;
  evidence_error: string | null;
}
function errorDetail(error: unknown): string | null {
  if (object(error) && typeof error['detail'] === 'string')
    return error['detail'];
  return error instanceof Error ? error.message : null;
}
import { spawn } from 'node:child_process';
import {
  groupState,
  ownedChild,
  snapshotOwnedTree,
  spawnOwnedGroup,
  stopOwnedGroup,
  stopSnapshottedTree,
} from '../../infra/owned-process-group.js';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildMessage } from '../../collab/envelope.js';
import { submitMessage } from '../../collab/messages.js';
import { readRecord } from '../../collab/store.js';

// Owned Codex app-server stdio transport and task-scoped query/cancel.
//
// Protocol facts come from the installed Codex CLI 0.162.1 v2 schemas and the official
// app-server documentation (https://learn.chatgpt.com/docs/app-server):
//   * `thread/read` does not resume or load the thread; a fresh server reports
//     `status.type: notLoaded`, which says nothing about the original execution server.
//   * `turn/interrupt` only requests cancellation; terminal `turn/completed` with
//     `turn.status: interrupted` is the lifecycle evidence, and it may arrive before the
//     interrupt response.
//   * `thread/shellCommand` creates a standalone native turn when the thread is idle and
//     emits `turn/started` then `turn/completed`; its acknowledgement is an empty object.
//   * Server-to-client requests (approvals, tool calls, token refresh) are refused by default.
//
// Boundaries stated rather than hidden:
//   * Opening a transport is a local process start with NO model inference; the arguments are
//     always exactly `app-server --stdio` (tests inject a fake executable, never arguments).
//   * `startThread`/`startTurn`/`startShellTurn` are explicit low-level APIs for a coordinator
//     to create work AFTER existing admission. Query/cancel/recover never call them.
//   * Ownership lives in private closure state and the transport object is frozen, so caller
//     mutation cannot forge original ownership. A thread/turn is owned only when its id came
//     back from a create response or a correlated native notification on THIS transport.
//   * Model/effort/reasoning overrides are refused at the raw request boundary as well as in
//     the convenience wrappers.
//   * Claims are retained; no CANCELLED is ever sent; every cancel returns
//     `reconciliation_required` once an intent has been recorded.

const SCHEMA = 'harness-collab/codex-native/1';
const CLIENT_INFO = Object.freeze({
  name: 'harness-collab-codex-native',
  version: '1',
});
const SERVER_ARGV = Object.freeze(['app-server', '--stdio']);
const CONTROLLED_SCOPE = 'controlled-owned-group';
const DEFAULT_SCOPE = 'default-process';
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_SHUTDOWN_MS = 3000;
const DEFAULT_SIGNAL_GRACE_MS = 1000;
const DEFAULT_STREAM_CLOSE_GRACE_MS = 500;
const OVERRIDE_KEYS = [
  'model',
  'effort',
  'reasoningEffort',
  'summary',
  'serviceTier',
  'personality',
];
const ACCEPTED_HARNESSES = new Set(['codex']);
const EXPECTED_RUNNER = 'codex-app-server';

export class CodexNativeRefusal extends Error {
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
  throw new CodexNativeRefusal(status, code, detail);
}
const nowIso = () => new Date().toISOString();
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const realpath = (file: string) => {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
};
const resolvePath = (file: string) => realpath(file) ?? path.resolve(file);
const isObject = object;

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

function absolute(value: unknown, code: string) {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    value.includes('\0')
  )
    refuse(code);
  return value;
}

function rejectOverrides(params: Record<string, unknown> = {}) {
  if (!isObject(params)) refuse('params_invalid');
  for (const key of OVERRIDE_KEYS)
    if (params[key] !== undefined && params[key] !== null)
      refuse('override_not_supported', 'invalid', key);
  return params;
}

async function raceDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  code: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new CodexNativeRefusal('needs_input', code)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function tryWritePrivate(file: string, bytes: Uint8Array) {
  try {
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    return { ref: file, bytes: bytes.length };
  } catch (error) {
    return {
      error:
        errorCode(error) === 'EEXIST'
          ? 'evidence_exists'
          : 'evidence_write_failed',
    };
  }
}

/**
 * Own one `codex app-server --stdio` child and speak bounded JSONL with it. Opening is a local
 * no-inference process start; `initialize` performs no model work.
 */
export async function openCodexTransport(options: TransportOptions) {
  const codexBin =
    typeof options.codexBin === 'string' && options.codexBin
      ? options.codexBin
      : 'codex';
  if (options.args !== undefined)
    refuse(
      'arguments_not_supported',
      'invalid',
      'the app-server stdio surface is fixed',
    );
  const cwd = absolute(options.cwd, 'cwd_must_be_absolute');
  const deadlineMs = bounded(
    options.deadlineMs,
    DEFAULT_TIMEOUT_MS,
    'deadline_out_of_range',
  );
  const maxBytes = bounded(
    options.maxBytes,
    MAX_BYTES,
    'max_bytes_out_of_range',
    MAX_BYTES,
  );
  const nonce = randomBytes(6).toString('hex');
  const controlled = options.controlled === true;
  let groupHandle: object | null = null;
  let child: ChildProcess;
  try {
    if (controlled) {
      // Opt-in controlled mode: the app-server is the leader of a genuine owned process group.
      groupHandle = spawnOwnedGroup(codexBin, [...SERVER_ARGV], {
        cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child = ownedChild(groupHandle);
    } else {
      child = spawn(codexBin, [...SERVER_ARGV], {
        cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
  } catch (error) {
    refuse('spawn_failed', 'needs_input', errorDetail(error));
  }
  const state: TransportState = {
    partial: Buffer.alloc(0),
    bytes: 0,
    events: [],
    serverRequests: [],
    pending: new Map(),
    fatal: null,
    exit: null,
    spawnFailed: false,
    requestLog: [],
    streamClosed: false,
  };
  const createdThreads = new Map<string, { cwd: string; created_at: string }>();
  const createdTurns = new Map<string, string>();
  const openTurns = new Set<string>();
  const shellReservations = new Set<string>();
  const waiters = new Set<() => void>();
  const identity = Object.freeze({
    kind: 'codex-app-server-stdio',
    argv: [codexBin, ...SERVER_ARGV],
    cwd,
    pid: child.pid ?? null,
    client_info: CLIENT_INFO,
    opened_at: nowIso(),
    model_inference: 'none',
    admitted_launcher: false,
    scope: controlled ? CONTROLLED_SCOPE : DEFAULT_SCOPE,
  });
  let sequence = 0;
  let controlledThreadReserved = false;
  let streamsDetached = false;
  let killedAfterEof = false;
  let signaledKill = false;

  const wake = () => {
    for (const waiter of [...waiters]) waiter();
  };
  const fail = (code: string, detail: string | null = null) => {
    if (!state.fatal) {
      state.fatal = new CodexNativeRefusal('needs_input', code, detail);
      for (const pending of state.pending.values()) pending.reject(state.fatal);
      state.pending.clear();
    }
    wake();
  };
  const closed = new Promise<void>((resolve) => {
    child.once('close', (code, signal) => {
      state.exit = { code, signal };
      state.streamClosed = true;
      resolve();
      wake();
    });
    child.once('error', (error) => {
      state.spawnFailed = true;
      fail('spawn_failed', errorDetail(error));
      state.streamClosed = true;
      resolve();
      wake();
    });
  });
  const exitRefusal = closed.then(() => {
    throw new CodexNativeRefusal('needs_input', 'native_transport_exited');
  });
  exitRefusal.catch(() => {
    /* handled by each racer below */
  });
  for (const stream of [child.stdin, child.stdout, child.stderr])
    stream?.on('error', () => {
      /* drained */
    });
  child.stderr!.on('data', () => {
    /* stderr is drained and discarded; never logged or returned */
  });

  const handleRecord = (record: NativeRecord) => {
    if (
      record.id !== undefined &&
      (Object.hasOwn(record, 'result') || Object.hasOwn(record, 'error'))
    ) {
      const pending = state.pending.get(record.id);
      if (!pending) {
        fail('unexpected_response_id', String(record.id));
        return;
      }
      state.pending.delete(record.id);
      if (Object.hasOwn(record, 'error'))
        pending.reject(
          new CodexNativeRefusal(
            'needs_input',
            'native_error',
            `${record.error?.message ?? 'error'}`,
          ),
        );
      else if (record.result) pending.resolve(record.result);
      else
        pending.reject(
          new CodexNativeRefusal('needs_input', 'native_result_malformed'),
        );
      return;
    }
    if (record.method !== undefined && record.id !== undefined) {
      // A server-to-client request. Refuse it explicitly; a caller may opt into a handler.
      state.serverRequests.push({
        id: record.id,
        method: record.method,
        at: nowIso(),
      });
      const answer = options.onServerRequest
        ? options.onServerRequest({
            id: record.id,
            method: record.method,
            params: record.params,
          })
        : {
            error: {
              code: -32000,
              message: 'harness_collab_refuses_server_request',
              data: { method: record.method },
            },
          };
      try {
        child.stdin!.write(`${JSON.stringify({ id: record.id, ...answer })}\n`);
      } catch {
        /* child gone */
      }
      return;
    }
    if (record.method !== undefined) {
      if (
        record.method === 'turn/completed' &&
        typeof record.params?.turn?.id === 'string'
      )
        openTurns.delete(record.params.turn.id);
      state.events.push({
        seq: state.events.length + 1,
        method: record.method,
        params: record.params ?? null,
        at: nowIso(),
      });
      wake();
      return;
    }
    fail('malformed_record');
  };

  child.stdout!.on('data', (chunk) => {
    state.bytes += chunk.length;
    if (state.bytes > maxBytes) {
      fail('response_too_large');
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
      return;
    }
    state.partial = Buffer.concat([state.partial, chunk]);
    let index = state.partial.indexOf(10);
    while (index !== -1) {
      const line = state.partial.subarray(0, index);
      state.partial = state.partial.subarray(index + 1);
      if (line.length > maxBytes) {
        fail('record_too_large');
        break;
      }
      if (line.length) {
        let record: unknown = null;
        try {
          record = parseJson(line.toString('utf8'));
        } catch {
          fail('malformed_record');
          break;
        }
        if (!isRecord(record)) {
          fail('malformed_record');
          break;
        }
        handleRecord(record);
      }
      index = state.partial.indexOf(10);
    }
  });

  async function request(
    method: string,
    params: Record<string, unknown>,
    opts: { timeoutMs?: number } = {},
  ): Promise<NativeReply> {
    if (typeof method !== 'string' || !method) refuse('method_required');
    rejectOverrides(params ?? {});
    if (
      controlled &&
      (method === 'thread/start' ||
        method === 'thread/resume' ||
        method === 'thread/fork')
    ) {
      // Controlled mode is single-thread: no sibling thread can be created, resumed or forked,
      // so a runtime-wide group stop can never stop work this transport does not own. The
      // reservation is taken synchronously before any await, so concurrent starts cannot both pass.
      if (method !== 'thread/start')
        refuse(
          'controlled_single_thread_required',
          'invalid',
          `${method} is not allowed in controlled mode`,
        );
      if (controlledThreadReserved)
        refuse(
          'controlled_single_thread_required',
          'invalid',
          'controlled mode admits one thread start',
        );
      controlledThreadReserved = true;
    }
    if (state.fatal) throw state.fatal;
    if (state.exit !== null || state.spawnFailed)
      refuse('native_transport_exited', 'needs_input');
    const timeoutMs = bounded(
      opts.timeoutMs,
      deadlineMs,
      'request_timeout_out_of_range',
    );
    const id = `hcx-${nonce}-${sequence++}`;
    const promise = new Promise<NativeReply>((resolve, reject) =>
      state.pending.set(id, { resolve, reject }),
    );
    try {
      child.stdin!.write(
        `${JSON.stringify({ id, method, params: params ?? {} })}\n`,
      );
    } catch (error) {
      state.pending.delete(id);
      refuse('native_write_failed', 'needs_input', errorDetail(error));
    }
    try {
      const result = await raceDeadline(
        Promise.race([promise, exitRefusal]),
        timeoutMs,
        'native_request_deadline',
      );
      state.requestLog.push({ id, method, at: nowIso(), ok: true });
      return result;
    } catch (error) {
      state.pending.delete(id);
      state.requestLog.push({
        id,
        method,
        at: nowIso(),
        ok: false,
        code: errorCode(error) ?? null,
      });
      throw error;
    }
  }

  function waitForNotification(
    predicate: (event: NativeEvent) => boolean,
    opts: { timeoutMs?: number; fromIndex?: number } = {},
  ): Promise<NativeEvent> {
    const timeoutMs = bounded(
      opts.timeoutMs,
      deadlineMs,
      'event_timeout_out_of_range',
    );
    const fromIndex = opts.fromIndex ?? 0;
    const found = state.events.slice(fromIndex).find(predicate);
    if (found) return Promise.resolve(found);
    return raceDeadline(
      new Promise<NativeEvent>((resolve, reject) => {
        const waiter = () => {
          if (state.fatal) {
            waiters.delete(waiter);
            reject(state.fatal);
            return;
          }
          const event = state.events.slice(fromIndex).find(predicate);
          if (event) {
            waiters.delete(waiter);
            resolve(event);
          }
        };
        waiters.add(waiter);
        waiter();
      }),
      timeoutMs,
      'native_event_deadline',
    );
  }

  const transport = Object.freeze({
    schema: SCHEMA,
    identity,
    pid: child.pid ?? null,
    request,
    notify: (method: string, params: Record<string, unknown>) => {
      try {
        child.stdin!.write(
          `${JSON.stringify({ method, params: params ?? {} })}\n`,
        );
      } catch {
        /* gone */
      }
    },
    events: () => state.events.slice(),
    requestLog: () => state.requestLog.slice(),
    serverRequestsRefused: () => state.serverRequests.slice(),
    fatal: () => state.fatal,
    requestIds: () => state.requestLog.map((entry) => entry.id),
    ownedThread: (threadId: string) => createdThreads.has(threadId),
    ownedTurn: (threadId: string, turnId: string) =>
      createdTurns.get(turnId) === threadId,
    owned: (threadId: string, turnId: string) =>
      createdThreads.has(threadId) && createdTurns.get(turnId) === threadId,
    createdThreads: () => [...createdThreads.keys()],
    createdTurns: () =>
      [...createdTurns.entries()].map(([turnId, threadId]) => ({
        threadId,
        turnId,
      })),
    waitForNotification,
    initialize: async () => {
      const result = await request('initialize', {
        clientInfo: CLIENT_INFO,
        capabilities: { experimentalApi: true },
      });
      try {
        child.stdin!.write(
          `${JSON.stringify({ method: 'initialized', params: {} })}\n`,
        );
      } catch {
        /* gone */
      }
      return result;
    },
    /** Explicit low-level fixture creation. Never called by query/cancel/recover. */
    startThread: async (params: Record<string, unknown> & { cwd: string }) => {
      rejectOverrides(params);
      const cwd = absolute(params.cwd, 'thread_cwd_must_be_absolute');
      const result = await request('thread/start', { ...params, cwd });
      const thread = result?.thread;
      if (
        !isObject(thread) ||
        typeof thread.id !== 'string' ||
        typeof thread.cwd !== 'string'
      )
        refuse('thread_response_malformed', 'needs_input');
      createdThreads.set(thread.id, { cwd: thread.cwd, created_at: nowIso() });
      return { threadId: thread.id, thread };
    },
    /** Explicit low-level fixture creation. Never called by query/cancel/recover. */
    startTurn: async (
      params: Record<string, unknown> & { threadId: string },
    ) => {
      rejectOverrides(params);
      const threadId = params.threadId;
      if (!createdThreads.has(threadId))
        refuse('unowned_thread', 'needs_input');
      const result = await request('turn/start', { ...params, threadId });
      const turn = result?.turn;
      if (!isObject(turn) || typeof turn.id !== 'string')
        refuse('turn_response_malformed', 'needs_input');
      createdTurns.set(turn.id, threadId);
      openTurns.add(turn.id);
      return { threadId, turnId: turn.id, turn };
    },
    /**
     * Explicit native shell turn on an owned, idle thread. This performs no model request: it
     * runs a local shell command through the app-server's own user-shell surface. The event
     * wait is installed before the request, so a `turn/started` that precedes the empty
     * acknowledgement is still correlated by thread and turn id.
     */
    startShellTurn: async (params: {
      threadId: string;
      command: string;
      waitMs?: number;
      timeoutMs?: number;
    }) => {
      rejectOverrides(params);
      const threadId = params.threadId;
      if (!createdThreads.has(threadId))
        refuse('unowned_thread', 'needs_input');
      if (typeof params.command !== 'string' || !params.command.trim())
        refuse('command_required');
      const waitMs = bounded(
        params.waitMs,
        deadlineMs,
        'shell_timeout_out_of_range',
      );
      let nativeTimeout;
      if (params.timeoutMs !== undefined && params.timeoutMs !== null) {
        // Installed ThreadShellCommandParams exposes `timeoutMs` (non-negative int64) as the
        // native shell execution bound; forward it, never as the client wait bound.
        if (!Number.isSafeInteger(params.timeoutMs) || params.timeoutMs < 0)
          refuse('shell_timeout_out_of_range');
        nativeTimeout = params.timeoutMs;
      }
      // Synchronous per-thread reservation before the first await: two concurrent callers must
      // not both observe idle and each send a shell command.
      if (shellReservations.has(threadId))
        refuse('thread_busy', 'needs_input', 'shell turn already starting');
      shellReservations.add(threadId);
      try {
        const read = await request(
          'thread/read',
          { threadId, includeTurns: false },
          { timeoutMs: waitMs },
        );
        if (read?.thread?.status?.type !== 'idle')
          refuse(
            'thread_busy',
            'needs_input',
            String(read?.thread?.status?.type ?? 'unknown'),
          );
        for (const turnId of openTurns)
          if (createdTurns.get(turnId) === threadId)
            refuse('thread_busy', 'needs_input', `active turn ${turnId}`);
        const fromIndex = state.events.length;
        const firstEvent = waitForNotification(
          (event) =>
            (event.method === 'turn/started' ||
              event.method === 'turn/completed') &&
            event.params?.threadId === threadId,
          { timeoutMs: waitMs, fromIndex },
        );
        // Consume the pending wait outcome immediately so a later event deadline, transport
        // close or request rejection can never surface as an unhandled rejection.
        firstEvent.catch(() => {
          /* consumed below */
        });
        const shellParams: {
          threadId: string;
          command: string;
          timeoutMs?: number;
        } = { threadId, command: params.command };
        if (nativeTimeout !== undefined) shellParams.timeoutMs = nativeTimeout;
        let ack;
        try {
          ack = await request('thread/shellCommand', shellParams, {
            timeoutMs: waitMs,
          });
        } catch (error) {
          await firstEvent.catch(() => {
            /* drain the pending wait */
          });
          throw error;
        }
        const eventsSeenAtAck = state.events.length;
        const event = await firstEvent;
        const turnId = event.params?.turn?.id;
        if (typeof turnId !== 'string')
          refuse('turn_response_malformed', 'needs_input');
        createdTurns.set(turnId, threadId);
        const completedAlready = state.events.some(
          (entry) =>
            entry.method === 'turn/completed' &&
            entry.params?.turn?.id === turnId,
        );
        if (event.method === 'turn/started' && !completedAlready)
          openTurns.add(turnId);
        else openTurns.delete(turnId);
        return {
          threadId,
          turnId,
          ack,
          event: { method: event.method, seq: event.seq, at: event.at },
          event_preceded_ack: event.seq <= eventsSeenAtAck,
          native_timeout_ms: nativeTimeout ?? null,
        };
      } finally {
        shellReservations.delete(threadId);
      }
    },
    threadRead: (threadId: string, params: { includeTurns?: boolean } = {}) =>
      request('thread/read', {
        threadId,
        includeTurns: params.includeTurns === true,
      }),
    listTurns: (
      threadId: string,
      params: {
        itemsView?: string;
        sortDirection?: string;
        limit?: number;
      } = {},
    ) =>
      request('thread/turns/list', {
        threadId,
        itemsView: params.itemsView ?? 'full',
        sortDirection: params.sortDirection ?? 'asc',
        limit: params.limit ?? 50,
      }),
    listItems: (
      threadId: string,
      params: { turnId?: string; sortDirection?: string; limit?: number } = {},
    ) =>
      request('thread/items/list', {
        threadId,
        turnId: params.turnId ?? null,
        sortDirection: params.sortDirection ?? 'asc',
        limit: params.limit ?? 200,
      }),
    /**
     * Frozen runtime capability. `stop` terminates ONLY the owned process group created for a
     * controlled transport (bounded TERM then KILL) and positively re-observes the group. In
     * default mode it refuses; it never releases resources and never signals a caller-supplied
     * pid/pgid. Descendants that escaped the group via setsid are outside this guarantee.
     */
    runtime: Object.freeze({
      scope: controlled ? CONTROLLED_SCOPE : DEFAULT_SCOPE,
      controlled,
      stop: async (stopOptions: StopOptions = {}) => {
        if (!controlled || groupHandle === null)
          refuse(
            'runtime_not_controlled',
            'invalid',
            'this transport has no owned process group',
          );
        const proof = await stopOwnedGroup(groupHandle, {
          termMs: stopOptions.termMs ?? 2000,
          killMs: stopOptions.killMs ?? 2000,
        });
        const observed = groupState(groupHandle);
        return {
          scope: CONTROLLED_SCOPE,
          child_pid: child.pid ?? null,
          group_observed: observed.observable,
          group_live: observed.group_live,
          live_members: observed.live_members,
          parent_exited: observed.parent_exited,
          stopped: proof.stopped && observed.group_live === false,
          term_sent: proof.term_sent,
          kill_sent: proof.kill_sent,
          remaining: proof.remaining,
          note: 'original owned group only; use snapshotTree/stopTree to include captured descendant groups',
        };
      },
      /**
       * Read-only snapshot of the owned root and its actual descendant groups (they may live in
       * their own process groups, as a real native user-shell does). Frozen opaque token backed
       * by private state; only `stopTree` accepts it, and the snapshot is privately bound to the
       * exact owned group handle that captured it.
       */
      snapshotTree: () => {
        if (!controlled || groupHandle === null)
          refuse(
            'runtime_not_controlled',
            'invalid',
            'this transport has no owned process group',
          );
        return snapshotOwnedTree(groupHandle);
      },
      /**
       * Stops only the groups captured in this exact snapshot and only when this transport's own
       * owned group captured it. Members are re-verified against their captured PID + start
       * identity and captured PGID before TERM, again before any KILL escalation, and once more
       * before a positive `stopped: true` proof.
       */
      stopTree: async (snapshot: unknown, stopOptions: StopOptions = {}) => {
        if (!controlled || groupHandle === null)
          refuse(
            'runtime_not_controlled',
            'invalid',
            'this transport has no owned process group',
          );
        return stopSnapshottedTree(snapshot, {
          termMs: stopOptions.termMs ?? 2000,
          killMs: stopOptions.killMs ?? 2000,
          handle: groupHandle,
        });
      },
    }),
    close: async () => {
      if (state.exit === null && !state.spawnFailed) {
        try {
          child.stdin!.end();
        } catch {
          /* already gone */
        }
        let exited = await raceDeadline(
          closed.then(() => true),
          DEFAULT_SHUTDOWN_MS,
          'shutdown_deadline',
        ).catch(() => false);
        if (!exited) {
          killedAfterEof = true;
          try {
            child.kill('SIGTERM');
          } catch {
            /* gone */
          }
          exited = await raceDeadline(
            closed.then(() => true),
            DEFAULT_SIGNAL_GRACE_MS,
            'signal_grace_deadline',
          ).catch(() => false);
          if (!exited) {
            signaledKill = true;
            try {
              child.kill('SIGKILL');
            } catch {
              /* gone */
            }
            await raceDeadline(
              closed.then(() => true),
              DEFAULT_SIGNAL_GRACE_MS,
              'kill_grace_deadline',
            ).catch(() => false);
          }
        }
      }
      if (!state.streamClosed) {
        await delay(Math.min(DEFAULT_STREAM_CLOSE_GRACE_MS, 250));
        if (!state.streamClosed) {
          streamsDetached = true;
          for (const stream of [child.stdin, child.stdout, child.stderr]) {
            try {
              stream?.destroy();
            } catch {
              /* gone */
            }
          }
          await delay(50);
        }
      }
      return {
        exit_code: state.exit?.code ?? null,
        signal: state.exit?.signal ?? null,
        parent_exited: state.exit !== null || state.spawnFailed,
        stream_closed: state.streamClosed,
        streams_detached: streamsDetached,
        killed_after_eof_timeout: killedAfterEof,
        signaled_kill: signaledKill,
        request_ids: state.requestLog.map((entry) => entry.id),
        server_requests_refused: state.serverRequests.length,
      };
    },
  });

  if (options.initialize !== false) {
    try {
      await transport.initialize();
    } catch (error) {
      await transport.close();
      throw error;
    }
  }
  return transport;
}

// ---------------------------------------------------------------------------
// Task-scoped query / cancel / recovery on an owned original transport
// ---------------------------------------------------------------------------

function normalizeAttemptOptions(options: AttemptOptions): Normalized {
  if (!Number.isSafeInteger(options.attempt) || options.attempt < 1)
    refuse('invalid_attempt');
  if (!Number.isSafeInteger(options.ownerEpoch) || options.ownerEpoch < 1)
    refuse('invalid_owner_epoch');
  for (const key of [
    'taskRoot',
    'agentId',
    'sessionId',
    'threadId',
    'turnId',
  ] as const) {
    if (typeof options[key] !== 'string' || !options[key].trim())
      refuse(`${key}_required`);
  }
  if (
    !options.transport ||
    typeof options.transport.request !== 'function' ||
    !options.transport.identity
  )
    refuse('owned_transport_required', 'needs_input');
  return {
    taskRoot: absolute(options.taskRoot, 'task_root_must_be_absolute'),
    subtaskId:
      typeof options.subtaskId === 'string' && options.subtaskId.trim()
        ? options.subtaskId
        : refuse('subtask_required'),
    attempt: options.attempt,
    ownerEpoch: options.ownerEpoch,
    agentId: options.agentId,
    sessionId: options.sessionId,
    threadId: options.threadId,
    turnId: options.turnId,
    cwd: absolute(options.cwd, 'cwd_must_be_absolute'),
    transport: options.transport,
    timeoutMs: bounded(
      options.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      'timeout_out_of_range',
    ),
    reason: options.reason ?? null,
    evidenceDir:
      options.evidenceDir === undefined || options.evidenceDir === null
        ? null
        : absolute(options.evidenceDir, 'evidence_dir_must_be_absolute'),
  };
}

function requireAttemptRecord(opts: Normalized) {
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
  const recordedThread = native.session_id ?? null;
  const recordedTurn = native.run_id ?? null;
  if (recordedThread === null || recordedTurn === null)
    refuse('native_refs_unrecorded', 'needs_input');
  if (recordedThread !== opts.threadId)
    refuse('native_thread_ref_mismatch', 'needs_input');
  if (recordedTurn !== opts.turnId)
    refuse('native_turn_ref_mismatch', 'needs_input');
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
  return target;
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
      harness: opts.assigneeHarness ?? 'codex',
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
      body: { reason: 'native app-server observation' },
    }),
  );
  if (query.ok !== true)
    refuse('status_query_not_recorded', 'invalid', query.reason ?? null);
  return query.registration.message_id;
}

/** Reports the factual native observation; terminal never becomes task completion here. */
function reportStatus(
  opts: Normalized,
  queryId: string,
  observation: string,
  nativeStatus: string,
  nativeFacts: Record<string, unknown>,
) {
  const { taskId, from, to } = ids(opts);
  const bodyStatus =
    observation === 'active'
      ? 'running'
      : observation === 'interrupted'
        ? 'cancelled'
        : observation === 'failed'
          ? 'failed'
          : 'unknown';
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
        status: bodyStatus,
        native_status: nativeStatus,
        ...nativeFacts,
        observation,
      },
    }),
  );
  if (status.ok !== true)
    refuse('status_not_recorded', 'invalid', status.reason ?? null);
  return status.registration.message_id;
}

/** Native read of the exact thread/turn, with no thread/resume, fork or prompt. */
async function readTurn(
  transport: CodexTransport,
  threadId: string,
  turnId: string,
  timeoutMs: number,
) {
  const read = await transport.request(
    'thread/read',
    { threadId, includeTurns: false },
    { timeoutMs },
  );
  const thread = read?.thread;
  if (!isObject(thread) || thread.id !== threadId)
    refuse('native_thread_identity_mismatch', 'needs_input');
  if (typeof thread.cwd !== 'string')
    refuse('native_thread_cwd_unsupported', 'needs_input');
  const listed = await transport.request(
    'thread/turns/list',
    { threadId, itemsView: 'full', sortDirection: 'asc', limit: 50 },
    { timeoutMs },
  );
  const turns = Array.isArray(listed?.data)
    ? listed.data
    : refuse('native_turns_malformed', 'needs_input');
  const turn = turns.find((item) => item?.id === turnId) ?? null;
  if (!turn) refuse('native_turn_not_found', 'needs_input');
  if (typeof turn.status !== 'string')
    refuse('native_turn_status_unsupported', 'needs_input');
  return {
    thread: { ...thread, cwd: thread.cwd },
    turn: { ...turn, status: turn.status },
    queried_at: nowIso(),
  };
}

/**
 * Classifies persisted turn items into a usable original native result. A model message and a
 * successful native shell command are kept distinct; nothing is synthesized.
 */
function classifyItems(entries: NativeEntry[]) {
  const items = entries.map((entry) => entry?.item);
  const messages = items.filter(
    (item) =>
      item?.type === 'agentMessage' &&
      typeof item.text === 'string' &&
      item.text.trim(),
  );
  if (messages.length) {
    return {
      result_kind: 'agent_message',
      agent_message: messages.at(-1)!.text,
      native_command_output: null,
      native_command_exit_code: null,
      item_count: entries.length,
    };
  }
  const commands = items.filter(
    (item) =>
      item?.type === 'commandExecution' &&
      item.status === 'completed' &&
      item.exitCode === 0 &&
      typeof item.aggregatedOutput === 'string',
  );
  if (commands.length) {
    const last = commands.at(-1)!;
    return {
      result_kind: 'native_command_output',
      agent_message: null,
      native_command_output: last.aggregatedOutput,
      native_command_exit_code: last.exitCode,
      item_count: entries.length,
    };
  }
  return {
    result_kind: null,
    agent_message: null,
    native_command_output: null,
    native_command_exit_code: null,
    item_count: entries.length,
  };
}

async function readItems(
  transport: CodexTransport,
  threadId: string,
  turnId: string,
  timeoutMs: number,
) {
  const listed = await transport.request(
    'thread/items/list',
    { threadId, turnId, sortDirection: 'asc', limit: 200 },
    { timeoutMs },
  );
  const entries = Array.isArray(listed?.data)
    ? listed.data
    : refuse('native_items_malformed', 'needs_input');
  return classifyItems(entries);
}

function observationOf(status: string) {
  if (status === 'completed') return 'completed';
  if (status === 'interrupted') return 'interrupted';
  if (status === 'failed') return 'failed';
  if (status === 'inProgress') return 'active';
  refuse('native_turn_status_unsupported', 'needs_input');
}

function refusalResult(
  error: unknown,
  extra: Record<string, unknown> = {},
): CodexObservation {
  const known = error instanceof CodexNativeRefusal;
  return {
    schema: SCHEMA,
    status: known ? error.status : 'invalid',
    blockers: [known ? error.code : 'internal_error'],
    detail: known
      ? error.detail
      : String(error instanceof Error ? errorDetail(error) : error),
    ...extra,
    reconciliation_required: false,
    claims_retained: true,
  };
}

/** In-flight status of one exact recorded attempt on its owned original transport and turn. */
export async function queryCodexAttempt(
  options: AttemptOptions,
): Promise<CodexObservation> {
  let statusQueryId: string | null = null;
  try {
    const opts = normalizeAttemptOptions(options);
    requireAttemptRecord(opts);
    if (!opts.transport.owned(opts.threadId, opts.turnId))
      refuse('unowned_native_turn', 'needs_input');
    statusQueryId = registerStatusQuery(opts);
    const native = await readTurn(
      opts.transport,
      opts.threadId,
      opts.turnId,
      opts.timeoutMs,
    );
    if (resolvePath(native.thread.cwd) !== resolvePath(opts.cwd))
      refuse('native_cwd_mismatch', 'needs_input');
    const observation = observationOf(native.turn.status);
    const result: CodexObservation = {
      schema: SCHEMA,
      status: observation,
      blockers: [],
      observation,
      native: {
        thread_id: opts.threadId,
        turn_id: opts.turnId,
        thread_status: native.thread.status ?? null,
        thread_cwd: native.thread.cwd,
        turn_status: native.turn.status,
      },
      transport: {
        identity: opts.transport.identity,
        request_ids: opts.transport.requestIds(),
        queried_at: native.queried_at,
      },
      reconciliation_required: false,
      claims_retained: true,
      evidence: {
        observed_ids: { thread_id: opts.threadId, turn_id: opts.turnId },
        queried_at: native.queried_at,
      },
    };
    try {
      const statusId = reportStatus(
        opts,
        statusQueryId,
        observation,
        native.turn.status,
        { native_thread_id: opts.threadId, native_turn_id: opts.turnId },
      );
      result.protocol = { status_query: statusQueryId, status: statusId };
    } catch (error) {
      result.record_error =
        error instanceof CodexNativeRefusal ? error.code : 'internal_error';
      result.protocol = { status_query: statusQueryId, status: null };
    }
    return result;
  } catch (error) {
    return refusalResult(error, { status_query: statusQueryId });
  }
}

/**
 * Requests cancellation of one exact recorded attempt. Requires a fresh active observation on
 * the owned original transport, records the CANCEL intent, invokes `turn/interrupt` with the
 * exact ids, and accepts only terminal `turn/completed` with `interrupted` as evidence - even
 * if it precedes the interrupt response. Claims stay held and no CANCELLED is sent; any failure
 * after the recorded intent still returns `reconciliation_required: true`.
 */
export async function cancelCodexAttempt(
  options: AttemptOptions,
): Promise<CodexObservation> {
  const ctx: CancelContext = {
    cancel_message_id: null,
    intent_recorded: false,
    intent_error: null,
    interrupt_request_ids: [],
    interrupt_response: null,
    interrupt_error: null,
    terminal_event: null,
    evidence_error: null,
  };
  try {
    const opts = normalizeAttemptOptions(options);
    requireAttemptRecord(opts);
    if (!opts.transport.owned(opts.threadId, opts.turnId))
      refuse('unowned_native_turn', 'needs_input');
    const before = await readTurn(
      opts.transport,
      opts.threadId,
      opts.turnId,
      opts.timeoutMs,
    );
    const beforeObservation = observationOf(before.turn.status);
    if (beforeObservation !== 'active') {
      return {
        schema: SCHEMA,
        status: 'not_cancellable',
        blockers: ['native_not_active'],
        observation: beforeObservation,
        native: {
          thread_id: opts.threadId,
          turn_id: opts.turnId,
          turn_status: before.turn.status,
        },
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
          reason: opts.reason ?? 'native app-server cancellation',
          native_thread_id: opts.threadId,
          native_turn_id: opts.turnId,
        },
      }),
    );
    if (intent.ok !== true) {
      ctx.intent_error = intent.reason ?? 'cancel_intent_not_recorded';
      return {
        schema: SCHEMA,
        status: 'invalid',
        blockers: ['cancel_intent_not_recorded'],
        intent_error: ctx.intent_error,
        native: {
          thread_id: opts.threadId,
          turn_id: opts.turnId,
          turn_status: before.turn.status,
        },
        reconciliation_required: false,
        claims_retained: true,
        cancelled_message_sent: false,
      };
    }
    ctx.cancel_message_id = intent.registration.message_id;
    ctx.intent_recorded = true;
    const fromIndex = opts.transport.events().length;
    const terminalPromise = opts.transport.waitForNotification(
      (event) =>
        event.method === 'turn/completed' &&
        event.params?.threadId === opts.threadId &&
        event.params?.turn?.id === opts.turnId,
      { timeoutMs: opts.timeoutMs, fromIndex },
    );
    const interruptPromise = opts.transport
      .request(
        'turn/interrupt',
        { threadId: opts.threadId, turnId: opts.turnId },
        { timeoutMs: opts.timeoutMs },
      )
      .then(
        (result) => {
          ctx.interrupt_response = result;
        },
        (error) => {
          ctx.interrupt_error = error;
        },
      );
    const terminal = await terminalPromise.catch(
      (
        error: unknown,
      ): {
        error: CodexNativeRefusal;
        method?: never;
        at?: never;
        params?: never;
      } => ({
        error:
          error instanceof CodexNativeRefusal
            ? error
            : new CodexNativeRefusal(
                'needs_input',
                'native_event_deadline',
                errorDetail(error),
              ),
      }),
    );
    await interruptPromise;
    ctx.interrupt_request_ids = opts.transport
      .requestLog()
      .filter((entry) => entry.method === 'turn/interrupt')
      .map((entry) => entry.id);
    ctx.terminal_event = terminal.error
      ? null
      : {
          method: terminal.method,
          at: terminal.at,
          turn_status: terminal.params?.turn?.status ?? null,
        };
    const evidence: Record<string, unknown> = {
      observed_ids: { thread_id: opts.threadId, turn_id: opts.turnId },
      cancel_message_id: ctx.cancel_message_id,
      interrupt_request_ids: ctx.interrupt_request_ids,
      interrupt_response: ctx.interrupt_response,
      interrupt_error: ctx.interrupt_error
        ? {
            code: errorCode(ctx.interrupt_error) ?? null,
            detail: errorDetail(ctx.interrupt_error),
          }
        : null,
      terminal_event: ctx.terminal_event,
      before: {
        turn_status: before.turn.status,
        queried_at: before.queried_at,
      },
      queried_at: nowIso(),
    };
    if (opts.evidenceDir) {
      try {
        fs.mkdirSync(opts.evidenceDir, { recursive: true, mode: 0o700 });
      } catch {
        /* reported below */
      }
      const written = tryWritePrivate(
        path.join(opts.evidenceDir, 'codex-native-cancel.json'),
        Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`),
      );
      if (written.error) ctx.evidence_error = written.error;
      else evidence.evidence_ref = written;
    }
    const shared = {
      evidence,
      evidence_error: ctx.evidence_error,
      cancel_message_id: ctx.cancel_message_id,
      intent_recorded: ctx.intent_recorded,
      reconciliation_required: true,
      claims_retained: true,
      cancelled_message_sent: false,
    };
    if (terminal.error) {
      return {
        schema: SCHEMA,
        status: 'needs_input',
        blockers: [terminal.error.code ?? 'native_event_deadline'],
        native: {
          thread_id: opts.threadId,
          turn_id: opts.turnId,
          turn_status: before.turn.status,
        },
        interrupt_accepted: ctx.interrupt_response !== null,
        ...shared,
      };
    }
    const terminalStatus = terminal.params?.turn?.status ?? null;
    if (terminalStatus !== 'interrupted') {
      return {
        schema: SCHEMA,
        status: 'needs_input',
        blockers: ['terminal_state_unexpected'],
        native: {
          thread_id: opts.threadId,
          turn_id: opts.turnId,
          turn_status: terminalStatus,
        },
        ...shared,
      };
    }
    return {
      schema: SCHEMA,
      status: 'terminal',
      blockers: [],
      native: {
        thread_id: opts.threadId,
        turn_id: opts.turnId,
        turn_status: terminalStatus,
      },
      native_terminal: {
        turn_status: terminalStatus,
        observed_at: terminal.at,
      },
      ...shared,
    };
  } catch (error) {
    return refusalResult(error, {
      cancel_message_id: ctx.cancel_message_id,
      intent_recorded: ctx.intent_recorded,
      intent_error: ctx.intent_error,
      interrupt_request_ids: ctx.interrupt_request_ids,
      interrupt_response: ctx.interrupt_response,
      terminal_event: ctx.terminal_event,
      evidence_error: ctx.evidence_error,
      reconciliation_required: ctx.intent_recorded,
      cancelled_message_sent: false,
    });
  }
}

/**
 * Recovery of a completed turn whose notification was lost. Only the exact requested terminal
 * turn is accepted, and it must carry a usable original native result: a model agent message or
 * an explicit successful native shell command output. Nothing is synthesized.
 */
export async function recoverCodexCompleted(
  options: AttemptOptions,
): Promise<CodexObservation> {
  try {
    const opts = normalizeAttemptOptions(options);
    requireAttemptRecord(opts);
    if (!opts.transport.owned(opts.threadId, opts.turnId))
      refuse('unowned_native_turn', 'needs_input');
    const native = await readTurn(
      opts.transport,
      opts.threadId,
      opts.turnId,
      opts.timeoutMs,
    );
    if (resolvePath(native.thread.cwd) !== resolvePath(opts.cwd))
      refuse('native_cwd_mismatch', 'needs_input');
    if (native.turn.status !== 'completed') {
      return {
        schema: SCHEMA,
        status: 'needs_input',
        blockers: ['terminal_turn_not_completed'],
        native: {
          thread_id: opts.threadId,
          turn_id: opts.turnId,
          turn_status: native.turn.status,
        },
        claims_retained: true,
      };
    }
    const classified = await readItems(
      opts.transport,
      opts.threadId,
      opts.turnId,
      opts.timeoutMs,
    );
    if (classified.result_kind === null) {
      return {
        schema: SCHEMA,
        status: 'needs_input',
        blockers: ['native_result_unavailable'],
        native: {
          thread_id: opts.threadId,
          turn_id: opts.turnId,
          turn_status: native.turn.status,
        },
        item_count: classified.item_count,
        claims_retained: true,
      };
    }
    return {
      schema: SCHEMA,
      status: 'recovered',
      blockers: [],
      requested: {
        thread_id: opts.threadId,
        turn_id: opts.turnId,
        turn_type: 'recorded',
      },
      native: {
        thread_id: opts.threadId,
        turn_id: opts.turnId,
        turn_status: native.turn.status,
        thread_cwd: native.thread.cwd,
      },
      result_kind: classified.result_kind,
      agent_message: classified.agent_message,
      native_command_output: classified.native_command_output,
      native_command_exit_code: classified.native_command_exit_code,
      item_count: classified.item_count,
      transport: {
        identity: opts.transport.identity,
        request_ids: opts.transport.requestIds(),
        queried_at: native.queried_at,
      },
      receipt: null,
      report_requires_validation: true,
      claims_retained: true,
    };
  } catch (error) {
    return refusalResult(error);
  }
}

/**
 * Persisted-history read on a FRESH server. `notLoaded` describes only this server's load state,
 * never the original execution. The canonical thread cwd is always validated against the
 * requested cwd, and with `requireCompleted` only an exact completed turn with a usable native
 * result is accepted.
 */
export async function queryPersistedHistory(
  options: HistoryOptions,
): Promise<CodexObservation> {
  const threadId =
    typeof options.threadId === 'string' && options.threadId.trim()
      ? options.threadId
      : refuse('thread_id_required');
  const turnId = options.turnId ?? null;
  const timeoutMs = bounded(
    options.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    'timeout_out_of_range',
  );
  const cwd = absolute(options.cwd, 'cwd_must_be_absolute');
  let transport: CodexTransport | null = null;
  try {
    transport = await openCodexTransport({
      codexBin: options.codexBin,
      cwd,
      env: options.env,
      deadlineMs: timeoutMs,
      maxBytes: options.maxBytes,
    });
    const read = await transport.request(
      'thread/read',
      { threadId, includeTurns: false },
      { timeoutMs },
    );
    const thread = read?.thread;
    if (!isObject(thread) || thread.id !== threadId)
      refuse('native_thread_identity_mismatch', 'needs_input');
    if (typeof thread.cwd !== 'string')
      refuse('native_thread_cwd_unsupported', 'needs_input');
    if (resolvePath(thread.cwd) !== resolvePath(cwd))
      refuse('native_cwd_mismatch', 'needs_input');
    const listed = await transport.request(
      'thread/turns/list',
      { threadId, itemsView: 'full', sortDirection: 'asc', limit: 50 },
      { timeoutMs },
    );
    const turns = Array.isArray(listed?.data)
      ? listed.data
      : refuse('native_turns_malformed', 'needs_input');
    const turn =
      turnId === null
        ? null
        : (turns.find((item) => item?.id === turnId) ?? null);
    if (turnId !== null && !turn)
      refuse('native_turn_not_found', 'needs_input');
    const base = {
      schema: SCHEMA,
      status: 'persisted_history_only',
      blockers: [],
      note: 'thread status from a fresh server describes this server load state only; it is not a statement about the original server or process',
      requested: { thread_id: threadId, turn_id: turnId, cwd },
      native: {
        thread_id: threadId,
        turn_id: turnId,
        thread_status: thread.status ?? null,
        thread_cwd: thread.cwd,
        turn_status: turn?.status ?? null,
      },
      transport: {
        identity: transport.identity,
        request_ids: transport.requestIds(),
        queried_at: nowIso(),
      },
      in_flight_status: null,
      claims_retained: true,
    };
    if (options.requireCompleted === true) {
      if (!turn) refuse('turn_id_required', 'invalid');
      if (turn.status !== 'completed')
        return {
          ...base,
          status: 'needs_input',
          blockers: ['terminal_turn_not_completed'],
        };
      const classified = await readItems(
        transport,
        threadId,
        turnId!,
        timeoutMs,
      );
      if (classified.result_kind === null)
        return {
          ...base,
          status: 'needs_input',
          blockers: ['native_result_unavailable'],
          item_count: classified.item_count,
        };
      return {
        ...base,
        status: 'recovered',
        result_kind: classified.result_kind,
        agent_message: classified.agent_message,
        native_command_output: classified.native_command_output,
        native_command_exit_code: classified.native_command_exit_code,
        item_count: classified.item_count,
        receipt: null,
        report_requires_validation: true,
      };
    }
    return base;
  } catch (error) {
    return refusalResult(error);
  } finally {
    if (transport) await transport.close();
  }
}
/**
 * Cancellation plus controlled-runtime stop for one exact recorded attempt.
 *
 * The native handshake (CANCEL intent + `turn/interrupt` + observed terminal event) is reported
 * separately from the group/process stop proof. The owned process group is stopped ONLY when the
 * cancellation intent was actually recorded, and only for a controlled transport that created
 * the original runtime. Claims are retained, no CANCELLED is sent, and the result always carries
 * `reconciliation_required: true` once the intent exists. A non-terminal native handshake may
 * still require the controlled shutdown; it is never reported as a native interruption.
 * Task-specific evidence (known child pids/heartbeats) remains the caller's responsibility:
 * an empty owned group is not proof that every OS side effect stopped.
 */
export async function cancelAndStopCodexAttempt(
  options: AttemptOptions,
): Promise<CodexObservation> {
  // Exact target validation FIRST and read-only: no native request, no mutation on an invalid
  // or unowned target, so a snapshot is never taken for work this adapter does not own.
  let prepared;
  try {
    prepared = normalizeAttemptOptions(options);
    requireAttemptRecord(prepared);
    if (!prepared.transport.owned(prepared.threadId, prepared.turnId))
      refuse('unowned_native_turn', 'needs_input');
  } catch (error) {
    const known = error instanceof CodexNativeRefusal;
    return {
      schema: SCHEMA,
      status: known ? error.status : 'invalid',
      blockers: [known ? error.code : 'internal_error'],
      detail: known
        ? error.detail
        : String(error instanceof Error ? errorDetail(error) : error),
      native_handshake: null,
      runtime_stop: {
        attempted: false,
        reason: known ? error.code : 'internal_error',
      },
      claims_retained: true,
      reconciliation_required: false,
      cancelled_message_sent: false,
      task_specific_verification_required: true,
    };
  }
  const controlled = prepared.transport.runtime?.controlled === true;
  let snapshot: ReturnType<typeof snapshotOwnedTree> | null = null;
  if (controlled) {
    // Read-only snapshot of the genuine owned root and its actual descendant groups, taken
    // before the interrupt so orphaned groups stay targetable. A failed capture refuses instead
    // of creating a runtime that could not be stopped.
    try {
      snapshot = prepared.transport.runtime.snapshotTree();
    } catch (error) {
      return {
        schema: SCHEMA,
        status: 'needs_input',
        blockers: [errorCode(error) ?? 'snapshot_failed'],
        detail: errorDetail(error) ?? '',
        native_handshake: null,
        runtime_stop: {
          attempted: false,
          refused: 'snapshot_unavailable',
          reason: errorCode(error) ?? 'snapshot_failed',
        },
        claims_retained: true,
        reconciliation_required: false,
        cancelled_message_sent: false,
        task_specific_verification_required: true,
      };
    }
  }
  const handshake = await cancelCodexAttempt(options);
  const native_handshake = {
    status: handshake.status,
    blockers: handshake.blockers ?? [],
    detail: handshake.detail ?? null,
    cancel_message_id: handshake.cancel_message_id ?? null,
    intent_recorded: handshake.intent_recorded === true,
    interrupts: handshake.evidence?.interrupt_request_ids ?? [],
    interrupt_response:
      handshake.evidence?.interrupt_response ??
      handshake.interrupt_response ??
      null,
    interrupt_error:
      handshake.evidence?.interrupt_error ?? handshake.interrupt_error ?? null,
    terminal_event:
      handshake.evidence?.terminal_event ?? handshake.terminal_event ?? null,
    native: handshake.native ?? null,
    native_terminal: handshake.native_terminal ?? null,
    native_interrupted_confirmed:
      handshake.status === 'terminal' &&
      handshake.native?.turn_status === 'interrupted',
    evidence_error: handshake.evidence_error ?? null,
  };
  const base = {
    schema: SCHEMA,
    status: handshake.status,
    native_handshake,
    snapshot:
      snapshot === null
        ? null
        : {
            scope: snapshot.scope,
            original_pgid: snapshot.original_pgid,
            groups: snapshot.groups,
            descendants: snapshot.descendants.length,
            captured_at: snapshot.captured_at,
          },
    claims_retained: true,
    reconciliation_required: true,
    cancelled_message_sent: false,
    task_specific_verification_required: true,
  };
  if (native_handshake.intent_recorded !== true) {
    return {
      ...base,
      runtime_stop: {
        attempted: false,
        reason: handshake.blockers?.[0] ?? 'cancel_intent_not_recorded',
      },
    };
  }
  if (!controlled) {
    return {
      ...base,
      runtime_stop: { attempted: false, refused: 'runtime_not_controlled' },
    };
  }
  try {
    const proof = await prepared.transport.runtime.stopTree(snapshot, {
      termMs: options.stopTermMs,
      killMs: options.stopKillMs,
    });
    return {
      ...base,
      runtime_stop: {
        attempted: true,
        source: 'owned-descendant-tree-snapshot',
        ...proof,
      },
    };
  } catch (error) {
    return {
      ...base,
      runtime_stop: {
        attempted: true,
        stopped: false,
        error: errorCode(error) ?? 'internal_error',
        detail: errorDetail(error),
      },
    };
  }
}
