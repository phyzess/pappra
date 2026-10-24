import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  deriveCapabilityCard,
  type CapabilityEvidenceResult,
} from '../../src/app/capability-evidence/index.js';
import { runCollaborationPreflight } from '../../src/app/collab-preflight.js';
import { cleanup } from '../workspace/fixtures.js';
import {
  FIXTURE_SECRET,
  makeCapabilitiesFixture,
  writeRows,
  type CapabilitiesFixture,
} from './capabilities-fixtures.js';

function digestOf(file: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
}

function readRows(file: string): Record<string, unknown>[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function derive(fixture: CapabilitiesFixture): CapabilityEvidenceResult {
  return deriveCapabilityCard({
    harness: fixture.harness,
    assignmentFile: fixture.assignmentFile,
    templateFile: fixture.templateFile,
    executionFile: fixture.executionFile,
    sessionFile: fixture.harness === 'pi' ? fixture.sessionFile : null,
    eventsFile: fixture.harness === 'pi' ? null : fixture.eventsFile,
  });
}

function writeCard(
  fixture: CapabilitiesFixture,
  result: CapabilityEvidenceResult,
) {
  assert.equal(result.status, 'derived');
  const file = join(fixture.root, 'card.runtime.json');
  writeFileSync(file, `${JSON.stringify(result.card, null, 2)}\n`);
  return file;
}

function snapshot(paths: readonly string[]): string[] {
  return paths.map(
    (file) => `${file}:${String(lstatSync(file).mtimeMs)}:${digestOf(file)}`,
  );
}

test('live Pi derives a schema-valid runtime card without an invented exit receipt', () => {
  const fixture = makeCapabilitiesFixture('pi-live', { harness: 'pi' });
  try {
    const before = snapshot([fixture.sessionFile, fixture.templateFile]);
    const result = deriveCapabilityCard({
      harness: 'pi',
      assignmentFile: fixture.assignmentFile,
      templateFile: fixture.templateFile,
      sessionFile: fixture.sessionFile,
      live: true,
    });
    assert.equal(result.status, 'derived', JSON.stringify(result));
    assert.equal(result.card?.tools[0]?.state, 'verified');
    assert.equal(result.card?.skills[0]?.state, 'verified');
    assert.deepEqual(result.card?.evidence_records, [
      { ref: fixture.sessionFile, digest: digestOf(fixture.sessionFile) },
    ]);
    assert.equal(
      (result.card?.native_observation as Record<string, unknown>)
        .launcher_clock,
      null,
    );
    assert.ok(
      result.limitations?.includes(
        'live_snapshot_does_not_prove_process_state_or_queue_approval_inventory',
      ),
    );
    assert.ok(!JSON.stringify(result).includes(FIXTURE_SECRET));
    assert.deepEqual(
      snapshot([fixture.sessionFile, fixture.templateFile]),
      before,
    );
    const cardFile = writeCard(fixture, result);
    assert.equal(
      runCollaborationPreflight({
        assignmentFile: fixture.assignmentFile,
        capabilitiesFile: cardFile,
      }).status,
      'ready',
    );
  } finally {
    cleanup(fixture.root);
  }
});

test('live Pi refuses pending input, partial tool work, model drift and conflicting execution evidence', () => {
  const fixture = makeCapabilitiesFixture('pi-live-pending', { harness: 'pi' });
  try {
    const rows = readRows(fixture.sessionFile);
    const options = {
      harness: 'pi' as const,
      assignmentFile: fixture.assignmentFile,
      templateFile: fixture.templateFile,
      sessionFile: fixture.sessionFile,
      live: true,
    };
    for (const row of [
      {
        type: 'message',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: 'next' }] },
      },
      {
        type: 'model_change',
        timestamp: new Date().toISOString(),
        modelId: 'another-model',
      },
    ]) {
      writeRows(fixture.sessionFile, [...rows, row]);
      assert.equal(deriveCapabilityCard(options).status, 'needs_input');
    }
    writeRows(fixture.sessionFile, rows.slice(0, 3));
    assert.ok(
      deriveCapabilityCard(options).blockers?.includes(
        'incomplete_tool_results',
      ),
    );
    writeRows(fixture.sessionFile, rows);
    assert.equal(
      deriveCapabilityCard({ ...options, executionFile: fixture.executionFile })
        .status,
      'invalid',
    );
    assert.equal(
      deriveCapabilityCard({ ...options, harness: 'codex' }).status,
      'invalid',
    );
    // A metadata-only append must never refresh an old capability observation.
    const original = deriveCapabilityCard(options).card!.observed_at;
    writeRows(fixture.sessionFile, [
      ...rows,
      {
        type: 'session_info',
        timestamp: new Date().toISOString(),
        name: 'renamed',
      },
    ]);
    assert.equal(deriveCapabilityCard(options).card!.observed_at, original);
  } finally {
    cleanup(fixture.root);
  }
});

test('Pi evidence derives verified tools and an actually loaded skill', () => {
  const fixture = makeCapabilitiesFixture('c3-pi', { harness: 'pi' });
  try {
    const cardFile = join(fixture.root, 'card.runtime.json');
    const tracked = [
      fixture.sessionFile,
      fixture.executionFile,
      fixture.assignmentFile,
      fixture.templateFile,
      fixture.skillFile,
      cardFile,
    ];
    const before = snapshot(tracked.slice(0, 5));
    const result = derive(fixture);
    assert.equal(result.status, 'derived');
    assert.equal(result.harness, 'pi');
    assert.equal(result.card?.evidence_level, 'runtime');
    assert.equal(
      result.card?.tools.find((tool) => tool.id === 'read')?.state,
      'verified',
    );
    assert.equal(
      result.card?.tools.find((tool) => tool.id === 'bash')?.state,
      'verified',
    );
    assert.equal(result.card?.skills[0]?.state, 'verified');
    assert.deepEqual(
      result.card?.evidence_records?.map((record) => record.digest),
      [digestOf(fixture.sessionFile), digestOf(fixture.executionFile)],
    );
    assert.ok(
      Math.abs(Date.parse(result.card!.observed_at) - (Date.now() - 60_000)) <
        5_000,
    );
    assert.ok(!JSON.stringify(result).includes(FIXTURE_SECRET));
    assert.deepEqual(snapshot(tracked.slice(0, 5)), before);
    writeFileSync(cardFile, `${JSON.stringify(result.card, null, 2)}\n`);
    const preflight = runCollaborationPreflight({
      assignmentFile: fixture.assignmentFile,
      capabilitiesFile: cardFile,
    });
    assert.equal(preflight.status, 'ready');
    assert.deepEqual(preflight.blockers, []);
  } finally {
    cleanup(fixture.root);
  }
});

test('Pi replay keeps the native observation time and goes stale', () => {
  const fixture = makeCapabilitiesFixture('c3-pi-stale', { harness: 'pi' });
  try {
    const old = Date.parse('2020-01-02T03:04:05Z');
    const rows = readRows(fixture.sessionFile);
    const last = rows[rows.length - 1]!;
    last.timestamp = new Date(old).toISOString();
    const message = last.message as Record<string, unknown>;
    message.timestamp = old;
    writeRows(fixture.sessionFile, rows);
    const result = derive(fixture);
    assert.equal(result.status, 'derived');
    assert.equal(Date.parse(result.card!.observed_at), old);
    const cardFile = writeCard(fixture, result);
    const preflight = runCollaborationPreflight({
      assignmentFile: fixture.assignmentFile,
      capabilitiesFile: cardFile,
    });
    assert.equal(preflight.status, 'needs_input');
    assert.ok(
      preflight.blockers.some((check) => check.code === 'capabilities_stale'),
    );
  } finally {
    cleanup(fixture.root);
  }
});

test('Pi refuses identity, cwd, incomplete and changed-skill evidence', () => {
  const fixture = makeCapabilitiesFixture('c3-pi-refusals', { harness: 'pi' });
  try {
    const identity = structuredClone(fixture.assignment) as {
      assignee: Record<string, unknown>;
    };
    identity.assignee.cwd = fixture.root;
    const identityFile = join(fixture.root, 'assignment.identity.json');
    writeFileSync(identityFile, `${JSON.stringify(identity)}\n`);
    const mismatched = deriveCapabilityCard({
      harness: 'pi',
      assignmentFile: identityFile,
      templateFile: fixture.templateFile,
      executionFile: fixture.executionFile,
      sessionFile: fixture.sessionFile,
    });
    assert.equal(mismatched.status, 'needs_input');
    assert.deepEqual(mismatched.blockers, ['template_cwd_mismatch']);

    const failedRows = readRows(fixture.sessionFile);
    const failedResult = failedRows.find(
      (row) =>
        (row.message as Record<string, unknown> | undefined)?.toolCallId ===
        'call-bash',
    )!.message as Record<string, unknown>;
    failedResult.isError = true;
    writeRows(fixture.sessionFile, failedRows);
    const failed = derive(fixture);
    assert.equal(failed.status, 'derived');
    assert.equal(
      failed.card?.tools.find((tool) => tool.id === 'bash')?.state,
      'unknown',
    );

    const rows = readRows(fixture.sessionFile);
    const withoutResult = rows.filter(
      (row) =>
        (row.message as Record<string, unknown> | undefined)?.toolCallId !==
        'call-bash',
    );
    writeRows(fixture.sessionFile, withoutResult);
    const incomplete = derive(fixture);
    assert.equal(incomplete.status, 'needs_input');
    assert.deepEqual(incomplete.blockers, ['incomplete_tool_results']);

    writeRows(fixture.sessionFile, rows);
    writeFileSync(fixture.skillFile, '# Fixture skill\n\nchanged\n');
    const changed = derive(fixture);
    assert.equal(changed.status, 'needs_input');
    assert.deepEqual(changed.blockers, ['skill_files_changed']);
  } finally {
    cleanup(fixture.root);
  }
});

test('Codex evidence maps explicit items and never promotes skills', () => {
  const fixture = makeCapabilitiesFixture('c3-codex', { harness: 'codex' });
  try {
    const result = derive(fixture);
    assert.equal(result.status, 'derived');
    assert.equal(
      result.card?.tools.find((tool) => tool.id === 'shell')?.state,
      'verified',
    );
    assert.equal(result.card?.skills[0]?.state, 'unknown');
    assert.deepEqual(result.limitations, [
      'skill_invocation_not_reported_by_codex_exec_json',
      'unmapped_item_types_are_not_promoted',
    ]);
    assert.ok(!JSON.stringify(result).includes(FIXTURE_SECRET));
    const cardFile = writeCard(fixture, result);
    assert.equal(
      runCollaborationPreflight({
        assignmentFile: fixture.assignmentFile,
        capabilitiesFile: cardFile,
      }).status,
      'ready',
    );

    const rows = readRows(fixture.eventsFile);
    rows.splice(rows.length - 1, 0, {
      type: 'item.completed',
      item: { id: 'item_mystery', type: 'mystery' },
    });
    writeRows(fixture.eventsFile, rows);
    const unknownItem = derive(fixture);
    assert.equal(unknownItem.status, 'derived');
    assert.deepEqual(unknownItem.limitations, [
      'skill_invocation_not_reported_by_codex_exec_json',
      'unmapped_item_types_are_not_promoted',
    ]);
    assert.equal(
      unknownItem.card?.tools.find((tool) => tool.id === 'shell')?.state,
      'verified',
    );
    rows.splice(rows.length - 1, 0, { type: 'turn.mystery' });
    writeRows(fixture.eventsFile, rows);
    const unsupported = derive(fixture);
    assert.equal(unsupported.status, 'needs_input');
    assert.deepEqual(unsupported.blockers, [
      'unsupported_row_types:turn.mystery',
    ]);
  } finally {
    cleanup(fixture.root);
  }
});

test('Codex failed items stay unknown and do not satisfy required tools', () => {
  const fixture = makeCapabilitiesFixture('c3-codex-failed', {
    harness: 'codex',
  });
  try {
    const rows = readRows(fixture.eventsFile);
    const item = rows.find(
      (row) =>
        (row.item as Record<string, unknown> | undefined)?.type ===
        'command_execution',
    )!.item as Record<string, unknown>;
    item.exit_code = 1;
    writeRows(fixture.eventsFile, rows);
    const result = derive(fixture);
    assert.equal(result.status, 'derived');
    assert.equal(
      result.card?.tools.find((tool) => tool.id === 'shell')?.state,
      'unknown',
    );
    const cardFile = writeCard(fixture, result);
    const preflight = runCollaborationPreflight({
      assignmentFile: fixture.assignmentFile,
      capabilitiesFile: cardFile,
    });
    assert.equal(preflight.status, 'needs_input');
    assert.ok(
      preflight.blockers.some((check) => check.code === 'tools_unavailable'),
    );
  } finally {
    cleanup(fixture.root);
  }
});

test('Claude evidence verifies Read and the injected skill source', () => {
  const fixture = makeCapabilitiesFixture('c3-claude', { harness: 'claude' });
  try {
    const result = derive(fixture);
    assert.equal(result.status, 'derived');
    assert.equal(
      result.card?.tools.find((tool) => tool.id === 'Read')?.state,
      'verified',
    );
    assert.equal(
      result.card?.tools.find((tool) => tool.id === 'Skill')?.state,
      'verified',
    );
    assert.equal(result.card?.skills[0]?.state, 'verified');
    assert.ok(!JSON.stringify(result).includes(FIXTURE_SECRET));
    const cardFile = writeCard(fixture, result);
    assert.equal(
      runCollaborationPreflight({
        assignmentFile: fixture.assignmentFile,
        capabilitiesFile: cardFile,
      }).status,
      'ready',
    );

    const rows = readRows(fixture.eventsFile);
    const originalRows = structuredClone(rows);
    const injection = rows.find((row) => row.isSynthetic === true)!;
    const content = (injection.message as { content: { text: string }[] })
      .content[0]!;
    content.text = `Base directory for this skill: ${fixture.root}\n`;
    writeRows(fixture.eventsFile, rows);
    const wrongSource = derive(fixture);
    assert.equal(wrongSource.status, 'derived');
    assert.equal(wrongSource.card?.skills[0]?.state, 'discovered');
    writeRows(fixture.eventsFile, originalRows);
    const failedRows = structuredClone(originalRows);
    const failedResult = failedRows.find((row) =>
      (
        (row.message as { content?: unknown[] } | undefined)?.content ?? []
      ).some(
        (item) => (item as Record<string, unknown>).tool_use_id === 'read-1',
      ),
    )!;
    const failedContent = (
      failedResult.message as { content: { is_error?: boolean }[] }
    ).content[0]!;
    failedContent.is_error = true;
    writeRows(fixture.eventsFile, failedRows);
    const failed = derive(fixture);
    assert.equal(failed.status, 'derived');
    assert.equal(
      failed.card?.tools.find((tool) => tool.id === 'Read')?.state,
      'callable',
    );
    assert.equal(
      failed.card?.tools.find((tool) => tool.id === 'Skill')?.state,
      'verified',
    );
  } finally {
    cleanup(fixture.root);
  }
});

test('Claude refuses non-discovery phases and incomplete correlation', () => {
  const fixture = makeCapabilitiesFixture('c3-claude-refusals', {
    harness: 'claude',
  });
  try {
    const execution = JSON.parse(
      readFileSync(fixture.executionFile, 'utf8'),
    ) as Record<string, unknown>;
    const original = execution.phase;
    execution.phase = 'exec';
    writeFileSync(fixture.executionFile, `${JSON.stringify(execution)}\n`);
    const phase = derive(fixture);
    assert.equal(phase.status, 'needs_input');
    assert.deepEqual(phase.blockers, ['not_a_discovery_execution']);
    execution.phase = original;
    writeFileSync(fixture.executionFile, `${JSON.stringify(execution)}\n`);

    const rows = readRows(fixture.eventsFile);
    writeRows(
      fixture.eventsFile,
      rows.filter((row) => {
        const content = (row.message as { content?: unknown[] } | undefined)
          ?.content;
        return !(
          Array.isArray(content) &&
          content.some(
            (item) =>
              (item as Record<string, unknown>).tool_use_id === 'read-1',
          )
        );
      }),
    );
    const incomplete = derive(fixture);
    assert.equal(incomplete.status, 'needs_input');
    assert.deepEqual(incomplete.blockers, ['incomplete_tool_results']);
  } finally {
    cleanup(fixture.root);
  }
});

test('oversize and special evidence files are refused without blocking', () => {
  const fixture = makeCapabilitiesFixture('c3-special', { harness: 'pi' });
  try {
    const fifo = join(fixture.root, 'session.fifo');
    assert.equal(
      // `mkfifo` is the only portable way to create a real FIFO here.
      spawnSync('mkfifo', [fifo]).status,
      0,
    );
    const fifoResult = deriveCapabilityCard({
      harness: 'pi',
      assignmentFile: fixture.assignmentFile,
      templateFile: fixture.templateFile,
      executionFile: fixture.executionFile,
      sessionFile: fifo,
    });
    assert.equal(fifoResult.status, 'needs_input');
    assert.deepEqual(fifoResult.blockers, ['unsupported_evidence_file']);

    const oversize = join(fixture.root, 'oversize.jsonl');
    writeFileSync(oversize, '');
    truncateSync(oversize, 16 * 1024 * 1024 + 1);
    const bigResult = deriveCapabilityCard({
      harness: 'pi',
      assignmentFile: fixture.assignmentFile,
      templateFile: fixture.templateFile,
      executionFile: fixture.executionFile,
      sessionFile: oversize,
    });
    assert.equal(bigResult.status, 'needs_input');
    assert.deepEqual(bigResult.blockers, ['unsupported_evidence_file']);
    unlinkSync(fifo);
  } finally {
    cleanup(fixture.root);
  }
});

test('a same-session model change re-derives, stays ready and keeps every unrelated refusal', () => {
  const fixture = makeCapabilitiesFixture('e1-model-continuation', {
    harness: 'pi',
  });
  try {
    const base = Date.now() - 30_000;
    const switchCall = 'call-model-switch';
    const rows = readRows(fixture.sessionFile);
    rows.push({
      type: 'message',
      id: 'switch-1',
      parentId: null,
      timestamp: new Date(base).toISOString(),
      message: {
        role: 'assistant',
        timestamp: base,
        model: 'successor-model',
        provider: 'successor-provider',
        stopReason: 'toolUse',
        content: [
          {
            type: 'toolCall',
            id: switchCall,
            name: 'read',
            arguments: {
              path: join(fixture.cwd, 'skills/fixture-skill/SKILL.md'),
            },
          },
        ],
      },
    });
    rows.push({
      type: 'message',
      id: 'switch-2',
      parentId: 'switch-1',
      timestamp: new Date(base + 500).toISOString(),
      message: {
        role: 'toolResult',
        toolCallId: switchCall,
        toolName: 'read',
        isError: false,
        timestamp: base + 500,
        content: [],
      },
    });
    rows.push({
      type: 'message',
      id: 'switch-3',
      parentId: 'switch-2',
      timestamp: new Date(base + 1000).toISOString(),
      message: {
        role: 'assistant',
        timestamp: base + 1000,
        model: 'successor-model',
        provider: 'successor-provider',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'continued after the switch' }],
      },
    });
    writeRows(fixture.sessionFile, rows);

    const derived = derive(fixture);
    assert.equal(derived.status, 'derived');
    const observation = derived.card!.native_observation as Record<
      string,
      unknown
    >;
    assert.equal(observation.model, 'successor-model');
    assert.equal(observation.provider, 'successor-provider');
    const cardFile = writeCard(fixture, derived);
    const ready = runCollaborationPreflight({
      assignmentFile: fixture.assignmentFile,
      capabilitiesFile: cardFile,
    });
    assert.equal(ready.status, 'ready');
    assert.deepEqual(ready.blockers, []);

    const variant = (
      name: string,
      mutate: (card: Record<string, unknown>) => void,
    ): string => {
      const card = JSON.parse(readFileSync(cardFile, 'utf8')) as Record<
        string,
        unknown
      >;
      mutate(card);
      const file = join(fixture.root, `card.${name}.json`);
      writeFileSync(file, `${JSON.stringify(card, null, 2)}\n`);
      return file;
    };
    const outcome = (file: string): { status: string; blockers: string[] } => {
      const report = runCollaborationPreflight({
        assignmentFile: fixture.assignmentFile,
        capabilitiesFile: file,
      });
      return {
        status: report.status,
        blockers: report.blockers.map((check) => check.code).sort(),
      };
    };

    // Fresh evidence with the previous model value still passes: model is an observation.
    assert.deepEqual(
      outcome(
        variant('previous-model', (card) => {
          const native = card.native_observation as Record<string, unknown>;
          native.model = 'fixture-model';
          native.provider = 'fixture-provider';
        }),
      ),
      { status: 'ready', blockers: [] },
    );
    const refusals: readonly {
      readonly name: string;
      readonly mutate: (card: Record<string, unknown>) => void;
      readonly blockers: readonly string[];
    }[] = [
      {
        name: 'stale',
        mutate: (card) => {
          card.observed_at = new Date(
            Date.now() - 2 * 60 * 60 * 1000,
          ).toISOString();
        },
        blockers: ['capabilities_stale'],
      },
      {
        name: 'future',
        mutate: (card) => {
          card.observed_at = new Date(
            Date.now() + 2 * 60 * 60 * 1000,
          ).toISOString();
        },
        blockers: ['capabilities_from_future'],
      },
      {
        name: 'capability-loss',
        mutate: (card) => {
          card.tools = (card.tools as { id: string; state: string }[]).map(
            (tool) =>
              tool.id === 'bash' ? { id: tool.id, state: 'unknown' } : tool,
          );
        },
        blockers: ['tools_unavailable'],
      },
      {
        name: 'session',
        mutate: (card) => {
          card.session_id = 'other-session';
        },
        blockers: ['assignee_session_id_mismatch'],
      },
      {
        name: 'cwd',
        mutate: (card) => {
          card.cwd = fixture.root;
        },
        blockers: ['assignee_cwd_mismatch'],
      },
      {
        name: 'configuration',
        mutate: (card) => {
          card.configuration_id = 'other-configuration';
        },
        blockers: ['assignee_configuration_id_mismatch'],
      },
    ];
    for (const entry of refusals) {
      assert.deepEqual(
        outcome(variant(entry.name, entry.mutate)),
        { status: 'needs_input', blockers: [...entry.blockers] },
        entry.name,
      );
    }
  } finally {
    cleanup(fixture.root);
  }
});
