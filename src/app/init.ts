import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import type { Diagnostic } from '../schemas/diagnostics.js';
import {
  createDiagnostic,
  hasErrors,
  pointer,
} from '../schemas/diagnostics.js';
import type { DiagnosticCode } from '../schemas/errors.js';
import { diagnosticCodes } from '../schemas/errors.js';
import {
  INIT_CHOICES_SCHEMA,
  initPlanSchema,
  parseInitChoices,
  type InitChoices,
  type InitExternalAction,
  type InitPlan,
} from '../schemas/init.js';
import { machineConfigSchema, type MachineConfig } from '../schemas/machine.js';
import {
  isExternalRepositoryPath,
  isPathInside,
  isPortableRelativePath,
  normalizePortableRelativePath,
  resolvePortableRelativePath,
  samePath,
  toWorkspaceRelativePath,
} from '../schemas/paths.js';
import {
  WORKSPACE_SCHEMA,
  validateWorkspaceConfigSemantics,
  workspaceConfigSchema,
  type WorkspaceConfig,
  type WorkspaceValidation,
} from '../schemas/workspace.js';
import { getPackageInfo, getPackageRoot } from '../package-info.js';
import { spawnSync } from 'node:child_process';
import { executableOnPath } from '../hosts/detect.js';
import { HOST_SUPPORT } from '../hosts/integration/support.js';
import { observePath, resolveRealpath, sha256Digest } from '../infra/fs.js';
import {
  inspectGitRepository,
  type GitRepositoryObservation,
} from '../infra/git.js';
import type {
  MachineConfigInspection,
  WorkspaceConfigInspection,
} from '../workspace/config.js';
import {
  inspectMachineConfig,
  inspectWorkspaceConfig,
} from '../workspace/config.js';
import {
  discoverWorkspace,
  type WorkspaceDiscovery,
} from '../workspace/discover.js';
import { isExcludedPath } from '../workspace/ignore.js';
import { resolveWorkspaceRoot } from '../workspace/resolve.js';
import type {
  DiscoveredRepository,
  ValidationCandidate,
} from '../workspace/types.js';
import { buildInitPlan, type PlannedFileContent } from '../install/plan.js';
import {
  backupPath,
  ensureStatePathBoundary,
  writeBytesAtomic,
  writeWorkspaceManifest,
} from '../install/ownership.js';
import type { WorkspaceInstallManifest } from '../schemas/install.js';
import {
  beginManagedApply,
  completeManagedApply,
  failManagedApply,
  inspectWorkspaceInstallReadiness,
  recordManagedFile,
  type ManagedApplyContext,
  updateMachineRuntime,
  verifyWorkspaceInstallReady,
} from '../install/apply.js';
import {
  installRuntime,
  type RuntimeInstallResult,
} from '../install/runtime.js';

const workspaceConfigRelativePath = '.pappra/workspace.json';
const machineConfigRelativePath = '.pappra/local/machine.json';

export type InitFailureStatus =
  'needs_input' | 'invalid' | 'conflict' | 'unavailable';

export interface InitFailure {
  readonly ok: false;
  readonly status: InitFailureStatus;
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly nextAction: string | null;
  /** Machine-readable payload for callers that cannot prompt. */
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface InitRootResolution {
  readonly requestedRoot: string;
  readonly root: string;
  readonly registered: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

export type InitRootResult =
  { readonly ok: true; readonly value: InitRootResolution } | InitFailure;

export interface InitContext {
  readonly requestedRoot: string;
  readonly root: string;
  readonly registered: boolean;
  /** Directory identity captured before inspection and discovery. */
  readonly rootIdentity: RootIdentity;
  readonly workspaceInspection: WorkspaceConfigInspection;
  readonly machineInspection: MachineConfigInspection;
  readonly discovery: WorkspaceDiscovery;
  readonly diagnostics: readonly Diagnostic[];
}

export type InitContextResult =
  { readonly ok: true; readonly context: InitContext } | InitFailure;

export interface InitScopeRepository {
  readonly id: string;
  readonly path: string;
  readonly access: 'read' | 'write';
  readonly external: boolean;
  readonly root: string | null;
  readonly kind: string | null;
  readonly dirty: boolean | null;
  readonly declaredBy: 'existing' | 'planned';
}

export interface InitScope {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly runtimeVersion: string;
  readonly configSource: 'existing' | 'planned';
  readonly repositories: readonly InitScopeRepository[];
  readonly knowledge: WorkspaceConfig['knowledge'];
  readonly code: WorkspaceConfig['code'];
  readonly validation: readonly WorkspaceValidation[];
  readonly excludes: readonly string[];
  readonly hosts: readonly MachineConfig['selectedHosts'][number][];
  readonly boundaries: readonly string[];
}

export interface RootIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface InitPlanBundle {
  readonly plan: InitPlan;
  readonly scope: InitScope;
  readonly writes: readonly PlannedFileContent[];
  readonly diagnostics: readonly Diagnostic[];
  /** Filesystem identity of the planned workspace root; not persisted in plan JSON. */
  readonly rootIdentity: RootIdentity;
}

export type InitPreparation =
  { readonly ok: true; readonly bundle: InitPlanBundle } | InitFailure;

export type InitApplyStatus =
  | 'applied'
  | 'external-actions-pending'
  | 'no-changes'
  | 'stale'
  | 'conflict'
  | 'unsupported'
  | 'failed';

export interface InitApplyResult {
  readonly ok: boolean;
  readonly status: InitApplyStatus;
  readonly appliedFiles: readonly string[];
  readonly pendingExternalActions: readonly InitExternalAction[];
  /** Planned files that could not be safely removed after a failed apply. */
  readonly residualPaths: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface InitApplyOptions {
  /** Fault-injection seam for tests; the CLI never supplies this hook. */
  readonly beforeWrite?: (
    relativePath: string,
    index: number,
  ) => Promise<void> | void;
  /** Test seam after durable create, before its identity is journaled; never supplied by CLI. */
  readonly afterWrite?: (
    relativePath: string,
    index: number,
  ) => Promise<void> | void;
}

export interface KnowledgeCandidate {
  readonly path: string;
  readonly kind: string;
  readonly origin: string | null;
  readonly repositoryId: string | null;
}

export interface RepositoryCandidate {
  readonly key: string;
  readonly id: string | null;
  readonly external: boolean;
  readonly access: 'read' | 'write';
  readonly root: string;
  readonly kind: string;
  readonly dirty: boolean | null;
  readonly configured: boolean;
}

export type InitPathAdditionKind = 'repository' | 'knowledge';

/** Read-only snapshot of one exact, explicitly entered workspace-relative path. */
export interface InitPathObservation {
  readonly kind: InitPathAdditionKind;
  readonly requestedPath: string;
  /** Canonical workspace-relative path suitable for an existing InitChoices field. */
  readonly path: string;
  readonly realPath: string;
  readonly targetKind: 'file' | 'directory';
  readonly device: number;
  readonly inode: number;
  /** Actual bounded Git metadata observation for repository additions. */
  readonly git: GitRepositoryObservation | null;
}

export type InitPathInspectionResult =
  | { readonly ok: true; readonly observation: InitPathObservation }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export interface PlanInitOptions {
  readonly root: string;
  readonly choices?: InitChoices | null;
  readonly runtimeVersion?: string;
  /** Rebuilds workspace.json from selections even when a valid config exists. */
  readonly reconfigure?: boolean;
  readonly planId?: string;
  readonly discoveredAt?: string;
  /** Reuse an immediately preceding inspectInitContext result. */
  readonly context?: InitContext;
  /** In-memory UI observations; planning re-inspects each path before use. */
  readonly pathObservations?: readonly InitPathObservation[];
}

function failure(
  status: InitFailureStatus,
  code: DiagnosticCode,
  message: string,
  diagnostics: readonly Diagnostic[] = [],
  nextAction: string | null = null,
): InitFailure {
  return { ok: false, status, code, message, diagnostics, nextAction };
}

function failureFromDiagnostics(
  status: InitFailureStatus,
  diagnostics: readonly Diagnostic[],
  fallbackCode: DiagnosticCode,
  message: string,
): InitFailure {
  const first =
    diagnostics.find((entry) => entry.severity === 'error') ?? diagnostics[0];
  return failure(
    status,
    first?.code ?? fallbackCode,
    first?.message ?? message,
    diagnostics,
    first?.hint ?? null,
  );
}

function info(
  code: DiagnosticCode,
  message: string,
  source: string,
  hint: string | null = null,
): Diagnostic {
  return createDiagnostic({
    code,
    severity: 'info',
    message,
    source,
    hint,
  });
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function dedupeDiagnostics(
  diagnostics: readonly Diagnostic[],
): readonly Diagnostic[] {
  const seen = new Set<string>();
  const unique: Diagnostic[] = [];
  for (const entry of diagnostics) {
    const key = [
      entry.code,
      entry.severity,
      entry.source,
      entry.pointer ?? '',
      entry.message,
    ].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique;
}

function sanitizeIdentifier(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[-.]+$/g, '')
    .slice(0, 50);
  return normalized === '' ? 'repo' : normalized;
}

function uniqueIdentifier(base: string, used: Set<string>): string {
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

type RepositorySelectionSource = Pick<
  DiscoveredRepository,
  | 'id'
  | 'external'
  | 'access'
  | 'root'
  | 'relativePath'
  | 'configuredPath'
  | 'git'
  | 'kind'
  | 'diagnostics'
>;

function repositoryKey(repository: RepositorySelectionSource): string {
  if (repository.configuredPath !== null) {
    return isExternalRepositoryPath(repository.configuredPath)
      ? repository.configuredPath
      : normalizePortableRelativePath(repository.configuredPath);
  }
  return repository.relativePath === null
    ? repository.root
    : normalizePortableRelativePath(repository.relativePath);
}

function candidateKey(value: string): string {
  return isExternalRepositoryPath(value)
    ? value
    : normalizePortableRelativePath(value);
}

/** Resolves the explicit root and refuses to create a hidden nested workspace. */
export async function resolveInitRoot(
  rootPath: string,
): Promise<InitRootResult> {
  const requestedRoot = resolve(rootPath);
  const resolution = await resolveWorkspaceRoot({ startPath: requestedRoot });
  if (resolution.state === 'incomplete' && resolution.root !== null) {
    const canonicalRequested = await resolveRealpath(requestedRoot);
    const marker = join(resolution.root, '.pappra');
    const local = join(marker, 'local');
    const markerObservation = await observePath(marker);
    const localObservation = await observePath(local);
    const configObservation = await observePath(join(marker, 'workspace.json'));
    if (
      canonicalRequested !== null &&
      samePath(canonicalRequested, resolution.root) &&
      markerObservation.kind === 'directory' &&
      configObservation.kind === 'missing' &&
      ['missing', 'directory'].includes(localObservation.kind) &&
      (await readdir(marker)).every((name) => name === 'local')
    ) {
      const ready = await inspectWorkspaceInstallReadiness(resolution.root);
      if (!ready.ok)
        return failure(
          'unavailable',
          ready.code,
          ready.message,
          [],
          ready.nextAction,
        );
      return {
        ok: true,
        value: {
          requestedRoot,
          root: resolution.root,
          registered: false,
          diagnostics: resolution.diagnostics.filter(
            (entry) =>
              entry.code !== diagnosticCodes.workspaceRegistrationIncomplete,
          ),
        },
      };
    }
  }
  if (resolution.state === 'unavailable' || resolution.state === 'incomplete') {
    return failureFromDiagnostics(
      'unavailable',
      resolution.diagnostics,
      diagnosticCodes.workspaceStartInvalid,
      `Cannot initialize from ${requestedRoot}.`,
    );
  }
  if (resolution.root !== null) {
    const diagnostics = [...resolution.diagnostics];
    if (!samePath(resolution.root, requestedRoot)) {
      diagnostics.push(
        info(
          diagnosticCodes.initRegisteredRootUsed,
          `Using the nearest registered workspace root: ${resolution.root}`,
          resolution.root,
          'Run init from the workspace root or select a different directory; Pappra does not create a nested workspace implicitly.',
        ),
      );
    }
    return {
      ok: true,
      value: {
        requestedRoot,
        root: resolution.root,
        registered: true,
        diagnostics,
      },
    };
  }
  if (resolution.startDirectory === null) {
    return failure(
      'unavailable',
      diagnosticCodes.workspaceStartInvalid,
      `Cannot resolve initialization root ${requestedRoot}.`,
      resolution.diagnostics,
      'Pass an existing readable directory.',
    );
  }
  return {
    ok: true,
    value: {
      requestedRoot,
      root: resolution.startDirectory,
      registered: false,
      diagnostics: resolution.diagnostics,
    },
  };
}

async function observeRootIdentity(root: string): Promise<RootIdentity | null> {
  const observation = await observePath(root);
  return observation.kind === 'directory' && observation.stats !== null
    ? { dev: observation.stats.dev, ino: observation.stats.ino }
    : null;
}

function sameRootIdentity(left: RootIdentity, right: RootIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Loads the discovery inputs and rejects changed or invalid existing state.
 * This function is read-only.
 */
export async function inspectInitContext(
  rootPath: string,
): Promise<InitContextResult> {
  const rootResult = await resolveInitRoot(rootPath);
  if (!rootResult.ok) return rootResult;
  const root = rootResult.value.root;
  const installReady = await inspectWorkspaceInstallReadiness(root);
  if (!installReady.ok)
    return failure(
      'unavailable',
      installReady.code,
      installReady.message,
      [],
      installReady.nextAction,
    );
  const rootIdentity = await observeRootIdentity(root);
  if (rootIdentity === null) {
    return failure(
      'unavailable',
      diagnosticCodes.workspaceRootInvalid,
      `Workspace root is no longer a directory: ${root}`,
      rootResult.value.diagnostics,
      'Retry init from an existing workspace root; no plan was produced.',
    );
  }
  const workspaceInspection = await inspectWorkspaceConfig(root, {
    missing: 'info',
  });
  const machineInspection = await inspectMachineConfig(root);
  const initialDiagnostics = [
    ...workspaceInspection.diagnostics,
    ...machineInspection.diagnostics,
  ];
  if (workspaceInspection.exists && workspaceInspection.value === null) {
    return failureFromDiagnostics(
      'invalid',
      initialDiagnostics,
      diagnosticCodes.configSchemaInvalid,
      'Existing workspace configuration is invalid.',
    );
  }
  if (machineInspection.exists && machineInspection.value === null) {
    return failureFromDiagnostics(
      'invalid',
      initialDiagnostics,
      diagnosticCodes.configSchemaInvalid,
      'Existing machine configuration is invalid.',
    );
  }

  const discovery = await discoverWorkspace(root);
  const finalWorkspace = await inspectWorkspaceConfig(root, {
    missing: 'info',
  });
  const finalMachine = await inspectMachineConfig(root);
  const finalRootIdentity = await observeRootIdentity(root);
  const changedDuringDiscovery =
    workspaceInspection.digest !== finalWorkspace.digest ||
    workspaceInspection.exists !== finalWorkspace.exists ||
    machineInspection.digest !== finalMachine.digest ||
    machineInspection.exists !== finalMachine.exists;
  const finalDiagnostics = [...initialDiagnostics, ...discovery.diagnostics];
  if (
    finalRootIdentity === null ||
    !sameRootIdentity(rootIdentity, finalRootIdentity)
  ) {
    return failure(
      'conflict',
      diagnosticCodes.initPlanStale,
      'Workspace root directory was replaced while discovery was running.',
      finalDiagnostics,
      'Retry init from the current workspace root; no plan was produced.',
    );
  }
  if (changedDuringDiscovery) {
    return failure(
      'conflict',
      diagnosticCodes.initPlanStale,
      'Workspace inputs changed while discovery was running.',
      finalDiagnostics,
      'Retry init; no plan was produced.',
    );
  }
  if (
    (workspaceInspection.value === null && discovery.configState === 'valid') ||
    (workspaceInspection.value !== null && discovery.configState !== 'valid') ||
    (machineInspection.value === null && discovery.machineState === 'valid') ||
    (machineInspection.value !== null && discovery.machineState !== 'valid')
  ) {
    return failure(
      'conflict',
      diagnosticCodes.initPlanStale,
      'Workspace configuration changed while discovery was running.',
      finalDiagnostics,
      'Retry init; no plan was produced.',
    );
  }

  return {
    ok: true,
    context: {
      requestedRoot: rootResult.value.requestedRoot,
      root,
      registered: rootResult.value.registered,
      rootIdentity,
      workspaceInspection,
      machineInspection,
      discovery,
      diagnostics: dedupeDiagnostics([
        ...rootResult.value.diagnostics,
        ...finalDiagnostics,
      ]),
    },
  };
}

/** Lists discovered repository scope choices for a UI. */
export function listRepositoryCandidates(
  discovery: WorkspaceDiscovery,
): readonly RepositoryCandidate[] {
  return discovery.repositories.map((repository) => ({
    key: repositoryKey(repository),
    id: repository.id,
    external: repository.external,
    access: repository.access,
    root: repository.root,
    kind: repository.kind,
    dirty: repository.git.dirty,
    configured: repository.origin === 'workspace-config',
  }));
}

/** Lists knowledge source choices derived only from current discovery. */
export function listKnowledgeCandidates(
  discovery: WorkspaceDiscovery,
): readonly KnowledgeCandidate[] {
  const candidates = new Map<string, KnowledgeCandidate>();
  for (const document of discovery.documents) {
    if (document.workspaceRelativePath === null) continue;
    candidates.set(document.workspaceRelativePath, {
      path: document.workspaceRelativePath,
      kind: document.kind,
      origin: document.origin,
      repositoryId: document.repositoryId,
    });
    const segments = document.workspaceRelativePath.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const path = segments.slice(0, index).join('/');
      if (path.startsWith('.')) continue;
      candidates.set(path, {
        path,
        kind: 'directory',
        origin: document.origin,
        repositoryId: document.repositoryId,
      });
    }
  }
  return [...candidates.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

export interface InitChoiceRule {
  readonly field: string;
  readonly value: string;
  readonly reason: string;
}

export interface InitChoiceCandidates {
  readonly repositories: readonly string[];
  readonly knowledge: readonly string[];
  readonly validation: readonly string[];
  readonly hosts: readonly string[];
}

export interface DerivedInitChoices {
  readonly choices: InitChoices;
  readonly rules: readonly InitChoiceRule[];
  readonly candidates: InitChoiceCandidates;
}

const derivedExcludes = [
  'node_modules',
  'dist',
  'coverage',
  'tmp',
  'test-results',
] as const;
const derivedValidationScripts = ['lint', 'typecheck', 'test'] as const;

export interface CommonInitDefaults {
  readonly name: string;
  readonly knowledge: InitChoices['knowledge'];
  readonly code: Pick<InitChoices['code'], 'symbols' | 'prepare'>;
  readonly excludes: readonly string[];
}

/**
 * Pure discovery-based selections shared by derived and interactive setup.
 * Mode-specific repositories, validation, graph and host choices stay with
 * their callers.
 */
export function deriveCommonInitDefaults(
  discovery: WorkspaceDiscovery,
): CommonInitDefaults {
  const knowledgeCandidates = listKnowledgeCandidates(discovery);
  const knowledgeSources: string[] = [];
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const candidate = knowledgeCandidates.find(
      (entry) => entry.path.toLowerCase() === name.toLowerCase(),
    );
    if (candidate !== undefined) knowledgeSources.push(candidate.path);
  }
  const docs = knowledgeCandidates.find((entry) => entry.path === 'docs');
  if (docs !== undefined) knowledgeSources.push(docs.path);
  return {
    name: basename(discovery.root),
    knowledge: {
      sources: knowledgeSources,
      newDocuments: '.pappra/knowledge',
      taskVisibility: 'private',
    },
    code: { symbols: 'auto', prepare: 'on-demand' },
    excludes: [...derivedExcludes],
  };
}

/**
 * Converts an existing valid workspace/machine pair into a lossless editable
 * selection draft. Extensions and continuity are intentionally not part of
 * InitChoices; plan reconstruction preserves them from the existing config.
 */
export function existingInitChoices(
  config: WorkspaceConfig,
  machine: MachineConfig | null,
): InitChoices {
  return {
    schema: INIT_CHOICES_SCHEMA,
    name: config.name,
    workspaceId: config.workspaceId,
    repositories: config.repositories.map((repository) => ({
      path: repository.path,
      id: repository.id,
      access: repository.access,
    })),
    knowledge: {
      sources: [...config.knowledge.sources],
      newDocuments: config.knowledge.newDocuments,
      taskVisibility: config.knowledge.taskVisibility,
    },
    code: { ...config.code },
    validation: config.validation.map(
      (validation) => `workspace-config:${validation.id}`,
    ),
    excludes: [...config.excludes],
    hosts: [...(machine?.selectedHosts ?? [])] as InitChoices['hosts'],
  };
}

export type InitEditableField =
  'name' | 'newDocuments' | 'excludes' | 'repositoryPath' | 'knowledgePath';

function portableFieldError(label: string, value: string): string | null {
  if (value.includes('\0') || value.includes('\\')) {
    return `${label} must use forward slashes and must not contain NUL or backslashes.`;
  }
  if (
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value) ||
    value.startsWith('\\\\')
  ) {
    return `${label} must be relative to the workspace root, not absolute.`;
  }
  if (!isPortableRelativePath(value)) {
    return `${label} must be a workspace-relative path that does not escape the root.`;
  }
  return null;
}

/**
 * Immediate UI field feedback using the same name schema, portable-path rules,
 * literal-prefix exclusion policy and workspace-relative semantics as planning.
 */
export function validateInitField(
  field: InitEditableField,
  value: string,
): string | null {
  if (field === 'name') {
    const parsed = workspaceConfigSchema.shape.name.safeParse(value.trim());
    return parsed.success
      ? null
      : (parsed.error.issues[0]?.message ?? 'Use a non-empty workspace name.');
  }
  if (field === 'newDocuments') {
    const parsed =
      workspaceConfigSchema.shape.knowledge.shape.newDocuments.safeParse(value);
    if (!parsed.success) {
      return (
        parsed.error.issues[0]?.message ??
        'Use a workspace-relative new document destination.'
      );
    }
    return portableFieldError('New document destination', value);
  }
  if (field === 'repositoryPath') {
    return portableFieldError('Repository path', value);
  }
  if (field === 'knowledgePath') {
    return portableFieldError('Knowledge source path', value);
  }
  for (const entry of value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter((item) => item !== '')) {
    const pathError = portableFieldError('Exclude entry', entry);
    if (pathError !== null) return pathError;
    if (/[*?[\]{}]/.test(entry)) {
      return `Exclude entry "${entry}" contains glob metacharacters; use literal workspace-relative prefixes.`;
    }
  }
  return null;
}

async function nestedWorkspaceBoundaryForPath(
  root: string,
  path: string,
  kind: 'file' | 'directory',
): Promise<string | null> {
  let current = kind === 'directory' ? path : dirname(path);
  while (!samePath(current, root)) {
    if (!isPathInside(root, current)) return null;
    const marker = await observePath(join(current, '.pappra'));
    if (marker.kind !== 'missing') return current;
    const parent = dirname(current);
    if (samePath(parent, current) || !isPathInside(root, parent)) return null;
    current = parent;
  }
  return null;
}

function explicitPathDiagnostic(
  code: DiagnosticCode,
  message: string,
  location: string | null,
  hint: string,
): Diagnostic {
  return createDiagnostic({
    code,
    severity: 'error',
    message,
    source: 'init explicit path inspection',
    pointer: location,
    hint,
  });
}

/** Inspects one user-entered path only; it never broadens workspace discovery. */
export async function inspectInitPathAddition(
  root: string,
  kind: InitPathAdditionKind,
  inputPath: string,
  excludes: readonly string[] = [],
  location: string | null = null,
): Promise<InitPathInspectionResult> {
  const label =
    kind === 'repository' ? 'Repository path' : 'Knowledge source path';
  const pathError = portableFieldError(label, inputPath);
  if (pathError !== null) {
    return {
      ok: false,
      diagnostics: [
        explicitPathDiagnostic(
          diagnosticCodes.initInvalidInput,
          pathError,
          location,
          'Enter an existing workspace-relative path using forward slashes; absolute and escaping paths are not accepted.',
        ),
      ],
    };
  }
  if (inputPath === '~' || inputPath.startsWith('~/')) {
    return {
      ok: false,
      diagnostics: [
        explicitPathDiagnostic(
          diagnosticCodes.initInvalidInput,
          `${label} must not use a home-relative path: ${inputPath}`,
          location,
          'Enter a path relative to the resolved workspace root.',
        ),
      ],
    };
  }
  if (kind === 'repository' && isExternalRepositoryPath(inputPath)) {
    return {
      ok: false,
      diagnostics: [
        explicitPathDiagnostic(
          diagnosticCodes.initInvalidInput,
          'Explicit repository addition does not create external repository mappings.',
          location,
          'Add an existing checkout located inside the workspace root.',
        ),
      ],
    };
  }

  const requestedPath = normalizePortableRelativePath(inputPath);
  const candidatePath = resolvePortableRelativePath(root, requestedPath);
  if (!isPathInside(root, candidatePath)) {
    return {
      ok: false,
      diagnostics: [
        explicitPathDiagnostic(
          diagnosticCodes.initInvalidInput,
          `${label} escapes the workspace root: ${inputPath}`,
          location,
          'Keep the path within the resolved workspace root.',
        ),
      ],
    };
  }

  try {
    const initial = await observePath(candidatePath);
    if (initial.kind === 'missing') {
      return {
        ok: false,
        diagnostics: [
          explicitPathDiagnostic(
            kind === 'repository'
              ? diagnosticCodes.repositoryPathMissing
              : diagnosticCodes.knowledgeSourceMissing,
            `${label} does not exist: ${candidatePath}`,
            location,
            'Correct the path or cancel the addition; init does not create the location.',
          ),
        ],
      };
    }
    const realPath = await resolveRealpath(candidatePath);
    if (realPath === null) {
      return {
        ok: false,
        diagnostics: [
          explicitPathDiagnostic(
            kind === 'repository'
              ? diagnosticCodes.repositoryPathMissing
              : diagnosticCodes.knowledgeSourceNotReadable,
            `Cannot resolve ${label.toLowerCase()}: ${candidatePath}`,
            location,
            'Check the entered path and permissions.',
          ),
        ],
      };
    }
    if (!isPathInside(root, realPath)) {
      return {
        ok: false,
        diagnostics: [
          explicitPathDiagnostic(
            kind === 'repository'
              ? diagnosticCodes.repositorySymlinkEscape
              : diagnosticCodes.knowledgeSourceSymlinkEscape,
            `${label} resolves outside the workspace root: ${candidatePath} -> ${realPath}`,
            location,
            'Keep the resolved target inside the workspace; explicit additions do not create external mappings.',
          ),
        ],
      };
    }
    const target = await observePath(realPath);
    if (target.kind !== 'file' && target.kind !== 'directory') {
      return {
        ok: false,
        diagnostics: [
          explicitPathDiagnostic(
            kind === 'repository'
              ? diagnosticCodes.repositoryNotGit
              : diagnosticCodes.knowledgeSourceNotReadable,
            `${label} is not an existing regular file or directory: ${realPath}`,
            location,
            'Special files, FIFOs and unreadable locations are not accepted.',
          ),
        ],
      };
    }
    if (kind === 'repository' && target.kind !== 'directory') {
      return {
        ok: false,
        diagnostics: [
          explicitPathDiagnostic(
            diagnosticCodes.repositoryNotGit,
            `Repository path is not a checkout directory: ${realPath}`,
            location,
            'Enter the exact existing Git checkout root, not a file or a subdirectory.',
          ),
        ],
      };
    }
    const nested = await nestedWorkspaceBoundaryForPath(
      root,
      realPath,
      target.kind,
    );
    if (nested !== null) {
      return {
        ok: false,
        diagnostics: [
          explicitPathDiagnostic(
            kind === 'repository'
              ? diagnosticCodes.repositoryNestedWorkspace
              : diagnosticCodes.discoveryNestedWorkspace,
            `${label} is inside nested workspace ${nested}.`,
            location,
            'Configure the nested workspace separately; outer init does not absorb its paths.',
          ),
        ],
      };
    }
    const canonicalPath = toWorkspaceRelativePath(root, realPath);
    if (canonicalPath === null) {
      return {
        ok: false,
        diagnostics: [
          explicitPathDiagnostic(
            kind === 'repository'
              ? diagnosticCodes.repositorySymlinkEscape
              : diagnosticCodes.knowledgeSourceSymlinkEscape,
            `${label} has no safe workspace-relative identity: ${realPath}`,
            location,
            'Keep the resolved target inside the workspace root.',
          ),
        ],
      };
    }
    if (isExcludedPath(canonicalPath, excludes)) {
      const label = kind === 'repository' ? 'Repository' : 'Knowledge source';
      return {
        ok: false,
        diagnostics: [
          explicitPathDiagnostic(
            kind === 'repository'
              ? diagnosticCodes.initRepositoryUnknown
              : diagnosticCodes.initKnowledgeUnknown,
            `${label} is excluded by workspace policy: ${canonicalPath}`,
            location,
            'Remove or change the exclude before adding this path.',
          ),
        ],
      };
    }

    let git: GitRepositoryObservation | null = null;
    if (kind === 'repository') {
      const inspected = await inspectGitRepository(realPath);
      if (!inspected.ok) {
        return {
          ok: false,
          diagnostics: [
            createDiagnostic({
              code: inspected.code,
              severity: 'error',
              message: inspected.message,
              source: 'init explicit repository path',
              pointer: location,
              hint:
                inspected.nextAction ??
                'Check the exact repository path and Git metadata.',
            }),
          ],
        };
      }
      if (!samePath(inspected.value.root, realPath)) {
        return {
          ok: false,
          diagnostics: [
            explicitPathDiagnostic(
              diagnosticCodes.repositoryNotGit,
              `Entered location is not the exact repository root: ${realPath}; Git resolved ${inspected.value.root}.`,
              location,
              'Enter the checkout root itself; init does not substitute a parent repository.',
            ),
          ],
        };
      }
      if (!isPathInside(root, inspected.value.root)) {
        return {
          ok: false,
          diagnostics: [
            explicitPathDiagnostic(
              diagnosticCodes.repositorySymlinkEscape,
              `Repository resolves outside the workspace root: ${inspected.value.root}`,
              location,
              'Use a workspace-local checkout; external mapping creation is not part of init path addition.',
            ),
          ],
        };
      }
      git = inspected.value;
    }

    if (target.stats === null) {
      return {
        ok: false,
        diagnostics: [
          explicitPathDiagnostic(
            diagnosticCodes.fileUnreadable,
            `Cannot snapshot ${label.toLowerCase()}: ${realPath}`,
            location,
            'Check the path and permissions, then try the explicit addition again.',
          ),
        ],
      };
    }
    return {
      ok: true,
      observation: {
        kind,
        requestedPath,
        path: canonicalPath,
        realPath,
        targetKind: target.kind,
        device: target.stats.dev,
        inode: target.stats.ino,
        git,
      },
    };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        explicitPathDiagnostic(
          diagnosticCodes.fileUnreadable,
          `Cannot inspect ${label.toLowerCase()} ${candidatePath}: ${error instanceof Error ? error.message : String(error)}`,
          location,
          'Check permissions and the path; init does not open document bodies during path addition.',
        ),
      ],
    };
  }
}

export function detectedHostVersion(
  command: string,
  pathEnv: string,
): string | null {
  const executable = executableOnPath(command, pathEnv);
  if (executable === null) return null;
  const probe = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    shell: false,
    timeout: 3_000,
    maxBuffer: 256 * 1024,
  });
  if (probe.error !== undefined || probe.status !== 0) return null;
  const output = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`;
  const match = /(\d+\.\d+\.\d+)/.exec(output);
  return match?.[1] ?? null;
}

/**
 * Derives deterministic init selections from discovery alone. Every value is
 * reported with the rule that produced it so a caller can audit the choice
 * before applying it; nothing here writes, installs or prompts.
 */
export async function deriveInitChoices(
  discovery: WorkspaceDiscovery,
  options: {
    readonly pathEnv?: string;
  } = {},
): Promise<DerivedInitChoices> {
  const pathEnv = options.pathEnv ?? process.env['PATH'] ?? '';
  const rules: InitChoiceRule[] = [];

  const repositories = discovery.repositories.map((repository) => {
    const path = repositoryKey(repository);
    const access = samePath(repository.root, discovery.root)
      ? ('write' as const)
      : ('read' as const);
    rules.push({
      field: 'repositories',
      value: path,
      reason:
        access === 'write'
          ? 'workspace-root checkout is selected for write access'
          : 'discovered checkout outside the workspace root is read-only',
    });
    return { path, access };
  });

  const common = deriveCommonInitDefaults(discovery);
  const knowledgeCandidates = listKnowledgeCandidates(discovery);
  for (const source of common.knowledge.sources) {
    rules.push({
      field: 'knowledge.sources',
      value: source,
      reason:
        source === 'docs'
          ? 'documentation directory reported by discovery'
          : 'workspace-root rule file reported by discovery',
    });
  }

  const codegraphDetected =
    executableOnPath('codegraph', pathEnv) !== null &&
    (
      await Promise.all(
        discovery.repositories.map(async (repository) =>
          observePath(join(repository.root, '.codegraph')),
        ),
      )
    ).some((observation) => observation.kind !== 'missing');
  const graph = codegraphDetected ? ('codegraph' as const) : ('none' as const);
  rules.push({
    field: 'code.graph',
    value: graph,
    reason: codegraphDetected
      ? 'codegraph executable and .codegraph index were both observed'
      : 'no codegraph executable plus .codegraph index pair was observed',
  });
  rules.push({
    field: 'code.symbols',
    value: common.code.symbols,
    reason: 'symbol providers are detected passively at use time',
  });
  rules.push({
    field: 'code.prepare',
    value: common.code.prepare,
    reason: 'index preparation stays an explicit, bounded action',
  });

  const validation: string[] = [];
  for (const script of derivedValidationScripts) {
    const candidate = discovery.validationCandidates.find(
      (entry) =>
        entry.id.endsWith(`:${script}`) && !validation.includes(entry.id),
    );
    if (candidate === undefined) continue;
    validation.push(candidate.id);
    rules.push({
      field: 'validation',
      value: candidate.id,
      reason: `package script "${script}" reported by discovery`,
    });
  }

  rules.push({
    field: 'excludes',
    value: common.excludes.join(', '),
    reason:
      'built-in defaults keep generated and dependency trees out of scope',
  });

  const hosts: InitChoices['hosts'] = [];
  for (const host of ['claude', 'codex', 'pi'] as const) {
    const command = host;
    const version = detectedHostVersion(command, pathEnv);
    if (version === null || version !== HOST_SUPPORT[host].version) {
      rules.push({
        field: 'hosts',
        value: host,
        reason:
          version === null
            ? 'host executable was not observed on PATH'
            : `observed version ${version} is outside the pinned support matrix`,
      });
      continue;
    }
    hosts.push(host);
    rules.push({
      field: 'hosts',
      value: host,
      reason: `host executable reports the pinned version ${version}`,
    });
  }

  const name = common.name;
  rules.push({
    field: 'name',
    value: name,
    reason: 'workspace name derived from the workspace root directory',
  });

  const choices: InitChoices = {
    schema: INIT_CHOICES_SCHEMA,
    name,
    repositories,
    knowledge: common.knowledge,
    code: {
      graph,
      symbols: common.code.symbols,
      prepare: common.code.prepare,
    },
    validation,
    excludes: [...common.excludes],
    hosts,
  };

  return {
    choices,
    rules,
    candidates: {
      repositories: listRepositoryCandidates(discovery).map(
        (candidate) => candidate.key,
      ),
      knowledge: knowledgeCandidates.map((candidate) => candidate.path),
      validation: discovery.validationCandidates.map(
        (candidate) => candidate.id,
      ),
      hosts,
    },
  };
}

interface SelectedRepository {
  readonly repository: RepositorySelectionSource;
  readonly id: string;
  readonly path: string;
  readonly access: 'read' | 'write';
  readonly originalId: string | null;
}

function selectRepositories(
  choices: InitChoices,
  discovery: WorkspaceDiscovery,
  root: string,
  additionalRepositories: ReadonlyMap<
    string,
    RepositorySelectionSource
  > = new Map(),
  reservedRepositoryIds: readonly string[] = [],
): {
  readonly selected: readonly SelectedRepository[];
  readonly diagnostics: readonly Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const byKey = new Map<string, RepositorySelectionSource>();
  for (const repository of discovery.repositories) {
    byKey.set(repositoryKey(repository), repository);
    if (repository.relativePath !== null) {
      byKey.set(
        normalizePortableRelativePath(repository.relativePath),
        repository,
      );
    }
  }
  for (const [key, repository] of additionalRepositories) {
    if (!byKey.has(key)) byKey.set(key, repository);
  }
  const reservedIds = new Set([
    ...reservedRepositoryIds,
    ...choices.repositories.flatMap((choice) =>
      choice.id === undefined ? [] : [choice.id],
    ),
  ]);
  const usedIds = new Set<string>();
  const selected: SelectedRepository[] = [];
  const seenRepositories = new Set<string>();
  for (const [index, choice] of choices.repositories.entries()) {
    const key = candidateKey(choice.path);
    const repository = byKey.get(key);
    if (repository === undefined) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.initRepositoryUnknown,
          severity: 'error',
          message: `Init selection references an undiscovered or uninspected repository: ${choice.path}`,
          source: 'init choices',
          pointer: pointer('repositories', index, 'path'),
          hint: 'Select a discovered checkout or add an existing workspace-relative checkout through the bounded path action.',
        }),
      );
      continue;
    }
    if (seenRepositories.has(repository.root)) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.initRepositoryDuplicate,
          severity: 'error',
          message: `Repository selection repeats ${repository.root}.`,
          source: 'init choices',
          pointer: pointer('repositories', index, 'path'),
          hint: 'Keep one selection per canonical checkout.',
        }),
      );
      continue;
    }
    seenRepositories.add(repository.root);
    const external = repository.external;
    const derivedBase =
      repository.id ??
      (repository.relativePath === null || repository.relativePath === '.'
        ? basename(root)
        : basename(repository.relativePath));
    const id =
      choice.id ??
      uniqueIdentifier(
        sanitizeIdentifier(derivedBase),
        new Set([...reservedIds, ...usedIds]),
      );
    if (choice.id !== undefined) {
      if (usedIds.has(choice.id)) {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.initRepositoryDuplicate,
            severity: 'error',
            message: `Repository id "${choice.id}" is selected more than once.`,
            source: 'init choices',
            pointer: pointer('repositories', index, 'id'),
            hint: 'Use unique repository ids.',
          }),
        );
        continue;
      }
    }
    usedIds.add(id);
    const configPath = external
      ? repository.configuredPath
      : (repository.relativePath ?? repository.configuredPath ?? '.');
    if (configPath === null) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.initRepositoryUnknown,
          severity: 'error',
          message: `Repository ${repository.root} has no portable configuration path.`,
          source: 'init choices',
          pointer: pointer('repositories', index, 'path'),
          hint: 'Declare the checkout explicitly before initialization.',
        }),
      );
      continue;
    }
    selected.push({
      repository,
      id,
      path: configPath,
      access: choice.access,
      originalId: repository.id,
    });
  }
  return { selected, diagnostics };
}

function selectKnowledgeSources(
  choices: InitChoices,
  discovery: WorkspaceDiscovery,
  retainedSources: readonly string[] = [],
  explicitSources: ReadonlyMap<string, string> = new Map(),
): {
  readonly sources: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
} {
  const allowed = new Map(
    listKnowledgeCandidates(discovery).map((candidate) => [
      candidateKey(candidate.path),
      candidate.path,
    ]),
  );
  for (const [key, path] of explicitSources) {
    if (!allowed.has(key)) allowed.set(key, path);
  }
  const retained = new Map(
    retainedSources.map((source) => [candidateKey(source), source]),
  );
  const diagnostics: Diagnostic[] = [];
  const sources: string[] = [];
  const seen = new Set<string>();
  for (const [index, source] of choices.knowledge.sources.entries()) {
    const key = candidateKey(source);
    const canonical = allowed.get(key);
    if (canonical === undefined) {
      const kept = retained.get(key);
      if (kept !== undefined) {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.initKnowledgeUnknown,
            severity: 'warning',
            message: `Configured knowledge source is retained but not currently discovered: ${kept}`,
            source: 'init choices',
            pointer: pointer('knowledge', 'sources', index),
            hint: 'Keep the source if it is intentionally unavailable, or remove it explicitly.',
          }),
        );
        if (!seen.has(kept)) {
          seen.add(kept);
          sources.push(kept);
        }
        continue;
      }
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.initKnowledgeUnknown,
          severity: 'error',
          message: `Init selection references an undiscovered knowledge source: ${source}`,
          source: 'init choices',
          pointer: pointer('knowledge', 'sources', index),
          hint: 'Select a rule or document reported by discovery; Pappra does not copy or create documentation.',
        }),
      );
      continue;
    }
    if (!seen.has(canonical)) {
      seen.add(canonical);
      sources.push(canonical);
    }
  }
  return { sources, diagnostics };
}

interface ExplicitInitPathSelections {
  readonly repositories: ReadonlyMap<string, RepositorySelectionSource>;
  readonly knowledgeSources: ReadonlyMap<string, string>;
  readonly observations: readonly InitPathObservation[];
}

type ExplicitInitPathInspectionResult =
  | { readonly ok: true; readonly value: ExplicitInitPathSelections }
  | {
      readonly ok: false;
      readonly status: 'invalid' | 'conflict';
      readonly diagnostics: readonly Diagnostic[];
    };

function pathObservationKey(kind: InitPathAdditionKind, path: string): string {
  return `${kind}:${candidateKey(path)}`;
}

function sameInitPathObservation(
  left: InitPathObservation,
  right: InitPathObservation,
): boolean {
  if (
    left.kind !== right.kind ||
    candidateKey(left.path) !== candidateKey(right.path) ||
    !samePath(left.realPath, right.realPath) ||
    left.targetKind !== right.targetKind ||
    left.device !== right.device ||
    left.inode !== right.inode
  ) {
    return false;
  }
  if (left.git === null || right.git === null) return left.git === right.git;
  return (
    samePath(left.git.root, right.git.root) &&
    samePath(left.git.gitDir, right.git.gitDir) &&
    samePath(left.git.commonDir, right.git.commonDir) &&
    left.git.kind === right.git.kind
  );
}

function repositorySelectionFromPathObservation(
  observation: InitPathObservation,
): RepositorySelectionSource {
  if (observation.kind !== 'repository' || observation.git === null) {
    throw new Error('Repository selection requires a Git path observation.');
  }
  return {
    id: null,
    external: false,
    access: 'read',
    root: observation.git.root,
    relativePath: observation.path,
    configuredPath: observation.path,
    git: observation.git,
    kind: observation.git.kind,
    diagnostics: [],
  };
}

async function inspectExplicitInitPathSelections(
  root: string,
  choices: InitChoices,
  discovery: WorkspaceDiscovery,
  preservedConfig: WorkspaceConfig | null,
  priorObservations: readonly InitPathObservation[],
): Promise<ExplicitInitPathInspectionResult> {
  const repositories = new Map<string, RepositorySelectionSource>();
  const knowledgeSources = new Map<string, string>();
  const observations: InitPathObservation[] = [];
  const diagnostics: Diagnostic[] = [];
  const priorByPath = new Map<string, InitPathObservation>();
  for (const observation of priorObservations) {
    const key = pathObservationKey(observation.kind, observation.path);
    if (!priorByPath.has(key)) priorByPath.set(key, observation);
  }
  const discoveredRepositories = new Map<string, RepositorySelectionSource>();
  for (const repository of discovery.repositories) {
    discoveredRepositories.set(repositoryKey(repository), repository);
    if (repository.relativePath !== null) {
      discoveredRepositories.set(
        candidateKey(repository.relativePath),
        repository,
      );
    }
  }
  const discoveredKnowledge = new Map(
    listKnowledgeCandidates(discovery).map((candidate) => [
      candidateKey(candidate.path),
      candidate.path,
    ]),
  );
  const retainedRepositoryPaths = new Set(
    (preservedConfig?.repositories ?? []).map((repository) =>
      candidateKey(repository.path),
    ),
  );
  const retainedKnowledgePaths = new Set(
    (preservedConfig?.knowledge.sources ?? []).map(candidateKey),
  );
  const inspectedChoices = new Set<string>();
  let failureStatus: 'invalid' | 'conflict' = 'invalid';

  const inspectChoice = async (
    kind: InitPathAdditionKind,
    inputPath: string,
    location: string,
  ): Promise<void> => {
    const inputKey = candidateKey(inputPath);
    const inspectionKey = pathObservationKey(kind, inputKey);
    if (inspectedChoices.has(inspectionKey)) return;
    inspectedChoices.add(inspectionKey);
    const inspected = await inspectInitPathAddition(
      root,
      kind,
      inputPath,
      choices.excludes,
      location,
    );
    if (!inspected.ok) {
      diagnostics.push(...inspected.diagnostics);
      return;
    }
    const observation = inspected.observation;
    const prior =
      priorByPath.get(pathObservationKey(kind, observation.path)) ??
      priorByPath.get(inspectionKey);
    if (prior !== undefined && !sameInitPathObservation(prior, observation)) {
      failureStatus = 'conflict';
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.initPlanStale,
          severity: 'error',
          message: `Explicit ${kind} path changed after it was inspected: ${observation.path}`,
          source: 'init explicit path inspection',
          pointer: location,
          hint: 'Review the changed location and re-enter it deliberately; init does not refresh path identity automatically.',
        }),
      );
      return;
    }
    observations.push(observation);
    if (kind === 'repository') {
      const discovered = [...discovery.repositories].find((entry) =>
        samePath(entry.root, observation.realPath),
      );
      const source =
        discovered ?? repositorySelectionFromPathObservation(observation);
      repositories.set(inputKey, source);
      repositories.set(candidateKey(observation.path), source);
    } else {
      const canonical =
        discoveredKnowledge.get(candidateKey(observation.path)) ??
        observation.path;
      knowledgeSources.set(inputKey, canonical);
      knowledgeSources.set(candidateKey(observation.path), canonical);
    }
  };

  for (const [index, choice] of choices.repositories.entries()) {
    const key = candidateKey(choice.path);
    const hasPriorObservation = priorByPath.has(
      pathObservationKey('repository', key),
    );
    if (
      !hasPriorObservation &&
      (retainedRepositoryPaths.has(key) ||
        (discoveredRepositories.has(key) &&
          !isExcludedPath(key, choices.excludes)))
    ) {
      continue;
    }
    await inspectChoice(
      'repository',
      choice.path,
      pointer('repositories', index, 'path'),
    );
  }
  for (const [index, source] of choices.knowledge.sources.entries()) {
    const key = candidateKey(source);
    const hasPriorObservation = priorByPath.has(
      pathObservationKey('knowledge', key),
    );
    if (
      !hasPriorObservation &&
      (retainedKnowledgePaths.has(key) ||
        (discoveredKnowledge.has(key) &&
          !isExcludedPath(key, choices.excludes)))
    ) {
      continue;
    }
    await inspectChoice(
      'knowledge',
      source,
      pointer('knowledge', 'sources', index),
    );
  }
  if (diagnostics.some((entry) => entry.severity === 'error')) {
    return { ok: false, status: failureStatus, diagnostics };
  }
  return {
    ok: true,
    value: { repositories, knowledgeSources, observations },
  };
}

async function revalidateExplicitInitPaths(
  root: string,
  observations: readonly InitPathObservation[],
  excludes: readonly string[],
): Promise<readonly Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  for (const previous of observations) {
    const current = await inspectInitPathAddition(
      root,
      previous.kind,
      previous.path,
      excludes,
    );
    if (
      !current.ok ||
      !sameInitPathObservation(previous, current.observation)
    ) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.initPlanStale,
          severity: 'error',
          message: `Explicit ${previous.kind} path changed or became unsafe before the final plan: ${previous.path}`,
          source: 'init explicit path inspection',
          pointer: null,
          hint: 'Review and re-enter the exact path; init does not refresh a stale path observation automatically.',
        }),
      );
    }
  }
  return diagnostics;
}

function findSelectedRepositoryForCandidate(
  candidate: ValidationCandidate,
  selected: readonly SelectedRepository[],
): SelectedRepository | null {
  if (candidate.repositoryId !== null) {
    for (const repository of selected) {
      if (repository.originalId === candidate.repositoryId) return repository;
    }
    // A configured/discovered repository identity is authoritative. A
    // different checkout that merely reuses its final selected ID is not a
    // substitute, and working-directory evidence must not override it.
    return null;
  }
  for (const repository of selected) {
    if (
      candidate.workingDirectory !== null &&
      samePath(candidate.workingDirectory, repository.repository.root)
    ) {
      return repository;
    }
  }
  return null;
}

function selectValidationEntries(
  choices: InitChoices,
  discovery: WorkspaceDiscovery,
  selected: readonly SelectedRepository[],
  strictExistingBinding = false,
): {
  readonly validation: readonly WorkspaceValidation[];
  readonly diagnostics: readonly Diagnostic[];
} {
  const byId = new Map(
    discovery.validationCandidates.map((candidate) => [
      candidate.id,
      candidate,
    ]),
  );
  const diagnostics: Diagnostic[] = [];
  const validation: WorkspaceValidation[] = [];
  const usedIds = new Set<string>();
  const existingIds = new Set<string>();
  for (const candidate of discovery.validationCandidates) {
    if (candidate.origin !== 'workspace-config') continue;
    existingIds.add(candidate.id.slice('workspace-config:'.length));
  }
  const seen = new Set<string>();
  for (const [index, candidateId] of choices.validation.entries()) {
    if (seen.has(candidateId)) continue;
    seen.add(candidateId);
    const candidate = byId.get(candidateId);
    if (candidate === undefined) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.initValidationUnknown,
          severity: 'error',
          message: `Init selection references an undiscovered validation candidate: ${candidateId}`,
          source: 'init choices',
          pointer: pointer('validation', index),
          hint: 'Select candidates reported by discovery; discovery does not prove that a command is runnable.',
        }),
      );
      continue;
    }
    const repository = findSelectedRepositoryForCandidate(candidate, selected);
    if (repository === null) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.initValidationUnbound,
          severity:
            strictExistingBinding && candidate.origin === 'workspace-config'
              ? 'error'
              : 'warning',
          message: `Validation candidate "${candidateId}" is not bound to a selected repository.`,
          source: 'init choices',
          pointer: pointer('validation', index),
          hint: 'Select its repository or omit this candidate; unbound commands are not written to workspace config.',
        }),
      );
      continue;
    }
    const existing = candidate.origin === 'workspace-config';
    const base = existing
      ? candidate.id.slice('workspace-config:'.length)
      : sanitizeIdentifier(
          candidate.id.replace(/^(?:workspace-config|package-script):/, ''),
        );
    let id: string;
    if (existing) {
      if (usedIds.has(base)) {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.initValidationUnknown,
            severity: 'error',
            message: `Configured validation id "${base}" is selected more than once.`,
            source: 'init choices',
            pointer: pointer('validation', index),
            hint: 'Keep one selection per configured validation id.',
          }),
        );
        continue;
      }
      id = base;
      usedIds.add(id);
    } else {
      id = uniqueIdentifier(base, new Set([...usedIds, ...existingIds]));
      usedIds.add(id);
    }
    validation.push({
      id,
      repositoryId: repository.id,
      executable: candidate.executable,
      args: [...candidate.args],
    });
  }
  return { validation, diagnostics };
}

function buildWorkspaceConfig(
  root: string,
  choices: InitChoices,
  discovery: WorkspaceDiscovery,
  runtimeVersion: string,
  options: {
    readonly preserveFrom?: WorkspaceConfig;
    readonly strictExistingValidation?: boolean;
    readonly explicitRepositories?: ReadonlyMap<
      string,
      RepositorySelectionSource
    >;
    readonly explicitKnowledgeSources?: ReadonlyMap<string, string>;
  } = {},
): {
  readonly config: WorkspaceConfig | null;
  readonly selected: readonly SelectedRepository[];
  readonly diagnostics: readonly Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const repositorySelection = selectRepositories(
    choices,
    discovery,
    root,
    options.explicitRepositories,
    options.preserveFrom?.repositories.map((repository) => repository.id) ?? [],
  );
  diagnostics.push(...repositorySelection.diagnostics);
  const knowledgeSelection = selectKnowledgeSources(
    choices,
    discovery,
    options.preserveFrom?.knowledge.sources ?? [],
    options.explicitKnowledgeSources,
  );
  diagnostics.push(...knowledgeSelection.diagnostics);
  const validationSelection = selectValidationEntries(
    choices,
    discovery,
    repositorySelection.selected,
    options.strictExistingValidation === true,
  );
  diagnostics.push(...validationSelection.diagnostics);
  if (hasErrors(diagnostics)) {
    return {
      config: null,
      selected: repositorySelection.selected,
      diagnostics,
    };
  }

  const name = choices.name?.trim() ?? '';
  const config: WorkspaceConfig = {
    schema: WORKSPACE_SCHEMA,
    workspaceId:
      options.preserveFrom?.workspaceId ?? choices.workspaceId ?? randomUUID(),
    name: name === '' ? basename(root) || 'workspace' : name,
    runtimeVersion,
    repositories: repositorySelection.selected.map((repository) => ({
      id: repository.id,
      path: repository.path,
      access: repository.access,
    })),
    knowledge: {
      sources: [...knowledgeSelection.sources],
      newDocuments: choices.knowledge.newDocuments,
      taskVisibility: choices.knowledge.taskVisibility,
    },
    code: choices.code,
    validation: [...validationSelection.validation],
    excludes: [...new Set(choices.excludes)],
    extensions: options.preserveFrom?.extensions ?? {},
    ...(options.preserveFrom?.continuity === undefined
      ? {}
      : { continuity: options.preserveFrom.continuity }),
  };
  const parsed = workspaceConfigSchema.safeParse(config);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.initInvalidInput,
          severity: 'error',
          message: issue.message,
          source: 'effective workspace config',
          pointer:
            issue.path.length === 0
              ? null
              : pointer(...issue.path.map((item) => String(item))),
          hint: 'Correct the init selections; Pappra does not coerce invalid configuration.',
        }),
      );
    }
    return {
      config: null,
      selected: repositorySelection.selected,
      diagnostics,
    };
  }
  const semantic = validateWorkspaceConfigSemantics(parsed.data, {
    configPath: join(root, workspaceConfigRelativePath),
  });
  diagnostics.push(...semantic);
  if (hasErrors(semantic)) {
    return {
      config: null,
      selected: repositorySelection.selected,
      diagnostics,
    };
  }
  return {
    config: parsed.data,
    selected: repositorySelection.selected,
    diagnostics,
  };
}

function scopeRepositories(
  config: WorkspaceConfig,
  discovery: WorkspaceDiscovery,
  selected: readonly SelectedRepository[] = [],
): readonly InitScopeRepository[] {
  const byConfiguredPath = new Map(
    discovery.repositories.map((repository) => [
      repository.configuredPath,
      repository,
    ]),
  );
  const bySelectedPath = new Map(
    selected.map((repository) => [candidateKey(repository.path), repository]),
  );
  return config.repositories.map((repository) => {
    const planned = bySelectedPath.get(candidateKey(repository.path));
    const discovered =
      planned?.repository ?? byConfiguredPath.get(repository.path);
    return {
      id: repository.id,
      path: repository.path,
      access: repository.access,
      external: isExternalRepositoryPath(repository.path),
      root: discovered?.root ?? null,
      kind: discovered?.kind ?? null,
      dirty: discovered?.git.dirty ?? null,
      declaredBy:
        planned?.originalId === null
          ? ('planned' as const)
          : ('existing' as const),
    };
  });
}

function planFilesFor(
  config: WorkspaceConfig,
  machine: MachineConfig,
  needWorkspaceConfig: boolean,
  needMachineConfig: boolean,
  existing: {
    readonly workspaceDigest: string | null;
    readonly machineDigest: string | null;
  },
): {
  readonly files: readonly {
    readonly path: string;
    readonly bytes: Buffer;
    readonly beforeText: string | null;
  }[];
  readonly workspaceBytes: Buffer | null;
  readonly machineBytes: Buffer | null;
} {
  const workspaceBytes = needWorkspaceConfig ? jsonBytes(config) : null;
  const machineBytes = needMachineConfig ? jsonBytes(machine) : null;
  const files: {
    path: string;
    bytes: Buffer;
    beforeText: string | null;
  }[] = [];
  if (
    workspaceBytes !== null &&
    existing.workspaceDigest !== sha256Digest(workspaceBytes)
  ) {
    files.push({
      path: workspaceConfigRelativePath,
      bytes: workspaceBytes,
      beforeText: null,
      ...(existing.workspaceDigest === null
        ? {}
        : {
            operation: 'replace-managed' as const,
            expectedBeforeDigest: existing.workspaceDigest,
            backupRequired: true,
          }),
    });
  }
  if (
    machineBytes !== null &&
    existing.machineDigest !== sha256Digest(machineBytes)
  ) {
    files.push({
      path: machineConfigRelativePath,
      bytes: machineBytes,
      beforeText: null,
      ...(existing.machineDigest === null
        ? {}
        : {
            operation: 'replace-managed' as const,
            expectedBeforeDigest: existing.machineDigest,
            backupRequired: true,
          }),
    });
  }
  return { files, workspaceBytes, machineBytes };
}

async function pendingRuntimeActions(
  config: WorkspaceConfig,
  machine: MachineConfig,
): Promise<readonly InitExternalAction[]> {
  if (machine.runtime !== null) {
    const executable = await observePath(machine.runtime.executable);
    if (
      machine.runtime.version === config.runtimeVersion &&
      executable.kind === 'file'
    ) {
      return [];
    }
  }
  return [
    {
      kind: 'install-runtime',
      target: 'pappra',
      version: config.runtimeVersion,
    },
  ];
}

function existingMachineForExistingConfig(
  root: string,
  config: WorkspaceConfig,
  choices: InitChoices | null | undefined,
  discovery: WorkspaceDiscovery,
): {
  readonly machine: MachineConfig | null;
  readonly diagnostics: readonly Diagnostic[];
} {
  if (choices === null || choices === undefined) {
    return {
      machine: null,
      diagnostics: [
        createDiagnostic({
          code: diagnosticCodes.initInputRequired,
          severity: 'error',
          message: 'Host selection is required to create local machine.json.',
          source: 'init choices',
          hint: 'Provide --config with hosts, or run the interactive wizard.',
        }),
      ],
    };
  }
  const externalRepositoryUnknown = config.repositories.some((repository) =>
    isExternalRepositoryPath(repository.path),
  );
  if (externalRepositoryUnknown) {
    return {
      machine: null,
      diagnostics: [
        createDiagnostic({
          code: diagnosticCodes.initExternalMappingRequired,
          severity: 'error',
          message:
            'External repository mappings are missing, so machine.json cannot be completed safely.',
          source: join(root, workspaceConfigRelativePath),
          hint: 'Create or repair .pappra/local/machine.json explicitly; Pappra does not guess absolute external paths.',
        }),
        ...discovery.unresolvedRepositories.flatMap(
          (repository) => repository.diagnostics,
        ),
      ],
    };
  }
  const machine: MachineConfig = {
    schema: 'pappra/machine/1',
    workspaceRealpath: root,
    checkoutId: randomUUID(),
    externalRepositories: [],
    selectedHosts: [...new Set(choices.hosts)],
    runtime: null,
  };
  const parsed = machineConfigSchema.safeParse(machine);
  if (!parsed.success) {
    return {
      machine: null,
      diagnostics: [
        createDiagnostic({
          code: diagnosticCodes.initInvalidInput,
          severity: 'error',
          message:
            parsed.error.issues[0]?.message ??
            'Generated machine configuration is invalid.',
          source: join(root, machineConfigRelativePath),
          hint: 'Correct the host selection.',
        }),
      ],
    };
  }
  return { machine: parsed.data, diagnostics: [] };
}

/**
 * Produces a strict plan and exact in-memory writes. No target file is created
 * or modified by this function.
 */
export async function planWorkspaceInit(
  options: PlanInitOptions,
): Promise<InitPreparation> {
  const contextResult =
    options.context === undefined
      ? await inspectInitContext(options.root)
      : { ok: true as const, context: options.context };
  if (!contextResult.ok) return contextResult;
  const context = contextResult.context;
  const contextRootIdentity = await observeRootIdentity(context.root);
  if (
    contextRootIdentity === null ||
    !sameRootIdentity(context.rootIdentity, contextRootIdentity)
  ) {
    return failure(
      'conflict',
      diagnosticCodes.initPlanStale,
      'Workspace root directory was replaced after discovery.',
      context.diagnostics,
      'Retry init from the current workspace root; no plan was produced.',
    );
  }
  let choices = options.choices ?? null;
  if (choices !== null) {
    const parsedChoices = parseInitChoices(choices, 'init choices');
    if (parsedChoices.value === null) {
      return failureFromDiagnostics(
        'invalid',
        parsedChoices.diagnostics,
        diagnosticCodes.initInvalidInput,
        'Init selections are invalid.',
      );
    }
    choices = parsedChoices.value;
  }
  const existingConfig = context.workspaceInspection.value;
  if (
    existingConfig !== null &&
    options.reconfigure === true &&
    choices !== null &&
    choices.workspaceId !== undefined &&
    choices.workspaceId !== existingConfig.workspaceId
  ) {
    return failure(
      'invalid',
      diagnosticCodes.initInvalidInput,
      'Reconfiguration cannot change workspaceId; the existing workspace identity is stable.',
      context.diagnostics,
      'Remove the conflicting workspaceId from the reconfiguration selections, or create a new workspace separately.',
    );
  }
  const existingMachine = context.machineInspection.value;
  const diagnostics: Diagnostic[] = [...context.diagnostics];
  const runtimeVersion =
    options.runtimeVersion ??
    (options.reconfigure === true
      ? undefined
      : existingConfig?.runtimeVersion) ??
    getPackageInfo().version;
  let config: WorkspaceConfig;
  let machine: MachineConfig;
  let needWorkspaceConfig = false;
  let needMachineConfig = false;
  let selected: readonly SelectedRepository[] = [];

  let explicitPathSelections: ExplicitInitPathSelections = {
    repositories: new Map(),
    knowledgeSources: new Map(),
    observations: [],
  };
  if (existingConfig !== null && options.reconfigure !== true) {
    config = existingConfig;
    if (choices !== null) {
      diagnostics.push(
        info(
          diagnosticCodes.initExistingConfigReused,
          'Existing valid workspace configuration is reused; init selections do not overwrite it.',
          context.workspaceInspection.path,
          'Use a future configure flow to change existing workspace policy.',
        ),
      );
    }
    if (existingMachine !== null) {
      machine = existingMachine;
    } else {
      const machineResult = existingMachineForExistingConfig(
        context.root,
        existingConfig,
        choices,
        context.discovery,
      );
      if (machineResult.machine === null) {
        return failureFromDiagnostics(
          'needs_input',
          [...diagnostics, ...machineResult.diagnostics],
          diagnosticCodes.initInputRequired,
          'More init input is required.',
        );
      }
      machine = machineResult.machine;
      diagnostics.push(...machineResult.diagnostics);
      needMachineConfig = true;
    }
  } else {
    if (choices === null) {
      return failure(
        'needs_input',
        diagnosticCodes.initInputRequired,
        'Workspace configuration is missing; init selections are required.',
        diagnostics,
        'Provide --config with pappra/init-choices/1 selections, or run the interactive wizard.',
      );
    }
    const effectiveChoices =
      existingConfig !== null && choices.workspaceId === undefined
        ? { ...choices, workspaceId: existingConfig.workspaceId }
        : choices;
    const explicitPaths = await inspectExplicitInitPathSelections(
      context.root,
      effectiveChoices,
      context.discovery,
      existingConfig,
      options.pathObservations ?? [],
    );
    if (!explicitPaths.ok) {
      return failureFromDiagnostics(
        explicitPaths.status,
        explicitPaths.diagnostics,
        diagnosticCodes.initInvalidInput,
        'Explicit init paths could not be inspected safely.',
      );
    }
    explicitPathSelections = explicitPaths.value;
    const built = buildWorkspaceConfig(
      context.root,
      effectiveChoices,
      context.discovery,
      runtimeVersion,
      {
        ...(existingConfig === null ? {} : { preserveFrom: existingConfig }),
        ...(options.reconfigure === true
          ? { strictExistingValidation: true }
          : {}),
        explicitRepositories: explicitPaths.value.repositories,
        explicitKnowledgeSources: explicitPaths.value.knowledgeSources,
      },
    );
    diagnostics.push(...built.diagnostics);
    if (built.config === null) {
      return failureFromDiagnostics(
        'invalid',
        diagnostics,
        diagnosticCodes.initInvalidInput,
        'Init selections do not form a valid workspace configuration.',
      );
    }
    config = built.config;
    selected = built.selected;
    needWorkspaceConfig = true;
    if (existingMachine !== null) {
      const desiredHosts = [
        ...new Set(choices.hosts),
      ] as MachineConfig['selectedHosts'];
      const hostsChanged =
        desiredHosts.length !== existingMachine.selectedHosts.length ||
        desiredHosts.some(
          (host) => !existingMachine.selectedHosts.includes(host),
        );
      if (
        options.reconfigure === true &&
        existingConfig !== null &&
        hostsChanged
      ) {
        machine = { ...existingMachine, selectedHosts: desiredHosts };
        needMachineConfig = true;
      } else {
        machine = existingMachine;
        diagnostics.push(
          info(
            diagnosticCodes.initExistingConfigReused,
            'Existing valid machine.json is reused while workspace.json is created.',
            context.machineInspection.path,
            'Use a future configure flow to change local host or external repository mappings.',
          ),
        );
      }
    } else {
      needMachineConfig = true;
      machine = {
        schema: 'pappra/machine/1',
        workspaceRealpath: context.root,
        checkoutId: randomUUID(),
        externalRepositories: [],
        selectedHosts: [...new Set(choices.hosts)],
        runtime: null,
      };
      const parsedMachine = machineConfigSchema.safeParse(machine);
      if (!parsedMachine.success) {
        return failure(
          'invalid',
          diagnosticCodes.initInvalidInput,
          parsedMachine.error.issues[0]?.message ??
            'Generated machine configuration is invalid.',
          diagnostics,
          'Correct the host selection.',
        );
      }
      machine = parsedMachine.data;
    }
  }

  const filePlan = planFilesFor(
    config,
    machine,
    needWorkspaceConfig,
    needMachineConfig,
    {
      workspaceDigest: context.workspaceInspection.digest,
      machineDigest: context.machineInspection.digest,
    },
  );
  const configurationDigest =
    filePlan.workspaceBytes !== null
      ? sha256Digest(filePlan.workspaceBytes)
      : (context.workspaceInspection.digest ??
        sha256Digest(JSON.stringify(config)));
  const externalActions = await pendingRuntimeActions(config, machine);
  const built = buildInitPlan({
    workspaceRoot: context.root,
    configurationDigest,
    files: filePlan.files,
    externalActions,
    ...(options.planId === undefined ? {} : { planId: options.planId }),
    ...(options.discoveredAt === undefined
      ? {}
      : { discoveredAt: options.discoveredAt }),
  });
  const pathRevalidation = await revalidateExplicitInitPaths(
    context.root,
    explicitPathSelections.observations,
    config.excludes,
  );
  if (pathRevalidation.length > 0) {
    return failureFromDiagnostics(
      'conflict',
      [...diagnostics, ...pathRevalidation],
      diagnosticCodes.initPlanStale,
      'An explicitly added path changed while init was planning.',
    );
  }

  const finalWorkspace = await inspectWorkspaceConfig(context.root, {
    missing: 'info',
  });
  const finalMachine = await inspectMachineConfig(context.root);
  if (
    context.workspaceInspection.digest !== finalWorkspace.digest ||
    context.workspaceInspection.exists !== finalWorkspace.exists ||
    context.machineInspection.digest !== finalMachine.digest ||
    context.machineInspection.exists !== finalMachine.exists
  ) {
    return failure(
      'conflict',
      diagnosticCodes.initPlanStale,
      'Workspace inputs changed after planning; the plan is stale.',
      diagnostics,
      'Retry init; no target files were written.',
    );
  }

  const finalRootIdentity = await observeRootIdentity(context.root);
  if (
    finalRootIdentity === null ||
    !sameRootIdentity(context.rootIdentity, finalRootIdentity)
  ) {
    return failure(
      'conflict',
      diagnosticCodes.initPlanStale,
      'Workspace root directory changed while planning.',
      diagnostics,
      'Retry init from the current workspace root; no target files were written.',
    );
  }
  const rootIdentity = context.rootIdentity;
  const scopeRepos: readonly InitScopeRepository[] =
    existingConfig !== null
      ? scopeRepositories(config, context.discovery, selected)
      : selected.map((repository) => ({
          id: repository.id,
          path: repository.path,
          access: repository.access,
          external: repository.repository.external,
          root: repository.repository.root,
          kind: repository.repository.kind,
          dirty: repository.repository.git.dirty,
          declaredBy: 'planned' as const,
        }));
  const scope: InitScope = {
    workspaceRoot: context.root,
    workspaceId: config.workspaceId,
    name: config.name,
    runtimeVersion: config.runtimeVersion,
    configSource:
      existingConfig !== null && options.reconfigure !== true
        ? 'existing'
        : 'planned',
    repositories: scopeRepos,
    knowledge: config.knowledge,
    code: config.code,
    validation: config.validation,
    excludes: config.excludes,
    hosts: machine.selectedHosts,
    boundaries: context.discovery.boundaries,
  };
  return {
    ok: true,
    bundle: {
      plan: built.plan,
      scope,
      writes: built.writes,
      diagnostics: dedupeDiagnostics(diagnostics),
      rootIdentity,
    },
  };
}

function planDiagnostics(
  message: string,
  code: DiagnosticCode,
): InitApplyResult {
  return {
    ok: false,
    status: 'stale',
    appliedFiles: [],
    pendingExternalActions: [],
    residualPaths: [],
    diagnostics: [
      createDiagnostic({
        code,
        severity: 'error',
        message,
        source: 'init apply',
        hint: 'Retry init to produce a fresh plan; no target files were written.',
      }),
    ],
  };
}

function applyFailure(
  status: InitApplyStatus,
  code: DiagnosticCode,
  message: string,
  hint: string | null,
): InitApplyResult {
  return {
    ok: false,
    status,
    appliedFiles: [],
    pendingExternalActions: [],
    residualPaths: [],
    diagnostics: [
      createDiagnostic({
        code,
        severity: 'error',
        message,
        source: 'init apply',
        hint,
      }),
    ],
  };
}

interface SafeTarget {
  readonly absolutePath: string;
  readonly existingAncestor: string;
}

async function safeTarget(
  root: string,
  relativePath: string,
): Promise<SafeTarget | null> {
  if (!isPortableRelativePath(relativePath) || relativePath === '.') {
    return null;
  }
  const absolutePath = resolvePortableRelativePath(root, relativePath);
  if (!isPathInside(root, absolutePath) || samePath(root, absolutePath)) {
    return null;
  }
  let ancestor = dirname(absolutePath);
  for (;;) {
    const observation = await observePath(ancestor);
    if (observation.kind !== 'missing') {
      if (observation.kind !== 'directory') return null;
      const real = await resolveRealpath(ancestor);
      if (real === null || !isPathInside(root, real)) return null;
      return { absolutePath, existingAncestor: real };
    }
    if (samePath(ancestor, root)) return null;
    const parent = dirname(ancestor);
    if (samePath(parent, ancestor)) return null;
    ancestor = parent;
  }
}

async function verifyBundleWrites(
  bundle: InitPlanBundle,
): Promise<readonly Diagnostic[]> {
  const parsed = initPlanSchema.safeParse(bundle.plan);
  if (!parsed.success) {
    return [
      createDiagnostic({
        code: diagnosticCodes.initPlanInvalid,
        severity: 'error',
        message: `Init plan does not match pappra/init-plan/1: ${parsed.error.issues[0]?.message ?? 'invalid plan'}`,
        source: 'init plan',
        hint: 'Regenerate the plan; Pappra does not apply malformed plans.',
      }),
    ];
  }
  if (bundle.writes.length !== bundle.plan.files.length) {
    return [
      createDiagnostic({
        code: diagnosticCodes.initPlanInvalid,
        severity: 'error',
        message: 'Init plan writes do not match planned file entries.',
        source: 'init plan',
        hint: 'Regenerate the plan; Pappra does not apply partial in-memory content.',
      }),
    ];
  }
  const diagnostics: Diagnostic[] = [];
  for (const [index, file] of bundle.plan.files.entries()) {
    const write = bundle.writes[index];
    if (write === undefined || write.path !== file.path) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.initPlanInvalid,
          severity: 'error',
          message: `Init plan write ${index} does not match its planned path.`,
          source: 'init plan',
          hint: 'Regenerate the plan.',
        }),
      );
      continue;
    }
    if (write.operation !== file.operation) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.initPlanInvalid,
          severity: 'error',
          message: `Planned operation for ${file.path} does not match its write.`,
          source: 'init plan',
          hint: 'Regenerate the plan.',
        }),
      );
    }
    if (file.operation !== 'create' && file.operation !== 'replace-managed') {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.initApplyUnsupported,
          severity: 'error',
          message: `Init apply does not support operation ${file.operation} for ${file.path}.`,
          source: 'init plan',
          hint: 'Regenerate the plan with create or replace-managed operations.',
        }),
      );
    }
    if (
      file.operation === 'replace-managed' &&
      file.expectedBeforeDigest === null
    ) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.initPlanInvalid,
          severity: 'error',
          message: `Managed replacement for ${file.path} has no expected before digest.`,
          source: 'init plan',
          hint: 'Regenerate the plan; Pappra does not replace an unverified file.',
        }),
      );
    }
    if (sha256Digest(write.bytes) !== file.nextDigest) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.initPlanInvalid,
          severity: 'error',
          message: `Planned bytes for ${file.path} do not match nextDigest.`,
          source: 'init plan',
          hint: 'Regenerate the plan from the same selections.',
        }),
      );
    }
  }
  return diagnostics;
}

interface CreatedFile {
  readonly path: string;
  readonly digest: string;
  dev: number;
  ino: number;
}

async function cleanupCreatedFiles(
  root: string,
  created: readonly CreatedFile[],
): Promise<readonly string[]> {
  const residual: string[] = [];
  for (const record of [...created].reverse()) {
    const absolute = resolvePortableRelativePath(root, record.path);
    try {
      const observation = await observePath(absolute);
      if (observation.kind === 'missing') continue;
      if (
        observation.kind !== 'file' ||
        observation.stats === null ||
        observation.stats.dev !== record.dev ||
        observation.stats.ino !== record.ino
      ) {
        residual.push(record.path);
        continue;
      }
      const written = await readFile(absolute);
      if (sha256Digest(written) !== record.digest) {
        residual.push(record.path);
        continue;
      }
      await rm(absolute, { force: false });
    } catch {
      residual.push(record.path);
    }
  }
  return residual;
}

/**
 * Applies create and managed replacement operations from a plan, after revalidating root,
 * configuration digest, target absence and exact bytes. External actions are
 * reported as pending and never executed here.
 */
export async function applyInitPlan(
  bundle: InitPlanBundle,
  options: InitApplyOptions = {},
): Promise<InitApplyResult> {
  const diagnostics = await verifyBundleWrites(bundle);
  if (diagnostics.length > 0) {
    return {
      ok: false,
      status: diagnostics.some(
        (entry) => entry.code === diagnosticCodes.initApplyUnsupported,
      )
        ? 'unsupported'
        : 'stale',
      appliedFiles: [],
      pendingExternalActions: [],
      residualPaths: [],
      diagnostics,
    };
  }
  const root = await resolveRealpath(bundle.plan.workspaceRoot);
  const rootObservation = await observePath(bundle.plan.workspaceRoot);
  if (
    root === null ||
    !samePath(root, bundle.plan.workspaceRoot) ||
    rootObservation.kind !== 'directory' ||
    rootObservation.stats === null ||
    rootObservation.stats.dev !== bundle.rootIdentity.dev ||
    rootObservation.stats.ino !== bundle.rootIdentity.ino
  ) {
    return applyFailure(
      'stale',
      diagnosticCodes.initPlanStale,
      'Workspace root identity changed since planning.',
      'Retry init from the current workspace root; no files were written.',
    );
  }

  const workspaceInspection = await inspectWorkspaceConfig(root, {
    missing: 'info',
  });
  const workspaceFileIndex = bundle.plan.files.findIndex(
    (file) => file.path === workspaceConfigRelativePath,
  );
  const workspaceFile =
    workspaceFileIndex === -1 ? null : bundle.plan.files[workspaceFileIndex]!;
  if (
    workspaceFile === null &&
    (!workspaceInspection.exists ||
      workspaceInspection.value === null ||
      workspaceInspection.digest !== bundle.plan.configurationDigest)
  ) {
    return planDiagnostics(
      'Workspace configuration changed since planning.',
      diagnosticCodes.initPlanStale,
    );
  }
  if (workspaceFile !== null) {
    if (workspaceFile.operation === 'create' && workspaceInspection.exists) {
      return applyFailure(
        'conflict',
        diagnosticCodes.initTargetExists,
        'Workspace configuration appeared after planning.',
        'Remove or relocate the unexpected file, then retry init.',
      );
    }
    if (
      workspaceFile.operation === 'replace-managed' &&
      workspaceInspection.digest !== workspaceFile.expectedBeforeDigest
    ) {
      return planDiagnostics(
        'Workspace configuration changed since planning.',
        diagnosticCodes.initPlanStale,
      );
    }
  }

  for (const file of bundle.plan.files) {
    const target = await safeTarget(root, file.path);
    if (target === null) {
      return applyFailure(
        'conflict',
        diagnosticCodes.initTargetUnsafe,
        `Planned target is not a safe workspace-relative path: ${file.path}`,
        'Regenerate the plan; Pappra does not follow symlinked parents outside the workspace.',
      );
    }
    const observation = await observePath(target.absolutePath);
    if (file.operation === 'create') {
      if (observation.kind !== 'missing') {
        return applyFailure(
          'conflict',
          diagnosticCodes.initTargetExists,
          `Planned target already exists: ${file.path}`,
          'Remove or relocate the unexpected file, then retry init.',
        );
      }
      continue;
    }
    if (observation.kind !== 'file' || observation.stats === null) {
      return applyFailure(
        'conflict',
        diagnosticCodes.initTargetExists,
        `Planned replacement target is not a regular file: ${file.path}`,
        'Inspect the target; Pappra does not replace directories or special files.',
      );
    }
    const before = await readFile(target.absolutePath);
    if (
      file.expectedBeforeDigest === null ||
      sha256Digest(before) !== file.expectedBeforeDigest
    ) {
      return planDiagnostics(
        `Planned replacement target changed since planning: ${file.path}`,
        diagnosticCodes.initPlanStale,
      );
    }
  }

  const createIndexes = bundle.plan.files.flatMap((file, index) =>
    file.operation === 'create' ? [index] : [],
  );
  const replaceIndexes = bundle.plan.files.flatMap((file, index) =>
    file.operation === 'replace-managed' ? [index] : [],
  );
  let managed: ManagedApplyContext | null = null;
  const created: CreatedFile[] = [];
  const createdDirectories: string[] = [];
  interface AppliedReplacement {
    readonly path: string;
    readonly absolutePath: string;
    readonly beforeBytes: Buffer;
    readonly backupRef: string;
    readonly backupDigest: string;
    readonly afterDigest: string;
    readonly identity: { readonly dev: number; readonly ino: number };
  }
  const replacements: AppliedReplacement[] = [];
  let originalManifest: WorkspaceInstallManifest | null = null;
  const ensureDirectory = async (directory: string): Promise<void> => {
    const missing: string[] = [];
    let current = directory;
    for (;;) {
      const observation = await observePath(current);
      if (observation.kind !== 'missing') {
        if (observation.kind !== 'directory') {
          throw new Error(`Parent path is not a directory: ${current}`);
        }
        break;
      }
      missing.push(current);
      if (samePath(current, root)) break;
      const parent = dirname(current);
      if (samePath(parent, current)) break;
      current = parent;
    }
    for (const path of missing.reverse()) {
      await mkdir(path);
      createdDirectories.push(path);
    }
  };
  const restoreReplacements = async (): Promise<string[]> => {
    const residual: string[] = [];
    const entries =
      originalManifest === null ? [] : [...originalManifest.entries];
    for (const replacement of [...replacements].reverse()) {
      try {
        const current = await observePath(replacement.absolutePath);
        if (
          current.kind !== 'file' ||
          current.stats === null ||
          current.stats.dev !== replacement.identity.dev ||
          current.stats.ino !== replacement.identity.ino ||
          sha256Digest(await readFile(replacement.absolutePath)) !==
            replacement.afterDigest
        ) {
          residual.push(replacement.path);
          continue;
        }
        const restored = await writeBytesAtomic(
          replacement.absolutePath,
          replacement.beforeBytes,
          root,
        );
        if (!restored.ok) throw new Error(restored.message);
        const after = await observePath(replacement.absolutePath);
        if (after.kind !== 'file' || after.stats === null)
          throw new Error('Restored file is unreadable.');
        const index = entries.findIndex(
          (entry) => entry.path === replacement.path,
        );
        if (index >= 0)
          entries[index] = {
            ...entries[index]!,
            afterDigest: replacement.backupDigest,
            identity: { dev: after.stats.dev, ino: after.stats.ino },
          };
      } catch {
        residual.push(replacement.path);
      }
    }
    if (originalManifest !== null && replacements.length > 0) {
      const restored = await writeWorkspaceManifest(root, {
        ...originalManifest,
        entries,
      }).catch(() => ({ ok: false }));
      if (!restored.ok) residual.push('.pappra/local/install-manifest.json');
    }
    return residual;
  };
  const rootBeforeWrite = await observePath(root);
  if (
    rootBeforeWrite.kind !== 'directory' ||
    rootBeforeWrite.stats === null ||
    rootBeforeWrite.stats.dev !== bundle.rootIdentity.dev ||
    rootBeforeWrite.stats.ino !== bundle.rootIdentity.ino
  ) {
    return applyFailure(
      'stale',
      diagnosticCodes.initPlanStale,
      'Workspace root identity changed before writing.',
      'Retry init from the current workspace root; no files were written.',
    );
  }

  try {
    if (bundle.plan.files.length > 0) {
      const managedStart = await beginManagedApply(
        root,
        bundle.plan,
        bundle.writes,
        bundle.rootIdentity,
      );
      if (!managedStart.ok) {
        return {
          ok: false,
          status:
            managedStart.status === 'invalid'
              ? 'stale'
              : managedStart.status === 'locked'
                ? 'conflict'
                : 'failed',
          appliedFiles: [],
          pendingExternalActions: [],
          residualPaths: managedStart.residualPaths,
          diagnostics: managedStart.diagnostics,
        };
      }
      managed = managedStart.context;
      originalManifest = managed.manifest;
    } else {
      const ready = await verifyWorkspaceInstallReady(root);
      if (!ready.ok)
        return applyFailure(
          'conflict',
          ready.code,
          ready.message,
          ready.nextAction ?? 'Run pappra repair before retrying init.',
        );
    }
    for (const index of replaceIndexes) {
      const file = bundle.plan.files[index]!;
      const write = bundle.writes[index]!;
      await options.beforeWrite?.(file.path, index);
      const absolutePath = resolvePortableRelativePath(root, file.path);
      const backupFile = backupPath(root, managed!.installId, file.path);
      const backupRef = toWorkspaceRelativePath(root, backupFile)!;
      const stateBoundary = await ensureStatePathBoundary(root, backupFile);
      if (!stateBoundary.ok) throw new Error(stateBoundary.message);
      const beforeBytes = await readFile(absolutePath);
      if (
        file.expectedBeforeDigest === null ||
        sha256Digest(beforeBytes) !== file.expectedBeforeDigest
      ) {
        throw new Error(`Replacement target changed again: ${file.path}`);
      }
      const observation = await observePath(absolutePath);
      if (observation.kind !== 'file')
        throw new Error(`Unsafe replacement target: ${file.path}`);
      const mode =
        observation.stats === null ? 0o644 : observation.stats.mode & 0o777;
      await mkdir(dirname(backupFile), { recursive: true });
      await writeFile(backupFile, beforeBytes, { mode: 0o600, flag: 'wx' });
      const temporary = `${absolutePath}.pappra-replace-${randomUUID().slice(0, 8)}`;
      try {
        await writeFile(temporary, write.bytes, { mode, flag: 'wx' });
        const staged = await observePath(temporary);
        if (staged.kind !== 'file' || staged.stats === null)
          throw new Error('Replacement staging failed.');
        const recorded = await recordManagedFile(
          managed!,
          file.path,
          file.nextDigest,
          { dev: staged.stats.dev, ino: staged.stats.ino },
          { backupRef, backupDigest: sha256Digest(beforeBytes) },
        );
        if (!recorded.ok)
          throw new Error(
            recorded.diagnostics[0]?.message ?? 'Cannot journal replacement.',
          );
        const beforeRename = await observePath(absolutePath);
        if (
          beforeRename.kind !== 'file' ||
          beforeRename.stats?.dev !== observation.stats?.dev ||
          beforeRename.stats?.ino !== observation.stats?.ino ||
          sha256Digest(await readFile(absolutePath)) !==
            file.expectedBeforeDigest
        ) {
          throw new Error(
            `Replacement target changed before publish: ${file.path}`,
          );
        }
        await rename(temporary, absolutePath);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
      const after = await observePath(absolutePath);
      if (after.kind !== 'file' || after.stats === null) {
        throw new Error(
          `Replacement target is unreadable after writing: ${file.path}`,
        );
      }
      replacements.push({
        path: file.path,
        absolutePath,
        beforeBytes,
        backupRef,
        backupDigest: sha256Digest(beforeBytes),
        afterDigest: file.nextDigest,
        identity: { dev: after.stats.dev, ino: after.stats.ino },
      });
    }

    if (createIndexes.length > 0) {
      for (const index of createIndexes) {
        const file = bundle.plan.files[index]!;
        const write = bundle.writes[index]!;
        const target = await safeTarget(root, file.path);
        if (target === null) {
          throw new Error(`Unsafe target: ${file.path}`);
        }
        await options.beforeWrite?.(file.path, index);
        await ensureDirectory(dirname(target.absolutePath));
        const handle = await open(target.absolutePath, 'wx');
        const record: CreatedFile = {
          path: file.path,
          digest: file.nextDigest,
          dev: 0,
          ino: 0,
        };
        try {
          await handle.writeFile(write.bytes);
          await handle.sync();
          const stats = await handle.stat();
          record.dev = stats.dev;
          record.ino = stats.ino;
        } finally {
          await handle.close();
        }
        await options.afterWrite?.(file.path, index);
        created.push(record);
        const recorded = await recordManagedFile(
          managed!,
          file.path,
          file.nextDigest,
          { dev: record.dev, ino: record.ino },
        );
        if (!recorded.ok) {
          throw new Error(
            recorded.diagnostics[0]?.message ?? `Cannot record ${file.path}.`,
          );
        }
      }
    }
    if (managed !== null) {
      const completed = await completeManagedApply(managed);
      if (!completed.ok) {
        const residual = [
          ...(await cleanupCreatedFiles(root, created)),
          ...(await restoreReplacements()),
        ];
        const failed = await failManagedApply(
          managed,
          'Cannot finalize managed installation manifest.',
          residual,
        );
        return {
          ok: false,
          status: 'failed',
          appliedFiles: [],
          pendingExternalActions: [],
          residualPaths: failed.residualPaths,
          diagnostics: failed.diagnostics,
        };
      }
    }

    const appliedFiles = [
      ...created.map((file) => file.path),
      ...replacements.map((replacement) => replacement.path),
    ];
    return {
      ok: true,
      status:
        bundle.plan.externalActions.length > 0
          ? 'external-actions-pending'
          : appliedFiles.length === 0
            ? 'no-changes'
            : 'applied',
      appliedFiles,
      pendingExternalActions: bundle.plan.externalActions,
      residualPaths: [],
      diagnostics: [],
    };
  } catch (error) {
    const residual = [
      ...(await restoreReplacements()),
      ...(await cleanupCreatedFiles(root, created)),
    ];
    for (const directory of createdDirectories.reverse()) {
      await rmdir(directory).catch(() => undefined);
    }
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'EEXIST'
        ? diagnosticCodes.initTargetExists
        : diagnosticCodes.initApplyFailed;
    const status: InitApplyStatus =
      code === diagnosticCodes.initTargetExists ? 'conflict' : 'failed';
    const base = `Init apply ${status === 'conflict' ? 'stopped because a target appeared' : 'failed'}: ${error instanceof Error ? error.message : String(error)}`;
    const residualNote =
      residual.length === 0
        ? 'No planned file from this attempt remains.'
        : `Residual planned files require manual inspection: ${residual.join(', ')}`;
    if (managed === null) {
      return {
        ok: false,
        status,
        appliedFiles: [],
        pendingExternalActions: [],
        residualPaths: residual,
        diagnostics: [
          createDiagnostic({
            code,
            severity: 'error',
            message: `${base}. ${residualNote}`,
            source: 'init apply',
            pointer: null,
            hint: 'Inspect the workspace state; backups from this attempt were restored when possible.',
          }),
        ],
      };
    }
    const failed = await failManagedApply(
      managed,
      `${base}. ${residualNote}`,
      residual,
    );
    return {
      ok: false,
      status,
      appliedFiles: [],
      pendingExternalActions: [],
      residualPaths: failed.residualPaths,
      diagnostics: failed.diagnostics,
    };
  }
}

export interface RuntimeFlowResult {
  readonly ok: boolean;
  readonly completion: boolean;
  readonly runtime: RuntimeInstallResult | null;
  readonly diagnostics: readonly Diagnostic[];
}

export async function bindAndRecordRuntime(
  root: string,
  installed: RuntimeInstallResult,
): Promise<RuntimeFlowResult> {
  if (!installed.ok || installed.manifest === null) {
    return {
      ok: false,
      completion: false,
      runtime: installed,
      diagnostics: installed.diagnostics,
    };
  }
  const updated = await updateMachineRuntime(root, installed.manifest);
  if (!updated.ok) {
    return {
      ok: false,
      completion: false,
      runtime: installed,
      diagnostics: updated.diagnostics,
    };
  }
  const followUp = await planWorkspaceInit({ root });
  if (!followUp.ok) {
    return {
      ok: false,
      completion: false,
      runtime: installed,
      diagnostics: followUp.diagnostics,
    };
  }
  if (
    followUp.bundle.plan.files.length > 0 ||
    followUp.bundle.plan.externalActions.length > 0
  ) {
    return {
      ok: false,
      completion: false,
      runtime: installed,
      diagnostics: [
        {
          code: diagnosticCodes.initRuntimeSourceRequired,
          severity: 'error',
          message:
            'Runtime installation succeeded but init still has pending file or external actions.',
          source: 'init runtime',
          pointer: null,
          hint: 'Run pappra init again to review the remaining plan; initialization is not complete.',
        },
      ],
    };
  }
  return {
    ok: true,
    completion: true,
    runtime: installed,
    diagnostics: [],
  };
}

/**
 * Ensures and binds the runtime package that is currently executing.
 *
 * The installer reuses an existing runtime only after its manifest, package
 * contents, executable and smoke checks pass; a regular file is not proof of a
 * verified durable runtime.
 */
export async function ensureDefaultRuntime(
  root: string,
  targetVersion: string,
): Promise<RuntimeFlowResult> {
  const installed = await installRuntime({
    version: targetVersion,
    source: { kind: 'self', path: getPackageRoot() },
    packageName: getPackageInfo().name,
  });
  return bindAndRecordRuntime(root, installed);
}
