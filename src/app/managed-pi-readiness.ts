import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { derivePiStartupCard } from './capability-evidence/pi.js';
import { readBoundedFile } from './bounded-file.js';
import { runCollaborationPreflight } from './collab-preflight.js';
import { isAssignment, isCard } from '../collab/contracts.js';
import { samePath } from './capability-evidence/shared.js';

export interface ManagedPiReadinessConfig {
  readonly assignmentFile: string;
  readonly templateFile: string;
  readonly cardFile: string;
}

export interface ManagedPiReadinessSource {
  readonly sessionId: string;
  readonly cwd: string;
  readonly metadataFile: string;
  readonly expectedProvider?: string;
  readonly expectedModel?: string;
}

export interface ManagedPiReadinessDependencies {
  readonly beforeRefresh?: () => Promise<void>;
}

export interface ManagedPiReadinessResult {
  readonly status: 'waiting' | 'published' | 'unchanged' | 'blocked';
  readonly code: string;
  readonly cardFile: string;
  readonly preflight: string | null;
}

function pinDirectory(directory: string) {
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(directory) !== directory
  )
    throw new Error('readiness_directory_redirected');
  return { dev: stat.dev, ino: stat.ino };
}

/** Publish startup capabilities only from a matching native resources_ready observation. */
export function publishManagedPiReadiness(
  config: ManagedPiReadinessConfig,
  source: ManagedPiReadinessSource,
): ManagedPiReadinessResult {
  const result = (
    status: ManagedPiReadinessResult['status'],
    code: string,
    preflight: string | null = null,
  ): ManagedPiReadinessResult => ({
    status,
    code,
    cardFile: config.cardFile,
    preflight,
  });
  let temporary: string | null = null;
  try {
    const files = [
      config.assignmentFile,
      config.templateFile,
      config.cardFile,
      source.metadataFile,
    ];
    if (files.some((file) => !path.isAbsolute(file)))
      return result('blocked', 'readiness_path_not_absolute');
    if (!source.sessionId || !path.isAbsolute(source.cwd))
      return result('waiting', 'readiness_source_identity_missing');
    if (
      [config.assignmentFile, config.templateFile, source.metadataFile].some(
        (file) => path.resolve(file) === path.resolve(config.cardFile),
      )
    )
      return result('blocked', 'readiness_input_output_conflict');

    const directory = path.dirname(config.cardFile);
    const parent = pinDirectory(directory);
    const assignmentRead = readBoundedFile(config.assignmentFile, 1024 * 1024);
    if (!assignmentRead.ok)
      return result(
        assignmentRead.code === 'unreadable' ? 'waiting' : 'blocked',
        `readiness_assignment_${assignmentRead.code}`,
      );
    const templateRead = readBoundedFile(config.templateFile, 1024 * 1024);
    if (!templateRead.ok)
      return result(
        templateRead.code === 'unreadable' ? 'waiting' : 'blocked',
        `readiness_template_${templateRead.code}`,
      );
    let assignment: unknown;
    let template: unknown;
    try {
      assignment = JSON.parse(assignmentRead.text) as unknown;
      template = JSON.parse(templateRead.text) as unknown;
    } catch {
      return result('waiting', 'readiness_configuration_invalid');
    }
    if (!isAssignment(assignment) || !isCard(template))
      return result('waiting', 'readiness_configuration_invalid');

    const derived = derivePiStartupCard({
      assignment,
      template,
      metadataFile: source.metadataFile,
      sessionId: source.sessionId,
      cwd: source.cwd,
      ...(source.expectedProvider === undefined
        ? {}
        : { expectedProvider: source.expectedProvider }),
      ...(source.expectedModel === undefined
        ? {}
        : { expectedModel: source.expectedModel }),
    });
    if (derived.status !== 'derived')
      return result(
        'waiting',
        derived.blockers[0] ?? 'native_card_unavailable',
      );
    if (
      derived.card.session_id !== source.sessionId ||
      !samePath(derived.card.cwd, source.cwd)
    )
      return result('waiting', 'readiness_source_identity_mismatch');

    const bytes = Buffer.from(`${JSON.stringify(derived.card, null, 2)}\n`);
    const existing = fs.lstatSync(config.cardFile, { throwIfNoEntry: false });
    if (existing) {
      const prior = readBoundedFile(config.cardFile, 1024 * 1024);
      if (!prior.ok) return result('blocked', 'readiness_card_target_unsafe');
      const card: unknown = JSON.parse(prior.text);
      if (
        !isCard(card) ||
        card.session_id !== source.sessionId ||
        !samePath(card.cwd, source.cwd)
      )
        return result('blocked', 'readiness_card_target_foreign');
      if (prior.bytes.equals(bytes)) {
        const preflight = runCollaborationPreflight({
          assignmentFile: config.assignmentFile,
          capabilitiesFile: config.cardFile,
        });
        return result('unchanged', 'native_card_unchanged', preflight.status);
      }
    }
    const current = pinDirectory(directory);
    if (current.dev !== parent.dev || current.ino !== parent.ino)
      return result('blocked', 'readiness_directory_changed');
    temporary = path.join(
      directory,
      `.pappra-readiness-${crypto.randomUUID()}.tmp`,
    );
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const beforePublish = pinDirectory(directory);
    if (beforePublish.dev !== parent.dev || beforePublish.ino !== parent.ino)
      return result('blocked', 'readiness_directory_changed');
    fs.renameSync(temporary, config.cardFile);
    temporary = null;
    const preflight = runCollaborationPreflight({
      assignmentFile: config.assignmentFile,
      capabilitiesFile: config.cardFile,
    });
    return result('published', 'native_card_published', preflight.status);
  } catch {
    return result('blocked', 'readiness_publication_failed');
  } finally {
    if (temporary !== null) {
      try {
        fs.unlinkSync(temporary);
      } catch {
        /* only this call's temporary file */
      }
    }
  }
}

/** Watch only explicit native/config inputs. No timer, model prompt or completion polling. */
export function watchManagedPiReadiness(
  config: ManagedPiReadinessConfig,
  source: ManagedPiReadinessSource,
  onResult: (result: ManagedPiReadinessResult) => void = () => {},
  dependencies: ManagedPiReadinessDependencies = {},
) {
  const inputs = [
    source.metadataFile,
    config.assignmentFile,
    config.templateFile,
  ];
  const directories = new Map<string, Set<string>>();
  const pins = new Map<string, { dev: number; ino: number }>();
  for (const file of inputs) {
    if (!path.isAbsolute(file)) throw new Error('readiness_path_not_absolute');
    const directory = path.dirname(file);
    pins.set(directory, pinDirectory(directory));
    const names = directories.get(directory) ?? new Set<string>();
    names.add(path.basename(file));
    directories.set(directory, names);
  }
  let last: ManagedPiReadinessResult | null = null;
  let lastCause: string | null = null;
  let closed = false;
  let pending = false;
  let forcePending = false;
  let active: Promise<void> | null = null;
  const watchers: fs.FSWatcher[] = [];
  const notify = (result: ManagedPiReadinessResult) => {
    try {
      onResult(result);
    } catch {
      /* Observers do not interrupt native lifecycle handling. */
    }
  };
  const inputCause = () => {
    const hash = crypto.createHash('sha256');
    for (const file of inputs) {
      const read = readBoundedFile(
        file,
        file === source.metadataFile ? 16 * 1024 * 1024 : 1024 * 1024,
      );
      hash.update(read.ok ? read.digest : `error:${read.code}`);
      hash.update('\0');
    }
    return hash.digest('hex');
  };
  const directoriesCurrent = () => {
    for (const [directory, pin] of pins) {
      try {
        const current = pinDirectory(directory);
        if (current.dev !== pin.dev || current.ino !== pin.ino) return false;
      } catch {
        return false;
      }
    }
    return true;
  };
  const refresh = (force = false): Promise<void> => {
    if (closed) return active ?? Promise.resolve();
    pending = true;
    forcePending ||= force;
    if (active) return active;
    active = (async () => {
      while (pending && !closed) {
        pending = false;
        const forced = forcePending;
        forcePending = false;
        if (!directoriesCurrent()) {
          last = {
            status: 'blocked',
            code: 'readiness_directory_changed',
            cardFile: config.cardFile,
            preflight: null,
          };
          notify(last);
          continue;
        }
        const beforeRefreshCause = inputCause();
        if (!forced && beforeRefreshCause === lastCause) continue;
        try {
          await dependencies.beforeRefresh?.();
        } catch {
          last = {
            status: 'waiting',
            code: 'readiness_refresh_dependency_failed',
            cardFile: config.cardFile,
            preflight: null,
          };
          notify(last);
          continue;
        }
        if (closed) break;
        if (!directoriesCurrent()) {
          last = {
            status: 'blocked',
            code: 'readiness_directory_changed',
            cardFile: config.cardFile,
            preflight: null,
          };
          notify(last);
          continue;
        }
        const cause = inputCause();
        if (!forced && cause === lastCause) continue;
        lastCause = cause;
        last = publishManagedPiReadiness(config, source);
        notify(last);
      }
    })().finally(() => {
      active = null;
      if (pending && !closed) void refresh(forcePending);
    });
    return active;
  };
  try {
    for (const [directory, names] of directories) {
      const watcher = fs.watch(directory, (_event, filename) => {
        if (closed) return;
        if (filename === null || names.has(filename.toString())) void refresh();
      });
      watcher.on('error', () => {
        last = {
          status: 'blocked',
          code: 'readiness_watch_failed',
          cardFile: config.cardFile,
          preflight: null,
        };
      });
      watchers.push(watcher);
    }
    void refresh();
  } catch (error) {
    for (const watcher of watchers) watcher.close();
    throw error;
  }
  return {
    refresh,
    status: () => last,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const watcher of watchers) watcher.close();
      await active;
    },
  };
}
