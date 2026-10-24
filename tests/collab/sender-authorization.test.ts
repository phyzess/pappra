import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMessage } from '../../src/collab/envelope.js';
import { applyMessage } from '../../src/collab/messages.js';
import { newRecord } from '../../src/collab/store.js';
import type { Identity, MessageInput } from '../../src/collab/types.js';

const coordinator = {
  agent_id: 'coordinator',
  session_id: 'coordinator-session',
  harness: 'codex',
  owner_epoch: 1,
  since: '2026-10-24T00:00:00Z',
};
const worker: Identity = {
  agent_id: 'worker',
  session_id: 'worker-session',
  harness: 'pi',
};
const foreign: Identity = {
  agent_id: 'foreign',
  session_id: 'foreign-session',
  harness: 'pi',
};
const clock = Date.parse('2026-10-24T00:00:00Z');

function message(type: string, overrides: Partial<MessageInput> = {}) {
  return buildMessage(
    {
      type,
      message_id: `message-${type}`,
      task_id: 'task',
      from: coordinator,
      to: worker,
      subtask_id: 'work',
      attempt: 1,
      owner_epoch: 1,
      body: {},
      ...overrides,
    },
    { clock },
  );
}

function record() {
  const value = newRecord({
    taskId: 'task',
    domainRoot: '/tmp/domain',
    taskRoot: '/tmp/domain/tasks/task',
    coordinator,
    clock,
  });
  const outcome = applyMessage(
    value,
    message('ASSIGN', { body: { assignment_digest: 'sha256:fixture' } }),
    { clock },
  );
  assert('record' in outcome);
  return value;
}

test('dispatch messages require the coordinator identity before any epoch mutation', () => {
  for (const type of ['ASSIGN', 'CANCEL', 'HANDOFF']) {
    for (const from of [
      foreign,
      { ...coordinator, session_id: 'another-session' },
    ]) {
      const value = record();
      const before = structuredClone(value);
      const outcome = applyMessage(
        value,
        message(type, {
          message_id: `forged-${type}`,
          from,
          owner_epoch: 99,
          body:
            type === 'ASSIGN'
              ? { assignment_digest: 'sha256:forged' }
              : type === 'HANDOFF'
                ? { kind: 'coordinator', phase: 'request', handoff_id: 'h1' }
                : {},
        }),
        { clock },
      );
      assert.deepEqual(outcome, { ok: false, reason: 'unauthorized_sender' });
      assert.deepEqual(value, before);
    }
  }
});

test('attempt messages reject unrelated workers and stale assignee sessions', () => {
  for (const type of ['ACK', 'BLOCK', 'CANCELLED', 'HANDOFF']) {
    for (const from of [
      foreign,
      coordinator,
      { ...worker, session_id: 'old-session' },
    ]) {
      if (from === coordinator && type === 'BLOCK') continue;
      const value = record();
      const before = structuredClone(value);
      const outcome = applyMessage(
        value,
        message(type, {
          from,
          to: coordinator,
          reply_to: 'message-ASSIGN',
          body:
            type === 'BLOCK'
              ? { kind: 'clarification' }
              : type === 'CANCELLED'
                ? { stop_evidence: 'claimed-stop' }
                : type === 'HANDOFF'
                  ? { kind: 'writer', phase: 'request', handoff_id: 'h1' }
                  : {},
        }),
        { clock },
      );
      assert.deepEqual(outcome, { ok: false, reason: 'unauthorized_sender' });
      assert.deepEqual(value, before);
    }
  }
});

test('coordinator instructions and acceptance decisions never resume clarification blocks', () => {
  for (const body of [
    { note: 'continue' },
    { acceptance: { decision: 'accepted' } },
  ]) {
    const value = record();
    assert(
      'record' in
        applyMessage(
          value,
          message('BLOCK', {
            from: worker,
            to: coordinator,
            body: { kind: 'clarification' },
          }),
          { clock },
        ),
    );
    const beforeAttempt = structuredClone(value.attempts);
    const answer = message('ANSWER', { reply_to: 'message-ASSIGN', body });
    assert('record' in applyMessage(value, answer, { clock }));
    assert.deepEqual(value.attempts, beforeAttempt);
    const before = structuredClone(value);
    assert.deepEqual(
      applyMessage(
        value,
        { ...answer, message_id: 'forged-decision', from: foreign },
        { clock },
      ),
      { ok: false, reason: 'unauthorized_sender' },
    );
    assert.deepEqual(value, before);
  }
});

test('the coordinator can gate approval without allowing an automatic answer', () => {
  const value = record();
  assert(
    'record' in
      applyMessage(value, message('BLOCK', { body: { kind: 'approval' } }), {
        clock,
      }),
  );
  assert.equal(value.attempts[0]?.state, 'needs_input');
  const answer = message('ANSWER', {
    from: worker,
    to: coordinator,
    reply_to: 'message-BLOCK',
  });
  assert.deepEqual(applyMessage(value, answer, { clock }), {
    ok: false,
    reason: 'approval_not_auto_answerable',
  });
});

test('a forged cancellation cannot release resources before the authorized worker confirms stopping', () => {
  const value = record();
  value.claims.push({
    claim_id: 'claim',
    kind: 'path',
    scope: 'workspace',
    key: '/tmp/work',
    label: 'work',
    access: 'write',
    holder: worker,
    resource_epoch: 1,
    claimed_at: coordinator.since,
    released_at: null,
    subtask_id: 'work',
    attempt: 1,
    note: null,
  });
  const cancel = applyMessage(value, message('CANCEL'), { clock });
  assert('record' in cancel);
  const before = structuredClone(value);
  const stopped = message('CANCELLED', {
    from: foreign,
    to: coordinator,
    reply_to: 'message-CANCEL',
    body: { stop_evidence: 'stop' },
  });
  assert.deepEqual(applyMessage(value, stopped, { clock }), {
    ok: false,
    reason: 'unauthorized_sender',
  });
  assert.deepEqual(value, before);
  const legitimate = applyMessage(
    value,
    { ...stopped, from: worker },
    { clock },
  );
  assert('record' in legitimate);
  assert.equal(value.attempts[0]?.state, 'cancelled');
  assert(value.claims[0]?.released_at);
});

test('clarification answers bind sender, recipient and attempt to the original question', () => {
  const value = record();
  assert(
    'record' in
      applyMessage(
        value,
        message('BLOCK', {
          from: worker,
          to: coordinator,
          body: { kind: 'clarification' },
        }),
        { clock },
      ),
  );
  const before = structuredClone(value);
  const answer = message('ANSWER', { reply_to: 'message-BLOCK' });
  assert.deepEqual(
    applyMessage(value, { ...answer, from: foreign }, { clock }),
    { ok: false, reason: 'unauthorized_sender' },
  );
  assert.deepEqual(
    applyMessage(value, { ...answer, subtask_id: 'other' }, { clock }),
    { ok: false, reason: 'reply_identity_mismatch' },
  );
  assert.deepEqual(value, before);
  assert('record' in applyMessage(value, answer, { clock }));
  assert.equal(value.attempts[0]?.state, 'running');
});

test('an informational ASK cannot grant authority to resume another worker', () => {
  const value = record();
  assert(
    'record' in
      applyMessage(
        value,
        message('BLOCK', {
          from: worker,
          to: coordinator,
          body: { kind: 'clarification' },
        }),
        { clock },
      ),
  );
  assert(
    'record' in
      applyMessage(value, message('ASK', { from: foreign, to: foreign }), {
        clock,
      }),
  );
  const before = structuredClone(value);
  assert.deepEqual(
    applyMessage(
      value,
      message('ANSWER', {
        from: foreign,
        to: foreign,
        reply_to: 'message-ASK',
      }),
      { clock },
    ),
    { ok: false, reason: 'stale_question' },
  );
  assert.deepEqual(value, before);
});

test('the pending coordinator receiver can acknowledge a handoff without a writer attempt', () => {
  const value = record();
  assert(
    'record' in
      applyMessage(
        value,
        message('HANDOFF', {
          attempt: null,
          body: {
            kind: 'coordinator',
            phase: 'request',
            handoff_id: 'coordinator-handoff',
          },
        }),
        { clock },
      ),
  );
  const beforeAttempt = structuredClone(value.attempts);
  const ack = message('ACK', {
    from: worker,
    to: coordinator,
    subtask_id: null,
    attempt: null,
    reply_to: 'coordinator-handoff',
    body: { handoff_id: 'coordinator-handoff' },
  });
  assert('record' in applyMessage(value, ack, { clock }));
  assert.deepEqual(value.attempts, beforeAttempt);
  assert.equal(value.messages.at(-1)?.type, 'ACK');
  const before = structuredClone(value);
  assert.deepEqual(
    applyMessage(
      value,
      { ...ack, message_id: 'forged-ack', from: foreign },
      { clock },
    ),
    { ok: false, reason: 'unknown_attempt' },
  );
  assert.deepEqual(value, before);
});
