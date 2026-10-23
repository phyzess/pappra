import assert from 'node:assert/strict';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  collectInitChoices,
  runInitCommand,
} from '../../src/cli/commands/init.js';
import {
  deriveCommonInitDefaults,
  deriveInitChoices,
  inspectInitContext,
  existingInitChoices,
  planWorkspaceInit,
} from '../../src/app/init.js';
import { parseInitChoices } from '../../src/schemas/init.js';
import {
  baseMachineConfig,
  baseWorkspaceConfig,
  cleanup,
  createRepository,
  makeTempDir,
  snapshotTree,
  writeJson,
  writeText,
  writeMachineConfig,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';
import { getPackageInfo } from '../../src/package-info.js';
import { runtimePaths } from '../../src/install/runtime.js';
import { FakeWizardUi, baseInitChoices } from './fixtures.js';

const repositoryPath = 'projects/one/two/three/explicit-repo';
const repositoryAction = '../__pappra_add_existing_repository_action__';
const knowledgeAction = '../__pappra_add_existing_knowledge_action__';
const runtimeVersion = '0.1.0-dev.0';
function createUnboundValidationWorkspace(
  root: string,
): ReturnType<typeof baseWorkspaceConfig> {
  createRepository(root);
  const config = baseWorkspaceConfig({
    name: 'existing',
    repositories: [{ id: 'app', path: '.', access: 'write' }],
    knowledge: {
      sources: [],
      newDocuments: '.pappra/knowledge',
      taskVisibility: 'private',
    },
    validation: [
      {
        id: 'custom',
        repositoryId: 'app',
        executable: 'echo',
        args: ['custom'],
      },
    ],
  });
  writeWorkspaceConfig(root, config);
  writeMachineConfig(root, baseMachineConfig(root, { selectedHosts: [] }));
  return config;
}

test('cancelling the wizard leaves the workspace byte-identical', async () => {
  const root = makeTempDir('init-wizard-cancel');
  try {
    createRepository(root);
    writeText(join(root, 'README.md'), '# readme\n');
    const contextResult = await inspectInitContext(root);
    assert.equal(contextResult.ok, true);
    if (!contextResult.ok) return;
    const before = snapshotTree(root);
    const ui = new FakeWizardUi({ text: [Symbol('cancel')] });
    const choices = await collectInitChoices(contextResult.context, ui);
    assert.equal(choices, null);
    assert.equal(ui.cancelled.length, 1);
    assert.deepEqual(snapshotTree(root), before);
  } finally {
    cleanup(root);
  }
});

test('interactive selections round-trip through config input and produce the same scope', async () => {
  const root = makeTempDir('init-wizard-single');
  try {
    createRepository(root);
    writeText(join(root, 'README.md'), '# readme\n');
    writeJson(join(root, 'package.json'), {
      name: 'fixture',
      scripts: { test: 'echo test' },
    });
    writeText(join(root, 'pnpm-lock.yaml'), '');
    const contextResult = await inspectInitContext(root);
    assert.equal(contextResult.ok, true);
    if (!contextResult.ok) return;
    const before = snapshotTree(root);
    const ui = new FakeWizardUi({
      multiselect: [['.'], ['README.md'], []],
      select: [
        'next',
        'write',
        'next',
        'private',
        'next',
        'skip',
        'continue',
        'continue',
      ],
      text: ['wizard workspace', '.pappra/knowledge'],
    });
    const choices = await collectInitChoices(contextResult.context, ui);
    assert(choices !== null);
    if (choices === null) return;
    assert.deepEqual(choices.repositories, [{ path: '.', access: 'write' }]);
    assert.deepEqual(choices.knowledge.sources, ['README.md']);
    assert.equal(choices.name, 'wizard workspace');

    const wizardPlan = await planWorkspaceInit({
      root,
      choices,
      runtimeVersion: '0.1.0-dev.0',
    });
    assert.equal(wizardPlan.ok, true);
    if (!wizardPlan.ok) return;
    const parsedChoices = parseInitChoices(
      JSON.parse(JSON.stringify(choices)),
      'choices.json',
    );
    assert(parsedChoices.value !== null);
    if (parsedChoices.value === null) return;
    const configPlan = await planWorkspaceInit({
      root,
      choices: parsedChoices.value,
      runtimeVersion: '0.1.0-dev.0',
    });
    assert.equal(configPlan.ok, true);
    if (!configPlan.ok) return;
    assert.deepEqual(
      configPlan.bundle.scope.repositories,
      wizardPlan.bundle.scope.repositories,
    );
    assert.deepEqual(
      configPlan.bundle.scope.knowledge,
      wizardPlan.bundle.scope.knowledge,
    );
    assert.deepEqual(
      configPlan.bundle.scope.code,
      wizardPlan.bundle.scope.code,
    );
    assert.deepEqual(
      configPlan.bundle.scope.validation,
      wizardPlan.bundle.scope.validation,
    );
    assert.deepEqual(
      configPlan.bundle.scope.hosts,
      wizardPlan.bundle.scope.hosts,
    );
    assert.deepEqual(
      configPlan.bundle.scope.excludes,
      wizardPlan.bundle.scope.excludes,
    );
    assert.deepEqual(
      configPlan.bundle.plan.files.map((file) => file.path),
      wizardPlan.bundle.plan.files.map((file) => file.path),
    );
    assert.deepEqual(snapshotTree(root), before);
  } finally {
    cleanup(root);
  }
});

test('existing configuration asks only for missing hosts', async () => {
  const root = makeTempDir('init-wizard-existing');
  try {
    createRepository(root);
    writeWorkspaceConfig(
      root,
      baseWorkspaceConfig({
        name: 'existing',
        repositories: [{ id: 'app', path: '.', access: 'write' }],
      }),
    );
    const contextResult = await inspectInitContext(root);
    assert.equal(contextResult.ok, true);
    if (!contextResult.ok) return;
    const ui = new FakeWizardUi({ multiselect: [['codex']] });
    const choices = await collectInitChoices(contextResult.context, ui);
    assert(choices !== null);
    if (choices === null) return;
    assert.deepEqual(
      ui.calls.map((call) => call.kind),
      ['multiselect'],
    );
    const hostPrompt = ui.calls[0];
    assert(hostPrompt !== undefined);
    assert.equal(hostPrompt.message.includes('P03'), false);
    assert.equal(hostPrompt.message.includes('declaration only'), true);
    assert.equal(
      hostPrompt.options.every((option) =>
        option.hint?.includes('not detected or verified'),
      ),
      true,
    );
    assert.deepEqual(choices.hosts, ['codex']);
    const prepared = await planWorkspaceInit({
      root,
      context: contextResult.context,
      choices,
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.deepEqual(
      prepared.bundle.plan.files.map((file) => file.path),
      ['.pappra/local/machine.json'],
    );
  } finally {
    cleanup(root);
  }
});

test('declining the interactive apply confirmation writes nothing', async () => {
  const root = makeTempDir('init-wizard-decline');
  const previousDataHome = process.env.PAPPRA_DATA_HOME;
  try {
    createRepository(root);
    writeText(join(root, 'README.md'), '# readme\n');
    const before = snapshotTree(root);
    const dataHome = join(root, 'isolated-data');
    process.env.PAPPRA_DATA_HOME = dataHome;
    const ui = new FakeWizardUi({
      multiselect: [['.'], ['README.md'], []],
      select: [
        'next',
        'write',
        'next',
        'private',
        'next',
        'skip',
        'continue',
        'continue',
      ],
      text: ['declined workspace', '.pappra/knowledge'],
      confirm: [false],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runInitCommand(
      { cwd: root, configPath: null, apply: false, json: false },
      {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      },
      { interactive: true, ui },
    );
    assert.equal(code, 130);
    assert(stdout.join('').includes('Pappra init plan'));
    const confirmation = ui.calls.find((call) => call.kind === 'confirm');
    assert(confirmation !== undefined);
    assert(confirmation.message.includes('current package'));
    assert(
      confirmation.message.includes(
        runtimePaths(getPackageInfo().version, dataHome).runtimeRoot,
      ),
    );
    assert(
      confirmation.message.toLowerCase().includes('knowledge registration'),
    );
    assert.equal(existsSync(dataHome), false);
    assert(stderr.join('').includes('no files were written'));
    assert.deepEqual(snapshotTree(root), before);
  } finally {
    if (previousDataHome === undefined) {
      delete process.env.PAPPRA_DATA_HOME;
    } else {
      process.env.PAPPRA_DATA_HOME = previousDataHome;
    }
    cleanup(root);
  }
});

test('TTY --config without --apply only previews and never confirms', async () => {
  const root = makeTempDir('init-wizard-config-preview');
  try {
    const choicesPath = join(root, 'choices.json');
    writeText(choicesPath, `${JSON.stringify(baseInitChoices(), null, 2)}\n`);
    const before = snapshotTree(root);
    const ui = new FakeWizardUi({});
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runInitCommand(
      { cwd: root, configPath: choicesPath, apply: false, json: false },
      {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      },
      { interactive: true, ui },
    );
    assert.equal(code, 0);
    assert.deepEqual(ui.calls, []);
    assert(stdout.join('').includes('Plan only'));
    assert.equal(existsSync(join(root, '.pappra', 'workspace.json')), false);
    assert.deepEqual(snapshotTree(root), before);
  } finally {
    cleanup(root);
  }
});

test('interactive initial selections share common derived defaults', async () => {
  const root = makeTempDir('init-wizard-defaults');
  try {
    createRepository(root);
    writeText(join(root, 'AGENTS.md'), '# agents\n');
    writeText(join(root, 'CLAUDE.md'), '# claude\n');
    writeText(join(root, 'README.md'), '# readme\n');
    writeText(join(root, 'docs', 'a.md'), '# docs\n');
    writeJson(join(root, 'package.json'), {
      name: 'defaults-fixture',
      scripts: { lint: 'true', typecheck: 'true', test: 'true' },
    });
    writeText(join(root, 'pnpm-lock.yaml'), '');
    const contextResult = await inspectInitContext(root);
    assert.equal(contextResult.ok, true);
    if (!contextResult.ok) return;
    const context = contextResult.context;
    const common = deriveCommonInitDefaults(context.discovery);
    const derived = await deriveInitChoices(context.discovery, { pathEnv: '' });
    assert.deepEqual(derived.choices.knowledge, common.knowledge);
    assert.equal(derived.choices.name, common.name);
    assert.deepEqual(derived.choices.excludes, common.excludes);
    assert.deepEqual(derived.choices.validation, [
      'package-script:.:lint',
      'package-script:.:typecheck',
      'package-script:.:test',
    ]);
    assert.deepEqual(derived.choices.repositories, [
      { path: '.', access: 'write' },
    ]);
    assert.equal(derived.choices.knowledge.taskVisibility, 'private');
    assert.deepEqual(derived.choices.knowledge.sources, [
      'AGENTS.md',
      'CLAUDE.md',
      'docs',
    ]);
    assert.equal(
      derived.choices.knowledge.sources.includes('README.md'),
      false,
    );

    const before = snapshotTree(root);
    const ui = new FakeWizardUi({
      multiselect: [['.'], [...common.knowledge.sources], []],
      select: [
        'next',
        'write',
        'next',
        common.knowledge.taskVisibility,
        'next',
        'skip',
        'continue',
        'continue',
      ],
      text: [common.name, common.knowledge.newDocuments],
    });
    const choices = await collectInitChoices(context, ui);
    assert(choices !== null);
    if (choices === null) return;
    assert.deepEqual(choices.knowledge, derived.choices.knowledge);
    assert.equal(choices.name, derived.choices.name);
    assert.deepEqual(choices.excludes, derived.choices.excludes);
    assert.deepEqual(choices.code, derived.choices.code);
    assert.deepEqual(choices.validation, []);
    assert.deepEqual(choices.hosts, []);
    assert.deepEqual(snapshotTree(root), before);

    const call = (kind: 'text' | 'select' | 'multiselect', message: string) => {
      const match = ui.calls.find(
        (entry) => entry.kind === kind && entry.message.includes(message),
      );
      assert(match !== undefined);
      return match;
    };
    assert.deepEqual(call('multiselect', 'Select repositories').initialValues, [
      '.',
    ]);
    assert.deepEqual(
      call('multiselect', 'Select knowledge sources').initialValues,
      common.knowledge.sources,
    );
    assert.equal(
      call('text', 'New authored-document destination').initialValue,
      common.knowledge.newDocuments,
    );
    assert.equal(call('text', 'Workspace name').initialValue, common.name);
    assert.equal(
      call('select', 'Task document visibility').initialValue,
      'private',
    );

    const editUi = new FakeWizardUi({
      multiselect: [['.'], [...common.knowledge.sources], [], [], [], []],
      select: [
        'next',
        'write',
        'next',
        common.knowledge.taskVisibility,
        'next',
        'edit',
        'codegraph',
        'serena',
        'manual',
        'advanced',
        'codegraph',
        'serena',
        'manual',
        'continue',
      ],
      text: [
        'edited',
        common.knowledge.newDocuments,
        'docs/generated, custom',
        'docs/generated, custom',
      ],
    });
    const edited = await collectInitChoices(context, editUi);
    assert(edited !== null);
    if (edited === null) return;
    assert.equal(edited.name, 'edited');
    assert.deepEqual(edited.code, {
      graph: 'codegraph',
      symbols: 'serena',
      prepare: 'manual',
    });
    const graphCalls = editUi.calls.filter((call) =>
      call.message.startsWith('Code graph preference'),
    );
    assert.deepEqual(
      graphCalls.map((call) => call.initialValue),
      ['none', 'codegraph'],
    );
    const reviewCall = editUi.calls.find(
      (call) =>
        call.kind === 'select' &&
        call.message === 'Edit a section or continue to the detailed plan',
    );
    assert(reviewCall !== undefined);
    assert.equal(
      reviewCall.options.some((option) => option.value === 'advanced'),
      true,
    );
    assert.deepEqual(edited.excludes, ['docs/generated', 'custom']);
    assert.deepEqual(snapshotTree(root), before);
  } finally {
    cleanup(root);
  }
});

test('field validation rejects malformed name and destination with correction', async () => {
  const root = makeTempDir('init-wizard-validation');
  try {
    const contextResult = await inspectInitContext(root);
    assert.equal(contextResult.ok, true);
    if (!contextResult.ok) return;
    const before = snapshotTree(root);
    const ui = new FakeWizardUi({
      multiselect: [[], []],
      select: ['next', 'next', 'private', 'next', 'skip', 'continue'],
      text: ['', 'fixed', '/tmp/outside', '.pappra/knowledge'],
    });
    const choices = await collectInitChoices(contextResult.context, ui);
    assert(choices !== null);
    if (choices === null) return;
    assert.equal(choices.name, 'fixed');
    assert.equal(choices.knowledge.newDocuments, '.pappra/knowledge');
    assert.equal(ui.validationErrors.length, 2);
    assert.deepEqual(
      ui.validationErrors.map((entry) => entry.message.split(' (')[0]),
      ['Workspace name', 'New authored-document destination'],
    );
    assert.deepEqual(snapshotTree(root), before);
  } finally {
    cleanup(root);
  }
});

test('section Back and review editing retain the draft', async () => {
  const root = makeTempDir('init-wizard-navigation');
  try {
    createRepository(root);
    writeText(join(root, 'AGENTS.md'), '# agents\n');
    const contextResult = await inspectInitContext(root);
    assert.equal(contextResult.ok, true);
    if (!contextResult.ok) return;
    const before = snapshotTree(root);
    const ui = new FakeWizardUi({
      text: ['first', 'second', '.pappra/knowledge', 'third'],
      select: [
        'next',
        'write',
        'back',
        'next',
        'read',
        'next',
        'private',
        'review',
        'workspace',
        'continue',
      ],
      multiselect: [['.'], ['.'], ['AGENTS.md']],
    });
    const choices = await collectInitChoices(contextResult.context, ui);
    assert(choices !== null);
    if (choices === null) return;
    assert.equal(choices.name, 'third');
    assert.deepEqual(choices.repositories, [{ path: '.', access: 'read' }]);
    assert.equal(
      ui.calls.some(
        (entry) =>
          entry.kind === 'select' &&
          entry.message === 'Section navigation' &&
          entry.options.some((option) => option.value === 'back'),
      ),
      true,
    );
    assert.equal(
      ui.calls.filter((entry) => entry.message === 'Workspace name').length,
      3,
    );
    assert.equal(
      ui.notes.some((note) => note.includes('Knowledge sources')),
      true,
    );
    assert.deepEqual(snapshotTree(root), before);
  } finally {
    cleanup(root);
  }
});

test('grouped knowledge labels retained values and skipped advanced preserve seed', async () => {
  const root = makeTempDir('init-wizard-grouped');
  try {
    createRepository(root);
    writeText(join(root, 'AGENTS.md'), '# agents\n');
    writeText(join(root, 'README.md'), '# readme\n');
    writeText(join(root, 'docs', 'a.md'), '# docs\n');
    const config = baseWorkspaceConfig({
      name: 'existing',
      repositories: [{ id: 'app', path: '.', access: 'write' }],
      knowledge: {
        sources: ['AGENTS.md', 'missing-source'],
        newDocuments: '.pappra/knowledge',
        taskVisibility: 'private',
      },
      code: { graph: 'codegraph', symbols: 'serena', prepare: 'manual' },
      validation: [
        {
          id: 'custom',
          repositoryId: 'app',
          executable: 'echo',
          args: ['custom'],
        },
      ],
      excludes: ['dist'],
      extensions: { 'pappra.test': { keep: true } },
      continuity: { autoResume: true },
    });
    writeWorkspaceConfig(root, config);
    writeMachineConfig(
      root,
      baseMachineConfig(root, { selectedHosts: ['pi'] }),
    );
    const contextResult = await inspectInitContext(root);
    assert.equal(contextResult.ok, true);
    if (!contextResult.ok) return;
    const ui = new FakeWizardUi({
      text: ['existing', '.pappra/knowledge'],
      select: [
        'next',
        'write',
        'next',
        'private',
        'next',
        'skip',
        'continue',
        'continue',
      ],
      multiselect: [['.'], ['AGENTS.md', 'missing-source']],
    });
    const choices = await collectInitChoices(contextResult.context, ui, {
      reconfigure: true,
    });
    assert(choices !== null);
    if (choices === null) return;
    const knowledgeCall = ui.calls.find((entry) =>
      entry.message.includes('Select knowledge sources'),
    );
    assert(knowledgeCall !== undefined);
    const labels = knowledgeCall.options.map((option) => option.label);
    assert.equal(
      labels.some((label) => label.startsWith('Folder: docs')),
      true,
    );
    assert.equal(
      labels.some((label) => label.startsWith('File: docs/a.md')),
      true,
    );
    assert.equal(
      labels.some((label) => label.startsWith('Root file: AGENTS.md')),
      true,
    );
    assert.equal(
      labels.some((label) =>
        label.startsWith('Retained configured: missing-source'),
      ),
      true,
    );
    assert.deepEqual(choices.knowledge.sources, [
      'AGENTS.md',
      'missing-source',
    ]);
    assert.deepEqual(choices.code, config.code);
    assert.deepEqual(choices.validation, ['workspace-config:custom']);
    assert.deepEqual(choices.hosts, ['pi']);
    assert.deepEqual(choices.excludes, ['dist']);
    assert.equal(
      ui.notes.some((note) => note.includes('New document destination')),
      true,
    );
  } finally {
    cleanup(root);
  }
});

test('interactive repository pre-selection distinguishes zero, one, and multiple candidates', async () => {
  const empty = makeTempDir('init-wizard-zero');
  const single = makeTempDir('init-wizard-one');
  const multiple = makeTempDir('init-wizard-many');
  try {
    createRepository(single);
    createRepository(join(multiple, 'apps', 'api'));
    createRepository(join(multiple, 'apps', 'web'));
    writeText(join(multiple, 'README.md'), '# many\n');

    const emptyContext = await inspectInitContext(empty);
    const singleContext = await inspectInitContext(single);
    const multipleContext = await inspectInitContext(multiple);
    assert.equal(emptyContext.ok, true);
    assert.equal(singleContext.ok, true);
    assert.equal(multipleContext.ok, true);
    if (!emptyContext.ok || !singleContext.ok || !multipleContext.ok) return;
    assert.deepEqual(
      (await deriveInitChoices(emptyContext.context.discovery)).choices
        .repositories,
      [],
    );
    assert.equal(
      (await deriveInitChoices(singleContext.context.discovery)).choices
        .repositories.length,
      1,
    );
    assert.equal(
      (await deriveInitChoices(multipleContext.context.discovery)).choices
        .repositories.length,
      2,
    );

    const zeroUi = new FakeWizardUi({ text: [Symbol('cancel')] });
    assert.equal(await collectInitChoices(emptyContext.context, zeroUi), null);
    assert.equal(
      zeroUi.calls.some((entry) =>
        entry.message.includes('Select repositories'),
      ),
      false,
    );
    assert.equal(zeroUi.cancelled.length, 1);

    const multipleUi = new FakeWizardUi({
      text: ['many'],
      select: ['write'],
      multiselect: [Symbol('cancel')],
    });
    assert.equal(
      await collectInitChoices(multipleContext.context, multipleUi),
      null,
    );
    assert.deepEqual(
      multipleUi.calls.find((entry) =>
        entry.message.includes('Select repositories'),
      )?.initialValues,
      [],
    );
    assert.equal(multipleUi.cancelled.length, 1);
  } finally {
    cleanup(empty);
    cleanup(single);
    cleanup(multiple);
  }
});

test('TTY reconfigure prefills existing selections and preserves identity', async () => {
  const root = makeTempDir('init-wizard-reconfigure');
  try {
    createRepository(root);
    writeText(join(root, 'AGENTS.md'), '# agents\n');
    const config = baseWorkspaceConfig({
      name: 'existing',
      repositories: [{ id: 'app', path: '.', access: 'write' }],
      knowledge: {
        sources: ['AGENTS.md'],
        newDocuments: '.pappra/knowledge',
        taskVisibility: 'private',
      },
      validation: [
        {
          id: 'custom',
          repositoryId: 'app',
          executable: 'echo',
          args: ['custom'],
        },
      ],
      excludes: ['dist'],
      extensions: { 'pappra.test': { keep: true } },
      continuity: { autoResume: true },
    });
    writeWorkspaceConfig(root, config);
    writeMachineConfig(
      root,
      baseMachineConfig(root, { selectedHosts: ['pi'] }),
    );
    const contextResult = await inspectInitContext(root);
    assert.equal(contextResult.ok, true);
    if (!contextResult.ok) return;
    const before = snapshotTree(root);
    const ui = new FakeWizardUi({
      multiselect: [['.'], ['AGENTS.md'], []],
      select: [
        'next',
        'write',
        'next',
        'private',
        'next',
        'skip',
        'continue',
        'continue',
      ],
      text: ['edited', '.pappra/knowledge'],
    });
    const choices = await collectInitChoices(contextResult.context, ui, {
      reconfigure: true,
    });
    assert(choices !== null);
    if (choices === null) return;
    assert.equal(choices.workspaceId, config.workspaceId);
    assert.equal(choices.name, 'edited');
    assert.deepEqual(choices.validation, ['workspace-config:custom']);
    assert.deepEqual(choices.excludes, ['dist']);
    assert.deepEqual(choices.hosts, ['pi']);
    assert.deepEqual(choices.knowledge.sources, ['AGENTS.md']);
    assert.deepEqual(choices.repositories, [
      { path: '.', access: 'write', id: 'app' },
    ]);
    const call = (kind: 'text' | 'select' | 'multiselect', message: string) => {
      const match = ui.calls.find(
        (entry) => entry.kind === kind && entry.message.includes(message),
      );
      assert(match !== undefined);
      return match;
    };
    assert.deepEqual(call('multiselect', 'Select repositories').initialValues, [
      '.',
    ]);
    assert.deepEqual(
      call('multiselect', 'Select knowledge sources').initialValues,
      ['AGENTS.md'],
    );
    assert.equal(call('text', 'destination').initialValue, '.pappra/knowledge');
    assert.equal(call('text', 'Workspace name').initialValue, 'existing');
    assert.deepEqual(snapshotTree(root), before);

    const prepared = await planWorkspaceInit({
      root,
      context: contextResult.context,
      choices,
      reconfigure: true,
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.equal(prepared.bundle.scope.workspaceId, config.workspaceId);
    assert.deepEqual(prepared.bundle.scope.hosts, ['pi']);
  } finally {
    cleanup(root);
  }
});

test('default basic route never enters advanced prompts and skip retains values', async () => {
  const root = makeTempDir('init-wizard-advanced-skip');
  try {
    createRepository(root);
    const contextResult = await inspectInitContext(root);
    assert.equal(contextResult.ok, true);
    if (!contextResult.ok) return;
    const before = snapshotTree(root);
    const ui = new FakeWizardUi({
      select: ['next', 'write', 'next', 'private', 'next', 'skip', 'continue'],
      multiselect: [['.'], []],
      text: ['default route', '.pappra/knowledge'],
    });
    const choices = await collectInitChoices(contextResult.context, ui);
    assert(choices !== null);
    if (choices === null) return;
    const advancedMessages = ui.calls.filter((entry) =>
      /Code graph|Symbol provider|Index preparation|Select hosts|exclude prefixes/.test(
        entry.message,
      ),
    );
    assert.deepEqual(advancedMessages, []);
    const advancedNavigation = ui.calls.filter(
      (entry) =>
        entry.kind === 'select' &&
        entry.message === 'Section navigation' &&
        entry.options.some((option) => option.value === 'skip'),
    );
    assert.equal(advancedNavigation.length, 1);
    assert.deepEqual(
      advancedNavigation[0]?.options.map((option) => option.value),
      ['skip', 'edit', 'back', 'cancel'],
    );
    assert.equal(advancedNavigation[0]?.initialValue, 'skip');
    assert.deepEqual(choices.code, {
      graph: 'none',
      symbols: 'auto',
      prepare: 'on-demand',
    });
    assert.deepEqual(choices.hosts, []);
    assert.deepEqual(choices.excludes, [
      'node_modules',
      'dist',
      'coverage',
      'tmp',
      'test-results',
    ]);
    assert.equal(ui.cancelled.length, 0);
    assert.deepEqual(snapshotTree(root), before);

    const revisit = new FakeWizardUi({
      select: [
        'next',
        'write',
        'next',
        'private',
        'next',
        'edit',
        'none',
        'auto',
        'on-demand',
        'continue',
      ],
      multiselect: [['.'], [], []],
      text: ['revisit', '.pappra/knowledge', 'custom'],
    });
    const revisited = await collectInitChoices(contextResult.context, revisit);
    assert(revisited !== null);
    if (revisited === null) return;
    assert.deepEqual(revisited.code, {
      graph: 'none',
      symbols: 'auto',
      prepare: 'on-demand',
    });
    assert.deepEqual(revisited.hosts, []);
    assert.deepEqual(revisited.excludes, ['custom']);
    assert.deepEqual(snapshotTree(root), before);
  } finally {
    cleanup(root);
  }
});

test('recoverable validation binding error returns to repository review and retries the plan', async () => {
  const root = makeTempDir('init-wizard-recover-validation');
  try {
    createUnboundValidationWorkspace(root);
    const before = snapshotTree(root);
    const ui = new FakeWizardUi({
      select: [
        'next',
        'next',
        'private',
        'next',
        'skip',
        'continue',
        'repositories',
        'write',
        'continue',
      ],
      multiselect: [[], [], ['.']],
      text: ['edited', '.pappra/knowledge'],
      confirm: [false],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runInitCommand(
      {
        cwd: root,
        configPath: null,
        apply: false,
        json: false,
        reconfigure: true,
      },
      {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      },
      { interactive: true, ui },
    );

    assert.equal(code, 130);
    assert(stderr.join('').includes('init_validation_unbound'));
    assert(stdout.join('').includes('Pappra init plan'));
    assert(stdout.join('').includes('Repositories: app:.:write'));
    assert.equal(
      ui.calls.filter(
        (call) =>
          call.kind === 'select' &&
          call.message === 'Edit a section or continue to the detailed plan',
      ).length,
      3,
    );
    assert.equal(
      ui.calls.filter(
        (call) =>
          call.kind === 'multiselect' &&
          call.message.includes('Select repositories'),
      ).length,
      2,
    );
    assert.equal(
      ui.notes.filter((note) => note.includes('Name: edited')).length,
      3,
    );
    assert.equal(ui.calls.filter((call) => call.kind === 'confirm').length, 1);
    assert.deepEqual(snapshotTree(root), before);
  } finally {
    cleanup(root);
  }
});

test('cancelling recoverable validation correction returns 130 without writes', async () => {
  const root = makeTempDir('init-wizard-cancel-recovery');
  try {
    createUnboundValidationWorkspace(root);
    const before = snapshotTree(root);
    const ui = new FakeWizardUi({
      select: ['next', 'next', 'private', 'next', 'skip', 'continue', 'cancel'],
      multiselect: [[], []],
      text: ['existing', '.pappra/knowledge'],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runInitCommand(
      {
        cwd: root,
        configPath: null,
        apply: false,
        json: false,
        reconfigure: true,
      },
      {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      },
      { interactive: true, ui },
    );

    assert.equal(code, 130);
    assert(stderr.join('').includes('init_validation_unbound'));
    assert.equal(stdout.join('').includes('Pappra init plan'), false);
    assert.equal(
      ui.calls.filter(
        (call) =>
          call.kind === 'select' &&
          call.message === 'Edit a section or continue to the detailed plan',
      ).length,
      2,
    );
    assert.equal(ui.calls.filter((call) => call.kind === 'confirm').length, 0);
    assert.equal(ui.cancelled.length, 1);
    assert.deepEqual(snapshotTree(root), before);
  } finally {
    cleanup(root);
  }
});

test('continuing recoverable correction without editing does not replan', async () => {
  const root = makeTempDir('init-wizard-noop-recovery');
  try {
    createUnboundValidationWorkspace(root);
    const before = snapshotTree(root);
    const ui = new FakeWizardUi({
      select: [
        'next',
        'next',
        'private',
        'next',
        'skip',
        'continue',
        'continue',
      ],
      multiselect: [[], []],
      text: ['existing', '.pappra/knowledge'],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runInitCommand(
      {
        cwd: root,
        configPath: null,
        apply: false,
        json: false,
        reconfigure: true,
      },
      {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      },
      { interactive: true, ui },
    );

    assert.equal(code, 2);
    assert.equal(stderr.join('').match(/init_validation_unbound/g)?.length, 1);
    assert.equal(stdout.join('').includes('Pappra init plan'), false);
    assert.equal(
      ui.calls.filter(
        (call) =>
          call.kind === 'select' &&
          call.message === 'Edit a section or continue to the detailed plan',
      ).length,
      2,
    );
    assert.equal(
      ui.calls.filter(
        (call) =>
          call.kind === 'multiselect' &&
          call.message.includes('Select repositories'),
      ).length,
      1,
    );
    assert.equal(ui.calls.filter((call) => call.kind === 'confirm').length, 0);
    assert.deepEqual(snapshotTree(root), before);
  } finally {
    cleanup(root);
  }
});

test('stale configuration conflict exits without offering recoverable correction', async () => {
  const root = makeTempDir('init-wizard-stale-config');
  try {
    const config = createUnboundValidationWorkspace(root);
    const observations: {
      externalSnapshot?: ReturnType<typeof snapshotTree>;
    } = {};
    class StaleConfigWizardUi extends FakeWizardUi {
      override async select(
        message: string,
        options: Parameters<FakeWizardUi['select']>[1],
        initialValue?: string,
      ): Promise<string | symbol> {
        const answer = await super.select(message, options, initialValue);
        if (
          message === 'Edit a section or continue to the detailed plan' &&
          answer === 'continue'
        ) {
          writeWorkspaceConfig(root, { ...config, name: 'external change' });
          observations.externalSnapshot = snapshotTree(root);
        }
        return answer;
      }
    }
    const ui = new StaleConfigWizardUi({
      select: ['next', 'write', 'next', 'private', 'next', 'skip', 'continue'],
      multiselect: [['.'], []],
      text: ['existing', '.pappra/knowledge'],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runInitCommand(
      {
        cwd: root,
        configPath: null,
        apply: false,
        json: false,
        reconfigure: true,
      },
      {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      },
      { interactive: true, ui },
    );

    assert.equal(code, 1);
    assert.match(stderr.join(''), /plan is stale/);
    assert.equal(stdout.join('').includes('Pappra init plan'), false);
    assert.equal(
      ui.calls.filter(
        (call) =>
          call.kind === 'select' &&
          call.message === 'Edit a section or continue to the detailed plan',
      ).length,
      1,
    );
    assert.equal(ui.calls.filter((call) => call.kind === 'confirm').length, 0);
    assert(observations.externalSnapshot !== undefined);
    assert.deepEqual(snapshotTree(root), observations.externalSnapshot);
  } finally {
    cleanup(root);
  }
});
test('fresh-init and reconfigure wizards can add one inspected repository and knowledge folder', async () => {
  for (const reconfigure of [false, true]) {
    const root = makeTempDir(
      reconfigure
        ? 'init-explicit-path-reconfigure-ui'
        : 'init-explicit-path-fresh-ui',
    );
    try {
      const repositoryRoot = join(root, repositoryPath);
      createRepository(repositoryRoot);
      mkdirSync(join(root, 'notes', 'empty'), { recursive: true });
      if (reconfigure) {
        writeWorkspaceConfig(
          root,
          baseWorkspaceConfig({
            name: 'before reconfigure',
            repositories: [],
          }),
        );
        writeMachineConfig(root, baseMachineConfig(root));
      }
      const contextResult = await inspectInitContext(root);
      assert.equal(contextResult.ok, true);
      if (!contextResult.ok) continue;
      const context = contextResult.context;
      const seed =
        reconfigure && context.workspaceInspection.value !== null
          ? existingInitChoices(
              context.workspaceInspection.value,
              context.machineInspection.value,
            )
          : baseInitChoices({ name: 'fresh explicit paths' });
      const ui = new FakeWizardUi({
        multiselect: [
          [repositoryAction],
          [repositoryPath],
          [knowledgeAction],
          ['notes/empty'],
        ],
        select: ['repositories', 'read', 'knowledge', 'private', 'continue'],
        text: [repositoryPath, 'notes/empty', '.pappra/knowledge'],
      });

      const choices = await collectInitChoices(context, ui, {
        ...(reconfigure ? { reconfigure: true } : {}),
        draft: seed,
        reviewOnly: true,
      });
      assert(choices !== null);
      if (choices === null) continue;
      assert.deepEqual(choices.repositories, [
        { path: repositoryPath, access: 'read' },
      ]);
      assert.deepEqual(choices.knowledge.sources, ['notes/empty']);
      assert(
        ui.calls.some(
          (call) =>
            call.kind === 'text' &&
            call.message.includes(`workspace root ${context.root}`),
        ),
        'the path prompt explains the resolved workspace root',
      );
      assert(
        ui.calls.some(
          (call) =>
            call.kind === 'multiselect' &&
            call.options.some((option) => option.value === repositoryAction),
        ),
      );
      assert(
        ui.calls.some(
          (call) =>
            call.kind === 'multiselect' &&
            call.options.some((option) => option.value === knowledgeAction),
        ),
      );
      assert(
        ui.notes.some((note) =>
          note.includes('Empty folders are valid knowledge sources'),
        ),
      );

      const beforePlan = snapshotTree(root);
      const prepared = await planWorkspaceInit({
        root,
        context,
        choices,
        ...(reconfigure ? { reconfigure: true } : {}),
        runtimeVersion,
      });
      assert.equal(prepared.ok, true, JSON.stringify(prepared));
      if (!prepared.ok) continue;
      assert.equal(prepared.bundle.scope.repositories[0]?.path, repositoryPath);
      assert.deepEqual(prepared.bundle.scope.knowledge.sources, [
        'notes/empty',
      ]);
      assert.deepEqual(snapshotTree(root), beforePlan);
    } finally {
      cleanup(root);
    }
  }
});
test('wizard path additions retain draft state on local cancellation and expose the workspace root', async () => {
  const root = makeTempDir('init-explicit-path-cancel');
  try {
    const repositoryRoot = join(root, repositoryPath);
    createRepository(repositoryRoot);
    mkdirSync(join(root, 'notes', 'empty'), { recursive: true });
    const contextResult = await inspectInitContext(root);
    assert.equal(contextResult.ok, true);
    if (!contextResult.ok) return;
    const ui = new FakeWizardUi({
      select: ['repositories', 'read', 'knowledge', 'private', 'continue'],
      multiselect: [[repositoryPath, repositoryAction], [repositoryPath], []],
      text: [Symbol('cancel-path'), '.pappra/knowledge'],
    });
    const seed = baseInitChoices({
      repositories: [{ path: repositoryPath, access: 'read' }],
      knowledge: {
        sources: [],
        newDocuments: '.pappra/knowledge',
        taskVisibility: 'private',
      },
    });

    const choices = await collectInitChoices(contextResult.context, ui, {
      draft: seed,
      reviewOnly: true,
    });
    assert(choices !== null);
    if (choices === null) return;
    assert.deepEqual(choices.repositories, [
      { path: repositoryPath, access: 'read' },
    ]);
    assert.deepEqual(choices.knowledge.sources, []);
    assert(
      ui.notes.some((note) => note.includes('draft selections are unchanged')),
    );
    assert(
      ui.calls.some(
        (call) =>
          call.kind === 'text' &&
          call.message.includes(contextResult.context.root),
      ),
    );
  } finally {
    cleanup(root);
  }
});
test('wizard path inspection keeps invalid-path correction local and retains the draft', async () => {
  const root = makeTempDir('init-explicit-path-correction');
  try {
    createRepository(root);
    writeText(join(root, 'notes', 'manual.md'), '# manual\n');
    const contextResult = await inspectInitContext(root);
    assert.equal(contextResult.ok, true);
    if (!contextResult.ok) return;
    const before = snapshotTree(root);
    const ui = new FakeWizardUi({
      select: ['knowledge', 'private', 'continue'],
      multiselect: [[knowledgeAction], ['notes/manual.md']],
      text: ['notes/missing.md', 'notes/manual.md', '.pappra/knowledge'],
    });
    const seed = baseInitChoices({
      repositories: [{ path: '.', access: 'read' }],
      knowledge: {
        sources: [],
        newDocuments: '.pappra/knowledge',
        taskVisibility: 'private',
      },
    });

    const choices = await collectInitChoices(contextResult.context, ui, {
      draft: seed,
      reviewOnly: true,
    });
    assert(choices !== null);
    if (choices === null) return;
    assert.deepEqual(choices.repositories, [{ path: '.', access: 'read' }]);
    assert.deepEqual(choices.knowledge.sources, ['notes/manual.md']);
    const pathPrompts = ui.calls.filter(
      (call) =>
        call.kind === 'text' &&
        call.message.includes('Existing knowledge file'),
    );
    assert.equal(pathPrompts.length, 2);
    assert.equal(pathPrompts[1]?.initialValue, 'notes/missing.md');
    assert(ui.notes.some((note) => note.includes('notes/missing.md')));
    assert.equal(ui.cancelled.length, 0);
    assert.deepEqual(snapshotTree(root), before);
  } finally {
    cleanup(root);
  }
});
test('interactive init forwards its path observations and rejects drift before plan output', async () => {
  const root = makeTempDir('init-explicit-path-interactive-drift');
  try {
    const sourcePath = join(root, 'notes', 'source.md');
    writeText(sourcePath, '# initial\n');
    let afterMutation: ReturnType<typeof snapshotTree> | undefined;
    class MutatingWizardUi extends FakeWizardUi {
      override async select(
        message: string,
        options: Parameters<FakeWizardUi['select']>[1],
        initialValue?: string,
      ): Promise<string | symbol> {
        const answer = await super.select(message, options, initialValue);
        if (
          message === 'Edit a section or continue to the detailed plan' &&
          answer === 'continue' &&
          afterMutation === undefined
        ) {
          const replacement = join(root, 'notes', 'replacement.md');
          writeText(replacement, '# replacement\n');
          renameSync(replacement, sourcePath);
          afterMutation = snapshotTree(root);
        }
        return answer;
      }
    }
    const ui = new MutatingWizardUi({
      text: ['interactive workspace', 'notes/source.md', '.pappra/knowledge'],
      multiselect: [[], [knowledgeAction], ['notes/source.md']],
      select: ['next', 'next', 'private', 'next', 'skip', 'continue'],
    });
    let stdout = '';
    let stderr = '';
    const exitCode = await runInitCommand(
      { cwd: root, configPath: null, apply: false, json: false },
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
      { interactive: true, ui },
    );

    assert.notEqual(exitCode, 0);
    assert(afterMutation !== undefined);
    assert.match(stderr, /init_plan_stale|changed after it was inspected/);
    assert.equal(stdout.includes('Pappra init plan'), false);
    assert.deepEqual(snapshotTree(root), afterMutation);
  } finally {
    cleanup(root);
  }
});
