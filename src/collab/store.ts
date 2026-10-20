import type {
  TaskRecord,
  Coordinator,
  Mutation,
  Failure,
  LockHolder,
  TransactionFile,
  Finding,
  TransactionResult,
} from './types.js';
import {
  errorCode,
  parseJson,
  object,
  isTaskRecord,
  isLockHolder,
} from './validation.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Task collaboration record. The record is data, never an executable script, and it
// stays separate from harness session stores and generated registry manifests.
//
// Concurrency model (asserted, not implied):
//   * Mutual exclusion is a directory created with `mkdir`, which is atomic on POSIX.
//     There is no lock TTL and no time-based takeover.
//   * Read-validate-write happens while holding that lock, so the expected-revision
//     check is a real compare-and-swap over the record, not a best-effort reread.
//   * Commit is write-then-rename inside the lock directory. A surviving transaction
//     file proves the rename never happened, so an interrupted commit is detectable
//     and never leaves a partially written record.
//   * The lock is released explicitly. A crash leaves it in place for inspection.

export const STATE_SCHEMA = 'harness-collab/state/1';
export const LEDGER_SCHEMA = 'harness-collab/ledger/1';
export const RECORD_FILE = 'task.json';
export const LEDGER_FILE = 'ledger.jsonl';

export const DEFAULT_DOMAIN_ROOT = path.join(
  os.homedir(),
  '.local',
  'state',
  'pappra',
  'domains',
  'default',
);

export class LockHeldError extends Error {
  constructor(
    message: string,
    public readonly holder: LockHolder | null,
  ) {
    super(message);
    this.name = 'LockHeldError';
    this.holder = holder;
  }
}

export class RevisionConflictError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(`state_revision conflict: expected ${expected}, found ${actual}`);
    this.name = 'RevisionConflictError';
    this.expected = expected;
    this.actual = actual;
  }
}

export const digestBytes = (value: string | Uint8Array) =>
  `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
export const digestText = (value: string | Uint8Array) => digestBytes(value);

export function createNonce() {
  return crypto.randomBytes(12).toString('hex');
}

export function nowIso(clock = Date.now()) {
  const date = new Date(clock);
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  // Shift the instant by the local offset so the wall-clock part and the offset suffix
  // agree; appending an offset to a UTC instant would misstate the time by that offset.
  const shifted = new Date(date.getTime() + offset * 60_000);
  return shifted
    .toISOString()
    .replace(
      'Z',
      `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`,
    );
}

export function isAbsoluteExistingDirectory(value: unknown) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return false;
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

export function resolveDomainRoot(input?: string | null) {
  const candidate =
    input ?? process.env.PAPPRA_DOMAIN_ROOT ?? DEFAULT_DOMAIN_ROOT;
  if (!path.isAbsolute(candidate))
    throw new Error('Domain root must be an absolute path');
  fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
  return fs.realpathSync(candidate);
}

export function taskRootFor(domainRoot: string, taskId: string) {
  if (
    typeof taskId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId)
  ) {
    throw new Error(
      'task_id must be a short identifier (letters, digits, dot, dash, underscore)',
    );
  }
  return path.join(resolveDomainRoot(domainRoot), 'tasks', taskId);
}

export const recordPath = (taskRoot: string) =>
  path.join(taskRoot, RECORD_FILE);
export const ledgerPath = (taskRoot: string) =>
  path.join(taskRoot, LEDGER_FILE);
export const lockPath = (taskRoot: string) =>
  path.join(taskRoot, '.write.lock');
export const messagesDir = (taskRoot: string) =>
  path.join(taskRoot, 'messages');
export const resultsDir = (taskRoot: string) => path.join(taskRoot, 'results');
export const nativeDir = (taskRoot: string) => path.join(taskRoot, 'native');
export const abortedDir = (taskRoot: string) => path.join(taskRoot, 'aborted');
export const brokenLocksDir = (taskRoot: string) =>
  path.join(taskRoot, 'broken-locks');

export function domainIdOf(domainRoot: string) {
  return `domain:${crypto.createHash('sha256').update(domainRoot).digest('hex').slice(0, 24)}`;
}

/** Validate the stored shape without inferring native execution facts. */
export function readRecord(taskRoot: string): TaskRecord | null {
  const file = recordPath(taskRoot);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024)
    throw new Error('Task record is not a supported file');
  const parsed = parseJson(fs.readFileSync(file, 'utf8'));
  if (!isTaskRecord(parsed)) throw new Error('Invalid task record structure');
  return parsed;
}

function writeJsonAtomic<T>(file: string, value: T): T {
  const temporary = `${file}.tmp-${createNonce()}`;
  const handle = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeSync(handle, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, file);
  return value;
}

export function readLock(taskRoot: string) {
  const directory = lockPath(taskRoot);
  try {
    if (!fs.statSync(directory).isDirectory()) return { held: false };
  } catch {
    return { held: false };
  }
  let holder: LockHolder | null = null;
  try {
    const parsed = parseJson(
      fs.readFileSync(path.join(directory, 'holder.json'), 'utf8'),
    );
    holder = isLockHolder(parsed) ? parsed : null;
  } catch {
    holder = null;
  }
  let alive = false;
  if (holder?.hostname === os.hostname() && Number.isSafeInteger(holder.pid)) {
    try {
      process.kill(holder.pid, 0);
      alive = true;
    } catch (error) {
      alive = errorCode(error) === 'EPERM';
    }
  }
  return {
    held: true,
    holder,
    holder_process_alive: alive,
    transaction_files: listTransactions(taskRoot).map((item) => item.file),
  };
}

export function listTransactions(taskRoot: string): TransactionFile[] {
  const directory = lockPath(taskRoot);
  const found: TransactionFile[] = [];
  let names = [];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return found;
  }
  for (const name of names
    .filter(
      (item) =>
        item.startsWith('txn-') &&
        item.endsWith('.json') &&
        !item.endsWith('.meta.json'),
    )
    .sort()) {
    const file = path.join(directory, name);
    let record: unknown = null;
    let meta: unknown = null;
    try {
      record = parseJson(fs.readFileSync(file, 'utf8'));
    } catch {
      record = null;
    }
    try {
      meta = parseJson(
        fs.readFileSync(file.replace(/\.json$/, '.meta.json'), 'utf8'),
      );
    } catch {
      meta = null;
    }
    found.push({
      file,
      revision: object(record) ? (record.state_revision ?? null) : null,
      purpose: object(meta) ? (meta.purpose ?? null) : null,
      actor: object(meta) ? (meta.actor ?? null) : null,
    });
  }
  return found;
}

/**
 * Acquire the record lock. `waitMs` bounds how long the caller waits; the lock itself
 * never expires and is never stolen.
 */
export function acquireLock(
  taskRoot: string,
  {
    actor = 'unattributed',
    purpose = 'unspecified',
    waitMs = 5000,
    pollMs = 20,
  }: {
    actor?: string;
    purpose?: string;
    waitMs?: number;
    pollMs?: number;
  } = {},
) {
  fs.mkdirSync(taskRoot, { recursive: true, mode: 0o700 });
  const directory = lockPath(taskRoot);
  const deadline = Date.now() + Math.max(0, waitMs);
  const nonce = createNonce();
  for (;;) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
      const holder = {
        schema: 'harness-collab/lock/1',
        nonce,
        actor,
        purpose,
        pid: process.pid,
        hostname: os.hostname(),
        acquired_at: nowIso(),
      };
      fs.writeFileSync(
        path.join(directory, 'holder.json'),
        `${JSON.stringify(holder, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      return holder;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      const current = readLock(taskRoot);
      if (Date.now() >= deadline) {
        throw new LockHeldError(
          'Task record lock is already held; the lock is never taken over by time',
          current.holder ?? null,
        );
      }
      const until = Date.now() + pollMs;
      while (Date.now() < until) {
        // Bounded busy wait keeps the helper dependency-free and deterministic.
      }
    }
  }
}

export function releaseLock(taskRoot: string, holder: LockHolder | null) {
  const directory = lockPath(taskRoot);
  const record = readLock(taskRoot);
  if (!record.held) return false;
  if (holder?.nonce && record.holder?.nonce !== holder.nonce) {
    throw new Error('Refusing to release a lock held by a different owner');
  }
  for (const item of listTransactions(taskRoot)) {
    throw new Error(
      `Refusing to release the lock with an uncommitted transaction: ${path.basename(item.file)}`,
    );
  }
  fs.rmSync(path.join(directory, 'holder.json'), { force: true });
  fs.rmdirSync(directory);
  return true;
}

/**
 * Break a lock only when the caller states the holder is stopped. The lock directory is
 * preserved as evidence; it is never deleted silently and never expires on its own.
 */
export function breakLock(
  taskRoot: string,
  {
    actor,
    reason,
    confirmHolderStopped,
    at = nowIso(),
  }: {
    actor?: string;
    reason?: string;
    confirmHolderStopped?: boolean;
    at?: string;
  } = {},
) {
  if (confirmHolderStopped !== true)
    throw new Error(
      'Breaking a lock requires an explicit confirmation that the holder stopped',
    );
  if (typeof actor !== 'string' || !actor.trim())
    throw new Error('Breaking a lock requires an actor');
  if (typeof reason !== 'string' || !reason.trim())
    throw new Error('Breaking a lock requires a reason');
  const directory = lockPath(taskRoot);
  const before = readLock(taskRoot);
  if (!before.held) return { broken: false, reason: 'no_lock' };
  const destination = path.join(
    brokenLocksDir(taskRoot),
    `${at.replace(/[:.]/g, '-')}-${createNonce()}`,
  );
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.renameSync(directory, destination);
  const record = {
    schema: 'harness-collab/lock-break/1',
    actor,
    reason,
    confirm_holder_stopped: true,
    at,
    previous_holder: before.holder,
    previous_holder_process_alive: before.holder_process_alive,
    uncommitted_transactions: (before.transaction_files ?? []).map((file) =>
      path.basename(file),
    ),
  };
  fs.writeFileSync(
    path.join(destination, 'break-record.json'),
    `${JSON.stringify(record, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  return { broken: true, evidence: destination, record };
}

/** Archive a leftover transaction file as evidence. A leftover file proves no commit happened. */
export function archiveAbortedTransaction(
  taskRoot: string,
  file: string,
  {
    actor,
    at = nowIso(),
  }: {
    actor?: string;
    reason?: string;
    confirmHolderStopped?: boolean;
    at?: string;
  } = {},
) {
  const suffix = path.basename(file);
  const destination = path.join(
    abortedDir(taskRoot),
    `${at.replace(/[:.]/g, '-')}-${suffix}`,
  );
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.renameSync(file, destination);
  const metaSource = file.replace(/\.json$/, '.meta.json');

  try {
    parseJson(fs.readFileSync(metaSource, 'utf8'));
    fs.renameSync(metaSource, destination.replace(/\.json$/, '.meta.json'));
  } catch {}
  fs.writeFileSync(
    `${destination}.note.json`,
    `${JSON.stringify(
      {
        schema: 'harness-collab/aborted-transaction/1',
        actor: actor ?? 'unattributed',
        at,
        note: 'Commit never happened: the transaction file still existed, so the rename did not run.',
      },
      null,
      2,
    )}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  return destination;
}

function assertRevision(expected: number | null | undefined, actual: number) {
  if (expected === undefined || expected === null) return;
  if (!Number.isSafeInteger(expected))
    throw new Error('expect_revision must be an integer');
  if (expected !== actual) throw new RevisionConflictError(expected, actual);
}

/**
 * Run one read-validate-write commit on the record.
 * `apply(record)` returns `{record, op, summary, result}`; returning `null` aborts the
 * transaction without touching the record. Returns `{ok, ...}`; revision conflicts and
 * held locks are reported instead of thrown so callers can reconcile.
 */
export function transact<T = unknown>(
  taskRoot: string,
  {
    actor = 'unattributed',
    purpose = 'unspecified',
    expectRevision,
    waitMs = 5000,
    apply,
    clock = Date.now(),
  }: {
    actor?: string;
    purpose?: string;
    expectRevision?: number | null | undefined;
    waitMs?: number;
    apply: (record: TaskRecord) => Mutation<T> | Failure | null | undefined;
    clock?: number;
  },
): TransactionResult<T> {
  if (typeof apply !== 'function')
    throw new Error('transact requires an apply function');
  let holder;
  try {
    holder = acquireLock(taskRoot, { actor, purpose, waitMs });
  } catch (error) {
    if (error instanceof LockHeldError)
      return { ok: false, reason: 'lock_held', holder: error.holder };
    throw error;
  }
  let committed = false;
  try {
    const current = readRecord(taskRoot);
    if (!current) return { ok: false, reason: 'not_initialised' };
    if (current.schema !== STATE_SCHEMA)
      return { ok: false, reason: 'unsupported_schema' };
    assertRevision(expectRevision, current.state_revision);
    const outcome = apply(structuredClone(current));
    if (outcome === null || outcome === undefined)
      return {
        ok: false,
        reason: 'rejected',
        state_revision: current.state_revision,
      };
    // A refusal that must still be recorded (a stale-epoch attempt, for example) sets
    // `commit: true`: the rejection is committed, the operation is still reported as refused.
    if (outcome.ok === false && outcome.commit !== true)
      return {
        ...outcome,
        ok: false,
        reason:
          typeof outcome.reason === 'string' ? outcome.reason : 'rejected',
        state_revision: current.state_revision,
      };
    const rejected = outcome.ok === false;
    if (!outcome.record || !isTaskRecord(outcome.record))
      throw new Error('Mutation must return a valid task record');
    const next = outcome.record;
    next.schema = STATE_SCHEMA;
    next.state_revision = current.state_revision + 1;
    next.updated_at = nowIso(clock);
    // The transaction file holds the next record itself, so the rename either commits
    // that exact record or leaves the previous one untouched.
    const transactionFile = path.join(
      lockPath(taskRoot),
      `txn-${current.state_revision + 1}-${holder.nonce}.json`,
    );
    const metadataFile = path.join(
      lockPath(taskRoot),
      `txn-${current.state_revision + 1}-${holder.nonce}.meta.json`,
    );
    const handle = fs.openSync(transactionFile, 'wx', 0o600);
    try {
      fs.writeSync(handle, `${JSON.stringify(next, null, 2)}\n`);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.writeFileSync(
      metadataFile,
      `${JSON.stringify(
        {
          schema: 'harness-collab/transaction/1',
          purpose,
          actor,
          base_revision: current.state_revision,
        },
        null,
        2,
      )}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    if (process.env.PAPPRA_FAULT === 'exit_before_rename') {
      // Documented test-only fault injection: leave an uncommitted transaction behind.
      process.exit(70);
    }
    fs.renameSync(transactionFile, recordPath(taskRoot));
    fs.rmSync(metadataFile, { force: true });
    committed = true;
    const rejection = rejected
      ? {
          ...outcome,
          ok: false as const,
          reason:
            typeof outcome.reason === 'string' ? outcome.reason : 'rejected',
          committed: true,
        }
      : null;
    const ledgerLine = {
      schema: LEDGER_SCHEMA,
      revision: next.state_revision,
      at: next.updated_at,
      actor,
      purpose,
      op: outcome.op ?? purpose,
      summary: outcome.summary ?? null,
      record_digest: digestText(JSON.stringify(next)),
    };
    fs.appendFileSync(ledgerPath(taskRoot), `${JSON.stringify(ledgerLine)}\n`, {
      mode: 0o600,
    });
    if (rejection)
      return {
        ...rejection,
        state_revision: next.state_revision,
        result: outcome.result ?? null,
        op: ledgerLine.op,
      };
    return {
      ok: true,
      state_revision: next.state_revision,
      result: outcome.result ?? null,
      op: ledgerLine.op,
    };
  } catch (error) {
    if (error instanceof RevisionConflictError) {
      return {
        ok: false,
        reason: 'revision_conflict',
        expected: error.expected,
        actual: error.actual,
      };
    }
    throw error;
  } finally {
    if (committed) {
      for (const item of listTransactions(taskRoot)) {
        // A committed transaction is gone; anything left here is an interrupted sibling commit.
        archiveAbortedTransaction(taskRoot, item.file, {
          actor,
          at: nowIso(clock),
        });
      }
      for (const name of fs
        .readdirSync(lockPath(taskRoot))
        .filter((entry) => entry.endsWith('.meta.json'))) {
        const sibling = path.join(
          lockPath(taskRoot),
          name.replace(/\.meta\.json$/, '.json'),
        );
        // A metadata file whose transaction already committed carries no uncommitted work.
        if (!fs.existsSync(sibling))
          fs.rmSync(path.join(lockPath(taskRoot), name), { force: true });
      }
    }
    releaseLock(taskRoot, holder);
  }
}

export function newRecord({
  taskId,
  domainRoot,
  taskRoot,
  coordinator,
  clock = Date.now(),
}: {
  taskId: string;
  domainRoot: string;
  taskRoot: string;
  coordinator?: Coordinator | null;
  clock?: number;
}): TaskRecord {
  return {
    schema: STATE_SCHEMA,
    task_id: taskId,
    domain_id: domainIdOf(domainRoot),
    domain_root: domainRoot,
    task_root: taskRoot,
    created_at: nowIso(clock),
    updated_at: nowIso(clock),
    state_revision: 1,
    coordinator: coordinator ?? null,
    input_revision: null,
    policy: {
      unknown_fields: 'ignored',
      unknown_message_type: 'rejected',
      attempt_key: 'task_id + subtask_id + attempt',
      single_native_manager: true,
    },
    attempts: [],
    messages: [],
    claims: [],
    handoffs: [],
    uncertainty: [],
    results: [],
    native: [],
  };
}

export function initTask(
  taskRoot: string,
  {
    taskId,
    coordinator,
    domainRoot: explicitDomainRoot = null,
    clock = Date.now(),
  }: {
    taskId: string;
    coordinator?: Coordinator | null;
    domainRoot?: string | null;
    clock?: number;
  },
) {
  fs.mkdirSync(taskRoot, { recursive: true, mode: 0o700 });
  const resolvedRoot = fs.realpathSync(taskRoot);
  const file = recordPath(resolvedRoot);
  if (fs.existsSync(file))
    return { created: false, record: readRecord(resolvedRoot) };
  const domainRoot = explicitDomainRoot
    ? fs.realpathSync(resolveDomainRoot(explicitDomainRoot))
    : fs.realpathSync(path.resolve(resolvedRoot, '..', '..'));
  for (const directory of [
    messagesDir(resolvedRoot),
    resultsDir(resolvedRoot),
    nativeDir(resolvedRoot),
    brokenLocksDir(resolvedRoot),
    abortedDir(resolvedRoot),
  ]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const record = newRecord({
    taskId,
    domainRoot,
    taskRoot: resolvedRoot,
    coordinator: coordinator ?? null,
    clock,
  });
  writeJsonAtomic(file, record);
  fs.writeFileSync(
    ledgerPath(taskRoot),
    `${JSON.stringify({
      schema: LEDGER_SCHEMA,
      revision: 1,
      at: record.created_at,
      actor: coordinator?.agent_id ?? 'unattributed',
      purpose: 'init',
      op: 'init',
      summary: null,
      record_digest: digestText(JSON.stringify(record)),
    })}\n`,
    { mode: 0o600 },
  );
  return { created: true, record };
}

/**
 * Inspect the record and its lock for interrupted work. Reporting only: nothing is
 * repaired, restarted or released here.
 */
export function doctor(taskRoot: string) {
  const findings: Finding[] = [];
  const lock = readLock(taskRoot);
  const record = readRecord(taskRoot);
  if (lock.held) {
    findings.push({
      code: 'lock_held',
      severity: lock.holder_process_alive ? 'active' : 'uncertain',
      detail: `lock holder pid ${lock.holder?.pid ?? 'unknown'} on ${lock.holder?.hostname ?? 'unknown'}`,
      holder: lock.holder,
    });
  }
  for (const item of listTransactions(taskRoot)) {
    findings.push({
      code: 'uncommitted_transaction',
      severity: 'uncertain',
      detail: `transaction for revision ${item.revision ?? 'unknown'} was never committed`,
      file: item.file,
    });
  }
  if (!record) {
    findings.push({
      code: 'record_missing',
      severity: 'invalid',
      detail: 'task.json is absent',
    });
    return { task_root: taskRoot, state_revision: null, findings };
  }
  if (record.schema !== STATE_SCHEMA)
    findings.push({
      code: 'unsupported_schema',
      severity: 'invalid',
      detail: String(record.schema),
    });
  const applied = new Set(
    (record.messages ?? []).map((message) => message.message_id),
  );
  let registered: string[] = [];
  try {
    registered = fs
      .readdirSync(messagesDir(taskRoot))
      .filter((name) => name.endsWith('.json'));
  } catch {
    registered = [];
  }
  for (const name of registered) {
    const messageId = name.slice(0, -'.json'.length);
    if (!applied.has(messageId)) {
      findings.push({
        code: 'message_registered_not_applied',
        severity: 'uncertain',
        detail: `message ${messageId} exists on disk but is not in the record`,
        message_id: messageId,
      });
    }
  }
  for (const entry of record.uncertainty ?? []) {
    if (!entry.resolved_at)
      findings.push({
        code: 'open_uncertainty',
        severity: 'uncertain',
        detail: entry.kind ?? 'unknown',
        uncertainty_id: entry.uncertainty_id,
      });
  }
  for (const attempt of record.attempts ?? []) {
    if (
      ['assigned', 'accepted', 'running', 'unknown'].includes(attempt.state)
    ) {
      const observation = attempt.native?.observation ?? 'unknown';
      if (observation !== 'confirmed') {
        findings.push({
          code: 'attempt_without_confirmed_native_state',
          severity: 'uncertain',
          detail: `${attempt.subtask_id}#${attempt.attempt} is ${attempt.state} with native observation ${observation}`,
          subtask_id: attempt.subtask_id,
          attempt: attempt.attempt,
        });
      }
    }
  }
  return {
    task_root: taskRoot,
    state_revision: record.state_revision,
    findings,
  };
}
