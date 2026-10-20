import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
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

async function connect(root: string) {
  const server = createPappraMcpServer({ root });
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
      assert.equal(refused.status, 'confirmation_required');

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

test('collab_start refuses without confirmation and never launches', async () => {
  const root = makeTempDir('mcp-collab');
  try {
    createRepository(root);
    writeWorkspaceConfig(root, baseWorkspaceConfig());
    writeMachineConfig(root, baseMachineConfig(root));
    const { client, server } = await connect(root);
    try {
      const refused = textPayload(
        await client.callTool({
          name: 'collab_start',
          arguments: {
            prepared: join(root, 'missing-prepared.json'),
            capabilities: join(root, 'missing-card.json'),
            controller: 'fixture',
            confirm: false,
          },
        }),
      );
      assert.equal(refused.ok, false);
      assert.equal(refused.status, 'confirmation_required');
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    cleanup(root);
  }
});
