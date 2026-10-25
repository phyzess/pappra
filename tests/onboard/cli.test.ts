import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRepository } from '../workspace/fixtures.js';
import { executableOnPath } from '../../src/hosts/detect.js';
import { HOST_EVENT_VERSIONS } from '../../src/hosts/integration/support.js';
import type { HostName } from '../../src/schemas/host.js';
import type { OnboardHostResult } from '../../src/app/onboard.js';

const cli = fileURLToPath(new URL('../../src/cli/main.js', import.meta.url));

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
  readonly bin: string;
  readonly calls: string;
  readonly env: NodeJS.ProcessEnv;
}

function fixture(
  versions: Partial<Record<HostName, string | null>> = {},
): Fixture {
  const temporary = mkdtempSync(join(tmpdir(), 'pappra-onboard-'));
  const workspace = join(temporary, 'workspace');
  const bin = join(temporary, 'bin');
  mkdirSync(workspace);
  mkdirSync(bin);
  const git = executableOnPath('git', process.env['PATH'] ?? '');
  assert(git);
  symlinkSync(git, join(bin, 'git'));
  const calls = join(temporary, 'native-calls.jsonl');
  createRepository(workspace);
  writeFileSync(join(workspace, 'AGENTS.md'), '# agents\n');
  for (const [name, version] of [
    ['claude', '2.1.292'],
    ['codex', '0.163.0'],
    ['pi', '1.3.0'],
  ] as const) {
    const selected = name in versions ? versions[name] : version;
    if (selected === null) continue;
    const file = join(bin, name);
    writeFileSync(
      file,
      `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({host: ${JSON.stringify(name)}, args: process.argv.slice(2)}) + '\\n');\nprocess.stdout.write(${JSON.stringify(`${selected}\n`)});\n`,
    );
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
  const home = join(temporary, 'home');
  mkdirSync(home);
  return {
    temporary,
    workspace,
    dataDir,
    choices,
    bin,
    calls,
    env: {
      PATH: bin,
      HOME: home,
      CODEX_HOME: join(temporary, 'codex-home'),
      CLAUDE_CONFIG_DIR: join(temporary, 'claude-home'),
      PI_CODING_AGENT_DIR: join(temporary, 'pi-home'),
      XDG_CONFIG_HOME: join(temporary, 'config'),
      XDG_DATA_HOME: join(temporary, 'xdg-data'),
      PAPPRA_DATA_HOME: dataDir,
      npm_config_offline: 'true',
    },
  };
}

function onboard(box: Fixture, host: HostName, flags: readonly string[]) {
  return invoke(
    [
      'onboard',
      '--root',
      box.workspace,
      '--config',
      box.choices,
      '--hosts',
      host,
      ...flags,
      '--json',
    ],
    box.workspace,
    box.env,
  );
}

function hostResult(stdout: string): OnboardHostResult {
  const hosts = parse(stdout).hosts as OnboardHostResult[];
  assert.equal(hosts.length, 1);
  return hosts[0]!;
}

function assertVersionOnly(box: Fixture): void {
  const calls = readFileSync(box.calls, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { args: string[] });
  assert(calls.length > 0);
  for (const call of calls) assert.deepEqual(call.args, ['--version']);
}

for (const host of ['claude', 'codex', 'pi'] as const) {
  for (const version of HOST_EVENT_VERSIONS[host]) {
    test(`onboard actual CLI plans and wires observed ${host} ${version} without native trust`, () => {
      const box = fixture({ [host]: version });
      try {
        const planned = onboard(box, host, ['--dry-run']);
        assert.equal(planned.status, 0, planned.stderr);
        const plan = hostResult(planned.stdout);
        assert.equal(plan.state, 'verified');
        assert.equal(plan.detectedVersion, version);
        assert.equal(plan.action, 'planned');
        assert.equal(existsSync(join(box.workspace, '.pappra')), false);
        const applied = onboard(box, host, ['--yes', '--apply-host']);
        assert.equal(applied.status, 0, applied.stderr + applied.stdout);
        const result = hostResult(applied.stdout);
        assert.equal(result.state, 'verified');
        assert.equal(result.detectedVersion, version);
        assert.equal(result.action, 'installed');
        assert(result.appliedFiles.length > 0);
        assert.match(result.nextActions.join(' '), /trust|Approve|Reload/);
        const target =
          host === 'claude'
            ? join(box.workspace, '.claude/settings.json')
            : host === 'codex'
              ? join(box.env.CODEX_HOME!, 'hooks.json')
              : join(box.workspace, '.pappra/host-bundles/pi/package.json');
        assert.equal(existsSync(target), true, target);
        assertVersionOnly(box);
      } finally {
        rmSync(box.temporary, { recursive: true, force: true });
      }
    });
  }
}

for (const host of ['claude', 'codex', 'pi'] as const) {
  for (const version of ['99.99.99', 'version-unavailable', null] as const) {
    test(`onboard actual CLI skips ${host} ${version ?? 'missing'} with truthful guidance`, () => {
      const box = fixture({ [host]: version });
      try {
        const planned = onboard(box, host, ['--dry-run']);
        assert.equal(planned.status, 0, planned.stderr);
        const plan = hostResult(planned.stdout);
        assert.equal(
          plan.state,
          version === null
            ? 'missing'
            : version === 'version-unavailable'
              ? 'unverified'
              : 'unsupported',
        );
        assert.equal(plan.action, 'skipped');
        assert.equal(
          plan.detectedVersion,
          version === '99.99.99' ? version : null,
        );
        assert.doesNotMatch(
          plan.nextActions.join(' '),
          /Rerun with --apply-host|host install/,
        );
        assert.match(
          plan.nextActions.join(' '),
          /supported version|manual checkpoint/,
        );
        assert.equal(existsSync(join(box.workspace, '.pappra')), false);
        for (const flags of [['--yes'], ['--yes', '--apply-host']]) {
          const applied = onboard(box, host, flags);
          assert.equal(applied.status, 0, applied.stderr + applied.stdout);
          const result = hostResult(applied.stdout);
          assert.equal(result.action, 'skipped');
          assert.deepEqual(result.appliedFiles, []);
          assert.equal(existsSync(join(box.workspace, '.claude')), false);
          assert.equal(existsSync(box.env.CODEX_HOME!), false);
          assert.equal(
            existsSync(join(box.workspace, '.pappra/host-bundles/pi')),
            false,
          );
        }
        if (version !== null) assertVersionOnly(box);
      } finally {
        rmSync(box.temporary, { recursive: true, force: true });
      }
    });
  }
}

test('onboard refuses unobserved patch versions rather than inferring support from a minor match', () => {
  for (const [host, version] of [
    ['claude', '2.1.999'],
    ['codex', '0.164.999'],
    ['pi', '1.4.999'],
  ] as const) {
    const box = fixture({ [host]: version });
    try {
      const result = onboard(box, host, ['--dry-run']);
      assert.equal(result.status, 0, result.stderr);
      const plan = hostResult(result.stdout);
      assert.equal(plan.state, 'unsupported');
      assert.equal(plan.action, 'skipped');
    } finally {
      rmSync(box.temporary, { recursive: true, force: true });
    }
  }
});

test('onboard re-probes the installed version before host writes and Pi export', () => {
  for (const host of ['claude', 'codex', 'pi'] as const) {
    const box = fixture();
    try {
      const counter = join(box.temporary, 'version-count');
      const version = HOST_EVENT_VERSIONS[host][0];
      writeFileSync(
        join(box.bin, host),
        `#!${process.execPath}\nconst fs = require('node:fs'); const file = ${JSON.stringify(counter)}; const count = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0; fs.writeFileSync(file, String(count + 1)); process.stdout.write(count === 0 ? ${JSON.stringify(version + '\n')} : '99.99.99\\n');\n`,
      );
      const applied = onboard(box, host, ['--yes', '--apply-host']);
      assert.equal(applied.status, 0, applied.stderr + applied.stdout);
      const result = hostResult(applied.stdout);
      assert.equal(result.state, 'unsupported');
      assert.equal(result.detectedVersion, '99.99.99');
      assert.equal(result.action, 'skipped');
      assert.deepEqual(result.appliedFiles, []);
      assert.equal(existsSync(join(box.workspace, '.claude')), false);
      assert.equal(existsSync(box.env.CODEX_HOME!), false);
      assert.equal(
        existsSync(join(box.workspace, '.pappra/host-bundles/pi')),
        false,
      );
      assert.equal(readFileSync(counter, 'utf8'), '2');
    } finally {
      rmSync(box.temporary, { recursive: true, force: true });
    }
  }
});

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
