import { z } from 'zod';
import { createDiagnostic, pointer, type Diagnostic } from './diagnostics.js';
import { diagnosticCodes } from './errors.js';
import {
  externalRepositoryId,
  isExternalRepositoryPath,
  isPortableRelativePath,
  normalizePortableRelativePath,
} from './paths.js';
export const WORKSPACE_SCHEMA = 'pappra/workspace/1';

const identifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    'Use a letter or digit followed by letters, digits, dot, underscore or dash.',
  );

const portablePathSchema = z.string().min(1).max(2048);
const executableSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes('\0'), 'NUL is not allowed.');
const argumentSchema = z
  .string()
  .max(4096)
  .refine((value) => !value.includes('\0'), 'NUL is not allowed.');

export const repositoryAccessSchema = z.enum(['read', 'write']);
export const codeGraphSchema = z.enum(['codegraph', 'none']);
export const symbolProviderSchema = z.enum(['auto', 'serena', 'none']);
export const indexPreparationSchema = z.enum(['on-demand', 'manual']);
export const taskVisibilitySchema = z.enum(['private', 'shared']);

export const workspaceRepositorySchema = z.strictObject({
  id: identifierSchema,
  path: portablePathSchema,
  access: repositoryAccessSchema,
});

export const workspaceKnowledgeSchema = z.strictObject({
  sources: z.array(portablePathSchema).max(128),
  newDocuments: portablePathSchema,
  taskVisibility: taskVisibilitySchema,
});

export const workspaceCodeSchema = z.strictObject({
  graph: codeGraphSchema,
  symbols: symbolProviderSchema,
  prepare: indexPreparationSchema,
});

export const workspaceValidationSchema = z.strictObject({
  id: identifierSchema,
  repositoryId: identifierSchema,
  executable: executableSchema,
  args: z.array(argumentSchema).max(256),
});

export const workspaceContinuitySchema = z.strictObject({
  autoResume: z.boolean(),
});

export const workspaceConfigSchema = z.strictObject({
  schema: z.literal(WORKSPACE_SCHEMA),
  workspaceId: z.uuid(),
  name: z.string().min(1).max(200),
  runtimeVersion: z.string().min(1).max(128),
  repositories: z.array(workspaceRepositorySchema).max(128),
  knowledge: workspaceKnowledgeSchema,
  code: workspaceCodeSchema,
  validation: z.array(workspaceValidationSchema).max(128),
  excludes: z.array(portablePathSchema).max(128),
  extensions: z.record(z.string().min(1).max(128), z.unknown()),
  continuity: workspaceContinuitySchema.optional(),
});

export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;
export type WorkspaceRepository = z.infer<typeof workspaceRepositorySchema>;
export type WorkspaceValidation = z.infer<typeof workspaceValidationSchema>;
export type RepositoryAccess = z.infer<typeof repositoryAccessSchema>;

export interface WorkspaceConfigSemanticOptions {
  readonly configPath: string;
}

function pathDiagnostic(
  value: string,
  source: string,
  fieldPointer: string,
  label: string,
): Diagnostic | null {
  const hint = 'Use a workspace-relative path such as "docs" or "repos/app".';
  if (value.includes('\0') || value.includes('\\')) {
    return createDiagnostic({
      code: diagnosticCodes.configPathInvalid,
      severity: 'error',
      message: `${label} must use forward slashes and must not contain NUL or backslashes.`,
      source,
      pointer: fieldPointer,
      hint,
    });
  }
  if (
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value) ||
    value.startsWith('\\\\')
  ) {
    return createDiagnostic({
      code: diagnosticCodes.configPathAbsolute,
      severity: 'error',
      message: `${label} must be relative to the workspace root, not absolute.`,
      source,
      pointer: fieldPointer,
      hint,
    });
  }
  if (!isPortableRelativePath(value)) {
    return createDiagnostic({
      code: diagnosticCodes.configPathEscapesRoot,
      severity: 'error',
      message: `${label} escapes the workspace root.`,
      source,
      pointer: fieldPointer,
      hint,
    });
  }
  return null;
}

/**
 * Applies rules that cannot be expressed by the structural schema alone.
 * The caller must only use the value when no returned diagnostic is an error.
 */
export function validateWorkspaceConfigSemantics(
  config: WorkspaceConfig,
  options: WorkspaceConfigSemanticOptions,
): readonly Diagnostic[] {
  const { configPath } = options;
  const diagnostics: Diagnostic[] = [];
  const repositoryIds = new Map<string, number>();
  const validationIds = new Map<string, number>();

  config.repositories.forEach((repository, index) => {
    const first = repositoryIds.get(repository.id);
    if (first !== undefined) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.configDuplicateRepositoryId,
          severity: 'error',
          message: `Repository id "${repository.id}" is already used by repositories[${first}].`,
          source: configPath,
          pointer: pointer('repositories', index, 'id'),
          hint: 'Give every repository a unique id within the workspace.',
        }),
      );
    } else {
      repositoryIds.set(repository.id, index);
    }

    if (isExternalRepositoryPath(repository.path)) {
      if (externalRepositoryId(repository.path) === null) {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.configPathInvalid,
            severity: 'error',
            message: `Repository path "${repository.path}" is not a valid external:<id> reference.`,
            source: configPath,
            pointer: pointer('repositories', index, 'path'),
            hint: 'Use external:<logical-id> and declare the absolute location in .pappra/local/machine.json.',
          }),
        );
      }
    } else {
      const pathIssue = pathDiagnostic(
        repository.path,
        configPath,
        pointer('repositories', index, 'path'),
        `Repository "${repository.id}" path`,
      );
      if (pathIssue !== null) diagnostics.push(pathIssue);
    }
  });

  config.validation.forEach((validation, index) => {
    const first = validationIds.get(validation.id);
    if (first !== undefined) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.configDuplicateValidationId,
          severity: 'error',
          message: `Validation id "${validation.id}" is already used by validation[${first}].`,
          source: configPath,
          pointer: pointer('validation', index, 'id'),
          hint: 'Give every validation command a unique id.',
        }),
      );
    } else {
      validationIds.set(validation.id, index);
    }
    if (!repositoryIds.has(validation.repositoryId)) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.configUnknownRepository,
          severity: 'error',
          message: `Validation "${validation.id}" refers to unknown repository "${validation.repositoryId}".`,
          source: configPath,
          pointer: pointer('validation', index, 'repositoryId'),
          hint: 'Declare the repository first or correct the repositoryId.',
        }),
      );
    }
  });

  config.knowledge.sources.forEach((source, index) => {
    const pathIssue = pathDiagnostic(
      source,
      configPath,
      pointer('knowledge', 'sources', index),
      'Knowledge source',
    );
    if (pathIssue !== null) diagnostics.push(pathIssue);
    if (isExternalRepositoryPath(source)) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.configPathInvalid,
          severity: 'error',
          message:
            'Knowledge sources must stay inside the workspace; external: references are only valid for repositories.',
          source: configPath,
          pointer: pointer('knowledge', 'sources', index),
          hint: 'Copy no external knowledge; declare an external repository and read its documentation in place.',
        }),
      );
    }
  });

  const newDocumentsIssue = pathDiagnostic(
    config.knowledge.newDocuments,
    configPath,
    pointer('knowledge', 'newDocuments'),
    'New document directory',
  );
  if (newDocumentsIssue !== null) diagnostics.push(newDocumentsIssue);

  config.excludes.forEach((exclude, index) => {
    const pathIssue = pathDiagnostic(
      exclude,
      configPath,
      pointer('excludes', index),
      'Exclude entry',
    );
    if (pathIssue !== null) diagnostics.push(pathIssue);
    if (/[*?[\]{}]/.test(exclude)) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.configGlobNotSupported,
          severity: 'error',
          message: `Exclude entry "${exclude}" contains glob metacharacters.`,
          source: configPath,
          pointer: pointer('excludes', index),
          hint: 'Use literal workspace-relative file or directory prefixes; glob expansion is not part of schema version 1.',
        }),
      );
    }
  });

  return diagnostics;
}

/** Normalizes config-declared excludes for prefix comparisons. */
export function normalizedExcludes(config: WorkspaceConfig): readonly string[] {
  return config.excludes.map((entry) => normalizePortableRelativePath(entry));
}
