import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as core from '../../src/collab/index.js';
import { breakLock } from '../../src/collab/store.js';
import { exercise, scenarioNames, owner, clock } from './scenarios.js';

export function sandbox() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'pappra-collab-'));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

for (const scenario of scenarioNames) {
  test(`legacy collaboration contract: ${scenario}`, () => {
    const box = sandbox();
    try {
      exercise(core, box.root, scenario);
    } finally {
      box.cleanup();
    }
  });
}

test('locks require explicit recovery and retain the previous holder evidence', () => {
  const box = sandbox();
  try {
    const task = join(box.root, 'domain', 'tasks', 'sample');
    core.store.initTask(task, { taskId: 'sample', coordinator: owner, clock });
    const holder = core.store.acquireLock(task);
    const blocked = core.store.transact(task, {
      waitMs: 0,
      apply: (record) => ({ record }),
    });
    assert(!blocked.ok);
    assert.equal(blocked.reason, 'lock_held');
    assert.equal(core.store.readLock(task).holder?.nonce, holder.nonce);
    assert.throws(
      () => breakLock(task, { actor: 'operator', reason: 'no proof' }),
      /explicit confirmation/,
    );
    assert.throws(
      () => core.store.releaseLock(task, { ...holder, nonce: 'foreign' }),
      /different owner/,
    );
    const broken = breakLock(task, {
      actor: 'operator',
      reason: 'fixture holder stopped',
      confirmHolderStopped: true,
    });
    assert.equal(broken.broken, true);
    assert.equal(core.store.readLock(task).held, false);
  } finally {
    box.cleanup();
  }
});

test('registered but unapplied messages are visible and can be reconciled without a new dispatch', () => {
  const box = sandbox();
  try {
    const task = join(box.root, 'domain', 'tasks', 'sample');
    core.store.initTask(task, { taskId: 'sample', coordinator: owner, clock });
    const message = core.envelope.buildMessage({
      type: 'STATUS_QUERY',
      task_id: 'sample',
      from: owner,
      to: owner,
    });
    assert.equal(
      core.envelope.registerMessage(task, message).status,
      'registered',
    );
    assert(
      core.store
        .doctor(task)
        .findings.some(
          (item) => item.code === 'message_registered_not_applied',
        ),
    );
    assert.equal(core.messages.submitMessage(task, message).ok, true);
    assert.equal(core.store.doctor(task).findings.length, 0);
  } finally {
    box.cleanup();
  }
});

test('malformed and unsupported records cannot be mutated, and extensions survive a valid commit', () => {
  const box = sandbox();
  try {
    const task = join(box.root, 'domain', 'tasks', 'sample');
    const { record } = core.store.initTask(task, {
      taskId: 'sample',
      coordinator: owner,
      clock,
    });
    assert(record);
    record['extension'] = { retained: true };
    writeFileSync(core.store.recordPath(task), JSON.stringify(record));
    assert.equal(
      core.store.transact(task, { apply: (current) => ({ record: current }) })
        .ok,
      true,
    );
    assert.deepEqual(core.store.readRecord(task)?.['extension'], {
      retained: true,
    });
    const ledgerLine = readFileSync(core.store.ledgerPath(task), 'utf8')
      .trim()
      .split('\n')
      .at(-1);
    assert(ledgerLine);
    const ledger: unknown = JSON.parse(ledgerLine);
    assert(
      typeof ledger === 'object' &&
        ledger !== null &&
        'record_digest' in ledger,
    );
    assert.equal(
      ledger.record_digest,
      core.store.digestText(JSON.stringify(core.store.readRecord(task))),
    );
    record.schema = 'harness-collab/state/999';
    writeFileSync(core.store.recordPath(task), JSON.stringify(record));
    const unsupported = core.store.transact(task, {
      apply: (current) => ({ record: current }),
    });
    assert(!unsupported.ok);
    assert.equal(unsupported.reason, 'unsupported_schema');
    writeFileSync(
      core.store.recordPath(task),
      JSON.stringify({ ...record, claims: 'invalid' }),
    );
    assert.throws(
      () => core.store.readRecord(task),
      /Invalid task record structure/,
    );
  } finally {
    box.cleanup();
  }
});
