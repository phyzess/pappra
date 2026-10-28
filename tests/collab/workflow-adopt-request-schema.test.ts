import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WORKFLOW_ADOPT_REQUEST_SCHEMA,
  parseWorkflowAdoptRequest,
} from '../../src/schemas/collab-workflow.js';

const base = {
  schema: WORKFLOW_ADOPT_REQUEST_SCHEMA,
  task_root: '/tmp/domain/tasks/t',
  caller: {
    agent_id: 'next-coordinator',
    session_id: 'next-session',
    harness: 'claude',
    cwd: '/tmp/work',
  },
  caller_pane: 'w1:p1',
};

test('adopt request accepts absolute unique extra_paths and none', () => {
  assert.equal(parseWorkflowAdoptRequest(base).ok, true);
  assert.equal(
    parseWorkflowAdoptRequest({ ...base, extra_paths: ['/tmp/a', '/tmp/b'] })
      .ok,
    true,
  );
});

test('adopt request refuses relative, duplicate, oversized and unknown extra_paths shapes', () => {
  for (const extra_paths of [
    ['relative/plan.json'],
    ['/tmp/a', '/tmp/a'],
    Array.from({ length: 17 }, (_, i) => `/tmp/p${i}`),
    'not-an-array',
  ])
    assert.equal(
      parseWorkflowAdoptRequest({ ...base, extra_paths }).ok,
      false,
      JSON.stringify(extra_paths),
    );
  assert.equal(parseWorkflowAdoptRequest({ ...base, other: 1 }).ok, false);
});
