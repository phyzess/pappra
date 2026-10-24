import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  doctor,
  initTask,
  listTransactions,
  readLock,
  readRecord,
} from '../../src/collab/store.js';
import { object, parseJson } from '../../src/collab/validation.js';
import { owner } from './scenarios.js';
import { launchFixture } from './launch-fixture.js';
import { testSubprocessEnvironment } from '../../scripts/test-environment.js';

const worker = fileURLToPath(new URL('./worker.js', import.meta.url));
function run(args: string[], injected: NodeJS.ProcessEnv = {}) {
  return new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(process.execPath, [worker, ...args], {
      env: testSubprocessEnvironment(injected, {
        allowPappra: ['PAPPRA_FAULT'],
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      timeout: 15_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
}

test('simultaneous processes can reserve one attempt only once', async () => {
  const box = launchFixture();
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, index) =>
        run(['reserve', box.taskRoot, '-', `reservation-${index}`]),
      ),
    );
    const values = results.map((result) => {
      if (result.status !== 'fulfilled') throw result.reason;
      assert.equal(result.value.code, 0, result.value.stderr);
      const value = parseJson(result.value.stdout);
      assert(object(value));
      return value;
    });
    assert.equal(values.filter((value) => value['ok'] === true).length, 1);
    assert.equal(
      values.filter((value) => value['reason'] === 'launch_already_reserved')
        .length,
      3,
    );
    assert.equal(readRecord(box.taskRoot)?.launch_reservations?.length, 1);
  } finally {
    box.cleanup();
  }
});

test('simultaneous OS processes cannot both claim the same path across task roots', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'pappra-race-'));
  try {
    const tasks = Array.from({ length: 4 }, (_, index) =>
      join(root, 'domain', 'tasks', `task-${index}`),
    );
    for (const [index, task] of tasks.entries())
      initTask(task, { taskId: `task-${index}`, coordinator: owner });
    const outcomes = await Promise.allSettled(
      tasks.map((task, index) =>
        run(['claim', task, join(root, 'contended'), `writer-${index}`]),
      ),
    );
    const results = outcomes.map((outcome) => {
      if (outcome.status !== 'fulfilled') throw outcome.reason;
      assert.equal(outcome.value.code, 0, outcome.value.stderr);
      const result = parseJson(outcome.value.stdout);
      assert(object(result));
      return result;
    });
    assert.equal(results.filter((result) => result['ok'] === true).length, 1);
    assert.equal(
      results.filter((result) => result['reason'] === 'resource_conflict')
        .length,
      3,
    );
    assert.equal(
      tasks.flatMap((task) => readRecord(task)?.claims ?? []).length,
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert(!existsSync(root));
  }
});

test('an OS process killed before rename leaves the old revision, lock and transaction evidence', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'pappra-crash-'));
  try {
    const task = join(root, 'domain', 'tasks', 'sample');
    initTask(task, { taskId: 'sample', coordinator: owner });
    const result = await run(['fault', task]);
    assert.equal(result.signal, 'SIGKILL', result.stderr);
    assert.equal(readRecord(task)?.state_revision, 1);
    assert.equal(readRecord(task)?.input_revision, null);
    assert.equal(readLock(task).held, true);
    const transactions = listTransactions(task);
    assert.equal(transactions.length, 1);
    const transaction = transactions[0];
    assert(transaction);
    assert.equal(transaction.revision, 2);
    assert(readFileSync(transaction.file).length > 0);
    assert(
      doctor(task).findings.some(
        (finding) => finding.code === 'uncommitted_transaction',
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert(!existsSync(root));
  }
});

test('an inherited production fault environment variable cannot kill or interrupt a transaction', async () => {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), 'pappra-no-fault-env-'),
  );
  try {
    const task = join(root, 'domain/tasks/sample');
    initTask(task, { taskId: 'sample', coordinator: owner });
    const result = await run(['commit', task], {
      PAPPRA_FAULT: 'exit_before_rename',
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(readRecord(task)?.state_revision, 2);
    assert.equal(
      readRecord(task)?.input_revision,
      'committed-without-environment-hook',
    );
    assert.equal(readLock(task).held, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
