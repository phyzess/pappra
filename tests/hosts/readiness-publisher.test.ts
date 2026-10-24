import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  publishManagedPiReadiness,
  watchManagedPiReadiness,
} from '../../src/app/managed-pi-readiness.js';
import { isAssignment, isCard } from '../../src/collab/contracts.js';
import { makeCapabilitiesFixture } from '../collab/capabilities-fixtures.js';
import { cleanup } from '../workspace/fixtures.js';

const SESSION_SCHEMA = 'harness-collab/pi-managed-session/1';

interface ReadinessPayload {
  schema: string;
  type: string;
  at: string;
  session_id: string;
  cwd: string;
  phase: string;
  native_header: {
    type: string;
    id: string;
    cwd: string;
    timestamp: string;
    version: string;
  };
  native_session_file: string | null;
  sdk: { package: string; version: string };
  native_identity: {
    agent_id: string;
    harness: string;
    surface: string;
    configuration_id: string;
  };
  model: { provider: string; id: string; thinking_level: string | null };
  configuration: { configuration_id: string; project_trusted: boolean | null };
  resource_inventory: {
    completeness: 'complete' | 'unknown';
    source: string;
    tools: { all_names: string[]; active_names: string[] };
    skills: {
      name: string;
      entry: string;
      availability: 'available' | 'unknown';
      body_loaded: string;
    }[];
  };
  owned_runtime: {
    scope: string;
    queues_completeness: 'complete' | 'unknown';
    pending_message_count: number;
    work_observation: string;
    is_idle: boolean;
    is_streaming: boolean;
    is_compacting: boolean;
    is_bash_running: boolean;
    has_pending_bash_messages: boolean;
    pending_tool_calls: number;
    extension_dialogs_completeness: string;
    pending_extension_dialogs: number;
    built_in_ui_approvals_observation: string;
    uncovered_approval_paths: string[];
  };
}
// Synthetic sidecar rows exercise the consumer only; these are not native acceptance evidence.
function setup(label: string) {
  const fixture = makeCapabilitiesFixture(label, { harness: 'pi' });
  const metadataFile = join(fixture.root, 'pi-events.jsonl');
  const nativeSessionFile = join(fixture.root, 'native-session.jsonl');
  const config = {
    assignmentFile: fixture.assignmentFile,
    templateFile: fixture.templateFile,
    cardFile: join(fixture.root, 'card.runtime.json'),
  };
  const source = {
    sessionId: 'worker-session',
    cwd: fixture.cwd,
    metadataFile,
    expectedProvider: 'openrouter',
    expectedModel: 'openai/gpt-6-luna',
  };
  const startedAt = new Date(Date.now() - 10_000).toISOString();
  const template = {
    agent_id: 'worker',
    surface: 'cli',
    configuration_id: 'fixture-config',
  };
  const sessionStart = {
    schema: SESSION_SCHEMA,
    type: 'session_start',
    at: startedAt,
    session_id: source.sessionId,
    cwd: source.cwd,
    session_file: nativeSessionFile,
  };
  writeFileSync(metadataFile, `${JSON.stringify(sessionStart)}\n`);
  const payload: ReadinessPayload = {
    schema: SESSION_SCHEMA,
    type: 'resources_ready',
    at: new Date().toISOString(),
    session_id: source.sessionId,
    cwd: source.cwd,
    phase: 'interactive_mode_init_complete',
    native_header: {
      type: 'session',
      id: source.sessionId,
      cwd: source.cwd,
      timestamp: startedAt,
      version: '1.4.0',
    },
    native_session_file: nativeSessionFile,
    sdk: {
      package: '@earendil-works/pi-coding-agent',
      version: '1.4.0',
    },
    native_identity: {
      agent_id: template.agent_id,
      harness: 'pi',
      surface: template.surface,
      configuration_id: template.configuration_id,
    },
    model: {
      provider: 'openrouter',
      id: 'openai/gpt-6-luna',
      thinking_level: 'max',
    },
    configuration: {
      configuration_id: template.configuration_id,
      project_trusted: true,
    },
    resource_inventory: {
      completeness: 'complete',
      source: 'pi_1_4_runtime_apis',
      tools: {
        all_names: ['read', 'bash'],
        active_names: ['read', 'bash'],
      },
      skills: [
        {
          name: 'fixture-skill',
          entry: fixture.skillFile,
          availability: 'available',
          body_loaded: 'not_observed',
        },
      ],
    },
    owned_runtime: {
      scope: 'pinned_pi_1_4_owned_runtime',
      queues_completeness: 'complete',
      pending_message_count: 0,
      work_observation: 'complete',
      is_idle: true,
      is_streaming: false,
      is_compacting: false,
      is_bash_running: false,
      has_pending_bash_messages: false,
      pending_tool_calls: 0,
      extension_dialogs_completeness: 'complete',
      pending_extension_dialogs: 0,
      built_in_ui_approvals_observation: 'complete',
      uncovered_approval_paths: [],
    },
  };
  const appendReady = (event: ReadinessPayload = payload) => {
    const prior = readFileSync(metadataFile, 'utf8');
    writeFileSync(metadataFile, `${prior}${JSON.stringify(event)}\n`);
  };
  const writeNativeHeader = (id = source.sessionId) => {
    writeFileSync(
      nativeSessionFile,
      `${JSON.stringify({
        type: 'session',
        id,
        cwd: source.cwd,
        timestamp: startedAt,
        version: '1.4.0',
      })}\n`,
    );
  };
  return {
    fixture,
    config,
    source,
    metadataFile,
    nativeSessionFile,
    sessionStart,
    payload,
    appendReady,
    writeNativeHeader,
  };
}

test('native startup availability publishes without a transcript or model turn and deduplicates restart', () => {
  const value = setup('readiness-no-prompt');
  try {
    const originalTemplate = readFileSync(value.config.templateFile, 'utf8');
    const pending = publishManagedPiReadiness(value.config, value.source);
    assert.equal(pending.status, 'waiting');
    assert.equal(pending.code, 'native_resources_ready_missing');
    assert.equal(existsSync(value.config.cardFile), false);

    value.appendReady();
    const first = publishManagedPiReadiness(value.config, value.source);
    assert.equal(first.status, 'published', JSON.stringify(first));
    assert.equal(first.preflight, 'ready');
    assert.equal(existsSync(value.nativeSessionFile), false);
    const card = JSON.parse(readFileSync(value.config.cardFile, 'utf8')) as {
      session_id: string;
      observed_at: string;
      tools: { id: string; state: string }[];
      skills: { id: string; state: string }[];
      evidence_records: { ref: string; digest: string }[];
      native_observation: Record<string, unknown>;
    };
    assert.equal(card.session_id, value.source.sessionId);
    assert.equal(card.observed_at, value.payload.at);
    assert.equal(
      card.tools.find((tool) => tool.id === 'read')?.state,
      'callable',
    );
    assert.equal(
      card.tools.find((tool) => tool.id === 'bash')?.state,
      'callable',
    );
    assert.equal(card.skills[0]?.state, 'callable');
    assert.deepEqual(
      card.evidence_records.map((item) => item.ref),
      [value.metadataFile],
    );
    assert.deepEqual(
      (card.native_observation['limitations'] as string[]).slice(0, 2),
      ['tool_execution_not_observed', 'skill_body_loading_not_observed'],
    );
    assert.equal(
      readFileSync(value.config.templateFile, 'utf8'),
      originalTemplate,
    );
    const publishedBytes = readFileSync(value.config.cardFile);
    const restarted = publishManagedPiReadiness(value.config, value.source);
    assert.equal(restarted.status, 'unchanged');
    assert.equal(restarted.preflight, 'ready');
    assert.deepEqual(readFileSync(value.config.cardFile), publishedBytes);
    const sidecar = readFileSync(value.metadataFile, 'utf8');
    assert.ok(!sidecar.includes('agent_settled'));
  } finally {
    cleanup(value.fixture.root);
  }
});

test('startup trust, approvals, identity, and inventory gaps remain pending', () => {
  const cases: readonly [
    string,
    (payload: ReturnType<typeof setup>['payload']) => void,
  ][] = [
    [
      'unknown inventory',
      (payload) => {
        payload.resource_inventory.completeness = 'unknown';
      },
    ],
    [
      'untrusted project',
      (payload) => {
        payload.configuration.project_trusted = false;
      },
    ],
    [
      'approval pending',
      (payload) => {
        payload.owned_runtime.pending_extension_dialogs = 1;
      },
    ],
    [
      'incomplete queue inventory',
      (payload) => {
        payload.owned_runtime.queues_completeness = 'unknown';
      },
    ],
    [
      'foreign native header',
      (payload) => {
        payload.native_header.id = 'foreign-session';
      },
    ],
    [
      'foreign resource session',
      (payload) => {
        payload.session_id = 'foreign-session';
      },
    ],
    [
      'wrong model pin',
      (payload) => {
        payload.model.id = 'openai/other-model';
      },
    ],
    [
      'skill body overclaim',
      (payload) => {
        payload.resource_inventory.skills[0]!.body_loaded = 'loaded';
      },
    ],
    [
      'unknown skill availability',
      (payload) => {
        payload.resource_inventory.skills[0]!.availability = 'unknown';
      },
    ],
  ];
  for (const [label, mutate] of cases) {
    const value = setup(`readiness-refusal-${label.replaceAll(' ', '-')}`);
    try {
      const event = structuredClone(value.payload);
      mutate(event);
      value.appendReady(event);
      const result = publishManagedPiReadiness(value.config, value.source);
      assert.equal(
        result.status,
        'waiting',
        `${label}: ${JSON.stringify(result)}`,
      );
      assert.equal(existsSync(value.config.cardFile), false, label);
    } finally {
      cleanup(value.fixture.root);
    }
  }

  const missingStart = setup('readiness-forged-sidecar-only');
  try {
    writeFileSync(
      missingStart.metadataFile,
      `${JSON.stringify(missingStart.payload)}\n`,
    );
    const result = publishManagedPiReadiness(
      missingStart.config,
      missingStart.source,
    );
    assert.equal(result.status, 'waiting');
    assert.equal(existsSync(missingStart.config.cardFile), false);
  } finally {
    cleanup(missingStart.fixture.root);
  }
});

test('complete inventory preserves missing required capabilities as unavailable, and latest valid snapshot wins', () => {
  const value = setup('readiness-latest-snapshot');
  try {
    const initial = structuredClone(value.payload);
    initial.resource_inventory.tools.active_names = ['read'];
    initial.resource_inventory.skills = [];
    value.appendReady(initial);
    const first = publishManagedPiReadiness(value.config, value.source);
    assert.equal(first.status, 'published');
    assert.equal(first.preflight, 'needs_input');
    const firstCard = JSON.parse(
      readFileSync(value.config.cardFile, 'utf8'),
    ) as {
      tools: { id: string; state: string }[];
      skills: { id: string; state: string }[];
    };
    assert.equal(
      firstCard.tools.find((tool) => tool.id === 'bash')?.state,
      'disabled',
    );
    assert.equal(
      firstCard.skills.find((skill) => skill.id === 'fixture-skill')?.state,
      'unknown',
    );

    const latest = structuredClone(value.payload);
    latest.at = new Date(Date.now() + 10).toISOString();
    value.appendReady(latest);
    const updated = publishManagedPiReadiness(value.config, value.source);
    assert.equal(updated.status, 'published');
    assert.equal(updated.preflight, 'ready');
    const card = JSON.parse(readFileSync(value.config.cardFile, 'utf8')) as {
      observed_at: string;
      evidence_records: { ref: string }[];
    };
    assert.equal(card.observed_at, latest.at);
    assert.deepEqual(
      card.evidence_records.map((item) => item.ref),
      [value.metadataFile],
    );
  } finally {
    cleanup(value.fixture.root);
  }
});

test('an existing transcript is verified when present but is not required before persistence', () => {
  const value = setup('readiness-existing-transcript');
  try {
    value.appendReady();
    value.writeNativeHeader();
    const result = publishManagedPiReadiness(value.config, value.source);
    assert.equal(result.status, 'published', JSON.stringify(result));
    const card = JSON.parse(readFileSync(value.config.cardFile, 'utf8')) as {
      evidence_records: { ref: string }[];
    };
    assert.deepEqual(
      card.evidence_records.map((item) => item.ref),
      [value.metadataFile, value.nativeSessionFile],
    );
  } finally {
    cleanup(value.fixture.root);
  }

  const mismatch = setup('readiness-transcript-mismatch');
  try {
    mismatch.appendReady();
    mismatch.writeNativeHeader('foreign-session');
    const result = publishManagedPiReadiness(mismatch.config, mismatch.source);
    assert.equal(result.status, 'waiting');
    assert.equal(result.code, 'native_header_identity_mismatch');
    assert.equal(existsSync(mismatch.config.cardFile), false);
  } finally {
    cleanup(mismatch.fixture.root);
  }
});

test(
  'watcher recovers after assignment/template arrival, invokes beforeRefresh, and ignores its own artifact event',
  { timeout: 5000 },
  async () => {
    const value = setup('readiness-watch-recovery');
    const assignment = readFileSync(value.config.assignmentFile, 'utf8');
    const template = readFileSync(value.config.templateFile, 'utf8');
    unlinkSync(value.config.assignmentFile);
    unlinkSync(value.config.templateFile);
    let beforeRefreshCalls = 0;
    let readyWritten = false;
    let completed!: () => void;
    let initialWaiting!: () => void;
    const published = new Promise<void>((resolve) => {
      completed = resolve;
    });
    const initial = new Promise<void>((resolve) => {
      initialWaiting = resolve;
    });
    const publisher = watchManagedPiReadiness(
      value.config,
      value.source,
      (result) => {
        if (result.status === 'waiting') initialWaiting();
        if (result.status === 'published' && result.preflight === 'ready')
          completed();
      },
      {
        beforeRefresh: async () => {
          beforeRefreshCalls += 1;
          if (
            readyWritten ||
            !existsSync(value.config.assignmentFile) ||
            !existsSync(value.config.templateFile)
          )
            return;
          const assignmentValue: unknown = JSON.parse(
            readFileSync(value.config.assignmentFile, 'utf8'),
          );
          const templateValue: unknown = JSON.parse(
            readFileSync(value.config.templateFile, 'utf8'),
          );
          if (!isAssignment(assignmentValue) || !isCard(templateValue)) return;
          readyWritten = true;
          value.appendReady();
        },
      },
    );
    let timer: NodeJS.Timeout | undefined;
    try {
      await initial;
      assert.equal(existsSync(value.config.cardFile), false);
      assert.equal(
        readyWritten,
        false,
        'identity-less startup must not fabricate readiness',
      );
      writeFileSync(value.config.assignmentFile, assignment);
      writeFileSync(value.config.templateFile, template);
      await Promise.race([
        published,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `readiness did not recover: ${JSON.stringify({ status: publisher.status(), beforeRefreshCalls, readyWritten })}`,
                ),
              ),
            3000,
          );
        }),
      ]);
      assert.equal(readyWritten, true);
      assert.equal(publisher.status()?.preflight, 'ready');
      assert.ok(beforeRefreshCalls >= 2);
      const settledCalls = beforeRefreshCalls;
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(
        beforeRefreshCalls,
        settledCalls,
        'sidecar/output writes must not create a watch loop',
      );
    } finally {
      await publisher.close();
      if (timer) clearTimeout(timer);
      cleanup(value.fixture.root);
    }
  },
);

test(
  'readiness watcher fails closed when a pinned input directory is replaced',
  { timeout: 5000 },
  async () => {
    const value = setup('readiness-directory-pin');
    let resolveInitial!: () => void;
    const initial = new Promise<void>((resolve) => {
      resolveInitial = resolve;
    });
    const publisher = watchManagedPiReadiness(
      value.config,
      value.source,
      () => {
        resolveInitial();
      },
    );
    const movedRoot = `${value.fixture.root}-moved`;
    try {
      await initial;
      renameSync(value.fixture.root, movedRoot);
      mkdirSync(value.fixture.root);
      await publisher.refresh(true);
      assert.equal(publisher.status()?.code, 'readiness_directory_changed');
    } finally {
      await publisher.close();
      cleanup(value.fixture.root);
      cleanup(movedRoot);
    }
  },
);

test('publisher refuses a foreign card, output symlink, and input/output alias', () => {
  const value = setup('readiness-boundaries');
  try {
    value.appendReady();
    writeFileSync(
      value.config.cardFile,
      `${JSON.stringify({ ...value.fixture.template, session_id: 'foreign-session' })}\n`,
    );
    const before = readFileSync(value.config.cardFile, 'utf8');
    assert.equal(
      publishManagedPiReadiness(value.config, value.source).code,
      'readiness_card_target_foreign',
    );
    assert.equal(readFileSync(value.config.cardFile, 'utf8'), before);

    const linkedCard = join(value.fixture.root, 'linked-card.json');
    symlinkSync(value.config.cardFile, linkedCard);
    assert.equal(
      publishManagedPiReadiness(
        { ...value.config, cardFile: linkedCard },
        value.source,
      ).code,
      'readiness_card_target_unsafe',
    );
    assert.equal(
      publishManagedPiReadiness(
        { ...value.config, cardFile: value.config.templateFile },
        value.source,
      ).code,
      'readiness_input_output_conflict',
    );
  } finally {
    cleanup(value.fixture.root);
  }
});
