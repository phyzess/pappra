import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  planManagedPiSession,
  readManagedPiRequest,
} from '../../src/app/managed-pi.js';

test('resume planning is read-only and does not treat source pins as execution authority', (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'resume-plan-')),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionId = 'a8c06c21-e2ca-4b14-b10a-11846c323979';
  const file = path.join(root, 'request.json');
  const request = {
    schema: 'pappra/managed-pi-session-request/1',
    runtime: 'sdk',
    cwd: root,
    model: 'openai/gpt-6-luna',
    sdkModulePath: path.join(root, 'not-installed-sdk.js'),
    journalPath: path.join(root, 'new.jsonl'),
    sessionId,
    executionScope: {
      schema: 'pappra/managed-pi-execution-scope/1',
      task_root: path.join(root, 'task'),
      task_id: 'task',
      subtask_id: 'work',
      attempt: 1,
      owner_epoch: 1,
      session_id: sessionId,
      cwd: root,
      claim_epochs: [],
    },
    resume: {
      sourceJournalPath: path.join(root, 'missing-source.jsonl'),
      sourceSessionFile: path.join(root, 'missing-session.jsonl'),
      sourceRunId: 'source-controller-run',
    },
  };
  fs.writeFileSync(file, JSON.stringify(request), { mode: 0o600 });
  const before = fs.readdirSync(root);
  const plan = planManagedPiSession(readManagedPiRequest(file));
  assert.equal(plan.effect, 'none');
  assert.equal(plan.launch_kind, 'controlled-resume');
  assert.equal(
    plan.resume?.authority,
    'requires-dead-source-checkpoint-and-task-reservation',
  );
  assert.deepEqual(fs.readdirSync(root), before);
  assert.equal(fs.existsSync(request.journalPath), false);
  assert.equal(fs.existsSync(`${request.journalPath}.control.json`), false);

  for (const invalid of [
    { ...request, runtime: 'pty' },
    { ...request, executionScope: undefined },
    { ...request, journalPath: request.resume.sourceJournalPath },
    { ...request, bootstrapExtensionPath: path.join(root, 'bootstrap.js') },
    { ...request, resume: { ...request.resume, arbitraryPid: 1 } },
  ]) {
    fs.writeFileSync(file, JSON.stringify(invalid), { mode: 0o600 });
    assert.throws(() => readManagedPiRequest(file));
  }
  assert.deepEqual(fs.readdirSync(root), before);
});
