import { readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { observePath, resolveRealpath } from '../infra/fs.js';
import {
  inspectPrivateLock,
  type PrivateLockObservation,
} from '../infra/private-lock.js';
import { ensureStatePathBoundary, readJsonDocument } from './ownership.js';

export const archiveIdentitySchema = z.strictObject({
  dev: z.number().int().nonnegative(),
  ino: z.number().int().nonnegative(),
  kind: z.enum(['file', 'directory']),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number(),
  digest: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .nullable(),
});
export const archiveItemSchema = z.strictObject({
  source: z.string().min(1).max(4096),
  destination: z.string().min(1).max(4096),
  identity: archiveIdentitySchema,
});
export const runtimeArchiveReceiptSchema = z.strictObject({
  schema: z.literal('pappra/runtime-archive/1'),
  id: z.uuid(),
  version: z.string().regex(/^[0-9A-Za-z][0-9A-Za-z0-9._+-]{0,127}$/),
  dataDir: z.string(),
  status: z.enum(['prepared', 'complete']),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  reason: z.string().trim().min(1).max(4096),
  forceUnknownReferences: z.literal(true),
  allWritersStopped: z.boolean(),
  references: z.unknown(),
  lock: z.unknown(),
  installIds: z.array(z.uuid()).max(4096),
  items: z.array(archiveItemSchema).max(8194),
});

export function runtimeArchiveDirectory(
  dataDir: string,
  version: string,
): string {
  return join(dataDir, 'runtime-archives', version);
}

/** A pending archive is a fence, including when its owner crashed. */
export class RuntimeArchiveBlockedError extends Error {}

export async function assertRuntimeNotArchiving(
  dataDir: string,
  version: string,
): Promise<void> {
  const root = (await resolveRealpath(dataDir)) ?? resolve(dataDir);
  const directory = runtimeArchiveDirectory(root, version);
  for (const name of ['archive.lock', 'pending.json']) {
    const file = join(directory, name);
    const boundary = await ensureStatePathBoundary(root, file);
    if (!boundary.ok) throw new Error(boundary.message);
    if ((await observePath(file)).kind === 'missing') continue;
    if (name === 'pending.json') {
      const read = await readJsonDocument(file, runtimeArchiveReceiptSchema);
      if (
        read.value?.status === 'complete' &&
        read.value.dataDir === root &&
        read.value.version === version &&
        read.value.completedAt !== null
      )
        continue;
    }
    throw new RuntimeArchiveBlockedError(
      `Runtime archive is pending or unverified; resume runtime archive for ${version}: ${file}`,
    );
  }
}

type ArchiveReceipt = z.infer<typeof runtimeArchiveReceiptSchema>;

export type RuntimeArchiveStatus =
  | 'none'
  | 'complete'
  | 'interrupted'
  | 'in-progress'
  | 'unknown-lock'
  | 'unverified'
  | 'corrupt'
  | 'unreadable';

export interface RuntimeArchiveInspection {
  readonly version: string;
  readonly status: RuntimeArchiveStatus;
  readonly directory: string;
  readonly pendingPath: string;
  readonly lockPath: string;
  readonly runtimeLockPath: string;
  readonly coordinatorLock: PrivateLockObservation;
  readonly runtimeLock: PrivateLockObservation;
  readonly receipt: ArchiveReceipt | null;
  readonly receiptDigest: string | null;
  readonly bundle: string | null;
  readonly permanentReceipt: boolean;
  readonly runtimePresent: boolean;
  readonly itemCount: number;
  readonly movedItems: number;
  readonly remainingItems: number;
  readonly conflictingItems: readonly string[];
  readonly unexpectedEntries: readonly string[];
  readonly problem: string | null;
}

const archiveVersionPattern = /^[0-9A-Za-z][0-9A-Za-z0-9._+-]{0,127}$/;
const archiveInventoryLimit = 4096;
const archiveBundleReceiptScanLimit = 32;

function absentPrivateLock(file: string): PrivateLockObservation {
  return { file, state: 'missing', token: null, digest: null, identity: null };
}

function expectedArchiveSource(
  root: string,
  version: string,
  receipt: ArchiveReceipt,
  source: string,
): boolean {
  if (
    source === join(root, 'runtimes', version) ||
    source === join(root, 'runtimes', '.locks', `${version}.lock`)
  )
    return true;
  return receipt.installIds.some(
    (id) =>
      source === join(root, 'journals', `${id}.json`) ||
      source === join(root, 'runtimes', '.staging', id),
  );
}

function expectedArchiveDestination(
  root: string,
  version: string,
  source: string,
): string {
  if (source === join(root, 'runtimes', version)) return 'runtime';
  if (source === join(root, 'runtimes', '.locks', `${version}.lock`))
    return 'original.lock';
  if (dirname(source) === join(root, 'journals'))
    return `journals/${basename(source)}`;
  return `staging/${basename(source)}`;
}

/**
 * Read-only observation of one runtime archive transaction. It never publishes
 * a lock or receipt, reclaims a lock, signals an owner or moves evidence.
 * Item paths are derived from the data directory and validated against the
 * receipt shape before any observation, so a tampered receipt cannot send the
 * inspector outside the archive namespace.
 */
export async function inspectRuntimeArchiveState(
  dataDir: string,
  version: string,
): Promise<RuntimeArchiveInspection> {
  const root = (await resolveRealpath(dataDir)) ?? resolve(dataDir);
  const directory = runtimeArchiveDirectory(root, version);
  const pendingPath = join(directory, 'pending.json');
  const lockPath = join(directory, 'archive.lock');
  const runtimeRoot = join(root, 'runtimes', version);
  const runtimeLockPath = join(root, 'runtimes', '.locks', `${version}.lock`);
  const runtimeLock = await inspectPrivateLock(runtimeLockPath);
  let coordinatorLock = absentPrivateLock(lockPath);
  let receipt: ArchiveReceipt | null = null;
  let receiptDigest: string | null = null;
  let bundle: string | null = null;
  let permanentReceipt = false;
  let runtimePresent = false;
  let itemCount = 0;
  let movedItems = 0;
  let remainingItems = 0;
  const conflictingItems: string[] = [];
  const unexpectedEntries: string[] = [];
  const settle = (
    status: RuntimeArchiveStatus,
    problem: string | null = null,
  ): RuntimeArchiveInspection => ({
    version,
    status,
    directory,
    pendingPath,
    lockPath,
    runtimeLockPath,
    coordinatorLock,
    runtimeLock,
    receipt,
    receiptDigest,
    bundle,
    permanentReceipt,
    runtimePresent,
    itemCount,
    movedItems,
    remainingItems,
    conflictingItems,
    unexpectedEntries,
    problem,
  });

  if (!archiveVersionPattern.test(version))
    return settle('unreadable', `Invalid runtime version: ${version}`);
  const directoryBoundary = await ensureStatePathBoundary(root, directory);
  if (!directoryBoundary.ok)
    return settle('unreadable', directoryBoundary.message);
  for (const file of [pendingPath, lockPath]) {
    const boundary = await ensureStatePathBoundary(root, file);
    if (!boundary.ok) return settle('unreadable', boundary.message);
  }
  runtimePresent = (await observePath(runtimeRoot)).kind !== 'missing';
  const control = await observePath(directory);
  if (control.kind === 'missing') return settle('none');
  if (control.kind !== 'directory')
    return settle(
      'unreadable',
      `Runtime archive directory is not a real directory: ${directory}`,
    );

  const pendingObservation = await observePath(pendingPath);
  if (
    pendingObservation.kind !== 'missing' &&
    pendingObservation.kind !== 'file'
  )
    return settle(
      'corrupt',
      `Pending archive receipt is not a regular file: ${pendingPath}`,
    );
  const pending =
    pendingObservation.kind === 'file'
      ? await readJsonDocument(pendingPath, runtimeArchiveReceiptSchema)
      : { exists: false, value: null, digest: null, diagnostics: [] };
  receiptDigest = pending.digest;
  coordinatorLock = await inspectPrivateLock(lockPath);
  const names = (await readdir(directory)).sort();
  if (names.length > archiveInventoryLimit)
    return settle(
      'unverified',
      `Archive inventory exceeds ${archiveInventoryLimit} entries.`,
    );
  for (const name of names) {
    if (name === 'pending.json' || name === 'archive.lock') continue;
    if (z.uuid().safeParse(name).success) continue;
    if (name.startsWith('archive.lock.') || name.startsWith('pending.json.'))
      continue;
    if (unexpectedEntries.length < 16) unexpectedEntries.push(name);
  }

  if (pending.exists && pending.value === null)
    return settle(
      'corrupt',
      `Pending archive receipt is unreadable: ${pendingPath}`,
    );

  if (pending.value !== null) {
    const active = pending.value;
    receipt = active;
    if (active.dataDir !== root || active.version !== version)
      return settle(
        'corrupt',
        'Pending archive receipt belongs to a different data directory or runtime.',
      );
    const unsafe =
      new Set(active.items.map((item) => item.source)).size !==
        active.items.length ||
      active.items.some(
        (item) =>
          !expectedArchiveSource(root, version, active, item.source) ||
          item.destination !==
            expectedArchiveDestination(root, version, item.source),
      );
    if (unsafe)
      return settle(
        'corrupt',
        'Pending archive receipt contains an unsafe or duplicate move.',
      );
    itemCount = active.items.length;
    if (active.items.length === 0)
      return settle(
        'unverified',
        'Pending archive receipt declares no evidence items; resume would finalize nothing.',
      );
    const bundlePath = join(directory, active.id);
    bundle = bundlePath;
    if ((await observePath(bundlePath)).kind !== 'directory')
      return settle(
        'corrupt',
        'Archive evidence directory is missing or unsafe; resume refuses it.',
      );

    const permanentPath = join(bundlePath, 'receipt.json');
    const permanentObservation = await observePath(permanentPath);
    if (permanentObservation.kind !== 'missing') {
      if (permanentObservation.kind !== 'file')
        return settle(
          'corrupt',
          `Permanent archive receipt is not a regular file: ${permanentPath}`,
        );
      const permanent = await readJsonDocument(
        permanentPath,
        runtimeArchiveReceiptSchema,
      );
      if (
        permanent.value === null ||
        permanent.value.status !== 'complete' ||
        permanent.value.completedAt === null ||
        permanent.value.id !== active.id ||
        permanent.value.dataDir !== root ||
        permanent.value.version !== version ||
        permanent.value.installIds.length !== active.installIds.length ||
        permanent.value.installIds.some(
          (id, index) => id !== active.installIds[index],
        ) ||
        permanent.value.items.length !== active.items.length ||
        permanent.value.items.some(
          (item, index) =>
            item.source !== active.items[index]!.source ||
            item.destination !== active.items[index]!.destination,
        )
      )
        return settle(
          'corrupt',
          'Permanent archive receipt is unreadable or conflicts with the pending fence.',
        );
      permanentReceipt = true;
    }

    const parents = new Set<string>([
      join(root, 'runtimes'),
      join(root, 'runtimes', '.locks'),
      join(root, 'runtimes', '.staging'),
      join(root, 'journals'),
      bundlePath,
      join(bundlePath, 'journals'),
      join(bundlePath, 'staging'),
    ]);
    for (const parent of parents) {
      const observation = await observePath(parent);
      if (observation.kind === 'missing') continue;
      if (observation.kind !== 'directory')
        return settle(
          'corrupt',
          `Archive evidence parent is not a real directory: ${parent}`,
        );
      const boundary = await ensureStatePathBoundary(root, parent);
      if (!boundary.ok)
        return settle(
          'corrupt',
          'Archive evidence namespace escapes the data directory.',
        );
    }

    for (const item of active.items) {
      const destination = join(bundlePath, item.destination);
      const source = await observePath(item.source);
      const archived = await observePath(destination);
      const sourcePresent = source.kind !== 'missing';
      const archivedPresent = archived.kind !== 'missing';
      if (sourcePresent && archivedPresent) {
        conflictingItems.push(
          `${item.source}: present at both source and archive destination`,
        );
        continue;
      }
      if (!sourcePresent && !archivedPresent) {
        conflictingItems.push(
          `${item.source}: missing from both source and archive destination`,
        );
        continue;
      }
      const present = sourcePresent ? source : archived;
      if (present.kind !== item.identity.kind) {
        conflictingItems.push(`${item.source}: evidence kind changed`);
        continue;
      }
      if (sourcePresent) remainingItems += 1;
      else movedItems += 1;
    }

    if (active.status === 'complete') {
      if (active.completedAt === null)
        return settle(
          'corrupt',
          'Completed archive fence has no completion timestamp.',
        );
      if (conflictingItems.length > 0)
        return settle(
          'unverified',
          'Completed archive evidence changed or is missing; preserve both generations.',
        );
      if (!permanentReceipt)
        return settle(
          'unverified',
          'Pending archive is marked complete but its permanent audit receipt is missing.',
        );
      return settle('complete');
    }
    if (conflictingItems.length > 0)
      return settle(
        'corrupt',
        'Pending archive evidence is missing or duplicated; resume refuses ambiguous identity.',
      );
    if (coordinatorLock.state === 'alive') return settle('in-progress');
    if (coordinatorLock.state === 'unknown')
      return settle(
        'unknown-lock',
        `Archive coordinator ownership is unverified: ${lockPath}`,
      );
    return settle('interrupted');
  }

  if (coordinatorLock.state === 'alive')
    return settle(
      'in-progress',
      'A verified live archive coordinator is active before a durable receipt was published.',
    );
  if (coordinatorLock.state === 'unknown')
    return settle(
      'unknown-lock',
      `Archive coordinator ownership is unverified: ${lockPath}`,
    );
  const bundles = names.filter((name) => z.uuid().safeParse(name).success);
  if (bundles.length > 0) {
    for (const name of bundles.slice(0, archiveBundleReceiptScanLimit)) {
      const candidate = join(directory, name);
      const permanentPath = join(candidate, 'receipt.json');
      const observation = await observePath(permanentPath);
      if (observation.kind === 'missing') continue;
      if (observation.kind !== 'file')
        return settle(
          'corrupt',
          `Archive bundle receipt is not a regular file: ${permanentPath}`,
        );
      const permanent = await readJsonDocument(
        permanentPath,
        runtimeArchiveReceiptSchema,
      );
      if (permanent.value === null)
        return settle(
          'unverified',
          `Archive bundle exists without a readable permanent receipt: ${candidate}`,
        );
      if (
        permanent.value.status === 'complete' &&
        permanent.value.completedAt !== null &&
        permanent.value.dataDir === root &&
        permanent.value.version === version
      ) {
        bundle = candidate;
        receipt = permanent.value;
        receiptDigest = permanent.digest;
        permanentReceipt = true;
        return settle(
          'unverified',
          'A completed archive bundle exists without its pending transaction fence.',
        );
      }
    }
    return settle(
      'unverified',
      'An archive bundle exists without a pending transaction fence.',
    );
  }
  if (unexpectedEntries.length > 0)
    return settle(
      'unverified',
      `Unrecognized entries exist in the archive control directory: ${unexpectedEntries.join(', ')}`,
    );
  return settle(
    'interrupted',
    'The archive control directory exists without a durable transaction receipt.',
  );
}
