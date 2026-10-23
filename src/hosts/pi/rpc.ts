import type { ChildProcess } from 'node:child_process';
import type {
  CancellationIntentReference,
  Identity,
  MessageInput,
} from '../../collab/types.js';
import { errorCode, object, parseJson } from '../../collab/validation.js';
import { isAssignment } from '../../collab/contracts.js';
import { isPiRecord, type PiRecord } from './protocol.js';
export interface PiOptions {
  taskRoot: string;
  cwd: string;
  assignmentFile: string;
  capabilitiesFile: string;
  promptFile: string;
  evidenceDir: string;
  namespaceGuard?: () => void;
  sessionDir?: string;
  outputName?: string;
  profile?: string;
  phase?: string;
  resume?: string;
  sessionId?: string;
  launchKind?: string;
  discovery?: boolean;
  trustProject?: boolean;
  piBin?: string;
  action?: string;
  requestTimeoutMs?: number;
  operationTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  settleTimeoutMs?: number;
  signalGraceMs?: number;
  streamCloseGraceMs?: number;
  maxBytes?: number;
  maxAgeMinutes?: number;
  clock?: number;
}
type Normalized = ReturnType<typeof normalizeOwnedOptions>;
interface TransportOptions {
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  signalGraceMs?: number;
  streamCloseGraceMs?: number;
  maxBytes?: number;
  maxStderrBytes?: number;
  onRecord?: (line: string) => void;
}
type Predicate = (record: PiRecord, ordinal: number) => boolean;
interface Found {
  record: PiRecord;
  ordinal: number;
}
interface Pending {
  type: string;
  resolve: (record: PiRecord) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}
interface EventWaiter {
  predicate: Predicate;
  fromOrdinal: number;
  resolve: (found: Found) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}
interface Proof {
  prompt: {
    at: string;
    disposition: string;
    response_id: string | undefined;
    event_ordinal_before_request: number;
  } | null;
  queries: Record<string, unknown>[];
  cancel: Record<string, unknown> | null;
  [key: string]: unknown;
}
export interface PiFinish {
  ok: boolean;
  schema: string;
  reason: string | null;
  detail: string | null;
  outcome: string;
  [key: string]: unknown;
}
function errorDetail(error: unknown): string | null {
  if (object(error) && typeof error['detail'] === 'string')
    return error['detail'];
  return error instanceof Error ? error.message : null;
}
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import {
  admitLaunch,
  claimCovers,
  classifyIdentity,
  hasPendingCancellation,
  reserveLaunch,
  settleLaunch,
  TOOL_PROFILES,
} from '../../collab/admission.js';
import { describeResource } from '../../collab/canonical.js';
import { buildMessage, sha256File } from '../../collab/envelope.js';
import { submitMessage } from '../../collab/messages.js';
import { readMessageFromTaskRoot } from '../../app/collab-messages.js';
import { findAttempt } from '../../collab/lifecycle.js';
import { createNonce, nowIso, readRecord } from '../../collab/store.js';

// Gated, owned Pi RPC lifecycle. One launch, one frozen prompt, repeated native queries and an
// explicit cancellation, all on the child this process started.
//
// Public surface:
//   startOwnedPiRpc(options)  admission -> atomic reservation -> spawn -> identity/header binding
//   runOwnedPiRpc(options)    one bounded operation: `query` (default) or `prompt`, then finish
//   PiRpcRefusal              a classified refusal (`code`, `status`, `detail`)
//
// Deliberate reductions and limits (see docs/pi-rpc.md):
//   * No ungated transport export, no raw request on the handle, no arbitrary prompt text, no
//     caller outcome/result overrides, no protocol identity override or bypass.
//   * Query/cancel always use the authoritative protocol identities read from the registered
//     task; STATUS_QUERY is recorded before the observation it asks for.
//   * A cancellation never starts work and never sends CANCELLED; claims stay held.
//   * The caller's registered programmatic invocation is the authorization point.
//   * Shutdown is per-child: EOF, then a bounded signal of this exact child, then a bounded wait
//     for our own stdio handles. Inheriting descendants are never signalled.

const RPC_SCHEMA = 'harness-collab/pi-rpc/1';
const EXECUTION_SCHEMA = 'harness-collab/native-execution/1';
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_OPERATION_TIMEOUT_MS = 120000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;
const DEFAULT_SIGNAL_GRACE_MS = 2000;
const DEFAULT_STREAM_CLOSE_GRACE_MS = 500;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const MAX_REQUEST_TIMEOUT_MS = 60000;
const MAX_OPERATION_TIMEOUT_MS = 600000;
const MAX_PROMPT_BYTES = 20000;
const HEADER_READ_BYTES = 64 * 1024;
const PHASES = new Set([
  'discovery',
  'implementation',
  'review',
  'handoff',
  'fix',
]);

const ACTIONS = new Set(['query', 'prompt']);

/** A classified refusal: `code` is stable, `status` is `invalid` | `needs_input` | `failed`. */
export class PiRpcRefusal extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 'invalid',
    public readonly detail: string | null = null,
  ) {
    super(code);
    this.name = 'PiRpcRefusal';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

const isObject = object;

/** Resolve `true` when `promise` settles, or `false` after `ms`; the timer is always cleared. */
function waitBounded(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise.then(() => true), timeout]).finally(() =>
    clearTimeout(timer),
  );
}

function samePath(left: string, right: string) {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internal transport over one caller-owned RPC child
// ---------------------------------------------------------------------------

/**
 * Attach the JSONL protocol to a Pi child this process spawned and gated.
 *
 * `exit` is the process boundary and `close` is the stream boundary. They are tracked
 * separately so a descendant that inherited stdout/stderr cannot extend shutdown: the owned
 * pipe handles are destroyed after a bounded wait instead of waiting for the descendant.
 */
function attachTransport(child: ChildProcess, options: TransportOptions = {}) {
  if (
    !child ||
    typeof child.once !== 'function' ||
    !child.stdin ||
    !child.stdout ||
    !child.stderr
  ) {
    throw new PiRpcRefusal('child_required');
  }
  const requestTimeoutMs = boundedTimeout(
    options.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
    MAX_REQUEST_TIMEOUT_MS,
    'request_timeout_out_of_range',
  );
  const shutdownTimeoutMs = boundedTimeout(
    options.shutdownTimeoutMs,
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
    MAX_REQUEST_TIMEOUT_MS,
    'shutdown_timeout_out_of_range',
  );
  const signalGraceMs = boundedTimeout(
    options.signalGraceMs,
    DEFAULT_SIGNAL_GRACE_MS,
    MAX_REQUEST_TIMEOUT_MS,
    'signal_grace_out_of_range',
  );
  const streamCloseGraceMs = boundedTimeout(
    options.streamCloseGraceMs,
    DEFAULT_STREAM_CLOSE_GRACE_MS,
    MAX_REQUEST_TIMEOUT_MS,
    'stream_close_grace_out_of_range',
  );
  const maxBytes =
    typeof options.maxBytes === 'number' &&
    Number.isSafeInteger(options.maxBytes) &&
    options.maxBytes > 0
      ? options.maxBytes
      : DEFAULT_MAX_BYTES;
  const maxStderrBytes =
    typeof options.maxStderrBytes === 'number' &&
    Number.isSafeInteger(options.maxStderrBytes) &&
    options.maxStderrBytes >= 0
      ? options.maxStderrBytes
      : DEFAULT_MAX_STDERR_BYTES;
  const onRecord =
    typeof options.onRecord === 'function' ? options.onRecord : null;
  const nonce = crypto.randomBytes(6).toString('hex');

  const decoder = new StringDecoder('utf8');
  const records: PiRecord[] = [];
  const pending = new Map<string, Pending>();
  const eventWaiters: EventWaiter[] = [];
  let drainQueue: (() => void)[] = [];
  let text = '';
  let bytes = 0;
  let stderrBytes = 0;
  const stderrChunks: Buffer[] = [];
  let sequence = 0;
  let streamsClosed = false;
  let parentExit: {
    code: number | null;
    signal: NodeJS.Signals | null;
  } | null = null;
  let spawnError: Error | null = null;
  let spawnFailed = false;
  let killedAfterEof = false;
  let signaledKill = false;
  let streamsDetached = false;
  let fatal: PiRpcRefusal | null = null;
  let resolveParentExit: () => void = () => {};
  let resolveStreamClose: () => void = () => {};
  const parentExitPromise = new Promise<void>((resolve) => {
    resolveParentExit = resolve;
  });
  const streamClosePromise = new Promise<void>((resolve) => {
    resolveStreamClose = resolve;
  });

  const declared = () => parentExit !== null;

  function fail(status: string, code: string, detail: string | null = null) {
    if (fatal) return;
    fatal = new PiRpcRefusal(code, status, detail);
    for (const [id, waiter] of [...pending.entries()]) {
      pending.delete(id);
      clearTimeout(waiter.timer);
      waiter.reject(fatal);
    }
    settleWaiters();
  }

  function flushDrains() {
    const queue = drainQueue;
    drainQueue = [];
    for (const resolve of queue) resolve();
  }

  function findRecord(predicate: Predicate, fromOrdinal: number) {
    for (let index = fromOrdinal; index < records.length; index += 1) {
      if (predicate(records[index]!, index))
        return { record: records[index]!, ordinal: index };
    }
    return null;
  }

  function settleWaiters() {
    for (let index = eventWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = eventWaiters[index]!;
      const found = findRecord(waiter.predicate, waiter.fromOrdinal);
      if (found) {
        eventWaiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(found);
      } else if (fatal) {
        eventWaiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.reject(fatal);
      } else if (streamsClosed) {
        eventWaiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.reject(new PiRpcRefusal('rpc_exited_early', 'needs_input'));
      }
    }
  }

  function handleLine(line: string) {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!trimmed.length) return;
    if (onRecord) {
      try {
        onRecord(trimmed);
      } catch (error) {
        fail('failed', 'evidence_write_failed', errorDetail(error));
        return;
      }
    }
    let record: unknown;
    try {
      record = parseJson(trimmed);
    } catch {
      fail('invalid', 'malformed_record', 'a stdout record is not valid JSON');
      return;
    }
    if (!isPiRecord(record)) {
      fail(
        'invalid',
        'malformed_record',
        'a stdout record is not a JSON object',
      );
      return;
    }
    records.push(record);
    if (record.type === 'response') {
      const waiter = record.id !== undefined ? pending.get(record.id) : null;
      if (!waiter) {
        fail(
          'invalid',
          record.command === 'parse'
            ? 'rpc_parse_error'
            : 'unexpected_response_id',
          `a response arrived for ${record.id ?? 'no request id'}`,
        );
        return;
      }
      pending.delete(record.id!);
      clearTimeout(waiter.timer);
      if (record.command !== waiter.type) {
        waiter.reject(
          new PiRpcRefusal(
            'response_command_mismatch',
            'invalid',
            `expected ${waiter.type}, got ${record.command}`,
          ),
        );
        return;
      }
      if (record.success !== true) {
        waiter.reject(
          new PiRpcRefusal(
            'native_command_failed',
            'invalid',
            record.error ?? null,
          ),
        );
        return;
      }
      waiter.resolve(record);
    }
    settleWaiters();
  }

  function finishStreams() {
    if (streamsClosed) return;
    streamsClosed = true;
    try {
      text += decoder.end();
    } catch {
      text = '';
    }
    if (text.trim().length) {
      fail(
        'invalid',
        'incomplete_framing',
        'the child closed with a partial record',
      );
      text = '';
    }
    for (const [id, waiter] of [...pending.entries()]) {
      pending.delete(id);
      clearTimeout(waiter.timer);
      waiter.reject(
        fatal ?? new PiRpcRefusal('rpc_exited_early', 'needs_input'),
      );
    }
    settleWaiters();
    flushDrains();
    resolveStreamClose();
  }

  child.once('exit', (code, signal) => {
    parentExit = { code: code ?? null, signal: signal ?? null };
    resolveParentExit();
  });
  child.once('close', (code, signal) => {
    if (parentExit === null) {
      parentExit = { code: code ?? null, signal: signal ?? null };
      resolveParentExit();
    }
    finishStreams();
  });
  child.once('error', (error) => {
    // A spawn error (for example ENOENT) is reported before close; a stdin error after spawn is
    // a broken pipe that the stream-close path already explains.
    spawnFailed = true;
    spawnError = error;
    fail('needs_input', 'spawn_failed', errorDetail(error));
    if (child.pid === undefined) {
      if (parentExit === null) {
        parentExit = { code: null, signal: null };
        resolveParentExit();
      }
      finishStreams();
    }
  });
  child.stdin.on('error', () => {
    if (!streamsClosed) fail('needs_input', 'rpc_stdin_failed');
  });
  child.stdin.on('drain', flushDrains);

  child.stdout.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      fail(
        'invalid',
        'rpc_response_too_large',
        `${bytes} bytes of stdout exceeds ${maxBytes}`,
      );
      child.kill('SIGKILL');
      return;
    }
    text += decoder.write(chunk);
    let index = text.indexOf('\n');
    while (index !== -1) {
      const line = text.slice(0, index);
      text = text.slice(index + 1);
      handleLine(line);
      index = text.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk) => {
    if (stderrBytes < maxStderrBytes)
      stderrChunks.push(chunk.subarray(0, maxStderrBytes - stderrBytes));
    stderrBytes += chunk.length;
  });
  // Destroying our own read ends must not surface as an unhandled stream error.
  child.stdout.on('error', () => {});
  child.stderr.on('error', () => {});

  function writeLine(record: Record<string, unknown>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (streamsClosed || !child.stdin!.writable) {
        reject(new PiRpcRefusal('rpc_stdin_closed', 'needs_input'));
        return;
      }
      let flushed;
      try {
        flushed = child.stdin!.write(`${JSON.stringify(record)}\n`);
      } catch {
        reject(new PiRpcRefusal('rpc_stdin_failed', 'needs_input'));
        return;
      }
      if (flushed) resolve();
      else drainQueue.push(resolve);
    });
  }

  function request(
    type: string,
    fields: Record<string, unknown> = {},
    { timeoutMs = requestTimeoutMs } = {},
  ): Promise<PiRecord> {
    if (fatal) return Promise.reject(fatal);
    if (streamsClosed)
      return Promise.reject(
        new PiRpcRefusal('rpc_exited_early', 'needs_input'),
      );
    const id = `pirpc-${nonce}-${sequence}`;
    sequence += 1;
    return new Promise<PiRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new PiRpcRefusal(
            'rpc_response_deadline',
            'needs_input',
            `no response to ${type} within ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      pending.set(id, { type, resolve, reject, timer });
      writeLine({ id, type, ...fields }).catch((error) => {
        if (pending.delete(id)) {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  function waitForEvent(
    predicate: Predicate,
    { timeoutMs = requestTimeoutMs, fromOrdinal = 0 } = {},
  ): Promise<Found> {
    const existing = findRecord(predicate, fromOrdinal);
    if (existing) return Promise.resolve(existing);
    if (fatal) return Promise.reject(fatal);
    if (streamsClosed)
      return Promise.reject(
        new PiRpcRefusal('rpc_exited_early', 'needs_input'),
      );
    return new Promise<Found>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = eventWaiters.findIndex(
          (waiter) => waiter.resolve === resolve,
        );
        if (index >= 0) eventWaiters.splice(index, 1);
        reject(
          new PiRpcRefusal(
            'rpc_event_deadline',
            'needs_input',
            `no matching event within ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      eventWaiters.push({ predicate, fromOrdinal, resolve, reject, timer });
    });
  }

  /** Orderly EOF, then a bounded signal of this exact child, then a bounded stream-close wait. */
  async function shutdown() {
    if (parentExit === null && !streamsClosed) {
      try {
        child.stdin!.end();
      } catch {
        // The pipe may already be gone; the exit path reports what happened.
      }
      let exited = await waitBounded(parentExitPromise, shutdownTimeoutMs);
      if (!exited) {
        killedAfterEof = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // Already gone.
        }
        exited = await waitBounded(parentExitPromise, signalGraceMs);
        if (!exited) {
          signaledKill = true;
          try {
            child.kill('SIGKILL');
          } catch {
            // Already gone.
          }
          await waitBounded(parentExitPromise, signalGraceMs);
        }
      }
    }
    if (!streamsClosed) {
      const closedInTime = await waitBounded(
        streamClosePromise,
        streamCloseGraceMs,
      );
      if (!closedInTime) {
        // A descendant inherited our pipes and keeps them open. Detach only the handles this
        // process owns; never signal a process this API did not spawn.
        streamsDetached = true;
        for (const stream of [child.stdin, child.stdout, child.stderr]) {
          try {
            stream?.destroy();
          } catch {
            // Already destroyed.
          }
        }
        // After destroying our own handles `close` is prompt; a short settle keeps the whole
        // shutdown bounded even on a loaded machine.
        await waitBounded(
          streamClosePromise,
          Math.min(streamCloseGraceMs, 250),
        );
      }
    }
    return {
      exit_code: parentExit?.code ?? null,
      signal: parentExit?.signal ?? null,
      parent_exited: declared(),
      stream_closed: streamsClosed,
      streams_detached: streamsDetached,
      killed_after_eof_timeout: killedAfterEof,
      signaled_kill: signaledKill,
    };
  }

  return {
    records,
    recordCount: () => records.length,
    fatal: () => fatal,
    parentExited: () => declared(),
    streamsDetached: () => streamsDetached,
    spawnFailed: () => spawnFailed,
    spawnError: () => spawnError,
    stderr: () => Buffer.concat(stderrChunks),
    request,
    waitForEvent,
    shutdown,
  };
}

// ---------------------------------------------------------------------------
// Gated owned launch + query/prompt/cancel
// ---------------------------------------------------------------------------

/**
 * Start exactly one owned Pi RPC child under the same admission/reservation gates as the native
 * pilot launcher, bind the native session header, and return a handle.
 *
 * Returns `{ ok: true as const, session, reservation_id }` on success. Every pre-handle failure returns
 * `{ ok: false as const, refused: true, stage, reason, ... }`; a failure after the reservation exists has
 * already been settled honestly.
 */
export async function startOwnedPiRpc(options: PiOptions) {
  let opts: Normalized;
  try {
    opts = normalizeOwnedOptions(options);
  } catch (error) {
    return refused('validation', error);
  }

  try {
    assertNamespaceGuard(opts);
  } catch (error) {
    return refused('evidence', error);
  }
  const artifacts = artifactPaths(opts);
  const createdDirs: string[] = [];
  const cleanupEvidence = () => {
    try {
      assertNamespaceGuard(opts);
    } catch {
      // Never remove or follow pathnames after the captured namespace changed.
      return;
    }
    try {
      fs.rmSync(artifacts.eventsFile, { force: true });
    } catch {
      // Best effort: a file that cannot be removed is reported by the refuse reason.
    }
    for (const directory of [...createdDirs].reverse()) {
      try {
        fs.rmdirSync(directory);
      } catch {
        // Only remove a directory this call created and that is still empty.
      }
    }
  };

  try {
    for (const target of Object.values(artifacts)) {
      if (fs.lstatSync(target, { throwIfNoEntry: false }))
        throw new PiRpcRefusal('evidence_target_exists', 'invalid', target);
    }
    if (!fs.existsSync(opts.evidenceDir)) {
      fs.mkdirSync(opts.evidenceDir, { recursive: true, mode: 0o700 });
      createdDirs.push(opts.evidenceDir);
    }
    if (!fs.statSync(opts.evidenceDir).isDirectory())
      throw new PiRpcRefusal('evidence_dir_not_a_directory');
    fs.writeFileSync(artifacts.eventsFile, '', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    cleanupEvidence();
    return refused('evidence', error);
  }

  // Protocol identities are always read from the registered task. A task without a coordinator
  // cannot start a new RPC child, because a query or cancellation could not be recorded.
  let protocol: ReturnType<typeof resolveProtocol>;
  try {
    protocol = resolveProtocol(opts);
  } catch (error) {
    cleanupEvidence();
    return refused('protocol', error);
  }

  const admission = admitLaunch({
    assignmentFile: opts.assignmentFile,
    capabilitiesFile: opts.capabilitiesFile,
    taskRoot: opts.taskRoot,
    cwd: opts.cwd,
    sessionId: opts.resume ?? opts.sessionId,
    harness: 'pi',
    profile: opts.profile,
    launchKind: opts.launchKind,
    discovery: opts.discovery,
    resumeSelector: opts.resume,
    now: opts.clock,
    maxAgeMinutes: opts.maxAgeMinutes,
  });
  if (!admission.ok) {
    cleanupEvidence();
    return {
      ok: false as const,
      refused: true,
      stage: 'admission',
      reason: admission.reason,
      admission,
    };
  }

  const reservation = reserveLaunch(opts.taskRoot, {
    expectRevision: admission.state_revision,
    clock: opts.clock,
    reservation: {
      reservation_id: `pirpc-${createNonce()}`,
      subtask_id: opts.assignmentId,
      attempt: opts.attempt,
      kind: opts.launchKind,
      mode: admission.mode,
      phase: opts.phase,
      holder: opts.assignment.assignee,
      pid: process.pid,
      requested_session_id: (opts.resume ?? opts.sessionId)!,
      resume_selector: opts.resume,
      transport: 'pi-rpc',
    },
  });
  if (!reservation.ok) {
    cleanupEvidence();
    return {
      ok: false as const,
      refused: true,
      stage: 'reservation',
      reason: reservation.reason,
      admission,
      reservation,
    };
  }

  try {
    assertNamespaceGuard(opts);
    if (!fs.existsSync(opts.sessionDir))
      fs.mkdirSync(opts.sessionDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (
      error instanceof PiRpcRefusal &&
      error.code === 'private_namespace_redirected'
    ) {
      return refused('evidence', error);
    }
    settleLaunch(opts.taskRoot, {
      reservationId: reservation.reservation_id,
      outcome: 'not_started',
      runner: 'pi-cli',
      detail: errorDetail(error),
      expectedIdentity: admission.expected_identity,
      capabilityEvidence: admission.capability_evidence,
    });
    cleanupEvidence();
    return refused('evidence', error);
  }

  const startedAt = nowIso(opts.clock);
  const argv = buildArgv(opts);
  let child: ChildProcess;
  try {
    assertNamespaceGuard(opts);
    child = spawn(opts.piBin, argv, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
  } catch (error) {
    if (
      error instanceof PiRpcRefusal &&
      error.code === 'private_namespace_redirected'
    ) {
      return refused('spawn', error);
    }
    settleLaunch(opts.taskRoot, {
      reservationId: reservation.reservation_id,
      outcome: 'not_started',
      runner: 'pi-cli',
      detail: errorDetail(error),
      expectedIdentity: admission.expected_identity,
      capabilityEvidence: admission.capability_evidence,
    });
    cleanupEvidence();
    return refused('spawn', error);
  }

  const proof: Proof = {
    schema: RPC_SCHEMA,
    reservation_id: reservation.reservation_id,
    child_pid: child.pid ?? null,
    expected_session_id: admission.expected_identity,
    requested_session_id: opts.resume ?? opts.sessionId,
    resumed_from: opts.resume,
    session_dir: opts.sessionDir,
    admission: {
      mode: admission.mode,
      launch_kind: admission.launch_kind,
      resume_selector: admission.resume_selector,
      max_age_minutes: opts.maxAgeMinutes,
    },
    started_at: startedAt,
    prompt: null,
    queries: [],
    cancel: null,
    stop_scope:
      'owned RPC child only; no arbitrary background or descendant stop guarantee',
  };

  let namespaceLost = false;
  const rpc = attachTransport(child, {
    requestTimeoutMs: opts.requestTimeoutMs,
    shutdownTimeoutMs: opts.shutdownTimeoutMs,
    signalGraceMs: opts.signalGraceMs,
    streamCloseGraceMs: opts.streamCloseGraceMs,
    maxBytes: opts.maxBytes,
    onRecord: (line: string) => {
      if (namespaceLost) return;
      try {
        assertNamespaceGuard(opts);
      } catch {
        namespaceLost = true;
        return;
      }
      try {
        fs.appendFileSync(artifacts.eventsFile, `${line}\n`);
      } catch {
        namespaceLost = true;
      }
    },
  });

  let observedSessionId: string | null = null;
  let reportedSessionFile: string | null = null;
  let boundSessionFile: string | null = null;
  let promptSent = false;
  let promptBaseline = 0;
  let lastPromptOrdinal = 0;
  let operationError: unknown = null;
  let finishPromise: Promise<PiFinish> | null = null;

  const setOperationError = (error: unknown) => {
    operationError = operationError ?? error;
  };

  async function request(type: string, fields: Record<string, unknown> = {}) {
    const remaining = opts.deadlineAt - Date.now();
    if (remaining <= 0)
      throw new PiRpcRefusal('operation_deadline', 'needs_input');
    return rpc.request(type, fields, {
      timeoutMs: Math.min(opts.requestTimeoutMs, remaining),
    });
  }

  /** Bound an event wait by the remaining total operation budget as well as its own limit. */
  function eventTimeout(fallback: number) {
    const remaining = opts.deadlineAt - Date.now();
    if (remaining <= 0)
      throw new PiRpcRefusal('operation_deadline', 'needs_input');
    return Math.min(fallback, remaining);
  }

  function protocolMessage(
    input: Pick<MessageInput, 'type' | 'from' | 'to'> &
      Partial<Pick<MessageInput, 'reply_to' | 'owner_epoch' | 'body'>>,
  ) {
    const message = buildMessage({
      task_id: protocol.taskId,
      subtask_id: protocol.subtaskId,
      attempt: protocol.attempt,
      from: input.from,
      to: input.to,
      reply_to: input.reply_to ?? null,
      owner_epoch: input.owner_epoch ?? null,
      type: input.type,
      body: input.body ?? {},
    });
    const result = submitMessage(opts.taskRoot, message);
    if (!result.ok) {
      throw new PiRpcRefusal(
        'protocol_message_refused',
        'failed',
        result.reason ?? 'refused',
      );
    }
    return { message_id: message.message_id, result };
  }

  /**
   * Current-epoch authority check. Admission runs once, but a handoff, a freeze or a released
   * claim can happen while this handle is alive; new work is only authorized while the original
   * contract still owns the attempt.
   */
  function assertCurrentAuthority({
    requireResources,
  }: {
    requireResources: boolean;
  }) {
    const record = readRecord(opts.taskRoot);
    if (!record)
      throw new PiRpcRefusal('task_record_unavailable', 'needs_input');
    if (requireResources && record.dispatch_frozen)
      throw new PiRpcRefusal('dispatch_frozen', 'needs_input');
    const currentEpoch = record.coordinator?.owner_epoch ?? null;
    const contractEpoch = opts.assignment.coordinator?.owner_epoch ?? null;
    if (currentEpoch !== contractEpoch)
      throw new PiRpcRefusal(
        'stale_epoch',
        'needs_input',
        `record epoch ${currentEpoch}, contract epoch ${contractEpoch}`,
      );
    const attempt = findAttempt(record, opts.assignmentId, opts.attempt);
    if (!attempt) throw new PiRpcRefusal('attempt_not_registered');
    if (
      requireResources &&
      hasPendingCancellation(record, opts.assignmentId, opts.attempt)
    ) {
      throw new PiRpcRefusal('cancel_unconfirmed', 'needs_input');
    }
    const assignee = attempt.assignee ?? null;
    if (
      !assignee ||
      assignee.agent_id !== opts.assignment.assignee.agent_id ||
      assignee.session_id !== opts.assignment.assignee.session_id
    ) {
      throw new PiRpcRefusal('assignee_mismatch');
    }
    if (
      ['completed', 'failed', 'cancelled'].includes(attempt.state) ||
      (requireResources && attempt.state === 'unknown')
    ) {
      throw new PiRpcRefusal(
        'attempt_not_active',
        'needs_input',
        attempt.state,
      );
    }
    if (requireResources) {
      // Issuing new work also requires the original reservation to still be live and every
      // contracted write resource to still be held by this assignee at the contracted epoch.
      const activeReservation = (record.launch_reservations ?? []).find(
        (item) => item.reservation_id === reservation.reservation_id,
      );
      if (!activeReservation || activeReservation.released_at)
        throw new PiRpcRefusal('reservation_not_active', 'needs_input');
      const claims = (record.claims ?? []).filter((item) => !item.released_at);
      for (const resource of opts.assignment.resources ?? []) {
        if (resource.access !== 'write') continue;
        const descriptor = describeResource(resource);
        const held = claims.find(
          (claim) =>
            claimCovers(claim, descriptor) &&
            claim.access === 'write' &&
            claim.holder?.agent_id === opts.assignment.assignee.agent_id &&
            claim.holder?.session_id === opts.assignment.assignee.session_id &&
            (claim.subtask_id ?? null) === opts.assignmentId &&
            (claim.attempt ?? null) === opts.attempt,
        );
        if (!held)
          throw new PiRpcRefusal(
            'resource_not_held',
            'needs_input',
            descriptor.key,
          );
        if (held.resource_epoch !== resource.resource_epoch)
          throw new PiRpcRefusal('resource_epoch_mismatch', 'needs_input');
      }
    }
  }

  async function verifyCancellationIntent(intent: CancellationIntentReference) {
    if (
      intent === null ||
      typeof intent !== 'object' ||
      typeof intent.messageId !== 'string' ||
      intent.messageId.trim() === '' ||
      typeof intent.contentDigest !== 'string' ||
      typeof intent.fileDigest !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(intent.contentDigest) ||
      !/^sha256:[0-9a-f]{64}$/.test(intent.fileDigest)
    )
      throw new PiRpcRefusal('cancel_intent_reference_invalid', 'needs_input');

    assertNamespaceGuard(opts);
    assertCurrentAuthority({ requireResources: false });
    const registered = await readMessageFromTaskRoot(
      opts.taskRoot,
      intent.messageId,
    );
    if (!registered.ok)
      throw new PiRpcRefusal(
        'cancel_intent_not_registered',
        'needs_input',
        registered.code,
      );
    assertNamespaceGuard(opts);

    const { message, entry, digest } = registered.value;
    const record = readRecord(opts.taskRoot);
    const attempt = record
      ? findAttempt(record, opts.assignmentId, opts.attempt)
      : null;
    const coordinator = record?.coordinator ?? null;
    const assignee = attempt?.assignee ?? null;
    type IntentIdentity = Pick<Identity, 'agent_id' | 'session_id'> & {
      readonly harness?: string | null;
    };
    const sameIdentity = (
      left: IntentIdentity | null | undefined,
      right: IntentIdentity | null | undefined,
    ) =>
      left !== null &&
      left !== undefined &&
      right !== null &&
      right !== undefined &&
      left.agent_id === right.agent_id &&
      left.session_id === right.session_id &&
      (left.harness ?? null) === (right.harness ?? null);

    if (
      digest !== intent.fileDigest ||
      message.message_id !== intent.messageId ||
      message.content_digest !== intent.contentDigest ||
      message.type !== 'CANCEL' ||
      message.task_id !== opts.assignment.task_id ||
      message.subtask_id !== opts.assignmentId ||
      message.attempt !== opts.attempt ||
      message.owner_epoch !== opts.assignment.coordinator.owner_epoch ||
      message.owner_epoch !== protocol.ownerEpoch ||
      entry === null ||
      entry.message_id !== message.message_id ||
      entry.type !== 'CANCEL' ||
      entry.state !== 'applied' ||
      entry.subtask_id !== message.subtask_id ||
      entry.attempt !== message.attempt ||
      entry.owner_epoch !== message.owner_epoch ||
      entry.content_digest !== intent.contentDigest ||
      !sameIdentity(entry.from, message.from) ||
      !sameIdentity(entry.to, message.to) ||
      record === null ||
      record.task_id !== message.task_id ||
      coordinator === null ||
      coordinator.owner_epoch !== message.owner_epoch ||
      !sameIdentity(coordinator, message.from) ||
      !sameIdentity(coordinator, protocol.coordinator) ||
      !sameIdentity(coordinator, opts.assignment.coordinator) ||
      assignee === null ||
      !sameIdentity(assignee, message.to) ||
      !sameIdentity(assignee, opts.assignment.assignee) ||
      !sameIdentity(assignee, protocol.assignee)
    )
      throw new PiRpcRefusal('cancel_intent_mismatch', 'needs_input');

    assertNamespaceGuard(opts);
    assertCurrentAuthority({ requireResources: false });
    return { message, fileDigest: digest };
  }

  /**
   * Read `get_state` and bind the exact native session file. The id alone is not enough: the
   * reported file must exist, its header must carry the contracted id and cwd, and once bound it
   * may not switch to a different path.
   */
  async function assertIdentity({ requireBinding = false } = {}) {
    const response = await request('get_state');
    const data = response.data;
    if (!isObject(data) || typeof data.sessionId !== 'string')
      throw new PiRpcRefusal('state_malformed');
    if (data.sessionId !== admission.expected_identity) {
      observedSessionId = data.sessionId;
      throw new PiRpcRefusal(
        'native_identity_mismatch',
        'invalid',
        `native session ${data.sessionId} is not the contracted ${admission.expected_identity}`,
      );
    }
    if (
      typeof data.isStreaming !== 'boolean' ||
      typeof data.isCompacting !== 'boolean' ||
      !Number.isSafeInteger(data.pendingMessageCount)
    ) {
      throw new PiRpcRefusal('state_incomplete');
    }
    if (
      typeof data.sessionFile !== 'string' ||
      !path.isAbsolute(data.sessionFile)
    ) {
      throw new PiRpcRefusal('native_session_file_missing', 'needs_input');
    }
    const reported = path.resolve(data.sessionFile);
    if (reportedSessionFile !== null && reported !== reportedSessionFile) {
      throw new PiRpcRefusal(
        'native_session_file_switched',
        'needs_input',
        reported,
      );
    }
    reportedSessionFile = reported;
    const header = readPiSessionHeader(reported);
    if (header) {
      if (header.id !== admission.expected_identity)
        throw new PiRpcRefusal('native_session_id_mismatch', 'invalid');
      if (!samePath(header.cwd, opts.cwd))
        throw new PiRpcRefusal('native_cwd_mismatch', 'invalid');
      boundSessionFile = reported;
    } else if (requireBinding) {
      throw new PiRpcRefusal(
        'native_session_file_unavailable',
        'needs_input',
        reported,
      );
    }
    observedSessionId = data.sessionId;
    return { response, data, headerBound: boundSessionFile !== null };
  }

  const session = {
    schema: RPC_SCHEMA,
    pid: child.pid ?? null,
    expectedSessionId: admission.expected_identity,
    sessionFile: () => boundSessionFile,
    /** Byte offset sampled immediately before the prompt was sent. */
    promptBaseline: () => promptBaseline,

    /** Read-only native query. Repeatable; always recorded through the protocol. */
    async query() {
      try {
        assertNamespaceGuard(opts);
        assertCurrentAuthority({ requireResources: false });
        // The request is recorded before the observation it asks for.
        const statusQuery = protocolMessage({
          type: 'STATUS_QUERY',
          from: protocol.coordinator,
          to: protocol.assignee,
          owner_epoch: protocol.ownerEpoch,
          body: { native_rpc_child_pid: child.pid ?? null },
        });
        const { response, data } = await assertIdentity({
          requireBinding: false,
        });
        const at = nowIso();
        const queryFile = path.join(
          opts.evidenceDir,
          `${opts.outputName}.query-${proof.queries.length + 1}.json`,
        );
        assertNamespaceGuard(opts);
        fs.writeFileSync(
          queryFile,
          `${JSON.stringify(
            {
              schema: RPC_SCHEMA,
              kind: 'native-query',
              at,
              command: 'get_state',
              response,
            },
            null,
            2,
          )}\n`,
          { flag: 'wx', mode: 0o600 },
        );
        assertNamespaceGuard(opts);
        const status = protocolMessage({
          type: 'STATUS',
          from: protocol.assignee,
          to: protocol.coordinator,
          owner_epoch: protocol.ownerEpoch,
          reply_to: statusQuery.message_id,
          body: {
            status: data.isStreaming ? 'running' : 'unknown',
            evidence_ref: queryFile,
          },
        });
        assertNamespaceGuard(opts);
        const queryDigest = sha256File(queryFile);
        assertNamespaceGuard(opts);
        const entry = {
          at,
          session_id: data.sessionId,
          session_file: boundSessionFile,
          header_bound: boundSessionFile !== null,
          is_streaming: data.isStreaming,
          is_compacting: data.isCompacting,
          pending_message_count: data.pendingMessageCount,
          message_count: Number.isSafeInteger(data.messageCount)
            ? data.messageCount
            : null,
          evidence_ref: queryFile,
          evidence_digest: queryDigest,
          status_query_message_id: statusQuery.message_id,
          status_message_id: status.message_id,
        };
        proof.queries.push(entry);
        return entry;
      } catch (error) {
        setOperationError(error);
        throw error;
      }
    },

    /** Send the one frozen prompt for this launch. A second call is refused. */
    async prompt() {
      try {
        if (promptSent)
          throw new PiRpcRefusal(
            'prompt_already_sent',
            'invalid',
            'one frozen prompt per launch',
          );
        assertNamespaceGuard(opts);
        assertCurrentAuthority({ requireResources: true });
        // Pi creates the session file lazily, on the first persisted message. The
        // pre-prompt check therefore verifies the reported session id without requiring
        // the header; the post-prompt check requires the bound header before the run is
        // accepted.
        await assertIdentity({ requireBinding: false });
        // The controller publishes only records written after this baseline, so it must
        // be sampled before the prompt creates the first message.
        const baselineFile = reportedSessionFile;
        promptBaseline = (() => {
          if (baselineFile === null) return 0;
          try {
            return fs.statSync(baselineFile).size;
          } catch {
            return 0;
          }
        })();
        const ordinalBefore = rpc.recordCount();
        const response = await request('prompt', { message: opts.promptText });
        const disposition = response.data?.disposition;
        if (
          typeof disposition !== 'string' ||
          !['started', 'queued', 'handled'].includes(disposition)
        ) {
          throw new PiRpcRefusal(
            'prompt_not_accepted',
            'needs_input',
            `disposition ${disposition}`,
          );
        }
        // The header row is flushed just after the prompt is accepted, so bind with a
        // short bounded retry instead of racing the writer.
        const bindDeadline = Date.now() + 2_000;
        for (;;) {
          try {
            await assertIdentity({ requireBinding: true });
            break;
          } catch (error) {
            const retryable =
              error instanceof PiRpcRefusal &&
              (error.code === 'native_session_file_unavailable' ||
                error.code === 'native_session_header_invalid') &&
              Date.now() < bindDeadline;
            if (!retryable) throw error;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
        promptSent = true;
        lastPromptOrdinal = ordinalBefore;
        proof.prompt = {
          at: nowIso(),
          disposition,
          response_id: response.id,
          event_ordinal_before_request: ordinalBefore,
        };
        return { disposition };
      } catch (error) {
        setOperationError(error);
        throw error;
      }
    },

    /** Bounded wait for the run started by `prompt` to settle. Used by the run helper. */
    async awaitSettled({ timeoutMs = opts.settleTimeoutMs } = {}) {
      try {
        if (proof.prompt?.disposition === 'handled') return null;
        const found = await rpc.waitForEvent(
          (record) => record.type === 'agent_settled',
          {
            fromOrdinal: lastPromptOrdinal,
            timeoutMs: eventTimeout(timeoutMs),
          },
        );
        return { ordinal: found.ordinal, at: nowIso() };
      } catch (error) {
        setOperationError(error);
        throw error;
      }
    },

    /**
     * Explicit cancellation of this owned runtime. It never sends a prompt, never sends
     * CANCELLED and never releases claims: a caller must reconcile the stop externally.
     */
    async cancel(
      options: {
        readonly reason?: string;
        readonly intent?: CancellationIntentReference;
      } = {},
    ) {
      const intent = options.intent;
      try {
        assertNamespaceGuard(opts);
        let verifiedIntent =
          intent === undefined ? null : await verifyCancellationIntent(intent);
        const reason =
          verifiedIntent &&
          typeof verifiedIntent.message.body.reason === 'string'
            ? verifiedIntent.message.body.reason
            : (options.reason ?? 'bounded RPC cancellation request');
        if (verifiedIntent === null)
          assertCurrentAuthority({ requireResources: false });
        const before = await assertIdentity({ requireBinding: true });
        if (intent !== undefined)
          verifiedIntent = await verifyCancellationIntent(intent);
        assertNamespaceGuard(opts);
        assertCurrentAuthority({ requireResources: false });
        const ordinalBeforeAbort = rpc.recordCount();
        const entry: Record<string, unknown> = {
          at: nowIso(),
          reason,
          event_ordinal_before_request: ordinalBeforeAbort,
          session_id: before.data.sessionId,
          reconciliation_required: true,
          stop_scope:
            'owned RPC child only; a native abort response is not proof that arbitrary descendants stopped',
        };
        // Record cancellation evidence before queue clearing or abort so partial failure remains inspectable.
        proof.cancel = entry;
        if (verifiedIntent === null) {
          const cancel = protocolMessage({
            type: 'CANCEL',
            from: protocol.coordinator,
            to: protocol.assignee,
            owner_epoch: protocol.ownerEpoch,
            body: { reason },
          });
          entry.cancel_message_id = cancel.message_id;
        } else {
          entry.cancel_message_id = verifiedIntent.message.message_id;
          entry.cancel_intent = {
            content_digest: verifiedIntent.message.content_digest,
            file_digest: verifiedIntent.fileDigest,
          };
        }
        assertNamespaceGuard(opts);
        assertCurrentAuthority({ requireResources: false });
        const clear = await request('clear_queue');
        entry.clear_queue = {
          id: clear.id,
          steering: Array.isArray(clear.data?.steering)
            ? clear.data.steering
            : [],
          follow_up: Array.isArray(clear.data?.followUp)
            ? clear.data.followUp
            : [],
        };
        const abort = await request('abort');
        entry.abort = {
          id: abort.id,
          success: abort.success === true,
          response_ordinal: rpc.recordCount() - 1,
        };
        let settledEvent = null;
        try {
          // The settled event may be emitted BEFORE the abort response; correlating from the
          // ordinal captured before the request finds it either way. `agent_end` alone is not
          // sufficient because retries/compaction/follow-ups can still follow it.
          settledEvent = await rpc.waitForEvent(
            (record) => record.type === 'agent_settled',
            {
              fromOrdinal: ordinalBeforeAbort,
              timeoutMs: eventTimeout(opts.settleTimeoutMs),
            },
          );
        } catch (error) {
          entry.agent_settled = null;
          entry.agent_settled_error =
            errorCode(error) ?? 'agent_settled_not_observed';
        }
        if (settledEvent)
          entry.agent_settled = { ordinal: settledEvent.ordinal, at: nowIso() };
        try {
          const after = await assertIdentity({ requireBinding: true });
          entry.native_idle =
            after.data.isStreaming === false &&
            after.data.isCompacting === false &&
            after.data.pendingMessageCount === 0;
          entry.idle_state = {
            session_id: after.data.sessionId,
            is_streaming: after.data.isStreaming,
            is_compacting: after.data.isCompacting,
            pending_message_count: after.data.pendingMessageCount,
          };
        } catch (error) {
          entry.native_idle = false;
          entry.idle_error = errorCode(error) ?? 'idle_not_confirmed';
        }
        if (!entry.agent_settled)
          throw new PiRpcRefusal('agent_settled_not_observed', 'needs_input');
        if (!entry.native_idle)
          throw new PiRpcRefusal('native_not_idle_after_abort', 'needs_input');
        return entry;
      } catch (error) {
        setOperationError(error);
        throw error;
      }
    },

    shutdown: () => rpc.shutdown(),
    finalize: (): Promise<PiFinish> => session.finish(),

    /**
     * Bounded shutdown, evidence persistence and one honest settlement. Serializable and safe to
     * call once on every path; no caller-supplied result or outcome can override the outcome.
     */
    finish(): Promise<PiFinish> {
      if (finishPromise) return finishPromise;
      finishPromise = (async () => {
        let exit = null;
        let shutdownError: unknown = null;
        try {
          exit = await rpc.shutdown();
        } catch (error) {
          shutdownError = error;
        }
        const fatal = rpc.fatal();
        const parentExited = rpc.parentExited();
        const detached =
          exit?.streams_detached === true || rpc.streamsDetached();
        const exitCode = exit?.exit_code ?? null;
        const finishedAt = nowIso();
        const identity = classifyIdentity({
          ran: parentExited,
          observed: observedSessionId,
          expected: admission.expected_identity,
          capabilityEvidence: admission.capability_evidence,
        });
        const operationOk = !operationError;
        const transportOk = !fatal && !shutdownError;
        // A clean run also requires the native session file to be observed: without it the
        // execution is not attributable and the attempt must stay reconcile-first.
        const processClean =
          parentExited &&
          exitCode === 0 &&
          !detached &&
          boundSessionFile !== null;
        const cleanExit = operationOk && transportOk && processClean;

        let outcome;
        if (rpc.spawnFailed()) outcome = 'spawn_failed';
        else if (!parentExited) outcome = 'timed_out';
        else outcome = exitCode === 0 ? 'exited' : 'exited_nonzero';

        const execution = {
          schema: EXECUTION_SCHEMA,
          harness: 'pi',
          transport: 'rpc',
          profile: opts.profile,
          phase: opts.phase,
          status: rpc.spawnFailed()
            ? 'spawn_failed'
            : parentExited
              ? 'exited'
              : 'timed_out',
          exit_code: exitCode,
          signal: exit?.signal ?? null,
          spawn_error: rpc.spawnFailed()
            ? (rpc.spawnError()?.message ?? 'spawn_failed')
            : null,
          started_at: startedAt,
          finished_at: finishedAt,
          cwd: opts.cwd,
          session_id: observedSessionId,
          requested_session_id: opts.resume ?? opts.sessionId,
          resumed_from: opts.resume,
          session_file: boundSessionFile,
          header_bound: boundSessionFile !== null,
          identity_status: identity.status,
          identity_confirmed:
            cleanExit &&
            identity.status === 'match' &&
            admission.capability_evidence === 'runtime-bound',
          argv_summary: argv,
          tool_allowlist:
            opts.profile === 'daily'
              ? 'host-settings'
              : TOOL_PROFILES.pi[opts.profile],
          limits: {
            request_timeout_ms: opts.requestTimeoutMs,
            operation_timeout_ms: opts.operationTimeoutMs,
            shutdown_timeout_ms: opts.shutdownTimeoutMs,
            stream_close_grace_ms: opts.streamCloseGraceMs,
            max_bytes: opts.maxBytes,
            model_override: null,
            effort_override: null,
          },
          project_trust: opts.trustProject
            ? 'approved-for-this-run'
            : 'not-approved',
          native_evidence: boundSessionFile,
          prompt_file: opts.promptFile,
          prompt_digest: opts.promptDigest,
          admission: {
            assignment_file: opts.assignmentFile,
            capabilities_file: opts.capabilitiesFile,
            task_root: opts.taskRoot,
            mode: admission.mode,
            launch_kind: admission.launch_kind,
            resume_selector: admission.resume_selector,
            reservation_id: reservation.reservation_id,
            checks: admission.checks,
          },
          planned_outcome: outcome,
          rpc_child_pid: child.pid ?? null,
        };

        let namespaceError: string | null = null;
        const checkNamespace = (): boolean => {
          if (namespaceError !== null) return false;
          try {
            assertNamespaceGuard(opts);
            return true;
          } catch (error) {
            namespaceError =
              errorDetail(error) ?? 'private_namespace_redirected';
            outcome = 'private_namespace_redirected';
            return false;
          }
        };
        let evidenceError: string | null = null;
        const writeFailure = (detail: string | null): void => {
          if (!checkNamespace()) return;
          try {
            fs.writeFileSync(
              artifacts.failureFile,
              `${JSON.stringify(
                {
                  schema: RPC_SCHEMA,
                  at: finishedAt,
                  reason: errorCode(operationError) ?? 'evidence_write_failed',
                  detail,
                  exit,
                  claims_retained: true,
                },
                null,
                2,
              )}\n`,
              { mode: 0o600 },
            );
          } catch {
            // A failure record that cannot be written is reported in the return value.
          }
        };
        if (checkNamespace()) {
          try {
            fs.writeFileSync(
              artifacts.executionFile,
              `${JSON.stringify(execution, null, 2)}\n`,
              { flag: 'wx', mode: 0o600 },
            );
          } catch (error) {
            evidenceError = errorDetail(error) ?? 'execution_write_failed';
            outcome = 'evidence_write_failed';
            writeFailure(evidenceError);
          }
        }
        if (
          namespaceError === null &&
          evidenceError === null &&
          checkNamespace()
        ) {
          try {
            fs.writeFileSync(
              artifacts.proofFile,
              `${JSON.stringify({ ...proof, finished_at: finishedAt, exit }, null, 2)}\n`,
              { flag: 'wx', mode: 0o600 },
            );
          } catch (error) {
            evidenceError = errorDetail(error) ?? 'proof_write_failed';
            outcome = 'evidence_write_failed';
            writeFailure(evidenceError);
          }
        }
        if (
          namespaceError === null &&
          evidenceError === null &&
          checkNamespace()
        ) {
          try {
            fs.writeFileSync(artifacts.stderrFile, rpc.stderr(), {
              flag: 'wx',
              mode: 0o600,
            });
          } catch (error) {
            evidenceError = errorDetail(error) ?? 'stderr_write_failed';
            outcome = 'evidence_write_failed';
            writeFailure(evidenceError);
          }
        }

        let settlement = null;
        let settlementError: unknown = null;
        if (!checkNamespace()) {
          settlementError = new PiRpcRefusal(
            'private_namespace_redirected',
            'needs_input',
            namespaceError,
          );
        } else {
          try {
            settlement = settleLaunch(opts.taskRoot, {
              reservationId: reservation.reservation_id,
              outcome,
              exitCode,
              sessionId: observedSessionId,
              runId: reservation.reservation_id,
              evidenceRef: evidenceError ? null : artifacts.executionFile,
              runner: 'pi-cli',
              detail: operationError
                ? errorDetail(operationError)
                : evidenceError,
              expectedIdentity: admission.expected_identity,
              capabilityEvidence: admission.capability_evidence,
              cleanExit: cleanExit && !evidenceError,
            });
          } catch (error) {
            settlementError = error;
          }
        }
        const recordOk = settlement?.ok === true;
        const ok =
          operationOk &&
          transportOk &&
          processClean &&
          namespaceError === null &&
          !evidenceError &&
          recordOk;

        let reason = null;
        let detail = null;
        if (namespaceError !== null) {
          reason = 'private_namespace_redirected';
          detail = namespaceError;
        } else if (operationError) {
          reason = errorCode(operationError) ?? 'operation_failed';
          detail = errorDetail(operationError) ?? null;
        } else if (evidenceError) {
          reason = 'evidence_write_failed';
          detail = evidenceError;
        } else if (!transportOk) {
          reason = fatal?.code ?? 'shutdown_failed';
          detail = fatal?.detail ?? errorDetail(shutdownError) ?? null;
        } else if (!parentExited) {
          reason = 'process_not_exited';
        } else if (detached) {
          reason = 'stream_termination_unproven';
        } else if (boundSessionFile === null) {
          reason = 'native_session_unobserved';
        } else if (exitCode !== 0) {
          reason = 'unclean_exit';
        } else if (settlementError) {
          reason = 'settlement_exception';
          detail = errorDetail(settlementError);
        } else if (!recordOk) {
          reason =
            settlement && !settlement.ok
              ? settlement.reason
              : 'settlement_failed';
        }

        return {
          ok,
          schema: RPC_SCHEMA,
          reason,
          detail,
          session_id: observedSessionId,
          session_file: boundSessionFile,
          header_bound: boundSessionFile !== null,
          identity: identity.status,
          outcome,
          clean_exit: cleanExit && !evidenceError,
          exit: exit ?? {
            exit_code: null,
            signal: null,
            parent_exited: parentExited,
            stream_closed: null,
            streams_detached: detached,
            killed_after_eof_timeout: false,
            signaled_kill: false,
          },
          transport_fatal: fatal
            ? { code: fatal.code, detail: fatal.detail }
            : null,
          settlement,
          result: {
            ok: recordOk,
            reason:
              settlement && !settlement.ok
                ? settlement.reason
                : errorDetail(settlementError),
            // An honest marker: the reservation may still be unreleased when storage prevented
            // the settlement transaction from committing.
            unresolved_reservation: !recordOk,
          },
          evidence: {
            evidence_dir: opts.evidenceDir,
            events_file: artifacts.eventsFile,
            execution_file:
              namespaceError === null && !evidenceError
                ? artifacts.executionFile
                : null,
            proof_file:
              namespaceError === null && !evidenceError
                ? artifacts.proofFile
                : null,
            failure_file:
              namespaceError === null && evidenceError
                ? artifacts.failureFile
                : null,
            stderr_file: artifacts.stderrFile,
            written: namespaceError === null && !evidenceError,
            error: namespaceError ?? evidenceError,
          },
          operations: {
            prompt: proof.prompt,
            queries: proof.queries,
            cancel: proof.cancel,
          },
        };
      })();
      return finishPromise;
    },
  };
  // Accepted alias for callers of the earlier revision; like `finish` it takes no arguments,
  // so it cannot override the authoritative outcome.

  // Bind the contracted identity and native session header before returning a live handle.
  try {
    await assertIdentity({ requireBinding: false });
  } catch (error) {
    const failure = await session.finish();
    return {
      ok: false as const,
      refused: true,
      stage: 'identity',
      reason: errorCode(error),
      detail: errorDetail(error),
      outcome: failure.outcome,
      settlement: failure.settlement,
      result: failure.result,
      evidence: failure.evidence,
    };
  }

  return {
    ok: true as const,
    session,
    reservation_id: reservation.reservation_id,
  };
}

/**
 * One bounded gated operation. `action` is `query` (default) or `prompt`; unsupported actions
 * are refused before anything is spawned. `prompt` sends the single frozen prompt and waits for
 * it to settle. A cancellation is never implicit here; callers cancel explicitly on the handle.
 */
export async function runOwnedPiRpc(options: PiOptions) {
  const action = options.action ?? 'query';
  if (!ACTIONS.has(action)) {
    return {
      ok: false as const,
      refused: true,
      stage: 'validation',
      reason: 'unsupported_action',
      detail: String(action),
      action,
    };
  }
  const started = await startOwnedPiRpc(options);
  if (!started.ok) return { ...started, action };
  const { session } = started;
  try {
    if (action === 'prompt') {
      await session.prompt();
      await session.awaitSettled();
    }
    await session.query();
  } catch {
    // The handle recorded the failure; finish() still runs and settles honestly.
  }
  const result = await session.finish();
  return { ...result, action };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function refused(stage: string, error: unknown) {
  return {
    ok: false as const,
    refused: true,
    stage,
    reason: errorCode(error) ?? 'invalid_options',
    detail: errorDetail(error),
  };
}

function boundedTimeout(
  value: number | undefined,
  fallback: number,
  max: number,
  code: string,
) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new PiRpcRefusal(code, 'invalid', String(value));
  return value;
}

function absolute(value: unknown, code: string) {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    value.includes('\0')
  )
    throw new PiRpcRefusal(code);
  return value;
}

function assertNamespaceGuard(options: {
  readonly namespaceGuard?: (() => void) | undefined;
}): void {
  if (options.namespaceGuard === undefined) return;
  try {
    options.namespaceGuard();
  } catch (error) {
    throw new PiRpcRefusal(
      'private_namespace_redirected',
      'needs_input',
      errorDetail(error),
    );
  }
}
function normalizeOwnedOptions(options: PiOptions) {
  assertNamespaceGuard(options);
  const taskRoot = absolute(options.taskRoot, 'task_root_must_be_absolute');
  const cwd = absolute(options.cwd, 'cwd_must_be_absolute');
  if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory())
    throw new PiRpcRefusal('cwd_missing');
  const assignmentFile = absolute(
    options.assignmentFile,
    'assignment_must_be_absolute',
  );
  const capabilitiesFile = absolute(
    options.capabilitiesFile,
    'capabilities_must_be_absolute',
  );
  const promptFile = absolute(
    options.promptFile,
    'prompt_file_must_be_absolute',
  );
  const promptStat = fs.statSync(promptFile, { throwIfNoEntry: false });
  if (!promptStat?.isFile()) throw new PiRpcRefusal('prompt_file_missing');
  if (promptStat.size > MAX_PROMPT_BYTES)
    throw new PiRpcRefusal('prompt_too_large');
  const evidenceDir = absolute(
    options.evidenceDir,
    'evidence_dir_must_be_absolute',
  );
  const sessionDir =
    options.sessionDir === undefined
      ? path.join(evidenceDir, 'pi-sessions')
      : absolute(options.sessionDir, 'session_dir_must_be_absolute');
  const outputName = options.outputName ?? 'pi-rpc';
  if (
    typeof outputName !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(outputName)
  )
    throw new PiRpcRefusal('invalid_output_name');

  const assignment = parseJson(fs.readFileSync(assignmentFile, 'utf8'));
  if (!isAssignment(assignment)) throw new PiRpcRefusal('invalid_assignment');
  const profile = options.profile ?? assignment.runner?.profile ?? 'writer';
  if (profile !== 'writer' && profile !== 'reviewer' && profile !== 'daily')
    throw new PiRpcRefusal('unsupported_profile');
  const phase =
    options.phase ?? (options.discovery ? 'discovery' : 'implementation');
  if (!PHASES.has(phase)) throw new PiRpcRefusal('unsupported_phase');
  const resume = options.resume ?? null;
  if (resume !== null && (typeof resume !== 'string' || !resume.trim()))
    throw new PiRpcRefusal('invalid_resume_selector');
  const sessionId = options.sessionId ?? null;
  if (resume === null && (typeof sessionId !== 'string' || !sessionId.trim()))
    throw new PiRpcRefusal('session_id_required');
  const launchKind = options.launchKind ?? (resume ? 'resume' : 'first');
  if (!['first', 'resume'].includes(launchKind))
    throw new PiRpcRefusal('invalid_launch_kind');
  if (launchKind === 'resume' && !resume)
    throw new PiRpcRefusal('resume_selector_required');
  if (launchKind === 'first' && resume)
    throw new PiRpcRefusal('unexpected_resume_selector');

  const requestTimeoutMs = boundedTimeout(
    options.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
    MAX_REQUEST_TIMEOUT_MS,
    'request_timeout_out_of_range',
  );
  const operationTimeoutMs = boundedTimeout(
    options.operationTimeoutMs,
    DEFAULT_OPERATION_TIMEOUT_MS,
    MAX_OPERATION_TIMEOUT_MS,
    'operation_timeout_out_of_range',
  );
  const shutdownTimeoutMs = boundedTimeout(
    options.shutdownTimeoutMs,
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
    MAX_REQUEST_TIMEOUT_MS,
    'shutdown_timeout_out_of_range',
  );
  const settleTimeoutMs = boundedTimeout(
    options.settleTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
    MAX_REQUEST_TIMEOUT_MS,
    'settle_timeout_out_of_range',
  );
  const signalGraceMs = boundedTimeout(
    options.signalGraceMs,
    DEFAULT_SIGNAL_GRACE_MS,
    MAX_REQUEST_TIMEOUT_MS,
    'signal_grace_out_of_range',
  );
  const streamCloseGraceMs = boundedTimeout(
    options.streamCloseGraceMs,
    DEFAULT_STREAM_CLOSE_GRACE_MS,
    MAX_REQUEST_TIMEOUT_MS,
    'stream_close_grace_out_of_range',
  );
  const maxBytes =
    options.maxBytes === undefined
      ? DEFAULT_MAX_BYTES
      : Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0
        ? options.maxBytes
        : (() => {
            throw new PiRpcRefusal('max_bytes_out_of_range');
          })();
  const maxAgeMinutes =
    options.maxAgeMinutes === undefined ? 30 : options.maxAgeMinutes;
  if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes < 0)
    throw new PiRpcRefusal('invalid_max_age');
  const clock = options.clock ?? Date.now();

  return {
    taskRoot,
    cwd,
    assignmentFile,
    capabilitiesFile,
    promptFile,
    evidenceDir,
    sessionDir,
    outputName,
    assignmentId: assignment.assignment_id,
    attempt: assignment.attempt,
    assignment,
    profile,
    phase,
    resume,
    sessionId,
    launchKind,
    discovery: options.discovery === true,
    trustProject: options.trustProject === true,
    piBin: options.piBin ?? process.env.PAPPRA_PI_BIN ?? 'pi',
    promptText: fs.readFileSync(promptFile, 'utf8'),
    promptDigest: sha256File(promptFile),
    requestTimeoutMs,
    operationTimeoutMs,
    shutdownTimeoutMs,
    settleTimeoutMs,
    signalGraceMs,
    streamCloseGraceMs,
    maxBytes,
    maxAgeMinutes,
    namespaceGuard: options.namespaceGuard,
    deadlineAt: Date.now() + operationTimeoutMs,
    clock,
  } as const;
}

function artifactPaths(opts: Normalized) {
  const base = path.join(opts.evidenceDir, opts.outputName);
  return {
    eventsFile: `${base}.rpc.jsonl`,
    executionFile: `${base}.execution.json`,
    proofFile: `${base}.proof.json`,
    failureFile: `${base}.failure.json`,
    stderrFile: `${base}.stderr.log`,
  };
}

function buildArgv(opts: Normalized): string[] {
  const base = ['--mode', 'rpc', '--session-dir', opts.sessionDir];
  const capabilityFlags =
    opts.profile === 'daily'
      ? []
      : ['--no-mcp', '--tools', TOOL_PROFILES.pi[opts.profile]];
  return [
    ...base,
    ...capabilityFlags,
    ...(opts.trustProject ? ['--approve'] : []),
    opts.resume ? '--session' : '--session-id',
    (opts.resume ?? opts.sessionId)!,
  ];
}

/**
 * Read the first record of a native session file.
 *
 * Returns `null` when the file is not there yet (a new session may persist its header only when
 * the runtime is created), and refuses when the file exists but does not carry a usable header.
 */
function readPiSessionHeader(file: string) {
  let head;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(HEADER_READ_BYTES);
      const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
      head = buffer.subarray(0, count);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new PiRpcRefusal(
      'native_session_file_unavailable',
      'needs_input',
      errorDetail(error),
    );
  }
  const end = head.indexOf(10);
  const line = head
    .subarray(0, end === -1 ? head.length : end)
    .toString('utf8');
  let header: unknown;
  try {
    header = parseJson(line);
  } catch {
    throw new PiRpcRefusal('native_session_header_invalid');
  }
  if (
    !isObject(header) ||
    header.type !== 'session' ||
    typeof header.id !== 'string' ||
    typeof header.cwd !== 'string'
  ) {
    throw new PiRpcRefusal('native_session_header_invalid');
  }
  return { ...header, id: header.id, cwd: header.cwd };
}

/**
 * Resolve the sender/recipient identities for STATUS_QUERY, STATUS and CANCEL from the
 * collaboration record. There is no override and no bypass: a task whose identities cannot be
 * resolved does not start a new RPC child.
 */
function resolveProtocol(opts: Normalized) {
  const record = readRecord(opts.taskRoot);
  if (!record?.coordinator)
    throw new PiRpcRefusal(
      'protocol_identity_unavailable',
      'invalid',
      'no coordinator on the task record',
    );
  const attemptRecord = findAttempt(record, opts.assignmentId, opts.attempt);
  const assignee = attemptRecord?.assignee ?? opts.assignment.assignee;
  assertIdentityShape(record.coordinator);
  assertIdentityShape(assignee);
  return {
    taskId: record.task_id,
    subtaskId: opts.assignmentId,
    attempt: opts.attempt,
    ownerEpoch: record.coordinator.owner_epoch ?? null,
    coordinator: record.coordinator,
    assignee,
  };
}

function assertIdentityShape(identity: Identity) {
  if (
    !identity ||
    typeof identity.agent_id !== 'string' ||
    typeof identity.session_id !== 'string' ||
    typeof identity.harness !== 'string'
  ) {
    throw new PiRpcRefusal('protocol_identity_unavailable');
  }
}

export const PI_RPC_SCHEMA = RPC_SCHEMA;
