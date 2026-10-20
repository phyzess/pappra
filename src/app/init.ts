import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import {
  mkdir,
  open,
  readFile,
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
} from '../schemas/paths.js';
import {
  WORKSPACE_SCHEMA,
  validateWorkspaceConfigSemantics,
  workspaceConfigSchema,
  type WorkspaceConfig,
  type WorkspaceValidation,
} from '../schemas/workspace.js';
import { getPackageInfo } from '../package-info.js';
import { spawnSync } from 'node:child_process';
import { executableOnPath } from '../hosts/detect.js';
import { HOST_SUPPORT } from '../hosts/integration/support.js';
import { observePath, resolveRealpath, sha256Digest } from '../infra/fs.js';
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
import { resolveWorkspaceRoot } from '../workspace/resolve.js';
import type {
  DiscoveredRepository,
  ValidationCandidate,
} from '../workspace/types.js';
import { buildInitPlan, type PlannedFileContent } from '../install/plan.js';
import {
  backupPath,
  ensureStatePathBoundary,
  readWorkspaceManifest,
  writeWorkspaceManifest,
} from '../install/ownership.js';
import type { WorkspaceInstallManifest } from '../schemas/install.js';
import {
  beginManagedApply,
  completeManagedApply,
  failManagedApply,
  recordManagedFile,
  type ManagedApplyContext,
} from '../install/apply.js';

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

function repositoryKey(repository: DiscoveredRepository): string {
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

function detectedHostVersion(command: string, pathEnv: string): string | null {
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

  const knowledgeCandidates = listKnowledgeCandidates(discovery);
  const rootRuleFiles = ['AGENTS.md', 'CLAUDE.md'];
  const knowledgeSources: string[] = [];
  for (const name of rootRuleFiles) {
    const candidate = knowledgeCandidates.find(
      (entry) => entry.path.toLowerCase() === name.toLowerCase(),
    );
    if (candidate === undefined) continue;
    knowledgeSources.push(candidate.path);
    rules.push({
      field: 'knowledge.sources',
      value: candidate.path,
      reason: 'workspace-root rule file reported by discovery',
    });
  }
  const docs = knowledgeCandidates.find((entry) => entry.path === 'docs');
  if (docs !== undefined) {
    knowledgeSources.push(docs.path);
    rules.push({
      field: 'knowledge.sources',
      value: docs.path,
      reason: 'documentation directory reported by discovery',
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
    value: 'auto',
    reason: 'symbol providers are detected passively at use time',
  });
  rules.push({
    field: 'code.prepare',
    value: 'on-demand',
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
    value: derivedExcludes.join(', '),
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

  const name = basename(discovery.root);
  rules.push({
    field: 'name',
    value: name,
    reason: 'workspace name derived from the workspace root directory',
  });

  const choices: InitChoices = {
    schema: INIT_CHOICES_SCHEMA,
    name,
    repositories,
    knowledge: {
      sources: knowledgeSources,
      newDocuments: '.pappra/knowledge',
      taskVisibility: 'private',
    },
    code: { graph, symbols: 'auto', prepare: 'on-demand' },
    validation,
    excludes: [...derivedExcludes],
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
  readonly repository: DiscoveredRepository;
  readonly id: string;
  readonly path: string;
  readonly access: 'read' | 'write';
  readonly originalId: string | null;
}

function selectRepositories(
  choices: InitChoices,
  discovery: WorkspaceDiscovery,
  root: string,
): {
  readonly selected: readonly SelectedRepository[];
  readonly diagnostics: readonly Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const byKey = new Map<string, DiscoveredRepository>();
  for (const repository of discovery.repositories) {
    byKey.set(repositoryKey(repository), repository);
    if (repository.relativePath !== null) {
      byKey.set(
        normalizePortableRelativePath(repository.relativePath),
        repository,
      );
    }
  }
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
          message: `Init selection references an undiscovered repository: ${choice.path}`,
          source: 'init choices',
          pointer: pointer('repositories', index, 'path'),
          hint: 'Select a repository path reported by discovery; Pappra does not invent repository scopes.',
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
          hint: 'Keep one selection per discovered checkout.',
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
    const id = choice.id
      ? choice.id
      : uniqueIdentifier(sanitizeIdentifier(derivedBase), usedIds);
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
      usedIds.add(choice.id);
    }
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
  const diagnostics: Diagnostic[] = [];
  const sources: string[] = [];
  const seen = new Set<string>();
  for (const [index, source] of choices.knowledge.sources.entries()) {
    const key = candidateKey(source);
    const canonical = allowed.get(key);
    if (canonical === undefined) {
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

function findSelectedRepositoryForCandidate(
  candidate: ValidationCandidate,
  selected: readonly SelectedRepository[],
): SelectedRepository | null {
  for (const repository of selected) {
    if (
      candidate.repositoryId !== null &&
      (candidate.repositoryId === repository.originalId ||
        candidate.repositoryId === repository.id)
    ) {
      return repository;
    }
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
          severity: 'warning',
          message: `Validation candidate "${candidateId}" is not bound to a selected repository.`,
          source: 'init choices',
          pointer: pointer('validation', index),
          hint: 'Select its repository or omit this candidate; unbound commands are not written to workspace config.',
        }),
      );
      continue;
    }
    const base = sanitizeIdentifier(
      candidate.id.replace(/^(?:workspace-config|package-script):/, ''),
    );
    validation.push({
      id: uniqueIdentifier(base, usedIds),
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
): {
  readonly config: WorkspaceConfig | null;
  readonly selected: readonly SelectedRepository[];
  readonly diagnostics: readonly Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const repositorySelection = selectRepositories(choices, discovery, root);
  diagnostics.push(...repositorySelection.diagnostics);
  const knowledgeSelection = selectKnowledgeSources(choices, discovery);
  diagnostics.push(...knowledgeSelection.diagnostics);
  const validationSelection = selectValidationEntries(
    choices,
    discovery,
    repositorySelection.selected,
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
    workspaceId: choices.workspaceId ?? randomUUID(),
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
    extensions: {},
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
): readonly InitScopeRepository[] {
  const byConfiguredPath = new Map(
    discovery.repositories.map((repository) => [
      repository.configuredPath,
      repository,
    ]),
  );
  return config.repositories.map((repository) => {
    const discovered = byConfiguredPath.get(repository.path);
    return {
      id: repository.id,
      path: repository.path,
      access: repository.access,
      external: isExternalRepositoryPath(repository.path),
      root: discovered?.root ?? null,
      kind: discovered?.kind ?? null,
      dirty: discovered?.git.dirty ?? null,
      declaredBy: 'existing' as const,
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
    const built = buildWorkspaceConfig(
      context.root,
      effectiveChoices,
      context.discovery,
      runtimeVersion,
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
      machine = existingMachine;
      diagnostics.push(
        info(
          diagnosticCodes.initExistingConfigReused,
          'Existing valid machine.json is reused while workspace.json is created.',
          context.machineInspection.path,
          'Use a future configure flow to change local host or external repository mappings.',
        ),
      );
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
      ? scopeRepositories(config, context.discovery)
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
 * Applies only create operations from a plan, after revalidating root,
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
  const restoreReplacements = async (): Promise<void> => {
    for (const replacement of [...replacements].reverse()) {
      try {
        await writeFile(replacement.absolutePath, replacement.beforeBytes);
      } catch {
        // The residual list below and the failure diagnostic report this case.
      }
    }
    if (originalManifest !== null) {
      await writeWorkspaceManifest(root, originalManifest).catch(
        () => undefined,
      );
    }
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
    for (const index of replaceIndexes) {
      const file = bundle.plan.files[index]!;
      const write = bundle.writes[index]!;
      await options.beforeWrite?.(file.path, index);
      const absolutePath = resolvePortableRelativePath(root, file.path);
      const backupRef = backupPath(root, bundle.plan.planId, file.path);
      const stateBoundary = await ensureStatePathBoundary(root, backupRef);
      if (!stateBoundary.ok) throw new Error(stateBoundary.message);
      const beforeBytes = await readFile(absolutePath);
      if (
        file.expectedBeforeDigest === null ||
        sha256Digest(beforeBytes) !== file.expectedBeforeDigest
      ) {
        throw new Error(`Replacement target changed again: ${file.path}`);
      }
      const observation = await observePath(absolutePath);
      const mode =
        observation.stats === null ? 0o644 : observation.stats.mode & 0o777;
      await mkdir(dirname(backupRef), { recursive: true });
      await writeFile(backupRef, beforeBytes, { mode: 0o600, flag: 'wx' });
      const temporary = `${absolutePath}.pappra-replace-${randomUUID().slice(0, 8)}`;
      await writeFile(temporary, write.bytes, { mode });
      await rename(temporary, absolutePath);
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

    if (replacements.length > 0) {
      const manifestRead = await readWorkspaceManifest(root);
      if (manifestRead.diagnostics.length > 0) {
        throw new Error(
          manifestRead.diagnostics[0]?.message ??
            'Workspace install manifest is unreadable.',
        );
      }
      if (manifestRead.value === null) {
        throw new Error(
          'Workspace install manifest is missing; Pappra does not adopt an unowned replacement.',
        );
      }
      originalManifest = manifestRead.value;
      const entries = [...manifestRead.value.entries];
      const verifiedAt = new Date().toISOString();
      for (const replacement of replacements) {
        const entry = {
          path: replacement.path,
          installId: bundle.plan.planId,
          operation: 'replace-managed' as const,
          beforeDigest: replacement.backupDigest,
          afterDigest: replacement.afterDigest,
          backupRef: replacement.backupRef,
          backupDigest: replacement.backupDigest,
          identity: replacement.identity,
          owner: 'pappra' as const,
          verifiedAt,
        };
        const existingIndex = entries.findIndex(
          (item) => item.path === replacement.path,
        );
        if (existingIndex === -1) entries.push(entry);
        else entries[existingIndex] = entry;
      }
      const written = await writeWorkspaceManifest(root, {
        ...manifestRead.value,
        entries,
      });
      if (!written.ok) throw new Error(written.message);
    }

    if (createIndexes.length > 0) {
      const createPlan = {
        ...bundle.plan,
        files: createIndexes.map((index) => bundle.plan.files[index]!),
      };
      const createWrites = createIndexes.map((index) => bundle.writes[index]!);
      const managedStart = await beginManagedApply(
        root,
        createPlan,
        createWrites,
        bundle.rootIdentity,
      );
      if (!managedStart.ok) {
        const status =
          managedStart.status === 'invalid'
            ? 'stale'
            : managedStart.status === 'locked'
              ? 'conflict'
              : 'failed';
        await restoreReplacements();
        return {
          ok: false,
          status,
          appliedFiles: [],
          pendingExternalActions: [],
          residualPaths: managedStart.residualPaths,
          diagnostics: managedStart.diagnostics,
        };
      }
      managed = managedStart.context;
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
        created.push(record);
        const recorded = await recordManagedFile(
          managed,
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
      const completed = await completeManagedApply(managed);
      if (!completed.ok) {
        const residual = await cleanupCreatedFiles(root, created);
        const failed = await failManagedApply(
          managed,
          'Cannot finalize managed installation manifest.',
          residual,
        );
        await restoreReplacements();
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
    await restoreReplacements();
    const residual = await cleanupCreatedFiles(root, created);
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
