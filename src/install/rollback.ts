import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Diagnostic } from '../schemas/diagnostics.js';
import { createDiagnostic } from '../schemas/diagnostics.js';
import { diagnosticCodes } from '../schemas/errors.js';
import { sha256Digest } from '../infra/fs.js';
import { observePath } from '../infra/fs.js';
import { persistedIdentityMatches } from '../infra/persisted-identity.js';
import type {
  InstallJournal,
  ManagedFileEntry,
  WorkspaceInstallManifest,
} from '../schemas/install.js';
import type { Outcome } from '../schemas/outcome.js';
import {
  acquireInstallLock,
  ensureStatePathBoundary,
  ensureWorkspaceStateBoundary,
  inspectOwnedFile,
  journalPath,
  readInstallJournal,
  readWorkspaceManifest,
  releaseInstallLock,
  removeOwnedFile,
  rootIdentityOf,
  workspaceInstallPaths,
  writeBytesAtomic,
  writeInstallJournal,
  writeWorkspaceManifest,
} from './ownership.js';

export type WorkspaceRemovalStatus =
  | 'rolled-back'
  | 'uninstalled'
  | 'partial'
  | 'missing'
  | 'unmanaged'
  | 'locked'
  | 'failed';

export interface WorkspaceRemovalResult {
  readonly ok: boolean;
  readonly status: WorkspaceRemovalStatus;
  readonly removedPaths: readonly string[];
  readonly residualPaths: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface RollbackWorkspaceOptions {
  readonly root: string;
  readonly installId: string;
  /** Fault-injection seam after the rollback journal is durable; CLI never supplies it. */
  readonly beforeRemoval?: () => Promise<void> | void;
  readonly afterRemoval?: () => Promise<void> | void;
}

function diagnostic(
  code: (typeof diagnosticCodes)[keyof typeof diagnosticCodes],
  message: string,
  hint: string,
  source: string,
): Diagnostic {
  return createDiagnostic({
    code,
    severity: 'error',
    message,
    source,
    hint,
  });
}

function now(): string {
  return new Date().toISOString();
}

async function removeManifestEntries(
  root: string,
  manifest: WorkspaceInstallManifest,
  entries: readonly ManagedFileEntry[],
): Promise<{
  readonly removed: readonly string[];
  readonly residual: readonly string[];
  readonly remaining: readonly ManagedFileEntry[];
}> {
  const removed: string[] = [];
  const residual: string[] = [];
  const keep: ManagedFileEntry[] = [];
  for (const entry of entries) {
    const result = await removeOwnedFile(root, entry);
    if (result.ok) {
      removed.push(entry.path);
    } else {
      residual.push(entry.path);
      keep.push(entry);
    }
  }
  const removedSet = new Set(removed);
  const remaining = manifest.entries.filter(
    (entry) =>
      !entries.some(
        (target) => target.path === entry.path && removedSet.has(target.path),
      ),
  );
  // Entries that disappeared from disk are also no longer owned.
  for (const entry of entries) {
    if (removedSet.has(entry.path)) continue;
    const state = await inspectOwnedFile(root, entry);
    if (state.status === 'missing') {
      const index = remaining.findIndex((item) => item.path === entry.path);
      if (index >= 0) {
        remaining.splice(index, 1);
        removed.push(entry.path);
        removedSet.add(entry.path);
      }
    }
  }
  const filtered = remaining.filter(
    (entry) =>
      !removedSet.has(entry.path) ||
      keep.some((item) => item.path === entry.path),
  );
  return { removed, residual, remaining: filtered };
}

function journalFor(
  operation: InstallJournal['operation'],
  target: string,
  root: string,
): { readonly journal: InstallJournal; readonly file: string } {
  const installId = randomUUID();
  return {
    journal: {
      schema: 'pappra/install-journal/1',
      installId,
      operation,
      target,
      workspaceRoot: root,
      runtimeVersion: null,
      status: 'prepared',
      createdAt: now(),
      updatedAt: now(),
      steps: [],
      entries: [],
      residuals: [],
      manifestRef: workspaceInstallPaths(root).manifestPath,
    },
    file: journalPath(root, installId),
  };
}

function withStep(
  journal: InstallJournal,
  name: string,
  detail: string | null,
  failed = false,
): InstallJournal {
  return {
    ...journal,
    updatedAt: now(),
    steps: [
      ...journal.steps,
      { name, status: failed ? 'failed' : 'ok', at: now(), detail },
    ],
  };
}

async function acquireForRemoval(
  root: string,
  operation: InstallJournal['operation'],
  target: string,
): Promise<
  | {
      readonly ok: true;
      readonly token: string;
      readonly path: string;
    }
  | { readonly ok: false; readonly result: WorkspaceRemovalResult }
> {
  const stateBoundary = await ensureWorkspaceStateBoundary(root);
  if (!stateBoundary.ok) {
    return {
      ok: false,
      result: {
        ok: false,
        status: 'failed',
        removedPaths: [],
        residualPaths: [],
        diagnostics: [
          diagnostic(
            diagnosticCodes.initTargetUnsafe,
            stateBoundary.message,
            stateBoundary.nextAction ??
              'Inspect symlinked Pappra state paths; nothing was removed.',
            workspaceInstallPaths(root).localDir,
          ),
        ],
      },
    };
  }
  const lock = await acquireInstallLock(
    workspaceInstallPaths(root).lockPath,
    operation,
    target,
    root,
  );
  if (!lock.ok || lock.lock === null) {
    return {
      ok: false,
      result: {
        ok: false,
        status: 'locked',
        removedPaths: [],
        residualPaths: [],
        diagnostics: [
          diagnostic(
            diagnosticCodes.initApplyFailed,
            lock.message ?? 'Workspace lock is held.',
            'Another managed operation owns this workspace; inspect the lock manually.',
            lock.path,
          ),
        ],
      },
    };
  }
  return { ok: true, token: lock.lock.token, path: lock.path };
}

async function finishJournal(
  file: string,
  journal: InstallJournal,
  residual: readonly string[],
  boundaryRoot: string,
): Promise<Outcome<null>> {
  return writeInstallJournal(
    file,
    {
      ...journal,
      status: residual.length === 0 ? 'rolled-back' : 'rollback-required',
      residuals: [...residual],
      updatedAt: now(),
    },
    boundaryRoot,
  ).then((written) =>
    written.ok
      ? { ok: true as const, value: null }
      : {
          ok: false as const,
          code: diagnosticCodes.initApplyResidual,
          message: written.message,
          retryable: false,
          nextAction: written.nextAction,
        },
  );
}

async function rollbackMachineRuntimeUpdate(
  root: string,
  manifest: WorkspaceInstallManifest,
  journal: InstallJournal,
  updateInstallId: string,
): Promise<WorkspaceRemovalResult> {
  const path = journal.entries[0]?.path ?? journal.target;
  const journalEntry = journal.entries.find((entry) => entry.path === path);
  if (
    journalEntry === undefined ||
    journalEntry.identity === null ||
    journalEntry.backupRef === null ||
    journalEntry.backupDigest === null
  ) {
    return {
      ok: false,
      status: 'partial',
      removedPaths: [],
      residualPaths: [path],
      diagnostics: [
        diagnostic(
          diagnosticCodes.initApplyResidual,
          'Runtime update journal has no bound after-state/backup record.',
          'Inspect the machine file manually; Pappra cannot prove this update.',
          journalPath(root, updateInstallId),
        ),
      ],
    };
  }
  const index = manifest.entries.findIndex((entry) => entry.path === path);
  if (index < 0) {
    return {
      ok: false,
      status: 'unmanaged',
      removedPaths: [],
      residualPaths: [path],
      diagnostics: [
        diagnostic(
          diagnosticCodes.initApplyUnsupported,
          'Runtime update has no matching ownership entry.',
          'Inspect install-manifest.json; Pappra cannot restore the update automatically.',
          workspaceInstallPaths(root).manifestPath,
        ),
      ],
    };
  }
  const entry = manifest.entries[index]!;
  if (
    entry.afterDigest !== journalEntry.digest ||
    !persistedIdentityMatches(entry.identity, journalEntry.identity)
  ) {
    return {
      ok: false,
      status: 'partial',
      removedPaths: [],
      residualPaths: [path],
      diagnostics: [
        diagnostic(
          diagnosticCodes.initApplyResidual,
          'The requested runtime update was superseded or ownership changed.',
          'Preserve the current machine.json and inspect the latest update journal.',
          path,
        ),
      ],
    };
  }
  const expectedEntry: ManagedFileEntry = {
    ...entry,
    afterDigest: journalEntry.digest,
    identity: journalEntry.identity,
    backupRef: journalEntry.backupRef,
    backupDigest: journalEntry.backupDigest,
  };
  const current = await inspectOwnedFile(root, expectedEntry);
  if (current.status !== 'match') {
    return {
      ok: false,
      status: 'partial',
      removedPaths: [],
      residualPaths: [path],
      diagnostics: [
        diagnostic(
          diagnosticCodes.initApplyResidual,
          `machine.json changed after the runtime update: ${current.status}`,
          'Preserve the current file; Pappra does not overwrite user changes.',
          path,
        ),
      ],
    };
  }
  const backup = join(root, ...journalEntry.backupRef.split('/'));
  const boundary = await ensureStatePathBoundary(root, backup);
  if (!boundary.ok) {
    return {
      ok: false,
      status: 'failed',
      removedPaths: [],
      residualPaths: [path],
      diagnostics: [
        diagnostic(
          diagnosticCodes.initTargetUnsafe,
          boundary.message,
          boundary.nextAction ?? 'Inspect the backup path; it was not read.',
          backup,
        ),
      ],
    };
  }
  let backupBytes: Buffer;
  try {
    backupBytes = await readFile(backup);
  } catch {
    return {
      ok: false,
      status: 'partial',
      removedPaths: [],
      residualPaths: [path],
      diagnostics: [
        diagnostic(
          diagnosticCodes.initApplyResidual,
          'Runtime update backup is missing or unreadable.',
          'Restore from another backup; machine.json was not changed.',
          backup,
        ),
      ],
    };
  }
  if (sha256Digest(backupBytes) !== journalEntry.backupDigest) {
    return {
      ok: false,
      status: 'partial',
      removedPaths: [],
      residualPaths: [path],
      diagnostics: [
        diagnostic(
          diagnosticCodes.initApplyResidual,
          'Runtime update backup no longer matches its recorded digest.',
          'Machine.json was not changed. Inspect/replace the backup before retrying rollback.',
          backup,
        ),
      ],
    };
  }
  const lock = await acquireForRemoval(
    root,
    'rollback-workspace-files',
    updateInstallId,
  );
  if (!lock.ok) return lock.result;
  const { journal: rollbackJournal, file } = journalFor(
    'rollback-workspace-files',
    updateInstallId,
    root,
  );
  let currentJournal = withStep(
    { ...rollbackJournal, status: 'applying', updatedAt: now() },
    'lock-acquired',
    lock.path,
  );
  currentJournal = withStep(
    currentJournal,
    'recovered-from-update-journal',
    updateInstallId,
  );
  await writeInstallJournal(file, currentJournal, root);
  const restoreWrite = await writeBytesAtomic(
    join(root, path),
    backupBytes,
    root,
  );
  if (!restoreWrite.ok) {
    const residual = [path, file];
    const failedJournal = await finishJournal(
      file,
      currentJournal,
      residual,
      root,
    ).catch(() => ({ ok: false as const }));
    const released = await releaseInstallLock(lock.path, lock.token);
    if (!failedJournal.ok) residual.push(file);
    if (!released.ok) residual.push(lock.path);
    return {
      ok: false,
      status: 'partial',
      removedPaths: [],
      residualPaths: residual,
      diagnostics: [
        diagnostic(
          diagnosticCodes.initApplyResidual,
          `Cannot restore machine.json from backup: ${restoreWrite.message}`,
          'Inspect the backup and file; Pappra did not claim rollback success.',
          path,
        ),
      ],
    };
  }
  const restored = await observePath(join(root, path));
  const afterDigest = sha256Digest(backupBytes);
  const updatedEntry: ManagedFileEntry = {
    ...entry,
    afterDigest,
    backupRef: null,
    backupDigest: null,
    identity:
      restored.kind === 'file' && restored.stats !== null
        ? { dev: restored.stats.dev, ino: restored.stats.ino }
        : entry.identity,
    verifiedAt: now(),
  };
  const updatedEntries = [...manifest.entries];
  updatedEntries[index] = updatedEntry;
  const manifestWritten = await writeWorkspaceManifest(root, {
    ...manifest,
    entries: updatedEntries,
    updatedAt: now(),
  });
  const residual = manifestWritten.ok
    ? []
    : [workspaceInstallPaths(root).manifestPath];
  const finished = await finishJournal(
    file,
    {
      ...currentJournal,
      entries: [
        {
          path,
          status: residual.length === 0 ? 'verified' : 'residual',
          digest: afterDigest,
          identity: updatedEntry.identity,
          backupRef: null,
          backupDigest: null,
          detail: null,
        },
      ],
      residuals: residual,
    },
    residual,
    root,
  );
  if (!finished.ok) residual.push(file);
  const released = await releaseInstallLock(lock.path, lock.token);
  if (!released.ok) residual.push(lock.path);
  return {
    ok: residual.length === 0,
    status: residual.length === 0 ? 'rolled-back' : 'partial',
    removedPaths: residual.length === 0 ? [path] : [],
    residualPaths: residual,
    diagnostics: residual.map((residualPath) =>
      createDiagnostic({
        code: diagnosticCodes.initApplyResidual,
        severity: 'warning',
        message: `Runtime update rollback left a residual path: ${residualPath}`,
        source: residualPath,
        hint: 'Inspect manually; Pappra did not claim a complete restoration.',
      }),
    ),
  };
}

export async function rollbackWorkspaceInstall(
  options: RollbackWorkspaceOptions,
): Promise<WorkspaceRemovalResult> {
  const manifestRead = await readWorkspaceManifest(options.root);
  let manifest = manifestRead.value;
  let entries =
    manifest?.entries.filter(
      (entry) => entry.installId === options.installId,
    ) ?? [];
  let journalRecovered: InstallJournal | null = null;
  let pendingResidual: string[] = [];
  if (entries.length === 0) {
    const journalRead = await readInstallJournal(
      journalPath(options.root, options.installId),
    );
    const journal = journalRead.value;
    if (
      journal !== null &&
      journal.operation === 'update-machine-runtime' &&
      manifest !== null &&
      (journal.status === 'applied' ||
        journal.status === 'verified' ||
        journal.status === 'rollback-required')
    ) {
      return rollbackMachineRuntimeUpdate(
        options.root,
        manifest,
        journal,
        options.installId,
      );
    }
    if (
      journal !== null &&
      journal.operation === 'apply-workspace-files' &&
      journal.workspaceRoot === options.root &&
      (journal.status === 'applying' ||
        journal.status === 'applied' ||
        journal.status === 'verified' ||
        journal.status === 'rollback-required')
    ) {
      const recovered = journal.entries
        .filter(
          (entry) =>
            (entry.status === 'created' || entry.status === 'verified') &&
            entry.identity !== null,
        )
        .map<ManagedFileEntry>((entry) => ({
          path: entry.path,
          installId: options.installId,
          operation: 'create',
          beforeDigest: null,
          afterDigest: entry.digest,
          backupRef: null,
          backupDigest: null,
          identity: entry.identity!,
          owner: 'pappra',
          verifiedAt: journal.updatedAt,
        }));
      for (const entry of journal.entries.filter(
        (entry) => entry.status === 'pending',
      )) {
        const target = join(options.root, entry.path);
        const boundary = await ensureStatePathBoundary(options.root, target);
        if (!boundary.ok || (await observePath(target)).kind !== 'missing') {
          pendingResidual.push(entry.path);
        }
      }
      if (recovered.length > 0) {
        entries = recovered;
        journalRecovered = journal;
      } else if (pendingResidual.length > 0) {
        return {
          ok: false,
          status: 'partial',
          removedPaths: [],
          residualPaths: pendingResidual,
          diagnostics: [
            diagnostic(
              diagnosticCodes.initApplyResidual,
              'Interrupted apply journal has pending entries without proven file identity.',
              'Inspect the listed paths manually; Pappra cannot prove ownership.',
              journalPath(options.root, options.installId),
            ),
          ],
        };
      }
    }
  }
  if (entries.length === 0) {
    return {
      ok: false,
      status: 'unmanaged',
      removedPaths: [],
      residualPaths: [],
      diagnostics:
        manifestRead.diagnostics.length > 0
          ? manifestRead.diagnostics
          : [
              diagnostic(
                diagnosticCodes.initApplyUnsupported,
                'Workspace has no managed ownership entry for this install.',
                'There is nothing with proven ownership to roll back.',
                workspaceInstallPaths(options.root).manifestPath,
              ),
            ],
    };
  }
  if (manifest !== null) {
    const currentIdentity = await rootIdentityOf(options.root);
    if (
      currentIdentity === null ||
      !persistedIdentityMatches(currentIdentity, manifest.rootIdentity)
    ) {
      return {
        ok: false,
        status: 'failed',
        removedPaths: [],
        residualPaths: [],
        diagnostics: [
          diagnostic(
            diagnosticCodes.initPlanStale,
            'Workspace root identity does not match the managed manifest.',
            'Inspect the workspace; Pappra does not roll back another root.',
            options.root,
          ),
        ],
      };
    }
  }
  const lock = await acquireForRemoval(
    options.root,
    'rollback-workspace-files',
    options.installId,
  );
  if (!lock.ok) return lock.result;
  const { journal, file } = journalFor(
    'rollback-workspace-files',
    options.installId,
    options.root,
  );
  let current = withStep(
    { ...journal, status: 'applying', updatedAt: now() },
    'lock-acquired',
    lock.path,
  );
  if (journalRecovered !== null) {
    current = withStep(
      current,
      'recovered-from-apply-journal',
      journalRecovered.installId,
    );
  }
  await writeInstallJournal(file, current, options.root);
  await options.beforeRemoval?.();
  const baseline: WorkspaceInstallManifest = manifest ?? {
    schema: 'pappra/install-manifest/1',
    workspaceRoot: options.root,
    rootIdentity: { dev: 0, ino: 0 },
    entries: [],
    createdAt: now(),
    updatedAt: now(),
  };
  const removal = await removeManifestEntries(options.root, baseline, entries);
  await options.afterRemoval?.();
  let residual = [...removal.residual, ...pendingResidual];
  if (manifest !== null) {
    const remainingManifest: WorkspaceInstallManifest = {
      ...manifest,
      entries: [...removal.remaining],
      updatedAt: now(),
    };
    const manifestWritten = await writeWorkspaceManifest(
      options.root,
      remainingManifest,
    );
    if (!manifestWritten.ok) {
      residual.push(workspaceInstallPaths(options.root).manifestPath);
    }
  }
  current = {
    ...withStep(current, 'files-removed', removal.removed.join(', ')),
    entries: entries.map((entry) => ({
      path: entry.path,
      status: residual.includes(entry.path) ? 'residual' : 'removed',
      digest: entry.afterDigest,
      identity: entry.identity,
      backupRef: entry.backupRef,
      backupDigest: entry.backupDigest,
      detail: null,
    })),
    residuals: residual,
  };
  const journalWritten = await finishJournal(
    file,
    current,
    residual,
    options.root,
  );
  if (!journalWritten.ok) residual.push(file);
  const lockRelease = await releaseInstallLock(lock.path, lock.token);
  if (!lockRelease.ok) residual.push(lock.path);
  return {
    ok: residual.length === 0,
    status: residual.length === 0 ? 'rolled-back' : 'partial',
    removedPaths: removal.removed,
    residualPaths: residual,
    diagnostics: residual.map((path) =>
      createDiagnostic({
        code: diagnosticCodes.initApplyResidual,
        severity: 'warning',
        message: `Rollback left a residual path: ${path}`,
        source: path,
        hint: 'Inspect manually; Pappra preserves files whose ownership or content changed.',
      }),
    ),
  };
}

export interface UninstallWorkspaceOptions {
  readonly root: string;
}

export async function uninstallWorkspaceManagedFiles(
  options: UninstallWorkspaceOptions,
): Promise<WorkspaceRemovalResult> {
  const manifestRead = await readWorkspaceManifest(options.root);
  if (manifestRead.value === null) {
    return {
      ok: true,
      status: 'missing',
      removedPaths: [],
      residualPaths: [],
      diagnostics: [],
    };
  }
  const manifest = manifestRead.value;
  const currentIdentity = await rootIdentityOf(options.root);
  if (
    currentIdentity === null ||
    !persistedIdentityMatches(currentIdentity, manifest.rootIdentity)
  ) {
    return {
      ok: false,
      status: 'failed',
      removedPaths: [],
      residualPaths: [],
      diagnostics: [
        diagnostic(
          diagnosticCodes.initPlanStale,
          'Workspace root identity does not match the managed manifest.',
          'Inspect the workspace; Pappra does not uninstall another root.',
          options.root,
        ),
      ],
    };
  }
  const lock = await acquireForRemoval(
    options.root,
    'uninstall-workspace-files',
    options.root,
  );
  if (!lock.ok) return lock.result;
  const { journal, file } = journalFor(
    'uninstall-workspace-files',
    options.root,
    options.root,
  );
  let current = withStep(
    { ...journal, status: 'applying', updatedAt: now() },
    'lock-acquired',
    lock.path,
  );
  await writeInstallJournal(file, current, options.root);
  const removal = await removeManifestEntries(
    options.root,
    manifest,
    manifest.entries,
  );
  const remainingManifest: WorkspaceInstallManifest = {
    ...manifest,
    entries: [...removal.remaining],
    updatedAt: now(),
  };
  const manifestWritten = await writeWorkspaceManifest(
    options.root,
    remainingManifest,
  );
  const residual = [...removal.residual];
  if (!manifestWritten.ok)
    residual.push(workspaceInstallPaths(options.root).manifestPath);
  current = {
    ...withStep(current, 'files-removed', removal.removed.join(', ')),
    entries: manifest.entries.map((entry) => ({
      path: entry.path,
      status: residual.includes(entry.path) ? 'residual' : 'removed',
      digest: entry.afterDigest,
      identity: entry.identity,
      backupRef: entry.backupRef,
      backupDigest: entry.backupDigest,
      detail: null,
    })),
    residuals: residual,
  };
  const journalWritten = await finishJournal(
    file,
    current,
    residual,
    options.root,
  );
  if (!journalWritten.ok) residual.push(file);
  const lockRelease = await releaseInstallLock(lock.path, lock.token);
  if (!lockRelease.ok) residual.push(lock.path);
  return {
    ok: residual.length === 0,
    status: residual.length === 0 ? 'uninstalled' : 'partial',
    removedPaths: removal.removed,
    residualPaths: residual,
    diagnostics: residual.map((path) =>
      createDiagnostic({
        code: diagnosticCodes.initApplyResidual,
        severity: 'warning',
        message: `Uninstall preserved a residual path: ${path}`,
        source: path,
        hint: 'User-modified or uncertain files are preserved; inspect manually.',
      }),
    ),
  };
}
