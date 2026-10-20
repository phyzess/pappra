import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { implementation } from './implementations.js';
const {
  groupState,
  ownedChild,
  snapshotOwnedTree,
  spawnOwnedGroup,
  stopOwnedGroup,
  stopSnapshottedTree,
} = await implementation('groups');

const supported = process.platform !== 'win32';
const idle = fileURLToPath(new URL('./idle.js', import.meta.url));
async function start() {
  const handle = spawnOwnedGroup(process.execPath, [idle]);
  const child = ownedChild(handle);
  assert(child.stdout);
  await once(child.stdout, 'data');
  return handle;
}

test(
  'owned process groups reject forged handles and stop only the owned group',
  { skip: !supported, timeout: 15_000 },
  async () => {
    assert.throws(() => ownedChild({}), /unforgeable_handle_required/);
    const handle = await start();
    try {
      assert(Object.isFrozen(handle));
      await assert.rejects(
        stopOwnedGroup({ ...handle }),
        /unforgeable_handle_required/,
      );
      assert.equal(groupState(handle).group_live, true);
      const result = await stopOwnedGroup(handle, {
        termMs: 1000,
        killMs: 1000,
      });
      assert.equal(result.stopped, true);
      assert.equal(groupState(handle).group_live, false);
    } finally {
      await stopOwnedGroup(handle);
    }
  },
);

test(
  'a tree snapshot is bound to its genuine owner and cannot redirect signals',
  { skip: !supported, timeout: 15_000 },
  async () => {
    const first = await start();
    const second = await start();
    try {
      const snapshot = snapshotOwnedTree(first);
      await assert.rejects(
        stopSnapshottedTree({ ...snapshot }, { handle: first }),
        /unforgeable_snapshot_required/,
      );
      await assert.rejects(
        stopSnapshottedTree(snapshot, { handle: second }),
        /snapshot_owner_mismatch/,
      );
      assert.equal(groupState(first).group_live, true);
      assert.equal(groupState(second).group_live, true);
      assert.equal(
        (
          await stopSnapshottedTree(snapshot, {
            handle: first,
            termMs: 1000,
            killMs: 1000,
          })
        ).stopped,
        true,
      );
      assert.equal(groupState(second).group_live, true);
    } finally {
      await stopOwnedGroup(first);
      await stopOwnedGroup(second);
    }
  },
);
