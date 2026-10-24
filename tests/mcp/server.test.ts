import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPappraMcpServer } from '../../src/mcp/server.js';
import {
  baseMachineConfig,
  baseWorkspaceConfig,
  cleanup,
  createRepository,
  makeTempDir,
  writeMachineConfig,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';

import type { Assignment, CapabilityCard } from '../../src/collab/contracts.js';
import { preflight } from '../../src/collab/preflight.js';

async function connect(root: string, allowWorkspaceWrites = true) {
  const server = createPappraMcpServer({ root, allowWorkspaceWrites });
  const client = new Client({ name: 'pappra-test', version: '0.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, server };
}

function textPayload(result: unknown): Record<string, unknown> {
  assert(typeof result === 'object' && result !== null);
  const content = (result as { content?: unknown }).content;
  assert(Array.isArray(content) && content.length > 0);
  const first: unknown = content[0];
  assert(typeof first === 'object' && first !== null && 'text' in first);
  const text = (first as { text?: unknown }).text;
  assert(typeof text === 'string');
  const value: unknown = JSON.parse(text);
  assert(typeof value === 'object' && value !== null);
  return value as Record<string, unknown>;
}

test('mcp lists the read-only tool set and answers workspace_status', async () => {
  const root = makeTempDir('mcp-server');
  try {
    createRepository(root);
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        repositories: [{ id: 'app', path: '.', access: 'write' }],
        knowledge: {
          sources: ['AGENTS.md'],
          newDocuments: '.pappra/knowledge',
          taskVisibility: 'private',
        },
      }),
    );
    writeMachineConfig(root, baseMachineConfig(root));
    writeFileSync(join(root, 'AGENTS.md'), '# agents\n');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/index.ts'), 'export const a = 1;\n');

    const { client, server } = await connect(root);
    try {
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
        'checkpoint',
        'code_prepare',
        'code_query',
        'code_status',
        'collab_prepare',
        'collab_start',
        'docs_check',
        'docs_list',
        'docs_scan',
        'resume',
        'runtime_install',
        'runtime_status',
        'workspace_status',
      ]);
      const readOnly = new Set([
        'workspace_status',
        'resume',
        'docs_list',
        'docs_check',
        'code_status',
        'code_query',
        'runtime_status',
        'collab_start',
        'runtime_install',
        'code_prepare',
      ]);
      for (const tool of tools.tools) {
        assert.equal(
          tool.annotations?.readOnlyHint,
          readOnly.has(tool.name),
          tool.name,
        );
      }
      const status = textPayload(
        await client.callTool({ name: 'workspace_status', arguments: {} }),
      );
      assert.equal(status.workspaceRoot, root);
      assert.equal(
        (status.config as Record<string, unknown>).name,
        baseWorkspaceConfig().name,
      );
      assert.deepEqual(
        (status.config as Record<string, unknown>).knowledgeSources,
        ['AGENTS.md'],
      );
      const docs = textPayload(
        await client.callTool({
          name: 'docs_list',
          arguments: { includePrivate: true },
        }),
      );
      assert.equal(docs.ok, true);
      assert.deepEqual(docs.documents, []);
      const runtime = textPayload(
        await client.callTool({ name: 'runtime_status', arguments: {} }),
      );
      assert.equal(runtime.binding, null);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanup(root);
  }
});

test('mcp tools report typed failures instead of throwing', async () => {
  const root = makeTempDir('mcp-failure');
  try {
    createRepository(root);
    writeWorkspaceConfig(root, baseWorkspaceConfig());
    writeMachineConfig(root, baseMachineConfig(root));
    const { client, server } = await connect(root);
    try {
      const missing = textPayload(
        await client.callTool({
          name: 'resume',
          arguments: { task: 'does-not-exist' },
        }),
      );
      assert.equal(missing.ok, false);
      const code = textPayload(
        await client.callTool({
          name: 'code_status',
          arguments: { repo: 'missing-repo' },
        }),
      );
      assert.equal(code.ok, false);
      assert.equal(
        (code.health as Record<string, unknown>).state,
        'unsupported',
      );
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanup(root);
  }
});

test('tool apply flags cannot enable the default read-only server policy', async () => {
  const root = makeTempDir('mcp-server-policy');
  try {
    const { client, server } = await connect(root, false);
    try {
      for (const [name, arguments_] of [
        [
          'checkpoint',
          { task: 'task', objective: 'untrusted apply', apply: true },
        ],
        ['docs_scan', { apply: true }],
        ['code_prepare', { repo: 'app', apply: true }],
        ['runtime_install', { from: 'self', apply: true }],
        [
          'collab_prepare',
          {
            domainRoot: join(root, 'outside-domain'),
            goal: explicitGoal(root),
          },
        ],
      ] as const) {
        const result = textPayload(
          await client.callTool({ name, arguments: arguments_ }),
        );
        assert.equal(result.status, 'cli_required', name);
      }
      const tools = await client.listTools();
      assert(
        tools.tools.every((tool) => tool.annotations?.readOnlyHint === true),
      );
      assert.equal(existsSync(join(root, '.pappra')), false);
      assert.equal(existsSync(join(root, 'outside-domain')), false);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanup(root);
  }
});

test('trusted workspace-write policy never allows arbitrary collaboration paths or package execution', async () => {
  const root = makeTempDir('mcp-write-scope');
  const outside = makeTempDir('mcp-outside-scope');
  try {
    createRepository(root);
    writeWorkspaceConfig(root, baseWorkspaceConfig());
    writeMachineConfig(root, baseMachineConfig(root));
    const { client, server } = await connect(root, true);
    try {
      const refused = textPayload(
        await client.callTool({
          name: 'collab_prepare',
          arguments: {
            domainRoot: join(outside, 'domain'),
            goal: explicitGoal(root),
          },
        }),
      );
      assert.equal(refused.status, 'scope_refused');
      assert.equal(existsSync(join(outside, 'domain')), false);
      for (const [name, args] of [
        ['runtime_install', { from: 'self', apply: true }],
        ['code_prepare', { repo: 'app', apply: true }],
      ] as const) {
        assert.equal(
          textPayload(await client.callTool({ name, arguments: args })).status,
          'cli_required',
        );
      }
      const outsideGoal = explicitGoal(root, { cwd: outside });
      assert.equal(
        textPayload(
          await client.callTool({
            name: 'collab_prepare',
            arguments: { domainRoot: mcpDomain(root), goal: outsideGoal },
          }),
        ).status,
        'scope_refused',
      );
      assert.equal(domainHasTasks(root), false);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test('code_query exposes text results and output budget reasons over MCP', async () => {
  const root = makeTempDir('mcp-code-query');
  try {
    createRepository(root);
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        repositories: [{ id: 'app', path: '.', access: 'write' }],
      }),
    );
    writeMachineConfig(root, baseMachineConfig(root));
    writeFileSync(join(root, 'needle.ts'), 'export const uniqueNeedle = 1;\n');
    const { client, server } = await connect(root);
    try {
      const query = { repo: 'app', kind: 'text', query: 'uniqueNeedle' };
      const found = textPayload(
        await client.callTool({ name: 'code_query', arguments: query }),
      );
      assert.equal(found.ok, true);
      assert.equal(found.provider, 'text');
      assert.equal((found.items as { path: string }[])[0]?.path, 'needle.ts');
      const bounded = textPayload(
        await client.callTool({
          name: 'code_query',
          arguments: { ...query, maxBytes: 1 },
        }),
      );
      assert.equal(bounded.ok, true);
      assert.deepEqual(bounded.items, []);
      assert.equal(bounded.truncated, true);
      assert((bounded.reasons as string[]).includes('output_budget'));
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanup(root);
  }
});

test('mcp write tools require apply and then persist', async () => {
  const root = makeTempDir('mcp-write');
  try {
    createRepository(root);
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        repositories: [{ id: 'app', path: '.', access: 'write' }],
        knowledge: {
          sources: ['AGENTS.md'],
          newDocuments: '.pappra/knowledge',
          taskVisibility: 'private',
        },
      }),
    );
    writeMachineConfig(root, baseMachineConfig(root));
    writeFileSync(join(root, 'AGENTS.md'), '# agents\n');
    const { client, server } = await connect(root);
    try {
      const refused = textPayload(
        await client.callTool({
          name: 'checkpoint',
          arguments: { task: 'mcp-task', objective: 'via mcp', apply: false },
        }),
      );
      assert.equal(refused.status, 'preview');

      const saved = textPayload(
        await client.callTool({
          name: 'checkpoint',
          arguments: {
            task: 'mcp-task',
            objective: 'via mcp',
            acceptance: ['the tool persisted the checkpoint'],
            nextActions: ['review resume'],
            contextCompleteness: 'complete',
            authorSession: 'mcp-test',
            apply: true,
          },
        }),
      );
      assert.equal(saved.ok, true);
      assert.equal(saved.status, 'saved');

      const resumed = textPayload(
        await client.callTool({
          name: 'resume',
          arguments: { task: 'mcp-task', session: 'mcp-test' },
        }),
      );
      assert.equal(resumed.ok, true);
      assert.equal(
        (resumed.packet as Record<string, unknown>).executionAllowed,
        false,
      );

      const scanned = textPayload(
        await client.callTool({
          name: 'docs_scan',
          arguments: { apply: true },
        }),
      );
      assert.equal(scanned.ok, true);
      assert.equal((scanned.registered as unknown[]).length, 1);

      const listed = textPayload(
        await client.callTool({
          name: 'docs_list',
          arguments: { includePrivate: true },
        }),
      );
      assert.equal((listed.documents as unknown[]).length, 1);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanup(root);
  }
});

test('docs_scan preserves incomplete coverage in MCP results', async () => {
  const root = makeTempDir('mcp-docs-scan-incomplete');
  try {
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        knowledge: {
          sources: ['AGENTS.md', 'missing'],
          newDocuments: '.pappra/knowledge',
          taskVisibility: 'private',
        },
      }),
    );
    writeMachineConfig(root, baseMachineConfig(root));
    writeFileSync(join(root, 'AGENTS.md'), '# agents\n');
    const { client, server } = await connect(root);
    try {
      const scanned = textPayload(
        await client.callTool({
          name: 'docs_scan',
          arguments: { apply: true },
        }),
      );
      assert.equal(scanned.ok, false);
      assert.equal((scanned.registered as unknown[]).length, 1);
      assert.equal(
        (scanned.diagnostics as Array<{ code: string }>).some(
          (diagnostic) => diagnostic.code === 'knowledge_source_missing',
        ),
        true,
      );
      assert.equal(
        (scanned.nextActions as string[]).some((action) =>
          action.includes('pappra docs list --include-private'),
        ),
        true,
      );
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanup(root);
  }
});

test('collab_start refuses even agent-supplied confirmation and never launches', async () => {
  const root = makeTempDir('mcp-collab');
  try {
    createRepository(root);
    writeWorkspaceConfig(root, baseWorkspaceConfig());
    writeMachineConfig(root, baseMachineConfig(root));
    const { client, server } = await connect(root);
    try {
      for (const confirm of [false, true]) {
        const refused = textPayload(
          await client.callTool({
            name: 'collab_start',
            arguments: {
              prepared: join(root, 'missing-prepared.json'),
              capabilities: join(root, 'missing-card.json'),
              controller: 'fixture',
              confirm,
            },
          }),
        );
        assert.equal(refused.ok, false);
        assert.equal(refused.status, 'cli_required');
      }
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanup(root);
  }
});

function explicitGoal(
  root: string,
  overrides: {
    readonly harness?: string;
    readonly cwd?: string;
    readonly roles?: string[];
    readonly taskId?: string;
  } = {},
) {
  const goal: Record<string, unknown> = {
    schema: 'pappra/collaboration-goal/1',
    task_id: overrides.taskId ?? 'mcp-goal',
    subtask_id: 'work',
    attempt: 1,
    phase: 'fix',
    objective: 'Prepare one bounded collaboration slice from MCP.',
    acceptance: ['prepared references verify'],
    prompt: 'Use only the frozen prompt.',
    coordinator: {
      agent_id: 'coord-mcp',
      session_id: 'coord-session',
      harness: 'codex',
      owner_epoch: 2,
    },
    assignee: {
      agent_id: 'worker-mcp',
      session_id: 'worker-session',
      harness: overrides.harness ?? 'pi',
      surface: 'cli',
      configuration_id: 'custom-config',
      cwd: overrides.cwd ?? join(root, 'assignee-cwd'),
    },
    resources: [{ path: join(root, 'slice.txt'), access: 'write' }],
    required: { skills: [], tools: ['read'] },
    preferred: { skills: [], tools: [] },
    ...(overrides.roles === undefined ? {} : { roles: overrides.roles }),
  };
  return goal;
}

function mcpDomain(root: string): string {
  return join(root, '.pappra', 'local', 'collaboration', 'domain');
}

function domainHasTasks(root: string): boolean {
  return existsSync(join(mcpDomain(root), 'tasks'));
}

test('runtime_install rejects arbitrary sources and version overrides before mutation', async () => {
  const root = makeTempDir('mcp-runtime-source');
  const { client, server } = await connect(root);
  try {
    for (const args of [
      { from: 'tarball', tarball: join(root, 'payload.tgz') },
      { from: 'version', version: '9.9.9' },
      { from: 'self', version: '9.9.9' },
      { from: 'self', tarball: join(root, 'payload.tgz') },
    ]) {
      const text = await refusalText(
        client.callTool({
          name: 'runtime_install',
          arguments: { ...args, apply: true },
        }),
      );
      assert.match(text, /runtime_install/);
    }
    assert.equal(existsSync(join(root, '.pappra')), false);
    const preview = textPayload(
      await client.callTool({
        name: 'runtime_install',
        arguments: { from: 'self', apply: false },
      }),
    );
    assert.equal(preview.from, 'self');
    assert.equal(preview.status, 'cli_required');
  } finally {
    await client.close();
    await server.close();
    cleanup(root);
  }
});

async function refusalText(call: Promise<unknown>): Promise<string> {
  const result = (await call) as {
    content?: { text?: string }[];
    isError?: boolean;
  };
  assert.equal(result.isError, true);
  return result.content?.[0]?.text ?? '';
}

test('collab_prepare builds explicit goal bundles without synthesizing cards', async () => {
  const root = makeTempDir('mcp-prepare');
  try {
    createRepository(root);
    writeWorkspaceConfig(root, baseWorkspaceConfig());
    writeMachineConfig(root, baseMachineConfig(root));
    const cwd = join(root, 'assignee-cwd');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(root, 'slice.txt'), 'first file resource\n');
    const { client, server } = await connect(root);
    try {
      const prepared = textPayload(
        await client.callTool({
          name: 'collab_prepare',
          arguments: {
            domainRoot: join(mcpDomain(root)),
            goal: explicitGoal(root, { roles: ['reviewer', 'implementer'] }),
          },
        }),
      );
      assert.equal(prepared.ok, true);
      assert.equal(prepared.cardPath, undefined);
      assert.equal(prepared.card, undefined);
      const bundle = prepared.prepared as Record<string, unknown>;
      const goal = prepared.goal as Record<string, unknown>;
      assert.equal(goal.task_id, 'mcp-goal');
      const assignment = JSON.parse(
        readFileSync(bundle.assignment_path as string, 'utf8'),
      ) as Record<string, unknown>;
      assert.deepEqual(assignment.roles, ['reviewer', 'implementer']);
      assert.deepEqual(goal.roles, ['reviewer', 'implementer']);
      assert.deepEqual(assignment.required, { skills: [], tools: ['read'] });
      assert.deepEqual(assignment.preferred, { skills: [], tools: [] });
      const coordinator = assignment.coordinator as Record<string, unknown>;
      assert.equal(coordinator.agent_id, 'coord-mcp');
      assert.equal(coordinator.session_id, 'coord-session');
      assert.equal(coordinator.harness, 'codex');
      assert.equal(coordinator.owner_epoch, 2);
      const assignee = assignment.assignee as Record<string, unknown>;
      assert.equal(assignee.agent_id, 'worker-mcp');
      assert.equal(assignee.session_id, 'worker-session');
      assert.equal(assignee.harness, 'pi');
      assert.equal(assignee.surface, 'cli');
      assert.equal(assignee.configuration_id, 'custom-config');
      assert.equal(assignee.cwd, cwd);
      const runner = assignment.runner as Record<string, unknown>;
      assert.equal(runner.name, 'pi-cli');
      assert.equal(runner.mode, 'native');
      const resources = assignment.resources as Record<string, unknown>[];
      assert.equal(resources[0]?.path, join(root, 'slice.txt'));
      assert.equal(typeof resources[0]?.resource_epoch, 'number');
      assert.equal(
        readdirSync(bundle.prepared_dir as string).some((name) =>
          name.startsWith('card.declared'),
        ),
        false,
      );

      const declaredCard = {
        schema: 'harness-collab/capabilities/1',
        agent_id: 'worker-mcp',
        session_id: 'worker-session',
        harness: 'pi',
        surface: 'cli',
        configuration_id: 'custom-config',
        cwd,
        observed_at: new Date().toISOString(),
        evidence_level: 'declared',
        skills: [],
        tools: [],
      } as unknown as CapabilityCard;
      const check = preflight(
        assignment as unknown as Assignment,
        declaredCard,
      );
      assert.equal(check.status, 'needs_input');
      assert(
        check.blockers.some(
          (entry) => entry.code === 'runtime_capabilities_unconfirmed',
        ),
      );
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanup(root);
  }
});

test('collab_prepare refuses legacy and unknown input before any write', async () => {
  const root = makeTempDir('mcp-prepare-legacy');
  try {
    createRepository(root);
    writeWorkspaceConfig(root, baseWorkspaceConfig());
    writeMachineConfig(root, baseMachineConfig(root));
    writeFileSync(join(root, 'slice.txt'), 'first file resource\n');
    const { client, server } = await connect(root);
    try {
      const legacy = await refusalText(
        client.callTool({
          name: 'collab_prepare',
          arguments: {
            domainRoot: join(mcpDomain(root)),
            objective: 'via mcp',
            task: 'mcp-goal',
            acceptance: ['prepared references verify'],
            resources: [{ path: root, access: 'write' }],
            coordinatorSession: 'coord-session',
            assigneeSession: 'worker-session',
            harness: 'pi',
          },
        }),
      );
      assert.match(legacy, /collab_prepare/);
      assert.match(legacy, /Unrecognized keys/);
      const mixed = await refusalText(
        client.callTool({
          name: 'collab_prepare',
          arguments: {
            domainRoot: join(mcpDomain(root)),
            goal: explicitGoal(root),
            objective: 'legacy leftover',
          },
        }),
      );
      assert.match(mixed, /Unrecognized key: "objective"/);
      const unknownField = await refusalText(
        client.callTool({
          name: 'collab_prepare',
          arguments: {
            domainRoot: join(mcpDomain(root)),
            goal: { ...explicitGoal(root), extra: true },
          },
        }),
      );
      assert.match(unknownField, /"extra" at goal/);
      const missing = await refusalText(
        client.callTool({
          name: 'collab_prepare',
          arguments: { domainRoot: join(mcpDomain(root)) },
        }),
      );
      assert.match(missing, /expected object, received undefined at goal/);
      assert.equal(domainHasTasks(root), false);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanup(root);
  }
});

test('collab_prepare maps supported runners and refuses invalid metadata without artifacts', async () => {
  const root = makeTempDir('mcp-prepare-runners');
  try {
    createRepository(root);
    writeWorkspaceConfig(root, baseWorkspaceConfig());
    writeMachineConfig(root, baseMachineConfig(root));
    mkdirSync(join(root, 'assignee-cwd'), { recursive: true });
    writeFileSync(join(root, 'slice.txt'), 'first file resource\n');
    const { client, server } = await connect(root);
    try {
      const expected = new Map([
        ['pi', 'pi-cli'],
        ['codex', 'codex-exec'],
        ['claude', 'claude-cli'],
      ]);
      for (const [harness, runner] of expected) {
        const prepared = textPayload(
          await client.callTool({
            name: 'collab_prepare',
            arguments: {
              domainRoot: join(mcpDomain(root)),
              goal: explicitGoal(root, { harness, taskId: `mcp-${harness}` }),
            },
          }),
        );
        assert.equal(prepared.ok, true, harness);
        const bundle = prepared.prepared as Record<string, unknown>;
        const assignment = JSON.parse(
          readFileSync(bundle.assignment_path as string, 'utf8'),
        ) as Record<string, unknown>;
        assert.equal(
          (assignment.runner as Record<string, unknown>).name,
          runner,
          harness,
        );
        assert.deepEqual(assignment.roles, ['implementer']);
      }

      const tasksBeforeInvalid = readdirSync(
        join(mcpDomain(root), 'tasks'),
      ).sort();
      for (const [index, harness] of [
        'gemini',
        'constructor',
        'toString',
        '__proto__',
      ].entries()) {
        const unsupported = textPayload(
          await client.callTool({
            name: 'collab_prepare',
            arguments: {
              domainRoot: join(mcpDomain(root)),
              goal: explicitGoal(root, {
                harness,
                taskId: `mcp-unsupported-${index}`,
              }),
            },
          }),
        );
        assert.equal(unsupported.ok, false, harness);
        assert.equal(unsupported.code, 'assignee_harness_unsupported', harness);
      }
      assert.deepEqual(
        readdirSync(join(mcpDomain(root), 'tasks')).sort(),
        tasksBeforeInvalid,
      );
      const missingCwd = textPayload(
        await client.callTool({
          name: 'collab_prepare',
          arguments: {
            domainRoot: join(mcpDomain(root)),
            goal: explicitGoal(root, {
              cwd: join(root, 'missing-directory'),
              taskId: 'mcp-missing-cwd',
            }),
          },
        }),
      );
      assert.equal(missingCwd.ok, false);
      assert.equal(missingCwd.code, 'cwd_unavailable');

      const fileCwd = textPayload(
        await client.callTool({
          name: 'collab_prepare',
          arguments: {
            domainRoot: join(mcpDomain(root)),
            goal: explicitGoal(root, {
              cwd: join(root, 'slice.txt'),
              taskId: 'mcp-file-cwd',
            }),
          },
        }),
      );
      assert.equal(fileCwd.ok, false);
      assert.equal(fileCwd.code, 'cwd_unavailable');

      const duplicateRoles = await refusalText(
        client.callTool({
          name: 'collab_prepare',
          arguments: {
            domainRoot: join(mcpDomain(root)),
            goal: explicitGoal(root, {
              roles: ['implementer', 'implementer'],
              taskId: 'mcp-duplicate-roles',
            }),
          },
        }),
      );
      assert.match(duplicateRoles, /roles must be unique/);
      const emptyRoles = await refusalText(
        client.callTool({
          name: 'collab_prepare',
          arguments: {
            domainRoot: join(mcpDomain(root)),
            goal: explicitGoal(root, { roles: [], taskId: 'mcp-empty-roles' }),
          },
        }),
      );
      assert.match(emptyRoles, /goal\.roles/);
      assert.equal(domainHasTasks(root), true);
      const tasks = readdirSync(join(mcpDomain(root), 'tasks'));
      assert.deepEqual(tasks.sort(), ['mcp-claude', 'mcp-codex', 'mcp-pi']);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanup(root);
  }
});

test('collab_start refuses a real controller on a foreign harness without launching', async () => {
  const root = makeTempDir('mcp-prepare-controller');
  try {
    createRepository(root);
    writeWorkspaceConfig(root, baseWorkspaceConfig());
    writeMachineConfig(root, baseMachineConfig(root));
    mkdirSync(join(root, 'assignee-cwd'), { recursive: true });
    writeFileSync(join(root, 'slice.txt'), 'first file resource\n');
    const { client, server } = await connect(root);
    try {
      const prepared = textPayload(
        await client.callTool({
          name: 'collab_prepare',
          arguments: {
            domainRoot: join(mcpDomain(root)),
            goal: explicitGoal(root, { harness: 'codex' }),
          },
        }),
      );
      assert.equal(prepared.ok, true);
      const bundle = prepared.prepared as Record<string, unknown>;
      const refused = textPayload(
        await client.callTool({
          name: 'collab_start',
          arguments: {
            prepared: join(bundle.prepared_dir as string, 'prepared.json'),
            capabilities: join(root, 'card.json'),
            controller: 'pi-rpc',
            confirm: true,
          },
        }),
      );
      assert.equal(refused.ok, false);
      assert.equal(refused.status, 'cli_required');
      const record = JSON.parse(
        readFileSync(join(bundle.task_root as string, 'task.json'), 'utf8'),
      ) as Record<string, unknown>;
      assert.equal(record.launch_reservations, undefined);
      assert.equal(existsSync(join(root, 'card.json')), false);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanup(root);
  }
});
