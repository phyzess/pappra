import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readBoundedFile } from './bounded-file.js';
import {
  tickRoleOrchestration,
  type RoleOrchestrationRequest,
  type RoleOrchestrationResult,
} from './collab-role-orchestration.js';
import { openTaskStore, assertTaskStoreCurrent } from './collab-task-store.js';
import type { OpenedTaskStore } from './collab-task-store.js';
import { canonicalJson } from '../collab/envelope.js';
import { managedPiRepairDependencies } from './managed-pi-repair-stop.js';

export const ROLE_RUN_REQUEST_SCHEMA =
  'pappra/collab-role-orchestration-request/1';

export function loadRoleRunRequest(file: string): RoleOrchestrationRequest {
  const loaded = readBoundedFile(file, 1024 * 1024);
  if (!loaded.ok) throw new Error(`role_request_${loaded.code}`);
  let value: unknown;
  try {
    value = JSON.parse(loaded.text) as unknown;
  } catch {
    throw new Error('role_request_invalid_json');
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('schema' in value) ||
    value.schema !== ROLE_RUN_REQUEST_SCHEMA ||
    !('role_plan' in value) ||
    !('execution' in value) ||
    !('limits' in value) ||
    !('event_id' in value) ||
    !('journal_file' in value)
  )
    throw new Error('role_request_invalid');
  return value as unknown as RoleOrchestrationRequest;
}

export interface RoleEventWatcher {
  refresh(): Promise<void>;
  status(): {
    readonly result: RoleOrchestrationResult | null;
    readonly error: string | null;
  };
  close(): Promise<void>;
}

export interface RoleEventDependencies {
  readonly openTaskStore?: typeof openTaskStore;
  readonly assertTaskStoreCurrent?: typeof assertTaskStoreCurrent;
  readonly tick?: typeof tickRoleOrchestration;
}

interface DirectoryPin {
  readonly device: number;
  readonly inode: number;
}

interface DirectoryWatch {
  readonly watcher: fs.FSWatcher;
  names: Set<string>;
}

function safeDirectory(directory: string): fs.Stats {
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(directory) !== directory
  )
    throw new Error('role_event_directory_redirected');
  return stat;
}

function buildWatchNames(
  requestFile: string,
  taskRoot: string,
  request: RoleOrchestrationRequest,
  pins: Map<string, DirectoryPin>,
): Map<string, Set<string>> {
  const journalFile = path.resolve(request.journal_file);
  const inputs = [
    requestFile,
    path.join(taskRoot, 'task.json'),
    ...request.execution.capability_cards.map((card) => card.capabilities_file),
  ];
  const watchNames = new Map<string, Set<string>>();
  for (const input of inputs) {
    if (typeof input !== 'string' || !path.isAbsolute(input))
      throw new Error('role_event_path_not_absolute');
    const absolute = path.resolve(input);
    if (absolute === journalFile)
      throw new Error('role_event_journal_input_conflict');
    const directory = path.dirname(absolute);
    const stat = safeDirectory(directory);
    const pin = pins.get(directory);
    if (pin && (pin.device !== stat.dev || pin.inode !== stat.ino))
      throw new Error('role_event_directory_changed');
    if (!pin) pins.set(directory, { device: stat.dev, inode: stat.ino });
    const names = watchNames.get(directory) ?? new Set<string>();
    names.add(path.basename(absolute));
    watchNames.set(directory, names);
  }
  return watchNames;
}

function sameNames(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return left.size === right.size && [...left].every((name) => right.has(name));
}

/**
 * Native session events and authoritative task-store changes drive one bounded tick.
 * Watch subscriptions follow request changes. The orchestration journal is never a cause.
 */
export async function watchRoleOrchestration(
  requestFile: string,
  onResult: (result: RoleOrchestrationResult) => void = () => {},
  deps: RoleEventDependencies = {},
): Promise<RoleEventWatcher> {
  if (!path.isAbsolute(requestFile))
    throw new Error('role_event_request_path_not_absolute');
  const openStore = deps.openTaskStore ?? openTaskStore;
  const assertCurrent = deps.assertTaskStoreCurrent ?? assertTaskStoreCurrent;
  const tick = deps.tick ?? tickRoleOrchestration;
  const initial = loadRoleRunRequest(requestFile);
  const opened = await openStore(initial.execution.task_root);
  if (!opened.ok) throw new Error('role_event_task_unavailable');
  const task: OpenedTaskStore = opened.value;
  const taskRoot = task.taskRoot;
  const messagesDirectory = task.messagesDirectory;
  if (path.resolve(initial.execution.task_root) !== path.resolve(taskRoot))
    throw new Error('role_event_task_root_mismatch');
  const messagesRelative = path.relative(taskRoot, messagesDirectory);
  if (
    messagesRelative === '' ||
    messagesRelative.startsWith('..') ||
    path.isAbsolute(messagesRelative)
  )
    throw new Error('role_event_task_namespace_mismatch');
  const taskRootIdentity = safeDirectory(taskRoot);
  const messagesDirectoryIdentity = safeDirectory(messagesDirectory);
  const namespacePins = {
    taskRoot: { device: taskRootIdentity.dev, inode: taskRootIdentity.ino },
    messagesDirectory: {
      device: messagesDirectoryIdentity.dev,
      inode: messagesDirectoryIdentity.ino,
    },
  };

  const directoryPins = new Map<string, DirectoryPin>();
  const watchers = new Map<string, DirectoryWatch>();
  let closed = false;
  let running = false;
  let pending = false;
  let last: RoleOrchestrationResult | null = null;
  let lastError: string | null = null;
  let lastCause: string | null = null;
  let retryCause: string | null = null;
  let lockRetries = 0;
  let retryTimer: NodeJS.Timeout | null = null;
  let subscriptionTimer: NodeJS.Timeout | null = null;
  let activeJournalFile = path.resolve(initial.journal_file);
  let active: Promise<void> = Promise.resolve();

  const syncWatchers = (request: RoleOrchestrationRequest): void => {
    let changed = false;
    const activeDirectories = new Set([
      path.dirname(path.resolve(requestFile)),
      path.dirname(path.join(taskRoot, 'task.json')),
      ...request.execution.capability_cards.map((card) =>
        path.dirname(path.resolve(card.capabilities_file)),
      ),
    ]);
    for (const directory of directoryPins.keys()) {
      if (!activeDirectories.has(directory)) directoryPins.delete(directory);
    }
    const desired = buildWatchNames(
      requestFile,
      taskRoot,
      request,
      directoryPins,
    );
    activeJournalFile = path.resolve(request.journal_file);
    for (const [directory, current] of watchers) {
      const names = desired.get(directory);
      if (!names) {
        current.watcher.close();
        watchers.delete(directory);
        changed = true;
      } else if (!sameNames(current.names, names)) {
        current.names = names;
        changed = true;
      }
    }
    for (const [directory, names] of desired) {
      if (watchers.has(directory)) continue;
      const entry: DirectoryWatch = {
        watcher: fs.watch(directory, (_event, name) => {
          if (closed) return;
          const observedName = name?.toString() ?? null;
          const ownJournal = activeJournalFile;
          if (
            observedName !== null &&
            path.resolve(directory, observedName) === ownJournal
          )
            return;
          if (observedName === null || entry.names.has(observedName))
            void refresh();
        }),
        names,
      };
      entry.watcher.on('error', () => {
        lastError = 'role_event_watch_failed';
      });
      watchers.set(directory, entry);
      changed = true;
    }
    if (changed) {
      if (subscriptionTimer) clearTimeout(subscriptionTimer);
      // Directory subscriptions can miss writes while the OS attaches them.
      // Reconcile once after rebinding; unchanged causes never dispatch again.
      subscriptionTimer = setTimeout(() => {
        subscriptionTimer = null;
        if (!closed) void refresh();
      }, 50);
      subscriptionTimer.unref();
    }
  };

  const refresh = (): Promise<void> => {
    if (closed) return active;
    pending = true;
    if (running) return active;
    running = true;
    active = (async () => {
      try {
        while (pending && !closed) {
          pending = false;

          const request = loadRoleRunRequest(requestFile);
          if (
            path.resolve(request.execution.task_root) !== path.resolve(taskRoot)
          )
            throw new Error('role_event_task_changed');
          syncWatchers(request);

          for (const [directory, pin] of directoryPins) {
            const now = safeDirectory(directory);
            if (now.dev !== pin.device || now.ino !== pin.inode)
              throw new Error('role_event_directory_changed');
          }
          const current = await openStore(taskRoot);
          if (!current.ok) throw new Error('role_event_task_unavailable');
          if (
            path.resolve(current.value.taskRoot) !== path.resolve(taskRoot) ||
            path.resolve(current.value.messagesDirectory) !==
              path.resolve(messagesDirectory)
          )
            throw new Error('role_event_task_namespace_changed');
          const currentTaskRoot = safeDirectory(current.value.taskRoot);
          const currentMessagesDirectory = safeDirectory(
            current.value.messagesDirectory,
          );
          if (
            currentTaskRoot.dev !== namespacePins.taskRoot.device ||
            currentTaskRoot.ino !== namespacePins.taskRoot.inode ||
            currentMessagesDirectory.dev !==
              namespacePins.messagesDirectory.device ||
            currentMessagesDirectory.ino !==
              namespacePins.messagesDirectory.inode
          )
            throw new Error('role_event_task_namespace_changed');
          const unsafe = await assertCurrent(current.value);
          if (unsafe) throw new Error('role_event_task_store_changed');
          const record = current.value.record;
          const cardDigests = request.execution.capability_cards.map((card) => {
            const bytes = readBoundedFile(card.capabilities_file, 1024 * 1024);
            return {
              assignment: card.assignment_id,
              digest: bytes.ok ? bytes.digest : bytes.code,
            };
          });
          const cause = crypto
            .createHash('sha256')
            .update(
              canonicalJson({
                request: {
                  role_plan: request.role_plan,
                  execution: request.execution,
                  journal_file: request.journal_file,
                  limits: request.limits,
                  repair_policy: request.repair_policy ?? null,
                },
                coordinator: record.coordinator ?? null,
                attempts: record.attempts ?? [],
                messages: record.messages ?? [],
                results: record.results ?? [],
                claims: record.claims ?? [],
                uncertainty: record.uncertainty ?? [],
                dispatch_frozen: record.dispatch_frozen ?? false,
                managed_runtimes: record.managed_pi_runtime_registry ?? null,
                cards: cardDigests,
              }),
            )
            .digest('hex');
          if (cause === lastCause) continue;
          lastCause = cause;
          const repair = managedPiRepairDependencies(request);
          last = await tick(
            {
              ...request,
              // Assigned-but-undispatched work was previously mistaken for
              // active execution. Reconcile it under the corrected scheduler;
              // durable work intents still prevent any native redelivery.
              event_id: `task-event-v2-${cause}`,
            },
            repair ? { repair } : {},
          );
          lastError = null;
          onResult(last);
          if (last.diagnostics.includes('journal_lock_present_or_busy')) {
            if (retryCause !== cause) {
              retryCause = cause;
              lockRetries = 0;
            }
            if (lockRetries < 2 && !retryTimer) {
              lockRetries++;
              // This outcome reserved no tick and caused no native effect.
              // A stale lock remains visible after the bounded retries.
              retryTimer = setTimeout(() => {
                retryTimer = null;
                if (!closed) {
                  lastCause = null;
                  void refresh();
                }
              }, 50 * lockRetries);
              retryTimer.unref();
            }
          } else {
            if (retryTimer) clearTimeout(retryTimer);
            retryTimer = null;
            retryCause = null;
            lockRetries = 0;
          }
        }
      } catch {
        // Never publish filesystem paths, serialized requests, or raw exception details.
        lastError = 'role_event_reconciliation_failed';
      } finally {
        running = false;
        if (pending && !closed) void refresh();
      }
    })();
    return active;
  };

  try {
    syncWatchers(initial);
    await refresh();
  } catch {
    if (subscriptionTimer) clearTimeout(subscriptionTimer);
    for (const entry of watchers.values()) entry.watcher.close();
    throw new Error('role_event_watch_initialization_failed');
  }

  return {
    refresh,
    status: () => ({ result: last, error: lastError }),
    close: async () => {
      if (closed) return;
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (subscriptionTimer) clearTimeout(subscriptionTimer);
      for (const entry of watchers.values()) entry.watcher.close();
      watchers.clear();
      await active;
    },
  };
}
