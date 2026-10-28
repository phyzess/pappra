import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../../src/cli/run.js';
import { makeTaskDomain } from './task-resources-fixtures.js';

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

test('successor takes only --request and --apply: a stray --task-root, a missing or relative request are refused', async () => {
  const domain = makeTaskDomain('succ-cli', ['t']);
  try {
    const request = join(domain.root, 'r.json');
    writeFileSync(request, '{}');
    const stray = await cli([
      'collab',
      'handoff',
      'successor',
      '--request',
      request,
      '--task-root',
      domain.tasks['t']!,
      '--json',
    ]);
    assert.equal(stray.code, 2, stray.stdout);
    const missing = await cli(['collab', 'handoff', 'successor', '--json']);
    assert.equal(missing.code, 2);
    const relative = await cli([
      'collab',
      'handoff',
      'successor',
      '--request',
      'r.json',
      '--json',
    ]);
    assert.equal(relative.code, 2);
    const invalidDoc = await cli([
      'collab',
      'handoff',
      'successor',
      '--request',
      request,
      '--json',
    ]);
    assert.equal(
      invalidDoc.code,
      2,
      'a request document that fails validation is exit 2',
    );
    assert.equal(JSON.parse(invalidDoc.stdout).status, 'invalid');
    const duplicate = await cli([
      'collab',
      'handoff',
      'successor',
      '--request',
      request,
      '--request',
      request,
      '--json',
    ]);
    assert.equal(duplicate.code, 2);
  } finally {
    domain.cleanup();
  }
});

test('ack reuses --request for a safe request id, needs a task root, and refuses an unrecorded launch without registering anything', async () => {
  const domain = makeTaskDomain('ack-cli', ['t']);
  try {
    const task = domain.tasks['t']!;
    const noId = await cli([
      'collab',
      'handoff',
      'ack',
      '--task-root',
      task,
      '--json',
    ]);
    assert.equal(noId.code, 2);
    const badId = await cli([
      'collab',
      'handoff',
      'ack',
      '--task-root',
      task,
      '--request',
      '../x',
      '--json',
    ]);
    assert.equal(badId.code, 2);
    const noRoot = await cli([
      'collab',
      'handoff',
      'ack',
      '--request',
      'req1',
      '--json',
    ]);
    assert.equal(noRoot.code, 2);
    const relativeRoot = await cli([
      'collab',
      'handoff',
      'ack',
      '--task-root',
      'rel',
      '--request',
      'req1',
      '--json',
    ]);
    assert.equal(relativeRoot.code, 2);
    const unrecorded = await cli([
      'collab',
      'handoff',
      'ack',
      '--task-root',
      task,
      '--request',
      'req1',
      '--apply',
      '--json',
    ]);
    assert.equal(unrecorded.code, 1, unrecorded.stdout);
    const body = JSON.parse(unrecorded.stdout);
    assert.equal(body.code, 'successor_not_recorded');
    assert.match(
      body.nextAction ?? body.message,
      /run the same command again|wait/i,
    );
  } finally {
    domain.cleanup();
  }
});

test('both actions appear in the usage text', async () => {
  const help = await cli(['collab', '--help']);
  assert.match(help.stdout, /handoff <inventory\|check\|successor\|ack\|begin/);
});
