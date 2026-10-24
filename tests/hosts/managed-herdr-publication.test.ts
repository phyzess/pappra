import assert from 'node:assert/strict';
import test from 'node:test';
import { publishManagedPiHerdrIdentity } from '../../src/app/managed-pi-herdr.js';
import type {
  CommandResult,
  CommandRunner,
} from '../../src/app/collab-notify.js';

const okay = (stdout = ''): CommandResult => ({
  spawned: true,
  code: 0,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false,
  spawnError: null,
});
const timeout: CommandResult = { ...okay(), code: null, timedOut: true };
function runtime() {
  return {
    isDisposed: false,
    observe: () => ({ native: { sessionId: 'owned-session' }, cwd: '/owned' }),
    subscribe: () => () => {},
    snapshot: () => ({
      process: { pid: process.pid },
      session: { sessionFile: null },
      ownedRuntime: {
        queues: {
          completeness: 'complete',
          internal: { activeSelector: false },
        },
        extensionDialogs: { pending: [] },
        work: {
          observation: 'complete',
          isIdle: true,
          isStreaming: false,
          isCompacting: false,
          isBashRunning: false,
          pendingToolCalls: 0,
        },
      },
    }),
  } as unknown as Parameters<typeof publishManagedPiHerdrIdentity>[0];
}
test('an initial read-only process observation timeout retries once without repeating publication', async () => {
  const calls: string[] = [];
  let reads = 0;
  const run: CommandRunner = async (_command, args) => {
    const action = args.slice(0, 2).join(' ');
    calls.push(action);
    if (action === 'pane process-info') {
      reads++;
      if (reads === 1) return timeout;
      return okay(
        JSON.stringify({
          result: {
            process_info: {
              pane_id: 'w3:p1',
              foreground_processes: [{ pid: process.pid }],
            },
          },
        }),
      );
    }
    return okay();
  };
  const publication = await publishManagedPiHerdrIdentity(runtime(), {
    paneId: 'w3:p1',
    run,
  });
  assert.equal(reads, 3);
  assert.equal(calls.filter((x) => x === 'pane report-agent').length, 1);
  assert.equal(
    calls.filter((x) => x === 'pane report-agent-session').length,
    1,
  );
  await publication.close();
});
test('repeated read timeouts and timed-out mutations remain refused', async () => {
  let reads = 0;
  await assert.rejects(
    publishManagedPiHerdrIdentity(runtime(), {
      paneId: 'w3:p1',
      run: async (_command, args) => {
        if (args[1] === 'process-info') {
          reads++;
          return timeout;
        }
        return okay();
      },
    }),
    /process-info:timeout/,
  );
  assert.equal(reads, 2);
  let mutations = 0;
  await assert.rejects(
    publishManagedPiHerdrIdentity(runtime(), {
      paneId: 'w3:p1',
      run: async (_command, args) => {
        if (args[1] === 'process-info')
          return okay(
            JSON.stringify({
              result: {
                process_info: {
                  pane_id: 'w3:p1',
                  foreground_processes: [{ pid: process.pid }],
                },
              },
            }),
          );
        if (args[1] === 'report-agent') {
          mutations++;
          return timeout;
        }
        return okay();
      },
    }),
    /report-agent:timeout/,
  );
  assert.equal(mutations, 1);
});
