import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRepository } from '../workspace/fixtures.js';

const root = dirname(
  fileURLToPath(import.meta.resolve('@phyzess/pappra/package.json')),
);
const cli = join(root, 'dist/cli/main.js');

function invoke(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 300_000,
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  return result;
}

function parse(stdout: string): Record<string, unknown> {
  const value: unknown = JSON.parse(stdout);
  assert(typeof value === 'object' && value !== null);
  return value as Record<string, unknown>;
}

interface Fixture {
  readonly temporary: string;
  readonly workspace: string;
  readonly dataDir: string;
  readonly choices: string;
  readonly env: NodeJS.ProcessEnv;
}

function fixture(): Fixture {
  const temporary = mkdtempSync(join(tmpdir(), 'pappra-onboard-'));
  const workspace = join(temporary, 'workspace');
  const bin = join(temporary, 'bin');
  mkdirSync(workspace);
  mkdirSync(bin);
  createRepository(workspace);
  writeFileSync(join(workspace, 'AGENTS.md'), '# agents\n');
  for (const [name, version] of [
    ['claude', '2.1.292'],
    ['codex', '0.163.0'],
    ['pi', '1.3.0'],
  ] as const) {
    const file = join(bin, name);
    writeFileSync(file, `#!/bin/sh\necho "${version}"\n`);
    chmodSync(file, 0o755);
  }
  const choices = join(temporary, 'choices.json');
  writeFileSync(
    choices,
    `${JSON.stringify({
      schema: 'pappra/init-choices/1',
      name: 'onboard fixture',
      repositories: [],
      knowledge: {
        sources: ['AGENTS.md'],
        newDocuments: '.pappra/knowledge',
        taskVisibility: 'private',
      },
      code: { graph: 'none', symbols: 'auto', prepare: 'on-demand' },
      validation: [],
      excludes: [],
      hosts: [],
    })}\n`,
  );
  const dataDir = join(temporary, 'data');
  return {
    temporary,
    workspace,
    dataDir,
    choices,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      PAPPRA_DATA_HOME: dataDir,
    },
  };
}

test('onboard plans without writing and prints the handoff matrix', () => {
  const box = fixture();
  try {
    const handoff = invoke(
      ['onboard', '--print-handoff', '--json'],
      box.workspace,
      box.env,
    );
    assert.equal(handoff.status, 0, handoff.stderr);
    const report = parse(handoff.stdout);
    assert.equal(report.schema, 'pappra/handoff/1');
    assert(
      (report.share as readonly string[]).includes('.pappra/workspace.json'),
    );
    assert(
      (report.doNotCopy as readonly string[]).includes(
        '.pappra/local/machine.json',
      ),
    );

    const planned = invoke(
      [
        'onboard',
        '--root',
        box.workspace,
        '--config',
        box.choices,
        '--hosts',
        'claude,codex,pi',
        '--dry-run',
        '--json',
      ],
      box.workspace,
      box.env,
    );
    assert.equal(planned.status, 0, planned.stderr);
    const value = parse(planned.stdout);
    assert.equal(value.dryRun, true);
    assert.equal(value.initComplete, false);
    assert.deepEqual(
      (value.files as readonly Record<string, unknown>[]).map(
        (file) => file.path,
      ),
      ['.pappra/workspace.json', '.pappra/local/machine.json'],
    );
    const hosts = value.hosts as readonly Record<string, unknown>[];
    assert.deepEqual(
      hosts.map((host) => [host.host, host.state, host.action]),
      [
        ['claude', 'verified', 'planned'],
        ['codex', 'verified', 'planned'],
        ['pi', 'verified', 'planned'],
      ],
    );
    assert.equal(existsSync(join(box.workspace, '.pappra')), false);
  } finally {
    rmSync(box.temporary, { recursive: true, force: true });
  }
});

test('onboard applies config, runtime and a verified host idempotently', () => {
  const box = fixture();
  try {
    const applied = invoke(
      [
        'onboard',
        '--root',
        box.workspace,
        '--config',
        box.choices,
        '--hosts',
        'claude',
        '--yes',
        '--apply-host',
        '--json',
      ],
      box.workspace,
      box.env,
    );
    assert.equal(applied.status, 0, applied.stderr);
    const value = parse(applied.stdout);
    assert.equal(value.ok, true);
    assert.equal(value.initComplete, true);
    assert.equal(
      existsSync(join(box.workspace, '.pappra/workspace.json')),
      true,
    );
    assert.equal(
      existsSync(join(box.workspace, '.pappra/local/machine.json')),
      true,
    );
    assert.equal(
      existsSync(join(box.workspace, '.claude/settings.json')),
      true,
    );
    assert.equal(
      existsSync(join(box.workspace, '.claude/hooks/pappra-hook.mjs')),
      true,
    );
    const hooks = readFileSync(
      join(box.workspace, '.claude/settings.json'),
      'utf8',
    );
    assert(hooks.includes('pappra-managed'));
    const hosts = value.hosts as readonly Record<string, unknown>[];
    assert.equal(hosts[0]?.action, 'installed');

    const repeated = invoke(
      [
        'onboard',
        '--root',
        box.workspace,
        '--config',
        box.choices,
        '--hosts',
        'claude',
        '--yes',
        '--apply-host',
        '--json',
      ],
      box.workspace,
      box.env,
    );
    assert.equal(repeated.status, 0, repeated.stderr);
    const repeatedValue = parse(repeated.stdout);
    assert.deepEqual(repeatedValue.files, []);
    assert.equal(
      (repeatedValue.hosts as readonly Record<string, unknown>[])[0]?.action,
      'unchanged',
    );
  } finally {
    rmSync(box.temporary, { recursive: true, force: true });
  }
});
