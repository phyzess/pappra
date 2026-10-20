import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  admitLaunch,
  claimCovers,
  reserveLaunch,
  settleLaunch,
} from '../../src/collab/admission.js';
import { describeResource } from '../../src/collab/canonical.js';
import { preflight } from '../../src/collab/preflight.js';
import { readRecord } from '../../src/collab/store.js';
import { launchFixture } from './launch-fixture.js';

test('admission checks the pinned contract bytes, current epoch and runtime capability evidence', () => {
  const box = launchFixture();
  try {
    assert.equal(admitLaunch(box.options).ok, true);
    assert.equal(
      admitLaunch({ ...box.options, harness: 'claude' }).reason,
      'harness_contract_mismatch',
    );
    writeFileSync(
      box.assignmentFile,
      JSON.stringify({
        ...box.assignment,
        objective: 'Changed after registration',
      }),
    );
    assert.equal(admitLaunch(box.options).reason, 'assignment_digest_mismatch');
    assert.equal(
      preflight(box.assignment, { ...box.card, evidence_level: 'declared' })
        .status,
      'needs_input',
    );
    assert.equal(
      preflight(
        { ...box.assignment, required: { skills: [], tools: ['mcp:needed'] } },
        box.card,
      ).status,
      'needs_input',
    );
  } finally {
    box.cleanup();
  }
});

test('a reservation excludes a second launch and abnormal settlement requires reconciliation', () => {
  const box = launchFixture();
  try {
    const reservation = {
      reservation_id: 'reservation-1',
      subtask_id: 'work',
      attempt: 1,
      kind: 'first',
      mode: 'work',
      holder: box.writer,
      requested_session_id: box.writer.session_id,
    };
    assert.equal(reserveLaunch(box.taskRoot, { reservation }).ok, true);
    const repeated = reserveLaunch(box.taskRoot, {
      reservation: { ...reservation, reservation_id: 'reservation-2' },
    });
    assert(!repeated.ok);
    assert.equal(repeated.reason, 'launch_already_reserved');
    assert.equal(
      settleLaunch(box.taskRoot, {
        reservationId: reservation.reservation_id,
        outcome: 'timed_out',
        runner: 'pi-cli',
      }).ok,
      true,
    );
    assert.equal(readRecord(box.taskRoot)?.attempts[0]?.state, 'unknown');
    assert.equal(admitLaunch(box.options).reason, 'attempt_state_unknown');
  } finally {
    box.cleanup();
  }
});

test('a child claim cannot authorize its parent directory and not_started leaves the attempt unchanged', () => {
  const box = launchFixture();
  try {
    assert.equal(
      claimCovers(
        describeResource({ path: join(box.root, 'work', 'file') }),
        describeResource({ path: join(box.root, 'work') }),
      ),
      false,
    );
    const reservation = {
      reservation_id: 'reservation',
      subtask_id: 'work',
      attempt: 1,
      kind: 'first',
      mode: 'work',
      holder: box.writer,
      requested_session_id: box.writer.session_id,
    };
    reserveLaunch(box.taskRoot, { reservation });
    settleLaunch(box.taskRoot, {
      reservationId: reservation.reservation_id,
      outcome: 'not_started',
    });
    assert.equal(readRecord(box.taskRoot)?.attempts[0]?.state, 'assigned');
    assert.equal(
      readRecord(box.taskRoot)?.launch_reservations?.[0]?.outcome,
      'not_started',
    );
  } finally {
    box.cleanup();
  }
});
