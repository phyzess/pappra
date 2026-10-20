import { join, resolve } from 'node:path';
import type { z } from 'zod';
import type { Diagnostic, DiagnosticSeverity } from '../schemas/diagnostics.js';
import {
  createDiagnostic,
  hasErrors,
  pointer,
} from '../schemas/diagnostics.js';
import { diagnosticCodes } from '../schemas/errors.js';
import { errorMessage, type Outcome } from '../schemas/outcome.js';
import { isPathInside } from '../schemas/paths.js';
import {
  DEFAULT_CONFIG_MAX_BYTES,
  observePath,
  readTextFileBounded,
  resolveRealpath,
} from '../infra/fs.js';

export interface ConfigFileInspection<T> {
  /** The path the caller asked to inspect (not silently replaced by a symlink target). */
  readonly path: string;
  readonly exists: boolean;
  readonly digest: string | null;
  readonly size: number | null;
  readonly value: T | null;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ConfigFileMissingPolicy {
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly hint: string;
}

export interface InspectConfigFileOptions<T> {
  readonly path: string;
  readonly schemaName: string;
  readonly schema: z.ZodType<T>;
  readonly missing: ConfigFileMissingPolicy;
  /** When set, the real path of the file must stay inside this real directory. */
  readonly containmentRoot?: string;
  readonly maxBytes?: number;
  readonly semantic?: (value: T) => readonly Diagnostic[];
}

function issuePointer(path: readonly PropertyKey[]): string {
  return pointer(...path.map((segment) => String(segment)));
}

function issueDiagnostics(
  issues: readonly z.core.$ZodIssue[],
  source: string,
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') {
      const base = issuePointer(issue.path);
      for (const key of issue.keys) {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.configUnknownKey,
            severity: 'error',
            message: `Unknown key "${key}".`,
            source,
            pointer: `${base}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`,
            hint: 'Remove the key or declare intentional extension data under the existing "extensions" field. A new top-level field requires a schema version change.',
          }),
        );
      }
      continue;
    }
    diagnostics.push(
      createDiagnostic({
        code: diagnosticCodes.configSchemaInvalid,
        severity: 'error',
        message: issue.message,
        source,
        pointer: issue.path.length === 0 ? '' : issuePointer(issue.path),
        hint: 'Correct the value; Pappra does not coerce or silently ignore configuration.',
      }),
    );
  }
  return diagnostics;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads, decodes, validates, and semantically checks one strict JSON
 * configuration file. Missing configuration is reported instead of defaulted.
 */
export async function inspectConfigFile<T>(
  options: InspectConfigFileOptions<T>,
): Promise<ConfigFileInspection<T>> {
  const source = options.path;
  let observation;
  try {
    observation = await observePath(options.path);
  } catch (error) {
    return {
      path: options.path,
      exists: true,
      digest: null,
      size: null,
      value: null,
      diagnostics: [
        createDiagnostic({
          code: diagnosticCodes.fileUnreadable,
          severity: 'error',
          message: `Cannot inspect ${options.path}: ${errorMessage(error)}`,
          source,
          hint: 'Check file permissions and the path.',
        }),
      ],
    };
  }
  if (observation.kind === 'missing') {
    return {
      path: options.path,
      exists: false,
      digest: null,
      size: null,
      value: null,
      diagnostics: [
        createDiagnostic({
          code: diagnosticCodes.configMissing,
          severity: options.missing.severity,
          message: options.missing.message,
          source,
          hint: options.missing.hint,
        }),
      ],
    };
  }

  const realPath = await resolveRealpath(options.path);
  if (
    realPath !== null &&
    options.containmentRoot !== undefined &&
    !isPathInside(options.containmentRoot, realPath)
  ) {
    return {
      path: options.path,
      exists: true,
      digest: null,
      size: null,
      value: null,
      diagnostics: [
        createDiagnostic({
          code: diagnosticCodes.configSymlinkEscape,
          severity: 'error',
          message: `Configuration file resolves outside the workspace: ${realPath}`,
          source,
          hint: 'Keep the configuration inside .pappra/; external symlinks are not followed.',
        }),
      ],
    };
  }

  const read = await readTextFileBounded(
    options.path,
    options.maxBytes ?? DEFAULT_CONFIG_MAX_BYTES,
  );
  if (!read.ok) {
    return {
      path: options.path,
      exists: true,
      digest: null,
      size: null,
      value: null,
      diagnostics: [
        createDiagnostic({
          code: read.code,
          severity: 'error',
          message: read.message,
          source,
          hint: read.nextAction,
        }),
      ],
    };
  }
  const { digest, size, text } = read.value;
  if (text.startsWith('\uFEFF')) {
    return {
      path: options.path,
      exists: true,
      digest,
      size,
      value: null,
      diagnostics: [
        createDiagnostic({
          code: diagnosticCodes.configInvalidJson,
          severity: 'error',
          message: 'Configuration starts with a UTF-8 BOM.',
          source,
          hint: 'Remove the BOM; Pappra does not rewrite configuration during inspection.',
        }),
      ],
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      path: options.path,
      exists: true,
      digest,
      size,
      value: null,
      diagnostics: [
        createDiagnostic({
          code: diagnosticCodes.configInvalidJson,
          severity: 'error',
          message: `Invalid JSON: ${errorMessage(error)}`,
          source,
          hint: 'Fix the JSON syntax; the original file was not modified.',
        }),
      ],
    };
  }

  if (
    isRecord(raw) &&
    typeof raw['schema'] === 'string' &&
    raw['schema'] !== options.schemaName
  ) {
    return {
      path: options.path,
      exists: true,
      digest,
      size,
      value: null,
      diagnostics: [
        createDiagnostic({
          code: diagnosticCodes.configUnsupportedSchema,
          severity: 'error',
          message: `Unsupported schema "${raw['schema']}"; this version reads only "${options.schemaName}".`,
          source,
          pointer: pointer('schema'),
          hint: 'Pappra will not migrate, overwrite, or partially interpret this file. Keep it and use a compatible Pappra version.',
        }),
      ],
    };
  }

  const parsed = options.schema.safeParse(raw);
  if (!parsed.success) {
    return {
      path: options.path,
      exists: true,
      digest,
      size,
      value: null,
      diagnostics: issueDiagnostics(parsed.error.issues, source),
    };
  }

  const diagnostics = options.semantic?.(parsed.data) ?? [];
  return {
    path: options.path,
    exists: true,
    digest,
    size,
    value: hasErrors(diagnostics) ? null : parsed.data,
    diagnostics,
  };
}

/** Converts an inspection into a convenience result for callers that fail closed. */
export function requireConfig<T>(
  inspection: ConfigFileInspection<T>,
): Outcome<T> {
  if (inspection.value !== null) {
    return { ok: true, value: inspection.value };
  }
  const firstError =
    inspection.diagnostics.find((entry) => entry.severity === 'error') ??
    inspection.diagnostics[0];
  if (firstError === undefined) {
    return {
      ok: false,
      code: diagnosticCodes.configSchemaInvalid,
      message: `Configuration is unavailable: ${inspection.path}`,
      retryable: false,
      nextAction: 'Run pappra doctor after correcting the configuration.',
    };
  }
  return {
    ok: false,
    code: firstError.code,
    message: firstError.message,
    retryable: false,
    nextAction: firstError.hint,
  };
}

/** Joins a workspace-relative configuration path without normalizing above root. */
export function workspaceConfigPath(root: string): string {
  return join(resolve(root), '.pappra', 'workspace.json');
}
