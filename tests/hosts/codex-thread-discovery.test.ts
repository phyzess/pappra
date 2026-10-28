import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  discoverCodexThread,
  type CodexThreadDiscovery,
  type CodexThreadDiscoveryOptions,
} from '../../src/hosts/codex/thread-discovery.js';
import type { ProxyChannel } from '../../src/hosts/codex/usage-observer.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CWD = '/tmp/seed-project';
const PREVIEW = 'Implement the thread discovery module.';
const MULTILINE_PREVIEW =
  'Task A: thread discovery\n\n- one source file\n- one test file';
const SEED_TIME = 1_760_000_000;
const THREAD_ID = '0199a1c4-7c2f-7c31-9e35-4f5a1c0d8e11';
const BLANK_ID = '0199a1c4-7c2f-7c31-9e35-000000000001';
const STALE_ID = '0199a1c4-7c2f-7c31-9e35-000000000002';
const OLD_ID = '0199a1c4-7c2f-7c31-9e35-000000000003';
const OTHER_CWD_ID = '0199a1c4-7c2f-7c31-9e35-000000000004';
const SECOND_MATCH_ID = '0199a1c4-7c2f-7c31-9e35-000000000005';
const BAD_ID = '0199a1c4-7c2f-7c31-9e35-000000000006';
// Long enough that the fake daemon must use the 16-bit WebSocket length form.
const USER_AGENT = `codex-tui/0.164.0 (${'x'.repeat(160)})`;

interface FakeThread {
  id: string;
  cwd: string;
  preview: string;
  createdAt: number;
}

interface FakePage {
  data: string[];
  nextCursor: string | null;
}

interface FakeBehavior {
  upgrade?:
    | 'ok'
    | 'status_400'
    | 'bad_accept'
    | 'exit_before_upgrade'
    | 'close_stdout'
    | 'spawn_error';
  /** `null` answers `initialize` without a userAgent. */
  userAgent?: string | null;
  initializeSilent?: boolean;
  pages?: FakePage[];
  threads?: FakeThread[];
  readError?: (threadId: string) => string | null;
  list?: (
    daemon: FakeDaemon,
    id: number,
    params: Record<string, unknown>,
    call: number,
  ) => void;
  read?: (
    daemon: FakeDaemon,
    id: number,
    params: Record<string, unknown>,
  ) => void;
  chunkedHandshake?: boolean;
  chunkedFrames?: boolean;
  stderrTail?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

class FakeDaemon implements ProxyChannel {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: {
    write(chunk: Buffer | string): unknown;
    end(callback?: () => void): unknown;
  };
  readonly methods: string[] = [];
  readonly messages: Record<string, unknown>[] = [];
  readonly listParams: Record<string, unknown>[] = [];
  readonly readParams: Record<string, unknown>[] = [];
  handshake = '';
  closeFrames = 0;
  killed = false;
  stdinEnded = false;
  /** What the daemon had received when it was killed: the frames must precede the kill. */
  methodsAtKill: string[] | null = null;
  /** Set to simulate a stuck pipe whose end() callback never fires. */
  stallEnd = false;
  allClientFramesMasked = true;
  serverFrameLengths: number[] = [];
  private readonly exitListeners: ((...args: unknown[]) => void)[] = [];
  private readonly errorListeners: ((...args: unknown[]) => void)[] = [];
  private readonly threads: Map<string, FakeThread>;
  private inbound = Buffer.alloc(0);
  private handshakeDone = false;
  private upgraded = false;
  private listCalls = 0;

  constructor(private readonly behavior: FakeBehavior = {}) {
    this.threads = new Map(
      (behavior.threads ?? []).map((thread) => [thread.id, thread]),
    );
    this.stdin = {
      write: (chunk) => {
        this.receive(
          typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk,
        );
        return true;
      },
      end: (callback) => {
        this.stdinEnded = true;
        if (!this.stallEnd && callback !== undefined) setImmediate(callback);
      },
    };
  }

  kill(): boolean {
    this.methodsAtKill = [...this.methods];
    this.killed = true;
    return true;
  }

  once(event: 'exit' | 'error', listener: (...args: unknown[]) => void): this {
    if (event === 'exit') this.exitListeners.push(listener);
    else this.errorListeners.push(listener);
    return this;
  }

  emitExit(): void {
    for (const listener of this.exitListeners) listener();
  }

  emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }

  sendJson(value: unknown): void {
    this.writeServerFrame(0x1, Buffer.from(JSON.stringify(value), 'utf8'));
  }

  /** A text frame with RSV1 set, as a compressed extension frame would look. */
  sendReservedBitFrame(): void {
    const payload = Buffer.from('{}', 'utf8');
    this.stdout.write(
      Buffer.concat([Buffer.from([0xc1, payload.length]), payload]),
    );
  }

  /** A ping above the 125-byte control-frame limit. */
  sendOversizePing(): void {
    const payload = Buffer.alloc(200, 0x61);
    const header = Buffer.alloc(4);
    header[0] = 0x89;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    this.stdout.write(Buffer.concat([header, payload]));
  }

  /** A declared length above 1 MiB: the client must reject the header alone. */
  sendOversizeHeader(): void {
    const header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(1024 * 1024 + 1), 2);
    this.stdout.write(header);
  }

  private writeServerFrame(opcode: number, payload: Buffer): void {
    this.serverFrameLengths.push(payload.length);
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, payload.length]);
    } else if (payload.length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const frame = Buffer.concat([header, payload]);
    if (!this.behavior.chunkedFrames) {
      this.stdout.write(frame);
      return;
    }
    // Split inside the header and inside the payload, never on a frame boundary.
    this.stdout.write(frame.subarray(0, 1));
    this.stdout.write(frame.subarray(1, 4));
    this.stdout.write(frame.subarray(4));
  }

  private receive(chunk: Buffer): void {
    this.inbound = Buffer.concat([this.inbound, chunk]);
    if (!this.handshakeDone) {
      const end = this.inbound.indexOf('\r\n\r\n');
      if (end < 0) return;
      this.handshake = this.inbound.subarray(0, end + 4).toString('latin1');
      this.inbound = this.inbound.subarray(end + 4);
      this.handshakeDone = true;
      this.respondHandshake();
      if (!this.upgraded) return;
    }
    this.drainClientFrames();
  }

  private respondHandshake(): void {
    const mode = this.behavior.upgrade ?? 'ok';
    if (this.behavior.stderrTail)
      this.stderr.write(this.behavior.stderrTail, 'utf8');
    if (mode === 'exit_before_upgrade') {
      setImmediate(() => {
        this.stdout.end();
        this.emitExit();
      });
      return;
    }
    if (mode === 'close_stdout') {
      setImmediate(() => this.stdout.end());
      return;
    }
    if (mode === 'spawn_error') {
      setImmediate(() => this.emitError(new Error('spawn codex ENOENT')));
      return;
    }
    if (mode === 'status_400') {
      this.stdout.write(
        'HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    const key =
      /^sec-websocket-key:\s*(.+)$/im.exec(this.handshake)?.[1]?.trim() ?? '';
    const accept =
      mode === 'bad_accept'
        ? 'AAAAAAAAAAAAAAAAAAAAAAAAAAA='
        : createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
    const response =
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`;
    this.upgraded = true;
    if (!this.behavior.chunkedHandshake) {
      this.stdout.write(response);
      return;
    }
    this.stdout.write(response.slice(0, 5));
    this.stdout.write(response.slice(5, Math.floor(response.length / 2)));
    this.stdout.write(response.slice(Math.floor(response.length / 2)));
  }

  private drainClientFrames(): void {
    for (;;) {
      if (this.inbound.length < 2) return;
      const opcode = this.inbound.readUInt8(0) & 0x0f;
      const second = this.inbound.readUInt8(1);
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.inbound.length < 4) return;
        length = this.inbound.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.inbound.length < 10) return;
        length = Number(this.inbound.readBigUInt64BE(2));
        offset = 10;
      }
      const maskBytes = masked ? 4 : 0;
      const total = offset + maskBytes + length;
      if (this.inbound.length < total) return;
      const payload = Buffer.from(
        this.inbound.subarray(offset + maskBytes, total),
      );
      if (masked) {
        const mask = this.inbound.subarray(offset, offset + 4);
        for (let index = 0; index < payload.length; index += 1)
          payload[index] = payload[index]! ^ mask[index % 4]!;
      }
      this.inbound = this.inbound.subarray(total);
      this.onClientFrame(opcode, payload, masked);
    }
  }

  private onClientFrame(
    opcode: number,
    payload: Buffer,
    masked: boolean,
  ): void {
    if (!masked) this.allClientFramesMasked = false;
    if (opcode === 0x8) {
      this.closeFrames += 1;
      return;
    }
    if (opcode !== 0x1) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString('utf8')) as unknown;
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    this.messages.push(parsed);
    const method =
      typeof parsed['method'] === 'string' ? parsed['method'] : null;
    if (method === null) return;
    this.methods.push(method);
    const id = parsed['id'];
    if (typeof id !== 'number') return;
    const params = isRecord(parsed['params']) ? parsed['params'] : {};
    if (method === 'initialize') {
      if (this.behavior.initializeSilent) return;
      const userAgent =
        this.behavior.userAgent === null
          ? null
          : (this.behavior.userAgent ?? USER_AGENT);
      this.sendJson({ id, result: userAgent === null ? {} : { userAgent } });
      return;
    }
    if (method === 'thread/loaded/list') {
      this.listCalls += 1;
      this.listParams.push(params);
      if (this.behavior.list) {
        this.behavior.list(this, id, params, this.listCalls);
        return;
      }
      const pages = this.behavior.pages;
      if (pages !== undefined) {
        const page = pages[this.listCalls - 1] ?? {
          data: [],
          nextCursor: null,
        };
        this.sendJson({ id, result: page });
        return;
      }
      this.sendJson({
        id,
        result: { data: [...this.threads.keys()], nextCursor: null },
      });
      return;
    }
    if (method === 'thread/read') {
      this.readParams.push(params);
      if (this.behavior.read) {
        this.behavior.read(this, id, params);
        return;
      }
      const threadId =
        typeof params['threadId'] === 'string' ? params['threadId'] : '';
      const failure = this.behavior.readError?.(threadId) ?? null;
      if (failure !== null) {
        this.sendJson({ id, error: { code: -32000, message: failure } });
        return;
      }
      const thread = this.threads.get(threadId);
      if (thread === undefined) {
        this.sendJson({
          id,
          error: { code: -32000, message: `thread not found: ${threadId}` },
        });
        return;
      }
      this.sendJson({ id, result: { thread } });
    }
  }
}

const thread = (overrides: Partial<FakeThread> = {}): FakeThread => ({
  id: THREAD_ID,
  cwd: CWD,
  preview: PREVIEW,
  createdAt: SEED_TIME + 7,
  ...overrides,
});

const discover = (
  daemon: ProxyChannel,
  overrides: Partial<CodexThreadDiscoveryOptions> = {},
) =>
  discoverCodexThread({
    cwd: CWD,
    preview: PREVIEW,
    createdAfter: SEED_TIME,
    deadlineMs: 2000,
    openProxy: () => daemon,
    ...overrides,
  });

const foundOf = (
  result: CodexThreadDiscovery,
): Extract<CodexThreadDiscovery, { state: 'found' }> => {
  if (result.state !== 'found')
    assert.fail(`expected found, got ${result.state}`);
  return result;
};

const notFoundOf = (
  result: CodexThreadDiscovery,
): Extract<CodexThreadDiscovery, { state: 'not_found' }> => {
  if (result.state !== 'not_found')
    assert.fail(`expected not_found, got ${result.state}`);
  return result;
};

const ambiguousOf = (
  result: CodexThreadDiscovery,
): Extract<CodexThreadDiscovery, { state: 'ambiguous' }> => {
  if (result.state !== 'ambiguous')
    assert.fail(`expected ambiguous, got ${result.state}`);
  return result;
};

const unavailableOf = (
  result: CodexThreadDiscovery,
): Extract<CodexThreadDiscovery, { state: 'unavailable' }> => {
  if (result.state !== 'unavailable')
    assert.fail(`expected unavailable, got ${result.state}`);
  return result;
};

const ALLOWED_METHODS = new Set([
  'initialize',
  'initialized',
  'thread/loaded/list',
  'thread/read',
]);

test('found: the single exact match among blank, stale and older threads', async () => {
  const daemon = new FakeDaemon({
    threads: [
      { ...thread(), id: BLANK_ID, preview: '', createdAt: SEED_TIME + 1 },
      { ...thread(), id: STALE_ID, preview: 'an older prompt' },
      { ...thread(), id: OLD_ID, createdAt: SEED_TIME - 1 },
      { ...thread(), id: OTHER_CWD_ID, cwd: '/tmp/other-project' },
      thread({ createdAt: SEED_TIME + 7 }),
    ],
  });
  const result = await discover(daemon);
  const found = foundOf(result);
  assert.equal(found.threadId, THREAD_ID);
  assert.equal(found.createdAt, SEED_TIME + 7);
  assert.equal(found.hostVersion, '0.164.0');
  assert.ok(daemon.methods.includes('initialize'));
  assert.ok(daemon.methods.includes('initialized'));
  for (const method of daemon.methods)
    assert.ok(
      ALLOWED_METHODS.has(method),
      `unexpected client method ${method}`,
    );
  assert.ok(daemon.allClientFramesMasked, 'every client frame is masked');
  assert.match(daemon.handshake, /^GET \/ HTTP\/1\.1\r\n/);
  assert.deepEqual(daemon.listParams, [{}]);
  for (const params of daemon.readParams)
    assert.equal(params['includeTurns'], false);
  assert.ok(daemon.killed);
  assert.ok(daemon.stdinEnded);
  assert.equal(daemon.closeFrames, 1);
  assert.ok(daemon.serverFrameLengths.some((length) => length > 125));
});

test('not_found: no thread matches and every loaded thread was examined', async () => {
  const daemon = new FakeDaemon({
    threads: [
      { ...thread(), id: BLANK_ID, preview: '' },
      { ...thread(), id: STALE_ID, preview: 'an older prompt' },
      { ...thread(), id: OLD_ID, createdAt: SEED_TIME - 1 },
    ],
  });
  const result = await discover(daemon);
  assert.equal(notFoundOf(result).examined, 3);
  assert.equal(daemon.readParams.length, 3);
});

test('ambiguous: two exact matches never pick one', async () => {
  const daemon = new FakeDaemon({
    threads: [
      thread({ id: THREAD_ID }),
      thread({ id: SECOND_MATCH_ID, createdAt: SEED_TIME + 9 }),
    ],
  });
  const result = await discover(daemon);
  assert.deepEqual(ambiguousOf(result).threadIds, [THREAD_ID, SECOND_MATCH_ID]);
  // The second match proves ambiguity; the remaining threads need no read.
  assert.equal(daemon.readParams.length, 2);
});

test('createdAfter: an otherwise matching thread from before the cutoff is excluded', async () => {
  const daemon = new FakeDaemon({
    threads: [thread({ createdAt: SEED_TIME - 1 })],
  });
  const result = await discover(daemon);
  assert.equal(notFoundOf(result).examined, 1);
});

test('createdAfter is inclusive at its boundary', async () => {
  const daemon = new FakeDaemon({
    threads: [thread({ createdAt: SEED_TIME })],
  });
  assert.equal(foundOf(await discover(daemon)).threadId, THREAD_ID);
});

test('preview must be exactly equal: trailing space, prefix and leading space do not match', async () => {
  const daemon = new FakeDaemon({
    threads: [
      { ...thread(), id: STALE_ID, preview: `${PREVIEW} ` },
      { ...thread(), id: OLD_ID, preview: `${PREVIEW} extra` },
      { ...thread(), id: BLANK_ID, preview: ` ${PREVIEW}` },
    ],
  });
  const result = await discover(daemon);
  assert.equal(notFoundOf(result).examined, 3);
});

test('cwd must be exactly equal: a trailing slash does not match', async () => {
  const daemon = new FakeDaemon({
    threads: [thread({ cwd: `${CWD}/` })],
  });
  assert.equal(notFoundOf(await discover(daemon)).examined, 1);
});

test('a multi-line preview matches including its newlines', async () => {
  const daemon = new FakeDaemon({
    threads: [
      thread({
        id: STALE_ID,
        preview: MULTILINE_PREVIEW.replaceAll('\n', '\r\n'),
      }),
      thread({ id: THREAD_ID, preview: MULTILINE_PREVIEW }),
    ],
  });
  const result = await discover(daemon, { preview: MULTILINE_PREVIEW });
  assert.equal(foundOf(result).threadId, THREAD_ID);
});

test('paging: a cursor is followed and the match on page two is found', async () => {
  const daemon = new FakeDaemon({
    threads: [
      thread({ id: STALE_ID, preview: 'an older prompt' }),
      thread({ id: THREAD_ID }),
    ],
    pages: [
      { data: [STALE_ID], nextCursor: 'cursor-1' },
      { data: [THREAD_ID], nextCursor: null },
    ],
  });
  const result = await discover(daemon);
  assert.equal(foundOf(result).threadId, THREAD_ID);
  assert.deepEqual(daemon.listParams, [{}, { cursor: 'cursor-1' }]);
  assert.equal(daemon.readParams.length, 2);
});

test('a thread/read error skips that thread instead of failing the discovery', async () => {
  const daemon = new FakeDaemon({
    threads: [thread({ id: THREAD_ID })],
    pages: [{ data: [BAD_ID, THREAD_ID], nextCursor: null }],
    readError: (threadId) =>
      threadId === BAD_ID ? 'thread not found: it was unloaded' : null,
  });
  const result = await discover(daemon);
  assert.equal(foundOf(result).threadId, THREAD_ID);
  assert.equal(daemon.readParams.length, 2);
});

test('a page whose threads all fail to read is still counted and reported as not_found', async () => {
  const daemon = new FakeDaemon({
    pages: [{ data: [BAD_ID], nextCursor: null }],
    readError: () => 'thread not found: it was unloaded',
  });
  const result = await discover(daemon);
  assert.equal(notFoundOf(result).examined, 1);
});

test('at most 200 threads are examined', async () => {
  const ids = Array.from(
    { length: 250 },
    (_, index) => `0199a1c4-7c2f-7c31-9e35-${String(index).padStart(12, '0')}`,
  );
  const beyondCap = ids[220]!;
  const daemon = new FakeDaemon({
    threads: [thread({ id: beyondCap })],
    pages: [{ data: ids, nextCursor: 'cursor-1' }],
  });
  const result = await discover(daemon);
  assert.equal(notFoundOf(result).examined, 200);
  assert.equal(daemon.readParams.length, 200);
  assert.equal(daemon.listParams.length, 1);
});

test('at most 5 pages are listed', async () => {
  const daemon = new FakeDaemon({
    list: (target, id, _params, call) =>
      target.sendJson({
        id,
        result: { data: [], nextCursor: `cursor-${call}` },
      }),
  });
  const result = await discover(daemon);
  assert.equal(notFoundOf(result).examined, 0);
  assert.equal(daemon.listParams.length, 5);
});

test('a missing userAgent leaves host_version null', async () => {
  const daemon = new FakeDaemon({
    userAgent: null,
    threads: [thread()],
  });
  assert.equal(foundOf(await discover(daemon)).hostVersion, null);
});

test('a thread/read result for a different thread id is skipped', async () => {
  const daemon = new FakeDaemon({
    pages: [{ data: [THREAD_ID], nextCursor: null }],
    read: (target, id) =>
      target.sendJson({
        id,
        result: { thread: { ...thread(), id: 'someone-else' } },
      }),
  });
  assert.equal(notFoundOf(await discover(daemon)).examined, 1);
});

test('a proxy that exits before the upgrade is daemon_unreachable', async () => {
  const daemon = new FakeDaemon({
    upgrade: 'exit_before_upgrade',
    stderrTail: 'daemon control socket missing',
  });
  const result = await discover(daemon);
  const unavailable = unavailableOf(result);
  assert.equal(unavailable.reason, 'daemon_unreachable');
  assert.equal(unavailable.detail, 'daemon control socket missing');
  assert.ok(daemon.killed);
});

test('stdout closing before the upgrade is daemon_unreachable', async () => {
  const daemon = new FakeDaemon({ upgrade: 'close_stdout' });
  assert.equal(
    unavailableOf(await discover(daemon)).reason,
    'daemon_unreachable',
  );
});

test('a spawn error is daemon_unreachable', async () => {
  const daemon = new FakeDaemon({ upgrade: 'spawn_error' });
  const result = await discover(daemon);
  assert.equal(unavailableOf(result).reason, 'daemon_unreachable');
  assert.match(unavailableOf(result).detail ?? '', /spawn codex ENOENT/);
});

test('a non-101 status line is a protocol_error', async () => {
  const daemon = new FakeDaemon({ upgrade: 'status_400' });
  const result = await discover(daemon);
  assert.equal(unavailableOf(result).reason, 'protocol_error');
  assert.match(unavailableOf(result).detail ?? '', /400/);
  assert.ok(daemon.killed);
});

test('a wrong Sec-WebSocket-Accept is a protocol_error', async () => {
  const daemon = new FakeDaemon({ upgrade: 'bad_accept' });
  assert.equal(unavailableOf(await discover(daemon)).reason, 'protocol_error');
});

test('an oversize frame is a protocol_error and kills the proxy', async () => {
  const daemon = new FakeDaemon({
    list: (target) => {
      // The oversized header arrives before any answer: reject it first.
      target.sendOversizeHeader();
    },
  });
  const result = await discover(daemon);
  assert.equal(unavailableOf(result).reason, 'protocol_error');
  assert.ok(daemon.killed);
});

test('a silent initialize is a timeout, and the proxy is still killed', async () => {
  const daemon = new FakeDaemon({ initializeSilent: true });
  const started = Date.now();
  const result = await discover(daemon, { deadlineMs: 500 });
  assert.equal(unavailableOf(result).reason, 'timeout');
  assert.ok(Date.now() - started >= 500);
  assert.ok(daemon.killed);
  assert.ok(daemon.stdinEnded);
});

test('a thread that is never answered is a timeout', async () => {
  const daemon = new FakeDaemon({
    pages: [{ data: [BAD_ID], nextCursor: null }],
    read: () => {
      // The daemon stays silent: the overall deadline must answer.
    },
  });
  const result = await discover(daemon, { deadlineMs: 500 });
  assert.equal(unavailableOf(result).reason, 'timeout');
});

test('invalid arguments throw without opening a proxy', async () => {
  let opened = false;
  const failProxy = () => {
    opened = true;
    throw new Error('must not open');
  };
  const base = {
    cwd: CWD,
    preview: PREVIEW,
    createdAfter: SEED_TIME,
    openProxy: failProxy,
  };
  await assert.rejects(discoverCodexThread({ ...base, cwd: '' }), /cwd/);
  await assert.rejects(
    discoverCodexThread({ ...base, preview: '' }),
    /preview/,
  );
  for (const createdAfter of [Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      discoverCodexThread({ ...base, createdAfter }),
      /createdAfter/,
    );
  }
  for (const deadlineMs of [499, 30_001, 500.5, Number.NaN]) {
    await assert.rejects(
      discoverCodexThread({ ...base, deadlineMs }),
      /deadlineMs/,
    );
  }
  assert.equal(opened, false);
});

test('a settled discovery clears its deadline timer', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const pending = new Set<ReturnType<typeof setTimeout>>();
  const deadline = 4321;
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    const handle = originalSetTimeout(callback, delay, ...args);
    if (delay === deadline) pending.add(handle);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    pending.delete(handle);
    originalClearTimeout(handle);
  }) as typeof clearTimeout;
  try {
    const daemon = new FakeDaemon({ threads: [thread()] });
    assert.equal(
      foundOf(await discover(daemon, { deadlineMs: deadline })).threadId,
      THREAD_ID,
    );
    assert.equal(pending.size, 0, 'the overall deadline timer was cleared');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('late frames and an exit after settling change nothing', async () => {
  const daemon = new FakeDaemon({ threads: [thread()] });
  const result = await discover(daemon);
  assert.equal(foundOf(result).threadId, THREAD_ID);
  const framesAfterSettle = daemon.messages.length;
  daemon.sendJson({ id: 999, result: { data: [THREAD_ID], nextCursor: null } });
  daemon.emitExit();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(daemon.messages.length, framesAfterSettle);
  assert.equal(foundOf(result).threadId, THREAD_ID);
});

test('a stuck stdin cannot delay the answer beyond the flush cap', async () => {
  const daemon = new FakeDaemon({ threads: [thread()] });
  daemon.stallEnd = true;
  const started = Date.now();
  const result = await discover(daemon);
  assert.equal(foundOf(result).threadId, THREAD_ID);
  assert.ok(Date.now() - started < 1500);
  assert.ok(daemon.killed);
});

test('a frame with reserved bits set is a protocol_error, not misparsed', async () => {
  const daemon = new FakeDaemon({
    list: (target) => target.sendReservedBitFrame(),
  });
  const result = await discover(daemon);
  assert.equal(unavailableOf(result).reason, 'protocol_error');
  assert.ok(daemon.killed);
});

test('an oversized ping is a protocol_error and is never echoed back', async () => {
  const daemon = new FakeDaemon({
    list: (target) => target.sendOversizePing(),
  });
  const result = await discover(daemon);
  assert.equal(unavailableOf(result).reason, 'protocol_error');
  assert.match(unavailableOf(result).detail ?? '', /control frame/);
  assert.ok(daemon.killed);
});

test('the same thread id listed twice is one match, not an ambiguity', async () => {
  const daemon = new FakeDaemon({
    threads: [thread()],
    pages: [{ data: [THREAD_ID, THREAD_ID], nextCursor: null }],
  });
  const found = foundOf(await discover(daemon));
  assert.equal(found.threadId, THREAD_ID);
});
