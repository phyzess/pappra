import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalJson } from '../collab/envelope.js';
import { readBoundedFile } from './bounded-file.js';
import {
  tickAutomaticHandoff,
  type AutomaticHandoffConfig,
  type AutomaticHandoffRuntime,
  type AutomaticHandoffResult,
} from './collab-auto-handoff.js';
import type { SessionTransitionDependencies } from './collab-session-transition.js';

export function loadAutomaticHandoffConfig(
  file: string,
): AutomaticHandoffConfig {
  const loaded = readBoundedFile(file, 64 * 1024);
  if (!loaded.ok) throw new Error('automatic_handoff_config_unreadable');
  const value = JSON.parse(loaded.text);
  if (
    !value ||
    value.schema !== 'pappra/automatic-handoff/1' ||
    !value.transition ||
    !path.isAbsolute(value.transition.task_root)
  )
    throw new Error('automatic_handoff_config_invalid');
  if (value.sourceReadiness !== undefined) {
    const readiness = value.sourceReadiness;
    const keys = ['assignmentFile', 'templateFile', 'cardFile'];
    if (
      !readiness ||
      typeof readiness !== 'object' ||
      Array.isArray(readiness) ||
      Object.keys(readiness).some((key) => !keys.includes(key)) ||
      !keys.every(
        (key) =>
          typeof readiness[key] === 'string' && path.isAbsolute(readiness[key]),
      ) ||
      new Set(keys.map((key) => path.resolve(readiness[key]))).size !==
        keys.length
    )
      throw new Error('automatic_handoff_source_readiness_invalid');
  }
  return value as AutomaticHandoffConfig;
}

/** A native settled event or registered task update advances one guarded transition. */
export function watchAutomaticHandoff(
  config: AutomaticHandoffConfig,
  runtime: AutomaticHandoffRuntime & {
    subscribe(listener: (event: unknown) => void): () => void;
  },
  dependencies: SessionTransitionDependencies = {},
  onRetirement?: (result: AutomaticHandoffResult) => Promise<void>,
) {
  const directory = config.transition.task_root;
  const pin = fs.lstatSync(directory);
  if (
    !pin.isDirectory() ||
    pin.isSymbolicLink() ||
    fs.realpathSync(directory) !== directory
  )
    throw new Error('automatic_handoff_task_redirected');
  let closed = false;
  let pending = false;
  let running = false;
  let active = Promise.resolve();
  let last: Awaited<ReturnType<typeof tickAutomaticHandoff>> | null = null;
  let error: string | null = null;
  let previousCause: string | null = null;
  type Completion =
    { readonly ok: true } | { readonly ok: false; readonly code: string };
  let completion: Completion | null = null;
  let resolveCompleted!: (value: Completion) => void;
  const completed = new Promise<Completion>((resolve) => {
    resolveCompleted = resolve;
  });
  const refresh = () => {
    if (closed) return active;
    pending = true;
    if (running) return active;
    running = true;
    active = (async () => {
      try {
        while (pending && !closed) {
          pending = false;
          const now = fs.lstatSync(directory);
          if (
            now.dev !== pin.dev ||
            now.ino !== pin.ino ||
            now.isSymbolicLink()
          )
            throw new Error('automatic_handoff_task_changed');
          const task = readBoundedFile(
            path.join(directory, 'task.json'),
            8 * 1024 * 1024,
          );
          if (!task.ok) throw new Error('automatic_handoff_task_unreadable');
          const state = JSON.parse(task.text) as Record<string, unknown>;
          delete state.automatic_handoff_journal;
          delete state.session_transition_journal;
          delete state.state_revision;
          delete state.updated_at;
          const cause = crypto
            .createHash('sha256')
            .update(canonicalJson({ state, observation: runtime.observe() }))
            .digest('hex');
          if (cause === previousCause) continue;
          previousCause = cause;
          last = await tickAutomaticHandoff(config, runtime, dependencies);
          if (last.status === 'complete') {
            try {
              await onRetirement?.(last);
              completion = { ok: true };
            } catch {
              error = 'automatic_handoff_retirement_failed';
              completion = { ok: false, code: error };
            }
            closed = true;
            watcher.close();
            unsubscribe();
            resolveCompleted(completion);
          }
        }
      } catch {
        error = 'automatic_handoff_event_failed';
      } finally {
        running = false;
      }
    })();
    return active;
  };
  const watcher = fs.watch(directory, (_event, name) => {
    if (name === null || name.toString() === 'task.json') void refresh();
  });
  watcher.on('error', () => {
    error = 'automatic_handoff_watch_failed';
  });
  const unsubscribe = runtime.subscribe((event) => {
    if (
      typeof event === 'object' &&
      event !== null &&
      'type' in event &&
      event.type === 'agent_settled'
    )
      void refresh();
  });
  // Startup also reconciles a durable prior transition; it never recaptures a reserved summary.
  void refresh();
  return {
    refresh,
    completed,
    status: () => ({ result: last, error, completion }),
    close() {
      closed = true;
      watcher.close();
      unsubscribe();
    },
  };
}
