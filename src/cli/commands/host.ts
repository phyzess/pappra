import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { hostNameSchema, type HostName } from '../../schemas/host.js';
import { HostIntegrationService } from '../../hosts/integration/service.js';
import {
  exportHostPluginBundle,
  type BootstrapBundleInput,
} from '../../hosts/integration/bundle-export.js';
import { readPiBootstrapConfig } from '../../hosts/integration/bootstrap-config.js';
import { readPiRecoveryConfig } from '../../hosts/integration/recovery-config.js';
import {
  applyHostMcp,
  planHostMcp,
  verifyHostMcp,
  type HostMcpResult,
} from '../../app/host-mcp.js';
import { probeHost } from '../../app/host-probe.js';
import {
  HOST_SUPPORT,
  isSupportedVersion,
} from '../../hosts/integration/support.js';
import { getPackageInfo, getPackageRoot } from '../../package-info.js';
import type { CliOutput } from '../output.js';
import {
  clackProgress,
  clackWizardUi,
  confirmApply,
  pickOne,
  type ProgressUi,
  type WizardUi,
} from '../interactive.js';
import { hostOptions } from '../pickers.js';

export const hostUsage =
  'pappra host <detect|describe|probe|plan|install|uninstall|verify|bundle|mcp> --host <pi|codex|claude>\n' +
  '  [--host-root <dir>] [--host-version <version>] [--out <dir>]\n' +
  '  [--mode project-settings|plugin] [--scope project|user] [--marketplace] [--apply] [--json]\n' +
  '  probe --host <name> [--host-root <dir>] [--json]\n' +
  '  uninstall --host <name> [--host-root <dir> | --scope user] [--apply] [--force]\n' +
  '    --force asserts all host writers are stopped and archives unknown locks; edited assets remain preserved.\n' +
  '  mcp <plan|install|verify> --host <name> [--host-root <dir>] [--apply] [--json]\n' +
  '  bundle --host pi --out <new-private-dir> [--bootstrap-config <abs-file> |\n' +
  '    --recovery-config <abs-file>] [--transition-extension]\n' +
  '\n' +
  'bundle exports a host-native plugin/package directory and never registers it or\n' +
  'claims host callability. Recovery and transition extensions are opt-in Pi bundle\n' +
  'artifacts; --recovery-config must pin an exact task-local session and binding.\n' +
  'Exports do not install, trust, load, launch or transfer; native quiescence and\n' +
  'interactive session takeover remain unsupported.';

export interface HostCommandOptions {
  readonly cwd: string;
  readonly json: boolean;
  readonly action:
    | 'detect'
    | 'describe'
    | 'plan'
    | 'install'
    | 'uninstall'
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
  /** Explicit private bootstrap binding; Pi bundle exports only. */
  readonly bootstrapConfig: string | null;
  /** Explicit validated task/session binding; recovery exports are Pi-only. */
  readonly recoveryConfig: string | null;
  /** Opt-in Pi session-transition command extension; it is not native takeover. */
  readonly transitionExtension: boolean;
  readonly marketplace: boolean;
  readonly scope: 'project' | 'user' | null;
  /** A person at a terminal: plan output may be followed by a prompt. */
  readonly interactive?: boolean;
}

/** Injected terminal surfaces; the defaults are the clack implementations. */
export interface HostCommandDeps {
  readonly ui?: WizardUi;
  readonly progress?: ProgressUi;
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
  deps: HostCommandDeps = {},
): Promise<number> {
  if (options.action === null) {
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
  let host = options.host;
  if (host === null && options.interactive === true && options.json !== true) {
    const picked = await pickOne(
      deps.ui ?? clackWizardUi,
      'Pick a host to configure',
      hostOptions(service.detect()),
    );
    if (picked === null) {
      output.stdout('Nothing selected; nothing was done.\n');
      return 0;
    }
    const parsed = hostNameSchema.safeParse(picked);
    if (!parsed.success) return 1;
    host = parsed.data;
  }
  if (host === null) {
    output.stderr('pappra: host requires an action and --host.\n');
    return 2;
  }
  if (options.scope === 'user') {
    if (HOST_SUPPORT[host].hookScope !== 'user') {
      output.stderr(
        `pappra host: ${host} loads hooks from ${HOST_SUPPORT[host].hookScope} scope; --scope user is only valid for a user-scoped host (codex).\n`,
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
      options.action !== 'uninstall' &&
      options.action !== 'verify'
    ) {
      output.stderr(
        'pappra host: --scope user is only valid for plan, install, uninstall, or verify.\n',
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
    const mcpPlan = await planHostMcp(host, options.cwd);
    let result: HostMcpResult =
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
    const printMcpResult = (value: HostMcpResult): void => {
      output.stdout(`Host ${value.host} MCP: ${value.state}\n`);
      if (value.target !== null) output.stdout(`  target: ${value.target}\n`);
      if (value.command !== null) {
        output.stdout(`  command: ${value.command.join(' ')}\n`);
      }
      output.stdout(`  ${value.message}\n`);
      if (value.detail !== null) output.stdout(`  detail: ${value.detail}\n`);
    };
    if (options.json) {
      output.stdout(
        `${JSON.stringify({ schema: 'pappra/host-mcp/1', ...result })}\n`,
      );
    } else {
      printMcpResult(result);
      if (options.subAction === 'install' && !options.apply) {
        if (options.interactive === true) {
          if (result.state === 'conflict') {
            output.stdout(
              'Pass --force explicitly to replace the existing entry.\n',
            );
            return 1;
          }
          const writable =
            mcpPlan.state === 'create' ||
            (mcpPlan.state === 'manual' && mcpPlan.command !== null);
          if (!writable) return 0;
          const apply = await confirmApply(
            deps.ui ?? clackWizardUi,
            `Write the ${result.host} MCP configuration now?`,
          );
          if (!apply) {
            output.stdout('Nothing was applied.\n');
            return 0;
          }
          const progress = deps.progress ?? clackProgress();
          progress.start(`Writing ${result.host} MCP configuration...`);
          result = await applyHostMcp(mcpPlan, { force: options.force });
          progress.stop(
            result.applied
              ? `MCP configuration written for ${result.host}.`
              : `MCP configuration not written for ${result.host}.`,
          );
          printMcpResult(result);
          return result.verified ? 0 : 1;
        }
        output.stdout('  plan only; rerun with --apply to write it.\n');
      }
    }
    return result.verified || (!options.apply && options.subAction !== 'verify')
      ? 0
      : 1;
  }

  if (options.action === 'probe') {
    const result = probeHost(host);
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
    const capabilities = service.describe(host);
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
      const plan = await service.plan(host, target);
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
    const install = async (apply: boolean, progress?: ProgressUi) => {
      progress?.start(`Wiring ${host}...`);
      const result = await service.install(host, {
        ...target,
        apply,
        ...(options.mode === null ? {} : { mode: options.mode }),
      });
      progress?.stop(`Host wiring ${result.status}.`);
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
      return result;
    };
    const planned = await install(options.apply);
    if (
      options.interactive === true &&
      options.json !== true &&
      !options.apply &&
      planned.ok &&
      planned.status === 'planned'
    ) {
      const apply = await confirmApply(
        deps.ui ?? clackWizardUi,
        `Install Pappra wiring for ${host} now?`,
      );
      if (!apply) {
        output.stdout('Nothing was applied.\n');
        return 0;
      }
      const applied = await install(true, deps.progress ?? clackProgress());
      return diagnosticStatus(applied.status);
    }
    return diagnosticStatus(planned.status);
  }

  if (options.action === 'uninstall') {
    const uninstall = async (apply: boolean, progress?: ProgressUi) => {
      progress?.start(`Removing ${host} wiring...`);
      const result = await service.uninstall(host, {
        ...target,
        apply,
        force: options.force,
      });
      progress?.stop(`Host uninstall ${result.status}.`);
      if (options.json) output.stdout(`${JSON.stringify(result)}\n`);
      else {
        output.stdout(`Status: ${result.status}\n`);
        for (const file of result.removedFiles)
          output.stdout(`  removed ${file}\n`);
        for (const file of result.retainedPaths)
          output.stdout(`  preserved ${file}\n`);
        for (const file of result.quarantinedLocks)
          output.stdout(`  archived lock ${file}\n`);
        printDiagnostics(output, result.diagnostics);
      }
      return result;
    };
    const planned = await uninstall(options.apply);
    if (
      options.interactive === true &&
      options.json !== true &&
      !options.apply
    ) {
      if (!planned.ok || planned.status !== 'planned') {
        return planned.ok ? 0 : 1;
      }
      const apply = await confirmApply(
        deps.ui ?? clackWizardUi,
        `Remove Pappra wiring from ${host} now?`,
        false,
      );
      if (!apply) {
        output.stdout('Nothing was applied.\n');
        return 0;
      }
      const applied = await uninstall(true, deps.progress ?? clackProgress());
      return applied.ok ? 0 : 1;
    }
    if (!options.apply && !options.json)
      output.stdout(
        '  plan only; rerun with --apply to remove managed wiring.\n',
      );
    return planned.ok ? 0 : 1;
  }

  if (options.action === 'bundle') {
    if (options.out === null) {
      output.stderr('pappra host bundle requires --out <dir>.\n');
      return 2;
    }
    if (options.bootstrapConfig !== null) {
      if (host !== 'pi') {
        output.stderr(
          'pappra host bundle: --bootstrap-config requires --host pi.\n',
        );
        return 2;
      }
      if (!isAbsolute(options.bootstrapConfig)) {
        output.stderr(
          'pappra host bundle: --bootstrap-config must be an absolute path.\n',
        );
        return 2;
      }
      if (options.marketplace || options.mode !== null || options.apply) {
        output.stderr(
          'pappra host bundle: --bootstrap-config cannot be combined with --marketplace, --mode or --apply.\n',
        );
        return 2;
      }
    }
    if (!isSupportedVersion(host, options.hostVersion)) {
      output.stderr(
        `Host ${host} version ${options.hostVersion ?? '(unknown)'} is outside the pinned ${HOST_SUPPORT[host].version} support matrix.\n`,
      );
      return 1;
    }
    let bootstrap: BootstrapBundleInput | undefined;
    if (options.bootstrapConfig !== null) {
      const loaded = readPiBootstrapConfig(options.bootstrapConfig);
      if (loaded.ok === false) {
        if (options.json) {
          output.stdout(
            `${JSON.stringify({
              ok: false,
              command: 'host',
              action: 'bundle',
              code: loaded.code,
              message: loaded.message,
            })}\n`,
          );
        } else {
          output.stderr(`pappra host bundle: ${loaded.message}\n`);
        }
        return 1;
      }
      bootstrap = {
        config: loaded.config,
        configBytes: loaded.bytes,
        configDigest: loaded.digest,
        artifactPath: join(
          getPackageRoot(),
          'dist/hosts/integration/pappra-bootstrap-extension.mjs',
        ),
      };
    }
    let recovery:
      | { readonly configFile: string; readonly artifactPath: string }
      | undefined;
    if (options.recoveryConfig !== null) {
      if (host !== 'pi') {
        output.stderr(
          'pappra host bundle: --recovery-config requires --host pi.\n',
        );
        return 2;
      }
      if (
        !isAbsolute(options.recoveryConfig) ||
        options.bootstrapConfig !== null ||
        options.marketplace ||
        options.mode !== null ||
        options.apply
      ) {
        output.stderr(
          'pappra host bundle: --recovery-config requires an absolute path and cannot be combined with --bootstrap-config, --marketplace, --mode or --apply.\n',
        );
        return 2;
      }
      const loaded = readPiRecoveryConfig(options.recoveryConfig);
      if (loaded.ok === false) {
        output.stderr(
          `pappra host bundle: recovery config validation failed (${loaded.code}).\n`,
        );
        return 1;
      }
      recovery = {
        configFile: options.recoveryConfig,
        artifactPath: join(
          getPackageRoot(),
          'dist/hosts/integration/pappra-recovery-extension.mjs',
        ),
      };
    }
    if (
      options.transitionExtension &&
      (host !== 'pi' ||
        options.bootstrapConfig !== null ||
        options.marketplace ||
        options.mode !== null ||
        options.apply)
    ) {
      output.stderr(
        'pappra host bundle: --transition-extension requires a plain Pi bundle and cannot be combined with --bootstrap-config, --marketplace, --mode or --apply.\n',
      );
      return 2;
    }
    try {
      const exported = await exportHostPluginBundle({
        host,
        hostVersion: options.hostVersion ?? HOST_SUPPORT[host].version,
        outDir: options.out,
        packageVersion: getPackageInfo().version,
        marketplace: options.marketplace,
        ...(bootstrap === undefined ? {} : { bootstrap }),
        ...(recovery === undefined ? {} : { recovery }),
        ...(options.transitionExtension
          ? {
              transition: {
                artifactPath: join(
                  getPackageRoot(),
                  'dist/hosts/integration/pappra-session-transition-extension.mjs',
                ),
              },
            }
          : {}),
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

  const result = await service.verify(host, target);
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
