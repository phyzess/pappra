import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ROLE_RUN_REQUEST_SCHEMA,
  watchRoleOrchestration,
  type RoleEventDependencies,
} from '../../src/app/collab-role-events.js';
import type { OpenedTaskStore } from '../../src/app/collab-task-store.js';
import {
  COLLAB_ROLE_ORCHESTRATION_SCHEMA,
  type RoleOrchestrationResult,
} from '../../src/app/collab-role-orchestration.js';
import type { TaskRecord } from '../../src/collab/types.js';

function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pappra-role-events-')),
  );
  const taskRoot = path.join(root, 'task');
  const messagesDirectory = path.join(taskRoot, 'messages');
  const firstCardDirectory = path.join(root, 'cards-first');
  const secondCardDirectory = path.join(root, 'cards-second');
  fs.mkdirSync(messagesDirectory, { recursive: true });
  fs.mkdirSync(firstCardDirectory);
  fs.mkdirSync(secondCardDirectory);
  const requestFile = path.join(root, 'request.json');
  const firstCard = path.join(firstCardDirectory, 'capabilities.json');
  const secondCard = path.join(secondCardDirectory, 'capabilities.json');
  const journalFile = path.join(taskRoot, 'role-orchestration.json');
  const taskRecordFile = path.join(taskRoot, 'task.json');
  fs.writeFileSync(taskRecordFile, '{"state_revision":1}\n');
  fs.writeFileSync(firstCard, '{"capabilities":["writer"]}\n');
  fs.writeFileSync(secondCard, '{"capabilities":["reviewer"]}\n');

  const writeRequest = (capabilityFile: string) => {
    fs.writeFileSync(
      requestFile,
      `${JSON.stringify({
        schema: ROLE_RUN_REQUEST_SCHEMA,
        role_plan: {},
        execution: {
          task_root: taskRoot,
          plan_file: path.join(taskRoot, 'work-plan.json'),
          binding_file: path.join(taskRoot, 'binding.json'),
          caller: {
            agent_id: 'coordinator',
            session_id: 'coordinator-session',
            harness: 'pi',
            cwd: root,
          },
          caller_pane: 'pi:p1',
          capability_cards: [
            {
              assignment_id: 'writer',
              capabilities_file: capabilityFile,
            },
          ],
        },
        event_id: 'caller-event',
        journal_file: journalFile,
        limits: { max_rounds: 8, max_actions: 4, max_attempts: 3 },
      })}\n`,
    );
  };
  writeRequest(firstCard);

  let revision = 1;
  let dispatchFrozen = false;
  const record = (): TaskRecord =>
    ({
      task_id: 'role-event-task',
      state_revision: revision,
      dispatch_frozen: dispatchFrozen,
      coordinator: {
        agent_id: 'coordinator',
        session_id: 'coordinator-session',
        harness: 'pi',
        owner_epoch: 1,
      },
      attempts: [],
      messages: [],
      results: [],
      claims: [],
      uncertainty: [],
    }) as unknown as TaskRecord;
  const opened = (): OpenedTaskStore =>
    ({
      taskRoot,
      domainRoot: root,
      record: record(),
      messagesDirectory,
      recordFile: taskRecordFile,
      identity: {},
    }) as unknown as OpenedTaskStore;
  let openedCalls = 0;
  const openTaskStore: NonNullable<
    RoleEventDependencies['openTaskStore']
  > = async () => {
    openedCalls += 1;
    return { ok: true, value: opened() } as Awaited<
      ReturnType<NonNullable<RoleEventDependencies['openTaskStore']>>
    >;
  };
  let ticks = 0;
  const tick: NonNullable<RoleEventDependencies['tick']> = async (request) => {
    ticks += 1;
    fs.writeFileSync(request.journal_file, `journal-${ticks}\n`);
    return {
      schema: COLLAB_ROLE_ORCHESTRATION_SCHEMA,
      status: 'waiting',
      event_id: request.event_id,
      plan_id: 'role-event-plan',
      round: ticks,
      reserved_actions: 0,
      prior_outcome: null,
      aggregate: null,
      execution: null,
      updatedRequest: null,
      diagnostics: [],
    } satisfies RoleOrchestrationResult;
  };
  const deps: RoleEventDependencies = {
    openTaskStore,
    assertTaskStoreCurrent: async (opened) =>
      opened.record.state_revision === revision
        ? null
        : {
            ok: false,
            code: 'task_namespace_changed',
            message: 'stale snapshot',
            nextAction: null,
          },
    tick,
  };
  return {
    root,
    taskRoot,
    taskRecordFile,
    requestFile,
    firstCard,
    firstCardDirectory,
    secondCard,
    secondCardDirectory,
    journalFile,
    writeRequest,
    bumpRevision() {
      revision += 1;
      dispatchFrozen = !dispatchFrozen;
    },
    bumpJournalRevision() {
      revision += 1;
    },
    deps,
    get ticks() {
      return ticks;
    },
    get openedCalls() {
      return openedCalls;
    },
  };
}

function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

test('a known no-effect journal-lock collision retries within a bound without another task event', async () => {
  const value = fixture();
  let calls = 0;
  const tick: NonNullable<RoleEventDependencies['tick']> = async (
    request,
    deps,
  ) => {
    const result = await value.deps.tick!(request, deps);
    calls++;
    return calls === 1
      ? {
          ...result,
          status: 'reconciliation-required',
          diagnostics: ['journal_lock_present_or_busy'],
        }
      : result;
  };
  const watcher = await watchRoleOrchestration(value.requestFile, () => {}, {
    ...value.deps,
    tick,
  });
  try {
    const deadline = Date.now() + 1000;
    while (calls < 2 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls, 2);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(calls, 2);
  } finally {
    await watcher.close();
    cleanup(value.root);
  }
});

test('reconciles a missed capability event after rebinding and ignores its own journal writes', async (context) => {
  const value = fixture();
  const originalWatch = fs.watch;
  context.mock.method(
    fs,
    'watch',
    (directory: fs.PathLike, listener: fs.WatchListener<string>) =>
      originalWatch(
        directory,
        directory === value.secondCardDirectory ? () => {} : listener,
      ),
  );
  let results = 0;
  let resolveThird!: () => void;
  let deadline: NodeJS.Timeout;
  const thirdResult = new Promise<void>((resolve, reject) => {
    resolveThird = resolve;
    deadline = setTimeout(
      () => reject(new Error('capability rebind did not reconcile')),
      3000,
    );
  });
  const watcher = await watchRoleOrchestration(
    value.requestFile,
    () => {
      results += 1;
      if (results >= 3) resolveThird();
    },
    value.deps,
  );
  try {
    assert.equal(value.ticks, 1);
    assert.equal(
      value.openedCalls,
      2,
      'each refresh must reopen current task state',
    );

    value.writeRequest(value.secondCard);
    await watcher.refresh();
    assert.equal(value.ticks, 2);

    fs.writeFileSync(
      value.secondCard,
      '{"capabilities":["reviewer","changed"]}\n',
    );
    await thirdResult;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      value.ticks,
      3,
      'new capability parent is watched after request rebind',
    );
    assert.equal(watcher.status().error, null);
  } finally {
    clearTimeout(deadline!);
    await watcher.close();
    cleanup(value.root);
  }
});

test('fails closed if an active input directory is replaced', async () => {
  const value = fixture();
  let results = 0;
  const watcher = await watchRoleOrchestration(
    value.requestFile,
    () => {
      results += 1;
    },
    value.deps,
  );
  try {
    fs.renameSync(value.firstCardDirectory, `${value.firstCardDirectory}-old`);
    fs.mkdirSync(value.firstCardDirectory);
    fs.writeFileSync(value.firstCard, '{"capabilities":["replacement"]}\n');
    await watcher.refresh();
    assert.equal(results, 1);
    assert.equal(watcher.status().error, 'role_event_reconciliation_failed');
  } finally {
    await watcher.close();
    cleanup(value.root);
  }
});

test('survives atomic task.json replacement by reopening and pinning the current namespace', async () => {
  const value = fixture();
  let results = 0;
  const watcher = await watchRoleOrchestration(
    value.requestFile,
    () => {
      results += 1;
    },
    value.deps,
  );
  try {
    value.bumpRevision();
    const temporary = `${value.taskRecordFile}.next`;
    fs.writeFileSync(temporary, '{"state_revision":2}\n');
    fs.renameSync(temporary, value.taskRecordFile);
    await watcher.refresh();
    assert.equal(results, 2);
    assert.equal(value.ticks, 2);
    assert.equal(watcher.status().error, null);
  } finally {
    await watcher.close();
    cleanup(value.root);
  }
});

test('journal-only task revisions do not consume another orchestration round', async () => {
  const value = fixture();
  const watcher = await watchRoleOrchestration(
    value.requestFile,
    () => {},
    value.deps,
  );
  try {
    value.bumpJournalRevision();
    fs.writeFileSync(
      value.taskRecordFile,
      '{"state_revision":2,"work_execution_journal":[]}\n',
    );
    await watcher.refresh();
    assert.equal(value.ticks, 1);
    assert.equal(watcher.status().error, null);
  } finally {
    await watcher.close();
    cleanup(value.root);
  }
});

test('new explicit repair authorization is a cause even with an unchanged role plan', async () => {
  const value = fixture();
  const watcher = await watchRoleOrchestration(
    value.requestFile,
    () => {},
    value.deps,
  );
  try {
    const request = JSON.parse(fs.readFileSync(value.requestFile, 'utf8'));
    request.repair_policy = { authorizations: [] };
    fs.writeFileSync(value.requestFile, JSON.stringify(request));
    await watcher.refresh();
    assert.equal(value.ticks, 2);
    assert.equal(watcher.status().error, null);
  } finally {
    await watcher.close();
    cleanup(value.root);
  }
});
