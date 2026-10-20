import { join, resolve } from 'node:path';
import type { Diagnostic } from '../schemas/diagnostics.js';
import { createDiagnostic } from '../schemas/diagnostics.js';
import { diagnosticCodes } from '../schemas/errors.js';
import type { MachineConfig } from '../schemas/machine.js';
import type { WorkspaceConfig } from '../schemas/workspace.js';
import { observePath, resolveRealpath } from '../infra/fs.js';
import { inspectMachineConfig, inspectWorkspaceConfig } from './config.js';
import { discoverDocuments } from './documents.js';
import { discoverRepositories } from './repositories.js';
import { discoverValidationCandidates } from './validation.js';
import type {
  DiscoveredDocument,
  DiscoveredRepository,
  DiscoveryOptions,
  MachineConfigState,
  NormalizedDiscoveryOptions,
  UnresolvedRepository,
  ValidationCandidate,
  WorkspaceConfigState,
} from './types.js';

export interface WorkspaceDiscovery {
  readonly requestedRoot: string;
  readonly root: string;
  readonly rootState: 'directory' | 'unavailable';
  readonly configPath: string;
  readonly configState: WorkspaceConfigState;
  readonly config: WorkspaceConfig | null;
  readonly machinePath: string;
  readonly machineState: MachineConfigState;
  readonly machine: MachineConfig | null;
  readonly repositories: readonly DiscoveredRepository[];
  readonly unresolvedRepositories: readonly UnresolvedRepository[];
  /** Nested workspace roots observed and deliberately not entered. */
  readonly boundaries: readonly string[];
  readonly documents: readonly DiscoveredDocument[];
  readonly validationCandidates: readonly ValidationCandidate[];
  readonly diagnostics: readonly Diagnostic[];
  readonly truncated: boolean;
  readonly observedAt: string;
}

function boundedInteger(
  name: string,
  value: number | undefined,
  fallback: number,
  minimum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(
      `${name} must be an integer >= ${minimum}; received ${String(value)}.`,
    );
  }
  return value;
}

function normalizeOptions(
  options: DiscoveryOptions,
): NormalizedDiscoveryOptions {
  return {
    scanDepth: boundedInteger('scanDepth', options.scanDepth, 2, 0),
    maxDirectories: boundedInteger(
      'maxDirectories',
      options.maxDirectories,
      400,
      1,
    ),
    maxDocuments: boundedInteger('maxDocuments', options.maxDocuments, 300, 1),
    maxEntriesPerDirectory: boundedInteger(
      'maxEntriesPerDirectory',
      options.maxEntriesPerDirectory,
      200,
      1,
    ),
    gitTimeoutMs: boundedInteger(
      'gitTimeoutMs',
      options.gitTimeoutMs,
      5_000,
      1,
    ),
  };
}

function configState(value: unknown, exists: boolean): WorkspaceConfigState {
  if (value !== null) return 'valid';
  return exists ? 'invalid' : 'missing';
}

function machineState(value: unknown, exists: boolean): MachineConfigState {
  if (value !== null) return 'valid';
  return exists ? 'invalid' : 'missing';
}

function unavailableDiscovery(
  requestedRoot: string,
  canonicalRoot: string,
  diagnostic: Diagnostic,
): WorkspaceDiscovery {
  return {
    requestedRoot,
    root: canonicalRoot,
    rootState: 'unavailable',
    configPath: join(canonicalRoot, '.pappra', 'workspace.json'),
    configState: 'missing',
    config: null,
    machinePath: join(canonicalRoot, '.pappra', 'local', 'machine.json'),
    machineState: 'missing',
    machine: null,
    repositories: [],
    unresolvedRepositories: [],
    boundaries: [],
    documents: [],
    validationCandidates: [],
    diagnostics: [diagnostic],
    truncated: false,
    observedAt: new Date().toISOString(),
  };
}

/**
 * Discovers repositories, rules, documents, and validation candidates under an
 * explicit workspace root.
 *
 * This function is read-only: it never executes package scripts, hooks, git
 * fetch, or model calls, and never writes configuration. Missing configuration
 * is reported and discovery continues only with capability-truthful scan data;
 * invalid configuration is never partially applied.
 */
export async function discoverWorkspace(
  workspaceRoot: string,
  options: DiscoveryOptions = {},
): Promise<WorkspaceDiscovery> {
  const normalized = normalizeOptions(options);
  const requestedRoot = resolve(workspaceRoot);
  let observation;
  try {
    observation = await observePath(requestedRoot);
  } catch (error) {
    return unavailableDiscovery(
      requestedRoot,
      requestedRoot,
      createDiagnostic({
        code: diagnosticCodes.workspaceRootInvalid,
        severity: 'error',
        message: `Cannot inspect workspace root: ${requestedRoot} (${error instanceof Error ? error.message : String(error)})`,
        source: requestedRoot,
        hint: 'Pass an existing readable directory.',
      }),
    );
  }
  if (observation.kind === 'missing') {
    return unavailableDiscovery(
      requestedRoot,
      requestedRoot,
      createDiagnostic({
        code: diagnosticCodes.workspaceRootInvalid,
        severity: 'error',
        message: `Workspace root does not exist: ${requestedRoot}`,
        source: requestedRoot,
        hint: 'Pass an existing directory; discovery does not create it.',
      }),
    );
  }
  const canonicalRoot = await resolveRealpath(requestedRoot);
  if (canonicalRoot === null) {
    return unavailableDiscovery(
      requestedRoot,
      requestedRoot,
      createDiagnostic({
        code: diagnosticCodes.workspaceRootInvalid,
        severity: 'error',
        message: `Cannot resolve workspace root: ${requestedRoot}`,
        source: requestedRoot,
        hint: 'Check permissions and the path.',
      }),
    );
  }
  const rootObservation = await observePath(canonicalRoot);
  if (rootObservation.kind !== 'directory') {
    return unavailableDiscovery(
      requestedRoot,
      canonicalRoot,
      createDiagnostic({
        code: diagnosticCodes.workspaceRootInvalid,
        severity: 'error',
        message: `Workspace root is not a directory: ${canonicalRoot}`,
        source: canonicalRoot,
        hint: 'Pass a directory path.',
      }),
    );
  }

  const [workspaceInspection, machineInspection] = await Promise.all([
    inspectWorkspaceConfig(canonicalRoot, { missing: 'info' }),
    inspectMachineConfig(canonicalRoot),
  ]);
  const config = workspaceInspection.value;
  const machine = machineInspection.value;
  const diagnostics: Diagnostic[] = [
    ...workspaceInspection.diagnostics,
    ...machineInspection.diagnostics,
  ];

  if (config !== null && machine !== null && machine.runtime !== null) {
    const runtime = machine.runtime;
    const executableObservation = await observePath(runtime.executable);
    if (
      executableObservation.kind !== 'file' &&
      executableObservation.kind !== 'symlink'
    ) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.runtimeMissing,
          severity: 'warning',
          message: `Recorded runtime does not exist: ${runtime.executable}`,
          source: machineInspection.path,
          hint: 'Reinstall or repair the fixed runtime explicitly; discovery never executes it.',
        }),
      );
    }
    if (runtime.version !== config.runtimeVersion) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.runtimeVersionMismatch,
          severity: 'warning',
          message: `Workspace targets ${config.runtimeVersion}, but the verified local runtime is ${runtime.version}.`,
          source: machineInspection.path,
          hint: 'Run an explicit update or repair flow; discovery does not change runtime selection.',
        }),
      );
    }
  }

  const repositoryDiscovery = await discoverRepositories({
    root: canonicalRoot,
    config,
    machine,
    configPath: workspaceInspection.path,
    options: normalized,
  });
  const documentDiscovery = await discoverDocuments({
    root: canonicalRoot,
    config,
    configPath: workspaceInspection.path,
    repositories: repositoryDiscovery.repositories,
    options: normalized,
  });
  const validationDiscovery = await discoverValidationCandidates({
    root: canonicalRoot,
    config,
    configPath: workspaceInspection.path,
    repositories: repositoryDiscovery.repositories,
  });

  const documents = [...documentDiscovery.documents].sort((left, right) =>
    (left.workspaceRelativePath ?? left.path).localeCompare(
      right.workspaceRelativePath ?? right.path,
    ),
  );

  const boundaries = [
    ...new Set([
      ...repositoryDiscovery.boundaries,
      ...documentDiscovery.boundaries,
    ]),
  ];

  return {
    requestedRoot,
    root: canonicalRoot,
    rootState: 'directory',
    configPath: workspaceInspection.path,
    configState: configState(config, workspaceInspection.exists),
    config,
    machinePath: machineInspection.path,
    machineState: machineState(machine, machineInspection.exists),
    machine,
    repositories: repositoryDiscovery.repositories,
    unresolvedRepositories: repositoryDiscovery.unresolved,
    boundaries,
    documents,
    validationCandidates: validationDiscovery.candidates,
    diagnostics: [
      ...diagnostics,
      ...repositoryDiscovery.diagnostics,
      ...documentDiscovery.diagnostics,
      ...validationDiscovery.diagnostics,
    ],
    truncated: repositoryDiscovery.truncated || documentDiscovery.truncated,
    observedAt: new Date().toISOString(),
  };
}
