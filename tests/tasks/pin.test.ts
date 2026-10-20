import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pinTask,
  readAutoResume,
  readTaskPin,
  setAutoResume,
  unpinTask,
} from '../../src/app/task-pin.js';
import {
  baseWorkspaceConfig,
  cleanup,
  makeTempDir,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';

test('task pin is explicit and auto-resume is a workspace switch', async () => {
  const root = makeTempDir('task-pin');
  try {
    writeWorkspaceConfig(root, baseWorkspaceConfig());
    assert.equal((await readTaskPin(root)) !== null, false);
    const pinned = await pinTask(root, 'FIJI-123456');
    assert.equal('message' in pinned, false);
    assert.equal((await readTaskPin(root))?.taskId, 'FIJI-123456');
    assert.equal(await readAutoResume(root), false);

    const switched = await setAutoResume(root, true);
    assert.equal('message' in switched, false);
    assert.equal(await readAutoResume(root), true);

    await unpinTask(root);
    assert.equal((await readTaskPin(root)) !== null, false);
    assert.equal(await readAutoResume(root), true);

    const invalid = await pinTask(root, 'not a task id');
    assert.equal('message' in invalid, true);
  } finally {
    cleanup(root);
  }
});
