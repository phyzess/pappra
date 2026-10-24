import { resolve } from 'node:path';
import type { Diagnostic } from '../../schemas/diagnostics.js';
import { getPackageInfo, getPackageRoot } from '../../package-info.js';
import {
  inspectRuntimeState,
  inspectRuntimeStatePassive,
  installRuntime,
  removeRuntime,
  resolveUserDataDir,
  runtimePaths,
  type RuntimeInstallResult,
} from '../../install/runtime.js';
import { updateMachineRuntime } from '../../install/apply.js';
import { inspectMachineConfig } from '../../workspace/config.js';
import { resolveWorkspaceRoot } from '../../workspace/resolve.js';
import type { CliOutput } from '../output.js';

export const runtimeUsage =
  'pappra runtime <install|status|verify|remove> [options] [--json]\n' +
  '  install [--from self|tarball|registry] [--tarball <file>] [--runtime-version <v>]\n' +
  '          [--apply] [--bind]\n' +
  '  status\n' +
  '  verify [--runtime-version <v>]\n' +
  '  remove [--runtime-version <v>] --apply --force\n\n' +
  'Install keeps a durable copy of the package outside the checkout. --from self packs the\n' +
  'package that is currently executing, which is what makes an npx/dlx bootstrap survive\n' +
  'cache eviction. Writes require --apply; --bind records the copy in machine.json.\n' +
  'Removal requires --force because references from other workspaces cannot be enumerated.\n';

export interface RuntimeCommandOptions {
  readonly cwd: string;
  readonly action: 'install' | 'status' | 'verify' | 'remove' | null;
  readonly json: boolean;
  readonly from: 'self' | 'tarball' | 'registry' | null;
  readonly tarball: string | null;
  readonly version: string | null;
  readonly apply: boolean;
  readonly bind: boolean;
  readonly force: boolean;
}

interface WorkspaceRuntimeBinding {
  readonly root: string;
  readonly machinePath: string;
  readonly runtime: {
    readonly version: string;
    readonly executable: string;
  } | null;
}

async function inspectBinding(
  cwd: string,
): Promise<WorkspaceRuntimeBinding | null> {
  const resolution = await resolveWorkspaceRoot({ startPath: cwd });
  if (resolution.root === null) return null;
  const machine = await inspectMachineConfig(resolution.root);
  return {
    root: resolution.root,
    machinePath: machine.path,
    runtime:
      machine.value?.runtime === null || machine.value?.runtime === undefined
        ? null
        : {
            version: machine.value.runtime.version,
            executable: machine.value.runtime.executable,
          },
  };
}

function printDiagnostics(
  output: CliOutput,
  diagnostics: readonly Diagnostic[],
) {
  for (const diagnostic of diagnostics) {
    output.stderr(
      `  ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}\n`,
    );
  }
}

function sourceFor(
  options: RuntimeCommandOptions,
):
  | { kind: 'self' }
  | { kind: 'tarball'; path: string }
  | { kind: 'version' }
  | null {
  const from = options.from ?? (options.tarball === null ? 'self' : 'tarball');
  if (from === 'self') return { kind: 'self' };
  if (from === 'tarball') {
    if (options.tarball === null) return null;
    return { kind: 'tarball', path: resolve(options.cwd, options.tarball) };
  }
  return { kind: 'version' };
}

async function runInstall(
  options: RuntimeCommandOptions,
  output: CliOutput,
  binding: WorkspaceRuntimeBinding | null,
): Promise<number> {
  const packageInfo = getPackageInfo();
  const version = options.version ?? packageInfo.version;
  const source = sourceFor(options);
  if (source === null) {
    output.stderr(
      'pappra runtime install: --from tarball requires --tarball.\n',
    );
    return 2;
  }
  const dataDir = resolveUserDataDir();
  const paths = runtimePaths(version, dataDir);
  if (!options.apply) {
    if (options.json) {
      output.stdout(
        `${JSON.stringify({
          ok: true,
          command: 'runtime',
          action: 'install',
          mode: 'plan',
          version,
          source: source.kind,
          dataDir,
          runtimeRoot: paths.runtimeRoot,
          bind: options.bind,
          workspaceRoot: binding?.root ?? null,
          nextActions: ['Rerun with --apply to install this exact runtime.'],
        })}\n`,
      );
    } else {
      output.stdout(`Runtime plan: ${packageInfo.name}@${version}\n`);
      output.stdout(`Source: ${source.kind}\n`);
      output.stdout(`Target: ${paths.runtimeRoot}\n`);
      output.stdout('Plan only; rerun with --apply to install it.\n');
    }
    return 0;
  }
  const installed: RuntimeInstallResult = await installRuntime({
    version,
    source:
      source.kind === 'tarball'
        ? { kind: 'tarball', path: source.path }
        : source.kind === 'self'
          ? { kind: 'self', path: getPackageRoot() }
          : { kind: 'version' },
    packageName: packageInfo.name,
  });
  let bindingResult: {
    readonly ok: boolean;
    readonly diagnostics: readonly Diagnostic[];
  } | null = null;
  if (installed.ok && installed.manifest !== null && options.bind) {
    if (binding === null) {
      output.stderr(
        'pappra runtime install: --bind requires a registered workspace root.\n',
      );
      return 1;
    }
    const updated = await updateMachineRuntime(
      binding.root,
      installed.manifest,
    );
    bindingResult = { ok: updated.ok, diagnostics: updated.diagnostics };
    if (!updated.ok) {
      if (options.json) {
        output.stdout(
          `${JSON.stringify({
            ok: false,
            command: 'runtime',
            action: 'install',
            version,
            runtime: installed,
            bind: { ok: false, diagnostics: updated.diagnostics },
          })}\n`,
        );
      }
      printDiagnostics(output, updated.diagnostics);
      return 1;
    }
  }
  if (options.json) {
    output.stdout(
      `${JSON.stringify({
        ok: installed.ok,
        command: 'runtime',
        action: 'install',
        version,
        source: source.kind,
        runtime: installed,
        bind: bindingResult,
        diagnostics: installed.diagnostics,
      })}\n`,
    );
  } else {
    output.stdout(`Runtime: ${installed.status} ${version}\n`);
    if (installed.runtimeRoot !== null) {
      output.stdout(`Location: ${installed.runtimeRoot}\n`);
    }
    if (bindingResult?.ok === true) {
      output.stdout('Machine binding updated.\n');
    }
    printDiagnostics(output, installed.diagnostics);
  }
  return installed.ok ? 0 : 1;
}

async function runStatus(
  options: RuntimeCommandOptions,
  output: CliOutput,
  binding: WorkspaceRuntimeBinding | null,
): Promise<number> {
  const packageInfo = getPackageInfo();
  const version =
    options.version ?? binding?.runtime?.version ?? packageInfo.version;
  const dataDir = resolveUserDataDir();
  const state = await inspectRuntimeStatePassive(version, dataDir);
  if (options.json) {
    output.stdout(
      `${JSON.stringify({
        ok: true,
        command: 'runtime',
        action: 'status',
        version,
        dataDir,
        workspaceRoot: binding?.root ?? null,
        machineRuntime: binding?.runtime ?? null,
        runtime: {
          status: state.status,
          runtimeRoot: state.runtimeRoot,
          packageDigestMatch: state.packageDigestMatch,
          executableExists: state.executableExists,
          verifiedAt: state.manifest?.verifiedAt ?? null,
          source: state.manifest?.source.kind ?? null,
        },
        diagnostics: state.diagnostics,
      })}\n`,
    );
  } else {
    output.stdout(`Runtime ${version}: ${state.status}\n`);
    output.stdout(`Location: ${state.runtimeRoot}\n`);
    if (state.manifest !== null) {
      output.stdout(`Verified at: ${state.manifest.verifiedAt}\n`);
    }
    output.stdout(
      `Bound in machine.json: ${binding?.runtime?.version === version ? 'yes' : 'no'}\n`,
    );
    printDiagnostics(output, state.diagnostics);
  }
  return 0;
}

async function runVerify(
  options: RuntimeCommandOptions,
  output: CliOutput,
  binding: WorkspaceRuntimeBinding | null,
): Promise<number> {
  const packageInfo = getPackageInfo();
  const version =
    options.version ?? binding?.runtime?.version ?? packageInfo.version;
  const state = await inspectRuntimeState(version, resolveUserDataDir());
  const ok = state.status === 'complete';
  if (options.json) {
    output.stdout(
      `${JSON.stringify({
        ok,
        command: 'runtime',
        action: 'verify',
        version,
        status: state.status,
        runtimeRoot: state.runtimeRoot,
        manifest: state.manifest,
        diagnostics: state.diagnostics,
      })}\n`,
    );
  } else {
    output.stdout(`Runtime ${version}: ${state.status}\n`);
    printDiagnostics(output, state.diagnostics);
  }
  return ok ? 0 : 1;
}

async function runRemove(
  options: RuntimeCommandOptions,
  output: CliOutput,
  binding: WorkspaceRuntimeBinding | null,
): Promise<number> {
  const version = options.version ?? binding?.runtime?.version ?? null;
  if (version === null) {
    output.stderr('pappra runtime remove: --runtime-version is required.\n');
    return 2;
  }
  if (!options.apply) {
    output.stderr('pappra runtime remove: rerun with --apply to remove it.\n');
    return 2;
  }
  const boundHere = binding?.runtime?.version === version;
  if (boundHere && !options.force) {
    const message =
      'machine.json still binds this runtime; pass --force to remove it anyway.';
    if (options.json) {
      output.stdout(
        `${JSON.stringify({
          ok: false,
          command: 'runtime',
          action: 'remove',
          version,
          message,
        })}\n`,
      );
    } else {
      output.stderr(`pappra runtime remove: ${message}\n`);
    }
    return 1;
  }
  const removed = await removeRuntime({
    version,
    dataDir: resolveUserDataDir(),
    // No global workspace registry exists. Unknown references are not an empty
    // set; only the explicit CLI override authorizes removal without that check.
    ...(options.force ? { activeReferences: [] } : {}),
  });
  const nextAction =
    removed.status === 'in-use' && !options.force
      ? 'Check references in other workspaces, then pass --force only if removing their shared runtime is intended.'
      : null;
  if (options.json) {
    output.stdout(
      `${JSON.stringify({
        ok: removed.ok,
        command: 'runtime',
        action: 'remove',
        version,
        removed,
        machineBindingRetained: boundHere,
        ...(nextAction === null ? {} : { nextAction }),
      })}\n`,
    );
  } else {
    output.stdout(`Runtime ${version}: ${removed.status}\n`);
    printDiagnostics(output, removed.diagnostics);
    if (nextAction !== null) output.stderr(`${nextAction}\n`);
  }
  return removed.ok ? 0 : 1;
}

export async function runRuntimeCommand(
  options: RuntimeCommandOptions,
  output: CliOutput,
): Promise<number> {
  if (options.action === null) {
    output.stderr(`${runtimeUsage}`);
    return 2;
  }
  const binding = await inspectBinding(options.cwd);
  switch (options.action) {
    case 'install':
      return runInstall(options, output, binding);
    case 'status':
      return runStatus(options, output, binding);
    case 'verify':
      return runVerify(options, output, binding);
    case 'remove':
      return runRemove(options, output, binding);
  }
}
