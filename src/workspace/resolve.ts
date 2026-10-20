import { dirname, join, resolve } from 'node:path';
import type { Diagnostic } from '../schemas/diagnostics.js';
import { createDiagnostic } from '../schemas/diagnostics.js';
import { diagnosticCodes } from '../schemas/errors.js';
import { isPathInside } from '../schemas/paths.js';
import { observePath, resolveRealpath } from '../infra/fs.js';

export type WorkspaceRootState =
  'registered' | 'missing' | 'incomplete' | 'unavailable';

export interface ResolveWorkspaceRootOptions {
  readonly startPath?: string;
}

export interface WorkspaceRootResolution {
  readonly requestedPath: string;
  readonly startDirectory: string | null;
  readonly state: WorkspaceRootState;
  /** The nearest directory containing an explicit `.pappra/workspace.json`. */
  readonly root: string | null;
  readonly configPath: string | null;
  readonly diagnostics: readonly Diagnostic[];
}

/** Directory-container check that also accepts a symlinked .pappra inside root. */
async function usablePappraDirectory(
  root: string,
  path: string,
): Promise<boolean> {
  const real = await resolveRealpath(path);
  return real !== null && isPathInside(root, real);
}

/**
 * Walks from an explicit start path (default cwd) to the filesystem root and
 * returns the nearest registered workspace. It only probes `.pappra` markers,
 * never scans home or unrelated project content.
 *
 * A `.pappra` directory without workspace.json stops the walk: a partial
 * registration is reported instead of silently falling back to an outer
 * workspace.
 */
export async function resolveWorkspaceRoot(
  options: ResolveWorkspaceRootOptions = {},
): Promise<WorkspaceRootResolution> {
  const requestedPath = options.startPath ?? process.cwd();
  const absolute = resolve(requestedPath);
  const diagnostics: Diagnostic[] = [];

  let observation;
  try {
    observation = await observePath(absolute);
  } catch (error) {
    diagnostics.push(
      createDiagnostic({
        code: diagnosticCodes.workspaceStartInvalid,
        severity: 'error',
        message: `Cannot inspect the workspace start path: ${absolute} (${error instanceof Error ? error.message : String(error)})`,
        source: absolute,
        hint: 'Pass an existing directory path.',
      }),
    );
    return {
      requestedPath,
      startDirectory: null,
      state: 'unavailable',
      root: null,
      configPath: null,
      diagnostics,
    };
  }

  if (observation.kind === 'missing') {
    diagnostics.push(
      createDiagnostic({
        code: diagnosticCodes.workspaceStartInvalid,
        severity: 'error',
        message: `Workspace start path does not exist: ${absolute}`,
        source: absolute,
        hint: 'Pass an existing directory path.',
      }),
    );
    return {
      requestedPath,
      startDirectory: null,
      state: 'unavailable',
      root: null,
      configPath: null,
      diagnostics,
    };
  }

  if (observation.kind === 'other') {
    diagnostics.push(
      createDiagnostic({
        code: diagnosticCodes.workspaceStartInvalid,
        severity: 'error',
        message: `Workspace start path is not a directory or regular file: ${absolute}`,
        source: absolute,
        hint: 'Pass an existing directory path.',
      }),
    );
    return {
      requestedPath,
      startDirectory: null,
      state: 'unavailable',
      root: null,
      configPath: null,
      diagnostics,
    };
  }

  let directoryCandidate = absolute;
  if (observation.kind === 'file') {
    directoryCandidate = dirname(absolute);
  } else if (observation.kind === 'symlink') {
    const target = await resolveRealpath(absolute);
    const targetObservation =
      target === null ? null : await observePath(target);
    if (target === null || targetObservation === null) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.workspaceStartInvalid,
          severity: 'error',
          message: `Cannot resolve the symlinked workspace start path: ${absolute}`,
          source: absolute,
          hint: 'Pass an existing readable directory path.',
        }),
      );
      return {
        requestedPath,
        startDirectory: null,
        state: 'unavailable',
        root: null,
        configPath: null,
        diagnostics,
      };
    }
    directoryCandidate =
      targetObservation.kind === 'file' ? dirname(target) : target;
  }
  const startDirectory = await resolveRealpath(directoryCandidate);
  if (startDirectory === null) {
    diagnostics.push(
      createDiagnostic({
        code: diagnosticCodes.workspaceStartInvalid,
        severity: 'error',
        message: `Cannot resolve the workspace start path: ${absolute}`,
        source: absolute,
        hint: 'Pass an existing readable directory path.',
      }),
    );
    return {
      requestedPath,
      startDirectory: null,
      state: 'unavailable',
      root: null,
      configPath: null,
      diagnostics,
    };
  }

  for (let directory = startDirectory; ; directory = dirname(directory)) {
    const pappraPath = join(directory, '.pappra');
    const pappraObservation = await observePath(pappraPath);
    if (pappraObservation.kind !== 'missing') {
      const usable =
        pappraObservation.kind === 'directory' ||
        (pappraObservation.kind === 'symlink' &&
          (await usablePappraDirectory(directory, pappraPath)));
      if (!usable) {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.workspaceRegistrationIncomplete,
            severity: 'error',
            message: `Found ${pappraPath}, but it is not a usable .pappra directory inside the workspace.`,
            source: pappraPath,
            hint: 'Repair or remove the marker explicitly; Pappra does not fall back to an outer workspace.',
          }),
        );
        return {
          requestedPath,
          startDirectory,
          state: 'incomplete',
          root: directory,
          configPath: null,
          diagnostics,
        };
      }

      const configPath = join(pappraPath, 'workspace.json');
      const configObservation = await observePath(configPath);
      if (configObservation.kind === 'missing') {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.workspaceRegistrationIncomplete,
            severity: 'error',
            message: `Workspace marker is incomplete: ${configPath} is missing.`,
            source: pappraPath,
            hint: 'Run pappra init or restore workspace.json. Pappra does not silently use an outer workspace.',
          }),
        );
        return {
          requestedPath,
          startDirectory,
          state: 'incomplete',
          root: directory,
          configPath: null,
          diagnostics,
        };
      }

      const configRealpath = await resolveRealpath(configPath);
      if (configObservation.kind === 'symlink' && configRealpath === null) {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.workspaceRegistrationIncomplete,
            severity: 'error',
            message: `workspace.json is a broken symlink: ${configPath}`,
            source: configPath,
            hint: 'Restore a readable regular workspace.json; Pappra does not follow broken links.',
          }),
        );
        return {
          requestedPath,
          startDirectory,
          state: 'incomplete',
          root: directory,
          configPath: null,
          diagnostics,
        };
      }
      if (configRealpath !== null && !isPathInside(directory, configRealpath)) {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.configSymlinkEscape,
            severity: 'error',
            message: `workspace.json resolves outside the workspace: ${configRealpath}`,
            source: configPath,
            hint: 'Keep configuration inside this workspace; external symlinks are not followed.',
          }),
        );
        return {
          requestedPath,
          startDirectory,
          state: 'incomplete',
          root: directory,
          configPath: null,
          diagnostics,
        };
      }
      if (configObservation.kind === 'symlink' && configRealpath !== null) {
        const targetObservation = await observePath(configRealpath);
        if (targetObservation.kind !== 'file') {
          diagnostics.push(
            createDiagnostic({
              code: diagnosticCodes.workspaceRegistrationIncomplete,
              severity: 'error',
              message: `workspace.json symlink does not resolve to a regular file: ${configPath}`,
              source: configPath,
              hint: 'Replace it with a readable regular file; Pappra does not guess configuration.',
            }),
          );
          return {
            requestedPath,
            startDirectory,
            state: 'incomplete',
            root: directory,
            configPath: null,
            diagnostics,
          };
        }
      }
      if (
        configObservation.kind !== 'file' &&
        configObservation.kind !== 'symlink'
      ) {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.workspaceRegistrationIncomplete,
            severity: 'error',
            message: `workspace.json is not a regular file: ${configPath}`,
            source: configPath,
            hint: 'Replace it with a regular JSON file; Pappra does not guess configuration.',
          }),
        );
        return {
          requestedPath,
          startDirectory,
          state: 'incomplete',
          root: directory,
          configPath: null,
          diagnostics,
        };
      }

      return {
        requestedPath,
        startDirectory,
        state: 'registered',
        root: directory,
        configPath,
        diagnostics,
      };
    }

    const parent = dirname(directory);
    if (parent === directory) break;
  }

  diagnostics.push(
    createDiagnostic({
      code: diagnosticCodes.workspaceNotFound,
      severity: 'info',
      message: `No registered Pappra workspace found above ${startDirectory}.`,
      source: startDirectory,
      hint: 'Provide an explicit workspace root or run pappra init. Pappra does not scan the home directory for workspaces.',
    }),
  );
  return {
    requestedPath,
    startDirectory,
    state: 'missing',
    root: null,
    configPath: null,
    diagnostics,
  };
}
