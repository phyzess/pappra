import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  parseCodexTokenUsage,
  validSessionId,
  type UsageObservation,
} from '../../usage/observation.js';

/**
 * Read one Codex thread's context-window occupancy through the local app-server proxy.
 *
 * The proxy relays raw bytes to the daemon's Unix control socket, which speaks WebSocket, so
 * this module carries the minimal client: one HTTP upgrade, masked JSON-RPC text frames and
 * the four read-only methods named below. It never starts a turn, never injects items and
 * never writes to the session or to disk.
 */

export type CodexUsageUnavailableReason =
  | 'daemon_unreachable'
  | 'thread_not_found'
  | 'no_rollout_yet'
  | 'no_usage_replayed'
  | 'protocol_error'
  | 'timeout';

export type CodexUsageResult =
  | { state: 'available'; observation: UsageObservation }
  | {
      state: 'unavailable';
      reason: CodexUsageUnavailableReason;
      detail: string | null;
    };

/** The subset of `ChildProcess` the observer uses, so tests can inject a fake daemon. */
export interface ProxyChannel {
  stdin: {
    write(chunk: Buffer | string): unknown;
    end(callback?: () => void): unknown;
  };
  stdout: NodeJS.ReadableStream;
  stderr?: NodeJS.ReadableStream | null;
  kill(): unknown;
  once(
    event: 'exit' | 'error',
    listener: (...args: unknown[]) => void,
  ): unknown;
}

export interface CodexUsageOptions {
  threadId: string;
  /** Executable that exposes `app-server proxy`; defaults to `codex`. */
  codexBin?: string;
  /** Overall bound in milliseconds; defaults to 5000 and allows 200..30000. */
  deadlineMs?: number;
  now?: () => Date;
  /** Injected transport; the default spawns `codex app-server proxy` with piped stdio. */
  openProxy?: () => ProxyChannel;
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_FRAME_ENVELOPE_BYTES = 14;
const MAX_HANDSHAKE_BYTES = 16 * 1024;
const MAX_DETAIL_LENGTH = 200;
const FLUSH_GRACE_MS = 300;
const DEFAULT_DEADLINE_MS = 5000;
const MIN_DEADLINE_MS = 200;
const MAX_DEADLINE_MS = 30_000;
const CLIENT_INFO = {
  name: 'pappra-usage',
  title: 'Pappra usage observer',
  version: '0',
} as const;
const HOST_VERSION = /codex-tui\/([0-9A-Za-z.+-]+)/;

type Phase = 'upgrade' | 'initialize' | 'resume' | 'awaiting_usage';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const clampDetail = (value: string): string =>
  value.length > MAX_DETAIL_LENGTH ? value.slice(0, MAX_DETAIL_LENGTH) : value;

const errorDetail = (error: unknown): string =>
  clampDetail(error instanceof Error ? error.message : String(error));

function boundedDeadline(value: number | undefined): number {
  const chosen = value === undefined ? DEFAULT_DEADLINE_MS : value;
  if (
    typeof chosen !== 'number' ||
    !Number.isSafeInteger(chosen) ||
    chosen < MIN_DEADLINE_MS ||
    chosen > MAX_DEADLINE_MS
  )
    throw new Error(
      `deadlineMs must be an integer between ${MIN_DEADLINE_MS} and ${MAX_DEADLINE_MS}`,
    );
  return chosen;
}

function openProxyChild(codexBin: string): ProxyChannel {
  const child = spawn(codexBin, ['app-server', 'proxy'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!child.stdin || !child.stdout)
    throw new Error('codex app-server proxy did not provide stdio pipes');
  return child as unknown as ProxyChannel;
}

const upgradeRequest = (key: string): string =>
  'GET / HTTP/1.1\r\n' +
  'Host: localhost\r\n' +
  'Upgrade: websocket\r\n' +
  'Connection: Upgrade\r\n' +
  `Sec-WebSocket-Key: ${key}\r\n` +
  'Sec-WebSocket-Version: 13\r\n' +
  '\r\n';

const acceptFor = (key: string): string =>
  createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');

/**
 * Observe the thread once. Expected failures are returned, never thrown; an invalid
 * `deadlineMs` rejects because it is a caller bug, not a daemon condition.
 */
export async function observeCodexUsage(
  options: CodexUsageOptions,
): Promise<CodexUsageResult> {
  const deadlineMs = boundedDeadline(options.deadlineMs);
  const now = options.now ?? (() => new Date());
  const threadId = options.threadId;
  if (!validSessionId(threadId))
    return {
      state: 'unavailable',
      reason: 'thread_not_found',
      detail: 'threadId is not a valid Codex thread id',
    };

  let channel: ProxyChannel;
  try {
    const open =
      options.openProxy ?? (() => openProxyChild(options.codexBin ?? 'codex'));
    channel = open();
  } catch (error) {
    return {
      state: 'unavailable',
      reason: 'daemon_unreachable',
      detail: errorDetail(error),
    };
  }

  return new Promise<CodexUsageResult>((resolve) => {
    const key = randomBytes(16).toString('base64');
    const expectedAccept = acceptFor(key);
    let phase: Phase = 'upgrade';
    let upgraded = false;
    let settled = false;
    let resumeSucceeded = false;
    let outstanding: number | null = null;
    let nextId = 0;
    let hostVersion: string | null = null;
    let pendingUsage: unknown;
    let hasPendingUsage = false;
    let stderrTail = '';
    let inbound = Buffer.alloc(0);
    let timer: NodeJS.Timeout | null = null;

    const stderrDetail = (): string | null => {
      const tail = stderrTail.trim();
      return tail.length > 0 ? clampDetail(tail) : null;
    };

    const writeFrame = (opcode: number, payload: Buffer): void => {
      try {
        const mask = randomBytes(4);
        let header: Buffer;
        if (payload.length < 126) {
          header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
        } else if (payload.length <= 0xffff) {
          header = Buffer.alloc(4);
          header[0] = 0x80 | opcode;
          header[1] = 0x80 | 126;
          header.writeUInt16BE(payload.length, 2);
        } else {
          // Only JSON-RPC control records travel this direction, far below 64 KiB.
          throw new Error('client frame exceeds the 16-bit length limit');
        }
        const masked = Buffer.alloc(payload.length);
        for (let index = 0; index < payload.length; index += 1)
          masked[index] = payload[index]! ^ mask[index % 4]!;
        channel.stdin.write(Buffer.concat([header, mask, masked]));
      } catch {
        // A destroyed stdin means the proxy is gone; never let a write escape.
        gone();
      }
    };

    const writeJson = (value: unknown): void => {
      writeFrame(0x1, Buffer.from(JSON.stringify(value), 'utf8'));
    };

    const sendUnsubscribe = (): void => {
      nextId += 1;
      writeJson({
        id: nextId,
        method: 'thread/unsubscribe',
        params: { threadId },
      });
    };

    const settle = (result: CodexUsageResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (upgraded) {
        if (resumeSucceeded) sendUnsubscribe();
        writeFrame(0x8, Buffer.alloc(0));
      }
      // Give the unsubscribe and close frames a chance to reach the proxy before it is killed:
      // end() reports when its buffered writes have been flushed. A short cap keeps a stuck
      // pipe from delaying the answer.
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(flushTimer);
        try {
          channel.kill();
        } catch {
          // The proxy may already be gone.
        }
        resolve(result);
      };
      const flushTimer = setTimeout(finish, FLUSH_GRACE_MS);
      try {
        channel.stdin.end(finish);
      } catch {
        finish();
      }
    };

    const unavailable = (
      reason: CodexUsageUnavailableReason,
      detail: string | null,
    ): void => settle({ state: 'unavailable', reason, detail });

    const gone = (): void => {
      if (settled) return;
      unavailable('daemon_unreachable', stderrDetail());
    };

    const protocolError = (detail: string): void =>
      unavailable('protocol_error', clampDetail(detail));

    const onProxyError = (error: unknown): void => {
      if (settled) return;
      unavailable(
        'daemon_unreachable',
        stderrDetail() ?? clampDetail(errorDetail(error)),
      );
    };

    const useUsage = (tokenUsage: unknown): void => {
      const observation = parseCodexTokenUsage(
        threadId,
        tokenUsage,
        now(),
        hostVersion,
      );
      if (observation === null) {
        unavailable('no_usage_replayed', 'usage not parseable');
        return;
      }
      settle({ state: 'available', observation });
    };

    const request = (method: string, params: unknown): void => {
      nextId += 1;
      outstanding = nextId;
      writeJson({ id: nextId, method, params });
    };

    const handleError = (error: unknown): void => {
      const message =
        isRecord(error) && typeof error['message'] === 'string'
          ? error['message']
          : '';
      if (phase === 'resume') {
        if (/no rollout found/i.test(message))
          return unavailable(
            'no_rollout_yet',
            message.length > 0 ? clampDetail(message) : null,
          );
        // Observed on Codex 0.164.0: a malformed id is rejected as "invalid session id: ...".
        if (
          /invalid (session|thread) id/i.test(message) ||
          (/thread/i.test(message) &&
            /(not\s+found|unknown|does not exist|no such)/i.test(message))
        )
          return unavailable(
            'thread_not_found',
            message.length > 0 ? clampDetail(message) : null,
          );
      }
      unavailable(
        'protocol_error',
        message.length > 0
          ? clampDetail(message)
          : 'the app-server rejected a request',
      );
    };

    const handleResult = (result: unknown): void => {
      if (phase === 'initialize') {
        const userAgent =
          isRecord(result) && typeof result['userAgent'] === 'string'
            ? result['userAgent']
            : '';
        hostVersion = HOST_VERSION.exec(userAgent)?.[1] ?? null;
        writeJson({ method: 'initialized' });
        phase = 'resume';
        request('thread/resume', { threadId });
        return;
      }
      if (phase === 'resume') {
        if (!isRecord(result) || !Object.hasOwn(result, 'thread')) {
          protocolError('thread/resume returned no thread');
          return;
        }
        const resumed = result['thread'];
        if (
          isRecord(resumed) &&
          typeof resumed['id'] === 'string' &&
          resumed['id'] !== threadId
        ) {
          protocolError('thread/resume returned a different thread');
          return;
        }
        resumeSucceeded = true;
        phase = 'awaiting_usage';
        // The daemon may replay usage before it answers the resume request.
        if (hasPendingUsage) useUsage(pendingUsage);
        return;
      }
      protocolError('unexpected response while awaiting usage');
    };

    const handleUsage = (params: unknown): void => {
      if (!isRecord(params)) return;
      const reported = params['threadId'];
      if (reported !== undefined && reported !== threadId) return;
      if (phase !== 'resume' && phase !== 'awaiting_usage') return;
      const tokenUsage = params['tokenUsage'];
      if (!resumeSucceeded) {
        pendingUsage = tokenUsage;
        hasPendingUsage = true;
        return;
      }
      useUsage(tokenUsage);
    };

    const onRecord = (record: Record<string, unknown>): void => {
      const id = record['id'];
      if (id !== undefined && outstanding !== null && id === outstanding) {
        outstanding = null;
        if (record['error'] !== undefined) handleError(record['error']);
        else handleResult(record['result']);
        return;
      }
      if (record['method'] === 'thread/tokenUsage/updated')
        handleUsage(record['params']);
    };

    const drainFrames = (): void => {
      for (;;) {
        if (settled) return;
        if (inbound.length < 2) return;
        const first = inbound.readUInt8(0);
        const fin = (first & 0x80) !== 0;
        const opcode = first & 0x0f;
        const second = inbound.readUInt8(1);
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (inbound.length < 4) return;
          length = inbound.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (inbound.length < 10) return;
          const declared = inbound.readBigUInt64BE(2);
          if (declared > BigInt(MAX_FRAME_BYTES)) {
            protocolError('WebSocket frame exceeds the 1 MiB limit');
            return;
          }
          length = Number(declared);
          offset = 10;
        }
        // Server frames are unmasked and unfragmented; anything else is a protocol fault.
        if (masked || !fin) {
          protocolError('unexpected server WebSocket frame');
          return;
        }
        if (inbound.length < offset + length) return;
        const payload = Buffer.from(inbound.subarray(offset, offset + length));
        inbound = inbound.subarray(offset + length);
        if (opcode === 0x1) {
          let record: unknown;
          try {
            record = JSON.parse(payload.toString('utf8')) as unknown;
          } catch {
            protocolError('the daemon sent invalid JSON');
            return;
          }
          if (!isRecord(record)) {
            protocolError('the daemon sent a non-object JSON record');
            return;
          }
          onRecord(record);
        } else if (opcode === 0x9) {
          writeFrame(0xa, payload);
        } else if (opcode === 0x8) {
          gone();
          return;
        } else {
          protocolError(`unexpected WebSocket opcode ${opcode}`);
          return;
        }
      }
    };

    const readUpgrade = (): boolean => {
      const boundary = inbound.indexOf('\r\n\r\n');
      if (boundary < 0) {
        if (inbound.length > MAX_HANDSHAKE_BYTES)
          protocolError('handshake header exceeds 16 KiB');
        return false;
      }
      const head = inbound.subarray(0, boundary).toString('latin1');
      inbound = inbound.subarray(boundary + 4);
      const lines = head.split('\r\n');
      const status = lines[0] ?? '';
      if (!/^HTTP\/1\.1 101\b/.test(status)) {
        protocolError(`unexpected handshake status: ${status}`);
        return false;
      }
      const headers = new Map<string, string>();
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon <= 0) continue;
        headers.set(
          line.slice(0, colon).trim().toLowerCase(),
          line.slice(colon + 1).trim(),
        );
      }
      if (headers.get('sec-websocket-accept') !== expectedAccept) {
        protocolError('handshake Sec-WebSocket-Accept does not match');
        return false;
      }
      upgraded = true;
      phase = 'initialize';
      request('initialize', {
        clientInfo: CLIENT_INFO,
        capabilities: null,
      });
      return true;
    };

    const absorbStderr = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      stderrTail = (stderrTail + text).slice(-MAX_DETAIL_LENGTH);
    };

    const onData = (chunk: Buffer | string): void => {
      if (settled) return;
      inbound = Buffer.concat([
        inbound,
        typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk,
      ]);
      if (!upgraded) {
        if (inbound.length > MAX_HANDSHAKE_BYTES) {
          protocolError('handshake header exceeds 16 KiB');
          return;
        }
        if (!readUpgrade()) return;
        if (settled) return;
      }
      if (inbound.length > MAX_FRAME_BYTES + MAX_FRAME_ENVELOPE_BYTES) {
        protocolError('WebSocket reassembly buffer exceeds the 1 MiB limit');
        return;
      }
      drainFrames();
    };

    const onDeadline = (): void => {
      if (settled) return;
      if (resumeSucceeded)
        unavailable(
          'no_usage_replayed',
          'no usage replayed before the deadline',
        );
      else unavailable('timeout', `no reply within ${deadlineMs}ms`);
    };

    channel.stdout.on('data', onData);
    channel.stdout.on('end', gone);
    channel.stdout.on('error', gone);
    if (channel.stderr) {
      channel.stderr.on('data', absorbStderr);
      channel.stderr.on('error', () => {
        // stderr is diagnostic only; a broken pipe never changes the outcome.
      });
    }
    channel.once('exit', gone);
    channel.once('error', onProxyError);
    timer = setTimeout(onDeadline, deadlineMs);
    try {
      channel.stdin.write(upgradeRequest(key));
    } catch (error) {
      unavailable('daemon_unreachable', errorDetail(error));
    }
  });
}
