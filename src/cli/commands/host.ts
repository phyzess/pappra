import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { HostName } from '../../schemas/host.js';
import { HostIntegrationService } from '../../hosts/integration/service.js';
import { exportHostPluginBundle } from '../../hosts/integration/bundle-export.js';
import {
  applyHostMcp,
  planHostMcp,
  verifyHostMcp,
} from '../../app/host-mcp.js';
import { probeHost } from '../../app/host-probe.js';
import {
  HOST_SUPPORT,
  isSupportedVersion,
} from '../../hosts/integration/support.js';
import { getPackageInfo } from '../../package-info.js';
import type { CliOutput } from '../output.js';

export const hostUsage =
  'pappra host <detect|describe|plan|install|verify|bundle|mcp> --host <pi|codex|claude>\n' +
  '  [--host-root <dir>] [--host-version <version>] [--out <dir>]\n' +
  '  [--mode project-settings|plugin] [--apply] [--json]\n' +
  '\n' +
  'bundle exports a host-native plugin/package directory and never registers it or\n' +
  'claims host callability.';

export interface HostCommandOptions {
  readonly cwd: string;
  readonly json: boolean;
  readonly action:
    | 'detect'
    | 'describe'
    | 'plan'
    | 'install'
    | 'verify'
    | 'bundle'
    | 'mcp'
    | 'probe'
    | null;
  readonly host: HostName | null;
  readonly hostRoot: string | null;
  readonly hostVersion: string | null;
  readonly apply: boolean;
  readonly force: boolean;
  readonly subAction: string | null;
  readonly out: string | null;
  readonly mode: 'project-settings' | 'plugin' | null;
  readonly marketplace: boolean;
  readonly scope: 'project' | 'user' | null;
}

/** Codex only loads lifecycle hooks from its user configuration directory. */
function codexHome(): string {
  const configured = process.env['CODEX_HOME'];
  return configured === undefined || configured === ''
    ? join(homedir(), '.codex')
    : resolve(configured);
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
  if (options.scope === 'user') {
    if (HOST_SUPPORT[options.host].hookScope !== 'user') {
      output.stderr(
        `pappra host: ${options.host} loads hooks from ${HOST_SUPPORT[options.host].hookScope} scope; --scope user is only valid for a user-scoped host (codex).\n`,
      );
      return 2;
    }
    if (options.hostRoot !== null) {
      output.stderr(
        'pappra host: --scope user resolves CODEX_HOME and cannot be combined with --host-root.\n',
      );
      return 2;
    }
    if (
      options.action !== 'plan' &&
      options.action !== 'install' &&
      options.action !== 'verify'
    ) {
      output.stderr(
        'pappra host: --scope user is only valid for plan, install, or verify.\n',
      );
      return 2;
    }
  }
  const hostRoot =
    options.scope === 'user'
      ? codexHome()
      : options.hostRoot === null
        ? undefined
        : resolve(options.cwd, options.hostRoot);
  const target = {
    ...(hostRoot === undefined ? {} : { hostRoot }),
    ...(options.hostVersion === null
      ? {}
      : { hostVersion: options.hostVersion }),
  };

  if (options.action === 'mcp') {
    if (
      options.subAction !== 'plan' &&
      options.subAction !== 'install' &&
      options.subAction !== 'verify'
    ) {
      output.stderr('pappra host mcp requires plan, install, or verify.\n');
      return 2;
    }
    const mcpPlan = await planHostMcp(options.host, options.cwd);
    const result =
      options.subAction === 'verify'
        ? await verifyHostMcp(mcpPlan)
        : options.subAction === 'install' && options.apply
          ? await applyHostMcp(mcpPlan, { force: options.force })
          : {
              ...mcpPlan,
              applied: false,
              verified: false,
              detail: null,
            };
    if (options.json) {
      output.stdout(
        `${JSON.stringify({ schema: 'pappra/host-mcp/1', ...result })}\n`,
      );
    } else {
      output.stdout(`Host ${result.host} MCP: ${result.state}\n`);
      if (result.target !== null) output.stdout(`  target: ${result.target}\n`);
      if (result.command !== null) {
        output.stdout(`  command: ${result.command.join(' ')}\n`);
      }
      output.stdout(`  ${result.message}\n`);
      if (result.detail !== null) output.stdout(`  detail: ${result.detail}\n`);
      if (options.subAction === 'install' && !options.apply) {
        output.stdout('  plan only; rerun with --apply to write it.\n');
      }
    }
    return result.verified || (!options.apply && options.subAction !== 'verify')
      ? 0
      : 1;
  }

  if (options.action === 'probe') {
    const result = probeHost(options.host);
    if (options.json) {
      output.stdout(
        `${JSON.stringify({ schema: 'pappra/host-probe/1', ...result })}\n`,
      );
    } else {
      output.stdout(
        `Host ${result.host} probe: ${result.ok ? 'ok' : 'failed'}\n`,
      );
      output.stdout(
        `  version: ${result.version ?? '(missing)'} / pinned ${result.pinnedVersion}\n`,
      );
      output.stdout(`  protocol: ${result.protocol}\n`);
      output.stdout(`  ${result.message}\n`);
    }
    return result.ok ? 0 : 1;
  }

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
      ...(options.mode === null ? {} : { mode: options.mode }),
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

  if (options.action === 'bundle') {
    if (options.out === null) {
      output.stderr('pappra host bundle requires --out <dir>.\n');
      return 2;
    }
    if (!isSupportedVersion(options.host, options.hostVersion)) {
      output.stderr(
        `Host ${options.host} version ${options.hostVersion ?? '(unknown)'} is outside the pinned ${HOST_SUPPORT[options.host].version} support matrix.\n`,
      );
      return 1;
    }
    try {
      const exported = await exportHostPluginBundle({
        host: options.host,
        hostVersion: options.hostVersion ?? HOST_SUPPORT[options.host].version,
        outDir: options.out,
        packageVersion: getPackageInfo().version,
        marketplace: options.marketplace,
      });
      if (options.json) {
        output.stdout(
          `${JSON.stringify({ ok: true, command: 'host', action: 'bundle', ...exported })}\n`,
        );
      } else {
        output.stdout(
          `Exported ${exported.host} bundle to ${exported.outDir}\n`,
        );
        for (const file of exported.files) output.stdout(`  ${file}\n`);
        for (const hint of exported.registration)
          output.stdout(`  note: ${hint}\n`);
        output.stdout('Registration and host callability remain unverified.\n');
      }
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.json) {
        output.stdout(
          `${JSON.stringify({ ok: false, command: 'host', action: 'bundle', message })}\n`,
        );
      } else {
        output.stderr(`pappra host bundle: ${message}\n`);
      }
      return 1;
    }
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
