import { cp, mkdir } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  observePath,
  readTextFileBounded,
  resolveRealpath,
} from '../infra/fs.js';
import { isPathInside, samePath } from '../schemas/paths.js';

const NODE_MODULES = 'node_modules';
const DEFAULT_MAX_PACKAGES = 512;

export interface PackageDependencyManifest {
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

function packageDependencyNames(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const entries = Object.entries(value);
  if (
    entries.some(
      ([name, range]) =>
        !/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(name) ||
        typeof range !== 'string',
    )
  ) {
    return null;
  }
  return entries.map(([name]) => name);
}

/** Reads the declared dependency names of one package without guessing ranges. */
export async function readPackageDependencyManifest(
  packageRoot: string,
): Promise<PackageDependencyManifest | null> {
  const manifestRead = await readTextFileBounded(
    join(packageRoot, 'package.json'),
  );
  if (!manifestRead.ok) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(manifestRead.value.text);
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null) return null;
  const manifest = decoded as {
    readonly dependencies?: unknown;
    readonly optionalDependencies?: unknown;
  };
  const required = packageDependencyNames(manifest.dependencies);
  const optional = packageDependencyNames(manifest.optionalDependencies);
  if (required === null || optional === null) return null;
  return { required, optional };
}

/**
 * Resolves the exact installed copy that Node would load for `name` from
 * `packageRoot`, walking the same ancestor chain Node resolves through. Every
 * candidate is realpath-resolved and name-checked so a symlinked store entry or
 * a mismatched directory is never mistaken for the requested dependency.
 */
export async function resolveInstalledDependency(
  packageRoot: string,
  name: string,
): Promise<string | null> {
  let current = packageRoot;
  while (true) {
    const candidate = join(current, NODE_MODULES, ...name.split('/'));
    const realPath = await resolveRealpath(candidate);
    if (
      realPath !== null &&
      (await observePath(realPath)).kind === 'directory'
    ) {
      const manifestRead = await readTextFileBounded(
        join(realPath, 'package.json'),
      );
      if (manifestRead.ok) {
        try {
          const decoded: unknown = JSON.parse(manifestRead.value.text);
          if (
            typeof decoded === 'object' &&
            decoded !== null &&
            'name' in decoded &&
            decoded.name === name
          ) {
            return realPath;
          }
        } catch {
          return null;
        }
      }
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export interface DependencyMaterialization {
  readonly ok: boolean;
  /** Destination directories created by this run, in copy order. */
  readonly copied: readonly string[];
  /** Destination slots satisfied by an already-materialized exact copy. */
  readonly reused: readonly string[];
  /** Optional dependencies that are absent from the installed tree. */
  readonly skippedOptional: readonly string[];
  /** Problems that make the materialized tree unsafe to publish. */
  readonly problems: readonly string[];
}

export interface MaterializeDependenciesOptions {
  readonly sourceRoot: string;
  readonly targetRoot: string;
  /** Upper bound on visited packages; guards against pathological trees. */
  readonly maxPackages?: number;
}

interface PlacementInput {
  readonly placements: Map<string, string>;
  readonly reservations: Map<string, Set<string | null>>;
  readonly targetRoot: string;
  readonly destination: string;
  readonly name: string;
  readonly dependencyRoot: string;
}

type Placement =
  | { readonly kind: 'placed'; readonly slot: string }
  | { readonly kind: 'reused'; readonly slot: string }
  | { readonly kind: 'conflict' };

/**
 * Chooses where one exact dependency belongs inside the destination tree.
 *
 * The slot must sit at the highest ancestor that is not shadowed by a different
 * exact source: Node resolves `node_modules/<name>` from the nearest ancestor
 * outwards, so a nearer conflicting placement forces a nested copy, while a free
 * chain up to the target root allows one shared copy at the highest ancestor.
 */
function choosePlacement(input: PlacementInput): Placement {
  let candidate: string | null = null;
  for (const slot of resolutionSlots(
    input.destination,
    input.targetRoot,
    input.name,
  )) {
    const reserved = input.reservations.get(slot);
    if (
      reserved &&
      [...reserved].some((source) => source !== input.dependencyRoot)
    )
      break;
    const placed = input.placements.get(slot);
    if (placed === input.dependencyRoot) return { kind: 'reused', slot };
    if (placed !== undefined) break;
    candidate = slot;
  }
  return candidate === null
    ? { kind: 'conflict' }
    : { kind: 'placed', slot: candidate };
}

function resolutionSlots(
  destination: string,
  targetRoot: string,
  name: string,
): string[] {
  const slots: string[] = [];
  let directory = destination;
  while (true) {
    // Node never appends `node_modules` to a directory that already is one, so
    // such an ancestor is walked through but never offered as a placement slot.
    if (basename(directory) !== NODE_MODULES)
      slots.push(join(directory, NODE_MODULES, ...name.split('/')));
    if (samePath(directory, targetRoot)) break;
    const parent = dirname(directory);
    if (parent === directory || !isPathInside(targetRoot, parent)) break;
    directory = parent;
  }
  return slots;
}

/** Empty nearer slots must not later shadow a consumer's already chosen copy. */
function reserveResolution(
  reservations: Map<string, Set<string | null>>,
  slots: readonly string[],
  source: string | null,
  resolvedSlot?: string,
): void {
  for (const slot of slots) {
    const expected = reservations.get(slot) ?? new Set<string | null>();
    expected.add(source);
    reservations.set(slot, expected);
    if (slot === resolvedSlot) break;
  }
}

/**
 * Payload paths never include a nested `node_modules`: that subtree belongs to
 * another resolver and is materialized explicitly from its own exact source.
 */
function isPayloadPath(sourceRoot: string, candidate: string): boolean {
  const path = relative(sourceRoot, candidate);
  if (path === '') return true;
  return !path.split(sep).includes(NODE_MODULES);
}

/**
 * Copies a regular package payload without nested dependency trees. Reject links
 * before publication rather than copying a store/absolute target or silently
 * producing an unusable runtime.
 */
async function copyPackagePayload(
  sourceRoot: string,
  destination: string,
): Promise<boolean> {
  const existing = await observePath(destination);
  if (existing.kind !== 'missing') return false;
  try {
    await cp(sourceRoot, destination, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      force: false,
      errorOnExist: false,
      filter: async (candidate) => {
        if (!isPayloadPath(sourceRoot, candidate)) return false;
        const entry = await observePath(candidate);
        if (entry.kind !== 'file' && entry.kind !== 'directory')
          throw new Error('Dependency payload contains a link or special file');
        return true;
      },
    });
  } catch {
    return false;
  }
  return true;
}

interface PendingPackage {
  readonly packageRoot: string;
  readonly destination: string;
}

/**
 * Materializes the installed dependency closure of `sourceRoot` under
 * `targetRoot/node_modules`, reusing exact resolved copies at the highest
 * non-shadowed ancestor. Required dependencies must resolve; absent optional
 * dependencies are skipped. The result is a plain report: callers decide whether
 * an incomplete closure is fatal or a reason to fall back to a package manager.
 */
export async function materializeInstalledDependencies(
  options: MaterializeDependenciesOptions,
): Promise<DependencyMaterialization> {
  const copied: string[] = [];
  const reused: string[] = [];
  const skippedOptional: string[] = [];
  const problems: string[] = [];
  const placements = new Map<string, string>();
  const reservations = new Map<string, Set<string | null>>();
  const sourceRoot =
    (await resolveRealpath(options.sourceRoot)) ?? resolve(options.sourceRoot);
  const targetRoot = resolve(options.targetRoot);
  const limit = options.maxPackages ?? DEFAULT_MAX_PACKAGES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096)
    return {
      ok: false,
      copied,
      reused,
      skippedOptional,
      problems: ['invalid_package_limit'],
    };
  const pending: PendingPackage[] = [
    { packageRoot: sourceRoot, destination: targetRoot },
  ];
  let index = 0;

  while (index < pending.length) {
    if (index >= limit) {
      problems.push(`package_limit:${String(limit)}`);
      break;
    }
    const current = pending[index];
    index += 1;
    if (current === undefined) break;
    const manifest = await readPackageDependencyManifest(current.packageRoot);
    if (manifest === null) {
      problems.push(`manifest_unreadable:${current.packageRoot}`);
      continue;
    }
    const declared: { readonly name: string; readonly optional: boolean }[] =
      [];
    for (const name of manifest.required) {
      if (declared.some((entry) => entry.name === name)) continue;
      declared.push({ name, optional: false });
    }
    for (const name of manifest.optional) {
      if (declared.some((entry) => entry.name === name)) continue;
      declared.push({ name, optional: true });
    }
    for (const entry of declared) {
      const name = entry.name;
      const optional = entry.optional;
      const dependencyRoot = await resolveInstalledDependency(
        current.packageRoot,
        name,
      );
      if (dependencyRoot === null) {
        const slots = resolutionSlots(current.destination, targetRoot, name);
        if (slots.some((slot) => placements.has(slot)))
          problems.push(`missing_dependency_shadowed:${name}`);
        reserveResolution(reservations, slots, null);
        if (optional) {
          skippedOptional.push(name);
          continue;
        }
        problems.push(`dependency_missing:${name}`);
        continue;
      }
      const placement = choosePlacement({
        placements,
        reservations,
        targetRoot,
        destination: current.destination,
        name,
        dependencyRoot,
      });
      if (placement.kind === 'reused') {
        reserveResolution(
          reservations,
          resolutionSlots(current.destination, targetRoot, name),
          dependencyRoot,
          placement.slot,
        );
        reused.push(placement.slot);
        continue;
      }
      if (placement.kind === 'conflict') {
        problems.push(`dependency_slot_conflict:${name}`);
        continue;
      }
      if (!isPathInside(targetRoot, placement.slot)) {
        problems.push(`dependency_placement_escape:${name}`);
        continue;
      }
      await mkdir(dirname(placement.slot), { recursive: true });
      if (!(await copyPackagePayload(dependencyRoot, placement.slot))) {
        problems.push(`dependency_copy_failed:${name}`);
        continue;
      }
      placements.set(placement.slot, dependencyRoot);
      reserveResolution(
        reservations,
        resolutionSlots(current.destination, targetRoot, name),
        dependencyRoot,
        placement.slot,
      );
      copied.push(placement.slot);
      pending.push({
        packageRoot: dependencyRoot,
        destination: placement.slot,
      });
    }
  }

  return {
    ok: problems.length === 0,
    copied,
    reused,
    skippedOptional,
    problems,
  };
}
