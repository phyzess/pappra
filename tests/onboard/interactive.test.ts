import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { planOnboard } from '../../src/app/onboard.js';
import { runOnboardCommand } from '../../src/cli/commands/onboard.js';
import { runAgentSetup } from '../../src/cli/commands/setup-flow.js';
import {
  silentProgress,
  type SelectOption,
  type WizardUi,
} from '../../src/cli/interactive.js';
import { executableOnPath } from '../../src/hosts/detect.js';
import { parseInitChoices } from '../../src/schemas/init.js';
import {
  baseMachineConfig,
  baseWorkspaceConfig,
  cleanup,
  createRepository,
  makeTempDir,
  writeMachineConfig,
  writeText,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';

interface UiCall {
  readonly kind: 'select' | 'confirm' | 'multiselect' | 'text';
  readonly message: string;
  readonly options?: readonly SelectOption[];
  readonly initialValue?: string | boolean;
  readonly initialValues?: readonly string[];
}

/** Records every surface and answers only the prompts a test queued. */
class RecordingUi implements WizardUi {
  readonly intros: string[] = [];
  readonly outros: string[] = [];
  readonly notes: { readonly title: string; readonly message: string }[] = [];
  readonly cancels: string[] = [];
  readonly calls: UiCall[] = [];
  readonly #select: (string | symbol)[];
  readonly #text: (string | symbol)[];
  readonly #multiselect: (readonly string[] | symbol)[];
  readonly #confirm: (boolean | symbol)[];

  constructor(
    queues: {
      readonly select?: readonly (string | symbol)[];
      readonly text?: readonly (string | symbol)[];
      readonly multiselect?: readonly (readonly string[] | symbol)[];
      readonly confirm?: readonly (boolean | symbol)[];
    } = {},
  ) {
    this.#select = [...(queues.select ?? [])];
    this.#text = [...(queues.text ?? [])];
    this.#multiselect = [...(queues.multiselect ?? [])];
    this.#confirm = [...(queues.confirm ?? [])];
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
    this.calls.push({ kind: 'select', message });
    assert(options.length > 0, `select without options: ${message}`);
    void initialValue;
    const next = this.#select.shift();
    if (next === undefined)
      throw new Error(`No fake select answer: ${message}`);
    return next;
  }

  async multiselect(
    message: string,
    options: readonly SelectOption[],
    initialValues?: readonly string[],
  ): Promise<readonly string[] | symbol> {
    this.calls.push({
      kind: 'multiselect',
      message,
      options,
      ...(initialValues === undefined ? {} : { initialValues }),
    });
    const next = this.#multiselect.shift();
    if (next === undefined)
      throw new Error(`No fake multiselect answer: ${message}`);
    return next;
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
      name: 'onboard fixture',
      repositories: [{ id: 'app', path: '.', access: 'write' }],
    }),
  );
  writeMachineConfig(root, baseMachineConfig(root, { selectedHosts: [] }));
  return root;
}

test('an interactive onboard of a configured workspace runs the guided setup', async () => {
  const root = workspaceFixture('onboard-guided');
  const io = sink();
  const ui = new RecordingUi();
  const previousPath = process.env['PATH'];
  process.env['PATH'] = '';
  try {
    const code = await runOnboardCommand(
      {
        cwd: root,
        root: null,
        configPath: null,
        hosts: null,
        apply: false,
        applyHosts: false,
        dryRun: false,
        printHandoff: false,
        json: false,
        interactive: true,
      },
      io.write,
      { ui, progress: silentProgress },
    );
    assert.equal(code, 0);
    assert.match(ui.intros[0] ?? '', /Repositories: app \(\.\)/);
    assert.match(
      io.stdout.join(''),
      /No supported coding agent was detected on PATH/,
    );
    assert.match(io.stdout.join(''), /Health: /);
    assert.equal(ui.outros.at(-1), 'Setup complete.');
  } finally {
    if (previousPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previousPath;
    cleanup(root);
  }
});

test('an interactive onboard without a workspace starts the guided setup', async () => {
  const root = makeTempDir('onboard-guided-new');
  const io = sink();
  const ui = new RecordingUi({
    text: ['onboard fixture'],
    select: [Symbol('cancel')],
  });
  try {
    const code = await runOnboardCommand(
      {
        cwd: root,
        root: null,
        configPath: null,
        hosts: null,
        apply: false,
        applyHosts: false,
        dryRun: false,
        printHandoff: false,
        json: false,
        interactive: true,
      },
      io.write,
      { ui, progress: silentProgress },
    );
    assert.equal(code, 0);
    assert.deepEqual(ui.intros, ['Welcome to Pappra']);
    assert.deepEqual(ui.cancels, ['Init cancelled; no files were written.']);
    assert.equal(ui.outros.at(-1), 'Setup cancelled.');
  } finally {
    cleanup(root);
  }
});

test('a non-interactive onboard plan keeps its flags contract and names the repository id', async () => {
  const root = makeTempDir('onboard-plan');
  const io = sink();
  const ui = new RecordingUi();
  const previousPath = process.env['PATH'];
  try {
    createRepository(root);
    writeText(join(root, 'AGENTS.md'), '# agents\n');
    const choicesPath = join(root, 'choices.json');
    const choices = {
      schema: 'pappra/init-choices/1',
      name: 'onboard plan fixture',
      repositories: [{ path: '.', access: 'read' }],
      knowledge: {
        sources: [],
        newDocuments: '.pappra/knowledge',
        taskVisibility: 'private',
      },
      code: { graph: 'codegraph', symbols: 'auto', prepare: 'on-demand' },
      validation: [],
      excludes: [],
      hosts: [],
    };
    writeFileSync(choicesPath, `${JSON.stringify(choices)}\n`);
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const git = executableOnPath('git', process.env['PATH'] ?? '');
    assert(git !== null);
    symlinkSync(git, join(bin, 'git'));
    process.env['PATH'] = bin;

    const parsed = parseInitChoices(
      JSON.parse(readFileSync(choicesPath, 'utf8')),
      choicesPath,
    );
    assert(parsed.value !== null);
    const planned = await planOnboard({
      root,
      choices: parsed.value,
      hosts: null,
      pathEnv: bin,
    });
    assert(!('reason' in planned));
    const expectedId = planned.bundle.scope.repositories[0]?.id;
    assert(expectedId !== undefined);

    const code = await runOnboardCommand(
      {
        cwd: root,
        root: null,
        configPath: choicesPath,
        hosts: null,
        apply: false,
        applyHosts: false,
        dryRun: false,
        printHandoff: false,
        json: true,
        interactive: false,
      },
      io.write,
      { ui, progress: silentProgress },
    );
    assert.equal(code, 0);
    const report = JSON.parse(io.stdout.join('')) as {
      readonly dryRun: boolean;
      readonly nextActions: readonly string[];
    };
    assert.equal(report.dryRun, true);
    assert(
      report.nextActions.includes(
        `pappra code prepare --repo ${expectedId} --apply`,
      ),
      report.nextActions.join(' | '),
    );
    assert.deepEqual(ui.calls, []);
  } finally {
    if (previousPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previousPath;
    cleanup(root);
  }
});

test('the agent step preselects verified hosts and wires only the chosen one', async () => {
  const root = makeTempDir('onboard-agents');
  const io = sink();
  const ui = new RecordingUi({
    confirm: [true, false],
    multiselect: [['codex']],
  });
  const previousPath = process.env['PATH'];
  const previousCodexHome = process.env['CODEX_HOME'];
  const codexHome = join(root, 'codex-home');
  try {
    createRepository(root);
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const git = executableOnPath('git', process.env['PATH'] ?? '');
    assert(git !== null);
    symlinkSync(git, join(bin, 'git'));
    const codex = join(bin, 'codex');
    writeFileSync(
      codex,
      `#!${process.execPath}\nprocess.stdout.write('0.163.0\\n');\n`,
    );
    chmodSync(codex, 0o755);
    process.env['PATH'] = bin;
    process.env['CODEX_HOME'] = codexHome;

    const result = await runAgentSetup(root, ui, silentProgress, io.write);
    assert.equal(result.failed, false);
    const multi = ui.calls.find((call) => call.kind === 'multiselect');
    assert(multi !== undefined);
    assert.deepEqual(multi.initialValues, ['codex']);
    assert.deepEqual(
      multi.options?.map((option) => option.value),
      ['claude', 'codex', 'pi'],
    );
    assert.deepEqual(
      multi.options?.map((option) => option.hint),
      ['not installed', 'verified 0.163.0', 'not installed'],
    );
    assert(
      result.manualSteps.some((step) =>
        step.includes('Approve the Pappra hook'),
      ),
      result.manualSteps.join(' | '),
    );
    assert.equal(existsSync(join(codexHome, 'hooks.json')), true);
    assert.equal(existsSync(join(root, '.claude')), false);
  } finally {
    if (previousPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previousPath;
    if (previousCodexHome === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = previousCodexHome;
    cleanup(root);
  }
});
