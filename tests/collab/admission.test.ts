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
import { transitionAttempt } from '../../src/collab/lifecycle.js';
import { preflight } from '../../src/collab/preflight.js';
import { readRecord, transact } from '../../src/collab/store.js';
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
    const attempt = readRecord(box.taskRoot)?.attempts[0];
    assert.equal(attempt?.state, 'unknown');
    assert.equal(attempt.transitions.at(-1)?.from, 'assigned');
    assert.equal(attempt.transitions.at(-1)?.to, 'unknown');
    assert.equal(admitLaunch(box.options).reason, 'attempt_state_unknown');
  } finally {
    box.cleanup();
  }
});

test('settling an already running launch preserves historical markers without appending another', () => {
  const box = launchFixture();
  try {
    assert(
      transact(box.taskRoot, {
        actor: 'fixture',
        purpose: 'seed-legacy-launch-history',
        apply: (record) => {
          assert(
            transitionAttempt(record, {
              subtaskId: 'work',
              attempt: 1,
              to: 'running',
            }).ok,
          );
          const attempt = record.attempts[0]!;
          attempt.transitions.push({
            from: 'running',
            to: 'running',
            at: attempt.updated_at,
            actor: 'launcher',
            reason: 'native launch settled: exited',
            evidence: null,
          });
          return { record, op: 'seed-legacy-launch-history' };
        },
      }).ok,
    );
    const before = readRecord(box.taskRoot)!.attempts[0]!.transitions;
    const reservation = {
      reservation_id: 'resume-running',
      subtask_id: 'work',
      attempt: 1,
      kind: 'resume',
      mode: 'work',
      holder: box.writer,
      requested_session_id: box.writer.session_id,
    };
    assert(reserveLaunch(box.taskRoot, { reservation }).ok);
    assert(
      settleLaunch(box.taskRoot, {
        reservationId: reservation.reservation_id,
        outcome: 'exited',
        sessionId: box.writer.session_id,
        expectedIdentity: box.writer.session_id,
        capabilityEvidence: 'runtime-bound',
        evidenceRef: 'resume-evidence',
      }).ok,
    );
    const record = readRecord(box.taskRoot)!;
    const attempt = record.attempts[0]!;
    assert.equal(attempt.state, 'running');
    assert.deepEqual(attempt.transitions, before);
    assert.equal(attempt.native?.observation, 'confirmed');
    assert.equal(attempt.native?.evidence_ref, 'resume-evidence');
    assert.equal(record.launch_reservations?.at(-1)?.outcome, 'exited');
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
