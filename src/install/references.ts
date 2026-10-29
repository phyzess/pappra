import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { readdir, unlink } from 'node:fs/promises';
import { z } from 'zod';
import { observePath, resolveRealpath, sha256Digest } from '../infra/fs.js';
import { persistedIdentityMatches } from '../infra/persisted-identity.js';
import {
  inspectMachineConfig,
  inspectWorkspaceConfig,
} from '../workspace/config.js';
import { isPathInside } from '../schemas/paths.js';
import type { RuntimeManifest } from '../schemas/install.js';
import { failed, succeeded, type Outcome } from '../schemas/outcome.js';
import { diagnosticCodes } from '../schemas/errors.js';
import { assertRuntimeNotArchiving } from './runtime-archive-state.js';
import {
  acquireInstallLock,
  ensureStatePathBoundary,
  readJsonDocument,
  releaseInstallLock,
  writeJsonAtomic,
} from './ownership.js';

const referenceSchema = z.strictObject({
  schema: z.literal('pappra/runtime-reference/1'),
  workspaceRoot: z.string().min(1).max(4096).refine(isAbsolute),
  workspaceId: z.uuid(),
  rootIdentity: z.strictObject({
    dev: z.number().int().nonnegative().optional(),
    ino: z.number().int().nonnegative(),
  }),
  intendedRuntime: z.strictObject({
    version: z.string().min(1).max(128),
    executable: z.string().min(1).max(4096),
    runtimeRoot: z.string().min(1).max(4096),
  }),
  registeredAt: z.iso.datetime({ offset: true }),
});
type RuntimeReference = z.infer<typeof referenceSchema>;

const referenceNamePattern = /^sha256-[0-9a-f]{64}\.json$/;

interface RegistryRecord {
  readonly name: string;
  readonly entry: RuntimeReference;
}

/** Validated records of this registry. Foreign or unparsable files are never records. */
async function readRegistryRecords(
  directory: string,
): Promise<readonly RegistryRecord[]> {
  let names: string[];
  try {
    names = (await readdir(directory)).sort();
  } catch {
    return [];
  }
  // Cleanup never enumerates an unbounded directory; inspection bounds it too.
  if (names.length > 4096) return [];
  const records: RegistryRecord[] = [];
  for (const name of names) {
    if (!referenceNamePattern.test(name)) continue;
    const read = await readJsonDocument(join(directory, name), referenceSchema);
    // A record that cannot be parsed is preserved and reported by inspection.
    if (!read.value) continue;
    records.push({ name, entry: read.value });
  }
  return records;
}

/** Valid records this registration replaces: same workspace root, id and inode. */
function supersededReferenceNames(
  records: readonly RegistryRecord[],
  entry: RuntimeReference,
  keepName: string,
): string[] {
  return records
    .filter(
      (record) =>
        record.name !== keepName &&
        record.entry.workspaceRoot === entry.workspaceRoot &&
        record.entry.workspaceId === entry.workspaceId &&
        persistedIdentityMatches(record.entry.rootIdentity, entry.rootIdentity),
    )
    .map((record) => record.name);
}

/** Removes only names this call already validated as records of this registry. */
async function removeReferenceRecords(
  directory: string,
  names: readonly string[],
): Promise<Outcome<null>> {
  for (const name of names) {
    if (!referenceNamePattern.test(name))
      return failed(
        diagnosticCodes.initApplyResidual,
        `Refusing to remove an unrecognised runtime reference entry: ${name}`,
      );
    try {
      await unlink(join(directory, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return failed(
        diagnosticCodes.initApplyResidual,
        `The superseded runtime reference could not be removed: ${name}`,
        {
          nextAction:
            'Inspect the runtime reference registry; the new record is already published.',
        },
      );
    }
  }
  return succeeded(null);
}

export interface RuntimeReferenceReport {
  readonly coverage: 'registered-workspaces-only';
  readonly active: readonly {
    workspaceRoot: string;
    workspaceId: string;
    executable: string;
  }[];
  readonly unknown: readonly string[];
  /** A registry never proves that no unregistered workspace exists. */
  readonly unregisteredCoverage: 'unknown';
}

export function runtimeReferencesDirectory(dataDir: string): string {
  return join(resolve(dataDir), 'runtime-references');
}

/** Keep a binding protective when corruption removed its executable or parent.
 * Resolve only existing ancestors; never follow a broken/unknown symlink. */
async function resolveBindingPath(path: string): Promise<string | null> {
  let current = resolve(path);
  const missing: string[] = [];
  for (let depth = 0; depth < 256; depth += 1) {
    const observation = await observePath(current).catch(() => null);
    if (observation?.kind !== 'missing') {
      const real = await resolveRealpath(current);
      return real === null ? null : resolve(real, ...missing);
    }
    const parent = dirname(current);
    if (parent === current) return null;
    missing.unshift(basename(current));
    current = parent;
  }
  return null;
}

/** Lexical and real-path aliases of the same global data directory are one runtime. */
export async function runtimeBindingMatches(
  dataDir: string,
  version: string,
  binding:
    | { readonly version: string; readonly executable: string }
    | null
    | undefined,
): Promise<boolean> {
  if (binding?.version !== version) return false;
  const target = join(resolve(dataDir), 'runtimes', version);
  const executable = resolve(binding.executable);
  if (isPathInside(target, executable)) return true;
  const realTarget = await resolveBindingPath(target);
  const realExecutable = await resolveBindingPath(executable);
  return (
    realTarget !== null &&
    realExecutable !== null &&
    isPathInside(realTarget, realExecutable)
  );
}

/** Reads only explicitly registered roots. No home-directory discovery occurs. */
export async function inspectRuntimeReferences(
  dataDir: string,
  version: string,
): Promise<RuntimeReferenceReport> {
  const active: {
    workspaceRoot: string;
    workspaceId: string;
    executable: string;
  }[] = [];
  const unknown: string[] = [];
  const listed = new Set<string>();
  const canonicalDataDir = (await resolveRealpath(dataDir)) ?? resolve(dataDir);
  const directory = runtimeReferencesDirectory(canonicalDataDir);
  const report = (): RuntimeReferenceReport => ({
    coverage: 'registered-workspaces-only',
    active,
    unknown,
    unregisteredCoverage: 'unknown',
  });
  const boundary = await ensureStatePathBoundary(canonicalDataDir, directory);
  if (!boundary.ok) {
    unknown.push('registry_path_unsafe');
    return report();
  }
  const presence = await observePath(directory).catch(() => null);
  if (presence?.kind === 'missing') {
    unknown.push('registry_missing');
    return report();
  }
  if (presence?.kind !== 'directory') {
    unknown.push('registry_unreadable_or_redirected');
    return report();
  }
  let names: string[];
  try {
    names = (await readdir(directory)).sort();
  } catch {
    unknown.push('registry_unreadable');
    return report();
  }
  if (names.length > 4096) {
    unknown.push('registry_entry_limit');
    return report();
  }
  for (const name of names) {
    if (!referenceNamePattern.test(name)) {
      unknown.push('unexpected_registry_entry');
      continue;
    }
    const read = await readJsonDocument(join(directory, name), referenceSchema);
    if (!read.value) {
      unknown.push(`reference_unreadable:${name}`);
      continue;
    }
    const entry = read.value;
    const root = await observePath(entry.workspaceRoot).catch(() => null);
    const canonical = await resolveRealpath(entry.workspaceRoot);
    if (
      root?.kind !== 'directory' ||
      !root.stats ||
      canonical !== entry.workspaceRoot ||
      !persistedIdentityMatches(entry.rootIdentity, root.stats)
    ) {
      unknown.push(`workspace_missing_or_replaced:${name}`);
      continue;
    }
    const workspace = await inspectWorkspaceConfig(entry.workspaceRoot);
    if (workspace.value?.workspaceId !== entry.workspaceId) {
      unknown.push(`workspace_identity_unknown:${name}`);
      continue;
    }
    const machine = await inspectMachineConfig(entry.workspaceRoot);
    if (!machine.value) {
      unknown.push(`machine_binding_unknown:${name}`);
      continue;
    }
    const binding = machine.value.runtime;
    if (!binding || !(await runtimeBindingMatches(dataDir, version, binding)))
      continue;
    const workspaceKey = JSON.stringify([
      entry.workspaceRoot,
      entry.workspaceId,
    ]);
    // A superseded legacy record can still name this same workspace; report
    // each workspace once instead of failing on the duplicate.
    if (listed.has(workspaceKey)) continue;
    listed.add(workspaceKey);
    active.push({
      workspaceRoot: entry.workspaceRoot,
      workspaceId: entry.workspaceId,
      executable: binding.executable,
    });
  }
  return report();
}

export interface RuntimeReferenceLease {
  readonly path: string;
  readonly lockPath: string;
  readonly release: () => Promise<Outcome<null>>;
}

/**
 * Publish before machine binding while holding the runtime's deletion/install
 * lock. A crash cannot create a new binding absent from the explicit registry.
 */
export async function beginRuntimeReference(
  root: string,
  runtime: RuntimeManifest,
): Promise<Outcome<RuntimeReferenceLease>> {
  const canonical = await resolveRealpath(root);
  const observation =
    canonical === null ? null : await observePath(canonical).catch(() => null);
  const workspace =
    canonical === null ? null : await inspectWorkspaceConfig(canonical);
  if (
    !canonical ||
    observation?.kind !== 'directory' ||
    !observation.stats ||
    !workspace?.value
  )
    return failed(
      diagnosticCodes.initPlanStale,
      'Cannot register a runtime reference for an unverified workspace root.',
    );
  const selectedDataDir = dirname(dirname(resolve(runtime.runtimeRoot)));
  if (
    join(selectedDataDir, 'runtimes', runtime.runtimeVersion) !==
      resolve(runtime.runtimeRoot) ||
    !isPathInside(runtime.runtimeRoot, runtime.executable)
  )
    return failed(
      diagnosticCodes.initTargetUnsafe,
      'Runtime reference is not inside its exact version directory.',
    );
  const dataDir = (await resolveRealpath(selectedDataDir)) ?? selectedDataDir;
  try {
    await assertRuntimeNotArchiving(dataDir, runtime.runtimeVersion);
  } catch (error) {
    return failed(diagnosticCodes.initApplyResidual, (error as Error).message);
  }
  const lockPath = join(
    dataDir,
    'runtimes',
    '.locks',
    `${runtime.runtimeVersion}.lock`,
  );
  const entry: RuntimeReference = {
    schema: 'pappra/runtime-reference/1',
    workspaceRoot: canonical,
    workspaceId: workspace.value.workspaceId,
    rootIdentity: { dev: observation.stats.dev, ino: observation.stats.ino },
    intendedRuntime: {
      version: runtime.runtimeVersion,
      executable: runtime.executable,
      runtimeRoot: runtime.runtimeRoot,
    },
    registeredAt: new Date().toISOString(),
  };
  const key = sha256Digest(
    JSON.stringify([canonical, entry.workspaceId, entry.rootIdentity.ino]),
  ).replace(':', '-');
  const directory = runtimeReferencesDirectory(dataDir);
  const name = `${key}.json`;
  const path = join(directory, name);
  const boundary = await ensureStatePathBoundary(dataDir, path);
  if (!boundary.ok) return boundary;
  let existing = await readJsonDocument(path, referenceSchema);
  const unchanged =
    existing.value &&
    existing.value.workspaceRoot === canonical &&
    existing.value.workspaceId === entry.workspaceId &&
    persistedIdentityMatches(existing.value.rootIdentity, entry.rootIdentity) &&
    JSON.stringify(existing.value.intendedRuntime) ===
      JSON.stringify(entry.intendedRuntime);
  if (unchanged && (await observePath(lockPath)).kind === 'missing') {
    const machine = await inspectMachineConfig(canonical);
    if (
      machine.value?.runtime?.version === runtime.runtimeVersion &&
      machine.value.runtime.executable === runtime.executable &&
      supersededReferenceNames(
        await readRegistryRecords(directory),
        entry,
        name,
      ).length === 0
    ) {
      // This binding is already published and protected from deletion by its
      // verified registry entry. A read-only repeat needs no registration lease.
      return succeeded({
        path,
        lockPath,
        release: async () => succeeded(null),
      });
    }
  }
  const lock = await acquireInstallLock(
    lockPath,
    'update-machine-runtime',
    runtime.runtimeRoot,
    dataDir,
  );
  if (!lock.ok || !lock.lock)
    return failed(
      diagnosticCodes.initApplyResidual,
      lock.message ?? 'Runtime reference registration is locked.',
    );
  const release = () => releaseInstallLock(lockPath, lock.lock!.token);
  try {
    await assertRuntimeNotArchiving(dataDir, runtime.runtimeVersion);
  } catch (error) {
    await release();
    return failed(diagnosticCodes.initApplyResidual, (error as Error).message);
  }
  existing = await readJsonDocument(path, referenceSchema);
  if (
    existing.exists &&
    (!existing.value ||
      existing.value.workspaceRoot !== canonical ||
      existing.value.workspaceId !== entry.workspaceId ||
      !persistedIdentityMatches(
        existing.value.rootIdentity,
        entry.rootIdentity,
      ))
  ) {
    await release();
    return failed(
      diagnosticCodes.initApplyResidual,
      'Existing runtime reference is unreadable or belongs to another workspace identity; it was preserved.',
    );
  }
  const superseded = supersededReferenceNames(
    await readRegistryRecords(directory),
    entry,
    name,
  );
  if (
    existing.value &&
    JSON.stringify(existing.value.intendedRuntime) ===
      JSON.stringify(entry.intendedRuntime)
  ) {
    const cleaned = await removeReferenceRecords(directory, superseded);
    if (!cleaned.ok) {
      await release();
      return cleaned;
    }
    return succeeded({ path, lockPath, release });
  }
  const written = await writeJsonAtomic(path, entry, dataDir);
  if (!written.ok) {
    await release();
    return written;
  }
  const cleaned = await removeReferenceRecords(directory, superseded);
  if (!cleaned.ok) {
    await release();
    return cleaned;
  }
  return succeeded({ path, lockPath, release });
}
