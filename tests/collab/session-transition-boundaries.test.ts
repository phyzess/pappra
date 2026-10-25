import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskRecord } from '../../src/collab/types.js';
import {
  SESSION_TRANSITION_JOURNAL_KEY,
  addJournalEntry,
  hasJournalConflict,
  journalEntry,
  readJournal,
  setJournalEffect,
  setJournalQuiescenceReceipt,
} from '../../src/app/collab-session-transition/journal.js';
import { parseQuiescenceReceipt } from '../../src/app/collab-session-transition/journal.js';
import type { SessionTransitionRequest } from '../../src/app/collab-session-transition-request.js';
import type { SessionTransitionQuiescenceReceipt } from '../../src/app/collab-session-transition/types.js';

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const TASK_ROOT = '/tmp/task-boundaries';

// The journal helpers take the authoritative record plus the pinned request; both are
// exercised here as plain values so no store, host or clock is involved.
function makeRecord(): TaskRecord {
  return {
    task_id: 'task-boundaries',
    task_root: TASK_ROOT,
    state_revision: 1,
  } as unknown as TaskRecord;
}

function makeRequest(
  overrides: Record<string, unknown> = {},
): SessionTransitionRequest {
  return {
    transition_id: 'transition-1',
    task_root: TASK_ROOT,
    bootstrap_request: { ref: `${TASK_ROOT}/bootstrap.json`, digest: DIGEST_B },
    intent: { handoff_id: 'handoff-1', intent_id: 'intent-1', generation: 1 },
    ...overrides,
  } as unknown as SessionTransitionRequest;
}

function makeReceipt(
  observedAt = '2026-10-25T10:00:00.000Z',
): SessionTransitionQuiescenceReceipt {
  return {
    schema: 'pappra/session-transition-quiescence-receipt/1',
    adapter_id: 'pappra/pi-session-transition-host/1',
    session_id: 'session-1',
    cwd: '/tmp/source',
    observed_at: observedAt,
    sequence: 4,
    evidence_ref: `${TASK_ROOT}/quiescence.json`,
    freeze_token: {
      sessionId: 'session-1',
      taskId: 'task-boundaries',
      handoffId: 'handoff-1',
      generation: 1,
    },
    inventory_digest: DIGEST_A,
  } as SessionTransitionQuiescenceReceipt;
}

test('an absent journal reads as empty and rejects a malformed record', () => {
  const empty = readJournal(makeRecord());
  assert.equal(empty.ok, true);
  assert.equal(empty.ok && empty.value.entries.length, 0);

  const malformed = makeRecord() as TaskRecord & Record<string, unknown>;
  malformed[SESSION_TRANSITION_JOURNAL_KEY] = {
    schema: 'pappra/other/1',
    entries: [],
  };
  const rejected = readJournal(malformed);
  assert.equal(rejected.ok, false);
  assert.equal(!rejected.ok && rejected.code, 'transition_journal_invalid');
});

test('journal intent is idempotent for one digest and a conflict for another', () => {
  const record = makeRecord();
  const request = makeRequest();

  assert.deepEqual(
    addJournalEntry(record, request, DIGEST_A, '2026-10-25T10:00:00.000Z'),
    {
      ok: true,
    },
  );
  assert.deepEqual(
    addJournalEntry(record, request, DIGEST_A, '2026-10-25T10:00:05.000Z'),
    {
      ok: true,
    },
  );
  const loaded = readJournal(record);
  assert.equal(loaded.ok && loaded.value.entries.length, 1);
  assert.equal(
    loaded.ok && loaded.value.entries[0]?.created_at,
    '2026-10-25T10:00:00.000Z',
  );

  assert.deepEqual(
    addJournalEntry(record, request, DIGEST_B, '2026-10-25T10:00:10.000Z'),
    {
      ok: false,
      code: 'transition_request_conflict',
    },
  );
  assert.equal(hasJournalConflict(record, request, DIGEST_B), true);
  assert.equal(
    hasJournalConflict(
      record,
      makeRequest({ transition_id: 'transition-2' }),
      DIGEST_B,
    ),
    false,
  );
});

test('a request digest conflict is scoped to the transition entry', () => {
  const record = makeRecord();
  const first = makeRequest();
  addJournalEntry(record, first, DIGEST_A, '2026-10-25T10:00:00.000Z');

  const other = makeRequest({ transition_id: 'transition-2' });
  assert.deepEqual(
    addJournalEntry(record, other, DIGEST_B, '2026-10-25T10:00:01.000Z'),
    { ok: true },
  );
  assert.equal(
    journalEntry(record, first, DIGEST_A)?.transition_id,
    'transition-1',
  );
  assert.equal(journalEntry(record, first, DIGEST_B), null);
});

test('the journal enforces its entry bound', () => {
  const record = makeRecord();
  for (let index = 0; index < 32; index++) {
    const request = makeRequest({ transition_id: `transition-${index}` });
    const result = addJournalEntry(
      record,
      request,
      DIGEST_A,
      '2026-10-25T10:00:00.000Z',
    );
    assert.deepEqual(result, { ok: true });
  }
  const overflow = addJournalEntry(
    record,
    makeRequest({ transition_id: 'transition-overflow' }),
    DIGEST_A,
    '2026-10-25T10:00:00.000Z',
  );
  assert.deepEqual(overflow, { ok: false, code: 'transition_journal_limit' });
});

test('an effect intent stays pending until an outcome is recorded', () => {
  const record = makeRecord();
  const request = makeRequest();
  addJournalEntry(record, request, DIGEST_A, '2026-10-25T10:00:00.000Z');

  assert.deepEqual(
    setJournalEffect(record, request.transition_id, {
      name: 'source-freeze',
      state: 'pending',
      at: '2026-10-25T10:00:01.000Z',
    }),
    { ok: true },
  );
  const pending = journalEntry(record, request, DIGEST_A)?.effects[
    'source-freeze'
  ];
  assert.equal(pending?.state, 'pending');
  assert.equal(pending?.intent_at, '2026-10-25T10:00:01.000Z');
  assert.equal(pending?.outcome_at, undefined);

  assert.deepEqual(
    setJournalEffect(record, request.transition_id, {
      name: 'source-freeze',
      state: 'completed',
      at: '2026-10-25T10:00:02.000Z',
    }),
    { ok: true },
  );
  const completed = journalEntry(record, request, DIGEST_A)?.effects[
    'source-freeze'
  ];
  assert.equal(completed?.state, 'completed');
  assert.equal(completed?.outcome_at, '2026-10-25T10:00:02.000Z');
  // The recorded intent timestamp is preserved, so ordering stays observable.
  assert.equal(completed?.intent_at, '2026-10-25T10:00:01.000Z');

  assert.deepEqual(
    setJournalEffect(record, 'transition-missing', {
      name: 'source-freeze',
      state: 'completed',
      at: '2026-10-25T10:00:03.000Z',
    }),
    { ok: false, code: 'transition_journal_missing' },
  );
});

test('completed artifacts are pinned to the entry and a different receipt conflicts', () => {
  const record = makeRecord();
  const request = makeRequest();
  addJournalEntry(record, request, DIGEST_A, '2026-10-25T10:00:00.000Z');

  assert.deepEqual(
    setJournalEffect(record, request.transition_id, {
      name: 'successor-route-binding',
      state: 'completed',
      at: '2026-10-25T10:00:01.000Z',
      ref: `${TASK_ROOT}/notifications/session-transition-bindings/transition-1.json`,
      digest: DIGEST_A,
      artifact: 'route-binding',
    }),
    { ok: true },
  );
  const entry = journalEntry(record, request, DIGEST_A);
  assert.equal(
    entry?.route_binding_ref,
    `${TASK_ROOT}/notifications/session-transition-bindings/transition-1.json`,
  );
  assert.equal(entry?.route_binding_digest, DIGEST_A);
  assert.equal(entry?.archive_ref, undefined);

  const receipt = makeReceipt();
  assert.deepEqual(
    setJournalQuiescenceReceipt(
      record,
      request.transition_id,
      'source',
      receipt,
    ),
    { ok: true },
  );
  assert.deepEqual(
    setJournalQuiescenceReceipt(
      record,
      request.transition_id,
      'source',
      makeReceipt('2026-10-25T10:00:09.000Z'),
    ),
    { ok: false, code: 'source_quiescence_receipt_conflict' },
  );
  assert.equal(
    journalEntry(record, request, DIGEST_A)?.source_quiescence_receipt
      ?.observed_at,
    receipt.observed_at,
  );
});

test('quiescence receipts are parsed strictly and never promoted from partial data', () => {
  const receipt = makeReceipt();
  assert.deepEqual(parseQuiescenceReceipt(receipt), receipt);
  // A scoped receipt without its execution-scope digest is not a valid scoped receipt.
  assert.equal(
    parseQuiescenceReceipt({
      ...receipt,
      schema: 'pappra/session-transition-quiescence-receipt/2',
    }),
    null,
  );
  assert.equal(
    parseQuiescenceReceipt({ ...receipt, inventory_digest: 'not-a-digest' }),
    null,
  );
  assert.equal(parseQuiescenceReceipt({ ...receipt, sequence: -1 }), null);
  assert.equal(
    parseQuiescenceReceipt({
      ...receipt,
      freeze_token: { ...receipt.freeze_token, sessionId: 'other' },
    }),
    null,
  );
});

test('a journal entry with a malformed effect state is rejected rather than repaired', () => {
  const record = makeRecord() as TaskRecord & Record<string, unknown>;
  record[SESSION_TRANSITION_JOURNAL_KEY] = {
    schema: 'pappra/session-transition-journal/1',
    entries: [
      {
        transition_id: 'transition-1',
        request_digest: DIGEST_A,
        bootstrap_request_digest: DIGEST_B,
        created_at: '2026-10-25T10:00:00.000Z',
        updated_at: '2026-10-25T10:00:00.000Z',
        effects: {
          'source-freeze': {
            state: 'done',
            intent_at: '2026-10-25T10:00:00.000Z',
          },
        },
      },
    ],
  };
  const loaded = readJournal(record);
  assert.equal(loaded.ok, false);
  assert.equal(!loaded.ok && loaded.code, 'transition_journal_invalid');
});
