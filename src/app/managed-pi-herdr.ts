import { runHerdrCommand, type CommandRunner } from './collab-notify.js';
import type { ManagedPiSdkSessionController } from '../hosts/pi/managed-sdk-session.js';

type Runtime = Pick<
  ManagedPiSdkSessionController,
  'snapshot' | 'observe' | 'subscribe' | 'isDisposed'
>;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Publish only this process's owned native SDK runtime; publication is not task authority. */
export async function publishManagedPiHerdrIdentity(
  runtime: Runtime,
  options: {
    readonly paneId: string;
    readonly name?: string;
    readonly run?: CommandRunner;
  },
) {
  if (
    !/^[A-Za-z0-9]+:p[A-Za-z0-9]+$/.test(options.paneId) ||
    (options.name !== undefined &&
      !/^[a-z][a-z0-9_-]{0,31}$/.test(options.name))
  )
    throw new Error('managed_herdr_identity_invalid');
  const run = options.run ?? runHerdrCommand;
  const source = `pappra-managed-sdk:${runtime.observe().native.sessionId}`;
  let seq = Date.now() * 1000;
  let closed = false;
  let pending = false;
  let active: Promise<void> | null = null;
  let lastState: string | null = null;
  let error: string | null = null;
  const invoke = async (args: readonly string[], read = false) => {
    const result = await run('herdr', args, 5000);
    if (
      !result.spawned ||
      result.code !== 0 ||
      result.timedOut ||
      result.signal ||
      result.spawnError
    )
      throw new Error(
        `managed_herdr_operation_failed:${args[0]}:${args[1]}:${result.timedOut ? 'timeout' : result.spawnError ? 'spawn' : String(result.code)}`,
      );
    if (!read) return null;
    try {
      const value: unknown = JSON.parse(result.stdout);
      if (object(value) && object(value.result)) return value.result;
    } catch {
      /* Never expose raw command output. */
    }
    throw new Error('managed_herdr_observation_invalid');
  };
  const assertOwnedPane = async () => {
    const snapshot = runtime.snapshot();
    if (runtime.isDisposed || snapshot.process.pid !== process.pid)
      throw new Error('managed_herdr_runtime_not_owned');
    const result = await invoke(
      ['pane', 'process-info', '--pane', options.paneId],
      true,
    );
    const info = result?.process_info;
    if (
      !object(info) ||
      info.pane_id !== options.paneId ||
      !Array.isArray(info.foreground_processes) ||
      !info.foreground_processes.some(
        (row: unknown) => object(row) && row.pid === process.pid,
      )
    )
      throw new Error('managed_herdr_pane_not_owned');
  };
  const stateOf = () => {
    const s = runtime.snapshot();
    const owned = s.ownedRuntime;
    if (
      owned.extensionDialogs.pending.length ||
      owned.queues.internal.activeSelector
    )
      return 'blocked';
    if (
      owned.work.observation !== 'complete' ||
      owned.queues.completeness !== 'complete'
    )
      return 'unknown';
    return owned.work.isIdle &&
      !owned.work.isStreaming &&
      !owned.work.isCompacting &&
      !owned.work.isBashRunning &&
      owned.work.pendingToolCalls === 0
      ? 'idle'
      : 'working';
  };
  const publish = async () => {
    await assertOwnedPane();
    const live = runtime.observe();
    const snapshot = runtime.snapshot();
    const state = stateOf();
    const fingerprint = `${live.native.sessionId}:${snapshot.session.sessionFile}:${state}`;
    if (fingerprint === lastState) return;
    const ref = snapshot.session.sessionFile
      ? ['--agent-session-path', snapshot.session.sessionFile]
      : ['--agent-session-id', live.native.sessionId];
    await invoke([
      'pane',
      'report-agent',
      options.paneId,
      '--source',
      source,
      '--agent',
      'pi',
      '--state',
      state,
      '--seq',
      String(++seq),
      ...ref,
    ]);
    await assertOwnedPane();
    await invoke([
      'pane',
      'report-agent-session',
      options.paneId,
      '--source',
      source,
      '--agent',
      'pi',
      '--seq',
      String(++seq),
      ...ref,
      '--session-start-source',
      'startup',
    ]);
    lastState = fingerprint;
  };
  try {
    await publish();
    if (options.name) {
      await assertOwnedPane();
      await invoke(['agent', 'rename', options.paneId, options.name]);
    }
  } catch (failure) {
    await invoke([
      'pane',
      'release-agent',
      options.paneId,
      '--source',
      source,
      '--agent',
      'pi',
    ]).catch(() => {});
    throw failure;
  }
  const refresh = (): Promise<void> => {
    if (closed) return active ?? Promise.resolve();
    pending = true;
    if (active) return active;
    active = (async () => {
      try {
        while (pending && !closed) {
          pending = false;
          await publish();
          error = null;
        }
      } catch {
        error = 'managed_herdr_publication_failed';
      } finally {
        active = null;
      }
    })();
    return active;
  };
  const unsubscribe = runtime.subscribe(() => {
    void refresh();
  });
  return {
    refresh,
    status: () => ({
      source,
      pane_id: options.paneId,
      native_session_id: runtime.observe().native.sessionId,
      error,
      session_reference: 'published_native_sdk_observation',
      limitation: 'herdr_may_omit_sdk_session_reference_from_agent_list',
    }),
    async close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      await active;
      await invoke([
        'pane',
        'release-agent',
        options.paneId,
        '--source',
        source,
        '--agent',
        'pi',
      ]).catch(() => {});
    },
  };
}
