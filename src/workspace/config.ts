import { join, resolve } from 'node:path';
import type { Diagnostic } from '../schemas/diagnostics.js';
import { createDiagnostic, pointer } from '../schemas/diagnostics.js';
import { diagnosticCodes } from '../schemas/errors.js';
import {
  MACHINE_SCHEMA,
  machineConfigSchema,
  validateMachineConfigSemantics,
  type MachineConfig,
} from '../schemas/machine.js';
import type { Outcome } from '../schemas/outcome.js';
import { samePath } from '../schemas/paths.js';
import {
  WORKSPACE_SCHEMA,
  validateWorkspaceConfigSemantics,
  workspaceConfigSchema,
  type WorkspaceConfig,
} from '../schemas/workspace.js';
import { resolveRealpath } from '../infra/fs.js';
import {
  inspectConfigFile,
  requireConfig,
  type ConfigFileInspection,
} from './config-file.js';

export interface WorkspaceConfigInspection extends ConfigFileInspection<WorkspaceConfig> {
  readonly root: string;
}

export interface MachineConfigInspection extends ConfigFileInspection<MachineConfig> {
  readonly root: string;
}

export interface InspectWorkspaceConfigOptions {
  /** Missing workspace configuration is fatal by default; discovery may expect it. */
  readonly missing?: 'error' | 'info';
}

async function canonicalRoot(root: string): Promise<string> {
  const absolute = resolve(root);
  return (await resolveRealpath(absolute)) ?? absolute;
}

/**
 * Inspects `.pappra/workspace.json` without changing it. Invalid or unsupported
 * configuration yields `value: null` and structured diagnostics.
 */
export async function inspectWorkspaceConfig(
  root: string,
  options: InspectWorkspaceConfigOptions = {},
): Promise<WorkspaceConfigInspection> {
  const canonical = await canonicalRoot(root);
  const configPath = join(canonical, '.pappra', 'workspace.json');
  const inspection = await inspectConfigFile({
    path: configPath,
    schemaName: WORKSPACE_SCHEMA,
    schema: workspaceConfigSchema,
    containmentRoot: canonical,
    missing: {
      severity: options.missing ?? 'error',
      message: `Workspace configuration not found: ${configPath}`,
      hint: 'Run pappra init in the intended workspace root; Pappra does not guess configuration.',
    },
    semantic: (config) =>
      validateWorkspaceConfigSemantics(config, { configPath }),
  });
  return { root: canonical, ...inspection };
}

/**
 * Inspects `.pappra/local/machine.json`. The local file is allowed to be absent
 * on a fresh clone, but a present invalid or mismatched file is never used.
 */
export async function inspectMachineConfig(
  root: string,
): Promise<MachineConfigInspection> {
  const canonical = await canonicalRoot(root);
  const configPath = join(canonical, '.pappra', 'local', 'machine.json');
  const inspection = await inspectConfigFile({
    path: configPath,
    schemaName: MACHINE_SCHEMA,
    schema: machineConfigSchema,
    containmentRoot: canonical,
    missing: {
      severity: 'info',
      message: `Local machine configuration not found: ${configPath}`,
      hint: 'Pappra init can create machine.json on this checkout; shared workspace.json does not contain absolute paths.',
    },
    semantic: (config) =>
      validateMachineConfigSemantics(config, { configPath }),
  });

  const diagnostics: Diagnostic[] = [...inspection.diagnostics];
  let value = inspection.value;
  if (value !== null) {
    const recorded =
      (await resolveRealpath(value.workspaceRealpath)) ??
      resolve(value.workspaceRealpath);
    if (!samePath(recorded, canonical)) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.machineWorkspaceMismatch,
          severity: 'error',
          message: `machine.json belongs to ${value.workspaceRealpath}, not ${canonical}.`,
          source: configPath,
          pointer: pointer('workspaceRealpath'),
          hint: 'This checkout was moved or copied. Rebind the local mapping explicitly instead of reusing the old identity.',
        }),
      );
      value = null;
    }
  }
  return { root: canonical, ...inspection, value, diagnostics };
}

/** Fails closed when configuration is missing or invalid. */
export async function loadWorkspaceConfig(
  root: string,
  options: InspectWorkspaceConfigOptions = {},
): Promise<Outcome<WorkspaceConfig>> {
  return requireConfig(await inspectWorkspaceConfig(root, options));
}

/** Fails closed when an external mapping or runtime location is required. */
export async function loadMachineConfig(
  root: string,
): Promise<Outcome<MachineConfig>> {
  return requireConfig(await inspectMachineConfig(root));
}
