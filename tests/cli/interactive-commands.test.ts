import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { CheckpointService } from '../../src/continuity/index.js';
import type { CliOutput } from '../../src/cli/output.js';
import type { DocsCommandOptions } from '../../src/cli/commands/docs.js';
import { runDocsCommand } from '../../src/cli/commands/docs.js';
import type { CodeCommandOptions } from '../../src/cli/commands/code.js';
import { runCodeCommand } from '../../src/cli/commands/code.js';
import {
  runHostCommand,
  type HostCommandOptions,
} from '../../src/cli/commands/host.js';
import { runResumeCommand } from '../../src/cli/commands/continuity.js';
import { silentProgress } from '../../src/cli/interactive.js';
import { FakeWizardUi } from '../init/fixtures.js';
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

function capture(): {
  readonly output: CliOutput;
  readonly read: () => { readonly stdout: string; readonly stderr: string };
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

function makeWorkspace(label: string, overrides: Record<string, unknown> = {}) {
  const root = realpathSync(makeTempDir(label));
  writeWorkspaceConfig(root, baseWorkspaceConfig(overrides));
  writeMachineConfig(root, baseMachineConfig(root));
  return root;
}

function docsOptions(
  root: string,
  overrides: Partial<DocsCommandOptions> = {},
): DocsCommandOptions {
  return {
    cwd: root,
    action: 'scan',
    argument: null,
    targetPath: null,
    scope: null,
    json: false,
    includePrivate: false,
    includeArchived: false,
    apply: false,
    interactive: true,
    ...overrides,
  };
}

function makeDocsWorkspace(): string {
  const root = makeWorkspace('interactive-docs', {
    knowledge: {
      sources: ['AGENTS.md', 'docs'],
      newDocuments: 'knowledge',
      taskVisibility: 'shared',
    },
  });
  writeText(join(root, 'AGENTS.md'), '# Agents\n');
  writeText(join(root, 'docs/architecture/a.md'), '# Arch\n');
  return root;
}

function codeOptions(
  root: string,
  overrides: Partial<CodeCommandOptions> = {},
): CodeCommandOptions {
  return {
    cwd: root,
    json: false,
    action: 'status',
    repositoryId: null,
    kind: null,
    query: null,
    maxResults: null,
    maxBytes: null,
    apply: false,
    rebuild: false,
    interactive: true,
    ...overrides,
  };
}

function hostInvocation(
  root: string,
  overrides: Partial<HostCommandOptions> = {},
): HostCommandOptions {
  return {
    cwd: root,
    json: false,
    action: 'describe',
    host: null,
    hostRoot: null,
    hostVersion: null,
    apply: false,
    force: false,
    subAction: null,
    out: null,
    mode: null,
    bootstrapConfig: null,
    recoveryConfig: null,
    transitionExtension: false,
    marketplace: false,
    scope: null,
    interactive: true,
    ...overrides,
  };
}

test('docs scan asks once and registers the plan on yes', async () => {
  const root = makeDocsWorkspace();
  try {
    const captured = capture();
    const ui = new FakeWizardUi({ confirm: [true] });
    const status = await runDocsCommand(docsOptions(root), captured.output, {
      ui,
    });
    assert.equal(status, 0, captured.read().stderr);
    const { stdout } = captured.read();
    assert.match(stdout, /Scan candidates: 2\n/);
    assert.doesNotMatch(stdout, /rerun with --apply/i);
    assert.match(stdout, /Registered 2 document\(s\)\.\n/);
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.calls[0]?.kind, 'confirm');
    assert.equal(ui.calls[0]?.message, 'Register these documents now?');
    assert.equal(ui.calls[0]?.initialValue, true);
  } finally {
    cleanup(root);
  }
});

test('docs scan declines without registering anything', async () => {
  const root = makeDocsWorkspace();
  try {
    const captured = capture();
    const ui = new FakeWizardUi({ confirm: [false] });
    const status = await runDocsCommand(docsOptions(root), captured.output, {
      ui,
    });
    assert.equal(status, 0, captured.read().stderr);
    assert.match(captured.read().stdout, /Nothing was applied\.\n/);
    assert.doesNotMatch(captured.read().stdout, /Registered/);

    const replay = capture();
    const replayStatus = await runDocsCommand(
      docsOptions(root, { interactive: false }),
      replay.output,
    );
    assert.equal(replayStatus, 0, replay.read().stderr);
    assert.match(replay.read().stdout, /Scan candidates: 2\n/);
  } finally {
    cleanup(root);
  }
});

test('non-interactive docs scan output is unchanged', async () => {
  const root = makeDocsWorkspace();
  try {
    const captured = capture();
    const status = await runDocsCommand(
      docsOptions(root, { interactive: false }),
      captured.output,
    );
    assert.equal(status, 0, captured.read().stderr);
    assert.equal(
      captured.read().stdout,
      'Scan candidates: 2\n' +
        '  rule  AGENTS.md\n' +
        '  architecture  docs/architecture/a.md\n' +
        'Rerun with --apply to register these documents in the knowledge catalog.\n' +
        'Plan only; rerun with --apply to register them.\n',
    );
    assert.equal(captured.read().stderr, '');
  } finally {
    cleanup(root);
  }
});

test('docs forget defaults to no and only applies on yes', async () => {
  const root = makeDocsWorkspace();
  try {
    const registered = capture();
    const registerStatus = await runDocsCommand(
      docsOptions(root, { apply: true, interactive: false, json: true }),
      registered.output,
    );
    assert.equal(registerStatus, 0, registered.read().stderr);
    const scan = JSON.parse(registered.read().stdout) as {
      registered: { documentId: string }[];
    };
    const documentId = scan.registered[0]?.documentId;
    assert(documentId);

    const declined = capture();
    const ui = new FakeWizardUi({ confirm: [false] });
    const status = await runDocsCommand(
      docsOptions(root, { action: 'forget', argument: documentId }),
      declined.output,
      { ui },
    );
    assert.equal(status, 0, declined.read().stderr);
    assert.match(declined.read().stdout, /Plan only: forget/);
    assert.match(declined.read().stdout, /Nothing was applied\.\n/);
    assert.equal(ui.calls[0]?.kind, 'confirm');
    assert.equal(ui.calls[0]?.message, 'Forget this document now?');
    assert.equal(ui.calls[0]?.initialValue, false);

    const listed = capture();
    await runDocsCommand(
      docsOptions(root, { action: 'list', json: true, includePrivate: true }),
      listed.output,
    );
    const list = JSON.parse(listed.read().stdout) as { documents: unknown[] };
    assert.equal(list.documents.length, 2);

    const accepted = capture();
    const acceptStatus = await runDocsCommand(
      docsOptions(root, { action: 'forget', argument: documentId }),
      accepted.output,
      { ui: new FakeWizardUi({ confirm: [true] }) },
    );
    assert.equal(acceptStatus, 0, accepted.read().stderr);
    assert.match(accepted.read().stdout, /forget: applied\n/);

    const remaining = capture();
    await runDocsCommand(
      docsOptions(root, { action: 'list', json: true, includePrivate: true }),
      remaining.output,
    );
    const after = JSON.parse(remaining.read().stdout) as {
      documents: unknown[];
    };
    assert.equal(after.documents.length, 1);
  } finally {
    cleanup(root);
  }
});

test('code picks a declared repository when --repo is missing', async () => {
  const root = makeWorkspace('interactive-code-pick', {
    repositories: [
      { id: 'app', path: 'app', access: 'write' },
      { id: 'tools', path: 'tools', access: 'read' },
    ],
  });
  try {
    createRepository(join(root, 'app'));
    createRepository(join(root, 'tools'));
    const captured = capture();
    const ui = new FakeWizardUi({ select: ['tools'] });
    await runCodeCommand(codeOptions(root), captured.output, { ui });
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.calls[0]?.kind, 'select');
    assert.equal(ui.calls[0]?.message, 'Pick a repository');
    assert.deepEqual(
      ui.calls[0]?.options.map((option) => option.value),
      ['app', 'tools'],
    );
    assert.deepEqual(
      ui.calls[0]?.options.map((option) => option.hint),
      ['app', 'tools'],
    );
    assert.match(captured.read().stdout, /Repository: tools\n/);
  } finally {
    cleanup(root);
  }
});

test('code uses a single declared repository without asking', async () => {
  const root = makeWorkspace('interactive-code-single', {
    repositories: [{ id: 'app', path: '.', access: 'write' }],
  });
  try {
    createRepository(root);
    const captured = capture();
    const ui = new FakeWizardUi({});
    await runCodeCommand(codeOptions(root), captured.output, { ui });
    assert.equal(ui.calls.length, 0);
    assert.match(captured.read().stdout, /Repository: app\n/);
  } finally {
    cleanup(root);
  }
});

test('code reports a workspace without repositories and exits 1', async () => {
  const root = makeWorkspace('interactive-code-empty');
  try {
    const captured = capture();
    const ui = new FakeWizardUi({});
    const status = await runCodeCommand(codeOptions(root), captured.output, {
      ui,
    });
    assert.equal(status, 1);
    assert.equal(ui.calls.length, 0);
    assert.match(
      captured.read().stderr,
      /no repositories are declared in this workspace/,
    );
  } finally {
    cleanup(root);
  }
});

interface FakeCodeGraphEngine {
  /** Restores the PATH this fixture replaced; always call it from a finally block. */
  readonly restorePath: () => void;
}

/**
 * Puts a deterministic `codegraph` first on PATH. The indexing confirmation is
 * only asked for a plan that mutates, which needs an observable engine that
 * reports no index yet; a machine without CodeGraph installed would otherwise
 * plan nothing and ask nothing.
 */
function fakeCodeGraphOnPath(root: string): FakeCodeGraphEngine {
  const bin = join(root, 'fake-codegraph-bin');
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, 'codegraph');
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const command = process.argv[2];
if (command === '--version') {
  process.stdout.write('1.4.1\\n');
} else if (command === 'status') {
  process.stdout.write(
    JSON.stringify({ initialized: false, version: '1.4.1' }),
  );
} else {
  process.exit(2);
}
`,
  );
  chmodSync(executable, 0o755);
  const previous = process.env['PATH'];
  process.env['PATH'] = `${bin}${delimiter}${previous ?? ''}`;
  return {
    restorePath: () => {
      if (previous === undefined) delete process.env['PATH'];
      else process.env['PATH'] = previous;
    },
  };
}

test('code prepare asks before indexing and applies nothing on no', async () => {
  const root = makeWorkspace('interactive-code-prepare', {
    repositories: [{ id: 'app', path: '.', access: 'write' }],
    code: { graph: 'codegraph', symbols: 'none', prepare: 'on-demand' },
  });
  const engine = fakeCodeGraphOnPath(root);
  try {
    createRepository(root);
    const captured = capture();
    const ui = new FakeWizardUi({ confirm: [false] });
    const status = await runCodeCommand(
      codeOptions(root, { action: 'prepare' }),
      captured.output,
      { ui },
    );
    assert.equal(status, 0, captured.read().stderr);
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.calls[0]?.kind, 'confirm');
    assert.equal(ui.calls[0]?.message, 'Prepare the app code index now?');
    assert.match(captured.read().stdout, /Mutates index: yes\n/);
    assert.match(captured.read().stdout, /Nothing was applied\.\n/);
    assert.equal(existsSync(join(root, '.codegraph')), false);
  } finally {
    engine.restorePath();
    cleanup(root);
  }
});

test('host picks a host when --host is missing', async () => {
  const root = realpathSync(makeTempDir('interactive-host-pick'));
  try {
    const captured = capture();
    const ui = new FakeWizardUi({ select: ['claude'] });
    const status = await runHostCommand(hostInvocation(root), captured.output, {
      ui,
    });
    assert.equal(status, 0, captured.read().stderr);
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.calls[0]?.kind, 'select');
    assert.deepEqual(
      ui.calls[0]?.options.map((option) => option.value),
      ['pi', 'codex', 'claude'],
    );
    for (const option of ui.calls[0]?.options ?? []) {
      assert.equal(typeof option.hint, 'string');
    }
    assert.match(captured.read().stdout, /Host: claude/);
  } finally {
    cleanup(root);
  }
});

test('non-interactive host install plan output is unchanged', async () => {
  const root = realpathSync(makeTempDir('interactive-host-plan'));
  const previousPath = process.env['PATH'];
  try {
    const bin = join(root, 'empty-bin');
    mkdirSync(bin);
    process.env['PATH'] = bin;
    const captured = capture();
    const status = await runHostCommand(
      hostInvocation(root, {
        action: 'install',
        host: 'pi',
        interactive: false,
      }),
      captured.output,
    );
    assert.equal(status, 1);
    assert.equal(captured.read().stdout, 'Status: unsupported\n');
    assert.match(
      captured.read().stderr,
      /outside the pinned 1\.3\.0 support matrix/,
    );
  } finally {
    if (previousPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previousPath;
    cleanup(root);
  }
});

test('non-interactive host uninstall json output stays parseable', async () => {
  const root = realpathSync(makeTempDir('interactive-host-uninstall'));
  try {
    const captured = capture();
    const status = await runHostCommand(
      hostInvocation(root, {
        action: 'uninstall',
        host: 'claude',
        json: true,
        interactive: false,
      }),
      captured.output,
    );
    assert.equal(status, 0, captured.read().stderr);
    const value = JSON.parse(captured.read().stdout) as { schema: string };
    assert.equal(value.schema, 'pappra/host-uninstall/1');
    assert.doesNotMatch(captured.read().stdout, /plan only/);
  } finally {
    cleanup(root);
  }
});

test('host mcp install asks before writing and writes the plan on yes', async () => {
  const root = realpathSync(makeTempDir('interactive-host-mcp'));
  try {
    const declined = capture();
    const no = new FakeWizardUi({ confirm: [false] });
    const declinedStatus = await runHostCommand(
      hostInvocation(root, {
        action: 'mcp',
        subAction: 'install',
        host: 'claude',
      }),
      declined.output,
      { ui: no, progress: silentProgress },
    );
    assert.equal(declinedStatus, 0, declined.read().stderr);
    assert.equal(no.calls[0]?.kind, 'confirm');
    assert.equal(
      no.calls[0]?.message,
      'Write the claude MCP configuration now?',
    );
    assert.equal(no.calls[0]?.initialValue, true);
    assert.match(declined.read().stdout, /Nothing was applied\.\n/);
    assert.equal(existsSync(join(root, '.mcp.json')), false);

    const accepted = capture();
    const yes = new FakeWizardUi({ confirm: [true] });
    const acceptedStatus = await runHostCommand(
      hostInvocation(root, {
        action: 'mcp',
        subAction: 'install',
        host: 'claude',
      }),
      accepted.output,
      { ui: yes, progress: silentProgress },
    );
    assert.equal(acceptedStatus, 0, accepted.read().stderr);
    assert.equal(existsSync(join(root, '.mcp.json')), true);
  } finally {
    cleanup(root);
  }
});

test('resume asks for a saved task when the id is missing', async () => {
  const root = makeWorkspace('interactive-resume');
  try {
    const service = new CheckpointService(root);
    const first = await service.save({
      taskId: 'task-one',
      objective: 'First saved task',
      acceptance: ['Report written'],
      authorSession: null,
      contextCompleteness: 'complete',
      nativeRefs: [],
    });
    assert.equal(first.ok, true, first.diagnostics[0]?.message);
    const second = await service.save({
      taskId: 'task-two',
      objective: 'Second saved task',
      acceptance: ['Report written'],
      authorSession: null,
      contextCompleteness: 'complete',
      nativeRefs: [],
    });
    assert.equal(second.ok, true, second.diagnostics[0]?.message);

    const captured = capture();
    const ui = new FakeWizardUi({ select: ['task-two'] });
    await runResumeCommand(
      {
        cwd: root,
        json: false,
        taskId: null,
        currentSession: null,
        interactive: true,
      },
      captured.output,
      { ui },
    );
    assert.equal(ui.calls.length, 1);
    assert.equal(ui.calls[0]?.kind, 'select');
    assert.deepEqual(
      (ui.calls[0]?.options ?? []).map((option) => option.value).sort(),
      ['task-one', 'task-two'],
    );
    assert.deepEqual(
      (ui.calls[0]?.options ?? []).map((option) => option.hint).sort(),
      ['First saved task', 'Second saved task'],
    );
    assert.match(captured.read().stdout, /Task: task-two\n/);
  } finally {
    cleanup(root);
  }
});

test('resume uses the only saved task without asking', async () => {
  const root = makeWorkspace('interactive-resume-single');
  try {
    const saved = await new CheckpointService(root).save({
      taskId: 'task-one',
      objective: 'Only saved task',
      acceptance: ['Report written'],
      authorSession: null,
      contextCompleteness: 'complete',
      nativeRefs: [],
    });
    assert.equal(saved.ok, true, saved.diagnostics[0]?.message);
    const captured = capture();
    const ui = new FakeWizardUi({});
    await runResumeCommand(
      {
        cwd: root,
        json: false,
        taskId: null,
        currentSession: null,
        interactive: true,
      },
      captured.output,
      { ui },
    );
    assert.equal(ui.calls.length, 0);
    assert.match(captured.read().stdout, /Task: task-one\n/);
  } finally {
    cleanup(root);
  }
});

test('resume reports that no task is saved yet', async () => {
  const root = makeWorkspace('interactive-resume-empty');
  try {
    const captured = capture();
    const ui = new FakeWizardUi({});
    const status = await runResumeCommand(
      {
        cwd: root,
        json: false,
        taskId: null,
        currentSession: null,
        interactive: true,
      },
      captured.output,
      { ui },
    );
    assert.equal(status, 1);
    assert.equal(ui.calls.length, 0);
    assert.equal(
      captured.read().stderr,
      'No saved tasks yet. Save one with pappra checkpoint --task <id>.\n',
    );
  } finally {
    cleanup(root);
  }
});

test('code cancel reports that nothing was done and exits 0', async () => {
  const root = makeWorkspace('interactive-code-cancel', {
    repositories: [
      { id: 'app', path: 'app', access: 'write' },
      { id: 'tools', path: 'tools', access: 'read' },
    ],
  });
  try {
    createRepository(join(root, 'app'));
    createRepository(join(root, 'tools'));
    const captured = capture();
    const ui = new FakeWizardUi({ select: [Symbol('cancel')] });
    const status = await runCodeCommand(codeOptions(root), captured.output, {
      ui,
    });
    assert.equal(status, 0, captured.read().stderr);
    assert.equal(
      captured.read().stdout,
      'Nothing selected; nothing was done.\n',
    );
    assert.equal(captured.read().stderr, '');
  } finally {
    cleanup(root);
  }
});

test('host cancel reports that nothing was done and exits 0', async () => {
  const root = realpathSync(makeTempDir('interactive-host-cancel'));
  try {
    const captured = capture();
    const ui = new FakeWizardUi({ select: [Symbol('cancel')] });
    const status = await runHostCommand(hostInvocation(root), captured.output, {
      ui,
    });
    assert.equal(status, 0, captured.read().stderr);
    assert.equal(
      captured.read().stdout,
      'Nothing selected; nothing was done.\n',
    );
    assert.equal(captured.read().stderr, '');
  } finally {
    cleanup(root);
  }
});

test('resume cancel reports that nothing was done and exits 0', async () => {
  const root = makeWorkspace('interactive-resume-cancel');
  try {
    const service = new CheckpointService(root);
    for (const taskId of ['task-one', 'task-two']) {
      const saved = await service.save({
        taskId,
        objective: `Saved ${taskId}`,
        acceptance: ['Report written'],
        authorSession: null,
        contextCompleteness: 'complete',
        nativeRefs: [],
      });
      assert.equal(saved.ok, true, saved.diagnostics[0]?.message);
    }
    const captured = capture();
    const ui = new FakeWizardUi({ select: [Symbol('cancel')] });
    const status = await runResumeCommand(
      {
        cwd: root,
        json: false,
        taskId: null,
        currentSession: null,
        interactive: true,
      },
      captured.output,
      { ui },
    );
    assert.equal(status, 0, captured.read().stderr);
    assert.equal(
      captured.read().stdout,
      'Nothing selected; nothing was done.\n',
    );
    assert.equal(captured.read().stderr, '');
  } finally {
    cleanup(root);
  }
});

test('docs scan plan hides apply-time guidance until it is applied', async () => {
  const root = makeWorkspace('interactive-docs-private', {
    knowledge: {
      sources: ['AGENTS.md'],
      newDocuments: 'knowledge',
      taskVisibility: 'private',
    },
  });
  try {
    writeText(join(root, 'AGENTS.md'), '# Agents\n');

    const declined = capture();
    const status = await runDocsCommand(docsOptions(root), declined.output, {
      ui: new FakeWizardUi({ confirm: [false] }),
    });
    assert.equal(status, 0, declined.read().stderr);
    assert.match(declined.read().stdout, /Scan candidates: 1\n/);
    assert.doesNotMatch(declined.read().stdout, /after applying/i);
    assert.match(declined.read().stdout, /Nothing was applied\.\n/);

    const planned = capture();
    await runDocsCommand(
      docsOptions(root, { interactive: false }),
      planned.output,
    );
    assert.equal(
      planned.read().stdout,
      'Scan candidates: 1\n' +
        '  rule  AGENTS.md\n' +
        'Rerun with --apply to register these documents in the knowledge catalog.\n' +
        'After applying, review private documents with: pappra docs list --include-private.\n' +
        'Plan only; rerun with --apply to register them.\n',
    );

    const accepted = capture();
    const acceptedStatus = await runDocsCommand(
      docsOptions(root),
      accepted.output,
      { ui: new FakeWizardUi({ confirm: [true] }) },
    );
    assert.equal(acceptedStatus, 0, accepted.read().stderr);
    const output = accepted.read().stdout;
    assert.match(output, /Registered 1 document\(s\)\.\n/);
    assert.doesNotMatch(output, /after applying/i);
    assert.ok(
      output.indexOf('Review registered private documents with:') >
        output.indexOf('Registered 1 document(s).'),
    );
  } finally {
    cleanup(root);
  }
});

test('host mcp install does not ask when the entry is already registered', async () => {
  const root = realpathSync(makeTempDir('interactive-host-mcp-unchanged'));
  try {
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: { pappra: { command: 'pappra', args: ['mcp'] } },
      }),
    );
    const captured = capture();
    const ui = new FakeWizardUi({});
    const status = await runHostCommand(
      hostInvocation(root, {
        action: 'mcp',
        subAction: 'install',
        host: 'claude',
      }),
      captured.output,
      { ui, progress: silentProgress },
    );
    assert.equal(status, 0, captured.read().stderr);
    assert.equal(ui.calls.length, 0);
    assert.match(captured.read().stdout, /Host claude MCP: unchanged\n/);
    assert.doesNotMatch(captured.read().stdout, /Nothing was applied/);
  } finally {
    cleanup(root);
  }
});

test('host mcp install reports a conflict without asking and names --force', async () => {
  const root = realpathSync(makeTempDir('interactive-host-mcp-conflict'));
  try {
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: { pappra: { command: 'different', args: [] } },
      }),
    );
    const captured = capture();
    const ui = new FakeWizardUi({});
    const status = await runHostCommand(
      hostInvocation(root, {
        action: 'mcp',
        subAction: 'install',
        host: 'claude',
      }),
      captured.output,
      { ui, progress: silentProgress },
    );
    assert.equal(status, 1);
    assert.equal(ui.calls.length, 0);
    assert.match(captured.read().stdout, /Host claude MCP: conflict\n/);
    assert.match(
      captured.read().stdout,
      /Pass --force explicitly to replace the existing entry\.\n/,
    );
  } finally {
    cleanup(root);
  }
});

test('host picker never shows a caller-supplied version for another host', async () => {
  const root = realpathSync(makeTempDir('interactive-host-version'));
  try {
    const captured = capture();
    const ui = new FakeWizardUi({ select: ['claude'] });
    const status = await runHostCommand(
      hostInvocation(root, { hostVersion: '0.163.0' }),
      captured.output,
      { ui },
    );
    assert.equal(status, 0, captured.read().stderr);
    const hints = (ui.calls[0]?.options ?? []).map((option) => option.hint);
    assert.equal(hints.length, 3);
    for (const hint of hints) {
      assert.ok(hint === 'installed' || hint === 'not installed', String(hint));
    }
    assert.equal(hints.includes('0.163.0'), false);
  } finally {
    cleanup(root);
  }
});
