import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, rename } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { observePath, resolveRealpath, sha256Digest } from '../infra/fs.js';
import {
  inspectPrivateLock,
  reclaimDeadPrivateLock,
} from '../infra/private-lock.js';
import { captureProcessIdentity } from '../infra/process-identity.js';
import { publishPrivateLock } from '../infra/private-lock.js';
import { installJournalSchema } from '../schemas/install.js';
import { isPathInside } from '../schemas/paths.js';
import { getPackageRoot } from '../package-info.js';
import {
  ensureStatePathBoundary,
  readJsonDocument,
  releaseInstallLock,
} from './ownership.js';
import { persistedIdentityMatches } from '../infra/persisted-identity.js';
import {
  inspectRuntimeReferences,
  runtimeBindingMatches,
} from './references.js';
import { inspectMachineConfig } from '../workspace/config.js';
import {
  runtimeArchiveDirectory,
  runtimeArchiveReceiptSchema as receiptSchema,
  archiveItemSchema as itemSchema,
  archiveIdentitySchema as identitySchema,
} from './runtime-archive-state.js';
type Receipt = z.infer<typeof receiptSchema>;
type Item = z.infer<typeof itemSchema>;
type Identity = z.infer<typeof identitySchema>;

export interface ArchiveRuntimeOptions {
  readonly version: string;
  readonly dataDir: string;
  readonly workspaceRoot?: string;
  readonly installIds?: readonly string[];
  readonly apply?: boolean;
  readonly forceUnknownReferences?: boolean;
  readonly allWritersStopped?: boolean;
  readonly reason?: string;
  /** Dependency seam for hard-crash and race tests; never exposed by the CLI. */
  readonly checkpoint?: (phase: string) => void | Promise<void>;
}

export interface ArchiveRuntimeResult {
  readonly ok: boolean;
  readonly mode: 'plan' | 'apply';
  readonly status: 'planned' | 'blocked' | 'archived' | 'missing' | 'failed';
  readonly archive: string | null;
  readonly archiveDirectory: string | null;
  readonly receipt: string | null;
  readonly resumed: boolean;
  readonly items: readonly Item[];
  readonly references: Awaited<
    ReturnType<typeof inspectRuntimeReferences>
  > | null;
  readonly lock: Awaited<ReturnType<typeof inspectPrivateLock>> | null;
  readonly unselectedJournals: readonly string[];
  readonly blockers: readonly string[];
  readonly errors: readonly string[];
}

async function boundary(root: string, file: string): Promise<void> {
  const result = await ensureStatePathBoundary(root, file);
  if (!result.ok) throw new Error(result.message);
}

async function identify(file: string): Promise<Identity | null> {
  const observation = await observePath(file);
  if (observation.kind === 'missing') return null;
  if (!['file', 'directory'].includes(observation.kind) || !observation.stats)
    throw new Error(`Archive source is redirected or unsafe: ${file}`);
  const stats = observation.stats;
  let digest: string | null = null;
  if (observation.kind === 'file') {
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const actual = await handle.stat();
      if (
        !actual.isFile() ||
        actual.dev !== stats.dev ||
        actual.ino !== stats.ino
      )
        throw new Error(`Archive file changed: ${file}`);
      // Small control files receive a content digest. Larger raw evidence is
      // renamed intact without loading unbounded bytes into memory.
      if (stats.size <= 1024 * 1024) {
        const bytes = Buffer.alloc(stats.size + 1);
        let length = 0;
        while (length < bytes.length) {
          const read = await handle.read(
            bytes,
            length,
            bytes.length - length,
            null,
          );
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (length !== stats.size)
          throw new Error(`Archive file size changed: ${file}`);
        digest = sha256Digest(bytes.subarray(0, length));
      }
    } finally {
      await handle.close();
    }
  }
  return {
    dev: stats.dev,
    ino: stats.ino,
    kind: observation.kind as Identity['kind'],
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    digest,
  };
}

/** Live pins from this invocation keep the full device/inode pair. */
function same(actual: Identity | null, expected: Identity): boolean {
  return (
    actual !== null &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    sameContent(actual, expected)
  );
}

/** A persisted receipt identity ignores the device, which can change across reboots. */
function samePersisted(actual: Identity | null, expected: Identity): boolean {
  return (
    actual !== null &&
    persistedIdentityMatches(actual, expected) &&
    sameContent(actual, expected)
  );
}

function sameContent(actual: Identity, expected: Identity): boolean {
  return (
    actual.kind === expected.kind &&
    (actual.kind === 'directory' ||
      (actual.size === expected.size &&
        actual.mtimeMs === expected.mtimeMs &&
        actual.digest === expected.digest))
  );
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function save(file: string, value: Receipt, root: string): Promise<void> {
  await boundary(root, file);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const completedSize = Buffer.byteLength(
    `${JSON.stringify({ ...value, status: 'complete', completedAt: value.completedAt ?? new Date().toISOString() }, null, 2)}\n`,
  );
  if (Math.max(bytes.length, completedSize) > 1024 * 1024)
    throw new Error(
      'Archive receipt exceeds the 1 MiB recovery limit; no evidence was moved.',
    );
  const temporary = `${file}.pending-${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await boundary(root, file);
  await rename(temporary, file);
  await syncDirectory(dirname(file));
}

/** Raw, evidence-preserving archival. No runtime executable is ever loaded. */
export async function archiveRuntime(
  options: ArchiveRuntimeOptions,
): Promise<ArchiveRuntimeResult> {
  const mode = options.apply ? 'apply' : 'plan';
  let archive: string | null = null;
  let archiveDirectory: string | null = null;
  let receiptFile: string | null = null;
  let resumed = false;
  let items: Item[] = [];
  let references: ArchiveRuntimeResult['references'] = null;
  let lock: ArchiveRuntimeResult['lock'] = null;
  const unselectedJournals: string[] = [];
  const blockers: string[] = [];
  const result = (
    status: ArchiveRuntimeResult['status'],
    errors: string[] = [],
  ): ArchiveRuntimeResult => ({
    ok: ['planned', 'archived', 'missing'].includes(status),
    mode,
    status,
    archive,
    archiveDirectory,
    receipt: receiptFile,
    resumed,
    items,
    references,
    lock,
    unselectedJournals,
    blockers,
    errors,
  });
  try {
    if (!/^[0-9A-Za-z][0-9A-Za-z0-9._+-]{0,127}$/.test(options.version))
      throw new Error(
        'Archive requires an exact runtime version without path separators.',
      );
    const ids = [...new Set(options.installIds ?? [])].sort();
    if (ids.length > 256 || ids.some((id) => !z.uuid().safeParse(id).success))
      throw new Error(
        'Select journal files by exact install UUID (at most 256).',
      );
    const selected = resolve(options.dataDir);
    if (options.reason !== undefined && options.reason.trim().length > 4096)
      throw new Error('Archive reason exceeds 4096 characters.');
    const root = (await resolveRealpath(selected)) ?? selected;
    const version = options.version;
    const runtime = join(root, 'runtimes', version);
    const runtimeLock = join(root, 'runtimes', '.locks', `${version}.lock`);
    const control = runtimeArchiveDirectory(root, version);
    archiveDirectory = control;
    const pendingFile = join(control, 'pending.json');
    const archiveLock = join(control, 'archive.lock');
    const sources = [
      runtime,
      runtimeLock,
      pendingFile,
      archiveLock,
      join(root, 'journals', 'placeholder'),
    ];
    for (const file of sources) await boundary(root, file);
    const pending = await readJsonDocument(pendingFile, receiptSchema);
    if (pending.exists && !pending.value)
      throw new Error(
        'Archive receipt is unreadable; preserved for inspection.',
      );
    let receipt = pending.value;
    if (receipt) {
      if (receipt.dataDir !== root || receipt.version !== version)
        throw new Error(
          'Archive receipt belongs to a different data directory or runtime.',
        );
      archive = join(control, receipt.id);
      receiptFile = join(archive, 'receipt.json');
      const expectedSource = (source: string): boolean =>
        source === runtime ||
        source === runtimeLock ||
        receipt!.installIds.some(
          (id) =>
            source === join(root, 'journals', `${id}.json`) ||
            source === join(root, 'runtimes', '.staging', id),
        );
      const expectedDestination = (source: string): string =>
        source === runtime
          ? 'runtime'
          : source === runtimeLock
            ? 'original.lock'
            : dirname(source) === join(root, 'journals')
              ? `journals/${basename(source)}`
              : `staging/${basename(source)}`;
      if (
        receipt.items.some(
          (item) =>
            !expectedSource(item.source) ||
            item.destination !== expectedDestination(item.source),
        ) ||
        new Set(receipt.items.map((item) => item.source)).size !==
          receipt.items.length
      )
        throw new Error(
          'Archive receipt contains an unsafe or duplicate move.',
        );
      items = receipt.items;
      resumed = true;
      if (
        receipt.status !== 'complete' &&
        ids.some((id) => !receipt!.installIds.includes(id))
      )
        throw new Error(
          'Resume the pending archive with its original journal selection.',
        );
      if (
        receipt.status === 'complete' &&
        ((await identify(runtime)) ||
          ids.some((id) => !receipt!.installIds.includes(id)))
      ) {
        // A later installation is a new generation, never a continuation of
        // an old move. The old bundle and permanent receipt remain untouched.
        for (const item of items)
          if (
            !samePersisted(
              await identify(join(archive, item.destination)),
              item.identity,
            )
          )
            throw new Error(
              'Completed archive evidence changed; preserve both generations.',
            );
        receipt = null;
        items = [];
        resumed = false;
        archive = null;
        receiptFile = null;
      }
    }
    if (!receipt) {
      const add = async (source: string, destination: string) => {
        await boundary(root, source);
        const identity = await identify(source);
        if (identity) items.push({ source, destination, identity });
      };
      await add(runtime, 'runtime');
      const journals = join(root, 'journals');
      const journalDirectory = await observePath(journals);
      if (!['missing', 'directory'].includes(journalDirectory.kind))
        throw new Error('Unsafe journal directory.');
      const names =
        journalDirectory.kind === 'missing'
          ? []
          : (await readdir(journals)).sort();
      if (names.length > 4096)
        throw new Error('Journal inventory exceeds 4096 entries.');
      for (const name of names) {
        const id = name.endsWith('.json') ? name.slice(0, -5) : '';
        const file = join(journals, name);
        if (!z.uuid().safeParse(id).success) {
          unselectedJournals.push(file);
          continue;
        }
        await boundary(root, file);
        const read = await readJsonDocument(file, installJournalSchema);
        const matching =
          read.value?.runtimeVersion === version &&
          read.value.operation === 'install-runtime' &&
          read.value.target === runtime &&
          read.value.installId === id;
        if (ids.includes(id) && read.value && !matching)
          throw new Error(
            `Selected journal belongs to another runtime or operation: ${file}`,
          );
        if (!matching && !ids.includes(id)) {
          if (!read.value) unselectedJournals.push(file);
          continue;
        }
        await add(file, `journals/${name}`);
        await add(join(root, 'runtimes', '.staging', id), `staging/${id}`);
        if (!ids.includes(id)) ids.push(id);
      }
      for (const id of ids) {
        const file = join(journals, `${id}.json`);
        if (!items.some((item) => item.source === file))
          throw new Error(`Selected journal is missing: ${file}`);
      }
      // Keep an original stale/unknown lock as the normal mutation fence until
      // every other item is archived. Its original bytes are moved last.
      await add(runtimeLock, 'original.lock');
    }
    const checkUsage = async () => {
      references = await inspectRuntimeReferences(root, version);
      if (
        await runtimeBindingMatches(root, version, {
          version,
          executable: getPackageRoot(),
        })
      )
        throw new Error(
          'The executing package uses this runtime; run archive from a CLI outside the target runtime. Force cannot bypass verified use.',
        );
      let boundHere = false;
      if (options.workspaceRoot) {
        const machine = await inspectMachineConfig(options.workspaceRoot);
        boundHere = await runtimeBindingMatches(
          root,
          version,
          machine.value?.runtime,
        );
      }
      if (references.active.length || boundHere)
        throw new Error(
          'Verified workspace reference prevents runtime archival; force cannot bypass it.',
        );
    };
    try {
      await checkUsage();
    } catch (error) {
      blockers.push((error as Error).message);
    }
    lock = await inspectPrivateLock(runtimeLock);
    if (lock.state === 'alive')
      blockers.push(
        'A verified live lock owner prevents archival; force cannot bypass it.',
      );
    if (lock.state === 'unknown' && !options.allWritersStopped)
      blockers.push(
        'Unknown lock ownership requires --all-writers-stopped; no owner death is inferred.',
      );
    if (!options.forceUnknownReferences)
      blockers.push(
        'Unregistered reference coverage is unknown; explicit --force is required.',
      );
    if (options.apply && !options.reason?.trim())
      blockers.push(
        'Apply requires a nonempty --reason for the audit receipt.',
      );
    const owner = await inspectPrivateLock(archiveLock);
    if (owner.state === 'alive' || owner.state === 'unknown')
      blockers.push('Another archive owner is alive or unverified.');
    if (!options.apply) return result('planned');
    if (blockers.length) return result('blocked');
    if (!receipt && !items.length) return result('missing');
    await mkdir(control, { recursive: true, mode: 0o700 });
    await syncDirectory(dirname(control));
    await syncDirectory(root);
    // Pin every existing namespace ancestor, including the selected data root.
    const pinned = new Map<string, Identity>();
    for (const file of [...sources, ...items.map((item) => item.source)]) {
      let parent = dirname(file);
      while (isPathInside(root, parent)) {
        const identity = await identify(parent);
        if (identity) {
          if (identity.kind !== 'directory')
            throw new Error(`Unsafe archive parent: ${parent}`);
          pinned.set(parent, identity);
        }
        if (parent === root) break;
        parent = dirname(parent);
      }
    }
    const token = randomUUID();
    let owned: Identity | null = null;
    let pendingIdentity: Identity | null = null;
    const assertPinned = async () => {
      for (const [file, identity] of pinned)
        if (!same(await identify(file), identity))
          throw new Error(`Archive namespace identity changed: ${file}`);
      if (owned && !same(await identify(archiveLock), owned))
        throw new Error('Archive lock identity changed.');
      if (
        pendingIdentity &&
        !same(await identify(pendingFile), pendingIdentity)
      )
        throw new Error(
          'Archive receipt identity changed; preserved for inspection.',
        );
    };
    const acquire = () =>
      publishPrivateLock(
        archiveLock,
        Buffer.from(
          `${JSON.stringify({
            schema: 'pappra/install-lock/1',
            token,
            pid: process.pid,
            process_identity: captureProcessIdentity() ?? undefined,
            operation: 'archive-runtime',
            target: runtime,
            createdAt: new Date().toISOString(),
          })}\n`,
        ),
        assertPinned,
      );
    if (owner.state === 'dead')
      await reclaimDeadPrivateLock(archiveLock, assertPinned);
    await acquire();
    owned = await identify(archiveLock);
    try {
      await assertPinned();
      // Detect a competing archive that published a receipt after our preview.
      const current = await readJsonDocument(pendingFile, receiptSchema);
      if (
        current.exists !== pending.exists ||
        current.digest !== pending.digest
      )
        throw new Error(
          'Archive receipt changed since planning; preview again.',
        );
      pendingIdentity = await identify(pendingFile);
      await checkUsage();
      const originalLock = items.find((item) => item.source === runtimeLock);
      let generatedLockToken: string | null = null;
      if (!originalLock) {
        const currentLock = await inspectPrivateLock(runtimeLock);
        if (currentLock.state !== 'missing') {
          // Only an interrupted archive's generated fence may be reclaimed.
          const generated = await readJsonDocument(
            runtimeLock,
            z.object({
              operation: z.literal('archive-runtime'),
              target: z.literal(runtime),
            }),
          );
          if (!receipt || !generated.value || currentLock.state !== 'dead')
            throw new Error(
              'Runtime lock changed or has an unverified/live owner.',
            );
          await reclaimDeadPrivateLock(runtimeLock, assertPinned);
        }
        await mkdir(dirname(runtimeLock), { recursive: true, mode: 0o700 });
        generatedLockToken = randomUUID();
        await publishPrivateLock(
          runtimeLock,
          Buffer.from(
            `${JSON.stringify({
              schema: 'pappra/install-lock/1',
              token: generatedLockToken,
              pid: process.pid,
              process_identity: captureProcessIdentity() ?? undefined,
              operation: 'archive-runtime',
              target: runtime,
              createdAt: new Date().toISOString(),
            })}\n`,
          ),
          assertPinned,
        );
      }
      try {
        if (!receipt) {
          const id = randomUUID();
          archive = join(control, id);
          receiptFile = join(archive, 'receipt.json');
          await mkdir(archive, { mode: 0o700 });
          pinned.set(archive, (await identify(archive))!);
          receipt = {
            schema: 'pappra/runtime-archive/1',
            id,
            version,
            dataDir: root,
            status: 'prepared',
            createdAt: new Date().toISOString(),
            completedAt: null,
            reason: options.reason!.trim(),
            forceUnknownReferences: true,
            allWritersStopped: options.allWritersStopped === true,
            references,
            lock,
            installIds: ids.sort(),
            items,
          };
          await save(pendingFile, receipt, root);
          pendingIdentity = await identify(pendingFile);
          await options.checkpoint?.('prepared');
        } else {
          const bundle = await identify(archive!);
          if (!bundle || bundle.kind !== 'directory')
            throw new Error('Archive evidence directory is missing or unsafe.');
          pinned.set(archive!, bundle);
        }
        for (const item of items) {
          const destination = join(archive!, item.destination);
          await boundary(root, destination);
          await assertPinned();
          await checkUsage();
          const actual = await identify(item.source);
          const moved = await identify(destination);
          if (samePersisted(moved, item.identity) && actual === null) continue;
          if (moved !== null || !samePersisted(actual, item.identity))
            throw new Error(
              `Archive source/destination identity is ambiguous: ${item.source}`,
            );
          if (receipt.status === 'complete')
            throw new Error('Completed archive cannot move new evidence.');
          const runtimeOwner = await inspectPrivateLock(runtimeLock);
          if (
            generatedLockToken
              ? runtimeOwner.token !== generatedLockToken
              : runtimeOwner.state === 'alive' ||
                (runtimeOwner.state === 'unknown' &&
                  !options.allWritersStopped) ||
                !originalLock ||
                !samePersisted(
                  await identify(runtimeLock),
                  originalLock.identity,
                )
          )
            throw new Error(
              'Runtime lock changed or its owner is alive/unverified.',
            );
          await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
          await syncDirectory(archive!);
          await boundary(root, destination);
          const destinationParent = await identify(dirname(destination));
          if (!destinationParent || destinationParent.kind !== 'directory')
            throw new Error('Archive destination parent is unsafe.');
          if (!pinned.has(dirname(destination)))
            pinned.set(dirname(destination), destinationParent);
          await assertPinned();
          if (
            !samePersisted(await identify(item.source), item.identity) ||
            (await identify(destination))
          )
            throw new Error(
              'Archive evidence changed immediately before rename.',
            );
          await rename(item.source, destination);
          await syncDirectory(dirname(item.source));
          await syncDirectory(dirname(destination));
          await assertPinned();
          if (!samePersisted(await identify(destination), item.identity))
            throw new Error(
              'Moved evidence identity changed; preserved for inspection.',
            );
          await options.checkpoint?.(`moved:${item.destination}`);
        }
        await assertPinned();
        let completed: Receipt = {
          ...receipt,
          status: 'complete',
          completedAt: receipt.completedAt ?? new Date().toISOString(),
        };
        // A permanent bundle receipt is published before the pending fence is
        // marked complete. Crash retries reconcile inode-pinned moves first.
        await boundary(root, receiptFile!);
        const permanent = await readJsonDocument(receiptFile!, receiptSchema);
        if (permanent.exists) {
          if (
            !permanent.value ||
            permanent.value.status !== 'complete' ||
            permanent.value.completedAt === null ||
            JSON.stringify(permanent.value) !==
              JSON.stringify({
                ...completed,
                completedAt: permanent.value.completedAt,
              })
          )
            throw new Error(
              'Permanent archive receipt conflicts or is unreadable; it was preserved.',
            );
          completed = permanent.value;
        } else {
          // No-clobber publication also preserves a file created after the read.
          await publishPrivateLock(
            receiptFile!,
            Buffer.from(`${JSON.stringify(completed, null, 2)}\n`),
            assertPinned,
          );
          await syncDirectory(archive!);
        }
        await options.checkpoint?.('receipt');
        await save(pendingFile, completed, root);
        pendingIdentity = await identify(pendingFile);
        await options.checkpoint?.('complete');
        return result('archived');
      } finally {
        if (generatedLockToken) {
          await assertPinned();
          const released = await releaseInstallLock(
            runtimeLock,
            generatedLockToken,
          );
          if (!released.ok) throw new Error(released.message);
        }
      }
    } finally {
      await assertPinned();
      const released = await releaseInstallLock(archiveLock, token);
      if (!released.ok) throw new Error(released.message);
    }
  } catch (error) {
    return result('failed', [
      error instanceof Error ? error.message : String(error),
    ]);
  }
}
