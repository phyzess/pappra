import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { readCoordinatorHandoffCheck } from '../../src/app/collab-handoff.js';
import { beginHandoff } from '../../src/collab/handoff.js';
import {
  openUncertainty,
  transitionAttempt,
} from '../../src/collab/lifecycle.js';
import { claimResources, releaseClaim } from '../../src/collab/resources.js';
import { transact } from '../../src/collab/store.js';
import { runCli } from '../../src/cli/run.js';
import { snapshotTree } from './task-resources-fixtures.js';
import {
  COORDINATOR,
  NEXT_COORDINATOR,
  WRITER,
  makeHandoffFixture,
  type HandoffFixture,
} from './handoff-fixtures.js';

async function cli(args: string[]) {
  let stdout = '';
  const code = await runCli(args, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: () => {},
  });
  return { code, stdout };
}

async function check(fixture: HandoffFixture) {
  const result = await readCoordinatorHandoffCheck(fixture.task);
  assert.ok(result.ok);
  const value = result.value as {
    ok: boolean;
    status: string;
    blockers: { code: string }[];
    warnings: { code: string }[];
    next_steps: string[];
    fence: { process_quiescence: string };
    workflow_driven: boolean;
  };
  return {
    value,
    blockers: value.blockers.map((item) => item.code),
    warnings: value.warnings.map((item) => item.code),
  };
}

function finishWork(fixture: HandoffFixture): void {
  const moved = transact(fixture.task, {
    actor: 'fixture',
    purpose: 'finish-work',
    apply: (record) => {
      for (const to of ['accepted', 'running', 'completed']) {
        const result = transitionAttempt(record, {
          subtaskId: 'work',
          attempt: 1,
          to,
          actor: 'fixture',
          reason: 'fixture',
        });
        if (!result.ok) return result;
      }
      return { record, op: 'finish', summary: {}, result: { ok: true } };
    },
  });
  assert.ok(moved.ok, `transition: ${JSON.stringify(moved)}`);
  const released = releaseClaim(fixture.task, {
    claimId: fixture.claimId,
    holder: WRITER,
    reason: 'done',
  });
  assert.ok(released.ok, `release: ${JSON.stringify(released)}`);
}

test('handoff check blocks while work is in flight and claims are held', async () => {
  const fixture = makeHandoffFixture('hc-blocked');
  try {
    const { value, blockers } = await check(fixture);
    assert.equal(value.ok, false);
    assert.equal(value.status, 'blocked');
    assert.ok(blockers.includes('attempt_in_flight'));
    assert.ok(blockers.includes('claims_unreleased'));
    assert.deepEqual(value.next_steps, []);
    assert.equal(value.fence.process_quiescence, 'unavailable');
  } finally {
    fixture.domain.cleanup();
  }
});

test('handoff check is ready at a boundary and names the protocol-only fence', async () => {
  const fixture = makeHandoffFixture('hc-ready');
  try {
    finishWork(fixture);
    const { value, blockers } = await check(fixture);
    assert.deepEqual(blockers, []);
    assert.equal(value.status, 'ready');
    assert.equal(value.workflow_driven, false);
    assert.ok(value.next_steps.length > 0);
    assert.equal(value.fence.process_quiescence, 'unavailable');
  } finally {
    fixture.domain.cleanup();
  }
});

test('handoff check refuses a source coordinator that holds a claim', async () => {
  const fixture = makeHandoffFixture('hc-source-claim');
  try {
    finishWork(fixture);
    const claimed = claimResources(fixture.task, {
      resources: [{ kind: 'path', path: join(fixture.domain.root, 'own') }],
      holder: COORDINATOR,
    });
    assert.ok(claimed.ok);
    const { blockers } = await check(fixture);
    assert.deepEqual(blockers, ['source_holds_claims']);
  } finally {
    fixture.domain.cleanup();
  }
});

test('handoff check separates live uncertainty from residue on a closed attempt', async () => {
  const fixture = makeHandoffFixture('hc-uncertainty');
  try {
    finishWork(fixture);
    const add = (subtaskId: string | null, attempt: number | null) =>
      transact(fixture.task, {
        actor: 'fixture',
        purpose: 'uncertainty',
        apply: (record) => {
          openUncertainty(record, {
            kind: 'late_result',
            subtaskId,
            attempt,
            detail: 'fixture',
          });
          return { record, op: 'u', summary: {}, result: { ok: true } };
        },
      });
    add('work', 1);
    const residue = await check(fixture);
    assert.deepEqual(residue.blockers, []);
    assert.deepEqual(residue.warnings, ['uncertainty_on_closed_attempt']);
    add(null, null);
    const live = await check(fixture);
    assert.deepEqual(live.blockers, ['uncertainty_open']);
  } finally {
    fixture.domain.cleanup();
  }
});

test('handoff check blocks while another handoff is open', async () => {
  const fixture = makeHandoffFixture('hc-open');
  try {
    finishWork(fixture);
    const begun = transact(fixture.task, {
      actor: 'fixture',
      purpose: 'begin',
      apply: (record) => {
        const result = beginHandoff(record, {
          handoffId: 'open-one',
          kind: 'coordinator',
          from: COORDINATOR,
          to: NEXT_COORDINATOR,
          ownerEpoch: 1,
        });
        if (!result.ok) return result;
        return { record, op: 'begin', summary: {}, result };
      },
    });
    assert.ok(begun.ok);
    const { blockers } = await check(fixture);
    assert.deepEqual(blockers, ['handoff_open']);
  } finally {
    fixture.domain.cleanup();
  }
});

test('collab handoff check is routed, read-only and exits by readiness', async () => {
  const fixture = makeHandoffFixture('hc-cli');
  try {
    const blocked = await cli([
      'collab',
      'handoff',
      'check',
      '--task-root',
      fixture.task,
      '--json',
    ]);
    assert.equal(blocked.code, 1, blocked.stdout);
    assert.equal(JSON.parse(blocked.stdout).status, 'blocked');
    const human = await cli([
      'collab',
      'handoff',
      'check',
      '--task-root',
      fixture.task,
    ]);
    assert.match(human.stdout, /blocker attempt_in_flight/);
    assert.match(human.stdout, /protocol only/);

    finishWork(fixture);
    const ready = await cli([
      'collab',
      'handoff',
      'check',
      '--task-root',
      fixture.task,
      '--json',
    ]);
    assert.equal(ready.code, 0, ready.stdout);
    assert.equal(JSON.parse(ready.stdout).status, 'ready');

    const extra = await cli([
      'collab',
      'handoff',
      'check',
      '--task-root',
      fixture.task,
      '--apply',
      '--json',
    ]);
    assert.equal(extra.code, 2, extra.stdout);
  } finally {
    fixture.domain.cleanup();
  }
});

function setState(
  fixture: HandoffFixture,
  states: string[],
  purpose = 'set-state',
): void {
  const moved = transact(fixture.task, {
    actor: 'fixture',
    purpose,
    apply: (record) => {
      for (const to of states) {
        const result = transitionAttempt(record, {
          subtaskId: 'work',
          attempt: 1,
          to,
          actor: 'fixture',
          reason: 'fixture',
        });
        if (!result.ok) return result;
      }
      return { record, op: purpose, summary: {}, result: { ok: true } };
    },
  });
  assert.ok(moved.ok, JSON.stringify(moved));
}

test('handoff check blocks a needs_input attempt and an unknown one', async () => {
  const fixture = makeHandoffFixture('hc-states');
  try {
    setState(fixture, ['accepted', 'running', 'needs_input']);
    const blocked = await check(fixture);
    assert.ok(blocked.blockers.includes('attempt_needs_input'));
    assert.ok(!blocked.blockers.includes('attempt_in_flight'));
  } finally {
    fixture.domain.cleanup();
  }
  const other = makeHandoffFixture('hc-unknown');
  try {
    setState(other, ['accepted', 'running', 'unknown']);
    assert.ok((await check(other)).blockers.includes('attempt_in_flight'));
  } finally {
    other.domain.cleanup();
  }
});

test('handoff check passes a failed attempt but keeps its held claim a blocker', async () => {
  const fixture = makeHandoffFixture('hc-failed');
  try {
    setState(fixture, ['accepted', 'running', 'failed']);
    const held = await check(fixture);
    assert.deepEqual(held.blockers, ['claims_unreleased']);
    const released = releaseClaim(fixture.task, {
      claimId: fixture.claimId,
      holder: WRITER,
      reason: 'failed',
    });
    assert.ok(released.ok);
    assert.deepEqual((await check(fixture)).blockers, []);
  } finally {
    fixture.domain.cleanup();
  }
});

test('handoff check reports a frozen dispatch as a warning and a missing coordinator as a blocker', async () => {
  const fixture = makeHandoffFixture('hc-frozen');
  try {
    finishWork(fixture);
    const frozen = transact(fixture.task, {
      actor: 'fixture',
      purpose: 'freeze',
      apply: (record) => {
        record.dispatch_frozen = true;
        return { record, op: 'freeze', summary: {}, result: { ok: true } };
      },
    });
    assert.ok(frozen.ok);
    const warned = await check(fixture);
    assert.deepEqual(warned.blockers, []);
    assert.deepEqual(warned.warnings, ['dispatch_frozen']);

    const headless = transact(fixture.task, {
      actor: 'fixture',
      purpose: 'drop-coordinator',
      apply: (record) => {
        record.coordinator = null as never;
        return { record, op: 'drop', summary: {}, result: { ok: true } };
      },
    });
    assert.ok(headless.ok);
    assert.ok((await check(fixture)).blockers.includes('no_coordinator'));
  } finally {
    fixture.domain.cleanup();
  }
});

test('handoff check never writes to the task root', async () => {
  const fixture = makeHandoffFixture('hc-readonly');
  try {
    const before = snapshotTree(fixture.domain.domainRoot);
    await check(fixture);
    await cli(['collab', 'handoff', 'check', '--task-root', fixture.task]);
    assert.deepEqual(snapshotTree(fixture.domain.domainRoot), before);
  } finally {
    fixture.domain.cleanup();
  }
});

test('handoff check human output is actionable and an unreadable task is not "needs input"', async () => {
  const fixture = makeHandoffFixture('hc-human');
  try {
    finishWork(fixture);
    const ready = await cli([
      'collab',
      'handoff',
      'check',
      '--task-root',
      fixture.task,
    ]);
    assert.match(ready.stdout, /next steps, in order/);
    assert.match(ready.stdout, /release-dispatch/);
    assert.match(ready.stdout, /limits: stored_state_only/);
    const missing = await cli([
      'collab',
      'handoff',
      'check',
      '--task-root',
      join(fixture.domain.root, 'no-such-task'),
      '--json',
    ]);
    assert.equal(missing.code, 1);
    assert.equal(JSON.parse(missing.stdout).status, 'unreadable');
  } finally {
    fixture.domain.cleanup();
  }
});
