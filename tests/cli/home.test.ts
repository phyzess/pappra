import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runHomeCommand } from '../../src/cli/commands/home.js';
import {
  silentProgress,
  type SelectOption,
  type WizardUi,
} from '../../src/cli/interactive.js';
import {
  baseMachineConfig,
  baseWorkspaceConfig,
  cleanup,
  createRepository,
  makeTempDir,
  writeMachineConfig,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';

interface UiCall {
  readonly kind: 'select' | 'confirm' | 'multiselect' | 'text';
  readonly message: string;
  readonly initialValue?: string | boolean;
}

/** Records every surface and answers only the prompts a test queued. */
class RecordingUi implements WizardUi {
  readonly intros: string[] = [];
  readonly outros: string[] = [];
  readonly notes: { readonly title: string; readonly message: string }[] = [];
  readonly cancels: string[] = [];
  readonly calls: UiCall[] = [];
  readonly #select: (string | symbol)[];
  readonly #confirm: (boolean | symbol)[];
  readonly #text: (string | symbol)[];

  constructor(
    queues: {
      readonly select?: readonly (string | symbol)[];
      readonly confirm?: readonly (boolean | symbol)[];
      readonly text?: readonly (string | symbol)[];
    } = {},
  ) {
    this.#select = [...(queues.select ?? [])];
    this.#confirm = [...(queues.confirm ?? [])];
    this.#text = [...(queues.text ?? [])];
  }

  intro(message: string): void {
    this.intros.push(message);
  }

  outro(message: string): void {
    this.outros.push(message);
  }

  note(message: string, title: string): void {
    this.notes.push({ title, message });
  }

  async text(message: string): Promise<string | symbol> {
    this.calls.push({ kind: 'text', message });
    const next = this.#text.shift();
    if (next === undefined) throw new Error(`No fake text answer: ${message}`);
    return next;
  }

  async select(
    message: string,
    options: readonly SelectOption[],
    initialValue?: string,
  ): Promise<string | symbol> {
    this.calls.push({
      kind: 'select',
      message,
      ...(initialValue === undefined ? {} : { initialValue }),
    });
    assert(options.length > 0, `select without options: ${message}`);
    const next = this.#select.shift();
    if (next === undefined)
      throw new Error(`No fake select answer: ${message}`);
    return next;
  }

  async multiselect(message: string): Promise<readonly string[] | symbol> {
    this.calls.push({ kind: 'multiselect', message });
    throw new Error(`Unexpected multiselect prompt: ${message}`);
  }

  async confirm(
    message: string,
    initialValue?: boolean,
  ): Promise<boolean | symbol> {
    this.calls.push({
      kind: 'confirm',
      message,
      ...(initialValue === undefined ? {} : { initialValue }),
    });
    const next = this.#confirm.shift();
    if (next === undefined)
      throw new Error(`No fake confirm answer: ${message}`);
    return next;
  }

  cancel(message: string): void {
    this.cancels.push(message);
  }
}

function sink(): { stdout: string[]; stderr: string[]; write: CliSink } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    write: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
  };
}

interface CliSink {
  stdout(text: string): void;
  stderr(text: string): void;
}

function workspaceFixture(label: string): string {
  const root = makeTempDir(label);
  createRepository(root);
  writeWorkspaceConfig(
    root,
    baseWorkspaceConfig({
      name: 'home fixture',
      repositories: [{ id: 'app', path: '.', access: 'write' }],
      knowledge: {
        sources: [],
        newDocuments: '.pappra/knowledge',
        taskVisibility: 'private',
      },
    }),
  );
  writeMachineConfig(root, baseMachineConfig(root, { selectedHosts: [] }));
  return root;
}

test('a directory without a workspace starts the guided setup', async () => {
  const root = makeTempDir('home-welcome');
  const io = sink();
  const ui = new RecordingUi({
    text: ['home fixture'],
    select: [Symbol('cancel')],
  });
  try {
    const code = await runHomeCommand({ cwd: root }, io.write, {
      ui,
      progress: silentProgress,
    });
    assert.equal(code, 0);
    assert.deepEqual(ui.intros, ['Welcome to Pappra']);
    assert.deepEqual(
      ui.calls.map((call) => call.message),
      ['Workspace name', 'Section navigation'],
      'the interactive init collected its first choices',
    );
    assert.deepEqual(ui.cancels, ['Init cancelled; no files were written.']);
    assert.equal(ui.outros.at(-1), 'Setup cancelled.');
    assert.equal(existsSync(join(root, '.pappra', 'workspace.json')), false);
  } finally {
    cleanup(root);
  }
});

test('an existing workspace prints its status and offers the action menu', async () => {
  const root = workspaceFixture('home-menu');
  const io = sink();
  const ui = new RecordingUi({ select: ['agents', 'exit'] });
  const previousPath = process.env['PATH'];
  process.env['PATH'] = '';
  try {
    const code = await runHomeCommand({ cwd: root }, io.write, {
      ui,
      progress: silentProgress,
    });
    assert.equal(code, 0);
    const status = ui.intros[0] ?? '';
    assert.match(status, /Root: /);
    assert.match(status, /Repositories: app \(\.\)/);
    assert.match(status, /Runtime: not bound/);
    assert.match(
      io.stdout.join(''),
      /No supported coding agent was detected on PATH/,
    );
    assert.equal(ui.calls[0]?.message, 'What would you like to do?');
    assert.equal(ui.outros.at(-1), 'Done.');
  } finally {
    if (previousPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previousPath;
    cleanup(root);
  }
});

test('the menu forwards reconfigure to the interactive init and then exits', async () => {
  const root = workspaceFixture('home-reconfigure');
  const io = sink();
  const ui = new RecordingUi({
    text: ['home fixture'],
    select: ['reconfigure', Symbol('cancel'), 'exit'],
  });
  try {
    const code = await runHomeCommand({ cwd: root }, io.write, {
      ui,
      progress: silentProgress,
    });
    assert.equal(code, 0);
    assert.equal(ui.calls[2]?.message, 'Section navigation');
    assert.deepEqual(ui.cancels, ['Init cancelled; no files were written.']);
    assert.match(io.stderr.join(''), /Init cancelled; no files were written/);
    assert.equal(ui.outros.at(-1), 'Done.');
  } finally {
    cleanup(root);
  }
});
