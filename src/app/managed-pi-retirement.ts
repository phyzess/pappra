import fs from 'node:fs';
import path from 'node:path';
import type { ManagedPiSdkSessionController } from '../hosts/pi/managed-sdk-session.js';
import {
  continuityTaskPaths,
  writeContinuityBytes,
} from '../continuity/paths.js';
import { readBoundedFile } from './bounded-file.js';
import {
  applySessionTransition,
  planSessionTransition,
  type SessionTransitionDependencies,
  type SessionTransitionRequest,
} from './collab-session-transition.js';

type RetirementRuntime = Pick<
  ManagedPiSdkSessionController,
  'observe' | 'snapshot' | 'stopOwnedRuntime' | 'isDisposed'
>;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
export interface ManagedPiRetirementReceipt {
  readonly schema: 'pappra/managed-pi-retirement/1';
  readonly transition_id: string;
  readonly source_session_id: string;
  readonly successor_session_id: string;
  readonly status: 'runtime_disposed_and_transcript_retained';
  readonly stop: {
    readonly status: 'runtime_disposed';
    readonly process_exit: 'not_owned';
  };
  readonly transcript: {
    readonly source: string;
    readonly ref: string;
    readonly digest: string;
    readonly original: 'retained-in-place';
  };
  readonly native_history: 'unchanged';
}

function transcript(file: string, sessionId: string, cwd: string) {
  const before = fs.lstatSync(file);
  const read = readBoundedFile(file, MAX_TRANSCRIPT_BYTES);
  const after = fs.lstatSync(file);
  if (
    !read.ok ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  )
    throw new Error('retirement_transcript_unstable');
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(read.text.split('\n', 1)[0]!) as Record<
      string,
      unknown
    >;
  } catch {
    throw new Error('retirement_transcript_invalid');
  }
  if (
    header.type !== 'session' ||
    header.id !== sessionId ||
    header.cwd !== cwd
  )
    throw new Error('retirement_transcript_identity_mismatch');
  return read;
}

/** Native disposal and retention follow authoritative transfer + successor first work. */
export async function retireManagedPiSource(
  request: SessionTransitionRequest,
  runtime: RetirementRuntime,
  dependencies: SessionTransitionDependencies = {},
): Promise<{
  readonly receipt: ManagedPiRetirementReceipt;
  readonly receiptFile: string;
  readonly duplicate: boolean;
}> {
  const observed = runtime.observe();
  if (
    observed.native.sessionId !== request.intent.from.session_id ||
    path.resolve(observed.cwd) !== path.resolve(request.intent.from.cwd ?? '')
  )
    throw new Error('retirement_source_identity_mismatch');
  // Check read-only first: retirement must never advance bootstrap or transfer.
  const planned = await planSessionTransition(request, dependencies);
  if (!planned.ok || planned.stage !== 'task_retired')
    throw new Error('retirement_first_work_gate_unsatisfied');
  const verified = await applySessionTransition(request, dependencies);
  if (!verified.ok || verified.stage !== 'task_retired')
    throw new Error('retirement_first_work_gate_unsatisfied');
  const { root, continuity_task_id: taskId } = request.bundle;
  const directory = path.join(
    continuityTaskPaths(root, taskId).taskDir,
    'retired-sessions',
  );
  const archiveFile = path.join(directory, `${request.transition_id}.jsonl`);
  const receiptFile = path.join(
    directory,
    `${request.transition_id}.receipt.json`,
  );
  const nativeFile = runtime.snapshot().session.sessionFile;
  if (!nativeFile) throw new Error('retirement_transcript_unavailable');
  const prior = fs.lstatSync(receiptFile, { throwIfNoEntry: false });
  if (prior) {
    const read = readBoundedFile(receiptFile, 16 * 1024);
    if (!read.ok) throw new Error('retirement_receipt_unreadable');
    const value = JSON.parse(read.text) as ManagedPiRetirementReceipt;
    const archive = readBoundedFile(archiveFile, MAX_TRANSCRIPT_BYTES);
    if (
      !runtime.isDisposed ||
      value.schema !== 'pappra/managed-pi-retirement/1' ||
      value.transition_id !== request.transition_id ||
      value.source_session_id !== observed.native.sessionId ||
      value.successor_session_id !== request.intent.to.session_id ||
      value.status !== 'runtime_disposed_and_transcript_retained' ||
      value.transcript?.source !== nativeFile ||
      value.stop?.status !== 'runtime_disposed' ||
      value.stop.process_exit !== 'not_owned' ||
      value.transcript?.ref !==
        path.relative(root, archiveFile).split(path.sep).join('/') ||
      !archive.ok ||
      archive.digest !== value.transcript.digest
    )
      throw new Error('retirement_receipt_conflict');
    transcript(archiveFile, observed.native.sessionId, observed.cwd);
    return { receipt: value, receiptFile, duplicate: true };
  }
  transcript(nativeFile, observed.native.sessionId, observed.cwd);
  const stopped = await runtime.stopOwnedRuntime();
  if (
    stopped.status !== 'runtime_disposed' ||
    stopped.sessionId !== observed.native.sessionId ||
    stopped.process.exit !== 'not_owned' ||
    !stopped.finalSnapshot.scopedQuiescent
  )
    throw new Error('retirement_runtime_stop_unknown');
  const bytes = transcript(nativeFile, observed.native.sessionId, observed.cwd);
  const existing = fs.lstatSync(archiveFile, { throwIfNoEntry: false });
  if (existing) {
    const saved = readBoundedFile(archiveFile, MAX_TRANSCRIPT_BYTES);
    if (!saved.ok || saved.digest !== bytes.digest)
      throw new Error('retirement_archive_conflict');
  } else {
    const saved = await writeContinuityBytes(
      root,
      taskId,
      archiveFile,
      bytes.bytes,
      true,
    );
    if (!saved.ok) throw new Error(saved.code);
  }
  const receipt: ManagedPiRetirementReceipt = {
    schema: 'pappra/managed-pi-retirement/1',
    transition_id: request.transition_id,
    source_session_id: observed.native.sessionId,
    successor_session_id: request.intent.to.session_id,
    status: 'runtime_disposed_and_transcript_retained',
    stop: { status: 'runtime_disposed', process_exit: 'not_owned' },
    transcript: {
      source: nativeFile,
      ref: path.relative(root, archiveFile).split(path.sep).join('/'),
      digest: bytes.digest,
      original: 'retained-in-place',
    },
    native_history: 'unchanged',
  };
  const saved = await writeContinuityBytes(
    root,
    taskId,
    receiptFile,
    Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`),
    true,
  );
  if (!saved.ok) throw new Error(saved.code);
  return { receipt, receiptFile, duplicate: false };
}
