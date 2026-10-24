import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { getPackageInfo } from '../package-info.js';
import {
  observePath,
  readFileBounded,
  resolveRealpath,
  sha256Digest,
} from '../infra/fs.js';
import {
  installLockSchema,
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
import {
  resolveUserDataDir,
  runtimePaths,
  verifyRuntimeForRepair,
} from './runtime.js';

export interface RepairOptions {
  readonly root: string;
  readonly runtimeVersion?: string;
  readonly installId?: string;
  readonly dataDir?: string;
  readonly apply?: boolean;
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
}

function ownerIsDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH';
  }
}

/** A stale lock is reclaimed only on explicit repair and positive owner-death evidence. */
async function clearDeadLock(
  file: string,
  boundaryRoot: string,
): Promise<void> {
  const boundary = await ensureStatePathBoundary(boundaryRoot, file);
  if (!boundary.ok) throw new Error(boundary.message);
  const observation = await observePath(file);
  if (observation.kind === 'missing') return;
  if (observation.kind !== 'file')
    throw new Error(`Unsafe install lock: ${file}`);
  const read = await readJsonDocument(file, installLockSchema);
  if (read.value === null || !ownerIsDead(read.value.pid)) {
    throw new Error(
      `Install lock owner is alive or cannot be verified: ${file}`,
    );
  }
  const released = await releaseInstallLock(file, read.value.token);
  if (!released.ok) throw new Error(released.message);
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
            manifest.value.rootIdentity.dev !== rootObservation.stats?.dev ||
            manifest.value.rootIdentity.ino !== rootObservation.stats?.ino))
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
                  item.identity?.dev === entry.identity.dev &&
                  item.identity.ino === entry.identity.ino,
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
        manifest.value.rootIdentity.dev !== rootObservation.stats?.dev ||
        manifest.value.rootIdentity.ino !== rootObservation.stats?.ino ||
        manifest.value.entries.some(
          (entry) => entry.installId === source.installId,
        )))
  )
    throw new Error('Source rollback ownership state cannot be verified.');
  for (const entry of source.entries) {
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
      owned.identity.dev !== observation.stats?.dev ||
      owned.identity.ino !== observation.stats?.ino
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
            entry.identity?.dev !== origin.identity?.dev ||
            entry.identity?.ino !== origin.identity?.ino
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
    baseline.value.rootIdentity.dev !== rootObservation.stats?.dev ||
    baseline.value.rootIdentity.ino !== rootObservation.stats?.ino
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
        current.stats?.dev !== entry.identity.dev ||
        current.stats.ino !== entry.identity.ino ||
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
    const root = runtime
      ? resolve(options.dataDir ?? resolveUserDataDir())
      : await resolveRealpath(options.root);
    if (root === null) throw new Error('Workspace root does not exist.');
    const directory = runtime
      ? runtimePaths(options.runtimeVersion!, root).journalsDir
      : workspaceInstallPaths(root).journalsDir;
    const boundary = await ensureStatePathBoundary(root, directory);
    if (!boundary.ok) throw new Error(boundary.message);
    const lockPath = runtime
      ? runtimePaths(options.runtimeVersion!, root).lockPath
      : workspaceInstallPaths(root).lockPath;
    if ((await observePath(lockPath)).kind !== 'missing') locks.push(lockPath);
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
        repaired.push(file);
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return { ok: errors.length === 0, mode, entries, repaired, locks, errors };
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
