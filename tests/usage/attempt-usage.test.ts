import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectWorkflow } from '../../src/app/collab-workflow/inspect.js';
import { buildMessage } from '../../src/collab/envelope.js';
import { submitMessage } from '../../src/collab/messages.js';
import { attemptUsageProjectionSchema } from '../../src/schemas/attempt-usage.js';
import { owner, writer, clock } from '../collab/scenarios.js';
import { makeTaskDomain } from '../collab/task-resources-fixtures.js';

test('a low-level report receipt is projected as owner-attested accounting', async (t) => {
  const domain = makeTaskDomain('attempt-usage-attestation', ['cohort']);
  t.after(domain.cleanup);
  const task = domain.tasks['cohort']!;
  const address = {
    task_id: 'cohort',
    subtask_id: 'work',
    attempt: 1,
    owner_epoch: 1,
  };
  const assignment = buildMessage(
    {
      ...address,
      type: 'ASSIGN',
      message_id: 'assign',
      from: owner,
      to: writer,
      body: { assignment_digest: 'sha256:fixture' },
    },
    { clock },
  );
  assert.equal(submitMessage(task, assignment, { clock }).ok, true);
  const report = buildMessage(
    {
      ...address,
      type: 'REPORT',
      message_id: 'report',
      from: writer,
      to: owner,
      body: {
        status: 'completed',
        native_ref: {
          usage_observation: {
            schema: 'pappra/attempt-usage-receipt/1',
            session_id: writer.session_id,
            token_usage: {
              state: 'available',
              harness: 'codex',
              through: new Date(clock + 1000).toISOString(),
              input_tokens: 4,
              output_tokens: 5,
              cache_read_input_tokens: 2,
              cache_write_input_tokens: null,
              total_tokens: 9,
              evidence_digests: ['sha256:' + 'a'.repeat(64)],
            },
          },
        },
      },
    },
    { clock: clock + 2000 },
  );
  assert.equal(submitMessage(task, report, { clock: clock + 2000 }).ok, true);
  const inspected = await inspectWorkflow(task);
  const usage = attemptUsageProjectionSchema.parse(
    inspected.detail?.['attempt_usage'],
  );
  assert.equal(usage.provenance, 'attempt_owner_report');
  const observation = usage.attempts[0]?.token_usage;
  assert.equal(observation?.state, 'available');
  assert.equal(observation.total_tokens, 9);
});
