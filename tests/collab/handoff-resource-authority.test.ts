import assert from 'node:assert/strict';
import test from 'node:test';

import { beginHandoff } from '../../src/collab/handoff.js';
import { readRecord } from '../../src/collab/store.js';
import {
  COORDINATOR,
  RECEIVER,
  WRITER,
  makeHandoffFixture,
} from './handoff-fixtures.js';

test('writer handoff rejects a foreign inventory before reserving the attempt', () => {
  const fixture = makeHandoffFixture('handoff-foreign-inventory');
  try {
    const record = readRecord(fixture.task)!;
    record.claims.push({
      ...record.claims[0]!,
      claim_id: 'foreign-claim',
      holder: RECEIVER,
      subtask_id: 'other-work',
    });
    const before = structuredClone(record);
    const result = beginHandoff(record, {
      handoffId: 'forged-inventory',
      kind: 'writer',
      subtaskId: 'work',
      attempt: 1,
      from: WRITER,
      to: RECEIVER,
      resources: [fixture.claimId, 'foreign-claim'],
      ownerEpoch: 1,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'handoff_resource_not_owned');
    assert.deepEqual(record, before, 'no partial inventory reservation');
  } finally {
    fixture.domain.cleanup();
  }
});

test('invalid inventory is rejected without mutation for writer and coordinator handoffs', () => {
  const fixture = makeHandoffFixture('handoff-invalid-inventory');
  try {
    for (const kind of ['writer', 'coordinator']) {
      for (const invalid of [
        'unknown',
        'released',
        'foreign-session',
        'duplicate-id',
        'ambiguous-id',
      ]) {
        const record = readRecord(fixture.task)!;
        const from = kind === 'writer' ? WRITER : COORDINATOR;
        record.claims[0]!.holder = { ...from };
        let resources = [fixture.claimId];
        if (invalid === 'unknown') resources = ['missing-claim'];
        if (invalid === 'released')
          record.claims[0]!.released_at = '2026-10-24T00:00:00Z';
        if (invalid === 'foreign-session')
          record.claims[0]!.holder.session_id = 'another-session';
        if (invalid === 'duplicate-id') resources.push(fixture.claimId);
        if (invalid === 'ambiguous-id')
          record.claims.push(structuredClone(record.claims[0]!));
        const before = structuredClone(record);
        const result = beginHandoff(record, {
          handoffId: `${kind}-${invalid}`,
          kind,
          subtaskId: kind === 'writer' ? 'work' : null,
          attempt: kind === 'writer' ? 1 : null,
          from,
          to: RECEIVER,
          resources,
          ownerEpoch: 1,
        });
        assert.equal(result.ok, false, `${kind}: ${invalid}`);
        assert.deepEqual(record, before, `${kind}: ${invalid}`);
      }
    }
  } finally {
    fixture.domain.cleanup();
  }
});

test('writer inventory cannot reserve another attempt held by the same session', () => {
  const fixture = makeHandoffFixture('handoff-wrong-attempt-inventory');
  try {
    for (const mismatch of ['subtask', 'attempt']) {
      const record = readRecord(fixture.task)!;
      if (mismatch === 'subtask') record.claims[0]!.subtask_id = 'other-work';
      else record.claims[0]!.attempt = 2;
      const before = structuredClone(record);
      const result = beginHandoff(record, {
        handoffId: `wrong-${mismatch}`,
        kind: 'writer',
        subtaskId: 'work',
        attempt: 1,
        from: WRITER,
        to: RECEIVER,
        resources: [fixture.claimId],
        ownerEpoch: 1,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'handoff_resource_not_owned');
      assert.deepEqual(record, before);
    }
  } finally {
    fixture.domain.cleanup();
  }
});

test('the core handoff boundary rejects a non-owner even with an empty inventory', () => {
  const fixture = makeHandoffFixture('handoff-source-authority');
  try {
    for (const kind of ['writer', 'coordinator']) {
      const record = readRecord(fixture.task)!;
      const before = structuredClone(record);
      const result = beginHandoff(record, {
        handoffId: `wrong-source-${kind}`,
        kind,
        subtaskId: kind === 'writer' ? 'work' : null,
        attempt: kind === 'writer' ? 1 : null,
        from: RECEIVER,
        to: WRITER,
        ownerEpoch: 1,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'unauthorized_sender');
      assert.deepEqual(record, before);
    }
  } finally {
    fixture.domain.cleanup();
  }
});

test('coordinator handoff preserves an empty inventory without reserving writer claims', () => {
  const fixture = makeHandoffFixture('handoff-coordinator-inventory');
  try {
    const record = readRecord(fixture.task)!;
    const claimsBefore = structuredClone(record.claims);
    const result = beginHandoff(record, {
      handoffId: 'coordinator-transfer',
      kind: 'coordinator',
      from: COORDINATOR,
      to: RECEIVER,
      ownerEpoch: 1,
    });
    assert.equal(result.ok, true);
    assert.equal(record.dispatch_frozen, true);
    assert.deepEqual(record.handoffs[0]!.resources, []);
    assert.deepEqual(record.claims, claimsBefore);
    assert.equal(record.attempts[0]!.ownership, undefined);
  } finally {
    fixture.domain.cleanup();
  }
});
