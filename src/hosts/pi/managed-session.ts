import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import fs from 'node:fs';
import net, { type Server, type Socket } from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

export const MANAGED_PI_SESSION_SCHEMA =
  'harness-collab/pi-managed-session/1' as const;
const CONTROL_SCHEMA = 'harness-collab/pi-managed-control/1' as const;
const METADATA_ENV = 'PAPPRA_MANAGED_PI_METADATA_FILE';
const START_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
const KILL_GRACE_MS = 2_000;
const MAX_CONTROL_BYTES = 8 * 1024;
// Native queue inventories may contain admitted input. Keep responses bounded
// independently from the much smaller authenticated command envelope.
const MAX_CONTROL_RESPONSE_BYTES = 1024 * 1024;
const MAX_SOCKET_PATH_BYTES = 100;

/** Launch a fresh interactive TUI using normal Pi configuration and an explicit OpenRouter model. */
export interface ManagedPiSessionOptions {
  readonly cwd: string;
  readonly model: string;
  readonly journalPath: string;
  readonly controlSocketPath?: string;
  readonly piBin?: string;
  readonly pythonBin?: string;
  readonly shutdownGraceMs?: number;
}

export interface ManagedPiProcessIdentity {
  readonly runId: string;
  readonly helperPid: number;
  readonly piPid: number;
  readonly sessionId: string;
}

export interface ManagedPiControlEndpoint {
  readonly socketPath: string;
  readonly descriptorPath: string;
}

export interface ManagedPiSessionExit {
  readonly status: 'exited' | 'unknown';
  readonly piPid: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly helperExitCode: number | null;
  readonly helperSignal: string | null;
  readonly reason: string | null;
}

export interface ManagedPiTranscriptObservation {
  readonly status: 'verified' | 'not_observed' | 'mismatch' | 'unreadable';
  readonly path: string | null;
  readonly sessionId: string | null;
  readonly cwd: string | null;
  readonly sha256: string | null;
  readonly bytes: number | null;
  readonly detail: string | null;
}

export interface ManagedPiSessionSnapshot {
  readonly schema: typeof MANAGED_PI_SESSION_SCHEMA;
  readonly runId: string;
  readonly provider: 'openrouter';
  readonly model: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly process: ManagedPiProcessIdentity;
  readonly processExit: ManagedPiSessionExit | null;
  readonly readiness: {
    readonly ownedPiChild: 'started';
    readonly extensionSessionStart: 'observed';
    readonly terminalUiRender: 'not_observed';
  };
  readonly ingress: {
    readonly state: 'open' | 'fenced';
    readonly journalPath: string;
    readonly sequence: number;
    readonly headDigest: string;
    readonly healthy: boolean;
    readonly rawTerminalInputJournaled: true;
  };
  readonly transcript: ManagedPiTranscriptObservation;
  readonly nativeInventory: {
    readonly queuedMessages: 'unknown';
    readonly approvals: 'unknown';
    readonly inFlightWork: 'unknown';
    readonly externalWriters: 'unknown';
    readonly descendants: 'uncontrolled';
  };
  readonly transferReady: false;
  readonly blockers: readonly string[];
}

export interface ManagedPiReceiverConfirmation {
  readonly receiverSessionId: string;
  readonly confirmationId: string;
  readonly confirmedAt: string;
}

export interface ManagedPiFirstWorkObservation {
  readonly receiverSessionId: string;
  readonly workId: string;
  readonly observedAt: string;
}

export type ManagedPiArchiveResult =
  | {
      readonly ok: true;
      readonly archivePath: string;
      readonly sha256: string;
      readonly bytes: number;
    }
  | { readonly ok: false; readonly reason: string };

export interface ManagedPiSession {
  readonly identity: ManagedPiProcessIdentity;
  readonly journalPath: string;
  readonly controlEndpoint: ManagedPiControlEndpoint;
  waitForExit(): Promise<ManagedPiSessionExit>;
  snapshot(): ManagedPiSessionSnapshot;
  fenceIngress(reason?: string): void;
  stopOwnedChild(): Promise<ManagedPiSessionExit>;
  archiveOriginalTranscript(input: {
    readonly destinationPath: string;
    readonly receiverConfirmation: ManagedPiReceiverConfirmation;
    readonly firstWork: ManagedPiFirstWorkObservation;
  }): ManagedPiArchiveResult;
  close(): void;
}

export class ManagedPiSessionError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = 'ManagedPiSessionError';
  }
}

interface JournalRecord {
  readonly schema: typeof MANAGED_PI_SESSION_SCHEMA;
  readonly run_id: string;
  readonly sequence: number;
  readonly at: string;
  readonly kind: string;
  readonly previous_digest: string;
  readonly digest: string;
  readonly [key: string]: unknown;
}

/** Fsync-backed, hash-chained journal. */
export class ManagedPiJournal {
  private sequence = 0;
  private headDigest = '0'.repeat(64);
  private failure: string | null = null;
  private isClosed = false;
  private isFenced = false;

  constructor(
    readonly path: string,
    private readonly fd: number,
    private readonly runId: string,
  ) {}

  get healthy() {
    return this.failure === null && !this.isClosed;
  }
  get fenced() {
    return this.isFenced;
  }
  get currentSequence() {
    return this.sequence;
  }
  get currentDigest() {
    return this.headDigest;
  }

  append(kind: string, fields: Record<string, unknown> = {}): JournalRecord {
    if (!this.healthy)
      throw new ManagedPiSessionError(
        'journal_unavailable',
        this.failure ?? 'journal_closed',
      );
    const body = {
      schema: MANAGED_PI_SESSION_SCHEMA,
      run_id: this.runId,
      sequence: this.sequence + 1,
      at: new Date().toISOString(),
      kind,
      previous_digest: this.headDigest,
      ...fields,
    };
    const digest = createHash('sha256')
      .update(JSON.stringify(body))
      .digest('hex');
    const record = { ...body, digest };
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    try {
      writeAll(this.fd, bytes);
      fs.fsyncSync(this.fd);
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
      this.isFenced = true;
      throw new ManagedPiSessionError('journal_write_failed', this.failure);
    }
    this.sequence += 1;
    this.headDigest = digest;
    return record;
  }

  fence(reason: string) {
    if (this.isFenced) return;
    this.isFenced = true;
    try {
      this.append('ingress_fenced', { reason });
    } catch {
      /* fail closed in memory */
    }
  }

  close() {
    if (this.isClosed) return;
    this.isClosed = true;
    fs.closeSync(this.fd);
  }
}

/** Write-ahead helper: no ingress reaches Pi unless its complete bytes were fsynced first. */
export function forwardJournaledManagedInput(
  journal: ManagedPiJournal,
  chunk: Uint8Array,
  forward: (bytes: Uint8Array) => void,
): boolean {
  if (journal.fenced) return false;
  try {
    journal.append('terminal_input', {
      encoding: 'base64',
      bytes: Buffer.from(chunk).toString('base64'),
      byte_length: chunk.byteLength,
    });
  } catch {
    journal.fence('journal_write_failed');
    return false;
  }
  try {
    forward(chunk);
    return true;
  } catch {
    journal.fence('terminal_forward_failed');
    return false;
  }
}

export function buildManagedPiArgv(input: {
  readonly model: string;
  readonly sessionId: string;
  readonly extensionPath: string;
}): string[] {
  if (!input.model.trim()) throw new ManagedPiSessionError('model_required');
  if (!path.isAbsolute(input.extensionPath))
    throw new ManagedPiSessionError('extension_path_must_be_absolute');
  return [
    '--provider',
    'openrouter',
    '--model',
    input.model,
    '--session-id',
    input.sessionId,
    '--extension',
    input.extensionPath,
  ];
}

interface ProcessEventIdentity {
  readonly runId: string;
  readonly helperPid: number;
  readonly piPid: number;
}

interface PiExitEvent extends ProcessEventIdentity {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

/** Exit receipts from the bridge count only when all child identity fields match. */
export function isOwnedManagedPiExit(
  event: PiExitEvent,
  identity: ProcessEventIdentity,
): boolean {
  return (
    event.runId === identity.runId &&
    event.helperPid === identity.helperPid &&
    event.piPid === identity.piPid
  );
}

interface TranscriptFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
}

interface ControlDescriptor {
  readonly schema: typeof CONTROL_SCHEMA;
  readonly socketPath: string;
  readonly token: string;
  readonly runId: string;
  readonly sessionId: string;
}

const PTY_BRIDGE_SOURCE = String.raw`import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios

run_id = sys.argv[1]
pi_argv = sys.argv[2:]
if not pi_argv:
    os.write(2, b"managed Pi bridge: missing executable\n")
    sys.exit(64)
for fd in (3, 4):
    try:
        os.set_inheritable(fd, False)
    except OSError:
        pass

def write_all(fd, data):
    view = memoryview(data)
    while view:
        count = os.write(fd, view)
        view = view[count:]

def report(value):
    try:
        write_all(3, (json.dumps(value, separators=(",", ":")) + "\n").encode())
    except OSError:
        pass

def signal_owned(pid, name):
    sig = {"TERM": signal.SIGTERM, "KILL": signal.SIGKILL}.get(name)
    if sig is not None:
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass

try:
    pi_pid, master_fd = pty.fork()
except OSError as error:
    os.write(2, ("managed Pi bridge: pty.fork failed: " + str(error) + "\n").encode())
    sys.exit(70)
if pi_pid == 0:
    try:
        os.execvpe(pi_argv[0], pi_argv, os.environ)
    except BaseException as error:
        os.write(2, ("managed Pi bridge: exec failed: " + str(error) + "\n").encode())
        os._exit(127)

identity = {"runId": run_id, "helperPid": os.getpid(), "piPid": pi_pid}
report({"kind": "pi_started", **identity})
try:
    rows = max(1, int(os.environ.get("PAPPRA_MANAGED_PI_ROWS", "24")))
    columns = max(1, int(os.environ.get("PAPPRA_MANAGED_PI_COLUMNS", "80")))
    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
except (OSError, ValueError):
    pass

control_buffer = b""
control_open = True
stdin_open = True
output_open = True
reaped = False
status = 0
while True:
    read_fds = [master_fd]
    if control_open:
        read_fds.append(4)
    if stdin_open:
        read_fds.append(0)
    try:
        ready, _, _ = select.select(read_fds, [], [], 0.05)
    except InterruptedError:
        ready = []
    if master_fd in ready and output_open:
        try:
            data = os.read(master_fd, 65536)
            if data:
                try:
                    write_all(1, data)
                except OSError:
                    output_open = False
                    signal_owned(pi_pid, "TERM")
        except OSError as error:
            if error.errno not in (errno.EIO, errno.EBADF):
                os.write(2, ("managed Pi bridge: PTY read failed: " + str(error) + "\n").encode())
            output_open = False
    if 0 in ready and stdin_open:
        try:
            data = os.read(0, 65536)
            if not data:
                stdin_open = False
            else:
                view = memoryview(data)
                while view:
                    try:
                        count = os.write(master_fd, view)
                        view = view[count:]
                    except OSError:
                        stdin_open = False
                        break
        except OSError:
            stdin_open = False
    if 4 in ready and control_open:
        try:
            chunk = os.read(4, 4096)
        except OSError:
            chunk = b""
        if not chunk:
            control_open = False
            signal_owned(pi_pid, "TERM")
        else:
            control_buffer += chunk
            while b"\n" in control_buffer:
                line, control_buffer = control_buffer.split(b"\n", 1)
                try:
                    command = json.loads(line.decode())
                    if command.get("command") == "signal":
                        signal_owned(pi_pid, command.get("signal", ""))
                    elif command.get("command") == "resize":
                        rows = max(1, int(command.get("rows", 24)))
                        columns = max(1, int(command.get("columns", 80)))
                        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
                        try:
                            os.kill(pi_pid, signal.SIGWINCH)
                        except ProcessLookupError:
                            pass
                except (ValueError, OSError, TypeError):
                    pass
    if not reaped:
        try:
            waited, status = os.waitpid(pi_pid, os.WNOHANG)
            reaped = waited == pi_pid
        except ChildProcessError:
            # A missing waitpid result is not a successful child-exit receipt.
            # Closing the status channel makes the controller report unknown.
            os.close(master_fd)
            sys.exit(70)
    if reaped:
        if output_open:
            while True:
                try:
                    ready, _, _ = select.select([master_fd], [], [], 0)
                    if not ready:
                        break
                    data = os.read(master_fd, 65536)
                    if not data:
                        break
                    write_all(1, data)
                except OSError:
                    break
        exit_code = os.waitstatus_to_exitcode(status)
        child_signal = -exit_code if exit_code < 0 else None
        report({"kind": "pi_exit", **identity,
                "exitCode": exit_code if exit_code >= 0 else None,
                "signal": signal.Signals(child_signal).name if child_signal else None})
        break
try:
    os.close(master_fd)
except OSError:
    pass
`;

/** @internal: exercised by the owned PTY bridge regression test. */
export const managedPiPtyBridgeSourceForTests = PTY_BRIDGE_SOURCE;

function writeAll(fd: number, bytes: Uint8Array) {
  let offset = 0;
  while (offset < bytes.byteLength)
    offset += fs.writeSync(fd, bytes, offset, bytes.byteLength - offset);
}

function fsyncDirectory(directory: string) {
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function requirePrivateParent(file: string) {
  const parent = path.dirname(file);
  const stat = fs.lstatSync(parent, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink())
    throw new ManagedPiSessionError('artifact_parent_not_directory');
  if (fs.realpathSync(parent) !== parent)
    throw new ManagedPiSessionError('artifact_parent_not_canonical');
}

function createArtifacts(journalPath: string) {
  if (!path.isAbsolute(journalPath))
    throw new ManagedPiSessionError('journal_path_must_be_absolute');
  const file = path.resolve(journalPath);
  requirePrivateParent(file);
  const metadataPath = `${file}.pi-events.jsonl`;
  let journalFd: number | undefined;
  let metadataFd: number | undefined;
  try {
    journalFd = fs.openSync(file, 'wx', 0o600);
    metadataFd = fs.openSync(metadataPath, 'wx', 0o600);
    fs.fsyncSync(journalFd);
    fs.fsyncSync(metadataFd);
    fs.closeSync(metadataFd);
    metadataFd = undefined;
    fsyncDirectory(path.dirname(file));
    return { journalPath: file, metadataPath, journalFd };
  } catch (error) {
    if (metadataFd !== undefined)
      try {
        fs.closeSync(metadataFd);
      } catch {
        /* best effort */
      }
    if (journalFd !== undefined)
      try {
        fs.closeSync(journalFd);
      } catch {
        /* best effort */
      }
    for (const created of [metadataPath, file]) {
      try {
        fs.unlinkSync(created);
      } catch {
        /* only paths created by this attempt */
      }
    }
    throw error;
  }
}

export interface ManagedPiJournalArtifacts {
  readonly journal: ManagedPiJournal;
  readonly metadataPath: string;
}

/** Create private, exclusive journal and Pi observer metadata artifacts for SDK mode. */
export function createManagedPiJournalArtifacts(
  journalPath: string,
  runId = randomUUID(),
): ManagedPiJournalArtifacts {
  const artifacts = createArtifacts(journalPath);
  return {
    journal: new ManagedPiJournal(
      artifacts.journalPath,
      artifacts.journalFd,
      runId,
    ),
    metadataPath: artifacts.metadataPath,
  };
}

function extensionPath() {
  const current = fileURLToPath(import.meta.url);
  const ext = path.extname(current);
  const stem = path.join(path.dirname(current), 'managed-session-extension');
  const choices =
    ext === '.ts' ? [`${stem}.ts`, `${stem}.js`] : [`${stem}.js`, `${stem}.ts`];
  const found = choices.find((candidate) =>
    fs.statSync(candidate, { throwIfNoEntry: false })?.isFile(),
  );
  if (!found) throw new ManagedPiSessionError('managed_extension_missing');
  return found;
}

function parseBridgeEvent(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    if (
      (record['kind'] !== 'pi_started' && record['kind'] !== 'pi_exit') ||
      typeof record['runId'] !== 'string' ||
      !Number.isSafeInteger(record['helperPid']) ||
      !Number.isSafeInteger(record['piPid'])
    )
      return null;
    return record;
  } catch {
    return null;
  }
}

function metadataRecords(file: string) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line) => {
        try {
          const record: unknown = JSON.parse(line);
          return typeof record === 'object' && record !== null
            ? [record as Record<string, unknown>]
            : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function hashFile(file: string) {
  const fd = fs.openSync(file, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  try {
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
      bytes += count;
    }
    return { sha256: hash.digest('hex'), bytes };
  } finally {
    fs.closeSync(fd);
  }
}

function inspectTranscript(
  metadataPath: string,
  sessionId: string,
  requestedCwd: string,
): ManagedPiTranscriptObservation {
  const observation = metadataRecords(metadataPath).find(
    (record) =>
      record['type'] === 'session_start' && record['session_id'] === sessionId,
  );
  if (!observation || typeof observation['session_file'] !== 'string') {
    return {
      status: 'not_observed',
      path: null,
      sessionId: null,
      cwd: null,
      sha256: null,
      bytes: null,
      detail: 'Pi session_start did not report the new transcript path',
    };
  }
  const file = observation['session_file'];
  const observedCwd =
    typeof observation['cwd'] === 'string' ? observation['cwd'] : null;
  if (!fs.existsSync(file)) {
    return {
      status: 'not_observed',
      path: file,
      sessionId,
      cwd: observedCwd,
      sha256: null,
      bytes: null,
      detail: 'Pi has not persisted the session transcript yet',
    };
  }
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new ManagedPiSessionError('transcript_not_regular');
    const fd = fs.openSync(file, 'r');
    let firstLine: string;
    try {
      const header = Buffer.alloc(64 * 1024);
      const count = fs.readSync(fd, header, 0, header.length, 0);
      firstLine =
        header.subarray(0, count).toString('utf8').split('\n', 1)[0] ?? '';
    } finally {
      fs.closeSync(fd);
    }
    const entry: unknown = JSON.parse(firstLine);
    if (typeof entry !== 'object' || entry === null)
      throw new ManagedPiSessionError('transcript_header_invalid');
    const header = entry as Record<string, unknown>;
    const content = hashFile(file);
    const sameCwd =
      observedCwd !== null &&
      (observedCwd === requestedCwd ||
        path.resolve(observedCwd) === path.resolve(requestedCwd));
    if (
      header['type'] !== 'session' ||
      header['id'] !== sessionId ||
      header['cwd'] !== observedCwd ||
      !sameCwd
    ) {
      return {
        status: 'mismatch',
        path: file,
        sessionId,
        cwd: typeof header['cwd'] === 'string' ? header['cwd'] : observedCwd,
        sha256: content.sha256,
        bytes: content.bytes,
        detail: 'transcript header identity/cwd mismatch',
      };
    }
    return {
      status: 'verified',
      path: file,
      sessionId,
      cwd: observedCwd,
      sha256: content.sha256,
      bytes: content.bytes,
      detail: null,
    };
  } catch (error) {
    return {
      status: 'unreadable',
      path: file,
      sessionId,
      cwd: observedCwd,
      sha256: null,
      bytes: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function validTime(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function validateManagedPiArchiveEvidence(input: {
  readonly sourceExited: boolean;
  readonly transcript: ManagedPiTranscriptObservation;
  readonly receiverConfirmation: ManagedPiReceiverConfirmation;
  readonly firstWork: ManagedPiFirstWorkObservation;
}): string | null {
  if (!input.sourceExited) return 'source_child_not_confirmed_exited';
  if (
    input.transcript.status !== 'verified' ||
    !input.transcript.path ||
    !input.transcript.sha256
  )
    return 'original_transcript_not_verified';
  const confirmation = input.receiverConfirmation;
  const work = input.firstWork;
  if (
    !confirmation.receiverSessionId.trim() ||
    !confirmation.confirmationId.trim()
  )
    return 'receiver_confirmation_missing';
  if (!work.receiverSessionId.trim() || !work.workId.trim())
    return 'first_work_evidence_missing';
  if (confirmation.receiverSessionId !== work.receiverSessionId)
    return 'receiver_identity_mismatch';
  const confirmedAt = validTime(confirmation.confirmedAt);
  const workedAt = validTime(work.observedAt);
  if (confirmedAt === null || workedAt === null)
    return 'receipt_timestamp_invalid';
  if (workedAt < confirmedAt)
    return 'first_work_precedes_receiver_confirmation';
  return null;
}

function copyTranscript(
  source: TranscriptFile,
  destination: string,
): ManagedPiArchiveResult {
  if (!path.isAbsolute(destination))
    return { ok: false, reason: 'archive_path_must_be_absolute' };
  const target = path.resolve(destination);
  if (target === source.path)
    return { ok: false, reason: 'archive_is_original_path' };
  try {
    requirePrivateParent(target);
    if (fs.lstatSync(target, { throwIfNoEntry: false }))
      return { ok: false, reason: 'archive_target_exists' };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  let sourceFd: number | undefined;
  let destinationFd: number | undefined;
  let created = false;
  try {
    const before = fs.statSync(source.path, { bigint: true });
    if (
      before.dev !== source.dev ||
      before.ino !== source.ino ||
      before.size !== BigInt(source.bytes) ||
      before.mtimeNs !== source.mtimeNs
    )
      return { ok: false, reason: 'original_transcript_changed' };
    sourceFd = fs.openSync(source.path, 'r');
    destinationFd = fs.openSync(target, 'wx', 0o600);
    created = true;
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const count = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
      if (!count) break;
      const chunk = buffer.subarray(0, count);
      writeAll(destinationFd, chunk);
      hash.update(chunk);
      bytes += count;
    }
    const sha256 = hash.digest('hex');
    fs.fsyncSync(destinationFd);
    fs.closeSync(destinationFd);
    destinationFd = undefined;
    fs.closeSync(sourceFd);
    sourceFd = undefined;
    const after = fs.statSync(source.path, { bigint: true });
    if (
      sha256 !== source.sha256 ||
      bytes !== source.bytes ||
      after.dev !== source.dev ||
      after.ino !== source.ino ||
      after.size !== BigInt(source.bytes) ||
      after.mtimeNs !== source.mtimeNs
    ) {
      fs.unlinkSync(target);
      created = false;
      return { ok: false, reason: 'original_transcript_changed' };
    }
    fsyncDirectory(path.dirname(target));
    return { ok: true, archivePath: target, sha256, bytes };
  } catch (error) {
    if (destinationFd !== undefined)
      try {
        fs.closeSync(destinationFd);
      } catch {
        /* best effort */
      }
    if (sourceFd !== undefined)
      try {
        fs.closeSync(sourceFd);
      } catch {
        /* best effort */
      }
    if (created)
      try {
        fs.unlinkSync(target);
      } catch {
        /* only this call's target */
      }
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function boundedWait<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), milliseconds);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function tokenMatches(received: unknown, expected: string) {
  if (typeof received !== 'string') return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function respond(socket: Socket, value: Record<string, unknown>) {
  if (!socket.destroyed) socket.end(`${JSON.stringify(value)}\n`);
}

async function handleControl(
  socket: Socket,
  token: string,
  getSession: () => ManagedPiSessionController | null,
) {
  let text = '';
  let handled = false;
  // A disconnected client cannot crash or fence the owned session.
  socket.on('error', () => socket.destroy());
  socket.setTimeout(75_000, () => socket.destroy());
  socket.on('data', (chunk) => {
    if (handled) return;
    text += chunk.toString('utf8');
    if (Buffer.byteLength(text) > MAX_CONTROL_BYTES) {
      handled = true;
      respond(socket, { ok: false, reason: 'request_too_large' });
      return;
    }
    const newline = text.indexOf('\n');
    if (newline < 0) return;
    handled = true;
    let value: unknown;
    try {
      value = JSON.parse(text.slice(0, newline));
    } catch {
      respond(socket, { ok: false, reason: 'invalid_request' });
      return;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      respond(socket, { ok: false, reason: 'invalid_request' });
      return;
    }
    const request = value as { token?: unknown; command?: unknown };
    if (!tokenMatches(request.token, token)) {
      respond(socket, { ok: false, reason: 'unauthorized' });
      return;
    }
    const session = getSession();
    if (!session) {
      respond(socket, { ok: false, reason: 'session_not_ready' });
      return;
    }
    try {
      if (request.command === 'snapshot') {
        respond(socket, { ok: true, snapshot: session.snapshot() });
        return;
      }
      if (request.command === 'fence') {
        session.fenceIngress('authenticated_control_request');
        respond(socket, { ok: true, snapshot: session.snapshot() });
        return;
      }
      if (request.command === 'stop') {
        void session.stopOwnedChild().then(
          (exit) => respond(socket, { ok: true, exit }),
          () => respond(socket, { ok: false, reason: 'stop_failed' }),
        );
        return;
      }
      respond(socket, { ok: false, reason: 'unsupported_command' });
    } catch {
      respond(socket, { ok: false, reason: 'control_operation_failed' });
    }
  });
}

/** Cross-process client for the private descriptor written beside the journal. */
function currentUserOwns(stat: fs.Stats) {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

function readControlDescriptor(file: string): ControlDescriptor {
  if (!path.isAbsolute(file))
    throw new ManagedPiSessionError('descriptor_path_must_be_absolute');
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw new ManagedPiSessionError('control_descriptor_unavailable');
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    !currentUserOwns(stat) ||
    stat.size > 4096
  )
    throw new ManagedPiSessionError('control_descriptor_not_private');
  let fd: number | undefined;
  let parsed: unknown;
  try {
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino ||
      opened.size > 4096
    )
      throw new ManagedPiSessionError('control_descriptor_not_private');
    parsed = JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch {
    throw new ManagedPiSessionError('control_descriptor_invalid');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new ManagedPiSessionError('control_descriptor_invalid');
  const value = parsed as Record<string, unknown>;
  if (
    value['schema'] !== CONTROL_SCHEMA ||
    typeof value['socketPath'] !== 'string' ||
    !path.isAbsolute(value['socketPath']) ||
    Buffer.byteLength(value['socketPath']) > MAX_SOCKET_PATH_BYTES ||
    typeof value['token'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value['token']) ||
    typeof value['runId'] !== 'string' ||
    !value['runId'] ||
    value['runId'].length > 256 ||
    typeof value['sessionId'] !== 'string' ||
    !value['sessionId'] ||
    value['sessionId'].length > 256
  )
    throw new ManagedPiSessionError('control_descriptor_invalid');
  let socketStat: fs.Stats;
  try {
    socketStat = fs.lstatSync(value['socketPath']);
  } catch {
    throw new ManagedPiSessionError('control_socket_unavailable');
  }
  if (
    !socketStat.isSocket() ||
    (socketStat.mode & 0o077) !== 0 ||
    !currentUserOwns(socketStat)
  )
    throw new ManagedPiSessionError('control_socket_not_private');
  return value as unknown as ControlDescriptor;
}

/** Cross-process client for the private descriptor written beside the journal. */
export async function requestManagedPiControl(
  descriptorPath: string,
  action: 'snapshot' | 'fence' | 'stop' | 'deliver',
  payload: Readonly<Record<string, unknown>> = {},
): Promise<Record<string, unknown>> {
  const descriptor = readControlDescriptor(descriptorPath);
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = net.createConnection(descriptor.socketPath);
    const responseChunks: Buffer[] = [];
    let responseBytes = 0;
    let settled = false;
    const fail = (code: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new ManagedPiSessionError(code));
    };
    socket.setTimeout(75_000, () => fail('control_request_timeout'));
    socket.once('connect', () => {
      socket.write(
        `${JSON.stringify({ ...payload, token: descriptor.token, command: action })}\n`,
      );
    });
    socket.on('data', (chunk) => {
      if (settled) return;
      responseBytes += chunk.length;
      if (responseBytes > MAX_CONTROL_RESPONSE_BYTES) {
        fail('control_response_too_large');
        return;
      }
      responseChunks.push(chunk);
      if (!chunk.includes(0x0a)) return;
      const response = Buffer.concat(responseChunks).toString('utf8');
      const newline = response.indexOf('\n');
      let value: unknown;
      try {
        value = JSON.parse(response.slice(0, newline));
      } catch {
        fail('control_response_invalid');
        return;
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        fail('control_response_invalid');
        return;
      }
      settled = true;
      resolve(value as Record<string, unknown>);
      socket.end();
    });
    socket.once('end', () => {
      if (!settled) fail('control_response_incomplete');
    });
    socket.once('close', () => {
      if (!settled) fail('control_response_incomplete');
    });
    socket.once('error', () => fail('control_socket_unavailable'));
  });
}

class ManagedPiSessionController implements ManagedPiSession {
  readonly journalPath: string;
  readonly controlEndpoint: ManagedPiControlEndpoint;
  private processIdentity: ManagedPiProcessIdentity;
  private readonly journal: ManagedPiJournal;
  private readonly metadataPath: string;
  private readonly options: ManagedPiSessionOptions;
  private readonly child: ChildProcess;
  private readonly status: Readable;
  private readonly control: Writable;
  private readonly server: Server;
  private readonly socketStat: { dev: number; ino: number };
  private statusText = '';
  private fenced = false;
  private helperExit: {
    code: number | null;
    signal: NodeJS.Signals | null;
  } | null = null;
  private piExit: ManagedPiSessionExit | null = null;
  private resolveStarted!: () => void;
  private rejectStarted!: (error: Error) => void;
  private startSettled = false;
  private resolvePiExit!: (exit: ManagedPiSessionExit) => void;
  private resolveHelperExit!: () => void;
  private readonly started: Promise<void>;
  private readonly piExitPromise: Promise<ManagedPiSessionExit>;
  private readonly helperExitPromise: Promise<void>;
  private readonly inputData: (chunk: Buffer | string) => void;
  private readonly resize: () => void;
  private readonly outputDrain: () => void;
  private readonly terminalError: () => void;
  private rawBefore: boolean;
  private closed = false;

  constructor(input: {
    options: ManagedPiSessionOptions;
    identity: ManagedPiProcessIdentity;
    metadataPath: string;
    journal: ManagedPiJournal;
    child: ChildProcess;
    server: Server;
    socketStat: { dev: number; ino: number };
    controlEndpoint: ManagedPiControlEndpoint;
  }) {
    this.options = input.options;
    this.processIdentity = input.identity;
    this.metadataPath = input.metadataPath;
    this.journal = input.journal;
    this.journalPath = input.journal.path;
    this.child = input.child;
    this.server = input.server;
    this.socketStat = input.socketStat;
    this.controlEndpoint = input.controlEndpoint;
    const status = input.child.stdio[3];
    const control = input.child.stdio[4];
    if (!status || !control)
      throw new ManagedPiSessionError('pty_control_channel_missing');
    this.status = status as Readable;
    this.control = control as Writable;
    this.rawBefore = process.stdin.isRaw === true;
    this.started = new Promise<void>((resolve, reject) => {
      this.resolveStarted = resolve;
      this.rejectStarted = reject;
    });
    this.piExitPromise = new Promise((resolve) => {
      this.resolvePiExit = resolve;
    });
    this.helperExitPromise = new Promise((resolve) => {
      this.resolveHelperExit = resolve;
    });

    this.inputData = (chunk) => {
      if (this.fenced) return;
      const bytes = Buffer.from(chunk);
      const sent = forwardJournaledManagedInput(
        this.journal,
        bytes,
        (recorded) => {
          if (!this.child.stdin?.writable)
            throw new ManagedPiSessionError('pty_input_closed');
          if (!this.child.stdin.write(recorded)) process.stdin.pause();
        },
      );
      if (!sent) this.fenceIngress('journal_or_pty_input_failed');
    };
    this.resize = () => this.sendResize();
    this.outputDrain = () => this.child.stdout?.resume();
    this.terminalError = () => this.failIo('terminal_stream_failed');

    for (const stream of [
      this.child.stdin,
      this.child.stdout,
      this.child.stderr,
      this.status,
      this.control,
    ]) {
      stream?.on('error', () => this.failIo('pty_stream_failed'));
    }
    process.stdin.on('error', this.terminalError);
    process.stdout.on('error', this.terminalError);
    process.stderr.on('error', this.terminalError);

    this.child.stdin?.on('drain', () => {
      if (!this.fenced) process.stdin.resume();
    });
    this.child.stdout?.on('data', (chunk: Buffer) => {
      if (!process.stdout.write(chunk)) this.child.stdout?.pause();
    });
    process.stdout.on('drain', this.outputDrain);
    this.child.stderr?.on('data', (chunk: Buffer) =>
      process.stderr.write(chunk),
    );
    this.status.on('data', (chunk: Buffer) => this.onStatus(chunk));
    this.status.on('end', () => {
      if (this.processIdentity.piPid === 0) {
        this.failStart(
          new ManagedPiSessionError('pi_child_identity_unavailable'),
        );
        this.finishUnknown('bridge_status_ended_before_child_identity');
      } else if (this.piExit === null) {
        this.finishUnknown('bridge_status_ended_without_pi_exit');
      }
    });
    this.child.on('error', () => this.failIo('pty_bridge_failed'));
    this.child.once('close', () => {
      process.stdout.removeListener('drain', this.outputDrain);
      process.stdin.removeListener('error', this.terminalError);
      process.stdout.removeListener('error', this.terminalError);
      process.stderr.removeListener('error', this.terminalError);
    });
    this.child.on('exit', (code, signal) => {
      this.helperExit = { code: code ?? null, signal: signal ?? null };
      this.resolveHelperExit();
      if (this.piExit !== null) {
        this.piExit = {
          ...this.piExit,
          helperExitCode: code ?? null,
          helperSignal: signal ?? null,
        };
      }
      this.restoreTerminal();
    });

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', this.inputData);
    process.stdout.on('resize', this.resize);
    process.on('SIGWINCH', this.resize);
  }

  get identity(): ManagedPiProcessIdentity {
    return { ...this.processIdentity };
  }

  async waitUntilReady(timeoutMs = 30_000) {
    await this.started;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.piExit !== null)
        throw new ManagedPiSessionError('pi_exited_before_session_ready');
      const initialized = metadataRecords(this.metadataPath).some(
        (record) =>
          record['type'] === 'session_start' &&
          record['session_id'] === this.processIdentity.sessionId &&
          typeof record['cwd'] === 'string' &&
          (record['cwd'] === this.options.cwd ||
            path.resolve(record['cwd']) === path.resolve(this.options.cwd)),
      );
      if (initialized) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new ManagedPiSessionError('pi_session_start_not_observed');
  }

  private settleStart(error?: Error) {
    if (this.startSettled) return;
    this.startSettled = true;
    if (error) this.rejectStarted(error);
    else this.resolveStarted();
  }

  private failStart(error: Error) {
    this.settleStart(error);
    this.fenceIngress('startup_or_bridge_failure');
  }

  private failIo(reason: string) {
    this.failStart(new ManagedPiSessionError(reason));
    this.finishUnknown(reason);
  }

  private finishUnknown(reason: string) {
    if (this.piExit !== null) return;
    this.piExit = {
      status: 'unknown',
      piPid: this.processIdentity.piPid,
      exitCode: null,
      signal: null,
      helperExitCode: this.helperExit?.code ?? null,
      helperSignal: this.helperExit?.signal ?? null,
      reason,
    };
    this.resolvePiExit(this.piExit);
  }

  private onStatus(chunk: Buffer) {
    this.statusText += chunk.toString('utf8');
    if (Buffer.byteLength(this.statusText) > MAX_CONTROL_BYTES) {
      this.failStart(new ManagedPiSessionError('pty_status_too_large'));
      this.statusText = '';
      return;
    }
    let at = this.statusText.indexOf('\n');
    while (at >= 0) {
      const line = this.statusText.slice(0, at).trim();
      this.statusText = this.statusText.slice(at + 1);
      if (line) this.acceptStatusEvent(line);
      at = this.statusText.indexOf('\n');
    }
  }

  private acceptStatusEvent(line: string) {
    const event = parseBridgeEvent(line);
    if (
      !event ||
      event['runId'] !== this.processIdentity.runId ||
      event['helperPid'] !== this.processIdentity.helperPid
    ) {
      this.failStart(new ManagedPiSessionError('pty_identity_mismatch'));
      return;
    }
    if (event['kind'] === 'pi_started') {
      if (
        this.processIdentity.piPid !== 0 ||
        !Number.isSafeInteger(event['piPid']) ||
        Number(event['piPid']) <= 0
      ) {
        this.failStart(new ManagedPiSessionError('pty_identity_mismatch'));
        return;
      }
      this.processIdentity = {
        ...this.processIdentity,
        piPid: Number(event['piPid']),
      };
      try {
        this.journal.append('owned_pi_child_started', {
          helper_pid: this.processIdentity.helperPid,
          pi_pid: this.processIdentity.piPid,
          session_id: this.processIdentity.sessionId,
        });
        this.settleStart();
        this.sendResize();
      } catch (error) {
        this.failStart(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      return;
    }
    const exitEvent: PiExitEvent = {
      runId: String(event['runId']),
      helperPid: Number(event['helperPid']),
      piPid: Number(event['piPid']),
      exitCode:
        typeof event['exitCode'] === 'number' ? event['exitCode'] : null,
      signal: typeof event['signal'] === 'string' ? event['signal'] : null,
    };
    if (
      this.processIdentity.piPid <= 0 ||
      !isOwnedManagedPiExit(exitEvent, this.processIdentity)
    )
      return;
    this.piExit = {
      status: 'exited',
      piPid: exitEvent.piPid,
      exitCode: exitEvent.exitCode,
      signal: exitEvent.signal,
      helperExitCode: this.helperExit?.code ?? null,
      helperSignal: this.helperExit?.signal ?? null,
      reason: null,
    };
    try {
      this.journal.append('owned_pi_child_exited', {
        pi_pid: exitEvent.piPid,
        exit_code: exitEvent.exitCode,
        signal: exitEvent.signal,
      });
    } catch {
      /* exact waitpid exit remains distinguishable from journal health */
    }
    this.resolvePiExit(this.piExit);
    this.fenceIngress('owned_pi_child_exited');
  }

  private sendControl(record: Record<string, unknown>) {
    if (this.control.destroyed || !this.control.writable)
      throw new ManagedPiSessionError('control_pipe_closed');
    this.control.write(`${JSON.stringify(record)}\n`);
  }

  private sendResize() {
    if (this.processIdentity.piPid <= 0 || this.piExit !== null || this.closed)
      return;
    try {
      this.sendControl({
        command: 'resize',
        rows: process.stdout.rows ?? 24,
        columns: process.stdout.columns ?? 80,
      });
    } catch {
      /* presentation resize failure does not change process-exit evidence */
    }
  }

  private restoreTerminal() {
    this.fenceIngress('owned_process_finished');
    try {
      process.stdin.setRawMode(this.rawBefore);
    } catch {
      /* terminal may already be detached */
    }
  }

  fenceIngress(reason = 'controller_requested') {
    if (this.fenced) return;
    this.fenced = true;
    process.stdin.removeListener('data', this.inputData);
    process.stdin.pause();
    process.stdout.removeListener('resize', this.resize);
    process.removeListener('SIGWINCH', this.resize);
    this.journal.fence(reason);
    try {
      process.stdin.setRawMode(this.rawBefore);
    } catch {
      /* terminal may already be detached */
    }
  }

  snapshot(): ManagedPiSessionSnapshot {
    const transcript = inspectTranscript(
      this.metadataPath,
      this.processIdentity.sessionId,
      this.options.cwd,
    );
    const blockers = [
      'native_queue_payloads_unknown',
      'native_approval_state_unknown',
      'in_flight_work_inventory_unknown',
      'external_writers_not_fenced',
      'descendant_processes_not_owned_or_stopped',
    ];
    if (!this.journal.healthy) blockers.push('ingress_journal_unhealthy');
    if (transcript.status !== 'verified')
      blockers.push('original_transcript_unverified');
    return {
      schema: MANAGED_PI_SESSION_SCHEMA,
      runId: this.processIdentity.runId,
      provider: 'openrouter',
      model: this.options.model,
      cwd: this.options.cwd,
      sessionId: this.processIdentity.sessionId,
      process: this.identity,
      processExit: this.piExit,
      readiness: {
        ownedPiChild: 'started',
        extensionSessionStart: 'observed',
        terminalUiRender: 'not_observed',
      },
      ingress: {
        state: this.fenced ? 'fenced' : 'open',
        journalPath: this.journalPath,
        sequence: this.journal.currentSequence,
        headDigest: this.journal.currentDigest,
        healthy: this.journal.healthy,
        rawTerminalInputJournaled: true,
      },
      transcript,
      nativeInventory: {
        queuedMessages: 'unknown',
        approvals: 'unknown',
        inFlightWork: 'unknown',
        externalWriters: 'unknown',
        descendants: 'uncontrolled',
      },
      transferReady: false,
      blockers,
    };
  }

  async waitForExit(): Promise<ManagedPiSessionExit> {
    const exit = await this.piExitPromise;
    if (exit.status === 'unknown') return exit;
    const helperWaited = await boundedWait(this.helperExitPromise, 2_000);
    return {
      ...this.piExit!,
      helperExitCode: this.helperExit?.code ?? null,
      helperSignal: this.helperExit?.signal ?? null,
      reason:
        helperWaited === null
          ? 'pi_exit_confirmed_helper_exit_not_observed'
          : null,
    };
  }

  async stopOwnedChild(): Promise<ManagedPiSessionExit> {
    this.fenceIngress('owned_child_stop_requested');
    if (this.piExit !== null) return this.waitForExit();
    if (this.processIdentity.piPid <= 0)
      return {
        status: 'unknown',
        piPid: 0,
        exitCode: null,
        signal: null,
        helperExitCode: this.helperExit?.code ?? null,
        helperSignal: this.helperExit?.signal ?? null,
        reason: 'pi_child_identity_unavailable',
      };
    try {
      this.sendControl({ command: 'signal', signal: 'TERM' });
    } catch {
      return this.unknown('owned_child_signal_unavailable');
    }
    let exit = await boundedWait(
      this.piExitPromise,
      this.options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
    );
    if (exit === null) {
      try {
        this.sendControl({ command: 'signal', signal: 'KILL' });
      } catch {
        return this.unknown('owned_child_kill_unavailable');
      }
      exit = await boundedWait(this.piExitPromise, KILL_GRACE_MS);
    }
    if (exit === null) return this.unknown('owned_child_exit_not_observed');
    return this.waitForExit();
  }

  private unknown(reason: string): ManagedPiSessionExit {
    return {
      status: 'unknown',
      piPid: this.processIdentity.piPid,
      exitCode: null,
      signal: null,
      helperExitCode: this.helperExit?.code ?? null,
      helperSignal: this.helperExit?.signal ?? null,
      reason,
    };
  }

  archiveOriginalTranscript(input: {
    readonly destinationPath: string;
    readonly receiverConfirmation: ManagedPiReceiverConfirmation;
    readonly firstWork: ManagedPiFirstWorkObservation;
  }): ManagedPiArchiveResult {
    const snapshot = this.snapshot();
    const reason = validateManagedPiArchiveEvidence({
      sourceExited:
        snapshot.processExit?.status === 'exited' && this.helperExit !== null,
      transcript: snapshot.transcript,
      receiverConfirmation: input.receiverConfirmation,
      firstWork: input.firstWork,
    });
    if (reason) return { ok: false, reason };
    const observed = snapshot.transcript;
    if (!observed.path || !observed.sha256 || observed.bytes === null)
      return { ok: false, reason: 'original_transcript_not_verified' };
    const stat = fs.statSync(observed.path, { bigint: true });
    const source: TranscriptFile = {
      path: observed.path,
      sha256: observed.sha256,
      bytes: observed.bytes,
      dev: stat.dev,
      ino: stat.ino,
      mtimeNs: stat.mtimeNs,
    };
    try {
      this.journal.append('transcript_archive_authorized', {
        receiver_session_id: input.receiverConfirmation.receiverSessionId,
        confirmation_id: input.receiverConfirmation.confirmationId,
        confirmed_at: input.receiverConfirmation.confirmedAt,
        first_work_id: input.firstWork.workId,
        first_work_observed_at: input.firstWork.observedAt,
        original_transcript_sha256: observed.sha256,
      });
    } catch {
      return { ok: false, reason: 'archive_authorization_not_journaled' };
    }
    const result = copyTranscript(source, input.destinationPath);
    if (result.ok) {
      try {
        this.journal.append('transcript_archive_created', result);
      } catch {
        return {
          ok: false,
          reason: 'archive_created_but_completion_not_journaled',
        };
      }
    }
    return result;
  }

  close() {
    if (this.closed) return;
    if (!this.piExit || !this.helperExit)
      throw new ManagedPiSessionError('cannot_close_live_session');
    this.closed = true;
    this.fenceIngress('controller_closed');
    this.server.close();
    try {
      const current = fs.lstatSync(this.controlEndpoint.socketPath);
      if (
        current.isSocket() &&
        current.dev === this.socketStat.dev &&
        current.ino === this.socketStat.ino
      )
        fs.unlinkSync(this.controlEndpoint.socketPath);
    } catch {
      /* never remove a path replaced after bind */
    }
    this.journal.close();
  }
}

/** Start Pi as an owned visible TUI; its native screen is passed directly through the PTY. */
export async function startManagedPiSession(
  options: ManagedPiSessionOptions,
): Promise<ManagedPiSession> {
  if (
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    typeof process.stdin.setRawMode !== 'function'
  )
    throw new ManagedPiSessionError('native_tui_requires_terminal');
  if (
    !path.isAbsolute(options.cwd) ||
    !fs.statSync(options.cwd, { throwIfNoEntry: false })?.isDirectory()
  )
    throw new ManagedPiSessionError('cwd_must_be_an_absolute_directory');
  if (!options.model.trim()) throw new ManagedPiSessionError('model_required');
  if (
    options.shutdownGraceMs !== undefined &&
    (!Number.isSafeInteger(options.shutdownGraceMs) ||
      options.shutdownGraceMs < 0 ||
      options.shutdownGraceMs > 60_000)
  )
    throw new ManagedPiSessionError('shutdown_grace_out_of_range');

  const artifacts = createArtifacts(options.journalPath);
  const runId = randomUUID();
  const sessionId = randomUUID();
  const journal = new ManagedPiJournal(
    artifacts.journalPath,
    artifacts.journalFd,
    runId,
  );
  journal.append('launch_requested', {
    provider: 'openrouter',
    model: options.model,
    cwd: options.cwd,
    session_id: sessionId,
    terminal_mode: 'native-pi-tui-over-pty',
  });
  const socketPath =
    options.controlSocketPath ??
    path.join(
      path.dirname(artifacts.journalPath),
      `.pappra-${runId.slice(0, 10)}.sock`,
    );
  if (
    !path.isAbsolute(socketPath) ||
    Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES
  ) {
    journal.close();
    throw new ManagedPiSessionError('control_socket_path_invalid');
  }
  requirePrivateParent(socketPath);
  if (fs.lstatSync(socketPath, { throwIfNoEntry: false })) {
    journal.close();
    throw new ManagedPiSessionError('control_socket_already_exists');
  }
  const token = randomBytes(32).toString('hex');
  const descriptorPath = `${artifacts.journalPath}.control.json`;
  if (fs.lstatSync(descriptorPath, { throwIfNoEntry: false })) {
    journal.close();
    throw new ManagedPiSessionError('control_descriptor_already_exists');
  }
  let controller: ManagedPiSessionController | null = null;
  const server = net.createServer((socket) => {
    void handleControl(socket, token, () => controller);
  });
  server.on('error', () => controller?.fenceIngress('control_server_failed'));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  fs.chmodSync(socketPath, 0o600);
  const socketStat = fs.lstatSync(socketPath);
  if (!socketStat.isSocket())
    throw new ManagedPiSessionError('control_socket_not_socket');

  const env = {
    ...process.env,
    [METADATA_ENV]: artifacts.metadataPath,
    PAPPRA_MANAGED_PI_ROWS: String(process.stdout.rows ?? 24),
    PAPPRA_MANAGED_PI_COLUMNS: String(process.stdout.columns ?? 80),
  };
  const piBin = options.piBin ?? process.env['PAPPRA_PI_BIN'] ?? 'pi';
  const argv = [
    piBin,
    ...buildManagedPiArgv({
      model: options.model,
      sessionId,
      extensionPath: extensionPath(),
    }),
  ];
  let child: ChildProcess;
  try {
    child = spawn(
      options.pythonBin ?? 'python3',
      ['-u', '-c', PTY_BRIDGE_SOURCE, runId, ...argv],
      {
        cwd: options.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    server.close();
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* socket created by this launch */
    }
    try {
      journal.append('launch_failed', { reason: String(error) });
    } catch {
      /* keep original error */
    }
    journal.close();
    throw new ManagedPiSessionError('pty_bridge_spawn_failed', String(error));
  }
  try {
    const inputIdentity: ManagedPiProcessIdentity = {
      runId,
      helperPid: child.pid ?? 0,
      piPid: 0,
      sessionId,
    };
    controller = new ManagedPiSessionController({
      options,
      identity: inputIdentity,
      metadataPath: artifacts.metadataPath,
      journal,
      child,
      server,
      socketStat: { dev: socketStat.dev, ino: socketStat.ino },
      controlEndpoint: { socketPath, descriptorPath },
    });
    await waitForStart(controller, START_TIMEOUT_MS);
    const descriptor: ControlDescriptor = {
      schema: CONTROL_SCHEMA,
      socketPath,
      token,
      runId,
      sessionId,
    };
    const descriptorFd = fs.openSync(descriptorPath, 'wx', 0o600);
    try {
      writeAll(descriptorFd, Buffer.from(`${JSON.stringify(descriptor)}\n`));
      fs.fsyncSync(descriptorFd);
    } finally {
      fs.closeSync(descriptorFd);
    }
    fsyncDirectory(path.dirname(descriptorPath));
    journal.append('controller_ready', {
      process: controller.identity,
      control_descriptor: descriptorPath,
    });
    return controller;
  } catch (error) {
    controller?.fenceIngress('startup_failed');
    if (controller && controller.identity.piPid > 0)
      await controller.stopOwnedChild();
    server.close();
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* only our socket */
    }
    try {
      journal.close();
    } catch {
      /* already closed */
    }
    throw error;
  }
}

async function waitForStart(
  session: ManagedPiSessionController,
  timeoutMs: number,
) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      session.waitUntilReady(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new ManagedPiSessionError('pi_start_timeout')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
