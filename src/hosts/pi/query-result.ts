import { object, parseJson, errorCode } from '../../infra/validation.js';
import { isPiRecord, type PiRecord } from './protocol.js';
export interface QueryOptions {
  session: string;
  cwd: string;
  expectedSession: string;
  taskId: string;
  assignmentId: string;
  attempt: number;
  inputDigest: string;
  output?: string;
  evidenceDir?: string;
  piBin?: string;
  timeoutMs?: number;
  graceMs?: number;
}
type Normalized = ReturnType<typeof normalize>;
interface Captured {
  commands: string[];
  raw: Buffer[];
  stderr: Buffer | null;
}
interface RpcState {
  lines: Buffer[];
  partial: Buffer[];
  total: number;
  failure: Refusal | null;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  spawnFailed: boolean;
  waiter: (() => void) | null;
}
interface PiPart {
  type?: string;
  text?: string;
  id?: string;
}
interface PiMessage {
  role?: string;
  content?: string | PiPart[];
  stopReason?: string;
  toolCallId?: string;
  isError?: boolean;
  timestamp?: unknown;
}
interface Receipt {
  schema: string;
  task_id: string;
  assignment_id: string;
  attempt: number;
  input_digest: string;
  status: string;
  outputs: { ref: string; digest: string }[];
}
interface Provenance {
  source: string;
  commands_sent: string[];
  session: { file: string; expected_id: string; [key: string]: unknown };
  [key: string]: unknown;
}
export interface RecoveryResult {
  schema: string;
  status: string;
  blockers: string[];
  recovered?: unknown;
  [key: string]: unknown;
}
function isPiMessage(value: unknown): value is PiMessage {
  if (!object(value)) return false;
  for (const key of ['role', 'stopReason', 'toolCallId'])
    if (value[key] !== undefined && typeof value[key] !== 'string')
      return false;
  if (value['isError'] !== undefined && typeof value['isError'] !== 'boolean')
    return false;
  const content = value['content'];
  return (
    content === undefined ||
    typeof content === 'string' ||
    (Array.isArray(content) &&
      content.every(
        (part: unknown) =>
          object(part) &&
          ['type', 'text', 'id'].every(
            (key) => part[key] === undefined || typeof part[key] === 'string',
          ),
      ))
  );
}
function isReceipt(value: unknown): value is Receipt {
  return (
    object(value) &&
    ['schema', 'task_id', 'assignment_id', 'input_digest', 'status'].every(
      (key) => typeof value[key] === 'string',
    ) &&
    typeof value['attempt'] === 'number' &&
    Array.isArray(value['outputs']) &&
    value['outputs'].every(
      (item: unknown) =>
        object(item) &&
        typeof item['ref'] === 'string' &&
        typeof item['digest'] === 'string',
    )
  );
}
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../collab/envelope.js';

// Read-only recovery of a completed native Pi execution whose REPORT notification was lost.
//
// The exact original session file is reopened through `pi --mode rpc` and only
// get_state, get_messages and get_session_stats are sent. No command in this file can
// start model work, run a tool, or change the session. This is NOT a query against an
// already-live Pi process and NOT a read of the shared task record; see docs/a09-native-query.md.
//
// Protocol facts used (Pi 1.3.0 docs/rpc.md): strict JSONL framed on LF only, every
// command carries an `id` that its `response` repeats, stdout carries events that are not
// responses, and closing stdin requests an orderly shutdown.

const SCHEMA = 'harness-collab/pi-native-query/1';
const RECEIPT_SCHEMA = 'harness-collab/native-result/1';
const RECEIPT_KEYS = [
  'assignment_id',
  'attempt',
  'input_digest',
  'outputs',
  'schema',
  'status',
  'task_id',
];
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_GRACE_MS = 2000;
const STDERR_KEEP = 64 * 1024;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

class Refusal extends Error {
  constructor(
    public readonly status: string,
    public readonly code: string,
  ) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function refuse(code: string, status = 'invalid'): never {
  throw new Refusal(status, code);
}
const sha256 = (bytes: string | Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const isObject = object;
const realpath = (file: string) => {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
};
const samePath = (left: string, right: string) => {
  const a = realpath(left);
  return a !== null && a === realpath(right);
};
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function normalize(options: QueryOptions) {
  const absolute = (value: unknown, code: string): string => {
    if (
      typeof value !== 'string' ||
      !path.isAbsolute(value) ||
      value.includes('\0')
    )
      refuse(code);
    return value;
  };
  const text = (value: unknown, code: string): string => {
    if (typeof value !== 'string' || !value.trim()) refuse(code);
    return value;
  };
  const timeoutMs = options.timeoutMs ?? MAX_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  )
    refuse('timeout_out_of_range');
  if (!Number.isSafeInteger(options.attempt) || options.attempt < 1)
    refuse('invalid_attempt');
  if (
    typeof options.inputDigest !== 'string' ||
    !SHA256.test(options.inputDigest)
  )
    refuse('invalid_input_digest');
  return {
    session: absolute(options.session, 'session_must_be_absolute'),
    cwd: absolute(options.cwd, 'cwd_must_be_absolute'),
    expectedSession: text(options.expectedSession, 'expected_session_required'),
    taskId: text(options.taskId, 'task_id_required'),
    assignmentId: text(options.assignmentId, 'assignment_id_required'),
    attempt: options.attempt,
    inputDigest: options.inputDigest,
    output:
      options.output === undefined
        ? null
        : absolute(options.output, 'output_must_be_absolute'),
    evidenceDir:
      options.evidenceDir === undefined
        ? null
        : absolute(options.evidenceDir, 'evidence_dir_must_be_absolute'),
    piBin: options.piBin ?? 'pi',
    timeoutMs,
    graceMs: options.graceMs ?? DEFAULT_GRACE_MS,
  };
}

function hashFile(file: string) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(file, 'r');
  let bytes = 0;
  try {
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
      bytes += count;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { digest: `sha256:${hash.digest('hex')}`, bytes };
}

function readHeader(file: string) {
  let line;
  try {
    if (!fs.statSync(file).isFile()) refuse('session_not_a_file');
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const end = buffer.subarray(0, count).indexOf(10);
      line = buffer.subarray(0, end === -1 ? count : end).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (error instanceof Refusal) throw error;
    refuse('session_unreadable');
  }
  try {
    const header = parseJson(line);
    if (
      isObject(header) &&
      header.type === 'session' &&
      typeof header.id === 'string' &&
      typeof header.cwd === 'string'
    )
      return {
        ...header,
        id: header.id,
        cwd: header.cwd,
        version: header['version'],
      };
  } catch {
    /* falls through to the refusal below */
  }
  return refuse('session_header_invalid');
}

// One child process, strictly sequential requests, bounded by one deadline and one byte cap.
function startRpc(opts: Normalized, captured: Captured) {
  const args = [
    '--mode',
    'rpc',
    '--session',
    opts.session,
    '--session-dir',
    path.dirname(opts.session),
    '--no-mcp',
    '--no-tools',
  ];
  const nonce = randomBytes(6).toString('hex');
  const child = spawn(opts.piBin, args, {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const state: RpcState = {
    lines: [],
    partial: [],
    total: 0,
    failure: null,
    exit: null,
    spawnFailed: false,
    waiter: null,
  };
  let sequence = 0;
  let killedAfterEof = false;
  const wake = () => {
    const waiter = state.waiter;
    state.waiter = null;
    waiter?.();
  };
  const fail = (status: string, code: string) => {
    state.failure ??= new Refusal(status, code);
    wake();
  };
  const closed = new Promise<void>((resolve) => {
    child.once('close', (code, signal) => {
      state.exit = { code, signal };
      resolve();
      wake();
    });
    child.once('error', () => {
      state.spawnFailed = true;
      fail('needs_input', 'spawn_failed');
      resolve();
    });
  });
  // A broken pipe means the child is gone; the exit path below reports why.
  child.stdin.on('error', () => {});
  child.stdout.on('data', (chunk) => {
    state.total += chunk.length;
    if (state.total > MAX_BYTES) {
      fail('invalid', 'response_too_large');
      child.kill('SIGKILL');
      return;
    }
    // Split on LF bytes only; U+2028/U+2029 are legal inside JSON strings.
    let start = 0;
    for (
      let index = chunk.indexOf(10, start);
      index !== -1;
      index = chunk.indexOf(10, start)
    ) {
      state.partial.push(chunk.subarray(start, index));
      state.lines.push(Buffer.concat(state.partial));
      state.partial = [];
      start = index + 1;
    }
    if (start < chunk.length) state.partial.push(chunk.subarray(start));
    wake();
  });
  const stderr: Buffer[] = [];
  let stderrBytes = 0;
  child.stderr.on('data', (chunk) => {
    if (stderrBytes < STDERR_KEEP)
      stderr.push(chunk.subarray(0, STDERR_KEEP - stderrBytes));
    stderrBytes += chunk.length;
  });
  const timer = setTimeout(() => {
    fail('needs_input', 'timeout');
    child.kill('SIGKILL');
  }, opts.timeoutMs);

  async function request(type: string) {
    const id = `pi-query-${nonce}-${sequence++}`;
    captured.commands.push(type);
    if (!state.failure && state.exit === null)
      child.stdin.write(`${JSON.stringify({ id, type })}\n`);
    for (;;) {
      if (state.failure) throw state.failure;
      const line = state.lines.shift();
      if (line) {
        const response = parseLine(line, id, type);
        if (response) {
          captured.raw.push(line);
          return response;
        }
        continue;
      }
      if (state.exit !== null) {
        if (state.partial.length) refuse('incomplete_framing');
        refuse('rpc_exited_early', 'needs_input');
      }
      await new Promise<void>((resolve) => {
        state.waiter = resolve;
      });
    }
  }

  async function close() {
    clearTimeout(timer);
    if (state.exit === null && !state.spawnFailed) {
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
      const exited = await Promise.race([
        closed.then(() => true),
        delay(opts.graceMs).then(() => false),
      ]);
      if (!exited) {
        killedAfterEof = true;
        child.kill('SIGKILL');
        await closed;
      }
    }
    captured.stderr = Buffer.concat(stderr);
    return {
      exit_code: state.exit?.code ?? null,
      signal: state.exit?.signal ?? null,
      killed_after_eof_timeout: killedAfterEof,
      stderr_bytes: stderrBytes,
    };
  }

  return { request, close };
}

// Returns the matching response, or null for an event record that is not a response.
function parseLine(line: Buffer, id: string, type: string) {
  const text = line.toString('utf8').replace(/\r$/, '');
  if (!text.length) return null;
  let record: unknown;
  try {
    record = parseJson(text);
  } catch {
    return refuse('malformed_record');
  }
  if (!isPiRecord(record)) refuse('malformed_record');
  if (record.type !== 'response') return null;
  if (record.id !== id)
    refuse(
      record.command === 'parse' ? 'rpc_parse_error' : 'unexpected_response_id',
    );
  if (record.command !== type) refuse('response_command_mismatch');
  if (record.success !== true) refuse('native_command_failed');
  return record;
}

function checkState(response: PiRecord, opts: Normalized) {
  const data = response.data;
  if (!isObject(data)) refuse('state_malformed');
  if (data.sessionId !== opts.expectedSession) refuse('session_id_mismatch');
  if (
    typeof data.sessionFile !== 'string' ||
    !samePath(data.sessionFile, opts.session)
  )
    refuse('session_file_mismatch');
  if (
    typeof data.isStreaming !== 'boolean' ||
    typeof data.isCompacting !== 'boolean' ||
    !Number.isSafeInteger(data.pendingMessageCount)
  )
    refuse('state_incomplete');
  if (data.isStreaming || data.isCompacting || data.pendingMessageCount !== 0)
    refuse('native_not_settled', 'needs_input');
  return {
    is_streaming: data.isStreaming,
    is_compacting: data.isCompacting,
    pending_message_count: data.pendingMessageCount,
    message_count: Number.isSafeInteger(data.messageCount)
      ? data.messageCount
      : null,
  };
}

function checkStats(response: PiRecord, opts: Normalized) {
  const data = response.data;
  if (!isObject(data)) refuse('stats_malformed');
  if (data.sessionId !== opts.expectedSession) refuse('session_id_mismatch');
  if (
    typeof data.sessionFile !== 'string' ||
    !samePath(data.sessionFile, opts.session)
  )
    refuse('session_file_mismatch');
  const count = (key: string) =>
    Number.isSafeInteger(data[key]) ? data[key] : null;
  return {
    user_messages: count('userMessages'),
    assistant_messages: count('assistantMessages'),
    tool_calls: count('toolCalls'),
    tool_results: count('toolResults'),
    total_messages: count('totalMessages'),
  };
}

function assistantText(message: PiMessage) {
  const parts =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content;
  if (!Array.isArray(parts)) return null;
  let text = '';
  for (const part of parts) {
    if (part?.type === 'thinking') continue;
    if (part?.type !== 'text' || typeof part.text !== 'string') return null;
    text += part.text;
  }
  return text.trim();
}

// Finds the one terminal assistant receipt that matches the exact assignment.
function findReceipt(messages: unknown, opts: Normalized) {
  if (!Array.isArray(messages) || !messages.every(isPiMessage))
    refuse('messages_malformed');
  // Every tool call in the session must have a successful result: a failed or missing
  // tool result means the run's own record cannot be trusted as a completed execution.
  const calls = new Set<string>();
  const results = new Map<string, boolean>();
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type !== 'toolCall') continue;
        if (typeof part.id !== 'string' || calls.has(part.id))
          refuse('tool_call_malformed');
        calls.add(part.id);
      }
    } else if (message.role === 'toolResult') {
      if (
        typeof message.toolCallId !== 'string' ||
        typeof message.isError !== 'boolean' ||
        results.has(message.toolCallId)
      )
        refuse('tool_result_malformed');
      results.set(message.toolCallId, message.isError);
    }
  }
  for (const id of calls)
    if (results.get(id) !== false) refuse('tool_call_unsuccessful');

  let terminal = -1;
  messages.forEach((message, index) => {
    if (message.role === 'assistant') terminal = index;
  });
  if (terminal < 0) refuse('no_assistant_message', 'needs_input');
  const stop = messages[terminal]!.stopReason;
  if (stop === 'error' || stop === 'aborted') refuse('terminal_turn_failed');
  if (stop !== 'stop') refuse('terminal_turn_not_complete', 'needs_input');
  if (terminal !== messages.length - 1) refuse('receipt_not_terminal');

  // Only assistant messages that stopped normally can carry a receipt; user, tool and
  // failed-assistant text that merely looks like one is ignored.
  const related: {
    index: number;
    receipt: Record<string, unknown>;
    timestamp: unknown;
  }[] = [];
  messages.forEach((message, index) => {
    if (message.role !== 'assistant' || message.stopReason !== 'stop') return;
    const text = assistantText(message);
    if (!text?.startsWith('{')) return;
    let receipt: unknown;
    try {
      receipt = parseJson(text);
    } catch {
      return;
    }
    if (!isObject(receipt) || receipt.schema !== RECEIPT_SCHEMA) return;
    if (
      receipt.task_id === opts.taskId &&
      receipt.assignment_id === opts.assignmentId &&
      receipt.attempt === opts.attempt
    ) {
      related.push({ index, receipt, timestamp: message.timestamp ?? null });
    }
  });
  if (related.some((item) => item.receipt.input_digest !== opts.inputDigest))
    refuse('input_digest_mismatch');
  if (!related.length) refuse('no_matching_receipt', 'needs_input');
  if (related.length > 1) refuse('ambiguous_receipt');
  const match = related[0]!;
  if (match.index !== terminal) refuse('receipt_not_terminal');
  const { receipt } = match;
  if (
    Object.keys(receipt).sort().join() !== RECEIPT_KEYS.join() ||
    receipt.status !== 'completed' ||
    !Array.isArray(receipt.outputs) ||
    receipt.outputs.some(
      (item) =>
        !isObject(item) ||
        Object.keys(item).sort().join() !== 'digest,ref' ||
        typeof item.ref !== 'string' ||
        typeof item.digest !== 'string' ||
        !SHA256.test(item.digest),
    )
  )
    refuse('receipt_shape_invalid');
  if (!isReceipt(receipt)) refuse('receipt_shape_invalid');
  return { ...match, receipt, receipt_digest: sha256(canonicalJson(receipt)) };
}

// Output files are only hashed. They are never opened for execution or interpreted.
function verifyOutputs(
  outputs: { ref: string; digest: string }[],
  cwd: string,
) {
  const root = realpath(cwd) ?? refuse('cwd_unavailable');
  const seen = new Set();
  return outputs.map(({ ref, digest }) => {
    if (!path.isAbsolute(ref) || ref.includes('\0') || seen.has(ref))
      refuse('output_ref_invalid');
    seen.add(ref);
    const real = realpath(ref);
    if (real === null) return refuse('output_missing');
    const relative = path.relative(root, real);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      refuse('output_escapes_cwd');
    let hashed;
    try {
      if (!fs.statSync(real).isFile()) refuse('output_not_a_file');
      hashed = hashFile(real);
    } catch (error) {
      if (error instanceof Refusal) throw error;
      return refuse('output_unreadable');
    }
    if (hashed.digest !== digest) refuse('output_digest_mismatch');
    return { ref, digest, bytes: hashed.bytes };
  });
}

// Result and evidence targets must be new: a repeated query never overwrites an earlier one.
function precheckTargets(opts: Normalized) {
  for (const target of [opts.output, opts.evidenceDir]) {
    if (target === null) continue;
    if (fs.lstatSync(target, { throwIfNoEntry: false }))
      refuse('output_exists');
    if (
      !fs
        .statSync(path.dirname(target), { throwIfNoEntry: false })
        ?.isDirectory()
    )
      refuse('output_parent_missing');
  }
}

async function query(
  opts: Normalized,
  provenance: Provenance,
  captured: Captured,
) {
  const header = readHeader(opts.session);
  if (header.id !== opts.expectedSession) refuse('session_id_mismatch');
  if (!samePath(header.cwd, opts.cwd)) refuse('native_cwd_mismatch');
  const before = hashFile(opts.session);
  provenance.session = {
    ...provenance.session,
    id: header.id,
    cwd: header.cwd,
    pi_version: header.version ?? null,
    sha256_before: before.digest,
    bytes_before: before.bytes,
  };

  const rpc = startRpc(opts, captured);
  let refusal: unknown = null;
  let messages: unknown = null;
  try {
    provenance.state = checkState(await rpc.request('get_state'), opts);
    const response = await rpc.request('get_messages');
    messages = response.data?.messages;
    provenance.stats = checkStats(await rpc.request('get_session_stats'), opts);
  } catch (error) {
    refusal = error;
  } finally {
    provenance.cleanup = await rpc.close();
  }
  const after = hashFile(opts.session);
  provenance.session.sha256_after = after.digest;
  if (after.digest !== before.digest) refuse('native_session_mutated');
  if (refusal) throw refusal;

  const match = findReceipt(messages, opts);
  const outputs = verifyOutputs(match.receipt.outputs, opts.cwd);
  if (!Array.isArray(messages)) refuse('messages_malformed');
  provenance.message_count = messages.length;
  provenance.receipt_message_index = match.index;
  provenance.receipt_message_timestamp = match.timestamp;
  const messageId = `msg-pirecover-${createHash('sha256')
    .update(
      canonicalJson({
        task_id: opts.taskId,
        assignment_id: opts.assignmentId,
        attempt: opts.attempt,
        receipt_digest: match.receipt_digest,
      }),
    )
    .digest('hex')
    .slice(0, 40)}`;
  return {
    status: 'recovered',
    blockers: [],
    recovered: {
      message_id: messageId,
      receipt_digest: match.receipt_digest,
      outputs,
      // Body for a REPORT sent through submitMessage; sender, recipient and subtask are the coordinator's to set.
      report_body: {
        status: 'completed',
        input_revision: opts.inputDigest,
        outputs: match.receipt.outputs.map(({ ref, digest }) => ({
          ref,
          digest,
        })),
        native_ref: {
          runner: 'pi',
          session_id: header.id,
          session_file: opts.session,
          session_sha256: before.digest,
          message_index: match.index,
          receipt_digest: match.receipt_digest,
        },
      },
    },
  };
}

function persist(
  opts: Normalized,
  result: RecoveryResult & { provenance: Provenance },
  captured: Captured,
) {
  try {
    if (opts.evidenceDir) {
      fs.mkdirSync(opts.evidenceDir, { mode: 0o700 });
      const files: { ref: string; digest: string }[] = [];
      const save = (name: string, bytes: Uint8Array) => {
        const file = path.join(opts.evidenceDir!, name);
        fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
        files.push({ ref: file, digest: sha256(bytes) });
      };
      if (captured.raw.length)
        save(
          'rpc-responses.jsonl',
          Buffer.concat(
            captured.raw.flatMap((line) => [line, Buffer.from('\n')]),
          ),
        );
      if (captured.stderr?.length) save('rpc-stderr.log', captured.stderr);
      result.provenance.evidence = files;
    }
    if (opts.output)
      fs.writeFileSync(opts.output, `${JSON.stringify(result, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
    return result;
  } catch {
    const { recovered: _recovered, ...rest } = result;
    return {
      ...rest,
      status: 'invalid',
      blockers: ['cannot_write_evidence_or_output'],
    };
  }
}

export async function queryPiResult(
  options: QueryOptions,
): Promise<RecoveryResult> {
  let opts: Normalized;
  try {
    opts = normalize(options);
  } catch (error) {
    return {
      schema: SCHEMA,
      status: 'invalid',
      blockers: [errorCode(error) ?? 'invalid_options'],
    };
  }
  const identity = {
    task_id: opts.taskId,
    assignment_id: opts.assignmentId,
    attempt: opts.attempt,
    input_digest: opts.inputDigest,
  };
  try {
    precheckTargets(opts);
  } catch (error) {
    // A rejected destination is reported as is: nothing is spawned, created or persisted.
    if (!(error instanceof Refusal)) throw error;
    return {
      schema: SCHEMA,
      status: error.status,
      blockers: [error.code],
      ...identity,
      provenance: { source: 'pi-rpc-session-reopen', commands_sent: [] },
    };
  }
  const provenance: Provenance = {
    source: 'pi-rpc-session-reopen',
    commands_sent: [],
    session: { file: opts.session, expected_id: opts.expectedSession },
  };
  const captured: Captured = {
    commands: provenance.commands_sent,
    raw: [],
    stderr: null,
  };
  let outcome;
  try {
    outcome = await query(opts, provenance, captured);
  } catch (error) {
    outcome =
      error instanceof Refusal
        ? { status: error.status, blockers: [error.code] }
        : { status: 'invalid', blockers: ['internal_error'] };
  }
  const result = {
    schema: SCHEMA,
    ...outcome,
    ...identity,
    provenance,
  };
  return persist(opts, result, captured);
}
