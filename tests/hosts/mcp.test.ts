import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyHostMcp,
  planHostMcp,
  verifyHostMcp,
} from '../../src/app/host-mcp.js';

function temp(): string {
  return mkdtempSync(join(tmpdir(), 'pappra-host-mcp-'));
}

test('claude and pi mcp registration merges without dropping other servers', async () => {
  const root = temp();
  try {
    writeFileSync(
      join(root, '.mcp.json'),
      `${JSON.stringify({
        mcpServers: { other: { command: 'other-server' } },
      })}\n`,
    );
    const claude = await planHostMcp('claude', root);
    assert.equal(claude.state, 'create');
    const applied = await applyHostMcp(claude, { force: false });
    assert.equal(applied.applied, true);
    assert.equal(applied.verified, true);
    const config = JSON.parse(
      readFileSync(join(root, '.mcp.json'), 'utf8'),
    ) as Record<string, unknown>;
    const servers = config.mcpServers as Record<string, unknown>;
    assert.deepEqual(servers.other, { command: 'other-server' });
    assert.deepEqual(servers.pappra, { command: 'pappra', args: ['mcp'] });
    const repeated = await planHostMcp('claude', root);
    assert.equal(repeated.state, 'unchanged');

    const pi = await planHostMcp('pi', root);
    assert.equal(pi.state, 'create');
    const piApplied = await applyHostMcp(pi, { force: false });
    assert.equal(piApplied.verified, true);
    assert.equal(existsSync(join(root, '.pi/mcp.json')), true);
    const verified = await verifyHostMcp(pi);
    assert.equal(verified.verified, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mcp registration reports a conflict instead of overwriting a different entry', async () => {
  const root = temp();
  try {
    writeFileSync(
      join(root, '.mcp.json'),
      `${JSON.stringify({
        mcpServers: { pappra: { command: 'different', args: [] } },
      })}\n`,
    );
    const plan = await planHostMcp('claude', root);
    assert.equal(plan.state, 'conflict');
    const refused = await applyHostMcp(plan, { force: false });
    assert.equal(refused.applied, false);
    const forced = await applyHostMcp(plan, { force: true });
    assert.equal(forced.applied, true);
    assert.equal(forced.verified, true);

    const codex = await planHostMcp('codex', root);
    assert.equal(codex.state, 'manual');
    assert.deepEqual(codex.command, [
      'codex',
      'mcp',
      'add',
      'pappra',
      '--',
      'pappra',
      'mcp',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
