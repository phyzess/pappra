import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { implementation } from './implementations.js';
const { queryPiResult } = await implementation('piHistory');
import { sha256File } from '../../src/collab/envelope.js';
import { object } from '../../src/collab/validation.js';
import { launchFixture } from '../collab/launch-fixture.js';

test('Pi history recovery verifies the terminal receipt and output bytes without mutating the session', async () => {
  const box = launchFixture();
  try {
    const executable = fileURLToPath(new URL('./fake-pi.js', import.meta.url));
    chmodSync(executable, 0o755);
    const output = join(box.root, 'result.txt');
    writeFileSync(output, 'Original fixture result.');
    const inputDigest = box.assignment.inputs[0]?.digest;
    assert(inputDigest);
    const session = join(box.root, 'history.jsonl');
    const receipt = {
      schema: 'harness-collab/native-result/1',
      task_id: 'sample',
      assignment_id: 'work',
      attempt: 1,
      input_digest: inputDigest,
      status: 'completed',
      outputs: [{ ref: output, digest: sha256File(output) }],
    };
    writeFileSync(
      session,
      `${JSON.stringify({ type: 'session', id: box.writer.session_id, cwd: box.root })}\n${JSON.stringify({ role: 'assistant', stopReason: 'stop', content: JSON.stringify(receipt) })}\n`,
    );
    const bytes = readFileSync(session);
    const options = {
      session,
      cwd: box.root,
      expectedSession: box.writer.session_id,
      taskId: 'sample',
      assignmentId: 'work',
      attempt: 1,
      inputDigest,
      piBin: executable,
      timeoutMs: 3000,
      graceMs: 100,
    };
    const result = await queryPiResult(options);
    assert.equal(result.status, 'recovered', JSON.stringify(result));
    assert(object(result['provenance']));
    assert.deepEqual(result['provenance']['commands_sent'], [
      'get_state',
      'get_messages',
      'get_session_stats',
    ]);
    assert.deepEqual(readFileSync(session), bytes);
    writeFileSync(output, 'Changed after the original receipt.');
    const changed = await queryPiResult(options);
    assert.equal(changed.status, 'invalid');
    assert.deepEqual(changed.blockers, ['output_digest_mismatch']);
    assert.equal(changed.recovered, undefined);
  } finally {
    box.cleanup();
  }
});
