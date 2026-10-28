import assert from 'node:assert/strict';
import test from 'node:test';
import { applyHandoffRequest } from '../../src/app/collab-handoff.js';
import {
  coordinatorLineage,
  judgeEvidence,
  lineageContains,
  lineageEntry,
} from '../../src/collab/lineage.js';
import { readRecord } from '../../src/collab/store.js';
import type { TaskRecord } from '../../src/collab/types.js';
import {
  COORDINATOR,
  NEXT_COORDINATOR,
  makeHandoffFixture,
  seedConfirmation,
  type HandoffFixture,
} from './handoff-fixtures.js';

const THIRD = {
  agent_id: 'third-coordinator',
  session_id: 'third-session',
  harness: 'claude',
};
const SCHEMA = 'pappra/collaboration-handoff-request/1';

/** Drives one coordinator handoff through the real protocol, exactly as the CLI does. */
async function hand(
  fixture: HandoffFixture,
  options: {
    id: string;
    from: typeof COORDINATOR;
    to: typeof NEXT_COORDINATOR;
    epoch: number;
  },
): Promise<void> {
  const base = {
    schema: SCHEMA,
    actor: options.from.agent_id,
    owner_epoch: options.epoch,
  } as const;
  const run = async (request: Record<string, unknown>) => {
    const result = await applyHandoffRequest(fixture.task, request as never);
    assert.ok(
      result.ok && result.value['ok'] === true,
      `${String(request['action'])}: ${JSON.stringify(result)}`,
    );
  };
  await run({
    ...base,
    action: 'begin',
    handoff_id: options.id,
    kind: 'coordinator',
    from: options.from,
    to: options.to,
  });
  await run({ ...base, action: 'transfer', handoff_id: options.id });
  const message = seedConfirmation(fixture.task, {
    handoffId: options.id,
    messageId: `confirm-${options.id}`,
    from: options.to,
    to: options.from,
    ownerEpoch: options.epoch,
  });
  await run({
    ...base,
    action: 'confirm',
    handoff_id: options.id,
    confirmation_message_id: message.message_id,
  });
  await run({ ...base, action: 'complete', handoff_id: options.id });
}

async function succeeded(
  label: string,
  times: 0 | 1 | 2,
): Promise<{ fixture: HandoffFixture; record: TaskRecord }> {
  const fixture = makeHandoffFixture(label);
  if (times >= 1)
    await hand(fixture, {
      id: 'h1',
      from: COORDINATOR,
      to: NEXT_COORDINATOR,
      epoch: 1,
    });
  if (times >= 2)
    await hand(fixture, {
      id: 'h2',
      from: NEXT_COORDINATOR,
      to: THIRD,
      epoch: 2,
    });
  return { fixture, record: readRecord(fixture.task)! };
}

const clone = (record: TaskRecord): TaskRecord => structuredClone(record);
const completedHandoffs = (record: TaskRecord) =>
  (record.handoffs ?? []).filter(
    (h) => h.kind === 'coordinator' && h.state === 'completed',
  );

test('a task that never had a coordinator handoff has a one-entry lineage', async () => {
  const { fixture, record } = await succeeded('lin-none', 0);
  try {
    const lineage = coordinatorLineage(record);
    assert.ok(lineage.valid);
    assert.equal(lineage.current, 1);
    assert.deepEqual(
      lineage.entries.map((e) => [e.epoch, e.identity.agent_id, e.until]),
      [[1, COORDINATOR.agent_id, null]],
    );
  } finally {
    fixture.domain.cleanup();
  }
});

test('two real succession handoffs derive a three-epoch lineage with the instants the epochs ended', async () => {
  const { fixture, record } = await succeeded('lin-two', 2);
  try {
    const lineage = coordinatorLineage(record);
    assert.ok(lineage.valid, lineage.valid ? '' : lineage.detail);
    assert.equal(lineage.current, 3);
    assert.deepEqual(
      lineage.entries.map((e) => [e.epoch, e.identity.agent_id, e.ended_by]),
      [
        [1, COORDINATOR.agent_id, 'h1'],
        [2, NEXT_COORDINATOR.agent_id, 'h2'],
        [3, THIRD.agent_id, null],
      ],
    );
    const [h1, h2] = completedHandoffs(record);
    const completedAt = (h: typeof h1) =>
      Date.parse(h!.steps.filter((s) => s.state === 'completed').at(-1)!.at);
    assert.equal(lineageEntry(lineage, 1)!.until, completedAt(h1));
    assert.equal(lineageEntry(lineage, 2)!.until, completedAt(h2));
    assert.equal(lineageEntry(lineage, 3)!.until, null);
    assert.ok(lineageContains(lineage, 2));
    assert.ok(!lineageContains(lineage, 4));
    assert.ok(
      lineageEntry(lineage, 1)!.until! <= lineageEntry(lineage, 2)!.until!,
      'ends in order',
    );
  } finally {
    fixture.domain.cleanup();
  }
});

test('aborted handoffs and writer handoffs are not part of the lineage', async () => {
  const { fixture, record } = await succeeded('lin-noise', 1);
  try {
    const noisy = clone(record);
    noisy.handoffs = [
      {
        ...structuredClone(completedHandoffs(record)[0]!),
        handoff_id: 'aborted-one',
        state: 'aborted',
        owner_epoch: 9,
      },
      {
        ...structuredClone(completedHandoffs(record)[0]!),
        handoff_id: 'a-writer-one',
        kind: 'writer',
        owner_epoch: 9,
      },
      ...(noisy.handoffs ?? []),
    ];
    const lineage = coordinatorLineage(noisy);
    assert.ok(lineage.valid, lineage.valid ? '' : lineage.detail);
    assert.equal(lineage.entries.length, 2);
  } finally {
    fixture.domain.cleanup();
  }
});

test('every record that does not look like what the protocol writes is an invalid lineage that reduces to the current epoch', async () => {
  const { fixture, record } = await succeeded('lin-bad', 2);
  try {
    const cases: [string, (r: TaskRecord) => void, string][] = [
      [
        'an epoch gap',
        (r) => {
          completedHandoffs(r)[1]!.owner_epoch = 5;
        },
        'epoch_gap',
      ],
      [
        'a duplicate epoch',
        (r) => {
          completedHandoffs(r)[1]!.owner_epoch =
            completedHandoffs(r)[0]!.owner_epoch;
        },
        'epoch_duplicate',
      ],
      [
        'out of order handoffs',
        (r) => {
          r.handoffs = [...(r.handoffs ?? [])].reverse();
        },
        'handoff_order',
      ],
      [
        'the last handoff did not install the recorded coordinator',
        (r) => {
          r.coordinator!.session_id = 'someone-else';
        },
        'last_handoff_not_current',
      ],
      [
        'the coordinator record disagrees about who came before',
        (r) => {
          r.coordinator!.previous = {
            agent_id: 'x',
            session_id: 'y',
            owner_epoch: 2,
          };
        },
        'previous_disagrees',
      ],
      [
        'a missing previous coordinator',
        (r) => {
          delete completedHandoffs(r)[0]!.previous_coordinator;
        },
        'handoff_incomplete',
      ],
      [
        'a handoff made by a coordinator the previous one did not install',
        (r) => {
          completedHandoffs(r)[0]!.to = {
            agent_id: 'intruder',
            session_id: 'intruder-session',
            harness: null,
          };
        },
        'identity_chain',
      ],
      [
        'no completion step',
        (r) => {
          completedHandoffs(r)[0]!.steps = completedHandoffs(
            r,
          )[0]!.steps.filter((s) => s.state !== 'completed');
        },
        'completion_time_missing',
      ],
      [
        'an unparseable completion time',
        (r) => {
          const s = completedHandoffs(r)[0]!
            .steps.filter((x) => x.state === 'completed')
            .at(-1)!;
          s.at = 'not a time';
        },
        'completion_time_unparseable',
      ],
    ];
    for (const [label, mutate, reason] of cases) {
      const broken = clone(record);
      mutate(broken);
      const lineage = coordinatorLineage(broken);
      assert.equal(lineage.valid, false, label);
      if (!lineage.valid) assert.equal(lineage.reason, reason, label);
      assert.deepEqual(
        lineage.entries.map((e) => e.epoch),
        [broken.coordinator!.owner_epoch],
        `${label}: reduces to the current epoch only`,
      );
      assert.equal(lineage.entries[0]!.until, null, label);
    }
    const headless = clone(record);
    headless.coordinator = null as never;
    const none = coordinatorLineage(headless);
    assert.equal(none.valid, false);
    assert.deepEqual(none.entries, []);
  } finally {
    fixture.domain.cleanup();
  }
});

test("evidence needs an epoch in the line, that epoch's own signer, and (for an ended epoch) a time at or before its end", async () => {
  const { fixture, record } = await succeeded('lin-evidence', 1);
  try {
    const lineage = coordinatorLineage(record);
    assert.ok(lineage.valid);
    const until = lineageEntry(lineage, 1)!.until!;
    const at = (ms: number) => new Date(ms).toISOString();
    const old = { epoch: 1, signer: COORDINATOR };

    assert.deepEqual(
      judgeEvidence(lineage, { ...old, appliedAt: at(until - 5000) }),
      { valid: true, reason: 'ok' },
    );
    assert.deepEqual(
      judgeEvidence(lineage, { ...old, appliedAt: at(until) }),
      { valid: true, reason: 'ok' },
      'exactly at the end is valid',
    );
    assert.deepEqual(
      judgeEvidence(lineage, { ...old, appliedAt: at(until + 1) }),
      { valid: false, reason: 'applied_after_epoch_ended' },
      'a millisecond later is not',
    );
    assert.deepEqual(
      judgeEvidence(lineage, {
        epoch: 1,
        signer: NEXT_COORDINATOR,
        appliedAt: at(until - 1),
      }),
      { valid: false, reason: 'signer_not_coordinator_of_epoch' },
    );
    assert.deepEqual(
      judgeEvidence(lineage, {
        epoch: 7,
        signer: COORDINATOR,
        appliedAt: at(until),
      }),
      { valid: false, reason: 'epoch_not_in_lineage' },
    );
    assert.deepEqual(judgeEvidence(lineage, { ...old, appliedAt: 'garbage' }), {
      valid: false,
      reason: 'applied_time_unparseable',
    });

    // The current epoch has no end, so any time is fine, but the signer must still match.
    assert.equal(
      judgeEvidence(lineage, {
        epoch: 2,
        signer: NEXT_COORDINATOR,
        appliedAt: at(until + 10_000_000),
      }).valid,
      true,
    );
    assert.equal(
      judgeEvidence(lineage, {
        epoch: 2,
        signer: COORDINATOR,
        appliedAt: at(until),
      }).valid,
      false,
    );

    // Offsets are compared as instants, not as strings.
    const eastern = new Date(until)
      .toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })
      .replace(' ', 'T');
    assert.equal(
      judgeEvidence(lineage, { ...old, appliedAt: `${eastern}.000+08:00` })
        .valid,
      Math.floor(until / 1000) * 1000 <= until,
    );
    assert.equal(
      judgeEvidence(lineage, {
        ...old,
        appliedAt: `${new Date(until - 2000).toISOString().replace('Z', '+00:00')}`,
      }).valid,
      true,
    );
  } finally {
    fixture.domain.cleanup();
  }
});

test("with a one-entry lineage evidence reduces to today's equality with the current coordinator", async () => {
  const { fixture, record } = await succeeded('lin-zero', 0);
  try {
    const lineage = coordinatorLineage(record);
    assert.equal(
      judgeEvidence(lineage, {
        epoch: 1,
        signer: COORDINATOR,
        appliedAt: new Date(0).toISOString(),
      }).valid,
      true,
    );
    assert.equal(
      judgeEvidence(lineage, {
        epoch: 2,
        signer: COORDINATOR,
        appliedAt: new Date().toISOString(),
      }).valid,
      false,
    );
    assert.equal(
      judgeEvidence(lineage, {
        epoch: 1,
        signer: NEXT_COORDINATOR,
        appliedAt: new Date().toISOString(),
      }).valid,
      false,
    );
  } finally {
    fixture.domain.cleanup();
  }
});

test("an invalid lineage accepts only the current epoch, so every check falls back to today's rule", async () => {
  const { fixture, record } = await succeeded('lin-fallback', 1);
  try {
    const broken = clone(record);
    broken.coordinator!.previous = {
      agent_id: 'x',
      session_id: 'y',
      owner_epoch: 1,
    };
    const lineage = coordinatorLineage(broken);
    assert.equal(lineage.valid, false);
    assert.equal(
      judgeEvidence(lineage, {
        epoch: 1,
        signer: COORDINATOR,
        appliedAt: new Date(0).toISOString(),
      }).valid,
      false,
      'the old epoch is no longer evidence',
    );
    assert.equal(
      judgeEvidence(lineage, {
        epoch: 2,
        signer: NEXT_COORDINATOR,
        appliedAt: new Date().toISOString(),
      }).valid,
      true,
    );
  } finally {
    fixture.domain.cleanup();
  }
});

test('the lineage is pure: it reads the record and changes nothing', async () => {
  const { fixture, record } = await succeeded('lin-pure', 2);
  try {
    const before = JSON.stringify(record);
    coordinatorLineage(record);
    coordinatorLineage(record);
    assert.equal(JSON.stringify(record), before);
    assert.equal(
      JSON.stringify(readRecord(fixture.task)),
      before,
      'nothing was written either',
    );
  } finally {
    fixture.domain.cleanup();
  }
});

test('a malformed record never makes the lineage throw: it answers invalid and reduces to the current epoch', async () => {
  const { fixture, record } = await succeeded('lin-shapes', 1);
  try {
    const bad = (mutate: (r: Record<string, unknown>) => void) => {
      const copy = clone(record) as unknown as Record<string, unknown>;
      mutate(copy);
      return coordinatorLineage(copy as unknown as TaskRecord);
    };
    const completed = (r: Record<string, unknown>) =>
      (r['handoffs'] as Record<string, unknown>[]).find(
        (h) => h['state'] === 'completed',
      )!;

    for (const [label, lineage] of [
      [
        'handoffs is an object',
        bad((r) => {
          r['handoffs'] = {};
        }),
      ],
      [
        'handoffs is a string',
        bad((r) => {
          r['handoffs'] = 'nope';
        }),
      ],
      [
        'steps is an object',
        bad((r) => {
          completed(r)['steps'] = {};
        }),
      ],
      [
        'steps is null',
        bad((r) => {
          completed(r)['steps'] = null;
        }),
      ],
      [
        'a step is null',
        bad((r) => {
          completed(r)['steps'] = [null, 7];
        }),
      ],
      [
        'previous is a string',
        bad((r) => {
          (r['coordinator'] as Record<string, unknown>)['previous'] = 'x';
        }),
      ],
      [
        'previous_coordinator is a number',
        bad((r) => {
          completed(r)['previous_coordinator'] = 5;
        }),
      ],
      [
        'epochs are strings',
        bad((r) => {
          completed(r)['owner_epoch'] = '2';
        }),
      ],
      [
        'to is null',
        bad((r) => {
          completed(r)['to'] = null;
        }),
      ],
    ] as const) {
      assert.equal(lineage.valid, false, label);
      assert.deepEqual(
        lineage.entries.map((e) => e.epoch),
        [2],
        `${label}: current epoch only`,
      );
    }
    // Junk items in the list are ignored rather than fatal.
    const noisy = bad((r) => {
      (r['handoffs'] as unknown[]).unshift(null, 7, 'x', []);
    });
    assert.ok(noisy.valid, 'null and non-object list items are skipped');

    for (const empty of [null, undefined, {}, 'record', 7]) {
      const lineage = coordinatorLineage(empty as unknown as TaskRecord);
      assert.equal(lineage.valid, false);
      assert.deepEqual(lineage.entries, []);
    }
    const hostile = coordinatorLineage({
      coordinator: { agent_id: 'a', session_id: 's', owner_epoch: 3 },
      handoffs: new Array(50_000).fill({
        kind: 'coordinator',
        state: 'completed',
      }),
    } as unknown as TaskRecord);
    assert.equal(
      hostile.valid,
      false,
      'a huge junk list is rejected, not walked forever',
    );
  } finally {
    fixture.domain.cleanup();
  }
});

test('the last completed step is the completion instant, and a missing coordinator.previous invalidates the lineage', async () => {
  const { fixture, record } = await succeeded('lin-steps', 1);
  try {
    const twice = clone(record);
    const handoff = completedHandoffs(twice)[0]!;
    const last = handoff.steps.filter((s) => s.state === 'completed').at(-1)!;
    const lastMs = Date.parse(last.at);
    handoff.steps = [
      { ...last, at: new Date(lastMs - 60_000).toISOString() },
      ...handoff.steps,
    ];
    const lineage = coordinatorLineage(twice);
    assert.ok(lineage.valid);
    assert.equal(
      lineageEntry(lineage, 1)!.until,
      lastMs,
      'the later completed step wins',
    );

    const without = clone(record);
    delete without.coordinator!.previous;
    const missing = coordinatorLineage(without);
    assert.equal(missing.valid, false);
    if (!missing.valid) assert.equal(missing.reason, 'previous_disagrees');
  } finally {
    fixture.domain.cleanup();
  }
});

test('only full ISO instants with an offset are trusted as times, so a loose string cannot pass as evidence', async () => {
  const { fixture, record } = await succeeded('lin-format', 1);
  try {
    const lineage = coordinatorLineage(record);
    assert.ok(lineage.valid);
    const until = lineageEntry(lineage, 1)!.until!;
    const old = { epoch: 1, signer: COORDINATOR };
    for (const loose of [
      '2020-01-01',
      'Jan 1 2020',
      '2020-01-01 00:00:00',
      ' 2020-01-01T00:00:00Z',
      '2020-01-01T00:00:00',
      '1577836800000',
      'now',
      '',
    ]) {
      assert.deepEqual(
        judgeEvidence(lineage, { ...old, appliedAt: loose }),
        { valid: false, reason: 'applied_time_unparseable' },
        JSON.stringify(loose),
      );
    }
    const early = new Date(until - 120_000);
    for (const strict of [
      early.toISOString(),
      early.toISOString().replace(/\.\d+Z$/, 'Z'),
      early.toISOString().replace('Z', '+00:00'),
      early.toISOString().replace('Z', '123+00:00'),
    ]) {
      assert.equal(
        judgeEvidence(lineage, { ...old, appliedAt: strict }).valid,
        true,
        strict,
      );
    }
    // A completion time in a loose format invalidates the lineage instead of being guessed.
    const loose = clone(record);
    completedHandoffs(loose)[0]!
      .steps.filter((s) => s.state === 'completed')
      .at(-1)!.at = '2020-01-01';
    const invalid = coordinatorLineage(loose);
    assert.equal(invalid.valid, false);
    if (!invalid.valid)
      assert.equal(invalid.reason, 'completion_time_unparseable');
  } finally {
    fixture.domain.cleanup();
  }
});
