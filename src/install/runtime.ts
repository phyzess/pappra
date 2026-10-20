import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { Diagnostic } from '../schemas/diagnostics.js';
import { createDiagnostic } from '../schemas/diagnostics.js';
import { diagnosticCodes } from '../schemas/errors.js';
import type {
  InstallJournal,
  RuntimeManifest,
  RuntimePackageManifest,
  RuntimeSource,
} from '../schemas/install.js';
import {
  installJournalSchema,
  runtimeManifestSchema,
  runtimePackageManifestSchema,
  runtimeSourceSchema,
} from '../schemas/install.js';
import { isPathInside } from '../schemas/paths.js';
import { errorMessage } from '../schemas/outcome.js';
import {
  observePath,
  readFileBounded,
  readTextFileBounded,
  resolveRealpath,
  sha256Digest,
} from '../infra/fs.js';
import {
  acquireInstallLock,
  readJsonDocument,
  releaseInstallLock,
  scanJournalDirectory,
  writeInstallJournal,
} from './ownership.js';

export type RuntimeInstallStatus =
  'installed' | 'reused' | 'locked' | 'corrupt' | 'partial' | 'failed';

export interface RuntimeInstallResult {
  readonly ok: boolean;
  readonly status: RuntimeInstallStatus;
  readonly version: string;
  readonly runtimeRoot: string | null;
  readonly manifest: RuntimeManifest | null;
  readonly journal: InstallJournal | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly residualPaths: readonly string[];
}

export interface RuntimeInstallSource {
  readonly kind: 'version' | 'tarball';
  /** Required for tarball sources. */
  readonly path?: string;
}

export interface InstallRuntimeOptions {
  readonly version: string;
  readonly source: RuntimeInstallSource;
  readonly dataDir?: string;
  readonly packageName?: string;
  readonly offline?: boolean;
  readonly timeoutMs?: number;
  /** Fault-injection seam for tests; the CLI never supplies this hook. */
  readonly beforeVerifiedJournalPersist?: () => Promise<void> | void;
}

export interface RuntimePaths {
  readonly dataDir: string;
  readonly runtimeRoot: string;
  readonly lockPath: string;
  readonly stagingRoot: string;
  readonly journalsDir: string;
}

export function resolveUserDataDir(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (environment['PAPPRA_DATA_HOME'] !== undefined) {
    return resolve(environment['PAPPRA_DATA_HOME']);
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Pappra');
  }
  if (platform === 'win32') {
    return join(environment['LOCALAPPDATA'] ?? home, 'Pappra');
  }
  return join(
    environment['XDG_DATA_HOME'] ?? join(home, '.local', 'share'),
    'pappra',
  );
}

function validVersion(version: string): boolean {
  return /^[0-9A-Za-z][0-9A-Za-z0-9._+-]*$/.test(version);
}

export function runtimePaths(
  version: string,
  dataDir = resolveUserDataDir(),
): RuntimePaths {
  const runtimes = join(dataDir, 'runtimes');
  return {
    dataDir,
    runtimeRoot: join(runtimes, version),
    lockPath: join(runtimes, '.locks', `${version}.lock`),
    stagingRoot: join(runtimes, '.staging'),
    journalsDir: join(dataDir, 'journals'),
  };
}

function diagnosticFailure(
  code: ReturnType<typeof diagnosticCode>,
  message: string,
  hint: string,
  source: string,
): Diagnostic {
  return createDiagnostic({
    code,
    severity: 'error',
    message,
    source,
    hint,
  });
}

function diagnosticCode(
  name: keyof typeof diagnosticCodes,
): (typeof diagnosticCodes)[keyof typeof diagnosticCodes] {
  return diagnosticCodes[name];
}

function failureResult(
  status: RuntimeInstallStatus,
  message: string,
  options: {
    readonly version: string;
    readonly runtimeRoot?: string | null;
    readonly manifest?: RuntimeManifest | null;
    readonly journal?: InstallJournal | null;
    readonly residualPaths?: readonly string[];
    readonly hint?: string;
    readonly source?: string;
  },
): RuntimeInstallResult {
  return {
    ok: false,
    status,
    version: options.version,
    runtimeRoot: options.runtimeRoot ?? null,
    manifest: options.manifest ?? null,
    journal: options.journal ?? null,
    diagnostics: [
      diagnosticFailure(
        diagnosticCodes.initApplyFailed,
        message,
        options.hint ?? 'Inspect the runtime state; Pappra did not auto-retry.',
        options.source ?? 'runtime install',
      ),
    ],
    residualPaths: options.residualPaths ?? [],
  };
}

function isoNow(): string {
  return new Date().toISOString();
}

async function hashPackageDirectory(directory: string): Promise<string> {
  const parts: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = (await readdir(current, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const path = join(current, entry.name);
      const rel = relative(directory, path).split(sep).join('/');
      if (entry.isSymbolicLink()) {
        const target = await readlink(path).catch(() => '');
        parts.push(`symlink:${rel}:${target}`);
      } else if (entry.isDirectory()) {
        parts.push(`dir:${rel}`);
        await visit(path);
      } else if (entry.isFile()) {
        const file = await readFileBounded(path, 64 * 1024 * 1024);
        if (!file.ok) {
          throw new Error(
            `Cannot hash runtime package file ${path}: ${file.code}`,
          );
        }
        parts.push(`file:${rel}:${file.value.digest}`);
      } else {
        parts.push(`other:${rel}`);
      }
    }
  };
  await visit(directory);
  return sha256Digest(parts.join('\n'));
}

async function packageDigest(directory: string): Promise<string> {
  return hashPackageDirectory(directory);
}

interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

async function runCommand(
  executable: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly timeoutMs: number },
): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      shell: false,
      env: { ...process.env, npm_config_update_notifier: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 4 * 1024 * 1024) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4 * 1024 * 1024) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({
        code: null,
        stdout,
        stderr: `${stderr}${errorMessage(error)}`,
        timedOut,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut });
    });
  });
}

function npmCommand(): {
  readonly executable: string;
  readonly args: readonly string[];
} {
  const execpath = process.env['npm_execpath'];
  if (execpath !== undefined && /npm-cli\.js$/.test(execpath)) {
    return { executable: process.execPath, args: [execpath] };
  }
  const bin = dirname(process.execPath);
  const candidates = [
    resolve(bin, '../lib/node_modules/npm/bin/npm-cli.js'),
    resolve(bin, 'node_modules/npm/bin/npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (candidate.endsWith('npm-cli.js') && existsSync(candidate)) {
      return { executable: process.execPath, args: [candidate] };
    }
  }
  return {
    executable: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: [],
  };
}

async function readPackageManifest(
  directory: string,
  boundaryRoot: string,
): Promise<RuntimePackageManifest | null> {
  const manifestPath = join(directory, 'package.json');
  const real = await resolveRealpath(manifestPath);
  if (real === null || !isPathInside(boundaryRoot, real)) return null;
  const read = await readTextFileBounded(manifestPath);
  if (!read.ok) return null;
  try {
    const raw: unknown = JSON.parse(read.value.text);
    const parsed = runtimePackageManifestSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function binPath(
  packageManifest: RuntimePackageManifest,
  packageName: string,
): string | null {
  if (packageManifest.bin === undefined) return null;
  if (typeof packageManifest.bin === 'string') return packageManifest.bin;
  return (
    packageManifest.bin[packageName] ?? packageManifest.bin['pappra'] ?? null
  );
}

async function verifyInstalledRuntime(
  runtimeRoot: string,
  expectedVersion: string,
  expectedPackageName: string,
  timeoutMs: number,
): Promise<{
  readonly manifest: RuntimePackageManifest;
  readonly digest: string;
  readonly executableRelative: string;
  readonly smoke: RuntimeManifest['smoke'];
} | null> {
  const packageRoot = join(
    runtimeRoot,
    'node_modules',
    ...expectedPackageName.split('/'),
  );
  const runtimeReal = await resolveRealpath(runtimeRoot);
  const packageManifest =
    runtimeReal === null
      ? null
      : await readPackageManifest(packageRoot, runtimeReal);
  if (
    packageManifest === null ||
    packageManifest.name !== expectedPackageName ||
    packageManifest.version !== expectedVersion
  ) {
    return null;
  }
  const bin = binPath(packageManifest, expectedPackageName);
  if (bin === null) return null;
  const executablePath = resolve(packageRoot, bin);
  if (!isPathInside(packageRoot, executablePath)) return null;
  const observation = await observePath(executablePath);
  if (observation.kind !== 'file') return null;
  const command = await runCommand(
    process.execPath,
    [executablePath, '--version', '--json'],
    { cwd: packageRoot, timeoutMs },
  );
  if (command.timedOut || command.code !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(command.stdout.trim());
  } catch {
    return null;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    parsed.version !== expectedVersion
  ) {
    return null;
  }
  return {
    manifest: packageManifest,
    digest: await packageDigest(packageRoot),
    executableRelative: relative(runtimeRoot, executablePath)
      .split(sep)
      .join('/'),
    smoke: {
      argv: ['--version', '--json'],
      exitCode: command.code,
      stdoutDigest: sha256Digest(command.stdout),
    },
  };
}

async function readRuntimeManifest(
  runtimeRoot: string,
): Promise<RuntimeManifest | null> {
  const read = await readJsonDocument(
    join(runtimeRoot, 'install-manifest.json'),
    runtimeManifestSchema,
  );
  return read.value;
}

interface RuntimeJournalScan {
  readonly journal: InstallJournal | null;
  readonly unreadable: readonly string[];
  readonly directoryUnreadable: boolean;
}

async function scanRuntimeJournals(
  version: string,
  paths: RuntimePaths,
): Promise<RuntimeJournalScan> {
  const directory = await scanJournalDirectory(paths.journalsDir);
  if (directory.kind === 'missing') {
    return { journal: null, unreadable: [], directoryUnreadable: false };
  }
  if (directory.kind === 'unreadable') {
    return {
      journal: null,
      unreadable: [paths.journalsDir],
      directoryUnreadable: true,
    };
  }
  const unreadable = [...directory.nonRegular];
  let journal: InstallJournal | null = null;
  for (const path of directory.files) {
    const read = await readJsonDocument(path, installJournalSchema);
    if (read.value === null) {
      unreadable.push(path);
      continue;
    }
    if (
      journal === null &&
      read.value.runtimeVersion === version &&
      (read.value.status === 'prepared' ||
        read.value.status === 'applying' ||
        read.value.status === 'applied' ||
        read.value.status === 'rollback-required')
    ) {
      journal = read.value;
    }
  }
  return { journal, unreadable, directoryUnreadable: false };
}

async function completeExistingRuntime(
  version: string,
  paths: RuntimePaths,
  packageName: string,
  timeoutMs: number,
): Promise<RuntimeInstallResult | null> {
  const observation = await observePath(paths.runtimeRoot);
  if (observation.kind === 'missing') return null;
  if (observation.kind !== 'directory') {
    return failureResult(
      'corrupt',
      `Runtime path is not a directory: ${paths.runtimeRoot}`,
      {
        version,
        runtimeRoot: paths.runtimeRoot,
        hint: 'Inspect or remove the incomplete runtime explicitly.',
        source: paths.runtimeRoot,
      },
    );
  }
  const manifest = await readRuntimeManifest(paths.runtimeRoot);
  if (manifest === null) {
    return failureResult(
      'corrupt',
      `Runtime has no valid manifest: ${paths.runtimeRoot}`,
      {
        version,
        runtimeRoot: paths.runtimeRoot,
        hint: 'Inspect the partial runtime; Pappra does not overwrite it.',
        source: paths.runtimeRoot,
      },
    );
  }
  if (
    manifest.runtimeVersion !== version ||
    manifest.packageName !== packageName
  ) {
    return failureResult(
      'corrupt',
      `Runtime manifest does not match ${version}.`,
      {
        version,
        runtimeRoot: paths.runtimeRoot,
        manifest,
        hint: 'Inspect or remove the unrelated runtime explicitly.',
        source: paths.runtimeRoot,
      },
    );
  }
  const packageRoot = join(
    paths.runtimeRoot,
    'node_modules',
    ...packageName.split('/'),
  );
  const digest = await packageDigest(packageRoot).catch(() => null);
  const executableObservation = await observePath(manifest.executable);
  if (
    digest === null ||
    digest !== manifest.packageDigest ||
    executableObservation.kind !== 'file'
  ) {
    return failureResult(
      'corrupt',
      `Runtime package content no longer matches its manifest: ${paths.runtimeRoot}`,
      {
        version,
        runtimeRoot: paths.runtimeRoot,
        manifest,
        hint: 'Inspect the runtime; Pappra will not silently reinstall or overwrite it.',
        source: paths.runtimeRoot,
      },
    );
  }
  const verified = await verifyInstalledRuntime(
    paths.runtimeRoot,
    version,
    packageName,
    timeoutMs,
  );
  if (verified === null) {
    return failureResult(
      'corrupt',
      `Runtime smoke check failed: ${paths.runtimeRoot}`,
      {
        version,
        runtimeRoot: paths.runtimeRoot,
        manifest,
        hint: 'Run doctor diagnostics; Pappra will not replace a failed runtime automatically.',
        source: paths.runtimeRoot,
      },
    );
  }
  return {
    ok: true,
    status: 'reused',
    version,
    runtimeRoot: paths.runtimeRoot,
    manifest,
    journal: null,
    diagnostics: [],
    residualPaths: [],
  };
}

function updateJournal(
  journal: InstallJournal,
  status: InstallJournal['status'],
  step: string,
  detail: string | null,
  failed = false,
): InstallJournal {
  return {
    ...journal,
    status,
    updatedAt: isoNow(),
    steps: [
      ...journal.steps,
      { name: step, status: failed ? 'failed' : 'ok', at: isoNow(), detail },
    ],
  };
}

export async function installRuntime(
  options: InstallRuntimeOptions,
): Promise<RuntimeInstallResult> {
  const version = options.version;
  const packageName = options.packageName ?? 'pappra';
  if (!validVersion(version)) {
    return failureResult('failed', `Invalid runtime version: ${version}`, {
      version,
      hint: 'Use a plain exact version (no path separators).',
      source: 'runtime install',
    });
  }
  if (
    !/^[A-Za-z0-9@][A-Za-z0-9._/@-]*$/.test(packageName) ||
    packageName.includes('..')
  ) {
    return failureResult(
      'failed',
      `Invalid runtime package name: ${packageName}`,
      {
        version,
        hint: 'Use a normal npm package name.',
        source: 'runtime install',
      },
    );
  }
  const timeoutMs = options.timeoutMs ?? 120_000;
  const dataDir = resolve(options.dataDir ?? resolveUserDataDir());
  const paths = runtimePaths(version, dataDir);
  const journalScan = await scanRuntimeJournals(version, paths);
  if (journalScan.unreadable.length > 0) {
    return failureResult(
      journalScan.directoryUnreadable ? 'failed' : 'partial',
      `Runtime journal state is unreadable or incompatible: ${journalScan.unreadable.join(', ')}`,
      {
        version,
        runtimeRoot: paths.runtimeRoot,
        residualPaths: journalScan.unreadable,
        hint: 'Inspect the listed journals; Pappra does not ignore incompatible install state.',
        source: paths.journalsDir,
      },
    );
  }
  if (journalScan.journal !== null) {
    return failureResult(
      'partial',
      `A previous runtime installation is incomplete: ${join(paths.journalsDir, `${journalScan.journal.installId}.json`)}`,
      {
        version,
        runtimeRoot: paths.runtimeRoot,
        journal: journalScan.journal,
        hint: 'Inspect the journal and runtime directory; Pappra does not auto-retry an interrupted install.',
        source: paths.runtimeRoot,
      },
    );
  }
  const existingLock = await observePath(paths.lockPath);
  if (existingLock.kind !== 'missing') {
    return failureResult('locked', 'Runtime installation is locked.', {
      version,
      runtimeRoot: paths.runtimeRoot,
      residualPaths: [paths.lockPath],
      hint: 'Inspect the existing lock; Pappra does not reuse a runtime while its install state is locked.',
      source: paths.lockPath,
    });
  }
  const existing = await completeExistingRuntime(
    version,
    paths,
    packageName,
    timeoutMs,
  );
  if (existing !== null) return existing;

  const lock = await acquireInstallLock(
    paths.lockPath,
    'install-runtime',
    paths.runtimeRoot,
    dataDir,
  );
  if (!lock.ok) {
    return failureResult(
      'locked',
      lock.message ?? 'Runtime installation is locked.',
      {
        version,
        runtimeRoot: paths.runtimeRoot,
        hint: 'Another install owns this version lock; Pappra will not reclaim it by age.',
        source: paths.lockPath,
      },
    );
  }

  const afterLock = await completeExistingRuntime(
    version,
    paths,
    packageName,
    timeoutMs,
  );
  if (afterLock !== null) {
    await releaseInstallLock(paths.lockPath, lock.lock!.token);
    return afterLock;
  }

  let source: RuntimeSource;
  try {
    if (options.source.kind === 'tarball') {
      const tarballPath = resolve(options.source.path ?? '');
      const observation = await observePath(tarballPath);
      if (observation.kind !== 'file' || observation.stats === null) {
        throw new Error(
          `Runtime tarball is not a regular file: ${tarballPath}`,
        );
      }
      const bytes = await readFile(tarballPath);
      source = {
        kind: 'tarball',
        packageName,
        version,
        path: tarballPath,
        digest: sha256Digest(bytes),
      };
    } else {
      source = {
        kind: 'version',
        packageName,
        version,
        ref: `${packageName}@${version}`,
      };
    }
    runtimeSourceSchema.parse(source);
  } catch (error) {
    await releaseInstallLock(paths.lockPath, lock.lock!.token);
    return failureResult(
      'failed',
      `Invalid runtime source: ${errorMessage(error)}`,
      {
        version,
        runtimeRoot: paths.runtimeRoot,
        hint: 'Provide a readable local tarball or an exact package version.',
        source: paths.runtimeRoot,
      },
    );
  }

  const installId = randomUUID();
  const stage = join(paths.stagingRoot, installId);
  const journalFile = join(paths.journalsDir, `${installId}.json`);
  let journal: InstallJournal = {
    schema: 'pappra/install-journal/1',
    installId,
    operation: 'install-runtime',
    target: paths.runtimeRoot,
    workspaceRoot: null,
    runtimeVersion: version,
    status: 'prepared',
    createdAt: isoNow(),
    updatedAt: isoNow(),
    steps: [
      {
        name: 'lock-acquired',
        status: 'ok',
        at: isoNow(),
        detail: paths.lockPath,
      },
    ],
    entries: [],
    residuals: [],
    manifestRef: join(paths.runtimeRoot, 'install-manifest.json'),
  };
  const writeJournal = async (): Promise<boolean> => {
    const written = await writeInstallJournal(journalFile, journal, dataDir);
    return written.ok;
  };
  if (!(await writeJournal())) {
    await releaseInstallLock(paths.lockPath, lock.lock!.token);
    return failureResult('failed', 'Cannot write runtime install journal.', {
      version,
      runtimeRoot: paths.runtimeRoot,
      journal,
      hint: 'Inspect data directory permissions before retrying.',
      source: journalFile,
    });
  }

  let published = false;
  const fail = async (
    message: string,
    stageResidual: boolean,
  ): Promise<RuntimeInstallResult> => {
    let residual: string[] = [];
    if (stageResidual) {
      try {
        await rm(stage, { recursive: true, force: true });
      } catch {
        residual = [stage];
      }
    }
    journal = updateJournal(
      journal,
      residual.length === 0 ? 'rolled-back' : 'rollback-required',
      'failed',
      message,
      true,
    );
    journal = { ...journal, residuals: residual };
    await writeJournal();
    const lockRelease = await releaseInstallLock(
      paths.lockPath,
      lock.lock!.token,
    );
    if (!lockRelease.ok) residual = [...residual, paths.lockPath];
    return failureResult('failed', message, {
      version,
      runtimeRoot: paths.runtimeRoot,
      journal,
      residualPaths: residual,
      hint: 'Inspect the journal and staging/runtime paths; no automatic retry was performed.',
      source: journalFile,
    });
  };

  try {
    await mkdir(stage, { recursive: true });
    await writeFile(
      join(stage, 'package.json'),
      `${JSON.stringify({ name: 'pappra-runtime-stage', private: true, version: '0.0.0-private' }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    journal = updateJournal(journal, 'applying', 'staging-created', stage);
    if (!(await writeJournal())) {
      throw new Error(`Cannot update install journal: ${journalFile}`);
    }

    const npm = npmCommand();
    const installArgs = [
      ...npm.args,
      'install',
      '--prefix',
      stage,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      '--save-exact',
      ...(options.offline === true ? ['--offline'] : []),
      source.kind === 'tarball'
        ? source.path
        : `${source.packageName}@${source.version}`,
    ];
    const installed = await runCommand(npm.executable, installArgs, {
      cwd: stage,
      timeoutMs,
    });
    if (installed.timedOut || installed.code !== 0) {
      throw new Error(
        `Package manager install failed (${installed.timedOut ? 'timeout' : `exit ${String(installed.code)}`}): ${installed.stderr.slice(0, 1000)}`,
      );
    }
    journal = updateJournal(journal, 'applying', 'package-installed', null);
    if (!(await writeJournal()))
      throw new Error('Cannot update install journal.');

    const verification = await verifyInstalledRuntime(
      stage,
      version,
      packageName,
      timeoutMs,
    );
    if (verification === null) {
      throw new Error(
        `Installed runtime failed version/content/smoke verification for ${version}.`,
      );
    }
    journal = updateJournal(journal, 'applying', 'runtime-verified', null);
    if (!(await writeJournal()))
      throw new Error('Cannot update install journal.');

    const manifest: RuntimeManifest = {
      schema: 'pappra/runtime-manifest/1',
      installId,
      packageName,
      runtimeVersion: version,
      runtimeRoot: paths.runtimeRoot,
      executable: join(
        paths.runtimeRoot,
        ...verification.executableRelative.split('/'),
      ),
      source,
      packageDigest: verification.digest,
      smoke: verification.smoke,
      verifiedAt: isoNow(),
    };
    const parsedManifest = runtimeManifestSchema.safeParse(manifest);
    if (!parsedManifest.success) {
      throw new Error(
        `Runtime manifest is invalid: ${parsedManifest.error.issues[0]?.message ?? 'unknown'}`,
      );
    }
    await writeFile(
      join(stage, 'install-manifest.json'),
      `${JSON.stringify(parsedManifest.data, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    journal = updateJournal(journal, 'applied', 'manifest-written', null);
    if (!(await writeJournal()))
      throw new Error('Cannot update install journal.');

    const finalObservation = await observePath(paths.runtimeRoot);
    if (finalObservation.kind !== 'missing') {
      throw new Error(
        `Runtime version directory already exists: ${paths.runtimeRoot}`,
      );
    }
    await rename(stage, paths.runtimeRoot);
    published = true;
    const finalManifest = await readRuntimeManifest(paths.runtimeRoot);
    if (finalManifest === null) {
      throw new Error('Runtime manifest is unreadable after publish.');
    }
    journal = updateJournal(
      journal,
      'verified',
      'published',
      paths.runtimeRoot,
    );
    journal = {
      ...journal,
      manifestRef: join(paths.runtimeRoot, 'install-manifest.json'),
    };
    await options.beforeVerifiedJournalPersist?.();
    const verifiedJournalWritten = await writeJournal();
    const released = await releaseInstallLock(paths.lockPath, lock.lock!.token);
    const residualPaths: string[] = [];
    if (!verifiedJournalWritten) residualPaths.push(journalFile);
    if (!released.ok) residualPaths.push(paths.lockPath);
    if (residualPaths.length > 0) {
      return {
        ok: false,
        status: 'partial',
        version,
        runtimeRoot: paths.runtimeRoot,
        manifest: finalManifest,
        journal,
        diagnostics: residualPaths.map((path) =>
          createDiagnostic({
            code: diagnosticCodes.initApplyResidual,
            severity: 'error',
            message: `Runtime is verified but install state is not final: ${path}`,
            source: path,
            hint: 'Do not treat initialization as complete. Inspect the journal/lock and retry before continuing.',
          }),
        ),
        residualPaths,
      };
    }
    return {
      ok: true,
      status: 'installed',
      version,
      runtimeRoot: paths.runtimeRoot,
      manifest: finalManifest,
      journal,
      diagnostics: [],
      residualPaths,
    };
  } catch (error) {
    if (published) {
      journal = updateJournal(
        journal,
        'rollback-required',
        'published-but-failed',
        errorMessage(error),
        true,
      );
      journal = { ...journal, residuals: [paths.runtimeRoot] };
      await writeJournal();
      const released = await releaseInstallLock(
        paths.lockPath,
        lock.lock!.token,
      );
      const residual = [paths.runtimeRoot];
      if (!released.ok) residual.push(paths.lockPath);
      return failureResult('failed', errorMessage(error), {
        version,
        runtimeRoot: paths.runtimeRoot,
        manifest: null,
        journal,
        residualPaths: residual,
        hint: 'Runtime was published but post-publish validation/state failed. Inspect it before retrying; Pappra did not delete it automatically.',
        source: paths.runtimeRoot,
      });
    }
    return fail(errorMessage(error), true);
  }
}

export interface RuntimeStateReport {
  readonly version: string;
  readonly status: 'missing' | 'complete' | 'partial' | 'corrupt' | 'locked';
  readonly runtimeRoot: string;
  readonly manifest: RuntimeManifest | null;
  readonly journal: InstallJournal | null;
  readonly diagnostics: readonly Diagnostic[];
}

export async function inspectRuntimeState(
  version: string,
  dataDir = resolveUserDataDir(),
): Promise<RuntimeStateReport> {
  const paths = runtimePaths(version, dataDir);
  if (!validVersion(version)) {
    return {
      version,
      status: 'corrupt',
      runtimeRoot: paths.runtimeRoot,
      manifest: null,
      journal: null,
      diagnostics: [
        createDiagnostic({
          code: diagnosticCodes.initApplyFailed,
          severity: 'error',
          message: `Invalid runtime version: ${version}`,
          source: paths.runtimeRoot,
          hint: 'Use a plain exact version without path separators.',
        }),
      ],
    };
  }
  const lockObservation = await observePath(paths.lockPath);
  const journalScan = await scanRuntimeJournals(version, paths);
  if (journalScan.unreadable.length > 0) {
    return {
      version,
      status: 'partial',
      runtimeRoot: paths.runtimeRoot,
      manifest: null,
      journal: null,
      diagnostics: [
        createDiagnostic({
          code: diagnosticCodes.initApplyResidual,
          severity: 'warning',
          message: `Runtime journals are unreadable or incompatible: ${journalScan.unreadable.join(', ')}`,
          source: paths.journalsDir,
          hint: 'Inspect the listed journals; no automatic retry or cleanup is performed.',
        }),
      ],
    };
  }
  const journal = journalScan.journal;
  if (journal !== null) {
    return {
      version,
      status: 'partial',
      runtimeRoot: paths.runtimeRoot,
      manifest: null,
      journal,
      diagnostics: [
        createDiagnostic({
          code: diagnosticCodes.initApplyResidual,
          severity: 'warning',
          message: `Runtime installation is incomplete; journal: ${join(paths.journalsDir, `${journal.installId}.json`)}`,
          source: paths.runtimeRoot,
          hint: 'Inspect the journal and staging directory; no automatic retry or cleanup is performed.',
        }),
      ],
    };
  }
  if (lockObservation.kind !== 'missing') {
    return {
      version,
      status: 'locked',
      runtimeRoot: paths.runtimeRoot,
      manifest: null,
      journal: null,
      diagnostics: [
        createDiagnostic({
          code: diagnosticCodes.initApplyResidual,
          severity: 'warning',
          message: `Runtime installation lock exists: ${paths.lockPath}`,
          source: paths.lockPath,
          hint: 'Inspect the lock owner before acting; locks do not expire automatically.',
        }),
      ],
    };
  }
  const complete = await completeExistingRuntime(
    version,
    paths,
    'pappra',
    30_000,
  );
  if (complete === null) {
    return {
      version,
      status: 'missing',
      runtimeRoot: paths.runtimeRoot,
      manifest: null,
      journal: null,
      diagnostics: [],
    };
  }
  return {
    version,
    status: complete.status === 'reused' ? 'complete' : 'corrupt',
    runtimeRoot: paths.runtimeRoot,
    manifest: complete.manifest,
    journal: complete.journal,
    diagnostics: complete.diagnostics,
  };
}

export interface RemoveRuntimeOptions {
  readonly version: string;
  readonly dataDir?: string;
  /** Caller-provided live workspace/runtime references. Unknown is not empty. */
  readonly activeReferences?: readonly string[];
}

export interface RemoveRuntimeResult {
  readonly ok: boolean;
  readonly status:
    'removed' | 'missing' | 'in-use' | 'locked' | 'corrupt' | 'failed';
  readonly runtimeRoot: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly residualPaths: readonly string[];
}

export async function removeRuntime(
  options: RemoveRuntimeOptions,
): Promise<RemoveRuntimeResult> {
  const dataDir = resolve(options.dataDir ?? resolveUserDataDir());
  const paths = runtimePaths(options.version, dataDir);
  if (!validVersion(options.version)) {
    return {
      ok: false,
      status: 'corrupt',
      runtimeRoot: paths.runtimeRoot,
      diagnostics: [
        createDiagnostic({
          code: diagnosticCodes.initApplyFailed,
          severity: 'error',
          message: `Invalid runtime version: ${options.version}`,
          source: paths.runtimeRoot,
          hint: 'Use a plain exact version without path separators.',
        }),
      ],
      residualPaths: [],
    };
  }
  const references = options.activeReferences ?? [];
  if (references.length > 0 || options.activeReferences === undefined) {
    return {
      ok: false,
      status: 'in-use',
      runtimeRoot: paths.runtimeRoot,
      diagnostics: [
        createDiagnostic({
          code: diagnosticCodes.initApplyResidual,
          severity: 'error',
          message:
            options.activeReferences === undefined
              ? 'Runtime removal requires an explicit active-reference check.'
              : `Runtime is referenced by ${references.length} active workspace(s).`,
          source: paths.runtimeRoot,
          hint: 'Resolve active references and retry; Pappra does not guess that a runtime is unused.',
        }),
      ],
      residualPaths: [],
    };
  }
  const state = await inspectRuntimeState(options.version, dataDir);
  if (state.status === 'missing') {
    return {
      ok: true,
      status: 'missing',
      runtimeRoot: paths.runtimeRoot,
      diagnostics: [],
      residualPaths: [],
    };
  }
  if (state.status === 'locked' || state.status === 'partial') {
    return {
      ok: false,
      status: state.status === 'locked' ? 'locked' : 'corrupt',
      runtimeRoot: paths.runtimeRoot,
      diagnostics: state.diagnostics,
      residualPaths: [],
    };
  }
  if (state.status !== 'complete' || state.manifest === null) {
    return {
      ok: false,
      status: 'corrupt',
      runtimeRoot: paths.runtimeRoot,
      diagnostics: state.diagnostics,
      residualPaths: [],
    };
  }
  try {
    await rm(paths.runtimeRoot, { recursive: true, force: false });
    return {
      ok: true,
      status: 'removed',
      runtimeRoot: paths.runtimeRoot,
      diagnostics: [],
      residualPaths: [],
    };
  } catch (error) {
    return {
      ok: false,
      status: 'failed',
      runtimeRoot: paths.runtimeRoot,
      diagnostics: [
        createDiagnostic({
          code: diagnosticCodes.initApplyResidual,
          severity: 'error',
          message: `Runtime removal failed: ${errorMessage(error)}`,
          source: paths.runtimeRoot,
          hint: 'Inspect the runtime directory and permissions; it was not reported as removed.',
        }),
      ],
      residualPaths: [paths.runtimeRoot],
    };
  }
}

export type RuntimePassiveStatus =
  | 'missing'
  | 'content-match'
  | 'version-mismatch'
  | 'corrupt'
  | 'locked'
  | 'partial'
  | 'unreadable';

export interface PassiveRuntimeState {
  readonly version: string;
  readonly status: RuntimePassiveStatus;
  readonly runtimeRoot: string;
  readonly manifest: RuntimeManifest | null;
  readonly journal: InstallJournal | null;
  readonly lockPath: string;
  readonly lockPresent: boolean;
  readonly packageDigestMatch: boolean;
  readonly executableExists: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

/** Read-only runtime state inspection. It never executes the installed CLI. */
export async function inspectRuntimeStatePassive(
  version: string,
  dataDir = resolveUserDataDir(),
): Promise<PassiveRuntimeState> {
  const paths = runtimePaths(version, dataDir);
  if (!validVersion(version)) {
    return {
      version,
      status: 'unreadable',
      runtimeRoot: paths.runtimeRoot,
      manifest: null,
      journal: null,
      lockPath: paths.lockPath,
      lockPresent: false,
      packageDigestMatch: false,
      executableExists: false,
      diagnostics: [
        createDiagnostic({
          code: diagnosticCodes.initApplyFailed,
          severity: 'error',
          message: `Invalid runtime version: ${version}`,
          source: paths.runtimeRoot,
          hint: 'Inspect the workspace runtimeVersion; it is not a safe exact version.',
        }),
      ],
    };
  }
  const lock = await observePath(paths.lockPath);
  const lockPresent = lock.kind !== 'missing';
  const journalScan = await scanRuntimeJournals(version, paths);
  if (journalScan.unreadable.length > 0) {
    return {
      version,
      status: 'unreadable',
      runtimeRoot: paths.runtimeRoot,
      manifest: null,
      journal: null,
      lockPath: paths.lockPath,
      lockPresent,
      packageDigestMatch: false,
      executableExists: false,
      diagnostics: [
        createDiagnostic({
          code: diagnosticCodes.initApplyResidual,
          severity: 'error',
          message: `Runtime journals are unreadable or incompatible: ${journalScan.unreadable.join(', ')}`,
          source: paths.journalsDir,
          hint: 'Inspect the listed journals; doctor treats them as unknown state and does not ignore them.',
        }),
      ],
    };
  }
  const journal = journalScan.journal;
  if (lockPresent) {
    return {
      version,
      status: 'locked',
      runtimeRoot: paths.runtimeRoot,
      manifest: null,
      journal,
      lockPath: paths.lockPath,
      lockPresent,
      packageDigestMatch: false,
      executableExists: false,
      diagnostics: [
        createDiagnostic({
          code: diagnosticCodes.initApplyResidual,
          severity: 'warning',
          message: `Runtime installation lock exists: ${paths.lockPath}`,
          source: paths.lockPath,
          hint: 'Inspect the lock owner; Pappra does not reclaim it by age or through doctor.',
        }),
      ],
    };
  }
  if (journal !== null) {
    return {
      version,
      status: 'partial',
      runtimeRoot: paths.runtimeRoot,
      manifest: null,
      journal,
      lockPath: paths.lockPath,
      lockPresent,
      packageDigestMatch: false,
      executableExists: false,
      diagnostics: [
        createDiagnostic({
          code: diagnosticCodes.initApplyResidual,
          severity: 'warning',
          message: `Runtime installation journal is not complete: ${join(paths.journalsDir, `${journal.installId}.json`)}`,
          source: paths.runtimeRoot,
          hint: 'Inspect the journal; no automatic retry or cleanup is performed.',
        }),
      ],
    };
  }
  const runtimeObservation = await observePath(paths.runtimeRoot);
  if (runtimeObservation.kind === 'missing') {
    return {
      version,
      status: 'missing',
      runtimeRoot: paths.runtimeRoot,
      manifest: null,
      journal: null,
      lockPath: paths.lockPath,
      lockPresent,
      packageDigestMatch: false,
      executableExists: false,
      diagnostics: [],
    };
  }
  if (runtimeObservation.kind !== 'directory') {
    return {
      version,
      status: 'corrupt',
      runtimeRoot: paths.runtimeRoot,
      manifest: null,
      journal: null,
      lockPath: paths.lockPath,
      lockPresent,
      packageDigestMatch: false,
      executableExists: false,
      diagnostics: [
        createDiagnostic({
          code: diagnosticCodes.initApplyFailed,
          severity: 'error',
          message: `Runtime path is not a directory: ${paths.runtimeRoot}`,
          source: paths.runtimeRoot,
          hint: 'Inspect or remove the path explicitly; doctor does not delete it.',
        }),
      ],
    };
  }
  const runtimeReal = await resolveRealpath(paths.runtimeRoot);
  const manifestPath = join(paths.runtimeRoot, 'install-manifest.json');
  const manifestReal = await resolveRealpath(manifestPath);
  if (
    runtimeReal === null ||
    (manifestReal !== null && !isPathInside(runtimeReal, manifestReal))
  ) {
    return {
      version,
      status: 'corrupt',
      runtimeRoot: paths.runtimeRoot,
      manifest: null,
      journal: null,
      lockPath: paths.lockPath,
      lockPresent,
      packageDigestMatch: false,
      executableExists: false,
      diagnostics: [
        createDiagnostic({
          code: diagnosticCodes.initApplyFailed,
          severity: 'error',
          message:
            'Runtime root or manifest path escapes the runtime directory.',
          source: manifestPath,
          hint: 'Inspect the runtime; doctor does not read through symlinked state paths.',
        }),
      ],
    };
  }
  const manifestRead = await readJsonDocument(
    manifestPath,
    runtimeManifestSchema,
  );
  if (!manifestRead.exists || manifestRead.value === null) {
    return {
      version,
      status: manifestRead.exists ? 'unreadable' : 'corrupt',
      runtimeRoot: paths.runtimeRoot,
      manifest: null,
      journal: null,
      lockPath: paths.lockPath,
      lockPresent,
      packageDigestMatch: false,
      executableExists: false,
      diagnostics:
        manifestRead.diagnostics.length > 0
          ? manifestRead.diagnostics
          : [
              createDiagnostic({
                code: diagnosticCodes.initApplyFailed,
                severity: 'error',
                message: `Runtime manifest is missing: ${paths.runtimeRoot}`,
                source: paths.runtimeRoot,
                hint: 'Inspect the partial runtime; doctor does not overwrite it.',
              }),
            ],
    };
  }
  const manifest = manifestRead.value;
  if (manifest.runtimeVersion !== version) {
    return {
      version,
      status: 'version-mismatch',
      runtimeRoot: paths.runtimeRoot,
      manifest,
      journal: null,
      lockPath: paths.lockPath,
      lockPresent,
      packageDigestMatch: false,
      executableExists: false,
      diagnostics: [
        createDiagnostic({
          code: diagnosticCodes.initApplyFailed,
          severity: 'error',
          message: `Runtime manifest reports ${manifest.runtimeVersion}, expected ${version}.`,
          source: paths.runtimeRoot,
          hint: 'Inspect the runtime version and workspace target; doctor does not change either.',
        }),
      ],
    };
  }
  if (
    manifest.packageName !== 'pappra' ||
    manifest.runtimeRoot !== paths.runtimeRoot
  ) {
    return {
      version,
      status: 'corrupt',
      runtimeRoot: paths.runtimeRoot,
      manifest,
      journal: null,
      lockPath: paths.lockPath,
      lockPresent,
      packageDigestMatch: false,
      executableExists: false,
      diagnostics: [
        createDiagnostic({
          code: diagnosticCodes.initApplyFailed,
          severity: 'error',
          message:
            'Runtime manifest identity does not match the requested runtime.',
          source: paths.runtimeRoot,
          hint: 'Inspect the runtime; doctor does not adopt a mismatched manifest.',
        }),
      ],
    };
  }
  const packageRoot = join(paths.runtimeRoot, 'node_modules', 'pappra');
  const packageObservation = await observePath(packageRoot);
  const packageReal =
    packageObservation.kind === 'directory'
      ? await resolveRealpath(packageRoot)
      : null;
  if (
    runtimeReal === null ||
    packageReal === null ||
    !isPathInside(runtimeReal, packageReal)
  ) {
    return {
      version,
      status: 'corrupt',
      runtimeRoot: paths.runtimeRoot,
      manifest,
      journal: null,
      lockPath: paths.lockPath,
      lockPresent,
      packageDigestMatch: false,
      executableExists: false,
      diagnostics: [
        createDiagnostic({
          code: diagnosticCodes.initApplyFailed,
          severity: 'error',
          message:
            'Runtime package path is missing or escapes the runtime directory.',
          source: packageRoot,
          hint: 'Inspect the runtime; doctor does not read through symlinked package paths.',
        }),
      ],
    };
  }
  const executableObservation = await observePath(manifest.executable);
  const executableReal = await resolveRealpath(manifest.executable);
  const executableInsideRuntime =
    executableReal !== null &&
    isPathInside(runtimeReal, executableReal) &&
    isPathInside(paths.runtimeRoot, manifest.executable);
  const packageManifest = await readPackageManifest(packageRoot, runtimeReal);
  const digest = await packageDigest(packageRoot).catch(() => null);
  const packageDigestMatch =
    digest !== null &&
    digest === manifest.packageDigest &&
    packageObservation.kind === 'directory' &&
    packageManifest !== null &&
    packageManifest.name === 'pappra' &&
    packageManifest.version === version;
  const executableExists =
    executableInsideRuntime && executableObservation.kind === 'file';
  if (!packageDigestMatch || !executableExists) {
    return {
      version,
      status: 'corrupt',
      runtimeRoot: paths.runtimeRoot,
      manifest,
      journal: null,
      lockPath: paths.lockPath,
      lockPresent,
      packageDigestMatch,
      executableExists,
      diagnostics: [
        createDiagnostic({
          code: diagnosticCodes.initApplyFailed,
          severity: 'error',
          message:
            'Runtime content or executable no longer matches its manifest.',
          source: paths.runtimeRoot,
          hint: 'Inspect the runtime; doctor does not reinstall or overwrite it.',
        }),
      ],
    };
  }
  return {
    version,
    status: 'content-match',
    runtimeRoot: paths.runtimeRoot,
    manifest,
    journal: null,
    lockPath: paths.lockPath,
    lockPresent,
    packageDigestMatch,
    executableExists,
    diagnostics: [],
  };
}
