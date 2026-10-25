import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../../src/cli/run.js';

interface CapturedOutput {
  readonly stdout: string;
  readonly stderr: string;
}

function capture(): {
  readonly output: {
    stdout: (text: string) => void;
    stderr: (text: string) => void;
  };
  readonly read: () => CapturedOutput;
} {
  let stdout = '';
  let stderr = '';
  return {
    output: {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
    read: () => ({ stdout, stderr }),
  };
}

async function invoke(args: readonly string[]): Promise<{
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const captured = capture();
  const status = await runCli(args, captured.output);
  return { status, ...captured.read() };
}

const modulesDir = join(process.cwd(), 'src/cli/collaboration-routing');
const routerFile = join(process.cwd(), 'src/cli/collaboration-router.ts');

const familyModules = readdirSync(modulesDir)
  .filter((name) => name.endsWith('.ts'))
  .sort();

const source = (file: string) => readFileSync(join(modulesDir, file), 'utf8');

test('the router stays a selector and never keeps family validation', () => {
  const router = readFileSync(routerFile, 'utf8');
  assert.ok(
    router.split('\n').length < 160,
    `router grew back into a monolith (${router.split('\n').length} lines)`,
  );
  // Every family owns its own guard rails; the router must not carry them.
  for (const marker of [
    'runCollaborationStateCommand',
    'runCollaborationHandoffCommand',
    'runCollaborationBindingCommand',
    'runCollaborationPlanCommand',
    'runCollaborationMessageCommand',
    'runCollaborationBootstrapCommand',
    'runCollaborationPreflightCommand',
    'duplicate option(s)',
  ])
    assert.equal(
      router.includes(marker),
      false,
      `router still contains family logic: ${marker}`,
    );
  assert.match(router, /handleDirectRun\(context\)/);
});

test('each command family is its own module with explicit handlers', () => {
  const expected = [
    'context.ts',
    'execution.ts',
    'handoff.ts',
    'help.ts',
    'messages.ts',
    'native.ts',
    'resources.ts',
    'routing.ts',
    'state.ts',
  ];
  assert.deepEqual(familyModules, expected);
  for (const file of expected) {
    const text = source(file);
    if (file === 'context.ts') {
      assert.match(text, /export interface RoutingContext/);
      continue;
    }
    assert.match(
      text,
      /export async function handle[A-Z][A-Za-z]*\(/,
      `${file} exports no handler`,
    );
    // A family handler must never reach back into the selector or the CLI bootstrap.
    assert.equal(
      /from '\.\.\/run\.js'|from '\.\/collaboration-router\.js'|from '\.\.\/collaboration-router\.js'/.test(
        text,
      ),
      false,
      `${file} imports the router or run.js`,
    );
  }
});

test('handler selection keeps the original precedence for a shared prefix', async () => {
  // `state:show --help` must narrow to the state usage, not the generic collab usage.
  const state = await invoke(['collab', 'state:show', '--help']);
  assert.equal(state.status, 0, state.stderr);
  assert.match(state.stdout, /task-root/);
  assert.doesNotMatch(state.stdout, /pappra collab <prepare\|run\|/);

  // `transition:apply --help` stays pinned to the transition family.
  const transition = await invoke(['collab', 'transition:apply', '--help']);
  assert.equal(transition.status, 0, transition.stderr);
  assert.match(transition.stdout, /transition/i);

  // The JSON envelope is still `{...info, commands:['collab'], usage}`.
  const json = await invoke(['collab', 'binding:list', '--help', '--json']);
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout) as {
    commands: string[];
    usage: string;
  };
  assert.deepEqual(parsed.commands, ['collab']);
  assert.equal(typeof parsed.usage, 'string');
});

test('family guards still refuse foreign and duplicate flags at the boundary', async () => {
  const foreign = await invoke([
    'collab',
    'state:show',
    '--request',
    '/nope.json',
  ]);
  assert.equal(foreign.status, 2);
  assert.match(foreign.stderr, /collab state accepts only/);

  const duplicate = await invoke([
    'collab',
    'resource:list',
    '--task-root',
    '/a',
    '--task-root=/b',
  ]);
  assert.equal(duplicate.status, 2);
  assert.match(duplicate.stderr, /Duplicate/);

  const unknown = await invoke(['collab', 'nonsense-action']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /collab requires prepare\/run\/query/);
});
