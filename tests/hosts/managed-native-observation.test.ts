import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { observeOwnedManagedPi } from '../../src/app/managed-pi-native-observation.js';
import type { CommandRunner } from '../../src/app/collab-notify.js';

test('native SDK identity requires matching private endpoint, OS peer and pane foreground PID', async (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pappra-native-identity-')),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'control.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      sessionId: 'actual-session',
      runId: 'controller-run',
      socketPath: '/private/tmp/owned.sock',
    }),
    { mode: 0o600 },
  );
  let peer = 481;
  let panePid = 481;
  let sessionId = 'actual-session';
  let taskRoot = root;
  const run: CommandRunner = async () => ({
    spawned: true,
    code: 0,
    signal: null,
    timedOut: false,
    spawnError: null,
    stderr: '',
    stdout: JSON.stringify({
      result: {
        process_info: {
          pane_id: 'w3:pZ',
          foreground_processes: [{ pid: panePid }],
        },
      },
    }),
  });
  const deps = {
    run,
    peerPid: () => peer,
    control: async () => ({
      ok: true,
      snapshot: { session: { sessionId }, process: { pid: 481 } },
      automation: {
        execution_scope: { task_root: taskRoot, session_id: 'actual-session' },
        launch: {
          runtime: 'sdk',
          ready: true,
          session_id: sessionId,
          controller_run_id: 'controller-run',
          cwd: root,
          herdr_pane_id: 'w3:pZ',
          herdr_agent_name: 'native-writer',
          model: { provider: 'openrouter', id: 'openai/gpt-6-luna' },
        },
      },
    }),
  };
  const expected = {
    sessionId: 'actual-session',
    cwd: root,
    paneId: 'w3:pZ',
    name: 'native-writer',
    taskRoot: root,
  };
  assert.equal(
    (await observeOwnedManagedPi(file, expected, deps))?.provenance,
    'owned-pi-sdk-control',
  );
  panePid++;
  assert.equal(await observeOwnedManagedPi(file, expected, deps), null);
  panePid = 481;
  peer++;
  assert.equal(await observeOwnedManagedPi(file, expected, deps), null);
  peer = 481;
  sessionId = 'forged-session';
  assert.equal(await observeOwnedManagedPi(file, expected, deps), null);
  sessionId = 'actual-session';
  taskRoot = '/different-task';
  assert.equal(await observeOwnedManagedPi(file, expected, deps), null);
  taskRoot = root;
  fs.chmodSync(file, 0o644);
  assert.equal(await observeOwnedManagedPi(file, expected, deps), null);
});
