import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
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

const packageRoot = dirname(
  fileURLToPath(import.meta.resolve('@phyzess/pappra/package.json')),
);
const cli = join(packageRoot, 'dist/cli/main.js');

function invoke(
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 120_000,
    env: { ...process.env, ...environment },
  });
  if (result.error) throw result.error;
  return result;
}

function parse(stdout: string): Record<string, unknown> {
  const value: unknown = JSON.parse(stdout);
  assert(typeof value === 'object' && value !== null);
  return value as Record<string, unknown>;
}

test('codex user scope installs into CODEX_HOME and preserves existing hooks', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'pappra-host-user-scope-'));
  const workspace = join(temporary, 'workspace');
  const codexHome = join(temporary, 'codex-home');
  mkdirSync(workspace);
  mkdirSync(codexHome);
  writeFileSync(
    join(codexHome, 'hooks.json'),
    `${JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: "sh -c 'echo control'",
                  timeout: 5,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
  const environment = { CODEX_HOME: codexHome };
  try {
    const installed = invoke(
      [
        'host',
        'install',
        '--host',
        'codex',
        '--scope',
        'user',
        '--host-version',
        '0.163.0',
        '--apply',
        '--json',
      ],
      workspace,
      environment,
    );
    assert.equal(installed.status, 0, installed.stderr);
    const value = parse(installed.stdout);
    assert.equal(value.status, 'applied');
    assert.equal(
      Array.isArray(value.appliedFiles) &&
        (value.appliedFiles as readonly string[]).includes('hooks.json'),
      true,
    );
    assert.equal(existsSync(join(codexHome, 'hooks', 'pappra-hook.mjs')), true);
    const merged = readFileSync(join(codexHome, 'hooks.json'), 'utf8');
    assert(merged.includes('pappra-managed'));
    assert(merged.includes("sh -c 'echo control'"));

    const verified = invoke(
      [
        'host',
        'verify',
        '--host',
        'codex',
        '--scope',
        'user',
        '--host-version',
        '0.163.0',
        '--json',
      ],
      workspace,
      environment,
    );
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(parse(verified.stdout).status, 'verified');

    const wrongHost = invoke(
      [
        'host',
        'install',
        '--host',
        'claude',
        '--scope',
        'user',
        '--host-version',
        '2.1.292',
        '--apply',
        '--json',
      ],
      workspace,
      environment,
    );
    assert.equal(wrongHost.status, 2);

    const wrongRoot = invoke(
      [
        'host',
        'plan',
        '--host',
        'codex',
        '--scope',
        'user',
        '--host-root',
        '.codex',
        '--host-version',
        '0.163.0',
        '--json',
      ],
      workspace,
      environment,
    );
    assert.equal(wrongRoot.status, 2);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
