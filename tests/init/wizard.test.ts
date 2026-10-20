import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  collectInitChoices,
  runInitCommand,
} from '../../src/cli/commands/init.js';
import { inspectInitContext, planWorkspaceInit } from '../../src/app/init.js';
import { parseInitChoices } from '../../src/schemas/init.js';
import {
  baseWorkspaceConfig,
  cleanup,
  createRepository,
  makeTempDir,
  snapshotTree,
  writeJson,
  writeText,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';
import { FakeWizardUi, baseInitChoices } from './fixtures.js';

test('cancelling the wizard leaves the workspace byte-identical', async () => {
  const root = makeTempDir('init-wizard-cancel');
  try {
    createRepository(root);
    writeText(join(root, 'README.md'), '# readme\n');
    const contextResult = await inspectInitContext(root);
    assert.equal(contextResult.ok, true);
    if (!contextResult.ok) return;
    const before = snapshotTree(root);
    const ui = new FakeWizardUi({
      multiselect: [Symbol('cancel')],
    });
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
      multiselect: [['.'], ['README.md'], [], ['pi']],
      select: ['write', 'private', 'none', 'auto', 'on-demand'],
      text: ['.pappra/knowledge', '', 'wizard workspace'],
    });
    const choices = await collectInitChoices(contextResult.context, ui);
    assert(choices !== null);
    if (choices === null) return;
    assert.deepEqual(choices.repositories, [{ path: '.', access: 'write' }]);
    assert.deepEqual(choices.knowledge.sources, ['README.md']);
    assert.equal(choices.name, 'wizard workspace');
    assert.deepEqual(choices.hosts, ['pi']);

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
  try {
    createRepository(root);
    writeText(join(root, 'README.md'), '# readme\n');
    const before = snapshotTree(root);
    const ui = new FakeWizardUi({
      multiselect: [['.'], ['README.md'], ['pi']],
      select: ['write', 'private', 'none', 'auto', 'on-demand'],
      text: ['.pappra/knowledge', '', 'declined workspace'],
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
    assert(stderr.join('').includes('no files were written'));
    assert.deepEqual(snapshotTree(root), before);
  } finally {
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
