import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { getPackageInfo } from '../package-info.js';
import {
  observePath,
  readFileBounded,
  resolveRealpath,
  sha256Digest,
} from '../infra/fs.js';
import {
  workspaceInstallManifestSchema,
  type InstallJournal,
  type ManagedFileEntry,
} from '../schemas/install.js';
import {
  isPortableRelativePath,
  resolvePortableRelativePath,
} from '../schemas/paths.js';
import {
  acquireInstallLock,
  ensureStatePathBoundary,
  readInstallJournal,
  readJsonDocument,
  readWorkspaceManifest,
  removeOwnedFile,
  releaseInstallLock,
  scanJournalDirectory,
  workspaceInstallPaths,
  writeInstallJournal,
  writeBytesAtomic,
  writeWorkspaceManifest,
} from './ownership.js';
import { rollbackWorkspaceInstall } from './rollback.js';
import { persistedIdentityMatches } from '../infra/persisted-identity.js';
import {
  resolveUserDataDir,
  runtimePaths,
  verifyRuntimeForRepair,
} from './runtime.js';
import {
  inspectPrivateLock,
  reclaimDeadPrivateLock,
  type PrivateLockObservation,
} from '../infra/private-lock.js';
import { resolveWorkspaceRoot } from '../workspace/resolve.js';
import { isValidTaskId } from '../schemas/continuity.js';
import { resetLocalState, type LocalResetResult } from './reset-local.js';
import { assertRuntimeNotArchiving } from './runtime-archive-state.js';

export interface RepairOptions {
  readonly root: string;
  readonly runtimeVersion?: string;
  readonly installId?: string;
  readonly dataDir?: string;
  readonly apply?: boolean;
  /** Explicit operator assertion that every potentially affected writer has stopped. */
  readonly quarantineUnownedLocks?: boolean;
  readonly resetLocal?: boolean;
  readonly allWritersStopped?: boolean;
  /** Test-only dependency seam; never supplied by the CLI. */
  readonly afterLocalArchive?: () => Promise<void> | void;
}

export interface RepairEntry {
  readonly journal: string;
  readonly installId: string;
  readonly operation: string;
  readonly status: string;
}

export interface RepairResult {
  readonly ok: boolean;
  readonly mode: 'plan' | 'apply';
  readonly entries: readonly RepairEntry[];
  readonly repaired: readonly string[];
  readonly locks: readonly string[];
  readonly errors: readonly string[];
  readonly lockStates: readonly Pick<
    PrivateLockObservation,
    'file' | 'state'
  >[];
  readonly preserved: readonly string[];
  readonly quarantined: readonly string[];
  readonly reset: LocalResetResult | null;
}

/** A stale lock is reclaimed only on explicit repair and positive owner-death evidence. */
async function clearDeadLock(
  file: string,
  boundaryRoot: string,
  quarantineUnowned = false,
  quarantined?: string[],
): Promise<void> {
  const boundary = await ensureStatePathBoundary(boundaryRoot, file);
  if (!boundary.ok) throw new Error(boundary.message);
  const observation = await observePath(file);
  if (observation.kind === 'missing') return;
  if (observation.kind !== 'file')
    throw new Error(`Unsafe install lock: ${file}`);
  const owner = await inspectPrivateLock(file);
  if (owner.state === 'unknown' && quarantineUnowned) {
    quarantined?.push(await quarantineUnownedLock(file, boundaryRoot));
    return;
  }
  await reclaimDeadPrivateLock(file, async () => {
    const current = await ensureStatePathBoundary(boundaryRoot, file);
    if (!current.ok) throw new Error(current.message);
  });
}

/** An explicit operator escape preserves unknown evidence; it never asserts owner death. */
async function quarantineUnownedLock(
  file: string,
  root: string,
): Promise<string> {
  const check = async (): Promise<void> => {
    const boundary = await ensureStatePathBoundary(root, file);
    if (!boundary.ok) throw new Error(boundary.message);
  };
  await check();
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const original = await handle.stat();
    if (!original.isFile() || original.size > 64 * 1024)
      throw new Error('Unowned lock is unsafe or too large to quarantine.');
    const bytes = Buffer.alloc(64 * 1024 + 1);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead > 64 * 1024)
      throw new Error('Unowned lock grew during quarantine.');
    const directory = join(dirname(file), 'lock-quarantine');
    const allowed = await ensureStatePathBoundary(root, directory);
    if (!allowed.ok) throw new Error(allowed.message);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const parent = await observePath(directory);
    if (parent.kind !== 'directory' || parent.stats === null)
      throw new Error('Unsafe lock quarantine directory.');
    const target = join(directory, `${randomUUID()}.lock`);
    const receipt = await writeBytesAtomic(
      `${target}.json`,
      Buffer.from(
        `${JSON.stringify({ schema: 'pappra/unowned-lock-quarantine/1', original: file, dev: original.dev, ino: original.ino, digest: sha256Digest(bytes.subarray(0, read.bytesRead)), size: read.bytesRead, operator_asserted_all_writers_stopped: true, owner_death_proven: false, quarantined_at: new Date().toISOString() }, null, 2)}\n`,
      ),
      root,
    );
    if (!receipt.ok) throw new Error(receipt.message);
    await check();
    const current = await observePath(file);
    const currentParent = await observePath(directory);
    if (
      current.kind !== 'file' ||
      current.stats?.dev !== original.dev ||
      current.stats.ino !== original.ino ||
      current.stats.size !== original.size ||
      currentParent.kind !== 'directory' ||
      currentParent.stats?.dev !== parent.stats.dev ||
      currentParent.stats.ino !== parent.stats.ino ||
      !(await ensureStatePathBoundary(root, target)).ok
    )
      throw new Error(
        'Unowned lock or quarantine directory changed; preserve evidence.',
      );
    await rename(file, target);
    const moved = await observePath(target);
    if (
      moved.kind !== 'file' ||
      moved.stats?.dev !== original.dev ||
      moved.stats.ino !== original.ino
    )
      throw new Error(
        'Lock changed during quarantine; moved evidence was retained for inspection.',
      );
    return target;
  } finally {
    await handle.close();
  }
}

/** Bounded private lock inventory shared by doctor and explicit repair. */
export async function inspectWorkspaceLocks(
  root: string,
): Promise<readonly PrivateLockObservation[]> {
  const files = [
    workspaceInstallPaths(root).lockPath,
    join(root, '.pappra/local/knowledge/apply.lock'),
    join(root, '.pappra/local-archive/reset.lock'),
  ];
  const tasks = join(root, '.pappra/local/tasks');
  const boundary = await ensureStatePathBoundary(root, tasks);
  if (!boundary.ok) throw new Error(boundary.message);
  const observation = await observePath(tasks);
  if (observation.kind === 'directory') {
    const entries = await readdir(tasks, { withFileTypes: true });
    if (entries.length > 1000)
      throw new Error('Private task lock inventory exceeds 1000 entries.');
    for (const entry of entries) {
      if (entry.isSymbolicLink() && isValidTaskId(entry.name))
        throw new Error(`Private task directory is a symlink: ${entry.name}`);
      if (entry.isDirectory() && isValidTaskId(entry.name))
        files.push(join(tasks, entry.name, 'checkpoint.lock'));
    }
  } else if (observation.kind !== 'missing')
    throw new Error('Private task state directory is unsafe.');
  const results: PrivateLockObservation[] = [];
  for (const file of files) {
    const allowed = await ensureStatePathBoundary(root, file);
    if (!allowed.ok) throw new Error(allowed.message);
    const lock = await inspectPrivateLock(file);
    if (lock.state !== 'missing') results.push(lock);
  }
  return results;
}

async function finish(
  file: string,
  journal: InstallJournal,
  status: 'verified' | 'rolled-back',
  boundary: string,
): Promise<void> {
  const current = await readInstallJournal(file);
  if (
    current.value === null ||
    JSON.stringify(current.value) !== JSON.stringify(journal)
  ) {
    throw new Error(`Journal changed during repair: ${file}`);
  }
  const written = await writeInstallJournal(
    file,
    {
      ...journal,
      status,
      updatedAt: new Date().toISOString(),
      residuals: [],
      steps: [
        ...journal.steps,
        {
          name: 'explicit-repair',
          status: 'ok',
          at: new Date().toISOString(),
          detail: status,
        },
      ],
    },
    boundary,
  );
  if (!written.ok) throw new Error(written.message);
}

async function repairWorkspace(
  root: string,
  file: string,
  journal: InstallJournal,
): Promise<void> {
  if (journal.operation === 'rollback-workspace-files') {
    await repairInterruptedRollback(root, file, journal);
    return;
  }
  if (
    journal.workspaceRoot !== root ||
    !['apply-workspace-files', 'update-machine-runtime'].includes(
      journal.operation,
    )
  ) {
    throw new Error(`Unsupported or mismatched workspace journal: ${file}`);
  }
  if (journal.steps.some((step) => step.name === 'manifest-backup')) {
    await repairReconfiguration(root, file, journal);
    return;
  }
  // Missing pending files need no rollback. Existing files without recorded
  // identity remain uncertain and are preserved by the rollback implementation.
  const observations = await Promise.all(
    journal.entries.map(async (entry) => {
      const target = resolvePortableRelativePath(root, entry.path);
      const boundary = await ensureStatePathBoundary(root, target);
      if (!boundary.ok) throw new Error(boundary.message);
      return observePath(target);
    }),
  );
  if (
    journal.operation === 'apply-workspace-files' &&
    journal.entries.some(
      (entry, index) =>
        entry.identity === null && observations[index]?.kind === 'file',
    )
  ) {
    await retireUnprovenApply(root, file, journal);
    return;
  }
  const noEffects =
    journal.operation === 'apply-workspace-files' &&
    observations.every((observation) => observation.kind === 'missing');
  const lockPath = workspaceInstallPaths(root).lockPath;
  await clearDeadLock(lockPath, root);
  if (noEffects) {
    const lock = await acquireInstallLock(
      lockPath,
      'rollback-workspace-files',
      journal.installId,
      root,
    );
    if (!lock.ok || lock.lock === null)
      throw new Error(lock.message ?? 'Workspace is locked.');
    try {
      await assertJournalCurrent(file, journal);
      for (const entry of journal.entries) {
        const target = resolvePortableRelativePath(root, entry.path);
        if ((await observePath(target)).kind !== 'missing') {
          throw new Error(`Pending file appeared during repair: ${target}`);
        }
      }
      const manifest = await readWorkspaceManifest(root);
      const rootObservation = await observePath(root);
      if (
        manifest.diagnostics.length > 0 ||
        (manifest.value !== null &&
          (manifest.value.workspaceRoot !== root ||
            !persistedIdentityMatches(
              manifest.value.rootIdentity,
              rootObservation.stats,
            )))
      )
        throw new Error('Cannot verify ownership after interrupted rollback.');
      if (manifest.value !== null) {
        const owned = manifest.value.entries.filter(
          (entry) => entry.installId === journal.installId,
        );
        if (
          owned.some(
            (entry) =>
              !journal.entries.some(
                (item) =>
                  item.path === entry.path &&
                  item.digest === entry.afterDigest &&
                  item.identity !== null &&
                  persistedIdentityMatches(item.identity, entry.identity),
              ),
          )
        )
          throw new Error('Ownership no longer matches the source journal.');
        if (owned.length > 0) {
          const written = await writeWorkspaceManifest(root, {
            ...manifest.value,
            entries: manifest.value.entries.filter(
              (entry) => entry.installId !== journal.installId,
            ),
            updatedAt: new Date().toISOString(),
          });
          if (!written.ok) throw new Error(written.message);
        }
      }
      await finish(file, journal, 'rolled-back', root);
    } finally {
      const released = await releaseInstallLock(lockPath, lock.lock.token);
      if (!released.ok) throw new Error(released.message);
    }
    return;
  }
  const result = await rollbackWorkspaceInstall({
    root,
    installId: journal.installId,
  });
  if (!result.ok)
    throw new Error(
      result.diagnostics.map((entry) => entry.message).join('; ') ||
        `Rollback preserved uncertain files: ${result.residualPaths.join(', ')}`,
    );
  await finish(file, journal, 'rolled-back', root);
}

/** Retire only managed effects; files whose creation was never proved stay user-owned. */
async function retireUnprovenApply(
  root: string,
  file: string,
  source: InstallJournal,
): Promise<void> {
  if (
    source.entries.some(
      (entry) => entry.backupRef !== null || entry.backupDigest !== null,
    )
  )
    throw new Error(
      'Unproven replacement needs its original verified backup; no file was changed.',
    );
  const lockPath = workspaceInstallPaths(root).lockPath;
  await clearDeadLock(lockPath, root);
  const lock = await acquireInstallLock(
    lockPath,
    'rollback-workspace-files',
    source.installId,
    root,
  );
  if (!lock.ok || lock.lock === null)
    throw new Error(lock.message ?? 'Workspace is locked.');
  try {
    await assertJournalCurrent(file, source);
    const manifest = await readWorkspaceManifest(root);
    const rootState = await observePath(root);
    if (
      manifest.diagnostics.length ||
      (manifest.value !== null &&
        (manifest.value.workspaceRoot !== root ||
          !persistedIdentityMatches(
            manifest.value.rootIdentity,
            rootState.stats,
          )))
    )
      throw new Error(
        'Cannot verify workspace ownership for interrupted creation.',
      );
    const owned =
      manifest.value?.entries.filter(
        (entry) => entry.installId === source.installId,
      ) ?? [];
    if (
      owned.some(
        (entry) =>
          !source.entries.some(
            (item) =>
              item.path === entry.path && item.digest === entry.afterDigest,
          ),
      )
    )
      throw new Error('Source journal does not cover its manifest ownership.');
    const entries: InstallJournal['entries'] = [];
    const removals: ManagedFileEntry[] = [];
    for (const entry of source.entries) {
      const target = resolvePortableRelativePath(root, entry.path);
      const boundary = await ensureStatePathBoundary(root, target);
      if (!boundary.ok) throw new Error(boundary.message);
      const observed = await observePath(target);
      if (observed.kind === 'missing') {
        entries.push(entry);
        continue;
      }
      if (observed.kind !== 'file')
        throw new Error(`Unsafe interrupted apply target: ${target}`);
      const known = owned.find((item) => item.path === entry.path);
      if (entry.identity === null && known === undefined) {
        entries.push({
          ...entry,
          status: 'residual',
          detail: 'preserved-unproven-file',
        });
        continue;
      }
      const managed: ManagedFileEntry = known ?? {
        path: entry.path,
        installId: source.installId,
        operation: 'create',
        beforeDigest: null,
        afterDigest: entry.digest,
        backupRef: null,
        backupDigest: null,
        identity: entry.identity!,
        owner: 'pappra',
        verifiedAt: source.updatedAt,
      };
      const read = await readFileBounded(target);
      if (
        !read.ok ||
        read.value.digest !== managed.afterDigest ||
        !persistedIdentityMatches(managed.identity, observed.stats)
      )
        throw new Error(`Proven managed file changed; preserve ${target}`);
      removals.push(managed);
      entries.push(entry);
    }
    const prepared = await writeInstallJournal(
      file,
      {
        ...source,
        entries,
        steps: source.steps.some(
          (step) => step.name === 'preserve-unproven-files',
        )
          ? source.steps
          : [
              ...source.steps,
              {
                name: 'preserve-unproven-files',
                status: 'ok',
                at: new Date().toISOString(),
                detail:
                  'Files without creation identity remain in place and are not adopted as managed ownership.',
              },
            ],
      },
      root,
    );
    if (!prepared.ok) throw new Error(prepared.message);
    for (const entry of removals) {
      const removed = await removeOwnedFile(root, entry);
      if (!removed.ok) throw new Error(removed.message);
    }
    if (manifest.value !== null && owned.length > 0) {
      const updated = await writeWorkspaceManifest(root, {
        ...manifest.value,
        entries: manifest.value.entries.filter(
          (entry) => entry.installId !== source.installId,
        ),
      });
      if (!updated.ok) throw new Error(updated.message);
    }
    const current = (await readInstallJournal(file)).value;
    if (current === null)
      throw new Error('Interrupted apply journal became unreadable.');
    await finish(file, current, 'rolled-back', root);
  } finally {
    const released = await releaseInstallLock(lockPath, lock.lock.token);
    if (!released.ok) throw new Error(released.message);
  }
}

async function assertRollbackComplete(
  root: string,
  source: InstallJournal,
): Promise<void> {
  if (source.status !== 'rolled-back' || source.residuals.length > 0) {
    throw new Error('Source installation has not completed rollback.');
  }
  const manifest = await readWorkspaceManifest(root);
  const rootObservation = await observePath(root);
  if (
    manifest.diagnostics.length > 0 ||
    (manifest.value !== null &&
      (manifest.value.workspaceRoot !== root ||
        !persistedIdentityMatches(
          manifest.value.rootIdentity,
          rootObservation.stats,
        ) ||
        manifest.value.entries.some(
          (entry) => entry.installId === source.installId,
        )))
  )
    throw new Error('Source rollback ownership state cannot be verified.');
  for (const entry of source.entries) {
    if (entry.identity === null && entry.detail === 'preserved-unproven-file')
      continue;
    if (!isPortableRelativePath(entry.path))
      throw new Error('Unsafe source rollback path.');
    const target = resolvePortableRelativePath(root, entry.path);
    const boundary = await ensureStatePathBoundary(root, target);
    if (!boundary.ok) throw new Error(boundary.message);
    const observation = await observePath(target);
    if (entry.backupDigest === null) {
      if (observation.kind !== 'missing')
        throw new Error(`Source rollback target still exists: ${target}`);
      continue;
    }
    const owned = manifest.value?.entries.find(
      (item) => item.path === entry.path,
    );
    if (
      observation.kind !== 'file' ||
      owned?.afterDigest !== entry.backupDigest ||
      !persistedIdentityMatches(owned.identity, observation.stats)
    ) {
      throw new Error(
        `Source restoration ownership cannot be verified: ${target}`,
      );
    }
    const content = await readFileBounded(target);
    if (!content.ok || content.value.digest !== entry.backupDigest) {
      throw new Error(
        `Source restoration content cannot be verified: ${target}`,
      );
    }
  }
}

async function repairInterruptedRollback(
  root: string,
  file: string,
  journal: InstallJournal,
): Promise<void> {
  if (
    journal.workspaceRoot !== root ||
    journal.runtimeVersion !== null ||
    journal.manifestRef !== workspaceInstallPaths(root).manifestPath ||
    !z.uuid().safeParse(journal.target).success ||
    journal.target === journal.installId
  ) {
    throw new Error(`Invalid interrupted rollback journal: ${file}`);
  }
  const sourceFile = join(
    workspaceInstallPaths(root).journalsDir,
    `${journal.target}.json`,
  );
  if ((await observePath(sourceFile)).kind !== 'file')
    throw new Error('Source install journal is missing or unsafe.');
  const sourceRead = await readInstallJournal(sourceFile);
  const source = sourceRead.value;
  if (
    source === null ||
    source.installId !== journal.target ||
    source.workspaceRoot !== root ||
    (source.runtimeVersion !== null &&
      source.operation !== 'update-machine-runtime') ||
    !['apply-workspace-files', 'update-machine-runtime'].includes(
      source.operation,
    ) ||
    source.manifestRef !== workspaceInstallPaths(root).manifestPath ||
    journal.steps.some(
      (step) =>
        step.name.startsWith('recovered-from-') &&
        (step.detail !== source.installId ||
          step.name !==
            (source.operation === 'apply-workspace-files'
              ? 'recovered-from-apply-journal'
              : 'recovered-from-update-journal')),
    )
  ) {
    throw new Error(
      'Interrupted rollback does not identify a supported source install.',
    );
  }
  const knownResiduals = new Set([
    ...source.entries.map((entry) => entry.path),
    file,
    workspaceInstallPaths(root).manifestPath,
    workspaceInstallPaths(root).lockPath,
  ]);
  if (
    journal.residuals.some((path) => !knownResiduals.has(path)) ||
    journal.entries.some((entry) => {
      const origin = source.entries.find((item) => item.path === entry.path);
      return (
        origin === undefined ||
        (source.operation === 'apply-workspace-files'
          ? entry.digest !== origin.digest ||
            entry.backupRef !== origin.backupRef ||
            entry.backupDigest !== origin.backupDigest ||
            (entry.identity === null) !== (origin.identity === null) ||
            (entry.identity !== null &&
              origin.identity !== null &&
              !persistedIdentityMatches(entry.identity, origin.identity))
          : entry.digest !== origin.backupDigest ||
            entry.backupRef !== null ||
            entry.backupDigest !== null)
      );
    })
  )
    throw new Error(
      'Interrupted rollback entries do not match the source install.',
    );
  if (source.status !== 'rolled-back')
    await repairWorkspace(root, sourceFile, source);
  const recovered = (await readInstallJournal(sourceFile)).value;
  if (recovered === null)
    throw new Error('Recovered source journal is unreadable.');
  const lockPath = workspaceInstallPaths(root).lockPath;
  await clearDeadLock(lockPath, root);
  const lock = await acquireInstallLock(
    lockPath,
    'rollback-workspace-files',
    source.installId,
    root,
  );
  if (!lock.ok || lock.lock === null)
    throw new Error(lock.message ?? 'Workspace is locked.');
  try {
    await assertJournalCurrent(file, journal);
    await assertJournalCurrent(sourceFile, recovered);
    await assertRollbackComplete(root, recovered);
    await finish(file, journal, 'rolled-back', root);
  } finally {
    const released = await releaseInstallLock(lockPath, lock.lock.token);
    if (!released.ok) throw new Error(released.message);
  }
}

async function repairReconfiguration(
  root: string,
  file: string,
  journal: InstallJournal,
): Promise<void> {
  const backupRef = journal.steps.find(
    (step) => step.name === 'manifest-backup',
  )?.detail;
  const backupDigest = journal.steps.find(
    (step) => step.name === 'manifest-backup-digest',
  )?.detail;
  if (!backupRef || !isPortableRelativePath(backupRef))
    throw new Error('Invalid ownership backup path.');
  const backupFile = resolvePortableRelativePath(root, backupRef);
  const boundary = await ensureStatePathBoundary(root, backupFile);
  if (!boundary.ok || (await observePath(backupFile)).kind !== 'file')
    throw new Error('Unsafe ownership backup.');
  const baseline = await readJsonDocument(
    backupFile,
    workspaceInstallManifestSchema,
  );
  const rootObservation = await observePath(root);
  if (
    baseline.value === null ||
    baseline.digest !== backupDigest ||
    baseline.value.workspaceRoot !== root ||
    !persistedIdentityMatches(
      baseline.value.rootIdentity,
      rootObservation.stats,
    )
  ) {
    throw new Error('Ownership backup does not match this workspace.');
  }
  const lockPath = workspaceInstallPaths(root).lockPath;
  await clearDeadLock(lockPath, root);
  const lock = await acquireInstallLock(
    lockPath,
    'rollback-workspace-files',
    journal.installId,
    root,
  );
  if (!lock.ok || lock.lock === null)
    throw new Error(lock.message ?? 'Workspace is locked.');
  try {
    await assertJournalCurrent(file, journal);
    const actions: {
      entry: InstallJournal['entries'][number];
      target: string;
      bytes: Buffer | null;
    }[] = [];
    for (const entry of journal.entries) {
      if (!isPortableRelativePath(entry.path))
        throw new Error(`Unsafe journal path: ${entry.path}`);
      const target = resolvePortableRelativePath(root, entry.path);
      const targetBoundary = await ensureStatePathBoundary(root, target);
      if (!targetBoundary.ok) throw new Error(targetBoundary.message);
      const current = await observePath(target);
      if (current.kind === 'missing' && entry.backupRef === null) continue;
      if (current.kind !== 'file')
        throw new Error(`Unsafe recovery target: ${target}`);
      const content = await readFileBounded(target);
      if (!content.ok) throw new Error(content.message);
      if (
        entry.backupDigest !== null &&
        content.value.digest === entry.backupDigest
      )
        continue;
      if (
        entry.identity === null ||
        !persistedIdentityMatches(entry.identity, current.stats) ||
        content.value.digest !== entry.digest
      ) {
        throw new Error(`Recovery target changed; it was preserved: ${target}`);
      }
      let bytes: Buffer | null = null;
      if (entry.backupRef !== null) {
        if (!isPortableRelativePath(entry.backupRef))
          throw new Error('Unsafe replacement backup path.');
        const backup = resolvePortableRelativePath(root, entry.backupRef);
        if (
          !(await ensureStatePathBoundary(root, backup)).ok ||
          (await observePath(backup)).kind !== 'file'
        ) {
          throw new Error(`Unsafe replacement backup: ${backup}`);
        }
        const read = await readFileBounded(backup);
        if (!read.ok || sha256Digest(read.value.bytes) !== entry.backupDigest)
          throw new Error(`Replacement backup changed: ${backup}`);
        bytes = read.value.bytes;
      }
      actions.push({ entry, target, bytes });
    }
    for (const action of actions) {
      if (action.bytes !== null) {
        const restored = await writeBytesAtomic(
          action.target,
          action.bytes,
          root,
        );
        if (!restored.ok) throw new Error(restored.message);
      } else {
        const owned: ManagedFileEntry = {
          path: action.entry.path,
          installId: journal.installId,
          operation: 'create',
          beforeDigest: null,
          afterDigest: action.entry.digest,
          backupRef: null,
          backupDigest: null,
          identity: action.entry.identity!,
          owner: 'pappra',
          verifiedAt: journal.updatedAt,
        };
        const removed = await removeOwnedFile(root, owned);
        if (!removed.ok) throw new Error(removed.message);
      }
    }
    const entries = await Promise.all(
      baseline.value.entries.map(async (entry) => {
        if (
          !journal.entries.some(
            (item) => item.path === entry.path && item.backupRef !== null,
          )
        )
          return entry;
        const observation = await observePath(
          resolvePortableRelativePath(root, entry.path),
        );
        if (observation.kind !== 'file' || observation.stats === null)
          throw new Error('Restored target is unreadable.');
        // Reconfiguration may start from a manually edited configuration. Its
        // exact pre-reconfiguration bytes, rather than an older digest, are restored.
        const prior = journal.entries.find((item) => item.path === entry.path)!;
        return {
          ...entry,
          afterDigest: prior.backupDigest!,
          identity: { dev: observation.stats.dev, ino: observation.stats.ino },
        };
      }),
    );
    const restored = await writeWorkspaceManifest(root, {
      ...baseline.value,
      entries,
      updatedAt: new Date().toISOString(),
    });
    if (!restored.ok) throw new Error(restored.message);
    await finish(file, journal, 'rolled-back', root);
  } finally {
    const released = await releaseInstallLock(lockPath, lock.lock.token);
    if (!released.ok) throw new Error(released.message);
  }
}

async function repairRuntime(
  dataDir: string,
  version: string,
  file: string,
  journal: InstallJournal,
): Promise<void> {
  const paths = runtimePaths(version, dataDir);
  await assertRuntimeNotArchiving(dataDir, version);
  if (
    journal.operation !== 'install-runtime' ||
    journal.runtimeVersion !== version ||
    journal.workspaceRoot !== null ||
    journal.target !== paths.runtimeRoot ||
    journal.manifestRef !== join(paths.runtimeRoot, 'install-manifest.json')
  ) {
    throw new Error(`Mismatched runtime journal: ${file}`);
  }
  await clearDeadLock(paths.lockPath, dataDir);
  const lock = await acquireInstallLock(
    paths.lockPath,
    'install-runtime',
    paths.runtimeRoot,
    dataDir,
  );
  if (!lock.ok || lock.lock === null)
    throw new Error(lock.message ?? 'Runtime is locked.');
  try {
    await assertJournalCurrent(file, journal);
    const boundary = await ensureStatePathBoundary(dataDir, paths.runtimeRoot);
    if (!boundary.ok) throw new Error(boundary.message);
    const published = await observePath(paths.runtimeRoot);
    if (published.kind !== 'missing') {
      if (
        published.kind !== 'directory' ||
        !(await verifyRuntimeForRepair(
          paths.runtimeRoot,
          version,
          getPackageInfo().name,
          journal.installId,
        ))
      )
        throw new Error(
          `Published runtime cannot be verified; it was preserved: ${paths.runtimeRoot}`,
        );
      await finish(file, journal, 'verified', dataDir);
      return;
    }
    const stage = join(paths.stagingRoot, journal.installId);
    const stageBoundary = await ensureStatePathBoundary(dataDir, stage);
    if (!stageBoundary.ok) throw new Error(stageBoundary.message);
    const staged = await observePath(stage);
    if (staged.kind !== 'missing') {
      if (
        staged.kind !== 'directory' ||
        !journal.steps.some(
          (step) =>
            step.name === 'staging-created' &&
            step.status === 'ok' &&
            step.detail === stage,
        )
      )
        throw new Error(`Staging ownership cannot be verified: ${stage}`);
      await rm(stage, { recursive: true, force: false });
    }
    await finish(file, journal, 'rolled-back', dataDir);
  } finally {
    const released = await releaseInstallLock(paths.lockPath, lock.lock.token);
    if (!released.ok) throw new Error(released.message);
  }
}

/** Explicit, bounded journal recovery. Preview never removes a lock or changes state. */
export async function repairInstall(
  options: RepairOptions,
): Promise<RepairResult> {
  const entries: RepairEntry[] = [];
  const repaired: string[] = [];
  const errors: string[] = [];
  const locks: string[] = [];
  const lockStates: PrivateLockObservation[] = [];
  const preserved: string[] = [];
  const quarantined: string[] = [];
  let reset: LocalResetResult | null = null;
  const mode = options.apply === true ? 'apply' : 'plan';
  try {
    if (
      options.installId !== undefined &&
      !z.uuid().safeParse(options.installId).success
    ) {
      throw new Error('Use an exact journal install UUID.');
    }
    if (
      options.runtimeVersion !== undefined &&
      !/^[0-9A-Za-z][0-9A-Za-z0-9._+-]{0,127}$/.test(options.runtimeVersion)
    ) {
      throw new Error('Use an exact runtime version without path separators.');
    }
    const runtime = options.runtimeVersion !== undefined;
    const resolution = runtime
      ? null
      : await resolveWorkspaceRoot({ startPath: options.root });
    const root = runtime
      ? resolve(options.dataDir ?? resolveUserDataDir())
      : (resolution?.root ?? (await resolveRealpath(options.root)));
    if (root === null) throw new Error('Workspace root does not exist.');
    if (runtime) await assertRuntimeNotArchiving(root, options.runtimeVersion!);
    if (options.resetLocal === true) {
      if (runtime || options.installId !== undefined)
        throw new Error(
          'Local reset cannot target a runtime version or install ID.',
        );
      lockStates.push(...(await inspectWorkspaceLocks(root)));
      locks.push(...lockStates.map((state) => state.file));
      reset = await resetLocalState(root, {
        apply: options.apply === true,
        allWritersStopped: options.allWritersStopped === true,
        assertNoLiveLocks: async () => {
          const current = await inspectWorkspaceLocks(root);
          if (
            current.some(
              (state) =>
                state.state === 'alive' &&
                state.file !== join(root, '.pappra/local-archive/reset.lock'),
            )
          )
            throw new Error(
              'A live writer lock prevents local reset; stop it first.',
            );
        },
        recoverUnknownResetLock: async (file) => {
          await clearDeadLock(file, root, true, quarantined);
        },
        ...(options.afterLocalArchive === undefined
          ? {}
          : { afterArchive: options.afterLocalArchive }),
      });
      return {
        ok: true,
        mode,
        entries,
        repaired: options.apply ? [join(root, '.pappra/local')] : [],
        locks,
        errors,
        lockStates: lockStates.map(({ file, state }) => ({ file, state })),
        preserved: reset.archive === null ? [] : [reset.archive],
        quarantined,
        reset,
      };
    }
    const directory = runtime
      ? runtimePaths(options.runtimeVersion!, root).journalsDir
      : workspaceInstallPaths(root).journalsDir;
    const boundary = await ensureStatePathBoundary(root, directory);
    if (!boundary.ok) throw new Error(boundary.message);
    const lockPath = runtime
      ? runtimePaths(options.runtimeVersion!, root).lockPath
      : workspaceInstallPaths(root).lockPath;
    if (runtime) {
      const state = await inspectPrivateLock(lockPath);
      if (state.state !== 'missing') lockStates.push(state);
    } else lockStates.push(...(await inspectWorkspaceLocks(root)));
    locks.push(...lockStates.map((state) => state.file));
    const scan = await scanJournalDirectory(directory);
    if (scan.kind === 'unreadable' || scan.nonRegular.length > 0) {
      throw new Error(`Unsafe or unreadable journal directory: ${directory}`);
    }
    const candidates: { file: string; journal: InstallJournal }[] = [];
    for (const file of scan.files) {
      const read = await readInstallJournal(file);
      if (read.value === null) throw new Error(`Unreadable journal: ${file}`);
      const journal = read.value;
      if (file !== join(directory, `${journal.installId}.json`)) {
        throw new Error(`Journal filename and identity disagree: ${file}`);
      }
      if (runtime && journal.runtimeVersion !== options.runtimeVersion)
        continue;
      if (
        options.installId !== undefined &&
        journal.installId !== options.installId
      )
        continue;
      if (journal.status === 'verified' || journal.status === 'rolled-back')
        continue;
      candidates.push({ file, journal });
      entries.push({
        journal: file,
        installId: journal.installId,
        operation: journal.operation,
        status: journal.status,
      });
    }
    if (options.installId !== undefined && candidates.length === 0) {
      throw new Error('No incomplete journal matches this install ID.');
    }
    if (options.apply === true) {
      if (runtime)
        await assertRuntimeNotArchiving(root, options.runtimeVersion!);
      if (options.quarantineUnownedLocks === true) {
        for (const state of lockStates.filter(
          (item) => item.state === 'unknown',
        ))
          await clearDeadLock(state.file, root, true, quarantined);
      }
      for (const state of lockStates.filter((item) => item.file !== lockPath)) {
        await clearDeadLock(state.file, root);
        repaired.push(state.file);
      }
      if (candidates.length === 0 && locks.length > 0) {
        await clearDeadLock(lockPath, root);
        repaired.push(lockPath);
      }
      for (const { file, journal } of candidates) {
        const current = (await readInstallJournal(file)).value;
        if (
          current === null ||
          current.installId !== journal.installId ||
          current.operation !== journal.operation ||
          current.workspaceRoot !== journal.workspaceRoot ||
          current.target !== journal.target ||
          current.runtimeVersion !== journal.runtimeVersion ||
          current.manifestRef !== journal.manifestRef
        ) {
          throw new Error(`Journal identity changed during repair: ${file}`);
        }
        if (
          current !== null &&
          (current.status === 'rolled-back' || current.status === 'verified')
        ) {
          repaired.push(file);
          continue;
        }
        await assertJournalCurrent(file, journal);
        if (runtime)
          await repairRuntime(root, options.runtimeVersion!, file, journal);
        else await repairWorkspace(root, file, journal);
        const completed = (await readInstallJournal(file)).value;
        for (const entry of completed?.entries ?? [])
          if (entry.detail === 'preserved-unproven-file')
            preserved.push(entry.path);
        repaired.push(file);
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return {
    ok: errors.length === 0,
    mode,
    entries,
    repaired,
    locks,
    errors,
    lockStates: lockStates.map(({ file, state }) => ({ file, state })),
    preserved,
    quarantined,
    reset,
  };
}

async function assertJournalCurrent(
  file: string,
  journal: InstallJournal,
): Promise<void> {
  const current = await readInstallJournal(file);
  if (
    current.value === null ||
    JSON.stringify(current.value) !== JSON.stringify(journal)
  ) {
    throw new Error(`Journal changed during repair: ${file}`);
  }
}
