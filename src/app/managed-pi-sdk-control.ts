import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ManagedPiSdkSessionController } from '../hosts/pi/managed-sdk-session.js';

/** Private local endpoint for a runtime created by this process. Never adopts a PID. */
export async function serveManagedPiSdkControl(
  controller: ManagedPiSdkSessionController,
  journalPath: string,
  requestedSocket?: string,
  automationStatus: () => unknown = () => null,
  deliver?: (
    request: Readonly<Record<string, unknown>>,
  ) => Promise<Readonly<Record<string, unknown>>>,
) {
  const directory = path.dirname(journalPath);
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    fs.realpathSync(directory) !== directory ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid())
  )
    throw new Error('sdk_control_directory_not_private');
  const descriptorPath = `${journalPath}.control.json`;
  if (fs.lstatSync(descriptorPath, { throwIfNoEntry: false }))
    throw new Error('sdk_control_path_unavailable');
  // macOS's per-user temp root and task paths can exceed sockaddr_un limits.
  const socketDirectory = requestedSocket
    ? null
    : fs.mkdtempSync(
        path.join(
          process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(),
          'pi-ctl-',
        ),
      );
  const socketPath = requestedSocket ?? path.join(socketDirectory!, 'c.sock');
  if (
    !path.isAbsolute(socketPath) ||
    Buffer.byteLength(socketPath) > 100 ||
    fs.existsSync(socketPath) ||
    fs.existsSync(descriptorPath)
  )
    throw new Error('sdk_control_path_unavailable');
  const token = randomBytes(32).toString('hex');
  const runId = randomBytes(16).toString('hex');
  const peers = new Set<net.Socket>();
  let busy = false;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  const server = net.createServer((socket) => {
    peers.add(socket);
    socket.once('close', () => peers.delete(socket));
    socket.setTimeout(75_000, () => socket.destroy());
    const chunks: Buffer[] = [];
    let requestBytes = 0;
    let handled = false;
    const send = (result: unknown) => socket.end(`${JSON.stringify(result)}\n`);
    socket.on('data', (chunk) => {
      if (handled) return;
      requestBytes += chunk.length;
      if (requestBytes > 8192) {
        handled = true;
        send({ ok: false, reason: 'request_too_large' });
        return;
      }
      chunks.push(chunk);
      if (!chunk.includes(0x0a)) return;
      const data = Buffer.concat(chunks).toString('utf8');
      const newline = data.indexOf('\n');
      handled = true;
      void (async () => {
        try {
          const request = JSON.parse(data.slice(0, newline));
          const provided = Buffer.from(
            typeof request?.token === 'string' ? request.token : '',
          );
          const expected = Buffer.from(token);
          if (
            provided.length !== expected.length ||
            !timingSafeEqual(provided, expected)
          ) {
            send({ ok: false, reason: 'unauthorized' });
            return;
          }
          if (request.command === 'snapshot') {
            send({
              ok: true,
              snapshot: controller.snapshot(),
              automation: automationStatus(),
            });
            return;
          }
          if (request.command === 'deliver') {
            if (!deliver)
              send({ ok: false, reason: 'delivery_not_configured' });
            else send(await deliver(request));
            return;
          }
          if (busy) {
            send({ ok: false, reason: 'operation_in_progress' });
            return;
          }
          if (!['fence', 'stop'].includes(request.command)) {
            send({ ok: false, reason: 'unsupported_command' });
            return;
          }
          busy = true;
          try {
            if (request.command === 'fence')
              send({
                ok: true,
                snapshot: await controller.quiesce(
                  'authenticated_control_request',
                ),
              });
            else {
              const exit = await controller.stopOwnedRuntime();
              send({ ok: true, exit });
              // Resolve after the response has entered the socket, before CLI cleanup.
              socket.once('close', resolveStopped);
            }
          } finally {
            busy = false;
          }
        } catch {
          send({ ok: false, reason: 'control_operation_failed' });
        }
      })();
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  fs.chmodSync(socketPath, 0o600);
  const socketIdentity = fs.lstatSync(socketPath);
  try {
    const fd = fs.openSync(descriptorPath, 'wx', 0o600);
    try {
      fs.writeFileSync(
        fd,
        `${JSON.stringify({
          schema: 'harness-collab/pi-managed-control/1',
          socketPath,
          token,
          runId,
          sessionId: controller.observe().native.sessionId,
        })}\n`,
      );
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    runId,
    stopped,
    close() {
      for (const peer of peers) peer.destroy();
      server.close();
      const current = fs.lstatSync(socketPath, { throwIfNoEntry: false });
      if (
        current?.isSocket() &&
        current.dev === socketIdentity.dev &&
        current.ino === socketIdentity.ino
      )
        fs.unlinkSync(socketPath);
      if (socketDirectory) {
        try {
          fs.rmdirSync(socketDirectory);
        } catch {
          /* preserve unexpected contents */
        }
      }
    },
  };
}
