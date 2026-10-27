import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  observeCodexUsage,
  type CodexUsageResult,
  type ProxyChannel,
} from '../../src/hosts/codex/usage-observer.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const THREAD_ID = '0199a1c4-7c2f-7c31-9e35-4f5a1c0d8e11';
const OTHER_THREAD_ID = '0199a1c4-7c2f-7c31-9e35-000000000000';
// Long enough that the fake daemon must use the 16-bit WebSocket length form.
const USER_AGENT = `codex-tui/0.164.0 (${'x'.repeat(160)})`;
const USAGE = {
  total: { totalTokens: 900_000 },
  last: { totalTokens: 45_734 },
  modelContextWindow: 200_000,
};

interface FakeBehavior {
  upgrade?:
    | 'ok'
    | 'status_400'
    | 'bad_accept'
    | 'exit_before_upgrade'
    | 'close_stdout'
    | 'spawn_error';
  chunkedHandshake?: boolean;
  chunkedFrames?: boolean;
  stderrTail?: string;
  initialize?: (daemon: FakeDaemon, id: number) => void;
  resume?: (daemon: FakeDaemon, id: number, threadId: string) => void;
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
  /** What the daemon had received when it was killed: the frames must precede the kill. */
  methodsAtKill: string[] | null = null;
  /** Set to simulate a stuck pipe whose end() callback never fires. */
  stallEnd = false;
  readonly methods: string[] = [];
  readonly messages: Record<string, unknown>[] = [];
  readonly pongs: { payload: string; masked: boolean }[] = [];
  handshake = '';
  closeFrames = 0;
  killed = false;
  stdinEnded = false;
  allClientFramesMasked = true;
  serverFrameLengths: number[] = [];
  private readonly exitListeners: ((...args: unknown[]) => void)[] = [];
  private readonly errorListeners: ((...args: unknown[]) => void)[] = [];
  private inbound = Buffer.alloc(0);
  private handshakeDone = false;
  private upgraded = false;

  constructor(private readonly behavior: FakeBehavior = {}) {
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

  notify(method: string, params: unknown): void {
    this.sendJson({ method, params });
  }

  sendPing(payload: string): void {
    this.writeServerFrame(0x9, Buffer.from(payload));
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
    if (opcode === 0xa) {
      this.pongs.push({ payload: payload.toString('utf8'), masked });
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
    const threadId =
      typeof params['threadId'] === 'string' ? params['threadId'] : '';
    if (method === 'initialize') {
      if (this.behavior.initialize) this.behavior.initialize(this, id);
      else this.sendJson({ id, result: { userAgent: USER_AGENT } });
    }
    if (method === 'thread/resume') {
      if (this.behavior.resume) this.behavior.resume(this, id, threadId);
      else resumeWithUsage()(this, id, threadId);
    }
  }
}

const resumeWithUsage =
  (usageThreadId?: string) =>
  (daemon: FakeDaemon, id: number, threadId: string): void => {
    daemon.sendJson({ id, result: { thread: { id: threadId } } });
    daemon.notify(
      'thread/tokenUsage/updated',
      usageThreadId === undefined
        ? { tokenUsage: USAGE }
        : { threadId: usageThreadId, tokenUsage: USAGE },
    );
  };

const resumeError =
  (message: string) =>
  (daemon: FakeDaemon, id: number): void => {
    daemon.sendJson({ id, error: { code: -32000, message } });
  };

const reasonOf = (result: CodexUsageResult): string =>
  result.state === 'unavailable'
    ? result.reason
    : assert.fail('expected an unavailable result');

const detailOf = (result: CodexUsageResult): string | null =>
  result.state === 'unavailable'
    ? result.detail
    : assert.fail('expected an unavailable result');

const observe = (daemon: FakeDaemon, deadlineMs = 2000) =>
  observeCodexUsage({
    threadId: THREAD_ID,
    deadlineMs,
    openProxy: () => daemon,
  });

test('success: the replayed usage becomes an available observation', async () => {
  const daemon = new FakeDaemon();
  const result = await observe(daemon);
  if (result.state !== 'available')
    assert.fail(`expected available, got ${result.reason}`);
  assert.equal(result.observation.host, 'codex');
  assert.equal(result.observation.session_id, THREAD_ID);
  assert.equal(result.observation.used_percent, 22.9);
  assert.equal(result.observation.used_tokens, 45_734);
  assert.equal(result.observation.window_tokens, 200_000);
  assert.equal(result.observation.host_version, '0.164.0');
  assert.equal(result.observation.source, 'codex-app-server');
  assert.ok(
    daemon.serverFrameLengths.some((length) => length > 125),
    'the fake daemon exercised the 16-bit length form',
  );
  assert.ok(daemon.methods.includes('thread/unsubscribe'));
  assert.ok(daemon.killed);
  assert.ok(daemon.stdinEnded);
  assert.equal(daemon.closeFrames, 1);
  const allowed = new Set([
    'initialize',
    'initialized',
    'thread/resume',
    'thread/unsubscribe',
  ]);
  for (const method of daemon.methods)
    assert.ok(allowed.has(method), `unexpected client method ${method}`);
  assert.ok(daemon.allClientFramesMasked, 'every client frame is masked');
  assert.match(daemon.handshake, /^GET \/ HTTP\/1\.1\r\n/);
  assert.match(daemon.handshake, /Sec-WebSocket-Key: .+/);
});

test('usage for a different thread is ignored and the matching one wins', async () => {
  const daemon = new FakeDaemon({
    resume: (target, id, threadId) => {
      target.sendJson({ id, result: { thread: { id: threadId } } });
      target.notify('thread/tokenUsage/updated', {
        threadId: OTHER_THREAD_ID,
        tokenUsage: { ...USAGE, last: { totalTokens: 199_000 } },
      });
      target.notify('thread/tokenUsage/updated', {
        threadId,
        tokenUsage: USAGE,
      });
    },
  });
  const result = await observe(daemon);
  if (result.state !== 'available') assert.fail(result.reason);
  assert.equal(result.observation.session_id, THREAD_ID);
  assert.equal(result.observation.used_tokens, 45_734);
});

test('a usage notification without a thread id is accepted', async () => {
  const result = await observe(
    new FakeDaemon({ resume: resumeWithUsage(undefined) }),
  );
  if (result.state !== 'available') assert.fail(result.reason);
  assert.equal(result.observation.used_tokens, 45_734);
});

test('a missing userAgent leaves host_version null', async () => {
  const daemon = new FakeDaemon({
    initialize: (target, id) => target.sendJson({ id, result: {} }),
    resume: resumeWithUsage(),
  });
  const result = await observe(daemon);
  if (result.state !== 'available') assert.fail(result.reason);
  assert.equal(result.observation.host_version, null);
});

test('a thread with no rollout yet is reported as no_rollout_yet', async () => {
  const daemon = new FakeDaemon({
    resume: resumeError(`no rollout found for thread id ${THREAD_ID}`),
  });
  const result = await observe(daemon);
  assert.equal(reasonOf(result), 'no_rollout_yet');
  assert.match(detailOf(result) ?? '', /no rollout found/);
});

test('an unknown thread is reported as thread_not_found', async () => {
  const daemon = new FakeDaemon({
    resume: resumeError(`thread not found: ${THREAD_ID}`),
  });
  const result = await observe(daemon);
  assert.equal(reasonOf(result), 'thread_not_found');
});

test('the proxy is killed only after the unsubscribe and close frames were written', async () => {
  const daemon = new FakeDaemon();
  const result = await observe(daemon);
  assert.equal(result.state, 'available');
  assert.ok(daemon.methodsAtKill?.includes('thread/unsubscribe'));
  assert.equal(daemon.closeFrames, 1);
});

test('a stuck stdin cannot delay the answer beyond the flush cap, and the proxy is still killed', async () => {
  const daemon = new FakeDaemon();
  daemon.stallEnd = true;
  const started = Date.now();
  const result = await observe(daemon);
  assert.equal(result.state, 'available');
  assert.ok(Date.now() - started < 1500);
  assert.ok(daemon.killed);
});

test('a resume that answers for a different thread is a protocol_error', async () => {
  const daemon = new FakeDaemon({
    resume: (target, id) =>
      target.sendJson({ id, result: { thread: { id: 'some-other-thread' } } }),
  });
  const result = await observe(daemon);
  assert.equal(reasonOf(result), 'protocol_error');
  assert.match(detailOf(result) ?? '', /different thread/);
});

test('a malformed id is rejected by the real server as "invalid session id" and maps to thread_not_found', async () => {
  // Message text observed against Codex 0.164.0.
  const daemon = new FakeDaemon({
    resume: resumeError(
      'invalid session id: invalid character: expected an optional prefix of `urn:uuid:` followed by [0-9a-fA-F-], found `t` at 1',
    ),
  });
  const result = await observe(daemon);
  assert.equal(reasonOf(result), 'thread_not_found');
});

test('any other resume error is a protocol_error with its message', async () => {
  const daemon = new FakeDaemon({
    resume: resumeError('internal error: kaboom'),
  });
  const result = await observe(daemon);
  assert.equal(reasonOf(result), 'protocol_error');
  assert.equal(detailOf(result), 'internal error: kaboom');
});

test('protocol_error detail is truncated to 200 characters', async () => {
  const daemon = new FakeDaemon({ resume: resumeError('x'.repeat(500)) });
  const result = await observe(daemon);
  assert.equal(reasonOf(result), 'protocol_error');
  assert.equal(detailOf(result)?.length, 200);
});

test('a resume without a replayed usage is no_usage_replayed', async () => {
  const daemon = new FakeDaemon({
    resume: (target, id, threadId) => {
      target.sendJson({ id, result: { thread: { id: threadId } } });
    },
  });
  const result = await observe(daemon, 300);
  assert.equal(reasonOf(result), 'no_usage_replayed');
});

test('a silent initialize is a timeout', async () => {
  const daemon = new FakeDaemon({ initialize: () => {} });
  const result = await observe(daemon, 250);
  assert.equal(reasonOf(result), 'timeout');
});

test('a proxy that exits before the upgrade is daemon_unreachable', async () => {
  const daemon = new FakeDaemon({
    upgrade: 'exit_before_upgrade',
    stderrTail: 'daemon control socket missing',
  });
  const result = await observe(daemon);
  assert.equal(reasonOf(result), 'daemon_unreachable');
  assert.equal(detailOf(result), 'daemon control socket missing');
  assert.ok(daemon.killed);
});

test('stdout closing before the upgrade is daemon_unreachable', async () => {
  const daemon = new FakeDaemon({ upgrade: 'close_stdout' });
  const result = await observe(daemon);
  assert.equal(reasonOf(result), 'daemon_unreachable');
});

test('a spawn error is daemon_unreachable', async () => {
  const daemon = new FakeDaemon({ upgrade: 'spawn_error' });
  const result = await observe(daemon);
  assert.equal(reasonOf(result), 'daemon_unreachable');
  assert.match(detailOf(result) ?? '', /spawn codex ENOENT/);
});

test('a non-101 status line is a protocol_error', async () => {
  const daemon = new FakeDaemon({ upgrade: 'status_400' });
  const result = await observe(daemon);
  assert.equal(reasonOf(result), 'protocol_error');
  assert.match(detailOf(result) ?? '', /400/);
});

test('a wrong Sec-WebSocket-Accept is a protocol_error', async () => {
  const daemon = new FakeDaemon({ upgrade: 'bad_accept' });
  const result = await observe(daemon);
  assert.equal(reasonOf(result), 'protocol_error');
});

test('handshake and frames split across chunks are reassembled', async () => {
  const daemon = new FakeDaemon({
    chunkedHandshake: true,
    chunkedFrames: true,
  });
  const result = await observe(daemon);
  if (result.state !== 'available') assert.fail(result.reason);
  assert.equal(result.observation.used_tokens, 45_734);
});

test('an oversize frame is a protocol_error and kills the proxy', async () => {
  const daemon = new FakeDaemon({
    initialize: (target) => target.sendOversizeHeader(),
  });
  const result = await observe(daemon);
  assert.equal(reasonOf(result), 'protocol_error');
  assert.ok(daemon.killed);
});

test('a server ping is answered with a masked pong', async () => {
  const daemon = new FakeDaemon({
    initialize: (target, id) => {
      target.sendPing('keepalive');
      target.sendJson({ id, result: { userAgent: USER_AGENT } });
    },
  });
  const result = await observe(daemon);
  if (result.state !== 'available') assert.fail(result.reason);
  assert.deepEqual(daemon.pongs, [{ payload: 'keepalive', masked: true }]);
});

test('an invalid thread id is refused without opening a proxy', async () => {
  let opened = false;
  const result = await observeCodexUsage({
    threadId: 'not a thread id',
    openProxy: () => {
      opened = true;
      throw new Error('must not open');
    },
  });
  assert.equal(reasonOf(result), 'thread_not_found');
  assert.ok(detailOf(result));
  assert.equal(opened, false);
});

test('an out-of-range deadline rejects', async () => {
  for (const deadlineMs of [199, 30_001, 200.5, Number.NaN]) {
    await assert.rejects(
      observeCodexUsage({
        threadId: THREAD_ID,
        deadlineMs,
        openProxy: () => {
          throw new Error('must not open');
        },
      }),
      /deadlineMs/,
    );
  }
});

test('late frames and an exit after settling change nothing', async () => {
  const daemon = new FakeDaemon();
  const result = await observe(daemon);
  if (result.state !== 'available') assert.fail(result.reason);
  const framesAfterSettle = daemon.messages.length;
  daemon.notify('thread/tokenUsage/updated', {
    threadId: THREAD_ID,
    tokenUsage: { ...USAGE, last: { totalTokens: 1 } },
  });
  daemon.sendJson({ id: 999, result: {} });
  daemon.emitExit();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(result.observation.used_tokens, 45_734);
  assert.equal(daemon.messages.length, framesAfterSettle);
});

test('a settled observation clears its deadline timer', async () => {
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
    const result = await observe(new FakeDaemon(), deadline);
    if (result.state !== 'available') assert.fail(result.reason);
    assert.equal(pending.size, 0, 'the overall deadline timer was cleared');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
