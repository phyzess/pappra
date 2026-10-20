import { join } from 'node:path';
import type { Diagnostic } from '../schemas/diagnostics.js';
import { createDiagnostic } from '../schemas/diagnostics.js';
import { diagnosticCodes } from '../schemas/errors.js';
import type { MachineConfig } from '../schemas/machine.js';
import type { WorkspaceConfig } from '../schemas/workspace.js';
import {
  inspectMachineConfig,
  inspectWorkspaceConfig,
} from '../workspace/config.js';
import { discoverRepositories } from '../workspace/repositories.js';
import type { DiscoveredRepository } from '../workspace/types.js';
import { observePath } from '../infra/fs.js';

const repositoryDiscoveryOptions = {
  scanDepth: 0,
  maxDirectories: 1,
  maxDocuments: 1,
  maxEntriesPerDirectory: 1,
  gitTimeoutMs: 5_000,
} as const;

export interface KnowledgeContext {
  readonly root: string;
  readonly config: WorkspaceConfig;
  readonly machine: MachineConfig | null;
  readonly configPath: string;
  readonly machinePath: string;
  readonly repositories: readonly DiscoveredRepository[];
  readonly diagnostics: readonly Diagnostic[];
  readonly observedAt: string;
  readonly rootIdentity: { readonly dev: number; readonly ino: number };
}

export interface KnowledgeContextResult {
  readonly ok: boolean;
  readonly context: KnowledgeContext | null;
  readonly diagnostics: readonly Diagnostic[];
}

export async function loadKnowledgeContext(
  inputRoot: string,
): Promise<KnowledgeContextResult> {
  const workspace = await inspectWorkspaceConfig(inputRoot);
  const diagnostics: Diagnostic[] = [...workspace.diagnostics];
  if (workspace.value === null) {
    return { ok: false, context: null, diagnostics };
  }
  const machineInspection = await inspectMachineConfig(workspace.root);
  diagnostics.push(...machineInspection.diagnostics);
  const machine = machineInspection.value;
  const discovered = await discoverRepositories({
    root: workspace.root,
    config: workspace.value,
    machine,
    configPath: workspace.path,
    options: repositoryDiscoveryOptions,
  });
  diagnostics.push(...discovered.diagnostics);
  const rootObservation = await observePath(workspace.root);
  if (rootObservation.stats === null) {
    diagnostics.push(
      createDiagnostic({
        code: diagnosticCodes.document_path_unsafe,
        severity: 'error',
        message: `Cannot observe workspace root identity: ${workspace.root}`,
        source: workspace.root,
        hint: 'Use an existing readable workspace directory.',
      }),
    );
    return { ok: false, context: null, diagnostics };
  }
  const context: KnowledgeContext = {
    root: workspace.root,
    config: workspace.value,
    machine,
    configPath: workspace.path,
    machinePath: join(workspace.root, '.pappra', 'local', 'machine.json'),
    repositories: discovered.repositories,
    diagnostics,
    observedAt: new Date().toISOString(),
    rootIdentity: {
      dev: rootObservation.stats.dev,
      ino: rootObservation.stats.ino,
    },
  };
  return { ok: true, context, diagnostics };
}

export function sameRootIdentity(
  context: KnowledgeContext,
  identity: { readonly dev: number; readonly ino: number },
): boolean {
  return (
    context.rootIdentity.dev === identity.dev &&
    context.rootIdentity.ino === identity.ino
  );
}
