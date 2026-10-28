import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyAdopt,
  applyPrepare,
  type WorkflowPrepareRequest,
} from '../../src/app/collab-workflow.js';
import type { AdoptRequest } from '../../src/app/collab-workflow/adopt.js';
import {
  COLLAB_ROLE_PLAN_SCHEMA,
  expandRolePlan,
  type RolePlanRequest,
} from '../../src/app/collab-role-plan.js';
import { transact } from '../../src/collab/store.js';
import type { Identity } from '../../src/collab/types.js';
import {
  WORK_PLAN_EVALUATION_SCHEMA,
  WORK_PLAN_SCHEMA,
} from '../../src/collab/work-plan.js';
import { owner } from './scenarios.js';
import { makeTaskDomain, snapshotTree } from './task-resources-fixtures.js';

const COORDINATOR = {
  agent_id: owner.agent_id,
  session_id: owner.session_id,
  harness: owner.harness,
  owner_epoch: owner.owner_epoch,
  since: owner.since,
};
const WRITER = {
  agent_id: 'writer-a',
  session_id: 'writer-a-session',
  harness: 'pi',
};
const NEXT = {
  agent_id: 'next-coordinator',
  session_id: 'next-session',
  harness: 'claude',
};
const INPUT_REVISION = `sha256:${'a'.repeat(64)}`;

/** The text adopt printed before `extra_paths` existed; it must not change without the field. */
const GENERIC_WARNING =
  'Role plans, role event journals and the goal-based worker path (collab prepare/start, work-run) keep current-epoch equality; they live at caller-chosen paths and cannot be detected here. Do not use them after a succession.';
/** Orchestration journals are written by collab-role-orchestration.ts, which keeps this private. */
const JOURNAL_SCHEMA = 'pappra/collab-role-orchestration-journal/1';

/** Installs one completed coordinator handoff on disk: epoch 1 ends, `NEXT` holds epoch 2. */
function succeed(taskRoot: string): void {
  const endedAt = '2099-01-01T00:00:00Z';
  const done = transact(taskRoot, {
    actor: 'fixture',
    purpose: 'succeed',
    apply: (record) => {
      const before = {
        agent_id: COORDINATOR.agent_id,
        session_id: COORDINATOR.session_id,
        owner_epoch: 1,
      };
      record.coordinator = {
        ...NEXT,
        owner_epoch: 2,
        since: endedAt,
        previous: before,
      } as never;
      record.handoffs = [
        ...(record.handoffs ?? []),
        {
          schema: 'harness-collab/handoff/1',
          handoff_id: 'h1',
          kind: 'coordinator',
          subtask_id: null,
          attempt: null,
          from: COORDINATOR,
          to: NEXT,
          resources: [],
          ownership_snapshot: [],
          state: 'completed',
          owner_epoch: 2,
          created_at: endedAt,
          updated_at: endedAt,
          reason: null,
          steps: [{ state: 'completed', at: endedAt, actor: 'fixture' }],
          partial_outputs: [],
          inflight: [],
          pending_approvals: [],
          confirmation_message_id: null,
          previous_coordinator: { ...COORDINATOR, ...before },
        } as never,
      ];
      return { record, op: 'succeed', summary: {}, result: { ok: true } };
    },
  });
  assert.ok(done.ok);
}

async function adoptFixture(label: string) {
  const fixture = makeTaskDomain(label, ['cohort'], { initialize: [] });
  const cwd = fixture.root;
  const seat = (base: Identity) => ({
    agent_id: base.agent_id,
    session_id: base.session_id,
    harness: base.harness ?? 'pi',
    cwd,
    surface: 'cli',
    configuration_id: 'daily-visible',
  });
  const prepared = await applyPrepare({
    schema: 'pappra/collab-workflow-prepare-request/1',
    domain_root: fixture.domainRoot,
    task_id: 'cohort',
    goal: {
      objective: 'Build the sample cohort.',
      input_ref: null,
      input_digest: null,
    },
    coordinator: {
      ...COORDINATOR,
      cwd,
      surface: 'cli',
      configuration_id: 'daily-visible',
    },
    participants: [seat(COORDINATOR), seat(WRITER)],
    bindings: [
      {
        agent_id: COORDINATOR.agent_id,
        pane_id: 'w1:p1',
        native_session_id: COORDINATOR.session_id,
      },
      {
        agent_id: WRITER.agent_id,
        pane_id: 'w1:p2',
        native_session_id: WRITER.session_id,
      },
    ],
    assignments: [
      {
        subtask_id: 'writer-one',
        role: 'writer',
        assignee: WRITER.agent_id,
        objective: 'Objective for writer-one.',
        acceptance: ['Acceptance for writer-one.'],
        resources: [{ path: join(cwd, 'a'), access: 'write' }],
        required_skills: [],
        required_tools: [],
        native_evidence: [],
      },
    ],
    runner: { name: 'pi-cli', mode: 'native-session', profile: 'daily' },
  } satisfies WorkflowPrepareRequest);
  assert.equal(prepared.status, 'applied', JSON.stringify(prepared.blockers));
  const taskRoot = join(fixture.domainRoot, 'tasks', 'cohort');
  succeed(taskRoot);
  const request = (extraPaths?: readonly string[]): AdoptRequest => ({
    schema: 'pappra/collab-workflow-adopt-request/1',
    task_root: taskRoot,
    caller: { ...NEXT, cwd },
    caller_pane: 'w1:p9',
    ...(extraPaths === undefined ? {} : { extra_paths: extraPaths }),
  });
  const observed = async () => ({
    ok: true as const,
    agents: [
      {
        name: 'next-agent',
        harness: NEXT.harness,
        paneId: 'w1:p9',
        cwd,
        sessionKind: 'id',
        sessionValue: NEXT.session_id,
        status: 'idle',
        focused: true,
      },
    ],
  });
  const plan = (extraPaths?: readonly string[]) =>
    applyAdopt(request(extraPaths), { apply: false, listAgents: observed });
  const write = (name: string, value: unknown): string => {
    const file = join(fixture.root, name);
    writeFileSync(
      file,
      typeof value === 'string' ? value : JSON.stringify(value),
    );
    return file;
  };
  return { fixture, taskRoot, request, observed, plan, write };
}

const rolePlan = (ownerEpoch: number): RolePlanRequest => ({
  schema: COLLAB_ROLE_PLAN_SCHEMA,
  plan_id: 'plan-role',
  task_id: 'cohort',
  owner_epoch: ownerEpoch,
  participants: [
    {
      participant_id: 'writer-a',
      role: 'writer',
      assignee: {
        agent_id: WRITER.agent_id,
        session_id: WRITER.session_id,
      },
    },
    {
      participant_id: 'reviewer',
      role: 'reviewer',
      assignee: { agent_id: 'reviewer', session_id: 'reviewer-session' },
    },
  ],
  assignments: [
    {
      node_id: 'write-a',
      role: 'writer',
      assignment_id: 'assignment-a',
      attempt: 1,
      input_revision: INPUT_REVISION,
      participant_id: 'writer-a',
      resources: [{ path: '/repo/src/alpha.ts', access: 'write' }],
    },
    {
      node_id: 'review',
      role: 'reviewer',
      assignment_id: 'assignment-r',
      attempt: 1,
      input_revision: INPUT_REVISION,
      participant_id: 'reviewer',
      resources: [{ path: '/repo/src/alpha.ts', access: 'read' }],
    },
  ],
});

const extraWarnings = (warnings: readonly string[]) =>
  warnings.filter((item) => item.startsWith('extra_paths '));

test('without extra_paths the generic warning is unchanged, and an empty list is the same as none', async () => {
  const { fixture, plan } = await adoptFixture('adopt-extra-none');
  try {
    for (const extra of [undefined, []]) {
      const result = await plan(extra);
      assert.equal(result.status, 'planned', JSON.stringify(result.blockers));
      assert.deepEqual(result.warnings, [GENERIC_WARNING]);
    }
  } finally {
    fixture.cleanup();
  }
});

test('a role plan that pins an earlier epoch is reported with both epochs instead of the generic text', async () => {
  const { fixture, plan, write } = await adoptFixture('adopt-extra-earlier');
  try {
    const expanded = expandRolePlan(rolePlan(1));
    assert.ok(expanded.ok, JSON.stringify(expanded));
    const request = write('role-plan.json', rolePlan(1));
    const workPlan = write('work-plan-copy.json', expanded.plan);
    const evaluation = write('evaluation.json', {
      schema: WORK_PLAN_EVALUATION_SCHEMA,
      owner_epoch: 1,
    });
    assert.equal(expanded.plan.schema, WORK_PLAN_SCHEMA);

    const result = await plan([request, workPlan, evaluation]);
    assert.equal(result.status, 'planned', JSON.stringify(result.blockers));
    assert.equal(result.ok, true);
    const found = extraWarnings(result.warnings);
    assert.equal(found.length, 3);
    assert.match(
      found[0]!,
      new RegExp(
        `^extra_paths ${JSON.stringify(request).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: role plan pins owner epoch 1, an earlier epoch of this task; the current epoch is 2\\. Executing through it \\(work-run, role-run\\) keeps current-epoch equality and is refused; only plan inspection follows the lineage\\. Rebuild it under epoch 2 or stop using it\\.$`,
      ),
    );
    assert.match(
      found[1]!,
      /: work plan pins owner epoch 1, an earlier epoch of this task; the current epoch is 2\./,
    );
    assert.match(
      found[2]!,
      /: work plan evaluation pins owner epoch 1, an earlier epoch of this task; the current epoch is 2\./,
    );
    // The generic text gives way to what is still undetectable, and comes last.
    assert.ok(!result.warnings.includes(GENERIC_WARNING));
    assert.match(
      result.warnings.at(-1)!,
      /^Role artifacts that extra_paths does not list and the goal-based worker path \(collab prepare\/start, work-run\) keep current-epoch equality; they live at caller-chosen paths and cannot be detected here\./,
    );
    assert.equal(result.warnings.length, 4);
  } finally {
    fixture.cleanup();
  }
});

test('a role plan that pins the current epoch is reported as depending on it, and an unknown epoch as not ours', async () => {
  const { fixture, plan, write } = await adoptFixture('adopt-extra-current');
  try {
    const current = write('plan-2.json', rolePlan(2));
    const unknown = write('plan-7.json', rolePlan(7));
    const result = await plan([current, unknown]);
    const [first, second] = extraWarnings(result.warnings);
    assert.match(
      first!,
      /: role plan pins owner epoch 2, the current epoch\. It works only while this coordinator holds that epoch and fails closed after the next succession\.$/,
    );
    assert.match(
      second!,
      /: role plan pins owner epoch 7, which is not an epoch of this task; the current epoch is 2\./,
    );
  } finally {
    fixture.cleanup();
  }
});

test('a role orchestration request is recognized by its nested plan and a journal records no epoch', async () => {
  const { fixture, plan, write } = await adoptFixture(
    'adopt-extra-orchestration',
  );
  try {
    const orchestration = write('role-orchestration.json', {
      role_plan: rolePlan(1),
      execution: {},
      event_id: 'event-1',
      journal_file: '/tmp/journal.json',
      limits: { max_rounds: 1, max_actions: 1, max_attempts: 1 },
    });
    const journal = write('journal.json', {
      schema: JOURNAL_SCHEMA,
      plans: [],
      events: [],
    });
    const result = await plan([orchestration, journal]);
    const [first, second] = extraWarnings(result.warnings);
    assert.match(
      first!,
      /: role orchestration request pins owner epoch 1, an earlier epoch of this task; the current epoch is 2\./,
    );
    assert.match(
      second!,
      /: role orchestration journal records no owner epoch; its events are tied to a role plan by plan id, so check that plan as well\.$/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('an unusable owner epoch is reported and never taken for a real epoch', async () => {
  const { fixture, plan, write } = await adoptFixture('adopt-extra-unusable');
  try {
    const files = [
      { owner_epoch: '1' },
      { owner_epoch: 0 },
      { owner_epoch: 1.5 },
      { owner_epoch: null },
      {},
    ].map((patch, index) =>
      write(`unusable-${String(index)}.json`, {
        ...rolePlan(1),
        owner_epoch: undefined,
        ...patch,
      }),
    );
    const result = await plan(files);
    const found = extraWarnings(result.warnings);
    assert.equal(found.length, files.length);
    for (const item of found)
      assert.match(
        item,
        /: role plan carries no usable owner_epoch; treat it as depending on the current epoch\.$/,
      );
  } finally {
    fixture.cleanup();
  }
});

test('a file that cannot be checked is reported as not checked and never skipped', async () => {
  const { fixture, plan, write } = await adoptFixture('adopt-extra-unchecked');
  try {
    const real = write('role-plan.json', rolePlan(1));
    const link = join(fixture.root, 'role-plan-link.json');
    symlinkSync(real, link);
    const directory = join(fixture.root, 'a-directory');
    mkdirSync(directory);
    const oversized = write('oversized.json', ' '.repeat(1024 * 1024 + 1));
    const broken = write('broken.json', '{ not json');
    const unrelated = write('unrelated.json', { schema: 'something/else/1' });
    const array = write('array.json', '[1, 2]');
    const result = await plan([
      join(fixture.root, 'missing.json'),
      directory,
      link,
      oversized,
      broken,
      unrelated,
      array,
      'relative/role-plan.json',
    ]);
    const found = extraWarnings(result.warnings);
    const reasons = [
      'file_unreadable',
      'file_not_regular',
      'file_symlink',
      'file_too_large',
      'file_invalid_json',
      'neither a role plan nor a role journal',
      'neither a role plan nor a role journal',
      'path_not_absolute',
    ];
    assert.equal(found.length, reasons.length);
    found.forEach((item, index) =>
      assert.ok(
        item.endsWith(
          `: not checked (${reasons[index]}); treat it as depending on the current epoch.`,
        ),
        item,
      ),
    );
    // A warning never copies file content: the unrelated document's schema is not echoed.
    assert.ok(!result.warnings.join('\n').includes('something/else/1'));
    assert.equal(result.status, 'planned');
  } finally {
    fixture.cleanup();
  }
});

test("the workflow's own sealed plan is not mistaken for a role artifact", async () => {
  const { fixture, taskRoot, plan } = await adoptFixture('adopt-extra-sealed');
  try {
    const sealed = join(taskRoot, 'workflow', 'work-plan.json');
    assert.ok(existsSync(sealed));
    const alias = join(fixture.root, 'sealed-alias.json');
    symlinkSync(sealed, alias);
    const result = await plan([sealed, alias]);
    const found = extraWarnings(result.warnings);
    assert.equal(found.length, 2);
    for (const item of found)
      assert.match(
        item,
        /: the sealed workflow plan follows the coordinator lineage; there is nothing to check\.$/,
      );
  } finally {
    fixture.cleanup();
  }
});

test('the listing is deduplicated and bounded, and the bound is stated', async () => {
  const { fixture, plan, write } = await adoptFixture('adopt-extra-bounded');
  try {
    const files = Array.from({ length: 17 }, (_, index) =>
      write(`plan-${String(index)}.json`, rolePlan(1)),
    );
    const result = await plan([files[0]!, files[0]!, ...files.slice(1)]);
    const found = extraWarnings(result.warnings);
    // 16 checked entries and the statement of the bound, which also starts with "extra_paths ".
    assert.equal(found.length, 17);
    assert.ok(found[0]!.includes(JSON.stringify(files[0])));
    assert.ok(found[15]!.includes(JSON.stringify(files[15])));
    assert.equal(
      found[16],
      'extra_paths lists 17 entries; only the first 16 were checked.',
    );
    assert.ok(!result.warnings.join('\n').includes(JSON.stringify(files[16])));
    assert.equal(
      result.warnings.filter((item) => item.includes(JSON.stringify(files[0])))
        .length,
      1,
    );
  } finally {
    fixture.cleanup();
  }
});

test('checking extra paths writes nothing, blocks nothing and leaves adoption as it was', async () => {
  const { fixture, taskRoot, request, observed, plan, write } =
    await adoptFixture('adopt-extra-readonly');
  try {
    const file = write('role-plan.json', rolePlan(1));
    const before = snapshotTree(fixture.domainRoot);
    const planned = await plan([file]);
    assert.equal(planned.status, 'planned');
    assert.deepEqual(planned.blockers, []);
    assert.deepEqual(snapshotTree(fixture.domainRoot), before);

    const applied = await applyAdopt(request([file]), { listAgents: observed });
    assert.equal(applied.status, 'applied', JSON.stringify(applied.blockers));
    assert.ok(existsSync(join(taskRoot, 'binding.e2.json')));
    const after = snapshotTree(fixture.domainRoot);
    const added = after.filter((row) => !before.includes(row));
    assert.equal(added.length, 1, JSON.stringify(added));
    assert.match(added[0]!, /binding\.e2\.json/);
    // The warnings of the applied run name the same finding.
    assert.equal(extraWarnings(applied.warnings).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('a refused adopt still reports what it found in the listed files', async () => {
  const { fixture, request, observed, write } = await adoptFixture(
    'adopt-extra-refused',
  );
  try {
    const file = write('role-plan.json', rolePlan(1));
    const stranger = {
      ...request([file]),
      caller: { ...WRITER, cwd: fixture.root },
    };
    const result = await applyAdopt(stranger, {
      apply: false,
      listAgents: observed,
    });
    assert.equal(result.status, 'refused');
    assert.ok(
      result.blockers.some((item) => item.code === 'adopt_not_coordinator'),
    );
    assert.equal(extraWarnings(result.warnings).length, 1);
  } finally {
    fixture.cleanup();
  }
});
