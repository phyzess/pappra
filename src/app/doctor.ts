import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Diagnostic } from '../schemas/diagnostics.js';
import type { DiagnosticCode } from '../schemas/errors.js';
import { diagnosticCodes } from '../schemas/errors.js';
import type { EvidenceRef } from '../schemas/evidence.js';
import {
  DOCTOR_REPORT_SCHEMA,
  doctorReportSchema,
  type DoctorCheck,
  type DoctorCheckStatus,
  type DoctorReport,
  type DoctorSeverity,
} from '../schemas/doctor.js';
import type { MachineConfig } from '../schemas/machine.js';
import type { WorkspaceConfig } from '../schemas/workspace.js';
import { isPathInside } from '../schemas/paths.js';
import { observePath, readFileBounded, resolveRealpath } from '../infra/fs.js';
import {
  inspectMachineConfig,
  inspectWorkspaceConfig,
} from '../workspace/config.js';
import {
  discoverWorkspace,
  type WorkspaceDiscovery,
} from '../workspace/discover.js';
import { resolveWorkspaceRoot } from '../workspace/resolve.js';
import {
  resolveUserDataDir,
  inspectRuntimeStatePassive,
} from '../install/runtime.js';
import {
  ensureStatePathBoundary,
  inspectOwnedFile,
  readInstallJournal,
  readWorkspaceManifest,
  rootIdentityOf,
  scanJournalDirectory,
  workspaceInstallPaths,
} from '../install/ownership.js';
import { detectPassiveHosts, detectPassiveTool } from '../hosts/detect.js';
import { inspectWorkspaceLocks } from '../install/repair.js';
import { inspectLocalResetState } from '../install/reset-local.js';
import { inspectPrivateLock } from '../infra/private-lock.js';

export interface DoctorOptions {
  readonly root?: string;
  readonly dataDir?: string;
  readonly homeDir?: string;
  readonly pathEnv?: string;
  readonly now?: Date;
}

interface CheckInput {
  readonly id: string;
  readonly code: DiagnosticCode;
  readonly status: DoctorCheckStatus;
  readonly severity: DoctorSeverity;
  readonly title: string;
  readonly summary: string;
  readonly source: string;
  readonly observedAt: string;
  readonly coverage?: string | null;
  readonly evidence?: readonly EvidenceRef[];
  readonly nextActions?: readonly string[];
}

function truncateText(value: string, limit: number): string {
  return value.length <= limit
    ? value
    : `${value.slice(0, Math.max(0, limit - 14))}…[truncated]`;
}

function makeCheck(input: CheckInput): DoctorCheck {
  const evidence = new Map<string, EvidenceRef>();
  for (const ref of input.evidence ?? []) {
    const key = `${ref.kind}\0${ref.ref}\0${ref.digest ?? ''}\0${ref.scope}`;
    if (!evidence.has(key)) evidence.set(key, ref);
    if (evidence.size >= 32) break;
  }
  const actions = [...new Set(input.nextActions ?? [])]
    .slice(0, 16)
    .map((action) => truncateText(action, 1024));
  const summary = truncateText(input.summary, 4096);
  let coverage = truncateText(input.coverage ?? '', 256);
  if ((input.evidence?.length ?? 0) > 32) {
    coverage = truncateText(`${coverage}; evidence truncated`, 256);
  }
  if ((input.nextActions?.length ?? 0) > 16) {
    coverage = truncateText(`${coverage}; actions truncated`, 256);
  }
  if (summary.length < input.summary.length) {
    coverage = truncateText(`${coverage}; summary truncated`, 256);
  }
  return {
    id: input.id,
    code: input.code,
    status: input.status,
    severity: input.severity,
    title: input.title,
    summary,
    source: input.source,
    observedAt: input.observedAt,
    coverage: coverage === '' ? null : coverage,
    evidence: [...evidence.values()],
    nextActions: actions,
  };
}

function fileEvidence(
  path: string,
  observedAt: string,
  digest: string | null,
  scope: EvidenceRef['scope'] = 'persisted',
): EvidenceRef {
  return { kind: 'file', ref: path, digest, observedAt, scope };
}

function diagnosticsSummary(diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .slice(0, 4)
    .map((entry) => `${entry.code}: ${entry.message}`)
    .join(' | ');
}

function statusForDiagnostics(
  diagnostics: readonly Diagnostic[],
  fallback: DoctorCheckStatus,
): DoctorCheckStatus {
  if (diagnostics.some((entry) => entry.severity === 'error')) return 'error';
  if (diagnostics.some((entry) => entry.severity === 'warning')) {
    return 'warning';
  }
  return fallback;
}

async function inspectInstallState(
  root: string,
  observedAt: string,
): Promise<DoctorCheck> {
  const paths = workspaceInstallPaths(root);
  const evidence: EvidenceRef[] = [];
  const actions: string[] = [];
  const state = { status: 'ok' as DoctorCheckStatus };
  const problems: string[] = [];
  const escalate = (next: DoctorCheckStatus): void => {
    const order: Record<DoctorCheckStatus, number> = {
      ok: 0,
      unsupported: 1,
      unknown: 2,
      warning: 3,
      partial: 4,
      error: 5,
    };
    if (order[next] > order[state.status]) state.status = next;
  };

  const realRoot = await resolveRealpath(root);
  const manifestBoundary = await ensureStatePathBoundary(
    root,
    paths.manifestPath,
  );
  const realManifest = await resolveRealpath(paths.manifestPath);
  const manifestUnsafe =
    !manifestBoundary.ok ||
    (realManifest !== null &&
      (realRoot === null || !isPathInside(realRoot, realManifest)));
  const manifest = manifestUnsafe ? null : await readWorkspaceManifest(root);
  if (manifest === null) {
    escalate('error');
    problems.push(
      'installation manifest path is unsafe or escapes the workspace',
    );
    actions.push(
      'Inspect .pappra/local/install-manifest.json; doctor does not read through unsafe paths.',
    );
  } else if (manifest.diagnostics.length > 0) {
    escalate('error');
    problems.push(diagnosticsSummary(manifest.diagnostics));
    actions.push(
      'Inspect install-manifest.json; doctor does not repair or migrate it.',
    );
  } else if (manifest.exists && manifest.value !== null) {
    evidence.push(
      fileEvidence(paths.manifestPath, observedAt, manifest.digest),
    );
    const identity = await rootIdentityOf(root);
    if (
      identity === null ||
      identity.dev !== manifest.value.rootIdentity.dev ||
      identity.ino !== manifest.value.rootIdentity.ino
    ) {
      escalate('error');
      problems.push(
        'manifest root identity does not match the current workspace',
      );
      actions.push(
        'Do not reuse this installation manifest for the current root.',
      );
    }
    for (const entry of manifest.value.entries) {
      const state = await inspectOwnedFile(root, entry);
      if (state.status === 'missing') {
        escalate('warning');
        problems.push(`managed file missing: ${entry.path}`);
        actions.push(
          `Restore or explicitly reconcile ${entry.path}; doctor does not write it.`,
        );
      } else if (state.status !== 'match') {
        escalate('warning');
        problems.push(`managed file changed: ${entry.path} (${state.status})`);
        actions.push(
          `Review ${entry.path}; rollback/uninstall will preserve the user-modified file.`,
        );
      }
      if (entry.backupRef !== null) {
        const backupPath = isAbsolute(entry.backupRef)
          ? resolve(entry.backupRef)
          : join(root, ...entry.backupRef.split('/'));
        const backupBoundary = await ensureStatePathBoundary(root, backupPath);
        const realBackup = await resolveRealpath(backupPath);
        const backupEscapes =
          realBackup !== null &&
          (realRoot === null || !isPathInside(realRoot, realBackup));
        if (!backupBoundary.ok || backupEscapes) {
          escalate('warning');
          problems.push(`backup path is unsafe: ${entry.backupRef}`);
          actions.push(
            `Inspect backup ${entry.backupRef}; doctor does not read outside the workspace.`,
          );
        } else {
          const backup = await readFileBounded(backupPath, 4 * 1024 * 1024);
          if (!backup.ok) {
            escalate('warning');
            problems.push(
              `backup is missing or not a readable regular file: ${entry.backupRef} (${backup.code})`,
            );
            actions.push(
              `Inspect backup ${entry.backupRef}; rollback will preserve the current file.`,
            );
          } else if (
            entry.backupDigest !== null &&
            backup.value.digest !== entry.backupDigest
          ) {
            escalate('warning');
            problems.push(`backup digest mismatch: ${entry.backupRef}`);
            actions.push(
              `Inspect backup ${entry.backupRef}; doctor does not restore it.`,
            );
          }
        }
      }
    }
  } else if (!manifest.exists) {
    escalate('unknown');
    problems.push(
      'workspace has no P04 installation manifest; existing files are unmanaged',
    );
    actions.push(
      'Use an explicit managed init/apply before expecting rollback or uninstall ownership.',
    );
  }

  const journalScan = await scanJournalDirectory(paths.journalsDir);
  if (journalScan.kind === 'unreadable') {
    escalate('error');
    problems.push(
      `cannot read journal directory: ${paths.journalsDir} (${journalScan.error ?? 'unreadable'})`,
    );
    actions.push(
      `Inspect journal directory ${paths.journalsDir}; doctor did not treat it as empty.`,
    );
    evidence.push(fileEvidence(paths.journalsDir, observedAt, null));
  }
  for (const path of journalScan.nonRegular) {
    escalate('error');
    problems.push(`journal candidate is not a regular file: ${path}`);
    actions.push(
      `Inspect ${path}; doctor does not follow, read, migrate, or repair non-regular journal candidates.`,
    );
    evidence.push(fileEvidence(path, observedAt, null));
  }
  const journalCount = journalScan.files.length + journalScan.nonRegular.length;
  if (journalCount > 32) {
    problems.push(
      `${journalCount} journal candidates observed; evidence/actions are bounded to 32/16 entries.`,
    );
  }
  for (const path of journalScan.files) {
    const read = await readInstallJournal(path);
    evidence.push(fileEvidence(path, observedAt, read.digest));
    if (read.value === null) {
      escalate('error');
      problems.push(`unreadable/incompatible install journal: ${path}`);
      actions.push(
        `Inspect journal ${path}; doctor does not migrate or retry it.`,
      );
      continue;
    }
    if (
      read.value.status !== 'verified' &&
      read.value.status !== 'rolled-back'
    ) {
      escalate('warning');
      problems.push(
        `install journal ${read.value.installId} is ${read.value.status}`,
      );
      actions.push(
        `Inspect journal ${path}; Pappra does not resume or clean it automatically.`,
      );
    }
    if (read.value.residuals.length > 0) {
      escalate('warning');
      problems.push(
        `journal ${read.value.installId} has residuals: ${read.value.residuals.join(', ')}`,
      );
      actions.push(
        'Inspect residual paths manually; doctor does not delete them.',
      );
    }
  }
  const lockObservation = await observePath(paths.lockPath);
  const lock = lockObservation.kind !== 'missing';
  if (lock) {
    escalate('warning');
    evidence.push(fileEvidence(paths.lockPath, observedAt, null));
    problems.push(`workspace lock exists: ${paths.lockPath}`);
    actions.push(
      'Inspect the lock owner; doctor does not reclaim locks by age.',
    );
  }

  const finalStatus = state.status;
  return makeCheck({
    id: 'install.workspace',
    code:
      finalStatus === 'error'
        ? diagnosticCodes.doctor_install_state_invalid
        : finalStatus === 'warning' || finalStatus === 'partial'
          ? diagnosticCodes.doctor_install_partial
          : finalStatus === 'ok'
            ? diagnosticCodes.doctor_install_ok
            : diagnosticCodes.doctor_install_unknown,
    status: finalStatus,
    severity:
      finalStatus === 'error'
        ? 'error'
        : finalStatus === 'ok'
          ? 'info'
          : 'warning',
    title: 'Managed workspace installation state',
    summary:
      problems.length === 0
        ? 'No unresolved P04 managed-install state was found.'
        : problems.join('; '),
    source: paths.manifestPath,
    observedAt,
    coverage: 'current workspace ownership, journals, lock, backups',
    evidence,
    nextActions: actions,
  });
}

function runtimeCheck(
  targetVersion: string | null,
  machineRuntime: MachineConfig['runtime'],
  passive: Awaited<ReturnType<typeof inspectRuntimeStatePassive>> | null,
  machinePath: string | null,
  observedAt: string,
  dataDir: string,
): DoctorCheck {
  if (targetVersion === null) {
    return makeCheck({
      id: 'runtime.state',
      code: diagnosticCodes.doctor_runtime_unknown,
      status: 'unknown',
      severity: 'info',
      title: 'Runtime target and installed state',
      summary: 'Workspace configuration does not declare a runtime target.',
      source: machinePath ?? dataDir,
      observedAt,
      coverage: 'workspace runtime target and machine runtime',
      nextActions: ['Run pappra init to establish a workspace runtime target.'],
    });
  }
  if (passive?.status === 'incompatible') {
    return makeCheck({
      id: 'runtime.state',
      code: diagnosticCodes.runtimeStateIncompatible,
      status: 'error',
      severity: 'error',
      title: 'Runtime state requires reinitialization',
      summary: diagnosticsSummary(passive.diagnostics),
      source: passive.runtimeRoot,
      observedAt,
      nextActions: passive.diagnostics.flatMap((entry) =>
        entry.hint === null ? [] : [entry.hint],
      ),
    });
  }
  if (machineRuntime === null) {
    if (passive === null) {
      return makeCheck({
        id: 'runtime.state',
        code: diagnosticCodes.doctor_runtime_missing,
        status: 'warning',
        severity: 'warning',
        title: 'Runtime target and installed state',
        summary: `Workspace targets ${targetVersion}, but machine.json has no runtime binding and no passive state could be read.`,
        source: machinePath ?? dataDir,
        observedAt,
        nextActions: [
          'Run pappra runtime install --apply (from self, tarball, or an exact version) or pappra init --apply when authorized.',
        ],
      });
    }
    const unboundState = passive.status;
    if (unboundState === 'locked') {
      return makeCheck({
        id: 'runtime.state',
        code: diagnosticCodes.doctor_runtime_locked,
        status: 'warning',
        severity: 'warning',
        title: 'Runtime target and installed state',
        summary: `Target runtime ${targetVersion} has a leftover installation lock; machine.json is not bound yet.`,
        source: passive.lockPath,
        observedAt,
        evidence: [fileEvidence(passive.lockPath, observedAt, null)],
        nextActions: [
          'Inspect the lock; doctor does not reclaim it or bind the runtime.',
        ],
      });
    }
    if (unboundState === 'partial') {
      return makeCheck({
        id: 'runtime.state',
        code: diagnosticCodes.doctor_runtime_partial,
        status: 'partial',
        severity: 'warning',
        title: 'Runtime target and installed state',
        summary: `Target runtime ${targetVersion} has an incomplete installation journal; machine.json is not bound yet.`,
        source: passive.runtimeRoot,
        observedAt,
        evidence: [fileEvidence(passive.runtimeRoot, observedAt, null)],
        nextActions: [
          'Inspect the journal; doctor does not resume an interrupted first install.',
        ],
      });
    }
    if (
      unboundState === 'corrupt' ||
      unboundState === 'unreadable' ||
      unboundState === 'version-mismatch'
    ) {
      return makeCheck({
        id: 'runtime.state',
        code:
          unboundState === 'unreadable'
            ? diagnosticCodes.doctor_read_error
            : unboundState === 'version-mismatch'
              ? diagnosticCodes.doctor_runtime_mismatch
              : diagnosticCodes.doctor_runtime_corrupt,
        status: 'error',
        severity: 'error',
        title: 'Runtime target and installed state',
        summary: `Target runtime ${targetVersion} is ${unboundState} and machine.json is not bound: ${diagnosticsSummary(passive.diagnostics)}`,
        source: passive.runtimeRoot,
        observedAt,
        evidence: [fileEvidence(passive.runtimeRoot, observedAt, null)],
        nextActions: [
          'Inspect the runtime; doctor does not reinstall or bind it.',
        ],
      });
    }
    return makeCheck({
      id: 'runtime.state',
      code: diagnosticCodes.doctor_runtime_missing,
      status: 'warning',
      severity: 'warning',
      title: 'Runtime target and installed state',
      summary:
        unboundState === 'content-match'
          ? `Target runtime ${targetVersion} content matches its manifest, but machine.json has no runtime binding.`
          : `Workspace targets ${targetVersion}, but machine.json has no verified runtime location.`,
      source: machinePath ?? dataDir,
      observedAt,
      evidence:
        unboundState === 'content-match'
          ? [
              fileEvidence(
                join(passive.runtimeRoot, 'install-manifest.json'),
                observedAt,
                null,
              ),
            ]
          : [],
      nextActions: [
        'Run pappra runtime install --apply (from self, tarball, or an exact version) or pappra init --apply when authorized.',
      ],
    });
  }
  if (machineRuntime.version !== targetVersion) {
    return makeCheck({
      id: 'runtime.state',
      code: diagnosticCodes.doctor_runtime_mismatch,
      status: 'error',
      severity: 'error',
      title: 'Runtime target and installed state',
      summary: `Workspace targets ${targetVersion}, but machine.json points to ${machineRuntime.version}.`,
      source: machinePath ?? dataDir,
      observedAt,
      evidence: [fileEvidence(machineRuntime.executable, observedAt, null)],
      nextActions: [
        'Do not switch runtime automatically. Inspect the workspace revision and machine mapping, then use an explicit update/repair plan.',
      ],
    });
  }
  if (passive === null) {
    return makeCheck({
      id: 'runtime.state',
      code: diagnosticCodes.doctor_runtime_unknown,
      status: 'unknown',
      severity: 'warning',
      title: 'Runtime target and installed state',
      summary:
        'Machine runtime is recorded, but passive runtime state could not be read.',
      source: machinePath ?? dataDir,
      observedAt,
      nextActions: [
        'Inspect the runtime data directory and machine.json manually.',
      ],
    });
  }
  const evidence: EvidenceRef[] = [
    fileEvidence(
      join(passive.runtimeRoot, 'install-manifest.json'),
      observedAt,
      null,
    ),
    fileEvidence(machineRuntime.executable, observedAt, null),
  ];
  const state = passive.status;
  if (state === 'content-match') {
    const executableMatches =
      passive.manifest !== null &&
      machineRuntime.executable === passive.manifest.executable;
    if (!executableMatches) {
      return makeCheck({
        id: 'runtime.state',
        code: diagnosticCodes.doctor_runtime_mismatch,
        status: 'error',
        severity: 'error',
        title: 'Runtime target and installed state',
        summary:
          'machine.json executable does not match the verified runtime manifest.',
        source: machineRuntime.executable,
        observedAt,
        evidence,
        nextActions: [
          'Run an explicit runtime repair/update plan; doctor does not rewrite machine.json.',
        ],
      });
    }
    return makeCheck({
      id: 'runtime.state',
      code: diagnosticCodes.doctor_runtime_unverified,
      status: 'partial',
      severity: 'warning',
      title: 'Runtime target and installed state',
      summary: `Runtime content digest matches its manifest, but doctor did not execute smoke. Historical verifiedAt ${passive.manifest?.verifiedAt ?? 'unknown'} is evidence only, not current callability.`,
      source: passive.runtimeRoot,
      observedAt,
      coverage: 'exact version, manifest, package digest, executable presence',
      evidence,
      nextActions: [
        'Do not treat this as a current callable-runtime proof. Run an explicit active runtime verify/install only with authorization; doctor does not execute it.',
      ],
    });
  }
  if (state === 'missing') {
    return makeCheck({
      id: 'runtime.state',
      code: diagnosticCodes.doctor_runtime_missing,
      status: 'warning',
      severity: 'warning',
      title: 'Runtime target and installed state',
      summary: `Runtime ${targetVersion} is recorded in machine.json but missing from ${dataDir}.`,
      source: passive.runtimeRoot,
      observedAt,
      evidence,
      nextActions: [
        'Run an explicit init/install with a chosen runtime source when authorized; doctor does not install.',
      ],
    });
  }
  if (state === 'locked') {
    return makeCheck({
      id: 'runtime.state',
      code: diagnosticCodes.doctor_runtime_locked,
      status: 'warning',
      severity: 'warning',
      title: 'Runtime target and installed state',
      summary: `Runtime ${targetVersion} has a leftover installation lock.`,
      source: passive.lockPath,
      observedAt,
      evidence,
      nextActions: [
        'Inspect the lock owner and journal; doctor does not reclaim, rerun, or delete the lock.',
      ],
    });
  }
  if (state === 'partial') {
    return makeCheck({
      id: 'runtime.state',
      code: diagnosticCodes.doctor_runtime_partial,
      status: 'partial',
      severity: 'warning',
      title: 'Runtime target and installed state',
      summary: `Runtime ${targetVersion} has an incomplete installation journal.`,
      source: passive.runtimeRoot,
      observedAt,
      evidence,
      nextActions: [
        'Inspect the journal and staging directory; doctor does not resume an interrupted install.',
      ],
    });
  }
  if (state === 'version-mismatch') {
    return makeCheck({
      id: 'runtime.state',
      code: diagnosticCodes.doctor_runtime_mismatch,
      status: 'error',
      severity: 'error',
      title: 'Runtime target and installed state',
      summary: `Runtime manifest does not match target ${targetVersion}.`,
      source: passive.runtimeRoot,
      observedAt,
      evidence,
      nextActions: [
        'Inspect the runtime and machine mapping; doctor does not switch versions.',
      ],
    });
  }
  return makeCheck({
    id: 'runtime.state',
    code:
      state === 'unreadable'
        ? diagnosticCodes.doctor_read_error
        : diagnosticCodes.doctor_runtime_corrupt,
    status: 'error',
    severity: 'error',
    title: 'Runtime target and installed state',
    summary: `Runtime state is ${state}: ${diagnosticsSummary(passive.diagnostics)}`,
    source: passive.runtimeRoot,
    observedAt,
    evidence,
    nextActions: [
      'Inspect the runtime manifest/package; doctor does not reinstall or overwrite it.',
    ],
  });
}

function hostChecks(
  selectedHosts: readonly string[],
  homeDir: string,
  pathEnv: string,
  observedAt: string,
): readonly DoctorCheck[] {
  const hosts = detectPassiveHosts({
    homeDir,
    pathEnv,
    selectedHosts,
    observedAt,
  });
  return hosts.map((host) => {
    const selected = host.selected;
    if (!host.discovered) {
      return makeCheck({
        id: `host.${host.host}`,
        code: selected
          ? diagnosticCodes.doctor_host_missing
          : diagnosticCodes.doctor_host_discovered_unverified,
        status: selected ? 'warning' : 'ok',
        severity: selected ? 'warning' : 'info',
        title: `Host ${host.host}`,
        summary: selected
          ? `Selected host ${host.host} executable was not discovered on PATH.`
          : `Host ${host.host} is not selected and no executable was discovered.`,
        source: host.host,
        observedAt,
        coverage: 'PATH filesystem presence only; no host started',
        evidence: host.evidence,
        nextActions: selected
          ? [
              'Install or select a supported host explicitly; P09 integration/callability is not verified.',
            ]
          : [],
      });
    }
    return makeCheck({
      id: `host.${host.host}`,
      code: host.configured
        ? diagnosticCodes.doctor_host_config_present
        : diagnosticCodes.doctor_host_discovered_unverified,
      status: 'unsupported',
      severity: 'info',
      title: `Host ${host.host}`,
      summary: `Executable discovered${host.configured ? '; a host config path exists' : ''}. Callability, trust, and P09 integration are not verified; config presence is not Pappra wiring.`,
      source: host.executablePath ?? host.host,
      observedAt,
      coverage: 'path/config existence only',
      evidence: host.evidence,
      nextActions: [
        'P09 host integration and runtime probes are not implemented; no host or model was started.',
      ],
    });
  });
}

function toolCheck(
  name: 'codegraph' | 'serena',
  preference: string | null,
  pathEnv: string,
  observedAt: string,
): DoctorCheck {
  if (preference === null) {
    return makeCheck({
      id: `tool.${name}`,
      code: diagnosticCodes.doctor_tool_discovered_unverified,
      status: 'unknown',
      severity: 'info',
      title: `Tool ${name}`,
      summary:
        'No workspace preference is readable; tool availability was not inferred.',
      source: name,
      observedAt,
      coverage: 'PATH filesystem presence only; no execution',
      nextActions: [
        'Run pappra init to declare code-intelligence preferences.',
      ],
    });
  }
  if (preference === 'none' || (name === 'serena' && preference === 'auto')) {
    return makeCheck({
      id: `tool.${name}`,
      code:
        preference === 'none'
          ? diagnosticCodes.doctor_tool_disabled
          : diagnosticCodes.doctor_tool_discovered_unverified,
      status: 'ok',
      severity: 'info',
      title: `Tool ${name}`,
      summary:
        preference === 'none'
          ? `${name} is disabled by workspace policy.`
          : 'auto does not prove a provider is available; no implicit installation or indexing is performed.',
      source: name,
      observedAt,
      coverage: 'preference only',
      nextActions: [],
    });
  }
  const tool = detectPassiveTool(name, pathEnv);
  if (!tool.discovered) {
    return makeCheck({
      id: `tool.${name}`,
      code: diagnosticCodes.doctor_tool_preference_unavailable,
      status: 'warning',
      severity: 'warning',
      title: `Tool ${name}`,
      summary: `Workspace preference is ${preference}, but ${name} was not discovered on PATH.`,
      source: name,
      observedAt,
      coverage: 'PATH filesystem presence only; no execution',
      nextActions: [
        'Install or configure the tool explicitly only if authorized; doctor does not run package managers or prepare indexes.',
      ],
    });
  }
  return makeCheck({
    id: `tool.${name}`,
    code: diagnosticCodes.doctor_tool_discovered_unverified,
    status: 'unsupported',
    severity: 'info',
    title: `Tool ${name}`,
    summary: `${name} was discovered at ${tool.executablePath}, but callability/index health is not verified by P05.`,
    source: tool.executablePath ?? name,
    observedAt,
    coverage: 'path presence only',
    evidence: [fileEvidence(tool.executablePath ?? name, observedAt, null)],
    nextActions: [
      'P08 code intelligence/index verification is not implemented; no index was prepared.',
    ],
  });
}

export async function runDoctor(
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const observedAt = (options.now ?? new Date()).toISOString();
  const dataDir = options.dataDir ?? resolveUserDataDir();
  const homeDir = options.homeDir ?? homedir();
  const pathEnv = options.pathEnv ?? process.env['PATH'] ?? '';
  const resolution = await resolveWorkspaceRoot({
    startPath: options.root ?? process.cwd(),
  });
  const checks: DoctorCheck[] = [];
  const root = resolution.root;
  let config: WorkspaceConfig | null = null;
  let machine: MachineConfig | null = null;
  let discovery: WorkspaceDiscovery | null = null;
  let configPath: string | null = null;
  let machinePath: string | null = null;

  checks.push(
    makeCheck({
      id: 'workspace.root',
      code:
        resolution.state === 'registered'
          ? diagnosticCodes.doctor_workspace_registered
          : resolution.state === 'missing'
            ? diagnosticCodes.doctor_workspace_not_registered
            : resolution.state === 'incomplete'
              ? diagnosticCodes.doctor_workspace_incomplete
              : diagnosticCodes.doctor_workspace_unavailable,
      status:
        resolution.state === 'registered'
          ? 'ok'
          : resolution.state === 'missing'
            ? 'warning'
            : 'error',
      severity:
        resolution.state === 'registered'
          ? 'info'
          : resolution.state === 'missing'
            ? 'warning'
            : 'error',
      title: 'Workspace root resolution',
      summary:
        resolution.state === 'registered'
          ? `Registered workspace root: ${root ?? '(unknown)'}`
          : resolution.state === 'missing'
            ? 'No registered Pappra workspace was found above the requested path.'
            : `Workspace root resolution is ${resolution.state}: ${diagnosticsSummary(resolution.diagnostics)}`,
      source: resolution.startDirectory ?? resolution.requestedPath,
      observedAt,
      coverage: 'nearest registered .pappra marker only; no home scan',
      evidence: root === null ? [] : [fileEvidence(root, observedAt, null)],
      nextActions:
        resolution.state === 'missing'
          ? ['Run pappra init from the intended workspace root.']
          : resolution.state === 'registered'
            ? []
            : [
                'Inspect the workspace marker/root path; doctor does not repair it.',
              ],
    }),
  );

  if (root !== null) {
    const resetState = await inspectLocalResetState(root);
    if (resetState === 'pending' || resetState === 'unreadable')
      checks.push(
        makeCheck({
          id: 'state.local-reset',
          code: diagnosticCodes.initApplyResidual,
          status: 'warning',
          severity: 'warning',
          title: 'Private local reset',
          summary: `Local reset metadata is ${resetState}; retained archives were not changed.`,
          source: join(root, '.pappra/local-archive/pending-reset.json'),
          observedAt,
          coverage:
            'read-only local reset journal status; no process is stopped or adopted',
          evidence: [],
          nextActions: [
            'After stopping all affected writers, resume with pappra repair --reset-local --all-writers-stopped --apply.',
          ],
        }),
      );
    try {
      const locks = await inspectWorkspaceLocks(root);
      const needsRepair = locks.some(
        (lock) => lock.state === 'dead' || lock.state === 'unknown',
      );
      checks.push(
        makeCheck({
          id: 'state.writer-locks',
          code: diagnosticCodes.document_locked,
          status: needsRepair ? 'warning' : 'ok',
          severity: needsRepair ? 'warning' : 'info',
          title: 'Private writer locks',
          summary:
            locks.length === 0
              ? 'No private writer lock remains.'
              : locks.map((lock) => `${lock.state}: ${lock.file}`).join('; '),
          source: join(root, '.pappra/local'),
          observedAt,
          coverage:
            'bounded install, knowledge and checkpoint lock inventory; process identity or positive owner-death evidence',
          evidence: locks.map((lock) =>
            fileEvidence(lock.file, observedAt, lock.digest),
          ),
          nextActions: needsRepair
            ? [
                'Run pappra repair to inspect owner states; use --apply only for provably dead writers. Unknown/live owners are preserved.',
              ]
            : [],
        }),
      );
    } catch (error) {
      checks.push(
        makeCheck({
          id: 'state.writer-locks',
          code: diagnosticCodes.document_locked,
          status: 'error',
          severity: 'error',
          title: 'Private writer locks',
          summary: `Cannot inspect private lock state: ${error instanceof Error ? error.message : String(error)}`,
          source: join(root, '.pappra/local'),
          observedAt,
          coverage:
            'private lock paths are unsafe or inventory was unavailable',
          evidence: [],
          nextActions: [
            'Inspect pappra repair output and the reported path; no lock was changed.',
          ],
        }),
      );
    }
    const workspaceInspection = await inspectWorkspaceConfig(root, {
      missing: 'info',
    });
    const machineInspection = await inspectMachineConfig(root);
    configPath = workspaceInspection.path;
    machinePath = machineInspection.path;
    config = workspaceInspection.value;
    machine = machineInspection.value;
    discovery = await discoverWorkspace(root);

    const configDiagnostics = workspaceInspection.diagnostics;
    const configStatus = config
      ? statusForDiagnostics(configDiagnostics, 'ok')
      : workspaceInspection.exists
        ? 'error'
        : 'warning';
    checks.push(
      makeCheck({
        id: 'workspace.config',
        code: config
          ? configStatus === 'ok'
            ? diagnosticCodes.doctor_config_valid
            : diagnosticCodes.doctor_config_invalid
          : workspaceInspection.exists
            ? diagnosticCodes.doctor_config_invalid
            : diagnosticCodes.doctor_config_missing,
        status: configStatus,
        severity:
          configStatus === 'error'
            ? 'error'
            : configStatus === 'warning'
              ? 'warning'
              : 'info',
        title: 'Workspace configuration',
        summary: config
          ? `Valid workspace configuration${configDiagnostics.length > 0 ? `; ${diagnosticsSummary(configDiagnostics)}` : ''}.`
          : workspaceInspection.exists
            ? `Workspace configuration is invalid: ${diagnosticsSummary(configDiagnostics)}`
            : 'Workspace configuration is missing.',
        source: workspaceInspection.path,
        observedAt,
        coverage: 'strict schema, semantic checks, digest',
        evidence: [
          fileEvidence(
            workspaceInspection.path,
            observedAt,
            workspaceInspection.digest,
          ),
        ],
        nextActions: config
          ? []
          : workspaceInspection.exists
            ? [
                'Inspect and repair the configuration manually; doctor does not overwrite it.',
              ]
            : ['Run pappra init to create configuration.'],
      }),
    );

    const machineDiagnostics = machineInspection.diagnostics;
    const machineStatus = machine
      ? statusForDiagnostics(machineDiagnostics, 'ok')
      : machineInspection.exists
        ? 'error'
        : 'warning';
    checks.push(
      makeCheck({
        id: 'workspace.machine',
        code:
          machineStatus === 'ok'
            ? diagnosticCodes.doctor_machine_valid
            : machineStatus === 'error'
              ? diagnosticCodes.doctor_machine_invalid
              : diagnosticCodes.doctor_config_missing,
        status: machineStatus,
        severity:
          machineStatus === 'error'
            ? 'error'
            : machineStatus === 'warning'
              ? 'warning'
              : 'info',
        title: 'Local machine configuration',
        summary: machine
          ? `Valid machine configuration${machineDiagnostics.length > 0 ? `; ${diagnosticsSummary(machineDiagnostics)}` : ''}.`
          : machineInspection.exists
            ? `Machine configuration is invalid: ${diagnosticsSummary(machineDiagnostics)}`
            : 'Machine configuration is missing; local paths/hosts/runtime are not bound.',
        source: machineInspection.path,
        observedAt,
        coverage: 'strict schema and workspace identity',
        evidence: [
          fileEvidence(
            machineInspection.path,
            observedAt,
            machineInspection.digest,
          ),
        ],
        nextActions: machine
          ? []
          : [
              'Run pappra init with --config (including hosts) or an interactive TTY.',
            ],
      }),
    );

    const discoveryDiagnostics = discovery.diagnostics;
    const repositoryErrors = discoveryDiagnostics.filter(
      (entry) =>
        entry.severity === 'error' &&
        (entry.code === diagnosticCodes.repositoryPathMissing ||
          entry.code === diagnosticCodes.repositoryNotGit ||
          entry.code === diagnosticCodes.repositorySymlinkEscape ||
          entry.code === diagnosticCodes.repositoryNestedWorkspace ||
          entry.code === diagnosticCodes.externalRepositoryUnmapped ||
          entry.code === diagnosticCodes.externalRepositoryInvalid),
    );
    const repositoryWarnings = discoveryDiagnostics.filter(
      (entry) => entry.severity === 'warning',
    );
    const repoStatus =
      repositoryErrors.length > 0
        ? 'error'
        : repositoryWarnings.length > 0 ||
            discovery.unresolvedRepositories.length > 0
          ? 'warning'
          : 'ok';
    checks.push(
      makeCheck({
        id: 'workspace.repositories',
        code:
          repoStatus === 'ok'
            ? diagnosticCodes.doctor_repository_ok
            : diagnosticCodes.doctor_repository_issues,
        status: repoStatus,
        severity:
          repoStatus === 'error'
            ? 'error'
            : repoStatus === 'warning'
              ? 'warning'
              : 'info',
        title: 'Repositories and worktrees',
        summary:
          `Discovered ${discovery.repositories.length} repository checkout(s).` +
          (discovery.boundaries.length > 0
            ? ` Nested workspace boundaries observed (not entered): ${discovery.boundaries.join(', ')}.`
            : '') +
          (repositoryErrors.length + repositoryWarnings.length > 0
            ? ` ${diagnosticsSummary([...repositoryErrors, ...repositoryWarnings])}`
            : ''),
        source: root,
        observedAt,
        coverage: 'read-only discovery; no fetch/source scan/scripts',
        evidence: discovery.repositories.flatMap((repository) =>
          repository.git.evidence.slice(0, 1),
        ),
        nextActions:
          repoStatus === 'error'
            ? [
                'Correct repository declarations or local mappings manually; doctor does not clone or move repositories.',
              ]
            : [],
      }),
    );

    const knowledgeDiagnostics = discoveryDiagnostics.filter(
      (entry) =>
        entry.code === diagnosticCodes.knowledgeSourceMissing ||
        entry.code === diagnosticCodes.knowledgeSourceSymlinkEscape ||
        entry.code === diagnosticCodes.knowledgeSourceNotReadable,
    );
    checks.push(
      makeCheck({
        id: 'workspace.knowledge',
        code: knowledgeDiagnostics.some((entry) => entry.severity === 'error')
          ? diagnosticCodes.doctor_knowledge_issues
          : diagnosticCodes.doctor_knowledge_issues,
        status: knowledgeDiagnostics.some((entry) => entry.severity === 'error')
          ? 'warning'
          : 'ok',
        severity: knowledgeDiagnostics.some(
          (entry) => entry.severity === 'error',
        )
          ? 'warning'
          : 'info',
        title: 'Knowledge and rules',
        summary: `Discovered ${discovery.documents.length} rule/document candidate(s) in place.${knowledgeDiagnostics.length > 0 ? ` ${diagnosticsSummary(knowledgeDiagnostics)}` : ''}`,
        source: configPath ?? root,
        observedAt,
        coverage: 'paths and provenance only; document contents not read',
        evidence: discovery.documents
          .slice(0, 5)
          .map((document) => fileEvidence(document.path, observedAt, null)),
        nextActions:
          knowledgeDiagnostics.length > 0
            ? [
                'Inspect declared knowledge sources; doctor does not copy or repair documentation.',
              ]
            : [],
      }),
    );

    checks.push(
      makeCheck({
        id: 'workspace.validation',
        code: diagnosticCodes.doctor_validation_unverified,
        status: 'ok',
        severity: 'info',
        title: 'Validation command candidates',
        summary: `Discovered ${discovery.validationCandidates.length} validation candidate(s); none are executed, PATH-resolved, or proven runnable.`,
        source: configPath ?? root,
        observedAt,
        coverage: 'declarations from config/package scripts only',
        nextActions: [
          'Select specific commands and run them only within an authorized task/environment.',
        ],
      }),
    );
    checks.push(await inspectInstallState(root, observedAt));
  } else {
    for (const [id, title] of [
      ['workspace.config', 'Workspace configuration'],
      ['workspace.machine', 'Local machine configuration'],
      ['workspace.repositories', 'Repositories and worktrees'],
      ['workspace.knowledge', 'Knowledge and rules'],
      ['workspace.validation', 'Validation command candidates'],
      ['install.workspace', 'Managed workspace installation state'],
    ] as const) {
      checks.push(
        makeCheck({
          id,
          code: diagnosticCodes.doctor_workspace_not_registered,
          status: 'unknown',
          severity: 'warning',
          title,
          summary:
            'Not checked because no registered workspace root is available.',
          source: resolution.startDirectory ?? resolution.requestedPath,
          observedAt,
          coverage: 'not checked',
          nextActions: ['Run from a registered workspace or run pappra init.'],
        }),
      );
    }
  }

  const passiveVersion =
    config?.runtimeVersion ?? machine?.runtime?.version ?? null;
  const passiveRuntime =
    passiveVersion === null
      ? null
      : await inspectRuntimeStatePassive(passiveVersion, dataDir);
  checks.push(
    runtimeCheck(
      config?.runtimeVersion ?? null,
      machine?.runtime ?? null,
      passiveRuntime,
      machinePath,
      observedAt,
      dataDir,
    ),
  );
  checks.push(
    makeCheck({
      id: 'runtime.references',
      code: diagnosticCodes.doctor_references_incomplete,
      status: 'unknown',
      severity: 'info',
      title: 'Runtime reference coverage',
      summary:
        machine?.runtime === null || machine?.runtime === undefined
          ? 'No current workspace runtime reference. Global runtime references were not checked.'
          : `Current workspace references ${machine.runtime.version}; other workspaces and global processes were not checked.`,
      source: machinePath ?? dataDir,
      observedAt,
      coverage: 'current workspace machine runtime only',
      evidence:
        machine?.runtime === null || machine?.runtime === undefined
          ? []
          : [fileEvidence(machine.runtime.executable, observedAt, null)],
      nextActions: [
        'Do not remove runtime from this report alone; provide explicit known references or complete a future global reference check.',
      ],
    }),
  );

  const selectedHosts = machine?.selectedHosts ?? [];
  const observableHosts = ['pi', 'codex', 'claude'] as const;
  // Passive observation only: a host install can target the private default root, a
  // project directory, or Codex's user configuration directory.
  const hostInstallRoots = (host: 'pi' | 'codex' | 'claude'): string[] => {
    const roots = [
      join(root ?? homeDir, '.pappra', 'local', 'hosts', host),
      join(root ?? homeDir, `.${host}`),
    ];
    if (host === 'codex') {
      roots.push(process.env['CODEX_HOME'] ?? join(homeDir, '.codex'));
    }
    return roots;
  };
  const installedHostBundle =
    (
      await Promise.all(
        observableHosts.map(async (host) => {
          for (const base of hostInstallRoots(host)) {
            const path = join(base, 'pappra-host.json');
            if ((await observePath(path)).kind === 'file') return path;
          }
          return null;
        }),
      )
    ).find((path) => path !== null) ?? null;
  const hostLocks = (
    await Promise.all(
      observableHosts.flatMap((host) =>
        hostInstallRoots(host).map(async (base) => ({
          host,
          base,
          owner: await inspectPrivateLock(join(base, '.pappra-host.lock')),
        })),
      ),
    )
  ).filter((entry) => entry.owner.state !== 'missing');
  if (hostLocks.length > 0)
    checks.push(
      makeCheck({
        id: 'host.install-locks',
        code: diagnosticCodes.host_install_conflict,
        status: hostLocks.every((entry) => entry.owner.state === 'alive')
          ? 'partial'
          : 'warning',
        severity: hostLocks.every((entry) => entry.owner.state === 'alive')
          ? 'info'
          : 'warning',
        title: 'Host installation locks',
        summary: `${hostLocks.length} host lock(s) observed; live owners are retained, dead owners can be reclaimed, and unknown owners require an explicit stopped-writer assertion.`,
        source: hostLocks[0]!.owner.file,
        observedAt,
        coverage: 'known project/private/user host roots only',
        evidence: hostLocks.map((entry) =>
          fileEvidence(entry.owner.file, observedAt, entry.owner.digest),
        ),
        nextActions: hostLocks.map((entry) =>
          entry.owner.state === 'alive'
            ? `Let the verified live ${entry.host} writer finish; --force cannot override it.`
            : entry.owner.state === 'dead'
              ? `Retry host install --host ${entry.host} --host-root ${JSON.stringify(entry.base)} to reclaim the proven dead owner.`
              : `Stop all writers for ${entry.base}, then run pappra host uninstall --host ${entry.host} --host-root ${JSON.stringify(entry.base)} --force --apply to archive an unknown lock.`,
        ),
      }),
    );
  const installedHostSkill =
    (
      await Promise.all(
        observableHosts.map(async (host) => {
          for (const base of hostInstallRoots(host)) {
            const path = join(base, 'skills', 'pappra', 'SKILL.md');
            if ((await observePath(path)).kind === 'file') return path;
          }
          return null;
        }),
      )
    ).find((path) => path !== null) ?? null;
  checks.push(...hostChecks(selectedHosts, homeDir, pathEnv, observedAt));
  checks.push(
    makeCheck({
      id: 'host.integration',
      code: diagnosticCodes.doctor_host_integration_unsupported,
      status: installedHostBundle === null ? 'unsupported' : 'partial',
      severity: 'info',
      title: 'Host integration',
      summary:
        installedHostBundle === null
          ? 'No host bundle manifest was observed under the known host roots; no host, session, or model was started.'
          : `P09 host bundle manifest exists at ${installedHostBundle}; native trust, reload and callability remain unverified and no host was started.`,
      source: installedHostBundle ?? root ?? homeDir,
      observedAt,
      coverage:
        installedHostBundle === null ? 'unsupported' : 'file-wiring-only',
      nextActions:
        installedHostBundle === null
          ? ['Install and verify a selected host explicitly when authorized.']
          : [
              'Run the read-only host verify path; native trust/reload/callability still require an explicit host check.',
            ],
    }),
  );
  checks.push(
    makeCheck({
      id: 'host.skills',
      code: diagnosticCodes.doctor_skill_verification_unsupported,
      status: installedHostSkill === null ? 'unsupported' : 'partial',
      severity: 'info',
      title: 'Skill/bundle freshness',
      summary:
        installedHostSkill === null
          ? 'No packaged P09 host skill was observed under the selected host roots; no stale-copy claim is made.'
          : `Packaged P09 skill exists at ${installedHostSkill}; native loader/trust freshness remains unverified.`,
      source: installedHostSkill ?? root ?? homeDir,
      observedAt,
      coverage: installedHostSkill === null ? 'unsupported' : 'file-copy-only',
      nextActions:
        installedHostSkill === null
          ? [
              'Install and verify a selected host bundle explicitly when authorized.',
            ]
          : [
              'Inspect the host bundle manifest/digest; native trust and reload are separate.',
            ],
    }),
  );

  checks.push(
    toolCheck('codegraph', config?.code.graph ?? null, pathEnv, observedAt),
  );
  checks.push(
    toolCheck('serena', config?.code.symbols ?? null, pathEnv, observedAt),
  );
  checks.push(
    makeCheck({
      id: 'tool.index',
      code: diagnosticCodes.doctor_tool_discovered_unverified,
      status: 'unsupported',
      severity: 'info',
      title: 'Code index',
      summary:
        'P08 code-index preparation/health is not implemented; doctor did not build or query an index.',
      source: root ?? dataDir,
      observedAt,
      coverage: 'unsupported',
      nextActions: [
        'Use P08 capabilities when available; doctor never builds an index.',
      ],
    }),
  );

  const counts = {
    ok: checks.filter((entry) => entry.status === 'ok').length,
    warning: checks.filter((entry) => entry.status === 'warning').length,
    error: checks.filter((entry) => entry.status === 'error').length,
    unknown: checks.filter((entry) => entry.status === 'unknown').length,
    partial: checks.filter((entry) => entry.status === 'partial').length,
    unsupported: checks.filter((entry) => entry.status === 'unsupported')
      .length,
  };
  const blocking = checks.some(
    (entry) =>
      entry.status === 'error' ||
      entry.status === 'warning' ||
      entry.status === 'partial' ||
      (entry.status === 'unknown' && entry.severity !== 'info') ||
      (entry.status === 'unsupported' && entry.severity === 'warning'),
  );
  const hasError = checks.some((entry) => entry.status === 'error');
  const nextActions = [
    ...new Set(checks.flatMap((entry) => entry.nextActions)),
  ].slice(0, 16);
  const report: DoctorReport = {
    schema: DOCTOR_REPORT_SCHEMA,
    generatedAt: observedAt,
    requestedRoot: resolution.requestedPath,
    workspace: {
      root,
      state: resolution.state,
      configPath,
      machinePath,
    },
    runtime: {
      targetVersion: config?.runtimeVersion ?? null,
      machineRuntime:
        machine?.runtime === null || machine?.runtime === undefined
          ? null
          : {
              version: machine.runtime.version,
              executable: machine.runtime.executable,
              verifiedAt: machine.runtime.verifiedAt,
            },
      dataDir,
      passiveStatus: passiveRuntime?.status ?? null,
    },
    scope: {
      checked: [
        'workspace-root',
        'workspace-config',
        'machine-config',
        'repositories',
        'knowledge',
        'validation',
        'workspace-install-state',
        'runtime-passive-state',
        'current-workspace-runtime-reference',
        'passive-host-discovery',
        'configured-tool-discovery',
      ],
      notChecked: [
        'other-workspace-runtime-references',
        'global-runtime-removal-safety',
        'host-callability',
        'host-trust',
        'model-session-history',
        'code-index-content',
        'windows-platform',
      ],
    },
    checks,
    summary: {
      status: hasError ? 'blocked' : blocking ? 'needs_attention' : 'ok',
      exitCode: blocking ? 1 : 0,
      counts,
      nextActions,
    },
  };
  const parsed = doctorReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new Error(
      `Internal doctor report is invalid: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`,
    );
  }
  return parsed.data;
}
