import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { Diagnostic } from '../schemas/diagnostics.js';
import { createDiagnostic } from '../schemas/diagnostics.js';
import { diagnosticCodes } from '../schemas/errors.js';
import {
  managedFileEntrySchema,
  type InstallJournal,
  type ManagedFileEntry,
  type RuntimeManifest,
  type WorkspaceInstallManifest,
} from '../schemas/install.js';
import type { InitPlan } from '../schemas/init.js';
import { machineConfigSchema } from '../schemas/machine.js';
import type { PlannedFileContent } from './plan.js';
import {
  acquireInstallLock,
  backupPath,
  createManifest,
  ensureStatePathBoundary,
  ensureWorkspaceStateBoundary,
  inspectOwnedFile,
  journalPath,
  readInstallJournal,
  readWorkspaceManifest,
  releaseInstallLock,
  rootIdentityOf,
  scanJournalDirectory,
  workspaceInstallPaths,
  writeInstallJournal,
  writeJsonAtomic,
  writeWorkspaceManifest,
} from './ownership.js';
import { observePath, sha256Digest } from '../infra/fs.js';
import { errorMessage } from '../schemas/outcome.js';

export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface ManagedApplyContext {
  readonly root: string;
  readonly installId: string;
  readonly planId: string;
  readonly lockPath: string;
  readonly lockToken: string;
  readonly journalFile: string;
  readonly manifest: WorkspaceInstallManifest;
  journal: InstallJournal;
  readonly entries: ManagedFileEntry[];
  readonly plannedPaths: readonly string[];
}

export type ManagedApplyBegin =
  | { readonly ok: true; readonly context: ManagedApplyContext }
  | {
      readonly ok: false;
      readonly status: 'locked' | 'invalid' | 'failed';
      readonly diagnostics: readonly Diagnostic[];
      readonly residualPaths: readonly string[];
    };

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

function appendStep(
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

function manifestEntry(
  installId: string,
  path: string,
  digest: string,
  identity: FileIdentity,
): ManagedFileEntry {
  return {
    path,
    installId,
    operation: 'create',
    beforeDigest: null,
    afterDigest: digest,
    backupRef: null,
    backupDigest: null,
    identity,
    owner: 'pappra',
    verifiedAt: now(),
  };
}

export async function beginManagedApply(
  root: string,
  plan: InitPlan,
  writes: readonly PlannedFileContent[],
  rootIdentity: FileIdentity,
): Promise<ManagedApplyBegin> {
  const stateBoundary = await ensureWorkspaceStateBoundary(root);
  if (!stateBoundary.ok) {
    return {
      ok: false,
      status: 'invalid',
      diagnostics: [
        diagnostic(
          diagnosticCodes.initTargetUnsafe,
          stateBoundary.message,
          stateBoundary.nextAction ??
            'Inspect symlinked Pappra state paths; no metadata was written.',
          workspaceInstallPaths(root).localDir,
        ),
      ],
      residualPaths: [],
    };
  }
  const currentIdentity = await rootIdentityOf(root);
  if (
    currentIdentity === null ||
    currentIdentity.dev !== rootIdentity.dev ||
    currentIdentity.ino !== rootIdentity.ino
  ) {
    return {
      ok: false,
      status: 'invalid',
      diagnostics: [
        diagnostic(
          diagnosticCodes.initPlanStale,
          'Workspace root identity changed before managed apply.',
          'Retry init from the current workspace root; no files were written.',
          root,
        ),
      ],
      residualPaths: [],
    };
  }
  if (
    writes.length !== plan.files.length ||
    plan.files.some(
      (file) => !['create', 'replace-managed'].includes(file.operation),
    )
  ) {
    return {
      ok: false,
      status: 'invalid',
      diagnostics: [
        diagnostic(
          diagnosticCodes.initApplyUnsupported,
          'Managed apply supports only create and managed replacement plans.',
          'Regenerate the plan with supported file operations.',
          root,
        ),
      ],
      residualPaths: [],
    };
  }
  const manifestRead = await readWorkspaceManifest(root);
  if (manifestRead.diagnostics.length > 0) {
    return {
      ok: false,
      status: 'invalid',
      diagnostics: manifestRead.diagnostics,
      residualPaths: [],
    };
  }
  const manifest = manifestRead.value ?? createManifest(root, rootIdentity);
  if (
    manifest.workspaceRoot !== root ||
    manifest.rootIdentity.dev !== rootIdentity.dev ||
    manifest.rootIdentity.ino !== rootIdentity.ino
  ) {
    return {
      ok: false,
      status: 'invalid',
      diagnostics: [
        diagnostic(
          diagnosticCodes.initPlanStale,
          'Existing installation manifest belongs to another root identity.',
          'Inspect .pappra/local/install-manifest.json; Pappra does not adopt it.',
          workspaceInstallPaths(root).manifestPath,
        ),
      ],
      residualPaths: [],
    };
  }
  const existingPaths = new Set(manifest.entries.map((entry) => entry.path));
  for (const file of plan.files) {
    if ((file.operation === 'create') === existingPaths.has(file.path)) {
      return {
        ok: false,
        status: 'invalid',
        diagnostics: [
          diagnostic(
            diagnosticCodes.initTargetExists,
            `Managed ownership does not match the planned operation for ${file.path}.`,
            'Inspect ownership state; replacements require an existing managed entry.',
            workspaceInstallPaths(root).manifestPath,
          ),
        ],
        residualPaths: [],
      };
    }
  }

  const lock = await acquireInstallLock(
    workspaceInstallPaths(root).lockPath,
    'apply-workspace-files',
    root,
    root,
  );
  if (!lock.ok || lock.lock === null) {
    return {
      ok: false,
      status: lock.status === 'locked' ? 'locked' : 'failed',
      diagnostics: [
        diagnostic(
          diagnosticCodes.initApplyFailed,
          lock.message ?? 'Workspace apply lock is held.',
          'Another Pappra apply owns this workspace; locks are not reclaimed by age.',
          lock.path,
        ),
      ],
      residualPaths: [],
    };
  }

  const currentManifest = await readWorkspaceManifest(root);
  const priorJournal = await findIncompleteWorkspaceJournal(root);
  if (
    currentManifest.digest !== manifestRead.digest ||
    priorJournal.incomplete !== null ||
    priorJournal.unreadable.length > 0
  ) {
    await releaseInstallLock(lock.path, lock.lock.token);
    return {
      ok: false,
      status: 'invalid',
      residualPaths: [],
      diagnostics: [
        diagnostic(
          diagnosticCodes.initPlanStale,
          'Managed ownership changed or an incomplete journal requires recovery.',
          'Run pappra repair to inspect interrupted installs, then regenerate the plan.',
          priorJournal.incomplete ?? workspaceInstallPaths(root).manifestPath,
        ),
      ],
    };
  }

  const installId = randomUUID();
  const journalFile = journalPath(root, installId);
  const manifestBackupSteps: InstallJournal['steps'] = [];
  if (plan.files.some((file) => file.operation === 'replace-managed')) {
    const backup = backupPath(root, installId, 'install-manifest.json');
    try {
      const boundary = await ensureStatePathBoundary(root, backup);
      if (!boundary.ok) throw new Error(boundary.message);
      const bytes = await readFile(workspaceInstallPaths(root).manifestPath);
      if (sha256Digest(bytes) !== manifestRead.digest)
        throw new Error('Ownership changed before backup.');
      await mkdir(dirname(backup), { recursive: true });
      await writeFile(backup, bytes, { flag: 'wx', mode: 0o600 });
      manifestBackupSteps.push(
        {
          name: 'manifest-backup',
          status: 'ok',
          at: now(),
          detail: relative(root, backup).split(sep).join('/'),
        },
        {
          name: 'manifest-backup-digest',
          status: 'ok',
          at: now(),
          detail: sha256Digest(bytes),
        },
      );
    } catch (error) {
      await releaseInstallLock(lock.path, lock.lock.token);
      return {
        ok: false,
        status: 'failed',
        residualPaths: [],
        diagnostics: [
          diagnostic(
            diagnosticCodes.initApplyFailed,
            `Cannot back up managed ownership: ${errorMessage(error)}`,
            'Inspect the workspace state; no target was changed.',
            journalFile,
          ),
        ],
      };
    }
  }
  let journal: InstallJournal = {
    schema: 'pappra/install-journal/1',
    installId,
    operation: 'apply-workspace-files',
    target: plan.planId,
    workspaceRoot: root,
    runtimeVersion: null,
    status: 'prepared',
    createdAt: now(),
    updatedAt: now(),
    steps: [
      { name: 'lock-acquired', status: 'ok', at: now(), detail: lock.path },
      ...manifestBackupSteps,
      ...writes.map((write) => ({
        name: `pending:${write.path}`,
        status: 'ok' as const,
        at: now(),
        detail: write.digest,
      })),
    ],
    entries: writes.map((write, index) => ({
      path: write.path,
      status: 'pending' as const,
      digest: write.digest,
      identity: null,
      backupRef:
        plan.files[index]?.operation === 'replace-managed'
          ? relative(root, backupPath(root, installId, write.path))
              .split(sep)
              .join('/')
          : null,
      backupDigest:
        plan.files[index]?.operation === 'replace-managed'
          ? plan.files[index]!.expectedBeforeDigest
          : null,
      detail: null,
    })),
    residuals: [],
    manifestRef: workspaceInstallPaths(root).manifestPath,
  };
  const journalWritten = await writeInstallJournal(journalFile, journal, root);
  if (!journalWritten.ok) {
    await releaseInstallLock(lock.path, lock.lock.token);
    return {
      ok: false,
      status: 'failed',
      diagnostics: [
        diagnostic(
          diagnosticCodes.initApplyFailed,
          `Cannot write apply journal: ${journalWritten.message}`,
          'Inspect .pappra/local permissions and retry; no files were written.',
          journalFile,
        ),
      ],
      residualPaths: [],
    };
  }
  journal = appendStep(
    { ...journal, status: 'applying', updatedAt: now() },
    'prepared',
    null,
  );
  await writeInstallJournal(journalFile, journal, root);
  return {
    ok: true,
    context: {
      root,
      installId,
      planId: plan.planId,
      lockPath: lock.path,
      lockToken: lock.lock.token,
      journalFile,
      manifest,
      journal,
      entries: [],
      plannedPaths: plan.files.map((file) => file.path),
    },
  };
}

export async function recordManagedFile(
  context: ManagedApplyContext,
  path: string,
  digest: string,
  identity: FileIdentity,
  replacement?: { readonly backupRef: string; readonly backupDigest: string },
): Promise<
  | { readonly ok: true }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }
> {
  if (!context.plannedPaths.includes(path)) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          diagnosticCodes.initPlanInvalid,
          `Managed apply recorded an unplanned path: ${path}`,
          'Regenerate the plan; the journal was not advanced.',
          context.journalFile,
        ),
      ],
    };
  }
  const entries = context.journal.entries.map((entry) =>
    entry.path === path
      ? {
          ...entry,
          status: 'created' as const,
          identity,
          backupRef: replacement?.backupRef ?? null,
          backupDigest: replacement?.backupDigest ?? null,
          detail: null,
        }
      : entry,
  );
  const journal = appendStep(
    {
      ...context.journal,
      entries,
      updatedAt: now(),
    },
    `created:${path}`,
    digest,
  );
  const written = await writeInstallJournal(
    context.journalFile,
    journal,
    context.root,
  );
  if (!written.ok) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          diagnosticCodes.initApplyFailed,
          `Cannot persist created file in journal: ${written.message}`,
          'Inspect .pappra/local/journals; the file may need manual recovery.',
          context.journalFile,
        ),
      ],
    };
  }
  context.journal = journal;
  context.entries.push({
    ...manifestEntry(context.installId, path, digest, identity),
    ...(replacement === undefined
      ? {}
      : {
          operation: 'replace-managed' as const,
          beforeDigest: replacement.backupDigest,
          backupRef: replacement.backupRef,
          backupDigest: replacement.backupDigest,
        }),
  });
  return { ok: true };
}

export interface CompleteManagedApply {
  readonly ok: boolean;
  readonly manifest: WorkspaceInstallManifest | null;
  readonly journal: InstallJournal;
  readonly diagnostics: readonly Diagnostic[];
  readonly residualPaths: readonly string[];
}

export async function completeManagedApply(
  context: ManagedApplyContext,
): Promise<CompleteManagedApply> {
  const appliedJournal = appendStep(
    { ...context.journal, status: 'applied', updatedAt: now() },
    'files-created',
    context.entries.map((entry) => entry.path).join(', '),
  );
  await writeInstallJournal(context.journalFile, appliedJournal, context.root);
  context.journal = appliedJournal;
  const changedPaths = new Set(context.entries.map((entry) => entry.path));
  const entries = [
    ...context.manifest.entries.filter(
      (entry) => !changedPaths.has(entry.path),
    ),
    ...context.entries,
  ];
  const manifest: WorkspaceInstallManifest = {
    ...context.manifest,
    entries,
    updatedAt: now(),
  };
  const manifestWritten = await writeWorkspaceManifest(context.root, manifest);
  if (!manifestWritten.ok) {
    return {
      ok: false,
      manifest: null,
      journal: context.journal,
      diagnostics: [
        diagnostic(
          diagnosticCodes.initApplyFailed,
          `Cannot write installation manifest: ${manifestWritten.message}`,
          'Files may remain; inspect .pappra/local/install-manifest.json and the journal.',
          workspaceInstallPaths(context.root).manifestPath,
        ),
      ],
      residualPaths: [],
    };
  }
  const verifiedJournal = appendStep(
    {
      ...context.journal,
      status: 'verified',
      entries: context.journal.entries.map((entry) => ({
        ...entry,
        status: 'verified' as const,
      })),
      manifestRef: workspaceInstallPaths(context.root).manifestPath,
      updatedAt: now(),
    },
    'manifest-written',
    manifestWritten.value.digest,
  );
  const journalWritten = await writeInstallJournal(
    context.journalFile,
    verifiedJournal,
    context.root,
  );
  const lockRelease = await releaseInstallLock(
    context.lockPath,
    context.lockToken,
  );
  const residualPaths: string[] = [];
  if (!journalWritten.ok) residualPaths.push(context.journalFile);
  if (!lockRelease.ok) residualPaths.push(context.lockPath);
  return {
    ok: true,
    manifest,
    journal: verifiedJournal,
    diagnostics: residualPaths.map((path) =>
      createDiagnostic({
        code: diagnosticCodes.initApplyResidual,
        severity: 'warning',
        message: `Managed apply completed but could not clean state: ${path}`,
        source: path,
        hint: 'Files and manifest are present; inspect this residual state before retrying.',
      }),
    ),
    residualPaths,
  };
}

export async function failManagedApply(
  context: ManagedApplyContext,
  message: string,
  residuals: readonly string[],
): Promise<CompleteManagedApply> {
  const journal = appendStep(
    {
      ...context.journal,
      status: residuals.length === 0 ? 'rolled-back' : 'rollback-required',
      residuals: [...residuals],
      entries: context.journal.entries.map((entry) =>
        residuals.includes(entry.path)
          ? { ...entry, status: 'residual' as const }
          : entry.status === 'pending' || entry.status === 'created'
            ? { ...entry, status: 'removed' as const }
            : entry,
      ),
      updatedAt: now(),
    },
    'failed',
    message,
    true,
  );
  const journalWritten = await writeInstallJournal(
    context.journalFile,
    journal,
    context.root,
  ).catch(() => ({ ok: false as const }));
  const lockRelease = await releaseInstallLock(
    context.lockPath,
    context.lockToken,
  );
  const residualPaths = [...residuals];
  if (!journalWritten.ok) residualPaths.push(context.journalFile);
  if (!lockRelease.ok) residualPaths.push(context.lockPath);
  return {
    ok: false,
    manifest: null,
    journal,
    diagnostics: [
      createDiagnostic({
        code: diagnosticCodes.initApplyFailed,
        severity: 'error',
        message: `${message}${residualPaths.length === 0 ? ' No planned file remains.' : ` Residual paths: ${residualPaths.join(', ')}`}`,
        source: context.journalFile,
        hint:
          residualPaths.length === 0
            ? 'Inspect the journal; runtime/provider actions were not executed.'
            : 'Inspect residual paths manually; Pappra does not delete files with uncertain ownership.',
      }),
      ...residualPaths.map((path) =>
        createDiagnostic({
          code: diagnosticCodes.initApplyResidual,
          severity: 'error',
          message: `Residual path requires manual review: ${path}`,
          source: path,
          hint: 'Pappra did not remove this path because ownership or content could not be proven.',
        }),
      ),
    ],
    residualPaths,
  };
}

export interface UpdateMachineRuntimeOptions {
  /** Fault-injection seams for tests; the CLI never supplies these hooks. */
  readonly beforeWrite?: () => Promise<void> | void;
  readonly beforeFinalJournalPersist?: () => Promise<void> | void;
}

export interface ManagedMachineUpdateResult {
  readonly ok: boolean;
  readonly status:
    | 'updated'
    | 'unchanged'
    | 'unmanaged'
    | 'locked'
    | 'conflict'
    | 'partial'
    | 'failed';
  readonly diagnostics: readonly Diagnostic[];
  readonly residualPaths: readonly string[];
  readonly updateInstallId?: string;
  readonly journalPath?: string;
}

interface WorkspaceJournalScan {
  readonly incomplete: string | null;
  readonly unreadable: readonly string[];
}

async function findIncompleteWorkspaceJournal(
  root: string,
): Promise<WorkspaceJournalScan> {
  const directory = workspaceInstallPaths(root).journalsDir;
  const listing = await scanJournalDirectory(directory);
  if (listing.kind === 'missing') {
    return { incomplete: null, unreadable: [] };
  }
  if (listing.kind === 'unreadable') {
    return { incomplete: null, unreadable: [directory] };
  }
  const unreadable = [...listing.nonRegular];
  let incomplete: string | null = null;
  for (const path of listing.files) {
    const read = await readInstallJournal(path);
    if (read.value === null) {
      unreadable.push(path);
      continue;
    }
    if (
      incomplete === null &&
      (read.value.status === 'prepared' ||
        read.value.status === 'applying' ||
        read.value.status === 'applied' ||
        read.value.status === 'rollback-required')
    ) {
      incomplete = path;
    }
  }
  return { incomplete, unreadable };
}

/** Updates the managed machine.json runtime location after a verified install. */
export async function updateMachineRuntime(
  root: string,
  runtime: RuntimeManifest,
  options: UpdateMachineRuntimeOptions = {},
): Promise<ManagedMachineUpdateResult> {
  const stateBoundary = await ensureWorkspaceStateBoundary(root);
  if (!stateBoundary.ok) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [
        diagnostic(
          diagnosticCodes.initTargetUnsafe,
          stateBoundary.message,
          stateBoundary.nextAction ?? 'Inspect symlinked Pappra state paths.',
          workspaceInstallPaths(root).localDir,
        ),
      ],
      residualPaths: [],
    };
  }
  const existingLock = await observePath(workspaceInstallPaths(root).lockPath);
  if (existingLock.kind !== 'missing') {
    return {
      ok: false,
      status: 'locked',
      diagnostics: [
        diagnostic(
          diagnosticCodes.initApplyResidual,
          'Workspace apply lock exists; machine update is not attempted.',
          'Inspect the lock owner; Pappra does not bypass it with an unchanged shortcut.',
          workspaceInstallPaths(root).lockPath,
        ),
      ],
      residualPaths: [workspaceInstallPaths(root).lockPath],
    };
  }
  const journalScan = await findIncompleteWorkspaceJournal(root);
  if (journalScan.unreadable.length > 0) {
    return {
      ok: false,
      status: 'partial',
      diagnostics: [
        diagnostic(
          diagnosticCodes.initApplyResidual,
          `Workspace journal state is unreadable or incompatible: ${journalScan.unreadable.join(', ')}`,
          'Inspect the listed journals; Pappra does not bypass or repair an unresolved state.',
          journalScan.unreadable[0] ?? workspaceInstallPaths(root).journalsDir,
        ),
      ],
      residualPaths: journalScan.unreadable,
    };
  }
  if (journalScan.incomplete !== null) {
    return {
      ok: false,
      status: 'partial',
      diagnostics: [
        diagnostic(
          diagnosticCodes.initApplyResidual,
          `A previous managed apply/update is incomplete: ${journalScan.incomplete}`,
          'Inspect the journal; Pappra does not bypass an unresolved state by updating again.',
          journalScan.incomplete,
        ),
      ],
      residualPaths: [journalScan.incomplete],
    };
  }
  const manifestRead = await readWorkspaceManifest(root);
  if (manifestRead.value === null) {
    return {
      ok: false,
      status: 'unmanaged',
      diagnostics: [
        diagnostic(
          diagnosticCodes.initApplyUnsupported,
          'machine.json is not owned by a P04 installation manifest.',
          'Use a managed init/apply or configure flow; Pappra does not adopt unowned files.',
          workspaceInstallPaths(root).manifestPath,
        ),
      ],
      residualPaths: [],
    };
  }
  const manifest = manifestRead.value;
  const currentIdentity = await rootIdentityOf(root);
  if (
    currentIdentity === null ||
    currentIdentity.dev !== manifest.rootIdentity.dev ||
    currentIdentity.ino !== manifest.rootIdentity.ino
  ) {
    return {
      ok: false,
      status: 'failed',
      diagnostics: [
        diagnostic(
          diagnosticCodes.initPlanStale,
          'Workspace root identity does not match the managed manifest.',
          'Inspect the workspace; Pappra does not update another root.',
          root,
        ),
      ],
      residualPaths: [],
    };
  }
  const machinePath = '.pappra/local/machine.json';
  const index = manifest.entries.findIndex(
    (entry) => entry.path === machinePath,
  );
  if (index < 0) {
    return {
      ok: false,
      status: 'unmanaged',
      diagnostics: [
        diagnostic(
          diagnosticCodes.initApplyUnsupported,
          'machine.json has no managed ownership entry.',
          'Create it through a P04 managed apply before installing a runtime.',
          workspaceInstallPaths(root).manifestPath,
        ),
      ],
      residualPaths: [],
    };
  }
  const entry = manifest.entries[index]!;
  const ownership = await inspectOwnedFile(root, entry);
  if (ownership.status !== 'match') {
    return {
      ok: false,
      status: 'conflict',
      diagnostics: [
        diagnostic(
          diagnosticCodes.initTargetExists,
          `machine.json no longer matches its managed digest: ${ownership.status}`,
          'Preserve the user-modified file; adjust ownership only after review.',
          join(root, machinePath),
        ),
      ],
      residualPaths: [machinePath],
    };
  }
  const currentMachineBytes = await readFile(join(root, machinePath)).catch(
    () => null,
  );
  if (currentMachineBytes !== null) {
    try {
      const currentMachine = JSON.parse(
        currentMachineBytes.toString('utf8'),
      ) as {
        runtime?: { version?: unknown; executable?: unknown };
      };
      if (
        currentMachine.runtime?.version === runtime.runtimeVersion &&
        currentMachine.runtime.executable === runtime.executable
      ) {
        return {
          ok: true,
          status: 'unchanged',
          diagnostics: [],
          residualPaths: [],
        };
      }
    } catch {
      // The schema-validated update path below reports malformed machine state.
    }
  }
  const lock = await acquireInstallLock(
    workspaceInstallPaths(root).lockPath,
    'update-machine-runtime',
    root,
    root,
  );
  if (!lock.ok || lock.lock === null) {
    return {
      ok: false,
      status: lock.status === 'locked' ? 'locked' : 'failed',
      diagnostics: [
        diagnostic(
          diagnosticCodes.initApplyFailed,
          lock.message ?? 'Workspace lock is held.',
          'Another managed operation owns this workspace.',
          lock.path,
        ),
      ],
      residualPaths: [],
    };
  }
  const updateInstallId = randomUUID();
  const updateJournalFile = journalPath(root, updateInstallId);
  let updateJournal: InstallJournal = {
    schema: 'pappra/install-journal/1',
    installId: updateInstallId,
    operation: 'update-machine-runtime',
    target: machinePath,
    workspaceRoot: root,
    runtimeVersion: runtime.runtimeVersion,
    status: 'prepared',
    createdAt: now(),
    updatedAt: now(),
    steps: [
      { name: 'lock-acquired', status: 'ok', at: now(), detail: lock.path },
    ],
    entries: [
      {
        path: machinePath,
        status: 'pending',
        digest: runtime.packageDigest,
        identity: null,
        backupRef: null,
        backupDigest: null,
        detail: null,
      },
    ],
    residuals: [],
    manifestRef: workspaceInstallPaths(root).manifestPath,
  };
  const initialJournal = await writeInstallJournal(
    updateJournalFile,
    updateJournal,
    root,
  );
  if (!initialJournal.ok) {
    await releaseInstallLock(lock.path, lock.lock.token);
    return {
      ok: false,
      status: 'failed',
      diagnostics: [
        diagnostic(
          diagnosticCodes.initApplyFailed,
          `Cannot write machine update journal: ${initialJournal.message}`,
          'Inspect .pappra/local/journals; runtime remains installed but pending.',
          updateJournalFile,
        ),
      ],
      residualPaths: [],
    };
  }
  updateJournal = appendStep(
    { ...updateJournal, status: 'applying', updatedAt: now() },
    'prepared',
    null,
  );
  await writeInstallJournal(updateJournalFile, updateJournal, root);
  try {
    const machineFile = join(root, machinePath);
    const oldBytes = await readFile(machineFile);
    let raw: unknown;
    try {
      raw = JSON.parse(oldBytes.toString('utf8'));
    } catch {
      throw new Error('machine.json is not valid JSON.');
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('machine.json is not an object.');
    }
    const next = {
      ...(raw as Record<string, unknown>),
      runtime: {
        version: runtime.runtimeVersion,
        executable: runtime.executable,
        verifiedAt: runtime.verifiedAt,
      },
    };
    const parsedMachine = machineConfigSchema.safeParse(next);
    if (!parsedMachine.success) {
      throw new Error(
        `Updated machine.json is invalid: ${parsedMachine.error.issues[0]?.message ?? 'unknown issue'}`,
      );
    }
    const updatedAt = now();
    const nextBytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
    const backup = backupPath(root, updateInstallId, machinePath);
    const backupBoundary = await ensureStatePathBoundary(root, backup);
    if (!backupBoundary.ok) {
      throw new Error(backupBoundary.message);
    }
    await mkdir(dirname(backup), { recursive: true });
    await writeFile(backup, oldBytes, { mode: 0o600, flag: 'wx' });
    await options.beforeWrite?.();
    const machineWrite = await writeJsonAtomic(machineFile, next, root);
    if (!machineWrite.ok) {
      throw new Error(`Cannot write machine.json: ${machineWrite.message}`);
    }
    const observation = await observePath(machineFile);
    if (observation.kind !== 'file' || observation.stats === null) {
      throw new Error('machine.json disappeared after update.');
    }
    const actualBytes = await readFile(machineFile);
    const afterDigest = sha256Digest(nextBytes);
    if (sha256Digest(actualBytes) !== afterDigest) {
      throw new Error('machine.json bytes do not match the intended update.');
    }
    const backupRef = backup
      .slice(root.length + 1)
      .split('\\')
      .join('/');
    const backupDigest = sha256Digest(oldBytes);
    const updatedEntry: ManagedFileEntry = {
      ...entry,
      afterDigest,
      backupRef,
      backupDigest,
      identity: { dev: observation.stats.dev, ino: observation.stats.ino },
      verifiedAt: updatedAt,
    };
    const updatedEntries = [...manifest.entries];
    updatedEntries[index] = managedFileEntrySchema.parse(updatedEntry);
    const nextManifest = {
      ...manifest,
      entries: updatedEntries,
      updatedAt,
    };
    const manifestWritten = await writeWorkspaceManifest(root, nextManifest);
    if (!manifestWritten.ok) {
      throw new Error(
        `Cannot update installation manifest: ${manifestWritten.message}`,
      );
    }
    updateJournal = appendStep(
      {
        ...updateJournal,
        status: 'verified',
        entries: updateJournal.entries.map((entry) => ({
          ...entry,
          status: 'verified' as const,
          digest: afterDigest,
          identity: updatedEntry.identity,
          backupRef,
          backupDigest,
        })),
        updatedAt: now(),
      },
      'verified',
      afterDigest,
    );
    await options.beforeFinalJournalPersist?.();
    const journalWritten = await writeInstallJournal(
      updateJournalFile,
      updateJournal,
      root,
    );
    const lockRelease = await releaseInstallLock(lock.path, lock.lock.token);
    const residualPaths: string[] = [];
    if (!journalWritten.ok) residualPaths.push(updateJournalFile);
    if (!lockRelease.ok) residualPaths.push(lock.path);
    if (residualPaths.length > 0) {
      return {
        ok: false,
        status: 'partial',
        updateInstallId,
        journalPath: updateJournalFile,
        diagnostics: residualPaths.map((path) =>
          createDiagnostic({
            code: diagnosticCodes.initApplyResidual,
            severity: 'error',
            message: `machine.json changed but managed state is not final: ${path}`,
            source: path,
            hint: 'Inspect the journal/lock; do not treat initialization as complete.',
          }),
        ),
        residualPaths,
      };
    }
    return {
      ok: true,
      status: 'updated',
      updateInstallId,
      journalPath: updateJournalFile,
      diagnostics: [],
      residualPaths: [],
    };
  } catch (error) {
    updateJournal = appendStep(
      {
        ...updateJournal,
        status: 'rollback-required',
        residuals: [machinePath],
        updatedAt: now(),
      },
      'failed',
      errorMessage(error),
      true,
    );
    const failedJournal = await writeInstallJournal(
      updateJournalFile,
      updateJournal,
      root,
    ).catch(() => ({ ok: false as const }));
    const lockRelease = await releaseInstallLock(lock.path, lock.lock.token);
    const residual = [machinePath];
    if (!failedJournal.ok) residual.push(updateJournalFile);
    if (!lockRelease.ok) residual.push(lock.path);
    return {
      ok: false,
      status: 'failed',
      diagnostics: [
        diagnostic(
          diagnosticCodes.initApplyFailed,
          `Cannot update machine runtime location: ${errorMessage(error)}`,
          'Inspect .pappra/local/backups and install-manifest.json; runtime remains installed but pending.',
          machinePath,
        ),
      ],
      residualPaths: residual,
    };
  }
}

export interface ManagedWorkspaceState {
  readonly manifest: WorkspaceInstallManifest | null;
  readonly diagnostics: readonly Diagnostic[];
}

export async function inspectManagedWorkspaceState(
  root: string,
): Promise<ManagedWorkspaceState> {
  const manifest = await readWorkspaceManifest(root);
  return { manifest: manifest.value, diagnostics: manifest.diagnostics };
}
