import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  tickAutomaticHandoff,
  type AutomaticHandoffConfig,
  type AutomaticHandoffRuntime,
} from '../../src/app/collab-auto-handoff.js';
import { watchAutomaticHandoff } from '../../src/app/automatic-handoff-events.js';
import { buildMessage } from '../../src/collab/envelope.js';
import { submitMessage } from '../../src/collab/messages.js';
import { claimResources } from '../../src/collab/resources.js';
import { readRecord } from '../../src/collab/store.js';
import { makeTaskDomain } from './task-resources-fixtures.js';
import { owner } from './scenarios.js';
import {
  baseWorkspaceConfig,
  baseMachineConfig,
  writeMachineConfig,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';

function setup(label: string) {
  const fixture = makeTaskDomain(label, ['sample']);
  const cwd = join(fixture.root, 'workspace');
  mkdirSync(cwd);
  writeWorkspaceConfig(cwd, baseWorkspaceConfig());
  writeMachineConfig(cwd, baseMachineConfig(cwd));
  const source = {
    agent_id: 'source',
    session_id: randomUUID(),
    harness: 'pi',
    cwd,
  };
  const successor = {
    agent_id: 'next',
    session_id: randomUUID(),
    harness: 'pi',
    cwd,
  };
  const input = `sha256:${'1'.repeat(64)}`;
  const claimed = claimResources(fixture.tasks.sample!, {
    resources: [{ kind: 'path', path: join(cwd, 'work') }],
    holder: source,
    subtaskId: 'work',
    attempt: 1,
  });
  assert.equal(claimed.ok, true);
  if (!claimed.ok) throw new Error('fixture claim failed');
  const assigned = submitMessage(
    fixture.tasks.sample!,
    buildMessage({
      message_id: 'assign-work',
      type: 'ASSIGN',
      task_id: 'sample',
      from: owner,
      to: source,
      subtask_id: 'work',
      attempt: 1,
      owner_epoch: 1,
      body: {
        assignment_digest: `sha256:${'a'.repeat(64)}`,
        input_revision: input,
      },
    }),
  );
  assert.equal(assigned.ok, true);
  const config: AutomaticHandoffConfig = {
    schema: 'pappra/automatic-handoff/1',
    id: 'threshold-handoff',
    thresholdPercent: 75,
    workspaceRoot: cwd,
    bundleId: randomUUID(),
    nextAction: 'Continue the authorized work.',
    checkpoint: {
      taskId: 'sample',
      objective: 'Finish the fixture task.',
      acceptance: ['The authorized work is completed and verified.'],
      nextActions: ['Continue the authorized work.'],
    },
    transition: {
      schema: 'pappra/collaboration-session-transition-request/1',
      task_root: fixture.tasks.sample!,
      transition_id: 'transition-auto',
      intent: {
        intent_id: 'intent-auto',
        handoff_id: 'handoff-auto',
        generation: 1,
        subtask_id: 'work',
        attempt: 1,
        input_revision: input,
        from: source,
        to: successor,
        coordinator_epoch: 1,
        claims: claimed.claims.map((claim) => ({
          claim_id: claim.claim_id,
          resource_epoch: claim.resource_epoch,
        })),
      },
      bootstrap_request: {
        ref: join(fixture.root, 'missing-bootstrap.json'),
        digest: `sha256:${'b'.repeat(64)}`,
      },
      evidence: { ack_message_id: null, first_work_report_id: null },
      archive_mode: 'task-retirement',
    },
  };
  let captures = 0;
  let percent: number | null = 60;
  const runtime: AutomaticHandoffRuntime = {
    observe: () => ({
      cwd,
      contextPercent: percent,
      native: {
        harness: 'pi',
        sessionId: source.session_id,
        agentId: source.agent_id,
        paneId: null,
        surface: 'sdk',
        configurationId: 'fixture',
        modelObservation: {
          model: 'fixture-model',
          provider: 'fixture-provider',
          reasoning: null,
        },
      },
    }),
    captureSummary: async () => {
      captures++;
      return {
        summary:
          'A real runtime supplies the native summary here; fixture task is pending.',
        complete: true,
      };
    },
    inventory: async () => ({
      completeness: 'unknown',
      inflight: [],
      pending_messages: [],
      pending_approvals: [],
    }),
  };
  return {
    fixture,
    config,
    runtime,
    setPercent: (value: number | null) => {
      percent = value;
    },
    captures: () => captures,
  };
}

test('automatic handoff does nothing below threshold and refuses unknown or foreign native identity', async () => {
  const flow = setup('auto-handoff-idle');
  try {
    const before = readRecord(flow.fixture.tasks.sample!)!.state_revision;
    assert.equal(
      (await tickAutomaticHandoff(flow.config, flow.runtime)).status,
      'below-threshold',
    );
    flow.setPercent(null);
    assert.equal(
      (await tickAutomaticHandoff(flow.config, flow.runtime)).status,
      'waiting',
    );
    flow.setPercent(80);
    const foreign = {
      ...flow.runtime,
      observe: () => ({ ...flow.runtime.observe(), cwd: '/foreign' }),
    };
    assert.equal(
      (await tickAutomaticHandoff(flow.config, foreign)).code,
      'automatic_handoff_source_mismatch',
    );
    assert.equal(flow.captures(), 0);
    assert.equal(
      readRecord(flow.fixture.tasks.sample!)!.state_revision,
      before,
    );
  } finally {
    flow.fixture.cleanup();
  }
});

test('unready native compaction waits without reserving or fencing a summary call', async () => {
  const flow = setup('auto-handoff-compaction-eligibility');
  try {
    flow.setPercent(80);
    const before = readRecord(flow.fixture.tasks.sample!)!.state_revision;
    const result = await tickAutomaticHandoff(flow.config, {
      ...flow.runtime,
      canCaptureSummary: () => false,
    });
    assert.equal(result.status, 'waiting');
    assert.equal(result.code, 'native_compaction_not_ready');
    assert.equal(flow.captures(), 0);
    assert.equal(
      readRecord(flow.fixture.tasks.sample!)!.state_revision,
      before,
    );
  } finally {
    flow.fixture.cleanup();
  }
});

test('post-compaction admission is pinned once without rewriting the approved template', async () => {
  const flow = setup('auto-handoff-refresh');
  try {
    flow.setPercent(80);
    let refreshed = 0;
    const original = structuredClone(flow.config.transition.bootstrap_request);
    const file = join(flow.fixture.root, 'admitted-bootstrap.json');
    const bytes = '{}\n';
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const runtime = {
      ...flow.runtime,
      prepareBootstrapAdmission: async (request: typeof original) => {
        assert.equal(flow.captures(), 1);
        assert.deepEqual(request, original);
        assert(
          existsSync(
            join(
              flow.config.workspaceRoot,
              '.pappra/local/tasks/sample/handoff-bundles',
              `${flow.config.bundleId}.json`,
            ),
          ),
        );
        refreshed++;
        writeFileSync(file, bytes);
        return { ref: file, digest };
      },
    };
    await tickAutomaticHandoff(flow.config, runtime);
    await tickAutomaticHandoff(flow.config, runtime);
    assert.equal(refreshed, 1);
    assert.deepEqual(flow.config.transition.bootstrap_request, original);
    const entries = readRecord(flow.fixture.tasks.sample!)!
      .automatic_handoff_journal as {
      request: { bootstrap_request: { ref: string; digest: string } };
    }[];
    assert.deepEqual(entries[0]?.request.bootstrap_request, {
      ref: file,
      digest,
    });
  } finally {
    flow.fixture.cleanup();
  }
});

test('automatic handoff captures one real checkpoint/bundle and retains native transfer guards', async () => {
  const flow = setup('auto-handoff-capture');
  try {
    flow.setPercent(80);
    const first = await tickAutomaticHandoff(flow.config, flow.runtime);
    assert.equal(first.status, 'waiting', JSON.stringify(first));
    assert.equal(flow.captures(), 1);
    const record = readRecord(flow.fixture.tasks.sample!)!;
    const entries = record.automatic_handoff_journal as {
      request: { bundle: { bundle_id: string } };
      stage: string;
    }[];
    assert.equal(entries[0]?.stage, 'active');
    const bundleFile = join(
      flow.config.workspaceRoot,
      '.pappra/local/tasks/sample/handoff-bundles',
      `${flow.config.bundleId}.json`,
    );
    assert.equal(existsSync(bundleFile), true);
    const bundle = JSON.parse(readFileSync(bundleFile, 'utf8')) as {
      handoff: { pendingTools: { completeness: string } };
    };
    assert.equal(bundle.handoff.pendingTools.completeness, 'unknown');
    await tickAutomaticHandoff(flow.config, flow.runtime);
    assert.equal(
      flow.captures(),
      1,
      'subsequent evidence events reuse the pinned bundle',
    );
    assert.equal(
      readRecord(flow.fixture.tasks.sample!)!.handoffs.length,
      0,
      'missing bootstrap/native proof never transfers claims',
    );
    const changed = await tickAutomaticHandoff(
      { ...flow.config, nextAction: 'different bytes' },
      flow.runtime,
    );
    assert.equal(changed.code, 'automatic_handoff_config_conflict');
  } finally {
    flow.fixture.cleanup();
  }
});

test('summary ambiguity is durable across restarts and does not issue another model request', async () => {
  const flow = setup('auto-handoff-ambiguous');
  try {
    flow.setPercent(90);
    let calls = 0;
    const broken = {
      ...flow.runtime,
      captureSummary: async () => {
        calls++;
        throw new Error('provider disconnected after admission');
      },
    };
    assert.equal(
      (await tickAutomaticHandoff(flow.config, broken)).status,
      'reconcile_required',
    );
    assert.equal(
      (await tickAutomaticHandoff(flow.config, broken)).status,
      'reconcile_required',
    );
    assert.equal(calls, 1);
    assert.equal(flow.captures(), 0);
  } finally {
    flow.fixture.cleanup();
  }
});

test('lossy native summary retains the full identity-checked transcript as a private checkpoint artifact', async () => {
  const flow = setup('auto-native-transcript');
  try {
    flow.setPercent(90);
    const sessionFile = join(flow.fixture.root, 'native.jsonl');
    const transcript = `${JSON.stringify({
      type: 'session',
      id: flow.runtime.observe().native.sessionId,
      cwd: flow.config.workspaceRoot,
    })}\n${JSON.stringify({ type: 'message', message: { role: 'user', content: 'Preserve the full source context.' } })}\n`;
    writeFileSync(sessionFile, transcript);
    const native = {
      ...flow.runtime,
      captureSummary: async () => ({
        summary: 'Lossy native summary.',
        complete: false,
        sessionFile,
      }),
    };
    const result = await tickAutomaticHandoff(flow.config, native);
    assert.equal(result.status, 'waiting', JSON.stringify(result));
    const saved = join(
      flow.config.workspaceRoot,
      '.pappra/local/tasks/sample/native-context',
      `${flow.config.id}.jsonl`,
    );
    assert.equal(readFileSync(saved, 'utf8'), transcript);
    const bundleFile = join(
      flow.config.workspaceRoot,
      '.pappra/local/tasks/sample/handoff-bundles',
      `${flow.config.bundleId}.json`,
    );
    assert.equal(
      JSON.parse(readFileSync(bundleFile, 'utf8')).checkpoint
        .contextCompleteness,
      'complete',
    );
  } finally {
    flow.fixture.cleanup();
  }
});

test('a foreign native transcript cannot supply complete handoff context', async () => {
  const flow = setup('auto-foreign-transcript');
  try {
    flow.setPercent(90);
    const sessionFile = join(flow.fixture.root, 'foreign.jsonl');
    writeFileSync(
      sessionFile,
      `${JSON.stringify({ type: 'session', id: randomUUID(), cwd: flow.config.workspaceRoot })}\n`,
    );
    const result = await tickAutomaticHandoff(flow.config, {
      ...flow.runtime,
      captureSummary: async () => ({
        summary: 'Partial summary.',
        complete: false,
        sessionFile,
      }),
    });
    assert.equal(result.code, 'native_transcript_identity_mismatch');
    assert.equal(
      existsSync(
        join(
          flow.config.workspaceRoot,
          '.pappra/local/tasks/sample/native-context',
        ),
      ),
      false,
    );
  } finally {
    flow.fixture.cleanup();
  }
});

test('native settled events advance capture once and own journal updates do not recapture', async () => {
  const flow = setup('auto-native-event');
  let listener: ((event: unknown) => void) | null = null;
  const watcher = watchAutomaticHandoff(flow.config, {
    ...flow.runtime,
    subscribe(callback) {
      listener = callback;
      return () => {
        listener = null;
      };
    },
  });
  try {
    await watcher.refresh();
    assert.equal(flow.captures(), 0);
    flow.setPercent(90);
    const notify = listener as ((event: unknown) => void) | null;
    assert.ok(notify);
    notify({ type: 'agent_settled' });
    await watcher.refresh();
    assert.equal(watcher.status().result?.status, 'waiting');
    assert.equal(flow.captures(), 1);
    await watcher.refresh();
    assert.equal(flow.captures(), 1);
  } finally {
    watcher.close();
    flow.fixture.cleanup();
  }
});
