import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../../src/cli/run.js';
import { makeTaskDomain } from './task-resources-fixtures.js';

async function cli(args: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(args, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

test('role-plan CLI expands disjoint work and aggregates only authoritative task evidence', async () => {
  const fixture = makeTaskDomain('role-plan-cli', ['sample']);
  try {
    const request = {
      schema: 'pappra/collab-role-plan/1',
      plan_id: 'roles',
      task_id: 'sample',
      owner_epoch: 1,
      participants: ['a', 'b', 'review'].map((id) => ({
        participant_id: id,
        role: id === 'review' ? 'reviewer' : 'writer',
        assignee: { agent_id: id, session_id: `${id}-session` },
      })),
      assignments: ['a', 'b', 'review'].map((id) => ({
        node_id: id,
        assignment_id: id,
        attempt: 1,
        input_revision: `sha256:${'1'.repeat(64)}`,
        participant_id: id,
        role: id === 'review' ? 'reviewer' : 'writer',
        resources: [{ path: join(fixture.root, id), access: 'write' }],
      })),
    };
    const requestFile = join(fixture.root, 'roles.json');
    const planFile = join(fixture.root, 'plan.json');
    writeFileSync(requestFile, JSON.stringify(request));
    const taskFile = join(fixture.tasks.sample!, 'task.json');
    const before = readFileSync(taskFile, 'utf8');
    const expanded = await cli([
      'collab',
      'role-plan',
      'expand',
      '--request',
      requestFile,
      '--json',
    ]);
    assert.equal(expanded.code, 0, expanded.stdout + expanded.stderr);
    const { plan } = JSON.parse(expanded.stdout) as {
      plan: { nodes: { node_id: string; depends_on: string[] }[] };
    };
    assert.deepEqual(
      plan.nodes.find((node) => node.node_id === 'review')?.depends_on,
      ['a', 'b'],
    );
    writeFileSync(planFile, JSON.stringify(plan));
    const aggregated = await cli([
      'collab',
      'role-plan',
      'aggregate',
      '--request',
      requestFile,
      '--config',
      planFile,
      '--task-root',
      fixture.tasks.sample!,
      '--json',
    ]);
    assert.equal(aggregated.code, 0, aggregated.stdout);
    assert.notEqual(
      (JSON.parse(aggregated.stdout) as { outcome: string }).outcome,
      'accepted',
    );
    assert.equal(readFileSync(taskFile, 'utf8'), before);
    writeFileSync(planFile, JSON.stringify({ ...plan, owner_epoch: 9 }));
    assert.equal(
      (
        await cli([
          'collab',
          'role-plan',
          'aggregate',
          '--request',
          requestFile,
          '--config',
          planFile,
          '--task-root',
          fixture.tasks.sample!,
          '--json',
        ])
      ).code,
      2,
    );
    assert.equal(
      (
        await cli([
          'collab',
          'role-plan',
          'expand',
          '--request',
          requestFile,
          '--apply',
          '--json',
        ])
      ).code,
      2,
    );
  } finally {
    fixture.cleanup();
  }
});
