import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectWorkflow } from '../../src/app/collab-workflow.js';
import {
  parseClaudeStatusline,
  writeUsageObservation,
} from '../../src/usage/observation.js';
import { makeTaskDomain } from '../collab/task-resources-fixtures.js';
import { cleanup, makeTempDir } from '../workspace/fixtures.js';

const NOW = new Date('2026-10-27T06:00:00.000Z');
const SESSION = 'bf4725b6-48d0-4410-8a62-7716b13c1345';

function domain(harness: string) {
  return makeTaskDomain('inspect-advisory', ['cohort'], {
    coordinators: {
      cohort: { agent_id: 'coord', session_id: SESSION, harness },
    },
  });
}

async function inspect(harness: string, usageDir: string) {
  const fixture = domain(harness);
  try {
    const result = await inspectWorkflow(fixture.tasks['cohort']!, {
      usageDataDir: usageDir,
      now: new Date(NOW.getTime() + 5_000),
    });
    return {
      advisory: (
        result.detail as { context_advisory: Record<string, unknown> | null }
      ).context_advisory,
      warnings: result.warnings,
    };
  } finally {
    fixture.cleanup();
  }
}

function seed(dir: string, percent: number): void {
  writeUsageObservation(
    dir,
    parseClaudeStatusline(
      {
        session_id: SESSION,
        context_window: {
          used_percentage: percent,
          context_window_size: 1000000,
          total_input_tokens: 1,
        },
      },
      NOW,
    )!,
  );
}

test('inspect advises a claude coordinator from the local beacon observation only', async () => {
  const dir = makeTempDir('inspect-usage');
  try {
    seed(dir, 82);
    const advised = await inspect('claude', dir);
    assert.equal(advised.advisory?.['state'], 'advised');
    assert.ok(
      advised.warnings.some(
        (item) => item.startsWith('context:') && item.includes('82%'),
      ),
    );

    seed(dir, 20);
    const low = await inspect('claude', dir);
    assert.equal(low.advisory?.['state'], 'below_threshold');
    assert.ok(!low.warnings.some((item) => item.startsWith('context:')));
  } finally {
    cleanup(dir);
  }
});

test('inspect never reports a missing observation as low, and points codex at the explicit command', async () => {
  const dir = makeTempDir('inspect-usage-none');
  try {
    const none = await inspect('claude', dir);
    assert.equal(none.advisory?.['state'], 'unavailable');
    assert.equal(none.advisory?.['reason'], 'missing');
    assert.ok(!none.warnings.some((item) => item.startsWith('context:')));

    const codex = await inspect('codex', dir);
    assert.equal(codex.advisory?.['reason'], 'live_read_required');
    assert.match(
      String(codex.advisory?.['next_action']),
      /context usage --host codex/,
    );

    const pi = await inspect('pi', dir);
    assert.equal(pi.advisory, null);
  } finally {
    cleanup(dir);
  }
});
