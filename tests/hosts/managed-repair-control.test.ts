import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  managedPiRepairDependencies,
  managedPiSocketPeerPid,
} from '../../src/app/managed-pi-repair-stop.js';
import { makeTaskDomain } from '../collab/task-resources-fixtures.js';
import { buildMessage } from '../../src/collab/envelope.js';
import { submitMessage } from '../../src/collab/messages.js';
import { transact } from '../../src/collab/store.js';
import { owner } from '../collab/scenarios.js';
import type { TaskRecord } from '../../src/collab/types.js';

function fixture() {
  const value = makeTaskDomain('managed-repair-control', ['sample']);
  const taskRoot = value.tasks.sample!;
  const assignee = {
    agent_id: 'source',
    session_id: randomUUID(),
    harness: 'pi',
    cwd: value.root,
  };
  const input = `sha256:${'1'.repeat(64)}`;
  const admitted = submitMessage(
    taskRoot,
    buildMessage({
      message_id: 'assign-source',
      type: 'ASSIGN',
      task_id: 'sample',
      from: owner,
      to: assignee,
      subtask_id: 'work',
      attempt: 1,
      owner_epoch: 1,
      body: {
        assignment_digest: `sha256:${'2'.repeat(64)}`,
        input_revision: input,
      },
    }),
  );
  assert.equal(admitted.ok, true);
  const descriptorFile = path.join(value.root, 'control.json');
  const scope = {
    schema: 'pappra/managed-pi-execution-scope/1',
    task_id: 'sample',
    task_root: taskRoot,
    session_id: assignee.session_id,
    cwd: value.root,
    subtask_id: 'work',
    attempt: 1,
    owner_epoch: 1,
    claim_epochs: [{ claim_id: 'fixture-claim', resource_epoch: 1 }],
  };
  fs.writeFileSync(
    descriptorFile,
    JSON.stringify({
      schema: 'harness-collab/pi-managed-control/1',
      sessionId: assignee.session_id,
      runId: 'owned-run',
      socketPath: '/private/tmp/owned-sdk.sock',
    }),
    { mode: 0o600 },
  );
  const register = () => {
    const result = transact(taskRoot, {
      actor: 'fixture',
      purpose: 'register-runtime',
      apply(record) {
        record.managed_pi_runtime_registry = [
          {
            schema: 'pappra/managed-pi-runtime/1',
            agent_id: assignee.agent_id,
            session_id: assignee.session_id,
            pid: process.pid,
            descriptor_file: descriptorFile,
            controller_run_id: 'owned-run',
            input_revision: input,
            scope,
          },
        ];
        return { record, op: 'fixture-register', summary: {}, result: null };
      },
    });
    assert.equal(result.ok, true);
  };
  const request = {
    execution: { task_root: taskRoot },
    repair_policy: { authorizations: [] },
  };
  const source = {
    task_id: 'sample',
    coordinator: {
      agent_id: owner.agent_id,
      session_id: owner.session_id,
      owner_epoch: 1,
    },
    source: {
      node_id: 'writer',
      assignment_id: 'work',
      attempt: 1,
      input_revision: input,
      resources: [
        { path: path.join(value.root, 'work'), access: 'write' as const },
      ],
    },
    assignee,
  };
  const snapshot = {
    schema: 'harness-collab/pi-managed-sdk-session/1',
    process: { pid: process.pid },
    session: { sessionId: assignee.session_id },
  };
  let stops = 0;
  let queries = 0;
  const control: NonNullable<
    Parameters<typeof managedPiRepairDependencies>[1]
  >['control'] = async (_descriptor, action) => {
    if (action === 'snapshot') {
      queries++;
      return { ok: true, snapshot, automation: { execution_scope: scope } };
    }
    stops++;
    return {
      ok: true,
      exit: {
        status: 'runtime_disposed',
        sessionId: assignee.session_id,
        process: { exit: 'not_owned' },
        finalSnapshot: {
          session: { sessionId: assignee.session_id },
          scopedQuiescent: true,
        },
      },
    };
  };
  return {
    ...value,
    taskRoot,
    request,
    source,
    register,
    control,
    get stops() {
      return stops;
    },
    get queries() {
      return queries;
    },
  };
}

test('registered owned SDK source produces one durable scoped stop receipt without replay', async () => {
  const value = fixture();
  try {
    value.register();
    const deps = { control: value.control, peerPid: () => process.pid };
    const first = await managedPiRepairDependencies(value.request, deps)!
      .confirm_stopped!(value.source);
    assert.equal(first?.observation, 'confirmed');
    assert.equal(first?.assignee.session_id, value.source.assignee.session_id);
    assert.equal(value.stops, 1);
    const restarted = await managedPiRepairDependencies(value.request, deps)!
      .confirm_stopped!(value.source);
    assert.deepEqual(restarted, first);
    assert.equal(value.stops, 1);
    assert.equal(value.queries, 1);
  } finally {
    value.cleanup();
  }
});

test('unregistered sources and a mismatching socket owner never receive stop commands', async () => {
  const value = fixture();
  try {
    const deps = { control: value.control, peerPid: () => process.pid + 1 };
    assert.equal(
      await managedPiRepairDependencies(value.request, deps)!.confirm_stopped!(
        value.source,
      ),
      null,
    );
    value.register();
    assert.equal(
      await managedPiRepairDependencies(value.request, deps)!.confirm_stopped!(
        value.source,
      ),
      null,
    );
    assert.equal(value.stops, 0);
    assert.equal(value.queries, 0);
    assert.equal(
      fs.existsSync(path.join(value.taskRoot, '.managed-native-stops')),
      false,
    );
  } finally {
    value.cleanup();
  }
});

test('an ambiguous native stop is reserved before admission and is not reissued after restart', async () => {
  const value = fixture();
  try {
    value.register();
    let admitted = 0;
    const control: NonNullable<
      Parameters<typeof managedPiRepairDependencies>[1]
    >['control'] = async (file, action) => {
      if (action === 'stop') {
        admitted++;
        throw new Error('injected_disconnect_after_admission');
      }
      return value.control!(file, action);
    };
    const deps = { control, peerPid: () => process.pid };
    await assert.rejects(
      () =>
        managedPiRepairDependencies(value.request, deps)!.confirm_stopped!(
          value.source,
        ),
      /injected_disconnect/,
    );
    await assert.rejects(
      () =>
        managedPiRepairDependencies(value.request, deps)!.confirm_stopped!(
          value.source,
        ),
      /managed_stop_outcome_unknown/,
    );
    assert.equal(admitted, 1);
  } finally {
    value.cleanup();
  }
});

test('a coordinator epoch change after the live lookup prevents the stop effect', async () => {
  const value = fixture();
  try {
    value.register();
    const control: NonNullable<
      Parameters<typeof managedPiRepairDependencies>[1]
    >['control'] = async (file, action) => {
      const result = await value.control!(file, action);
      if (action === 'snapshot')
        transact(value.taskRoot, {
          actor: 'fixture',
          purpose: 'new-owner',
          apply(record) {
            assert.ok(record.coordinator);
            record.coordinator.owner_epoch++;
            return { record, op: 'new-owner', summary: {}, result: null };
          },
        });
      return result;
    };
    assert.equal(
      await managedPiRepairDependencies(value.request, {
        control,
        peerPid: () => process.pid,
      })!.confirm_stopped!(value.source),
      null,
    );
    assert.equal(value.stops, 0);
  } finally {
    value.cleanup();
  }
});

for (const [label, mutate] of [
  [
    'attempt state',
    (record: TaskRecord) => {
      record.attempts[0]!.state = 'completed';
    },
  ],
  [
    'attempt input',
    (record: TaskRecord) => {
      record.attempts[0]!.input_revision = `sha256:${'3'.repeat(64)}`;
    },
  ],
  [
    'runtime registry',
    (record: TaskRecord) => {
      record.managed_pi_runtime_registry = [];
    },
  ],
] as const) {
  test(`${label} drift during the live lookup prevents the stop effect`, async () => {
    const value = fixture();
    try {
      value.register();
      const control: NonNullable<
        Parameters<typeof managedPiRepairDependencies>[1]
      >['control'] = async (file, action) => {
        const result = await value.control!(file, action);
        if (action === 'snapshot') {
          const changed = transact(value.taskRoot, {
            actor: 'fixture',
            purpose: 'concurrent-authority-change',
            apply(record) {
              mutate(record);
              return {
                record,
                op: 'concurrent-change',
                summary: {},
                result: null,
              };
            },
          });
          assert.ok(changed.ok);
        }
        return result;
      };
      assert.equal(
        await managedPiRepairDependencies(value.request, {
          control,
          peerPid: () => process.pid,
        })!.confirm_stopped!(value.source),
        null,
      );
      assert.equal(value.stops, 0);
      assert.equal(
        fs.existsSync(path.join(value.taskRoot, '.managed-native-stops')),
        false,
      );
    } finally {
      value.cleanup();
    }
  });
}

test('an unrelated normal task commit during the live lookup permits the stop effect', async () => {
  const value = fixture();
  try {
    value.register();
    const control: NonNullable<
      Parameters<typeof managedPiRepairDependencies>[1]
    >['control'] = async (file, action) => {
      const result = await value.control!(file, action);
      if (action === 'snapshot') {
        const changed = transact(value.taskRoot, {
          actor: 'another-actor',
          purpose: 'unrelated-normal-commit',
          apply(record) {
            record.audit_note =
              'Unrelated progress recorded during the native lookup.';
            return {
              record,
              op: 'unrelated-progress',
              summary: {},
              result: null,
            };
          },
        });
        assert.ok(changed.ok);
      }
      return result;
    };
    const receipt = await managedPiRepairDependencies(value.request, {
      control,
      peerPid: () => process.pid,
    })!.confirm_stopped!(value.source);
    assert.equal(receipt?.observation, 'confirmed');
    assert.equal(value.stops, 1);
  } finally {
    value.cleanup();
  }
});

test(
  'Unix socket peer PID comes from the OS rather than the application response',
  {
    skip:
      !['darwin', 'linux'].includes(process.platform) ||
      spawnSync('python3', ['-c', 'import socket'], { timeout: 4000 })
        .status !== 0,
  },
  async () => {
    const directory = fs.mkdtempSync(
      path.join(
        process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(),
        'pi-peer-',
      ),
    );
    const socket = path.join(directory, 'c.sock');
    const peers = new Set<net.Socket>();
    const server = net.createServer((peer) => {
      peers.add(peer);
      peer.on('close', () => peers.delete(peer));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socket, resolve);
      });
      assert.equal(managedPiSocketPeerPid(socket), process.pid);
    } finally {
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
