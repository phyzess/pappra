import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { implementation } from './implementations.js';
const { runNativePilot } = await implementation('pilot');
import { readRecord } from '../../src/collab/store.js';
import { launchFixture } from '../collab/launch-fixture.js';

test('the fixture pilot uses admission and records its observed native identity once', async () => {
  const box = launchFixture();
  const previousPath = process.env['PATH'];
  try {
    const executable = fileURLToPath(
      new URL('./fake-pilot.js', import.meta.url),
    );
    chmodSync(executable, 0o755);
    const bin = join(box.root, 'bin');
    mkdirSync(bin);
    symlinkSync(executable, join(bin, 'pi'));
    process.env['PATH'] = `${bin}:${previousPath ?? ''}`;
    const options = {
      ...box.options,
      harness: 'pi' as const,
      profile: 'writer' as const,
      promptFile: box.promptFile,
      evidenceDir: join(box.root, 'evidence'),
      timeoutMs: 3000,
    };
    const result = await runNativePilot(options);
    assert('execution' in result && result.execution);
    assert.equal(result.execution['session_id'], box.writer.session_id);
    assert.equal(result.execution['identity_confirmed'], true);
    const record = readRecord(box.taskRoot);
    assert.equal(record?.launch_reservations?.[0]?.outcome, 'exited');
    assert.equal(record?.attempts[0]?.state, 'running');
    const repeated = await runNativePilot({ ...options, outputName: 'repeat' });
    assert('refused' in repeated && repeated.refused);
    assert.equal(readRecord(box.taskRoot)?.launch_reservations?.length, 1);
  } finally {
    if (previousPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previousPath;
    box.cleanup();
  }
});
