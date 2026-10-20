import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as current from '../../src/collab/index.js';
import type {
  Identity,
  MessageBody,
  MessageInput,
  TaskRecord,
} from '../../src/collab/types.js';

export type Core = typeof current;
export const clock = Date.parse('2026-10-16T04:00:00Z');
export const owner = {
  agent_id: 'coordinator',
  session_id: 'coord-session',
  harness: 'pi',
  owner_epoch: 1,
  since: '2026-10-16T12:00:00+08:00',
};
export const writer: Identity = {
  agent_id: 'writer',
  session_id: 'writer-session',
  harness: 'codex',
};
export const receiver: Identity = {
  agent_id: 'receiver',
  session_id: 'receiver-session',
  harness: 'claude',
};

export const scenarioNames = [
  'revision',
  'messages',
  'retry',
  'results',
  'approval',
  'cancellation',
  'resources',
  'writer-handoff',
  'coordinator-handoff',
  'handoff-drift',
  'notifications',
  'unreadable-domain',
  'resource-aliases',
] as const;
export type Scenario = (typeof scenarioNames)[number];

/** The same synthetic corpus runs against the pinned legacy implementation and this port. */
export function exercise(api: Core, root: string, scenario: Scenario): unknown {
  const domain = join(root, 'domain');
  const taskRoot = join(domain, 'tasks', 'sample');
  const { store, envelope, messages, lifecycle, resources, handoff, notify } =
    api;
  store.initTask(taskRoot, { taskId: 'sample', coordinator: owner, clock });
  const load = (): TaskRecord => {
    const record = store.readRecord(taskRoot);
    assert(record);
    return record;
  };
  const outcomes: unknown[] = [];
  const send = (
    type: string,
    id: string,
    body: MessageBody = {},
    extra: Partial<MessageInput> = {},
  ) => {
    const message = envelope.buildMessage(
      {
        type,
        message_id: id,
        task_id: 'sample',
        from: owner,
        to: writer,
        subtask_id: 'work',
        attempt: 1,
        owner_epoch: 1,
        body,
        ...extra,
      },
      { clock },
    );
    const outcome = messages.submitMessage(taskRoot, message, { clock });
    outcomes.push(outcome);
    return outcome;
  };
  const assign = (id = 'assign', extra: Partial<MessageInput> = {}) =>
    send(
      'ASSIGN',
      id,
      { assignment_digest: 'sha256:fixture', input_revision: 'input-a' },
      extra,
    );
  const recordMutation = (apply: (record: TaskRecord) => void) =>
    store.transact(taskRoot, {
      clock,
      apply: (record) => {
        apply(record);
        return { record };
      },
    });
  const claim = (
    holder = writer,
    path = join(root, 'work'),
    subtaskId = 'work',
  ) =>
    resources.claimResources(taskRoot, {
      resources: [{ path }],
      holder,
      subtaskId,
      attempt: 1,
      clock,
    });
  const receipt = (
    status: string,
    id: string,
    extra: Partial<MessageInput> = {},
  ) =>
    send(
      'REPORT',
      id,
      { status, input_revision: 'input-a' },
      { from: writer, to: owner, ...extra },
    );

  switch (scenario) {
    case 'revision': {
      outcomes.push(
        store.transact(taskRoot, {
          expectRevision: 1,
          clock,
          apply: (record) => {
            record.input_revision = 'first';
            return { record, op: 'pin' };
          },
        }),
      );
      const stale = store.transact(taskRoot, {
        expectRevision: 1,
        clock,
        apply: (record) => {
          record.input_revision = 'wrong';
          return { record };
        },
      });
      assert.equal(stale.ok, false);
      assert.equal(stale.reason, 'revision_conflict');
      assert.equal(load().input_revision, 'first');
      outcomes.push(stale);
      break;
    }
    case 'messages': {
      assert.equal(assign().ok, true);
      assert.equal(assign().duplicate, true);
      const conflict = send('ASSIGN', 'assign', {
        assignment_digest: 'different',
      });
      assert.equal(conflict.reason, 'content_conflict');
      assert.equal(assign('repeat').reason, 'attempt_in_flight');
      assert.equal(assign('other', { subtask_id: 'other' }).ok, true);
      assert.equal(assign('stale', { owner_epoch: 9 }).reason, 'stale_epoch');
      assert.equal(load().attempts.length, 2);
      assert(load().uncertainty.some((item) => item.kind === 'stale_epoch'));
      break;
    }
    case 'retry': {
      assign();
      assert.equal(
        send(
          'ASSIGN',
          'no-approval',
          { assignment_digest: 'x' },
          { attempt: 2 },
        ).reason,
        'attempt_requires_approval',
      );
      assert.equal(
        send(
          'ASSIGN',
          'still-running',
          {
            assignment_digest: 'x',
            approval: { approved_by: 'operator', reason: 'retry' },
          },
          { attempt: 2 },
        ).reason,
        'previous_attempt_not_stopped',
      );
      send(
        'BLOCK',
        'clarify',
        { kind: 'clarification' },
        { from: writer, to: owner },
      );
      assert.equal(
        send(
          'ASSIGN',
          'still-blocked',
          {
            assignment_digest: 'x',
            approval: { approved_by: 'operator', reason: 'retry' },
          },
          { attempt: 2 },
        ).reason,
        'previous_attempt_not_stopped',
      );
      send('ANSWER', 'answer', {}, { reply_to: 'clarify' });
      receipt('completed', 'done');
      assert.equal(
        send(
          'ASSIGN',
          'retry-approved',
          {
            assignment_digest: 'x',
            approval: { approved_by: 'operator', reason: 'retry' },
          },
          { attempt: 2 },
        ).ok,
        true,
      );
      break;
    }
    case 'results': {
      assign();
      receipt('running', 'progress');
      recordMutation((record) => {
        record.input_revision = 'another-subtask';
      });
      receipt('completed', 'done');
      receipt('failed', 'late');
      receipt('completed', 'old-input', {
        body: { status: 'completed', input_revision: 'wrong' },
      });
      const record = load();
      assert.equal(record.attempts[0]?.state, 'completed');
      assert.deepEqual(
        record.results.map((item) => item.classification),
        ['applied', 'applied', 'late', 'superseded'],
      );
      break;
    }
    case 'approval': {
      assign();
      send(
        'BLOCK',
        'approval',
        { kind: 'approval' },
        { from: writer, to: owner },
      );
      assert.equal(
        send('ANSWER', 'auto-answer', {}, { reply_to: 'approval' }).reason,
        'approval_not_auto_answerable',
      );
      receipt('completed', 'withheld');
      assert.equal(load().results[0]?.classification, 'withheld');
      assert.equal(load().attempts[0]?.state, 'needs_input');
      outcomes.push(
        store.transact(taskRoot, {
          clock,
          apply: (record) => {
            const result = lifecycle.transitionAttempt(record, {
              subtaskId: 'work',
              attempt: 1,
              to: 'running',
              evidence: {
                authorization: { approved_by: 'operator', reason: 'approved' },
              },
              clock,
            });
            assert.equal(result.ok, true);
            return { record, result };
          },
        }),
      );
      receipt('completed', 'approved-completion');
      assert.equal(load().results[1]?.classification, 'applied');
      break;
    }
    case 'cancellation': {
      assign();
      assert.equal(claim().ok, true);
      assert.equal(
        claim({ ...writer, session_id: 'other-session' }, join(root, 'other'))
          .ok,
        true,
      );
      send('CANCEL', 'cancel');
      let record = load();
      assert.equal(record.claims[0]?.cancel_pending, true);
      assert.equal(record.claims[1]?.cancel_pending, undefined);
      assert.equal(
        send(
          'CANCELLED',
          'unconfirmed',
          {},
          { from: writer, to: owner, reply_to: 'cancel' },
        ).reason,
        'stop_evidence_required',
      );
      assert.equal(
        send(
          'CANCELLED',
          'stopped',
          { stop_evidence: 'fixture/native-stop.json' },
          { from: writer, to: owner, reply_to: 'cancel' },
        ).ok,
        true,
      );
      record = load();
      assert(record.claims[0]?.released_at);
      assert.equal(record.claims[1]?.released_at, null);
      break;
    }
    case 'resources': {
      assert.equal(claim().ok, true);
      const secondRoot = join(domain, 'tasks', 'other');
      store.initTask(secondRoot, {
        taskId: 'other',
        coordinator: owner,
        clock,
      });
      const contested = resources.claimResources(secondRoot, {
        resources: [{ path: join(root, 'work') }],
        holder: receiver,
        clock,
      });
      assert(!contested.ok);
      assert.equal(contested.reason, 'resource_conflict');
      outcomes.push(contested);
      const first = load().claims[0];
      assert(first);
      outcomes.push(
        resources.releaseClaim(taskRoot, {
          claimId: first.claim_id,
          holder: writer,
          clock,
        }),
      );
      assert.equal(claim(receiver).ok, true);
      assert.equal(load().claims[1]?.resource_epoch, 2);
      break;
    }
    case 'resource-aliases': {
      const target = join(root, 'real');
      mkdirSync(target);
      symlinkSync(target, join(root, 'alias'));
      const expanded = resources.expandResources(
        [{ path: target }, { path: target }, { path: join(root, 'alias') }],
        { includeGit: false },
      );
      assert.equal(expanded.length, 1);
      outcomes.push(expanded);
      claim(writer, target);
      const conflict = claim(receiver, join(root, 'alias', 'child'));
      assert(!conflict.ok);
      assert.equal(conflict.reason, 'resource_conflict');
      const first = load().claims[0];
      assert(first);
      recordMutation((record) => {
        record.claims.push(structuredClone(first));
      });
      const ambiguous = resources.releaseClaim(taskRoot, {
        claimId: first.claim_id,
        holder: writer,
        clock,
      });
      assert(!ambiguous.ok);
      assert.equal(ambiguous.reason, 'ambiguous_claim_id');
      outcomes.push(ambiguous);
      break;
    }
    case 'writer-handoff':
    case 'handoff-drift': {
      assign();
      claim();
      const record = load();
      const first = record.claims[0];
      assert(first);
      const options = {
        handoffId: 'transfer',
        kind: 'writer',
        subtaskId: 'work',
        attempt: 1,
        from: writer,
        to: receiver,
        resources: [first.claim_id],
        ownerEpoch: 1,
        clock,
      };
      outcomes.push(handoff.beginHandoff(record, options));
      const overlapping = handoff.beginHandoff(record, {
        ...options,
        handoffId: 'overlap',
      });
      assert.equal(overlapping.reason, 'overlapping_handoff');
      outcomes.push(overlapping);
      assert.equal(
        handoff.markOldWriterStopped(record, {
          handoffId: 'transfer',
          observation: 'unknown',
          clock,
        }).reason,
        'old_writer_not_stopped',
      );
      assert.equal(
        handoff.markOldWriterStopped(record, {
          handoffId: 'transfer',
          observation: 'confirmed',
          evidenceRef: 'fixture/stop.json',
          clock,
        }).ok,
        true,
      );
      assert.equal(
        handoff.markTransferring(record, { handoffId: 'transfer', clock }).ok,
        true,
      );
      const ack = envelope.buildMessage(
        {
          type: 'ACK',
          task_id: 'sample',
          from: receiver,
          to: owner,
          reply_to: 'transfer',
          body: { handoff_id: 'transfer' },
        },
        { clock },
      );
      assert.equal(
        handoff.confirmReceiver(record, {
          handoffId: 'transfer',
          message: ack,
          clock,
        }).ok,
        true,
      );
      assert.equal(
        handoff.rebindReceiver(record, {
          handoffId: 'transfer',
          to: writer,
          evidenceRef: 'fixture/new-session.json',
          clock,
        }).reason,
        'already_confirmed',
      );
      if (scenario === 'handoff-drift') first.resource_epoch += 1;
      const completed = handoff.completeHandoff(record, {
        handoffId: 'transfer',
        clock,
      });
      outcomes.push(completed);
      assert.equal(completed.ok, scenario === 'writer-handoff');
      if (scenario === 'writer-handoff') {
        assert.equal(first.holder.agent_id, receiver.agent_id);
        assert.equal(first.resource_epoch, 2);
        assert.equal(record.coordinator?.owner_epoch, 1);
        outcomes.push(
          api.messages.applyMessage(
            record,
            envelope.buildMessage(
              {
                type: 'REPORT',
                task_id: 'sample',
                message_id: 'stale-writer',
                from: writer,
                to: owner,
                subtask_id: 'work',
                attempt: 1,
                body: { status: 'completed' },
              },
              { clock },
            ),
            { clock },
          ),
        );
        assert.equal(record.results[0]?.classification, 'stale_sender');
      } else assert.equal(completed.reason, 'ownership_changed');
      outcomes.push(record);
      break;
    }
    case 'coordinator-handoff': {
      const record = load();
      assert.equal(
        handoff.beginHandoff(record, {
          handoffId: 'coordinate',
          kind: 'coordinator',
          from: owner,
          to: receiver,
          ownerEpoch: 1,
          clock,
        }).ok,
        true,
      );
      assert.equal(record.dispatch_frozen, true);
      assert.equal(
        handoff.markTransferring(record, { handoffId: 'coordinate', clock }).ok,
        true,
      );
      const ack = envelope.buildMessage(
        {
          type: 'ACK',
          task_id: 'sample',
          from: receiver,
          to: owner,
          reply_to: 'coordinate',
        },
        { clock },
      );
      assert.equal(
        handoff.confirmReceiver(record, {
          handoffId: 'coordinate',
          message: ack,
          clock,
        }).ok,
        true,
      );
      assert.equal(
        handoff.completeHandoff(record, { handoffId: 'coordinate', clock }).ok,
        true,
      );
      assert.equal(record.coordinator?.owner_epoch, 2);
      assert.equal(
        handoff.releaseDispatchFreeze(record, { ownerEpoch: 1, clock }).reason,
        'stale_epoch',
      );
      assert.equal(
        handoff.releaseDispatchFreeze(record, { ownerEpoch: 2, clock }).ok,
        true,
      );
      assert.equal(
        handoff.completeHandoff(record, { handoffId: 'coordinate', clock })
          .reason,
        'invalid_handoff_transition',
      );
      outcomes.push(record);
      break;
    }
    case 'notifications': {
      const record = load();
      const notification = {
        schema: 'harness-collab/notification/1',
        kind: 'task_event',
        task_id: 'sample',
        origin_session: 'one',
        target_session: 'two',
      };
      for (let index = 0; index < 4; index++)
        outcomes.push(
          notify.admitNotification(record, notification, { clock }),
        );
      assert.equal(record.notifications?.at(-1)?.reason, 'rate_limited');
      outcomes.push(
        notify.admitNotification(
          record,
          { ...notification, target_session: 'one' },
          { clock },
        ),
      );
      outcomes.push(
        notify.admitNotification(
          record,
          { ...notification, depth: 3 },
          { clock },
        ),
      );
      const approval = notify.admitNotification(
        record,
        { ...notification, kind: 'approval_request' },
        { clock },
      );
      assert.equal(approval.admit, false);
      assert.equal(approval.human_required, true);
      outcomes.push(
        approval,
        notify.trimNotificationLog(record, { limits: { max_entries: 2 } }),
        record,
      );
      break;
    }
    case 'unreadable-domain': {
      const broken = join(domain, 'tasks', 'broken');
      mkdirSync(broken);
      writeFileSync(join(broken, 'task.json'), '{invalid');
      const outcome = claim();
      assert(!outcome.ok);
      assert.equal(outcome.reason, 'domain_state_unknown');
      assert.equal(load().claims.length, 0);
      outcomes.push(outcome);
      break;
    }
  }
  return {
    outcomes,
    record: load(),
    ledger: readFileSync(store.ledgerPath(taskRoot), 'utf8'),
  };
}
