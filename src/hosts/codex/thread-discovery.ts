import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import type { ProxyChannel } from './usage-observer.js';

/**
 * Discover the single Codex thread a freshly seeded session created, through the local
 * app-server proxy.
 *
 * The proxy relays raw bytes to the daemon's Unix control socket, which speaks WebSocket, so
 * this module carries its own minimal client. The framing is deliberately duplicated from
 * `usage-observer.ts` (a later change deduplicates it); that module is not modified here.
 * Only `thread/loaded/list` and `thread/read` are used, so discovery never resumes, starts,
 * injects into or writes to a thread.
 *
 * A thread matches only on exact `cwd` and exact `preview` equality, with `createdAt` at or
 * after the caller's cutoff. The daemon keeps threads of closed sessions and also loads a
 * blank thread per TUI, so anything weaker would pick a stale thread.
 */

export interface CodexThreadCriteria {
  /** Exact string equality with the thread's cwd. */
  cwd: string;
  /** Exact string equality with the thread's preview (the seed text, newlines included). */
  preview: string;
  /** Unix seconds; a thread matches when its createdAt is at or after this value. */
  createdAfter: number;
}

export type CodexThreadDiscoveryUnavailableReason =
  'daemon_unreachable' | 'timeout' | 'protocol_error';

export type CodexThreadDiscovery =
  | {
      state: 'found';
      threadId: string;
      createdAt: number;
      hostVersion: string | null;
    }
  | { state: 'not_found'; examined: number }
  /** More than one match: never pick one of them. */
  | { state: 'ambiguous'; threadIds: string[] }
  | {
      state: 'unavailable';
      reason: CodexThreadDiscoveryUnavailableReason;
      detail: string | null;
    };

export interface CodexThreadDiscoveryOptions extends CodexThreadCriteria {
  /** Executable that exposes `app-server proxy`; defaults to `codex`. */
  codexBin?: string;
  /** Overall bound in milliseconds; defaults to 8000 and allows 500..30000. */
  deadlineMs?: number;
  /** Injected transport; the default spawns `codex app-server proxy` with piped stdio. */
  openProxy?: () => ProxyChannel;
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_FRAME_ENVELOPE_BYTES = 14;
const MAX_HANDSHAKE_BYTES = 16 * 1024;
const MAX_DETAIL_LENGTH = 200;
const FLUSH_GRACE_MS = 300;
const DEFAULT_DEADLINE_MS = 8000;
const MIN_DEADLINE_MS = 500;
const MAX_DEADLINE_MS = 30_000;
/** Bound on the work one discovery may do, independent of the deadline. */
const MAX_THREADS = 200;
const MAX_PAGES = 5;
const CLIENT_INFO = {
  name: 'pappra-thread-discovery',
  title: 'Pappra thread discovery',
  version: '0',
} as const;
const HOST_VERSION = /codex-tui\/([0-9A-Za-z.+-]+)/;

type PendingMethod = 'initialize' | 'list' | 'read';

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
 * Find one thread once. Expected daemon conditions are returned, never thrown; invalid
 * arguments reject because they are caller bugs, not daemon conditions.
 */
export async function discoverCodexThread(
  options: CodexThreadDiscoveryOptions,
): Promise<CodexThreadDiscovery> {
  const deadlineMs = boundedDeadline(options.deadlineMs);
  const cwd = options.cwd;
  const preview = options.preview;
  const createdAfter = options.createdAfter;
  if (typeof cwd !== 'string' || cwd.length === 0)
    throw new Error('cwd must be a non-empty string');
  if (typeof preview !== 'string' || preview.length === 0)
    throw new Error('preview must be a non-empty string');
  if (typeof createdAfter !== 'number' || !Number.isFinite(createdAfter))
    throw new Error('createdAfter must be a finite unix-seconds number');

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

  return new Promise<CodexThreadDiscovery>((resolve) => {
    const key = randomBytes(16).toString('base64');
    const expectedAccept = acceptFor(key);
    const matches: { threadId: string; createdAt: number }[] = [];
    let upgraded = false;
    let settled = false;
    let nextId = 0;
    let outstandingId: number | null = null;
    let pendingMethod: PendingMethod | null = null;
    let pendingThreadId: string | null = null;
    let hostVersion: string | null = null;
    let examined = 0;
    let pages = 0;
    let pageCursor: string | null = null;
    let queue: string[] = [];
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

    const settle = (result: CodexThreadDiscovery): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (upgraded) writeFrame(0x8, Buffer.alloc(0));
      // Give the close frame a chance to reach the proxy before it is killed: end() reports
      // when its buffered writes have been flushed. A short cap keeps a stuck pipe from
      // delaying the answer.
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
      reason: CodexThreadDiscoveryUnavailableReason,
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

    const request = (method: string, params: unknown): void => {
      nextId += 1;
      outstandingId = nextId;
      writeJson({ id: nextId, method, params });
    };

    const settleFinal = (): void => {
      if (settled) return;
      const [first] = matches;
      if (matches.length === 1 && first !== undefined) {
        settle({
          state: 'found',
          threadId: first.threadId,
          createdAt: first.createdAt,
          hostVersion,
        });
        return;
      }
      if (matches.length > 1) {
        settle({
          state: 'ambiguous',
          threadIds: matches.map((match) => match.threadId),
        });
        return;
      }
      settle({ state: 'not_found', examined });
    };

    const requestList = (cursor: string | null): void => {
      if (settled) return;
      if (pages >= MAX_PAGES) {
        settleFinal();
        return;
      }
      pages += 1;
      pendingMethod = 'list';
      pendingThreadId = null;
      request('thread/loaded/list', cursor === null ? {} : { cursor });
    };

    const readNext = (): void => {
      if (settled) return;
      if (examined >= MAX_THREADS) {
        settleFinal();
        return;
      }
      const threadId = queue.shift();
      if (threadId === undefined) {
        if (pageCursor !== null) {
          requestList(pageCursor);
          return;
        }
        settleFinal();
        return;
      }
      examined += 1;
      pendingMethod = 'read';
      pendingThreadId = threadId;
      request('thread/read', { threadId, includeTurns: false });
    };

    const handleThread = (result: unknown): void => {
      const requestedId = pendingThreadId;
      pendingThreadId = null;
      if (requestedId === null) {
        protocolError('thread/read answered without a request');
        return;
      }
      if (!isRecord(result) || !Object.hasOwn(result, 'thread')) {
        protocolError('thread/read returned no thread');
        return;
      }
      const thread = result['thread'];
      if (!isRecord(thread)) {
        protocolError('thread/read returned a non-object thread');
        return;
      }
      // A thread that changed identity between list and read is not the requested thread.
      if (thread['id'] !== requestedId) {
        readNext();
        return;
      }
      if (thread['cwd'] !== cwd) {
        readNext();
        return;
      }
      if (thread['preview'] !== preview) {
        readNext();
        return;
      }
      const createdAt = thread['createdAt'];
      if (
        typeof createdAt !== 'number' ||
        !Number.isFinite(createdAt) ||
        createdAt < createdAfter
      ) {
        readNext();
        return;
      }
      // The same id listed twice (or on two pages) is one thread, not an ambiguity.
      if (!matches.some((match) => match.threadId === requestedId))
        matches.push({ threadId: requestedId, createdAt });
      if (matches.length > 1) {
        settle({
          state: 'ambiguous',
          threadIds: matches.map((match) => match.threadId),
        });
        return;
      }
      readNext();
    };

    const handleList = (result: unknown): void => {
      if (!isRecord(result) || !Array.isArray(result['data'])) {
        protocolError('thread/loaded/list returned no thread ids');
        return;
      }
      const data: string[] = [];
      for (const entry of result['data']) {
        if (typeof entry !== 'string') {
          protocolError('thread/loaded/list returned a non-string thread id');
          return;
        }
        data.push(entry);
      }
      const nextCursor = result['nextCursor'];
      if (
        nextCursor !== null &&
        nextCursor !== undefined &&
        typeof nextCursor !== 'string'
      ) {
        protocolError('thread/loaded/list returned an invalid cursor');
        return;
      }
      pageCursor = typeof nextCursor === 'string' ? nextCursor : null;
      queue = data;
      readNext();
    };

    const handleInitialize = (result: unknown): void => {
      const userAgent =
        isRecord(result) && typeof result['userAgent'] === 'string'
          ? result['userAgent']
          : '';
      hostVersion = HOST_VERSION.exec(userAgent)?.[1] ?? null;
      writeJson({ method: 'initialized' });
      requestList(null);
    };

    const handleError = (
      method: PendingMethod | null,
      error: unknown,
    ): void => {
      const message =
        isRecord(error) && typeof error['message'] === 'string'
          ? error['message']
          : '';
      // An unloaded thread is a normal race: skip it instead of failing the discovery.
      if (method === 'read') {
        pendingThreadId = null;
        readNext();
        return;
      }
      unavailable(
        'protocol_error',
        message.length > 0
          ? clampDetail(message)
          : 'the app-server rejected a request',
      );
    };

    const onRecord = (record: Record<string, unknown>): void => {
      const id = record['id'];
      if (id !== undefined && outstandingId !== null && id === outstandingId) {
        outstandingId = null;
        const method = pendingMethod;
        pendingMethod = null;
        if (record['error'] !== undefined) {
          handleError(method, record['error']);
          return;
        }
        if (method === 'initialize') {
          handleInitialize(record['result']);
          return;
        }
        if (method === 'list') {
          handleList(record['result']);
          return;
        }
        if (method === 'read') {
          handleThread(record['result']);
          return;
        }
        protocolError('unexpected response while awaiting a reply');
        return;
      }
      // Discovery sends nothing that produces unsolicited notifications; ignore them.
    };

    const drainFrames = (): void => {
      for (;;) {
        if (settled) return;
        if (inbound.length < 2) return;
        const first = inbound.readUInt8(0);
        const fin = (first & 0x80) !== 0;
        const reserved = (first & 0x70) !== 0;
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
        if (masked || !fin || reserved) {
          protocolError('unexpected server WebSocket frame');
          return;
        }
        // RFC 6455: control frames carry at most 125 bytes; anything larger is a fault, and an
        // oversized ping must not be echoed.
        if (opcode >= 0x8 && length > 125) {
          protocolError('oversized WebSocket control frame');
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
      pendingMethod = 'initialize';
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
      unavailable('timeout', `no reply within ${deadlineMs}ms`);
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
