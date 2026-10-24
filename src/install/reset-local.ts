import { randomUUID } from 'node:crypto';
import { readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { observePath, readFileBounded } from '../infra/fs.js';
import { ensurePrivateState } from '../infra/private-state.js';
import {
  inspectPrivateLock,
  publishPrivateLock,
  reclaimDeadPrivateLock,
} from '../infra/private-lock.js';
import {
  captureProcessIdentity,
  isLocalProcessIdentity,
  observeProcessIdentity,
} from '../infra/process-identity.js';
import {
  ensureStatePathBoundary,
  readJsonDocument,
  releaseInstallLock,
  writeJsonAtomic,
} from './ownership.js';

const identitySchema = z.strictObject({
  dev: z.number().int().nonnegative(),
  ino: z.number().int().nonnegative(),
});
const resetSchema = z.strictObject({
  schema: z.literal('pappra/local-reset/1'),
  id: z.uuid(),
  root: z.string(),
  archive: z.string(),
  source: identitySchema,
  fresh: identitySchema.nullable(),
  status: z.enum(['prepared', 'archived', 'fresh']),
  createdAt: z.string(),
  allWritersStopped: z.literal(true),
  ownership: z.literal('operator-assertion-and-bounded-live-owner-checks'),
});
type ResetJournal = z.infer<typeof resetSchema>;
export interface LocalResetResult {
  readonly status: 'planned' | 'reset' | 'no-local-state';
  readonly archive: string | null;
  readonly resumed: boolean;
}
export interface LocalResetOptions {
  readonly apply: boolean;
  readonly allWritersStopped: boolean;
  readonly assertNoLiveLocks: () => Promise<void>;
  /** Explicit dependency seam used only by hard-crash tests. */
  readonly afterArchive?: () => Promise<void> | void;
  readonly recoverUnknownResetLock?: (file: string) => Promise<void>;
}

export async function inspectLocalResetState(
  root: string,
): Promise<'none' | 'pending' | 'complete' | 'unreadable'> {
  try {
    const file = join(root, '.pappra/local-archive/pending-reset.json');
    const boundary = await ensureStatePathBoundary(root, file);
    if (!boundary.ok) return 'unreadable';
    const read = await readJsonDocument(file, resetSchema);
    if (!read.exists) return 'none';
    if (read.value === null || read.value.root !== root) return 'unreadable';
    return read.value.status === 'fresh' ? 'complete' : 'pending';
  } catch {
    return 'unreadable';
  }
}

async function assertNoLiveManagedOwners(root: string): Promise<void> {
  const local = join(root, '.pappra/local');
  let seen = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 12)
      throw new Error('Managed ownership inventory exceeds its depth bound.');
    const boundary = await ensureStatePathBoundary(root, directory);
    if (!boundary.ok) throw new Error(boundary.message);
    const observation = await observePath(directory);
    if (observation.kind === 'missing') return;
    if (observation.kind !== 'directory')
      throw new Error('Private state directory is redirected or unsafe.');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++seen > 5000)
        throw new Error('Managed ownership inventory exceeds 5000 entries.');
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (
          ![
            'transcripts',
            'pi-sessions',
            'checkpoints',
            'patches',
            'node_modules',
          ].includes(entry.name)
        )
          await walk(join(directory, entry.name), depth + 1);
        continue;
      }
      if (entry.name !== 'task.json' || !entry.isFile()) continue;
      const read = await readFileBounded(
        join(directory, entry.name),
        1024 * 1024,
      );
      if (!read.ok)
        throw new Error(
          'Managed task metadata cannot be inspected; preserve local state.',
        );
      let record: unknown;
      try {
        record = JSON.parse(read.value.bytes.toString('utf8'));
      } catch {
        continue;
      }
      if (
        typeof record !== 'object' ||
        record === null ||
        !('managed_pi_runtime_registry' in record) ||
        !Array.isArray(record.managed_pi_runtime_registry)
      )
        continue;
      for (const owner of record.managed_pi_runtime_registry as unknown[]) {
        if (
          typeof owner !== 'object' ||
          owner === null ||
          !('pid' in owner) ||
          typeof owner.pid !== 'number' ||
          !Number.isSafeInteger(owner.pid) ||
          owner.pid <= 0
        )
          continue;
        if (
          'process_identity' in owner &&
          isLocalProcessIdentity(owner.process_identity)
        ) {
          if (
            owner.process_identity.pid === owner.pid &&
            observeProcessIdentity(owner.process_identity) === 'alive'
          )
            throw new Error(
              'A verified live managed session still owns local state. Stop it before reset.',
            );
        }
        // Imported PID-only registrations cannot identify a process birth; the
        // explicit stopped-writers assertion covers this unknown, never an adoption.
      }
    }
  };
  await walk(local, 0);
}

function sameIdentity(
  actual: Awaited<ReturnType<typeof observePath>>,
  expected: ResetJournal['source'],
): boolean {
  return (
    actual.kind === 'directory' &&
    actual.stats?.dev === expected.dev &&
    actual.stats.ino === expected.ino
  );
}

/** Explicit fresh beta state; old bytes are archived, never migrated or deleted. */
export async function resetLocalState(
  root: string,
  options: LocalResetOptions,
): Promise<LocalResetResult> {
  const local = join(root, '.pappra/local');
  const archiveRoot = join(root, '.pappra/local-archive');
  const journalFile = join(archiveRoot, 'pending-reset.json');
  const lockFile = join(archiveRoot, 'reset.lock');
  const old = await observePath(local);
  const allowed = await ensureStatePathBoundary(root, local);
  if (!allowed.ok || !['missing', 'directory'].includes(old.kind))
    throw new Error('Local state is redirected or is not a directory.');
  if (!options.apply)
    return { status: 'planned', archive: null, resumed: false };
  if (!options.allWritersStopped)
    throw new Error(
      'Local reset requires --apply --all-writers-stopped after stopping every affected writer.',
    );
  await options.assertNoLiveLocks();
  await assertNoLiveManagedOwners(root);
  const privateArchive = await ensurePrivateState(root, 'local-archive');
  if (!privateArchive.ok) throw new Error(privateArchive.message);
  const namespace = await Promise.all(
    [root, join(root, '.pappra'), archiveRoot].map(async (path) => {
      const observed = await observePath(path);
      if (observed.kind !== 'directory' || observed.stats === null)
        throw new Error('Reset namespace is not a real directory.');
      return {
        path,
        identity: { dev: observed.stats.dev, ino: observed.stats.ino },
      };
    }),
  );
  let ownedLock: { dev: number; ino: number } | null = null;
  const token = randomUUID();
  const assertPinned = async (): Promise<void> => {
    for (const item of namespace)
      if (!sameIdentity(await observePath(item.path), item.identity))
        throw new Error(
          'Reset namespace identity changed; retained state was preserved.',
        );
    if (ownedLock !== null) {
      const current = await inspectPrivateLock(lockFile);
      if (
        current.token !== token ||
        current.identity?.dev !== ownedLock.dev ||
        current.identity.ino !== ownedLock.ino
      )
        throw new Error(
          'Reset ownership changed; no further state is published.',
        );
    }
  };
  const saveJournal = async (journal: ResetJournal): Promise<void> => {
    await assertPinned();
    const saved = await writeJsonAtomic(journalFile, journal, root);
    if (!saved.ok) throw new Error(saved.message);
    await assertPinned();
  };
  const acquire = async () =>
    publishPrivateLock(
      lockFile,
      Buffer.from(
        `${JSON.stringify({ schema: 'pappra/install-lock/1', token, pid: process.pid, process_identity: captureProcessIdentity() ?? undefined, operation: 'rollback-workspace-files', target: root, createdAt: new Date().toISOString() })}\n`,
      ),
      async () => {
        await assertPinned();
        const boundary = await ensureStatePathBoundary(root, lockFile);
        if (!boundary.ok) throw new Error(boundary.message);
      },
    );
  try {
    await acquire();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const owner = await inspectPrivateLock(lockFile);
    if (
      owner.state === 'unknown' &&
      options.recoverUnknownResetLock !== undefined
    ) {
      await options.recoverUnknownResetLock(lockFile);
    } else {
      if (owner.state !== 'dead')
        throw new Error('Another reset owner is alive or unverified.');
      await reclaimDeadPrivateLock(lockFile, async () => {
        await assertPinned();
        const boundary = await ensureStatePathBoundary(root, lockFile);
        if (!boundary.ok) throw new Error(boundary.message);
      });
    }
    await acquire();
  }
  const acquired = await inspectPrivateLock(lockFile);
  if (acquired.token !== token || acquired.identity === null)
    throw new Error('Reset lock identity is unavailable.');
  ownedLock = acquired.identity;
  try {
    await options.assertNoLiveLocks();
    await assertNoLiveManagedOwners(root);
    const journalBoundary = await ensureStatePathBoundary(root, journalFile);
    if (!journalBoundary.ok) throw new Error(journalBoundary.message);
    await assertPinned();
    if (!['missing', 'file'].includes((await observePath(journalFile)).kind))
      throw new Error('Reset journal is redirected or not a regular file.');
    const pending = await readJsonDocument(journalFile, resetSchema);
    if (pending.exists && pending.value === null) {
      if ((await observePath(journalFile)).kind !== 'file')
        throw new Error('Reset journal is not a regular file.');
      await rename(
        journalFile,
        join(archiveRoot, `unreadable-reset-${randomUUID()}.json`),
      );
    }
    let journal = pending.value;
    let resumed = journal !== null && journal.status !== 'fresh';
    if (journal !== null && journal.root !== root) {
      // Imported private metadata is evidence, not an instruction to touch its old absolute root.
      await rename(
        journalFile,
        join(archiveRoot, `imported-reset-${randomUUID()}.json`),
      );
      journal = null;
      resumed = false;
    }
    if (journal?.status === 'fresh') {
      const now = await observePath(local);
      if (
        journal.fresh !== null &&
        sameIdentity(now, journal.fresh) &&
        (await readdir(local)).every((name) => name === '.gitignore')
      )
        return { status: 'reset', archive: journal.archive, resumed: true };
      await rename(journalFile, join(archiveRoot, `reset-${journal.id}.json`));
      journal = null;
      resumed = false;
    }
    if (journal === null) {
      const source = await observePath(local);
      if (source.kind === 'missing') {
        const fresh = await ensurePrivateState(root);
        if (!fresh.ok) throw new Error(fresh.message);
        return { status: 'no-local-state', archive: null, resumed: false };
      }
      if (source.kind !== 'directory' || source.stats === null)
        throw new Error('Local state changed before reset.');
      const id = randomUUID();
      journal = {
        schema: 'pappra/local-reset/1',
        id,
        root,
        archive: join(archiveRoot, id),
        source: { dev: source.stats.dev, ino: source.stats.ino },
        fresh: null,
        status: 'prepared',
        createdAt: new Date().toISOString(),
        allWritersStopped: true,
        ownership: 'operator-assertion-and-bounded-live-owner-checks',
      };
      await saveJournal(journal);
    }
    if (journal.archive !== join(archiveRoot, journal.id))
      throw new Error(
        'Reset archive path does not match the pinned local namespace.',
      );
    let archived = await observePath(journal.archive);
    const source = await observePath(local);
    if (archived.kind === 'missing') {
      if (!sameIdentity(source, journal.source))
        throw new Error(
          'Original local state identity changed before archival.',
        );
      await options.assertNoLiveLocks();
      await assertNoLiveManagedOwners(root);
      const boundary = await ensureStatePathBoundary(root, journal.archive);
      if (!boundary.ok) throw new Error(boundary.message);
      await assertPinned();
      if (!sameIdentity(await observePath(local), journal.source))
        throw new Error(
          'Original local state changed immediately before archival.',
        );
      await rename(local, journal.archive);
      await assertPinned();
      archived = await observePath(journal.archive);
      if (!sameIdentity(archived, journal.source))
        throw new Error(
          'Archived local state identity changed; preserved for inspection.',
        );
      await options.afterArchive?.();
    } else if (
      !sameIdentity(archived, journal.source) ||
      sameIdentity(source, journal.source)
    )
      throw new Error(
        'Reset archive/source identity is ambiguous; both were preserved.',
      );
    journal = { ...journal, status: 'archived' };
    await saveJournal(journal);
    const fresh = await ensurePrivateState(root);
    if (!fresh.ok) throw new Error(fresh.message);
    const created = await observePath(local);
    if (
      created.kind !== 'directory' ||
      created.stats === null ||
      sameIdentity(created, journal.source)
    )
      throw new Error('Fresh local state identity is unavailable.');
    await saveJournal({
      ...journal,
      status: 'fresh',
      fresh: { dev: created.stats.dev, ino: created.stats.ino },
    });
    return { status: 'reset', archive: journal.archive, resumed };
  } finally {
    await assertPinned();
    const released = await releaseInstallLock(lockFile, token);
    if (!released.ok) throw new Error(released.message);
  }
}
