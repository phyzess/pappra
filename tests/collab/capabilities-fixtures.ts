import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fingerprintSkill } from '../../src/collab/fingerprint.js';
import { makeTempDir } from '../workspace/fixtures.js';

export type FixtureHarness = 'pi' | 'codex' | 'claude';

export const FIXTURE_SECRET = 'do-not-leak-transcript-payload';

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export interface CapabilitiesFixture {
  readonly root: string;
  readonly cwd: string;
  readonly harness: FixtureHarness;
  readonly assignmentFile: string;
  readonly templateFile: string;
  readonly executionFile: string;
  readonly sessionFile: string;
  readonly eventsFile: string;
  readonly secretFile: string;
  readonly skillDir: string;
  readonly skillFile: string;
  readonly bundleDigest: string;
  readonly assignment: Record<string, unknown>;
  readonly template: Record<string, unknown>;
}

interface Options {
  readonly harness: FixtureHarness;
  readonly secret?: boolean;
}

const AGENT = {
  agent_id: 'worker',
  session_id: 'worker-session',
  harness: 'pi',
  surface: 'cli',
  configuration_id: 'fixture-config',
};

export function makeCapabilitiesFixture(
  label: string,
  options: Options,
): CapabilitiesFixture {
  const root = realpathSync(makeTempDir(label));
  const cwd = join(root, 'workspace');
  mkdirSync(cwd, { recursive: true });
  const skillDir = join(cwd, 'skills', 'fixture-skill');
  mkdirSync(skillDir, { recursive: true });
  const skillFile = join(skillDir, 'SKILL.md');
  writeFileSync(skillFile, '# Fixture skill\n\nRead-only evidence fixture.\n');
  writeFileSync(join(skillDir, 'reference.md'), 'Supporting reference.\n');
  const fingerprint = fingerprintSkill(skillDir);

  const secretFile = join(root, 'secret.txt');
  writeFileSync(secretFile, `${FIXTURE_SECRET}\n`);
  const inputFile = join(root, 'input.json');
  writeFileSync(inputFile, '{"pin":1}\n');

  const started = new Date(Date.now() - 120_000).toISOString();
  const finished = new Date(Date.now() - 60_000).toISOString();
  const secret = options.secret === false ? '' : ` ${FIXTURE_SECRET}`;

  const assignment = {
    schema: 'harness-collab/assignment/1',
    task_id: 'c3-task',
    assignment_id: `c3-${options.harness}`,
    attempt: 1,
    objective: 'Derive native capability evidence.',
    acceptance: ['evidence is derived read-only'],
    roles: ['implementer'],
    coordinator: {
      agent_id: 'coordinator',
      session_id: 'coordinator-session',
      harness: 'codex',
      owner_epoch: 1,
    },
    assignee: {
      ...AGENT,
      harness: options.harness,
      cwd,
    },
    inputs: [{ ref: inputFile, digest: digest('{"pin":1}\n') }],
    resources: [{ path: cwd, access: 'write', resource_epoch: 1 }],
    runner: {
      name: 'existing-session',
      mode: 'native-session',
      omitted_capabilities: [],
    },
    required: {
      skills:
        options.harness === 'codex'
          ? []
          : [{ id: 'fixture-skill', bundle_digest: fingerprint.bundle_digest }],
      tools:
        options.harness === 'pi'
          ? ['read', 'bash']
          : options.harness === 'codex'
            ? ['shell']
            : ['Read'],
    },
    preferred: { skills: [], tools: [] },
  };

  const toolIds =
    options.harness === 'pi'
      ? ['read', 'bash']
      : options.harness === 'codex'
        ? ['shell']
        : ['Read', 'Skill'];
  const template = {
    schema: 'harness-collab/capabilities/1',
    ...AGENT,
    harness: options.harness,
    cwd,
    observed_at: finished,
    evidence_level: 'declared',
    skills: [
      {
        id: 'fixture-skill',
        state: 'declared',
        path: skillFile,
        bundle_digest: fingerprint.bundle_digest,
        native_name: 'fixture-skill',
      },
    ],
    tools: toolIds.map((id) => ({ id, state: 'declared' })),
  };

  const sessionFile = join(root, 'session.jsonl');
  const eventsFile = join(root, 'events.jsonl');
  const executionFile = join(root, 'execution.json');

  if (options.harness === 'pi') {
    const base = Date.now() - 60_000;
    const messages: unknown[] = [
      {
        type: 'session',
        id: 'worker-session',
        cwd,
        timestamp: new Date(base).toISOString(),
        version: '1.3.0',
      },
      {
        type: 'message',
        id: 'm0',
        parentId: null,
        timestamp: new Date(base - 3000).toISOString(),
        message: { role: 'system', content: `System prompt${secret}` },
      },
      {
        type: 'message',
        id: 'm1',
        parentId: 'm0',
        timestamp: new Date(base - 2000).toISOString(),
        message: {
          role: 'assistant',
          timestamp: base - 2000,
          model: 'fixture-model',
          provider: 'fixture-provider',
          stopReason: 'toolUse',
          usage: { input: 1, output: 2 },
          content: [
            {
              type: 'toolCall',
              id: 'call-read',
              name: 'read',
              arguments: {
                path: 'skills/fixture-skill/SKILL.md',
                note: secret,
              },
            },
            {
              type: 'toolCall',
              id: 'call-bash',
              name: 'bash',
              arguments: { command: `echo ok${secret}` },
            },
          ],
        },
      },
      {
        type: 'message',
        id: 'm2',
        parentId: 'm1',
        timestamp: new Date(base - 1500).toISOString(),
        message: {
          role: 'toolResult',
          toolCallId: 'call-read',
          toolName: 'read',
          isError: false,
          timestamp: base - 1500,
          content: [],
        },
      },
      {
        type: 'message',
        id: 'm3',
        parentId: 'm2',
        timestamp: new Date(base - 1000).toISOString(),
        message: {
          role: 'toolResult',
          toolCallId: 'call-bash',
          toolName: 'bash',
          isError: false,
          timestamp: base - 1000,
          content: [],
        },
      },
      {
        type: 'message',
        id: 'm4',
        parentId: 'm3',
        timestamp: new Date(base).toISOString(),
        message: {
          role: 'assistant',
          timestamp: base,
          model: 'fixture-model',
          provider: 'fixture-provider',
          stopReason: 'stop',
          usage: { input: 3, output: 4 },
          content: [{ type: 'text', text: 'done' }],
        },
      },
    ];
    writeFileSync(
      sessionFile,
      `${messages.map((row) => JSON.stringify(row)).join('\n')}\n`,
    );
    writeJson(executionFile, {
      status: 'exited',
      exit_code: 0,
      started_at: started,
      finished_at: finished,
      native_evidence: sessionFile,
      phase: 'bootstrap',
      tool_allowlist: ['read', 'bash'],
      project_trust: 'trusted',
    });
  } else if (options.harness === 'codex') {
    const rows = [
      { type: 'thread.started', thread_id: 'worker-session' },
      { type: 'turn.started' },
      {
        type: 'item.completed',
        item: {
          id: 'item_0',
          type: 'command_execution',
          command: `echo ok${secret}`,
          status: 'completed',
          exit_code: 0,
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'agent_message',
          text: `done${secret}`,
        },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    ];
    writeFileSync(
      eventsFile,
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    );
    writeJson(executionFile, {
      status: 'exited',
      exit_code: 0,
      started_at: started,
      finished_at: finished,
      events_file: eventsFile,
      cwd,
      sandbox: 'read-only',
    });
  } else {
    const rows = [
      {
        type: 'system',
        subtype: 'init',
        session_id: 'worker-session',
        cwd,
        tools: ['Read', 'Skill'],
        skills: ['fixture-skill'],
        slash_commands: [],
        model: 'fixture-claude',
      },
      {
        type: 'assistant',
        session_id: 'worker-session',
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'skill-1',
              name: 'Skill',
              input: { skill: 'fixture-skill', marker: secret },
            },
          ],
        },
      },
      {
        type: 'user',
        session_id: 'worker-session',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'skill-1' }],
        },
      },
      {
        type: 'user',
        session_id: 'worker-session',
        parent_tool_use_id: null,
        isSynthetic: true,
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Base directory for this skill: ${skillDir}\n# Fixture skill`,
            },
          ],
        },
      },
      {
        type: 'assistant',
        session_id: 'worker-session',
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'read-1',
              name: 'Read',
              input: { file_path: skillFile, marker: secret },
            },
          ],
        },
      },
      {
        type: 'user',
        session_id: 'worker-session',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'read-1' }],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'worker-session',
      },
    ];
    writeFileSync(
      eventsFile,
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    );
    writeJson(executionFile, {
      status: 'exited',
      exit_code: 0,
      started_at: started,
      finished_at: finished,
      phase: 'discovery',
    });
  }

  const assignmentFile = join(root, 'assignment.json');
  const templateFile = join(root, 'template.json');
  writeJson(assignmentFile, assignment);
  writeJson(templateFile, template);

  return {
    root,
    cwd,
    harness: options.harness,
    assignmentFile,
    templateFile,
    executionFile,
    sessionFile,
    eventsFile,
    secretFile,
    skillDir,
    skillFile,
    bundleDigest: fingerprint.bundle_digest,
    assignment,
    template,
  };
}

/** Rewrite the JSONL evidence file, preserving the exact JSON shape. */
export function writeRows(file: string, rows: readonly unknown[]): void {
  writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}
