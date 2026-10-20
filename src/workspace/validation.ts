import { join } from 'node:path';
import { z } from 'zod';
import type { Diagnostic } from '../schemas/diagnostics.js';
import { createDiagnostic, pointer } from '../schemas/diagnostics.js';
import { diagnosticCodes } from '../schemas/errors.js';
import type { WorkspaceConfig } from '../schemas/workspace.js';
import { observePath, readTextFileBounded } from '../infra/fs.js';
import type { DiscoveredRepository, ValidationCandidate } from './types.js';

export interface ValidationDiscoveryInput {
  readonly root: string;
  readonly config: WorkspaceConfig | null;
  readonly configPath: string;
  readonly repositories: readonly DiscoveredRepository[];
}

export interface ValidationDiscoveryOutput {
  readonly candidates: readonly ValidationCandidate[];
  readonly diagnostics: readonly Diagnostic[];
}

const packageManifestSchema = z.object({
  packageManager: z.string().min(1).max(128).optional(),
  scripts: z.record(z.string(), z.string()).optional(),
});

const knownRunners = new Set(['pnpm', 'npm', 'yarn', 'bun']);
const validationScriptPattern =
  /^(?:test|lint|typecheck|check|verify|validate)(?::|$)/;

type PackageRunner = {
  readonly name: string;
  readonly source: 'declared' | 'lockfile' | 'fallback';
} | null;

function declaredRunner(
  packageManager: string | undefined,
): PackageRunner | 'unsupported' {
  if (packageManager === undefined) return null;
  const name = packageManager.split('@')[0] ?? '';
  if (!knownRunners.has(name)) return 'unsupported';
  return { name, source: 'declared' };
}

async function detectRunner(
  directory: string,
  packageManager: string | undefined,
  diagnostics: Diagnostic[],
  manifestPath: string,
): Promise<PackageRunner> {
  const declared = declaredRunner(packageManager);
  if (declared === 'unsupported') {
    diagnostics.push(
      createDiagnostic({
        code: diagnosticCodes.validationRunnerUnsupported,
        severity: 'warning',
        message: `Declared package manager "${packageManager}" is not supported for validation candidates.`,
        source: manifestPath,
        pointer: pointer('packageManager'),
        hint: 'Pappra reports no package-script candidates instead of guessing a different runner.',
      }),
    );
    return null;
  }
  if (declared !== null) return declared;

  const candidates: readonly (readonly [string, string])[] = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['pnpm-workspace.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ];
  const found: string[] = [];
  for (const [file, runner] of candidates) {
    const observation = await observePath(join(directory, file));
    if (observation.kind === 'file' && !found.includes(runner)) {
      found.push(runner);
    }
  }
  if (found.length > 1) {
    diagnostics.push(
      createDiagnostic({
        code: diagnosticCodes.validationRunnerAmbiguous,
        severity: 'warning',
        message: `Multiple package-manager lockfiles were found: ${found.join(', ')}.`,
        source: manifestPath,
        hint: `Discovery used ${found[0] ?? 'npm'} without executing any script; declare packageManager to remove the ambiguity.`,
      }),
    );
  }
  const selected = found[0];
  return selected === undefined
    ? { name: 'npm', source: 'fallback' }
    : { name: selected, source: 'lockfile' };
}

/**
 * Reports validation commands declared in workspace.json and package.json.
 * Nothing is resolved on PATH or executed.
 */
export async function discoverValidationCandidates(
  input: ValidationDiscoveryInput,
): Promise<ValidationDiscoveryOutput> {
  const { root, config, configPath, repositories } = input;
  const candidates: ValidationCandidate[] = [];
  const diagnostics: Diagnostic[] = [];

  if (config !== null) {
    for (const [index, validation] of config.validation.entries()) {
      const repository = repositories.find(
        (item) => item.id === validation.repositoryId,
      );
      if (repository === undefined) {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.validationCandidateUnbound,
            severity: 'warning',
            message: `Validation "${validation.id}" is declared for repository "${validation.repositoryId}", but that checkout was not discovered.`,
            source: configPath,
            pointer: pointer('validation', index, 'repositoryId'),
            hint: 'Fix the repository path or mapping before treating this command as runnable.',
          }),
        );
      }
      candidates.push({
        id: `workspace-config:${validation.id}`,
        origin: 'workspace-config',
        repositoryId: validation.repositoryId,
        repositoryAccess: repository?.access ?? null,
        executable: validation.executable,
        args: validation.args,
        workingDirectory: repository?.root ?? null,
        declaredBy: `${configPath}#${pointer('validation', index)}`,
        runnerSource: 'workspace-config',
        verification: 'not-verified',
      });
    }
  }

  const manifestDirectories = new Map<string, DiscoveredRepository | null>();
  for (const repository of repositories) {
    manifestDirectories.set(repository.root, repository);
  }
  if (!manifestDirectories.has(root)) {
    manifestDirectories.set(root, null);
  }

  for (const [directory, repository] of manifestDirectories) {
    const manifestPath = join(directory, 'package.json');
    const observation = await observePath(manifestPath);
    if (observation.kind === 'missing') continue;
    if (observation.kind !== 'file') {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.packageManifestInvalid,
          severity: 'warning',
          message: `package.json is not a regular file: ${manifestPath}`,
          source: manifestPath,
          hint: 'Discovery skips this manifest and executes nothing.',
        }),
      );
      continue;
    }
    const read = await readTextFileBounded(manifestPath, 1024 * 1024);
    if (!read.ok) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.packageManifestInvalid,
          severity: 'warning',
          message: `Cannot read package.json: ${read.message}`,
          source: manifestPath,
          hint: 'Fix the manifest or permissions; no scripts were executed.',
        }),
      );
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(read.value.text);
    } catch (error) {
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.packageManifestInvalid,
          severity: 'warning',
          message: `Invalid package.json: ${error instanceof Error ? error.message : String(error)}`,
          source: manifestPath,
          hint: 'Fix the manifest; discovery did not execute or rewrite it.',
        }),
      );
      continue;
    }
    const parsed = packageManifestSchema.safeParse(raw);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      diagnostics.push(
        createDiagnostic({
          code: diagnosticCodes.packageManifestInvalid,
          severity: 'warning',
          message: `package.json has an unexpected shape: ${firstIssue?.message ?? 'validation failed'}`,
          source: manifestPath,
          pointer:
            firstIssue === undefined
              ? null
              : pointer(...firstIssue.path.map((item) => String(item))),
          hint: 'Discovery skipped this manifest; no scripts were executed.',
        }),
      );
      continue;
    }
    const scripts = parsed.data.scripts;
    if (scripts === undefined) continue;
    const runner = await detectRunner(
      directory,
      parsed.data.packageManager,
      diagnostics,
      manifestPath,
    );
    if (runner === null) continue;

    const scriptNames = Object.keys(scripts)
      .filter((name) => validationScriptPattern.test(name))
      .sort((left, right) => left.localeCompare(right));
    for (const name of scriptNames) {
      if (candidates.length >= 256) {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.discoveryLimitReached,
            severity: 'warning',
            message: 'Validation candidate list reached its 256-entry bound.',
            source: manifestPath,
            hint: 'Declare only the validation commands needed for this workspace.',
          }),
        );
        break;
      }
      const scope = repository?.id ?? repository?.relativePath ?? 'workspace';
      candidates.push({
        id: `package-script:${scope}:${name}`,
        origin: 'package-script',
        repositoryId: repository?.id ?? null,
        repositoryAccess: repository?.access ?? null,
        executable: runner.name,
        args: ['run', name],
        workingDirectory: directory,
        declaredBy: `${manifestPath}#${pointer('scripts', name)}`,
        runnerSource: runner.source,
        verification: 'not-verified',
      });
    }
  }

  return { candidates, diagnostics };
}
