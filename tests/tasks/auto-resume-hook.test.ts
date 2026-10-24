import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { pinTask, setAutoResume } from '../../src/app/task-pin.js';
import { CheckpointService } from '../../src/continuity/service.js';
import { runHostHook } from '../../src/hosts/integration/hook.js';
import {
  baseMachineConfig,
  baseWorkspaceConfig,
  cleanup,
  makeTempDir,
  writeMachineConfig,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';

test('hook auto-resume follows only the private checkout preference, never the shared switch', async () => {
  const root = makeTempDir('task-auto-resume-hook');
  try {
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({ continuity: { autoResume: true } }),
    );
    writeMachineConfig(root, baseMachineConfig(root));
    const shared = readFileSync(join(root, '.pappra/workspace.json'));
    const saved = await new CheckpointService(root).save({
      taskId: 'T-PERSONAL',
      objective: 'PRIVATE_LOCAL_RESUME_OBJECTIVE',
      acceptance: [
        'Only explicitly enabled private preference injects this context.',
      ],
      contextCompleteness: 'complete',
    });
    assert.equal(saved.ok, true, JSON.stringify(saved.diagnostics));
    assert.equal('message' in (await pinTask(root, 'T-PERSONAL')), false);
    const input = {
      schema: 'pappra/host-hook-input/1' as const,
      host: 'claude' as const,
      event: 'startup' as const,
      nativeEvent: 'SessionStart',
      eventId: 'private-off',
      sessionId: 'private-hook-session',
      cwd: root,
      root: null,
      taskId: null,
      source: 'startup',
      observedAt: '2026-10-24T00:00:00.000Z',
    };
    const disabled = await runHostHook(input, { deadlineMs: 5000 });
    assert.equal(
      disabled.status,
      'processed',
      JSON.stringify(disabled.diagnostics),
    );
    assert.equal(
      disabled.context?.includes('PRIVATE_LOCAL_RESUME_OBJECTIVE'),
      false,
    );
    assert.equal('message' in (await setAutoResume(root, true)), false);
    const enabled = await runHostHook(
      { ...input, eventId: 'private-on' },
      { deadlineMs: 5000 },
    );
    assert.equal(
      enabled.status,
      'processed',
      JSON.stringify(enabled.diagnostics),
    );
    assert.equal(
      enabled.context?.includes('PRIVATE_LOCAL_RESUME_OBJECTIVE'),
      true,
    );
    assert.equal('message' in (await setAutoResume(root, false)), false);
    const disabledAgain = await runHostHook(
      { ...input, eventId: 'private-off-again' },
      { deadlineMs: 5000 },
    );
    assert.equal(
      disabledAgain.context?.includes('PRIVATE_LOCAL_RESUME_OBJECTIVE'),
      false,
    );
    assert.deepEqual(
      readFileSync(join(root, '.pappra/workspace.json')),
      shared,
    );
  } finally {
    cleanup(root);
  }
});
