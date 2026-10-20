import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { createDiagnostic, pointer, type Diagnostic } from './diagnostics.js';
import { diagnosticCodes } from './errors.js';

export const MACHINE_SCHEMA = 'pappra/machine/1';

const identifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const hostSchema = z.enum(['pi', 'codex', 'claude']);

export const externalRepositoryMappingSchema = z.strictObject({
  id: identifierSchema,
  path: z.string().min(1).max(4096),
});

export const runtimeLocationSchema = z.strictObject({
  version: z.string().min(1).max(128),
  executable: z.string().min(1).max(4096),
  verifiedAt: z.iso.datetime({ offset: true }),
});

export const machineConfigSchema = z.strictObject({
  schema: z.literal(MACHINE_SCHEMA),
  workspaceRealpath: z.string().min(1).max(4096),
  checkoutId: z.uuid(),
  externalRepositories: z.array(externalRepositoryMappingSchema).max(128),
  selectedHosts: z.array(hostSchema).max(16),
  runtime: runtimeLocationSchema.nullable(),
});

export type MachineConfig = z.infer<typeof machineConfigSchema>;
export type ExternalRepositoryMapping = z.infer<
  typeof externalRepositoryMappingSchema
>;
export type RuntimeLocation = z.infer<typeof runtimeLocationSchema>;

export interface MachineConfigSemanticOptions {
  readonly configPath: string;
}

export function validateMachineConfigSemantics(
  config: MachineConfig,
  options: MachineConfigSemanticOptions,
): readonly Diagnostic[] {
  const { configPath } = options;
  const diagnostics: Diagnostic[] = [];
  const externalIds = new Map<string, number>();

  if (!isAbsolute(config.workspaceRealpath)) {
    diagnostics.push(
      createDiagnostic({
        code: diagnosticCodes.configPathAbsolute,
        severity: 'error',
        message: 'workspaceRealpath must be an absolute host path.',
        source: configPath,
        pointer: pointer('workspaceRealpath'),
        hint: 'Write the real path of this checkout; machine.json is not shared across machines.',
      }),
    );
  }

  config.externalRepositories.forEach((mapping, index) => {
    const first = externalIds.get(mapping.id);
    if (first !== undefined) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.machineExternalDuplicate,
          severity: 'error',
          message: `External repository id "${mapping.id}" is already mapped by externalRepositories[${first}].`,
          source: configPath,
          pointer: pointer('externalRepositories', index, 'id'),
          hint: 'Keep exactly one local mapping per logical external repository id.',
        }),
      );
    } else {
      externalIds.set(mapping.id, index);
    }
    if (!isAbsolute(mapping.path) || mapping.path.includes('\0')) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.machineExternalPathInvalid,
          severity: 'error',
          message: `External repository "${mapping.id}" must map to an absolute host path.`,
          source: configPath,
          pointer: pointer('externalRepositories', index, 'path'),
          hint: 'Shared workspace.json stores only external:<id>; the absolute path stays in local machine.json.',
        }),
      );
    }
  });

  const seenHosts = new Set<string>();
  for (const [index, host] of config.selectedHosts.entries()) {
    if (seenHosts.has(host)) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.configSchemaInvalid,
          severity: 'warning',
          message: `Host "${host}" is selected more than once.`,
          source: configPath,
          pointer: pointer('selectedHosts', index),
          hint: 'Remove the duplicate host entry.',
        }),
      );
    }
    seenHosts.add(host);
  }

  if (config.runtime !== null) {
    if (!isAbsolute(config.runtime.executable)) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.configPathAbsolute,
          severity: 'error',
          message:
            'The verified runtime executable must be an absolute host path.',
          source: configPath,
          pointer: pointer('runtime', 'executable'),
          hint: 'Record the fixed runtime path created by the installer.',
        }),
      );
    }
  }

  return diagnostics;
}
