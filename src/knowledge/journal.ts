import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { diagnosticCodes } from '../schemas/errors.js';
import type { Outcome } from '../schemas/outcome.js';
import { errorMessage, failed, succeeded } from '../schemas/outcome.js';
import {
  knowledgeJournalSchema,
  knowledgeLockSchema,
  type KnowledgeJournal,
  type KnowledgeLock,
} from '../schemas/document.js';
import { readTextFileBounded } from '../infra/fs.js';
import { ensurePrivateState } from '../infra/private-state.js';
import type { KnowledgeContext } from './context.js';
import { ensureKnowledgePathBoundary, knowledgePaths } from './paths.js';

export interface KnowledgeLockAcquireResult {
  readonly ok: boolean;
  readonly status: 'acquired' | 'locked' | 'failed';
  readonly lock: KnowledgeLock | null;
  readonly path: string;
  readonly message: string | null;
}

function lockFailure(
  path: string,
  status: 'locked' | 'failed',
  message: string,
): KnowledgeLockAcquireResult {
  return { ok: false, status, lock: null, path, message };
}

export async function acquireKnowledgeLock(
  context: KnowledgeContext,
  operation: KnowledgeLock['operation'],
): Promise<KnowledgeLockAcquireResult> {
  const path = knowledgePaths(context.root).lockPath;
  const boundary = await ensureKnowledgePathBoundary(context.root, path);
  if (!boundary.ok) {
    return lockFailure(path, 'failed', boundary.message);
  }
  const prepared = await ensurePrivateState(context.root);
  if (!prepared.ok) return lockFailure(path, 'failed', prepared.message);
  try {
    await mkdir(dirname(path), { recursive: true });
  } catch (error) {
    return lockFailure(
      path,
      'failed',
      `Cannot create knowledge state directory: ${errorMessage(error)}`,
    );
  }
  const lock: KnowledgeLock = {
    schema: 'pappra/knowledge-lock/1',
    token: randomUUID(),
    operation,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(Buffer.from(`${JSON.stringify(lock, null, 2)}\n`));
    await handle.sync();
    await handle.close();
    handle = undefined;
    return { ok: true, status: 'acquired', lock, path, message: null };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : null;
    return code === 'EEXIST'
      ? lockFailure(
          path,
          'locked',
          `Knowledge mutation is already locked: ${path}`,
        )
      : lockFailure(
          path,
          'failed',
          `Cannot acquire knowledge lock ${path}: ${errorMessage(error)}`,
        );
  }
}

export async function releaseKnowledgeLock(
  lock: KnowledgeLock,
  path: string,
): Promise<Outcome<null>> {
  const read = await readTextFileBounded(path);
  if (!read.ok) {
    return failed(
      diagnosticCodes.document_locked,
      `Cannot verify knowledge lock ${path}: ${read.message}`,
      { nextAction: 'Inspect the lock manually; it was not removed.' },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.value.text);
  } catch {
    return failed(
      diagnosticCodes.document_locked,
      `Knowledge lock is not valid JSON: ${path}`,
      { nextAction: 'Inspect the lock manually; it was not removed.' },
    );
  }
  const valid = knowledgeLockSchema.safeParse(parsed);
  if (!valid.success || valid.data.token !== lock.token) {
    return failed(
      diagnosticCodes.document_locked,
      `Knowledge lock ownership changed: ${path}`,
      { nextAction: 'Inspect the lock manually; it was not removed.' },
    );
  }
  try {
    await unlink(path);
    return succeeded(null);
  } catch (error) {
    return failed(
      diagnosticCodes.document_locked,
      `Cannot release knowledge lock ${path}: ${errorMessage(error)}`,
      { nextAction: 'Inspect the lock manually; it remains as evidence.' },
    );
  }
}

export function knowledgeJournalPath(
  context: KnowledgeContext,
  operationId: string,
): string {
  return join(knowledgePaths(context.root).journalsDir, `${operationId}.json`);
}

export async function writeKnowledgeJournal(
  context: KnowledgeContext,
  journal: KnowledgeJournal,
): Promise<Outcome<{ readonly path: string }>> {
  const parsed = knowledgeJournalSchema.safeParse(journal);
  if (!parsed.success) {
    return failed(
      diagnosticCodes.document_journal_failed,
      `Knowledge journal is invalid: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`,
      {
        nextAction:
          'Inspect the operation state; no recovery state was written.',
      },
    );
  }
  const path = knowledgeJournalPath(context, parsed.data.operationId);
  const boundary = await ensureKnowledgePathBoundary(context.root, path);
  if (!boundary.ok) return boundary;
  const prepared = await ensurePrivateState(context.root);
  if (!prepared.ok) return prepared;
  const temporary = `${path}.tmp-${randomUUID()}`;
  const bytes = Buffer.from(`${JSON.stringify(parsed.data, null, 2)}\n`);
  let handle;
  try {
    await mkdir(dirname(path), { recursive: true });
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    return succeeded({ path });
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    return failed(
      diagnosticCodes.document_journal_failed,
      `Cannot write knowledge journal ${path}: ${errorMessage(error)}`,
      { nextAction: 'Resolve the local state write failure before retrying.' },
    );
  }
}
