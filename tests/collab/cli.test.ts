import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fingerprintSkill } from '../../src/collab/fingerprint.js';
import { cleanup, makeTempDir } from '../workspace/fixtures.js';

const ROOT = dirname(
  fileURLToPath(import.meta.resolve('@phyzess/pappra/package.json')),
);
const CLI = join(ROOT, 'dist/cli/main.js');
const SKILL_PATH = join(ROOT, 'src/assets/integrations/skills/pappra');
const SKILL_BUNDLE = fingerprintSkill(SKILL_PATH).bundle_digest;

test('collab CLI prepares and runs a bounded fixture flow', () => {
  const root = makeTempDir('p10-cli');
  try {
    const cwd = join(root, 'workspace');
    mkdirSync(cwd, { recursive: true });
    const goalPath = join(root, 'goal.json');
    const cardPath = join(root, 'card.json');
    const outputPath = join(root, 'result.txt');
    writeFileSync(outputPath, 'bounded result\n');
    const digest = `sha256:${createHash('sha256')
      .update(readFileSync(outputPath))
      .digest('hex')}`;
    writeFileSync(
      goalPath,
      `${JSON.stringify({
        schema: 'pappra/collaboration-goal/1',
        task_id: 'cli-task',
        subtask_id: 'slice',
        attempt: 1,
        phase: 'implementation',
        objective: 'Run the bounded CLI flow.',
        acceptance: ['one result'],
        prompt: 'Use only the frozen prompt.',
        coordinator: {
          agent_id: 'coordinator',
          session_id: 'coordinator-session',
          harness: 'codex',
          owner_epoch: 1,
        },
        assignee: {
          agent_id: 'worker',
          session_id: 'worker-session',
          harness: 'pi',
          surface: 'fixture',
          cwd,
          configuration_id: 'fixture-config',
        },
        resources: [{ path: cwd, access: 'write' }],
        required: {
          skills: [
            { id: 'workspace/harness-collab', bundle_digest: SKILL_BUNDLE },
          ],
          tools: ['read'],
        },
        preferred: { skills: [], tools: [] },
      })}\n`,
    );
    writeFileSync(
      cardPath,
      `${JSON.stringify({
        schema: 'harness-collab/capabilities/1',
        agent_id: 'worker',
        session_id: 'worker-session',
        harness: 'pi',
        surface: 'fixture',
        configuration_id: 'fixture-config',
        cwd,
        observed_at: new Date().toISOString(),
        evidence_level: 'runtime',
        skills: [
          {
            id: 'workspace/harness-collab',
            path: SKILL_PATH,
            bundle_digest: SKILL_BUNDLE,
            state: 'verified',
            evidence_ref: 'session:worker-session',
          },
        ],
        tools: [
          {
            id: 'read',
            state: 'verified',
            evidence_ref: 'session:worker-session',
          },
        ],
      })}\n`,
    );
    const prepare = spawnSync(
      process.execPath,
      [
        CLI,
        'collab',
        'prepare',
        '--goal',
        goalPath,
        '--domain-root',
        join(root, 'domain'),
        '--json',
      ],
      { cwd: root, encoding: 'utf8', timeout: 30_000 },
    );
    assert.equal(prepare.status, 0, prepare.stderr);
    const prepared = JSON.parse(prepare.stdout) as {
      prepared: { prepared_dir: string; prepared_path?: string };
    };
    const preparedFile = join(prepared.prepared.prepared_dir, 'prepared.json');

    const run = spawnSync(
      process.execPath,
      [
        CLI,
        'collab',
        'run',
        '--prepared',
        preparedFile,
        '--capabilities',
        cardPath,
        '--controller',
        'fixture',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
        input: `${JSON.stringify({
          schema: 'pappra/collaboration-command/1',
          action: 'query',
          request_id: 'q1',
        })}\n${JSON.stringify({
          schema: 'pappra/collaboration-command/1',
          action: 'finish',
          request_id: 'f1',
          status: 'completed',
        })}\n`,
      },
    );
    assert.equal(run.status, 0, run.stderr);
    const events = run.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string });
    assert(events.some((event) => event.kind === 'query'));
    assert(events.some((event) => event.kind === 'finished'));
    assert.equal(digest.startsWith('sha256:'), true);
  } finally {
    cleanup(root);
  }
});
