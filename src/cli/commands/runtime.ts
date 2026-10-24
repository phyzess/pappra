import { join, resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import {
  inspectRuntimeReferences,
  runtimeBindingMatches,
} from '../../install/references.js';
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
  'pappra runtime <install|status|verify|remove|gc> [options] [--json]\n' +
  '  install [--from self|tarball|registry] [--tarball <file>] [--runtime-version <v>]\n' +
  '          [--apply] [--bind]\n' +
  '  status\n' +
  '  verify [--runtime-version <v>]\n' +
  '  remove [--runtime-version <v>] [--apply] [--force]\n' +
  '  gc [--runtime-version <v>] [--apply] [--force]\n\n' +
  'Install keeps a durable copy of the package outside the checkout. --from self packs the\n' +
  'package that is currently executing, which is what makes an npx/dlx bootstrap survive\n' +
  'cache eviction. Writes require --apply; --bind records the copy in machine.json.\n' +
  'Only explicitly registered workspace roots are inspected; no home scan is performed.\n' +
  '--force accepts unknown/unregistered coverage, but never bypasses a verified workspace binding.\n';

export interface RuntimeCommandOptions {
  readonly cwd: string;
  readonly action: 'install' | 'status' | 'verify' | 'remove' | 'gc' | null;
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
    const message = 'runtime remove requires --runtime-version.';
    if (options.json)
      output.stdout(
        `${JSON.stringify({ ok: false, code: 'invalid_arguments', message })}\n`,
      );
    else output.stderr(`pappra: ${message}\n`);
    return 2;
  }
  const dataDir = resolveUserDataDir();
  const boundHere = await runtimeBindingMatches(
    dataDir,
    version,
    binding?.runtime,
  );
  const references = await inspectRuntimeReferences(dataDir, version);
  if (!options.apply) {
    const plan = {
      ok: true,
      command: 'runtime',
      action: 'remove',
      mode: 'plan',
      version,
      runtimeRoot: runtimePaths(version, dataDir).runtimeRoot,
      references,
      boundHere,
      eligibleUnderForcePolicy:
        !boundHere && references.active.length === 0 && options.force,
      nextAction:
        'Use --apply after review. --force accepts unknown coverage only; active bindings are always retained.',
    };
    output.stdout(
      options.json
        ? `${JSON.stringify(plan)}\n`
        : `Runtime removal plan ${version}: ${boundHere || references.active.length > 0 ? 'referenced; retained' : 'global coverage unknown; explicit --force required'}.\n`,
    );
    return 0;
  }
  const removed = await removeRuntime({
    version,
    dataDir,
    ...(boundHere && binding !== null
      ? { activeReferences: [binding.root] }
      : {}),
    forceUnknownReferences: options.force,
  });
  if (options.json)
    output.stdout(
      `${JSON.stringify({ ok: removed.ok, command: 'runtime', action: 'remove', version, removed, references, machineBindingRetained: boundHere })}\n`,
    );
  else {
    output.stdout(`Runtime ${version}: ${removed.status}\n`);
    printDiagnostics(output, removed.diagnostics);
  }
  return removed.ok ? 0 : 1;
}

async function runGc(
  options: RuntimeCommandOptions,
  output: CliOutput,
  binding: WorkspaceRuntimeBinding | null,
): Promise<number> {
  if (
    options.version !== null &&
    !/^[0-9A-Za-z][0-9A-Za-z0-9._+-]*$/.test(options.version)
  ) {
    const message =
      'runtime gc requires an exact --runtime-version without path separators.';
    output.stdout(
      options.json
        ? `${JSON.stringify({ ok: false, code: 'invalid_arguments', message })}\n`
        : `${message}\n`,
    );
    return 2;
  }
  if (options.from !== null || options.tarball !== null || options.bind) {
    const message =
      'runtime gc accepts only --runtime-version, --apply, --force and --json.';
    if (options.json)
      output.stdout(
        `${JSON.stringify({ ok: false, code: 'invalid_arguments', message })}\n`,
      );
    else output.stderr(`${message}\n`);
    return 2;
  }
  const dataDir = resolveUserDataDir();
  let versions: string[];
  try {
    const entries = await readdir(join(dataDir, 'runtimes'), {
      withFileTypes: true,
    });
    versions = entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          /^[0-9A-Za-z][0-9A-Za-z0-9._+-]*$/.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      const report = {
        ok: false,
        command: 'runtime',
        action: 'gc',
        mode: options.apply ? 'apply' : 'plan',
        message: 'Runtime directory is unreadable; nothing was removed.',
      };
      output.stdout(
        options.json ? `${JSON.stringify(report)}\n` : `${report.message}\n`,
      );
      return 1;
    }
    versions = [];
  }
  if (options.version !== null)
    versions = versions.filter((version) => version === options.version);
  if (versions.length > 256) {
    const message =
      'Runtime GC version limit exceeded; select one --runtime-version.';
    output.stdout(
      options.json
        ? `${JSON.stringify({ ok: false, command: 'runtime', action: 'gc', message })}\n`
        : `${message}\n`,
    );
    return 1;
  }
  const entries: Record<string, unknown>[] = [];
  let ok = true;
  for (const version of versions) {
    const references = await inspectRuntimeReferences(dataDir, version);
    const boundHere = await runtimeBindingMatches(
      dataDir,
      version,
      binding?.runtime,
    );
    if (boundHere || references.active.length > 0) {
      entries.push({
        version,
        status: 'retained',
        reason: 'verified-workspace-reference',
        references,
      });
      continue;
    }
    if (!options.apply) {
      entries.push({
        version,
        status: options.force ? 'candidate' : 'unknown',
        references,
      });
      continue;
    }
    const removed = await removeRuntime({
      version,
      dataDir,
      forceUnknownReferences: options.force,
    });
    entries.push({ version, ...removed, references });
    ok &&= removed.ok;
  }
  const report = {
    ok,
    command: 'runtime',
    action: 'gc',
    mode: options.apply ? 'apply' : 'plan',
    dataDir,
    coverage: 'registered-workspaces-only',
    unregisteredCoverage: 'unknown',
    entries,
  };
  output.stdout(
    options.json
      ? `${JSON.stringify(report)}\n`
      : `Runtime GC ${report.mode}: ${entries.map((entry) => `${String(entry['version'])}=${String(entry['status'])}`).join(', ') || 'no versions'}\n`,
  );
  return ok ? 0 : 1;
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
    case 'gc':
      return runGc(options, output, binding);
  }
}
