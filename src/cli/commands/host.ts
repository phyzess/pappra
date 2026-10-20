import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { HostName } from '../../schemas/host.js';
import { HostIntegrationService } from '../../hosts/integration/service.js';
import type { CliOutput } from '../output.js';

export const hostUsage =
  'pappra host <detect|describe|plan|install|verify> --host <pi|codex|claude>\n' +
  '  [--host-root <dir>] [--host-version <version>] [--apply] [--json]';

export interface HostCommandOptions {
  readonly cwd: string;
  readonly json: boolean;
  readonly action: 'detect' | 'describe' | 'plan' | 'install' | 'verify' | null;
  readonly host: HostName | null;
  readonly hostRoot: string | null;
  readonly hostVersion: string | null;
  readonly apply: boolean;
}

function printDiagnostics(
  output: CliOutput,
  diagnostics: readonly unknown[],
): void {
  for (const entry of diagnostics) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      'message' in entry &&
      typeof entry.message === 'string'
    ) {
      if ('hint' in entry && typeof entry.hint === 'string') {
        output.stderr(`${entry.message} Hint: ${entry.hint}\n`);
      } else {
        output.stderr(`${entry.message}\n`);
      }
    }
  }
}

function diagnosticStatus(status: string): number {
  return status === 'planned' ||
    status === 'applied' ||
    status === 'unchanged' ||
    status === 'verified' ||
    status === 'duplicate'
    ? 0
    : 1;
}

export async function runHostCommand(
  options: HostCommandOptions,
  output: CliOutput,
): Promise<number> {
  if (options.action === null || options.host === null) {
    output.stderr('pappra: host requires an action and --host.\n');
    return 2;
  }
  const service = new HostIntegrationService({
    root: options.cwd,
    homeDir: homedir(),
    pathEnv: process.env.PATH ?? '',
    hostVersion: options.hostVersion,
    observedAt: new Date().toISOString(),
  });
  const hostRoot =
    options.hostRoot === null
      ? undefined
      : resolve(options.cwd, options.hostRoot);
  const target = {
    ...(hostRoot === undefined ? {} : { hostRoot }),
    ...(options.hostVersion === null
      ? {}
      : { hostVersion: options.hostVersion }),
  };

  if (options.action === 'detect' || options.action === 'describe') {
    const capabilities = service.describe(options.host);
    if (options.json) {
      output.stdout(`${JSON.stringify(capabilities)}\n`);
    } else {
      output.stdout(
        `Host: ${capabilities.host} ${capabilities.version ?? '(unknown)'}\n`,
      );
      output.stdout(`Surface: ${capabilities.surface}\n`);
      output.stdout(
        `Executable: ${capabilities.executablePath ?? 'missing'}\n`,
      );
      output.stdout(
        `Reload required: ${capabilities.reloadRequired ? 'yes' : 'no'}\n`,
      );
      output.stdout(
        `Trust required: ${capabilities.trustRequired ? 'yes' : 'no'}\n`,
      );
      for (const capability of capabilities.capabilities) {
        output.stdout(
          `  ${capability.event}: ${capability.state}${capability.nativeEvent === null ? '' : ` (${capability.nativeEvent})`}\n`,
        );
      }
    }
    return 0;
  }

  if (options.action === 'plan') {
    try {
      const plan = await service.plan(options.host, target);
      if (options.json) {
        output.stdout(`${JSON.stringify(plan)}\n`);
      } else {
        output.stdout(`Host: ${plan.host} @ ${plan.hostRoot}\n`);
        output.stdout(`Bundle: ${plan.bundleDigest}\n`);
        for (const file of plan.files) {
          output.stdout(`  ${file.operation} ${file.path}\n`);
        }
        printDiagnostics(output, plan.diagnostics);
      }
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.json) {
        output.stdout(
          `${JSON.stringify({ ok: false, command: 'host', code: 'host_plan_failed', message })}\n`,
        );
      } else {
        output.stderr(`pappra host: ${message}\n`);
      }
      return 1;
    }
  }

  if (options.action === 'install') {
    const result = await service.install(options.host, {
      ...target,
      apply: options.apply,
    });
    if (options.json) {
      output.stdout(`${JSON.stringify(result)}\n`);
    } else {
      output.stdout(`Status: ${result.status}\n`);
      for (const file of result.appliedFiles)
        output.stdout(`  applied ${file}\n`);
      for (const path of result.residualPaths)
        output.stdout(`  residual ${path}\n`);
      printDiagnostics(output, result.diagnostics);
    }
    return diagnosticStatus(result.status);
  }

  const result = await service.verify(options.host, target);
  if (options.json) {
    output.stdout(`${JSON.stringify(result)}\n`);
  } else {
    output.stdout(`Status: ${result.status}\n`);
    for (const check of result.checks) {
      output.stdout(`  [${check.status}] ${check.id}: ${check.detail}\n`);
    }
    printDiagnostics(output, result.diagnostics);
  }
  return diagnosticStatus(result.status);
}
