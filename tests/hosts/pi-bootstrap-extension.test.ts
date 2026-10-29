import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  lstatSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after } from 'node:test';
import { buildMessage } from '../../src/collab/envelope.js';
import { bindNative } from '../../src/collab/lifecycle.js';
import { submitMessage } from '../../src/collab/messages.js';
import { claimResources, releaseClaim } from '../../src/collab/resources.js';
import * as rollover from '../../src/collab/rollover.js';
import { initTask, readRecord, transact } from '../../src/collab/store.js';
import type {
  Identity,
  Message,
  MessageInput,
  RolloverIntent,
} from '../../src/collab/types.js';
import {
  PI_BOOTSTRAP_CONFIG_SCHEMA,
  readPiBootstrapConfig,
} from '../../src/hosts/integration/bootstrap-config.js';
import { exportHostPluginBundle } from '../../src/hosts/integration/bundle-export.js';

/**
 * The repository root is located from the working directory so this file also runs when it
 * is compiled into an isolated layout. It requires a built `dist` (the normal pretest
 * contract), because the exported runtime is the real generated artifact.
 */
function repoRoot(): string {
  let current = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    if (
      existsSync(join(current, 'tsconfig.test.json')) &&
      existsSync(join(current, 'package.json'))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('Could not locate the repository root.');
}
const ROOT = repoRoot();
const DIST = join(ROOT, 'dist');
const ARTIFACT = join(DIST, 'hosts/integration/pappra-bootstrap-extension.mjs');
const CLI = join(DIST, 'cli/main.js');
const PACKAGE_VERSION = '0.1.0-beta.14';

const TMP = realpathSync(
  mkdtempSync(join(tmpdir(), 'pappra-bootstrap-export-')),
);
after(() => rmSync(TMP, { recursive: true, force: true }));

const sha = (path: string): string =>
  `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;

const TASK = 'sample';
const SUBTASK = 'work';
const INPUT = `sha256:${'1'.repeat(64)}`;
const COORD: Identity = {
  agent_id: 'coordinator',
  session_id: 'coord-session',
  harness: 'pi',
};
const OLD: Identity = {
  agent_id: 'writer-a',
  session_id: 'session-a',
  harness: 'pi',
};
const NEXT: Identity = {
  agent_id: 'writer-b',
  session_id: 'session-b',
  harness: 'pi',
};

interface TaskFixture {
  readonly base: string;
  readonly domainRoot: string;
  readonly taskRoot: string;
  readonly intent: RolloverIntent;
  readonly claims: readonly string[];
  readonly successorNative: {
    agent_id: string;
    runner: string;
    session_id: string;
    run_id: string;
    mission_id: string | null;
    evidence_ref: string;
  };
}

function transactOk(
  taskRoot: string,
  purpose: string,
  apply: Parameters<typeof transact>[1]['apply'],
): void {
  const outcome = transact(taskRoot, { actor: 'fixture', purpose, apply });
  assert.equal(outcome.ok, true, `${purpose}: ${JSON.stringify(outcome)}`);
}

function startTask(label: string, complete: boolean): TaskFixture {
  const base = join(TMP, label);
  const domainRoot = join(base, 'domain');
  const taskRoot = join(domainRoot, 'tasks', TASK);
  mkdirSync(domainRoot, { recursive: true });
  initTask(taskRoot, {
    taskId: TASK,
    domainRoot,
    coordinator: { ...COORD, owner_epoch: 1, since: '2026-10-22T00:00:00Z' },
  });
  let clock = Date.parse('2026-10-22T00:00:00Z');
  const tick = (): number => (clock += 1000);
  const send = (input: MessageInput): Message => {
    const message = buildMessage(input, { clock: tick() });
    const outcome = submitMessage(taskRoot, message, { clock: tick() });
    assert.equal(
      outcome.ok,
      true,
      `submit ${input.type}: ${JSON.stringify(outcome)}`,
    );
    return message;
  };
  const claimed = claimResources(taskRoot, {
    resources: [{ kind: 'path', path: join(base, 'work-a') }],
    holder: OLD,
    subtaskId: SUBTASK,
    attempt: 1,
  });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  const claims = claimed.ok
    ? claimed.claims.map((claim) => claim.claim_id)
    : [];
  send({
    message_id: 'msg-assign-work',
    type: 'ASSIGN',
    task_id: TASK,
    from: COORD,
    to: OLD,
    subtask_id: SUBTASK,
    attempt: 1,
    owner_epoch: 1,
    body: {
      assignment_digest: `sha256:${'a'.repeat(64)}`,
      input_revision: INPUT,
    },
  });
  transactOk(taskRoot, 'bind-source-native', (record) => {
    const bound = bindNative(record, {
      subtaskId: SUBTASK,
      attempt: 1,
      runner: 'pi',
      sessionId: OLD.session_id,
      runId: 'run-source',
      missionId: null,
      observation: 'confirmed',
      evidenceRef: 'herdr:agent:w3:p3:settled',
      observedAt: '2026-10-22T00:30:00Z',
    });
    if (!bound.ok) return bound as never;
    return { record, op: 'bind-source-native', summary: {}, result: bound };
  });
  const before = readRecord(taskRoot);
  assert.ok(before);
  const epochs = new Map(
    (before.claims ?? []).map((claim) => [
      claim.claim_id,
      claim.resource_epoch ?? 0,
    ]),
  );
  transactOk(taskRoot, 'create-rollover-intent', (record) => {
    const created = rollover.createRolloverIntent(record, {
      intent_id: 'intent-1',
      generation: 1,
      handoff_id: 'handoff-1',
      subtask_id: SUBTASK,
      attempt: 1,
      input_revision: INPUT,
      from: OLD,
      to: NEXT,
      claims: claims.map((claimId) => ({
        claim_id: claimId,
        resource_epoch: epochs.get(claimId) ?? 0,
      })),
      bundle: {
        ref: 'handoff-bundles/bundle-1.json',
        digest: `sha256:${'b'.repeat(64)}`,
      },
      coordinator_epoch: 1,
      clock: Date.parse('2026-10-22T01:00:00Z'),
    });
    if (!created.ok) return created as never;
    return {
      record,
      op: 'create-rollover-intent',
      summary: {},
      result: created,
    };
  });
  const successorNative = {
    agent_id: NEXT.agent_id,
    runner: 'pi',
    session_id: NEXT.session_id,
    run_id: 'run-successor',
    mission_id: null,
    evidence_ref: 'herdr:agent:w4:p2',
  };
  if (complete) {
    transactOk(taskRoot, 'prepare-rollover', (record) => {
      const prepared = rollover.prepareRolloverTransfer(record, {
        intent_id: 'intent-1',
        observation: 'confirmed',
        evidence_ref: 'herdr:agent:w3:p3:settled',
        inventory: {
          completeness: 'complete',
          inflight: [],
          pending_approvals: [],
          pending_messages: [],
        },
        clock: Date.parse('2026-10-22T01:00:01Z'),
      });
      if (!prepared.ok) return prepared as never;
      return { record, op: 'prepare-rollover', summary: {}, result: prepared };
    });
    const ack = send({
      message_id: 'msg-ack-successor',
      type: 'ACK',
      task_id: TASK,
      from: NEXT,
      to: COORD,
      reply_to: 'msg-assign-work',
      subtask_id: SUBTASK,
      attempt: 1,
      owner_epoch: 1,
      body: {
        handoff_id: 'handoff-1',
        rollover_intent_id: 'intent-1',
        rollover_generation: 1,
        input_revision: INPUT,
      },
    });
    transactOk(taskRoot, 'confirm-rollover', (record) => {
      const confirmed = rollover.confirmRolloverReceiver(record, {
        intent_id: 'intent-1',
        message: ack,
        clock: Date.parse('2026-10-22T01:00:02Z'),
      });
      if (!confirmed.ok) return confirmed as never;
      return { record, op: 'confirm-rollover', summary: {}, result: confirmed };
    });
    transactOk(taskRoot, 'complete-rollover', (record) => {
      const completed = rollover.completeRolloverTransfer(record, {
        intent_id: 'intent-1',
        successor_native: successorNative,
        clock: Date.parse('2026-10-22T01:00:05Z'),
      });
      if (!completed.ok) return completed as never;
      return {
        record,
        op: 'complete-rollover',
        summary: {},
        result: completed,
      };
    });
  }
  const record = readRecord(taskRoot);
  assert.ok(record);
  const intent = (record.rollover ?? []).find(
    (item) => item.intent_id === 'intent-1',
  );
  assert.ok(intent);
  return { base, domainRoot, taskRoot, intent, claims, successorNative };
}

function configValue(fixture: TaskFixture): Record<string, unknown> {
  return {
    schema: PI_BOOTSTRAP_CONFIG_SCHEMA,
    domainRoot: fixture.domainRoot,
    taskId: TASK,
    guard: {
      taskId: TASK,
      intentId: fixture.intent.intent_id,
      handoffId: fixture.intent.handoff_id,
      generation: fixture.intent.generation,
      subtaskId: fixture.intent.subtask_id,
      attempt: fixture.intent.attempt,
      inputRevision: fixture.intent.input_revision,
      coordinatorEpoch: fixture.intent.coordinator_epoch,
      successor: {
        agentId: fixture.successorNative.agent_id,
        sessionId: fixture.successorNative.session_id,
        harness: fixture.successorNative.runner,
      },
      claims: fixture.intent.claims.map((claim) => ({
        claimId: claim.claim_id,
        originalResourceEpoch: claim.resource_epoch,
      })),
    },
  };
}

function writeConfig(path: string, value: unknown): string {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

interface FakeHost {
  readonly pi: unknown;
  callTool(
    tool: string,
    sessionId: string | null,
  ): Promise<{ block: boolean; reason?: string } | null>;
  runStatus(): Record<string, unknown>;
  commands(): string[];
}

/**
 * A faithful structural Pi API boundary: `on`/`registerCommand` only, tool handlers receive
 * a context with the live session id, and the status command is invoked through its handler.
 */
function fakeHost(
  options: {
    readonly failCommand?: string;
    readonly failError?: () => unknown;
  } = {},
): FakeHost {
  const toolHandlers: ((
    event: unknown,
    context: unknown,
  ) =>
    | { block: boolean; reason?: string }
    | undefined
    | Promise<{ block: boolean; reason?: string } | undefined>)[] = [];
  const commands = new Map<
    string,
    { description: string; handler: (args: string, context: unknown) => void }
  >();
  let captured: string | null = null;
  const context = (sessionId: string | null) => ({
    sessionManager: {
      getSessionId: () => (sessionId === null ? undefined : sessionId),
    },
    ui: { notify: (message: string) => (captured = message) },
  });
  const pi = {
    on: (event: string, handler: (typeof toolHandlers)[number]) => {
      if (event === 'tool_call') toolHandlers.push(handler);
    },
    registerCommand: (
      name: string,
      command: {
        description: string;
        handler: (args: string, context: unknown) => void;
      },
    ) => {
      if (options.failCommand === name)
        throw options.failError === undefined
          ? new Error(`command registration refused: ${name}`)
          : options.failError();
      commands.set(name, command);
    },
  };
  return {
    pi,
    async callTool(tool, sessionId) {
      for (const handler of toolHandlers) {
        const outcome = await handler(
          { toolName: tool, input: {} },
          context(sessionId),
        );
        if (outcome !== undefined && outcome.block)
          return { block: true, reason: String(outcome.reason ?? '') };
      }
      return null;
    },
    runStatus() {
      const command = commands.get('bootstrap-status');
      assert.ok(command, 'bootstrap-status must be registered');
      captured = null;
      command.handler('', context(null));
      assert.ok(captured, 'status command must report');
      return JSON.parse(captured) as Record<string, unknown>;
    },
    commands() {
      return [...commands.keys()];
    },
  };
}

async function loadBundle(bundleDir: string): Promise<(pi: unknown) => void> {
  const runtime = join(bundleDir, 'extensions/pappra-bootstrap/runtime.mjs');
  const module = (await import(
    `${pathToFileURL(runtime).href}?case=${Math.random().toString(36).slice(2)}`
  )) as { default: (pi: unknown) => void };
  return module.default;
}

function copyBundle(source: string, label: string): string {
  const target = join(TMP, `case-${label}`);
  cpSync(source, target, { recursive: true });
  return target;
}

async function exportBundle(
  fixture: TaskFixture,
  label: string,
): Promise<string> {
  const configFile = writeConfig(
    join(TMP, `${label}.json`),
    configValue(fixture),
  );
  const loaded = readPiBootstrapConfig(configFile);
  if (!loaded.ok) assert.fail(JSON.stringify(loaded));
  const outDir = join(TMP, `bundle-${label}`);
  const exported = await exportHostPluginBundle({
    host: 'pi',
    hostVersion: '1.3.0',
    outDir,
    packageVersion: PACKAGE_VERSION,
    bootstrap: {
      config: loaded.config,
      configBytes: loaded.bytes,
      configDigest: loaded.digest,
      artifactPath: ARTIFACT,
    },
  });
  assert.equal(exported.bootstrap?.registeredByExport, false);
  return exported.outDir;
}

function runCli(args: readonly string[]): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: TMP,
    encoding: 'utf8',
    shell: false,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function parse(result: { readonly stdout: string }): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

test('the built bootstrap artifact is present', () => {
  assert.ok(
    existsSync(ARTIFACT),
    'dist/hosts/integration/pappra-bootstrap-extension.mjs must exist; build first',
  );
  assert.ok(existsSync(CLI), 'dist/cli/main.js must exist; build first');
});

test('config validation refuses unsafe input before any output', () => {
  const fixture = startTask('config', false);
  const validFile = writeConfig(join(TMP, 'valid.json'), configValue(fixture));
  const loaded = readPiBootstrapConfig(validFile);
  if (!loaded.ok) assert.fail(JSON.stringify(loaded));
  assert.equal(loaded.config.domainRoot, fixture.domainRoot);
  assert.equal(loaded.taskRoot, fixture.taskRoot);
  assert.match(loaded.digest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(loaded.bytes.length > 0);

  const missing = readPiBootstrapConfig(join(TMP, 'missing.json'));
  assert.equal(missing.ok === false && missing.code, 'config_unreadable');

  const link = join(TMP, 'config-link.json');
  symlinkSync(validFile, link);
  const linked = readPiBootstrapConfig(link);
  assert.equal(linked.ok === false && linked.code, 'config_symlink_refused');

  const huge = join(TMP, 'huge.json');
  writeFileSync(huge, JSON.stringify({ padding: 'x'.repeat(70 * 1024) }));
  const oversized = readPiBootstrapConfig(huge);
  assert.equal(oversized.ok === false && oversized.code, 'config_too_large');

  const malformed = join(TMP, 'malformed.json');
  writeFileSync(malformed, '{not json');
  const invalidJson = readPiBootstrapConfig(malformed);
  assert.equal(
    invalidJson.ok === false && invalidJson.code,
    'config_invalid_json',
  );

  const unknownKey = writeConfig(join(TMP, 'unknown.json'), {
    ...configValue(fixture),
    extra: true,
  });
  const keyed = readPiBootstrapConfig(unknownKey);
  assert.equal(keyed.ok === false && keyed.code, 'config_schema_invalid');

  const relativeRoot = writeConfig(join(TMP, 'relative.json'), {
    ...configValue(fixture),
    domainRoot: 'domain',
  });
  const relative = readPiBootstrapConfig(relativeRoot);
  assert.equal(
    relative.ok === false && relative.code,
    'config_domain_root_invalid',
  );

  const alias = join(TMP, 'domain-alias');
  symlinkSync(fixture.domainRoot, alias);
  const symlinkedRoot = writeConfig(join(TMP, 'symlinked-root.json'), {
    ...configValue(fixture),
    domainRoot: alias,
  });
  const redirected = readPiBootstrapConfig(symlinkedRoot);
  assert.equal(
    redirected.ok === false && redirected.code,
    'config_domain_root_invalid',
  );

  const missingTask = writeConfig(join(TMP, 'missing-task.json'), {
    ...configValue(fixture),
    taskId: 'absent-task',
    guard: {
      ...(configValue(fixture)['guard'] as object),
      taskId: 'absent-task',
    },
  });
  const noTask = readPiBootstrapConfig(missingTask);
  assert.equal(noTask.ok === false && noTask.code, 'config_task_root_invalid');

  const mismatched = writeConfig(join(TMP, 'mismatched.json'), {
    ...configValue(fixture),
    guard: {
      ...(configValue(fixture)['guard'] as object),
      taskId: 'other-task',
    },
  });
  const guardMismatch = readPiBootstrapConfig(mismatched);
  assert.equal(
    guardMismatch.ok === false && guardMismatch.code,
    'config_guard_invalid',
  );

  const duplicateClaims = configValue(fixture);
  const guard = duplicateClaims['guard'] as {
    claims: { claimId: string; originalResourceEpoch: number }[];
  };
  guard.claims = [...guard.claims, ...guard.claims];
  const duplicated = readPiBootstrapConfig(
    writeConfig(join(TMP, 'duplicate-claims.json'), duplicateClaims),
  );
  assert.equal(
    duplicated.ok === false && duplicated.code,
    'config_claims_invalid',
  );
});

test('export writes a private relative bundle and refuses existing output', async () => {
  const fixture = startTask('export', true);
  const outDir = await exportBundle(fixture, 'export');
  const files = readdirSync(outDir, { recursive: true })
    .map(String)
    .filter((path) => {
      try {
        return statSync(join(outDir, path)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
  assert.ok(files.includes('package.json'));
  assert.ok(files.includes('extensions/pappra-bootstrap/index.ts'));
  assert.ok(files.includes('extensions/pappra-bootstrap/runtime.mjs'));
  assert.ok(files.includes('extensions/pappra-bootstrap/bootstrap.json'));
  assert.ok(files.some((path) => path.startsWith('skills/pappra/')));
  assert.equal(statSync(outDir).mode & 0o777, 0o700);
  assert.equal(
    statSync(join(outDir, 'extensions/pappra-bootstrap/bootstrap.json')).mode &
      0o777,
    0o600,
  );
  assert.deepEqual(
    readFileSync(join(outDir, 'extensions/pappra-bootstrap/runtime.mjs')),
    readFileSync(ARTIFACT),
  );
  const manifest = JSON.parse(
    readFileSync(join(outDir, 'package.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.deepEqual((manifest['pi'] as Record<string, unknown>)['extensions'], [
    './extensions/pappra-bootstrap/index.ts',
  ]);
  for (const file of [
    'package.json',
    'extensions/pappra-bootstrap/index.ts',
    'extensions/pappra-bootstrap/runtime.mjs',
  ]) {
    const content = readFileSync(join(outDir, file), 'utf8');
    assert.equal(
      content.includes(ROOT),
      false,
      `${file} must not embed the checkout`,
    );
  }
  const config = JSON.parse(
    readFileSync(
      join(outDir, 'extensions/pappra-bootstrap/bootstrap.json'),
      'utf8',
    ),
  ) as Record<string, unknown>;
  assert.equal(config['domainRoot'], fixture.domainRoot);

  const existing = join(TMP, 'existing-out');
  mkdirSync(existing);
  const sentinel = join(existing, 'user-file.txt');
  writeFileSync(sentinel, 'user content\n');
  const before = sha(sentinel);
  const loaded = readPiBootstrapConfig(
    writeConfig(join(TMP, 'existing.json'), configValue(fixture)),
  );
  if (!loaded.ok) assert.fail(JSON.stringify(loaded));
  await assert.rejects(
    exportHostPluginBundle({
      host: 'pi',
      hostVersion: '1.3.0',
      outDir: existing,
      packageVersion: PACKAGE_VERSION,
      bootstrap: {
        config: loaded.config,
        configBytes: loaded.bytes,
        configDigest: loaded.digest,
        artifactPath: ARTIFACT,
      },
    }),
  );
  assert.equal(sha(sentinel), before);
  assert.deepEqual(readdirSync(existing), ['user-file.txt']);
});

test('ordinary Pi bundles keep their file set and source bytes without the flag', async () => {
  const outDir = join(TMP, 'ordinary');
  const exported = await exportHostPluginBundle({
    host: 'pi',
    hostVersion: '1.3.0',
    outDir,
    packageVersion: PACKAGE_VERSION,
  });
  assert.deepEqual(exported.files, [
    'extensions/pappra/index.ts',
    'extensions/pappra/runtime.mjs',
    'hooks/pappra-hook.mjs',
    'package.json',
    'skills/pappra/references/collaboration.md',
    'skills/pappra/references/environment.md',
    'skills/pappra/references/hosts.md',
    'skills/pappra/references/lifecycle.md',
    'skills/pappra/references/operations.md',
    'skills/pappra/references/workflow.md',
    'skills/pappra/SKILL.md',
  ]);
  assert.equal(existsSync(join(outDir, 'extensions/pappra-bootstrap')), false);
  assert.deepEqual(
    readFileSync(join(outDir, 'extensions/pappra/runtime.mjs')),
    readFileSync(join(DIST, 'hosts/integration/pappra-extension-runtime.mjs')),
  );
  assert.deepEqual(
    readFileSync(join(outDir, 'hooks/pappra-hook.mjs')),
    readFileSync(join(DIST, 'hosts/integration/pappra-hook.mjs')),
  );
  assert.equal(
    'bootstrap' in (exported as unknown as Record<string, unknown>),
    false,
  );
});

test('a missing or malformed loaded config keeps a persistent default deny', async () => {
  const fixture = startTask('deny', true);
  const valid = await exportBundle(fixture, 'deny');

  const deleted = copyBundle(valid, 'deleted');
  rmSync(join(deleted, 'extensions/pappra-bootstrap/bootstrap.json'));
  const deletedHost = fakeHost();
  (await loadBundle(deleted))(deletedHost.pi);
  for (const tool of ['bash', 'write', 'unknown-tool']) {
    const blocked = await deletedHost.callTool(tool, NEXT.session_id);
    assert.equal(blocked?.block, true, `${tool} must stay blocked`);
    assert.match(String(blocked?.reason), /config_unreadable/);
  }
  const status = deletedHost.runStatus();
  assert.equal(status['state'], 'denied');
  assert.equal(status['registered'], false);
  assert.equal(status['write_permitted'], 'not-asserted');
  assert.equal(status['mode'], 'default-deny');
  assert.match(String(status['reason']), /config_unreadable/);
  assert.equal(deletedHost.commands().includes('bootstrap-status'), true);
  assert.equal(
    deletedHost
      .commands()
      .some((name) => /allow|thaw|release|unfreeze/i.test(name)),
    false,
  );

  const corrupt = copyBundle(valid, 'corrupt');
  writeFileSync(
    join(corrupt, 'extensions/pappra-bootstrap/bootstrap.json'),
    '{broken',
  );
  const corruptHost = fakeHost();
  (await loadBundle(corrupt))(corruptHost.pi);
  const blocked = await corruptHost.callTool('bash', NEXT.session_id);
  assert.equal(blocked?.block, true);
  assert.match(String(blocked?.reason), /config_invalid_json/);

  const unknown = copyBundle(valid, 'unknown');
  const configPath = join(
    unknown,
    'extensions/pappra-bootstrap/bootstrap.json',
  );
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<
    string,
    unknown
  >;
  writeFileSync(configPath, JSON.stringify({ ...config, extra: 1 }));
  const unknownHost = fakeHost();
  (await loadBundle(unknown))(unknownHost.pi);
  const keyed = await unknownHost.callTool('bash', NEXT.session_id);
  assert.equal(keyed?.block, true);
  assert.match(String(keyed?.reason), /config_schema_invalid/);

  const goneFixture = startTask('deny-gone', true);
  const gone = await exportBundle(goneFixture, 'deny-gone');
  rmSync(goneFixture.taskRoot, { recursive: true, force: true });
  const goneHost = fakeHost();
  (await loadBundle(gone))(goneHost.pi);
  const missingRoot = await goneHost.callTool('bash', NEXT.session_id);
  assert.equal(missingRoot?.block, true);
  assert.match(
    String(missingRoot?.reason),
    /config_task_root_invalid|config_domain_root_invalid/,
  );
});

test('lifecycle initialization failure keeps denial and reports denied status', async () => {
  const fixture = startTask('lifecycle', true);
  const bundle = await exportBundle(fixture, 'lifecycle');
  const host = fakeHost({ failCommand: 'pappra-checkpoint' });
  (await loadBundle(bundle))(host.pi);
  const blocked = await host.callTool('bash', NEXT.session_id);
  assert.equal(blocked?.block, true);
  assert.match(String(blocked?.reason), /command registration refused/);
  const status = host.runStatus();
  assert.equal(status['state'], 'denied');
  assert.equal(status['registered'], false);
  assert.equal(status['write_permitted'], 'not-asserted');
});

test('a completed transfer allows the pinned successor and drift denies again', async () => {
  const fixture = startTask('gate', true);
  const bundle = await exportBundle(fixture, 'gate');
  const host = fakeHost();
  (await loadBundle(bundle))(host.pi);

  const allowed = await host.callTool('bash', NEXT.session_id);
  assert.equal(allowed, null);
  const wrongSession = await host.callTool('bash', OLD.session_id);
  assert.equal(wrongSession?.block, true);
  assert.match(
    String(wrongSession?.reason),
    /native_session_unknown_or_mismatch/,
  );

  const status = host.runStatus();
  assert.equal(status['state'], 'registered');
  assert.equal(status['registered'], true);
  assert.equal(status['write_permitted'], 'not-asserted');
  assert.equal(status['mode'], 'deny-until-completed-transfer');
  assert.equal(status['taskId'], TASK);
  assert.match(String(status['config_digest']), /^sha256:[0-9a-f]{64}$/);
  const guard = status['guard'] as Record<string, unknown>;
  assert.equal(guard['schema'], 'pappra/pi-bootstrap-guard-status/1');
  assert.equal(guard['pinnedClaimCount'], fixture.claims.length);

  const released = releaseClaim(fixture.taskRoot, {
    claimId: fixture.claims[0] as string,
    holder: NEXT,
    reason: 'fixture drift',
  });
  assert.equal(released.ok, true, JSON.stringify(released));
  const drifted = await host.callTool('bash', NEXT.session_id);
  assert.equal(drifted?.block, true);
  assert.match(String(drifted?.reason), /claim_released|claim_not_held/);
  // Registration is not permission: the drift denies the call, not the status.
  assert.equal(host.runStatus()['state'], 'registered');

  const commands = host.commands();
  assert.ok(commands.includes('bootstrap-status'));
  assert.equal(
    commands.some((name) => /allow|thaw|release|unfreeze/i.test(name)),
    false,
  );
});

test('a pre-transfer record is a valid export input but the gate still denies', async () => {
  const fixture = startTask('pre-transfer', false);
  const bundle = await exportBundle(fixture, 'pre-transfer');
  const host = fakeHost();
  (await loadBundle(bundle))(host.pi);
  const blocked = await host.callTool('bash', NEXT.session_id);
  assert.equal(blocked?.block, true);
  assert.match(
    String(blocked?.reason),
    /handoff_not_completed|ambiguous_or_missing/,
  );
  assert.equal(host.runStatus()['state'], 'registered');
});

test('the CLI rejects wrong flags, hosts and configs before writing', () => {
  const fixture = startTask('cli', true);
  const valid = writeConfig(join(TMP, 'cli-valid.json'), configValue(fixture));
  const newOut = (label: string): string => join(TMP, `cli-out-${label}`);

  const wrongHost = runCli([
    'host',
    'bundle',
    '--host',
    'claude',
    '--host-version',
    '2.1.292',
    '--out',
    newOut('wrong-host'),
    '--bootstrap-config',
    valid,
    '--json',
  ]);
  assert.equal(wrongHost.status, 2);
  assert.equal(existsSync(newOut('wrong-host')), false);

  const wrongAction = runCli([
    'host',
    'verify',
    '--host',
    'pi',
    '--bootstrap-config',
    valid,
    '--json',
  ]);
  assert.equal(wrongAction.status, 2);

  const marketplace = runCli([
    'host',
    'bundle',
    '--host',
    'pi',
    '--host-version',
    '1.3.0',
    '--out',
    newOut('marketplace'),
    '--bootstrap-config',
    valid,
    '--marketplace',
    '--json',
  ]);
  assert.equal(marketplace.status, 2);
  assert.equal(existsSync(newOut('marketplace')), false);

  const relative = runCli([
    'host',
    'bundle',
    '--host',
    'pi',
    '--host-version',
    '1.3.0',
    '--out',
    newOut('relative'),
    '--bootstrap-config',
    'cli-valid.json',
    '--json',
  ]);
  assert.equal(relative.status, 2);
  assert.equal(existsSync(newOut('relative')), false);

  const missing = runCli([
    'host',
    'bundle',
    '--host',
    'pi',
    '--host-version',
    '1.3.0',
    '--out',
    newOut('missing'),
    '--bootstrap-config',
    join(TMP, 'nope.json'),
    '--json',
  ]);
  assert.equal(missing.status, 1);
  assert.equal(parse(missing)['code'], 'config_unreadable');
  assert.equal(existsSync(newOut('missing')), false);

  const hugePath = join(TMP, 'cli-huge.json');
  writeFileSync(hugePath, JSON.stringify({ padding: 'x'.repeat(70 * 1024) }));
  const oversized = runCli([
    'host',
    'bundle',
    '--host',
    'pi',
    '--host-version',
    '1.3.0',
    '--out',
    newOut('oversized'),
    '--bootstrap-config',
    hugePath,
    '--json',
  ]);
  assert.equal(oversized.status, 1);
  assert.equal(parse(oversized)['code'], 'config_too_large');
  assert.equal(existsSync(newOut('oversized')), false);

  const linkPath = join(TMP, 'cli-link.json');
  symlinkSync(valid, linkPath);
  const linked = runCli([
    'host',
    'bundle',
    '--host',
    'pi',
    '--host-version',
    '1.3.0',
    '--out',
    newOut('link'),
    '--bootstrap-config',
    linkPath,
    '--json',
  ]);
  assert.equal(linked.status, 1);
  assert.equal(parse(linked)['code'], 'config_symlink_refused');
  assert.equal(existsSync(newOut('link')), false);

  const existing = newOut('existing');
  mkdirSync(existing);
  const sentinel = join(existing, 'keep.txt');
  writeFileSync(sentinel, 'keep\n');
  const before = sha(sentinel);
  const rejected = runCli([
    'host',
    'bundle',
    '--host',
    'pi',
    '--host-version',
    '1.3.0',
    '--out',
    existing,
    '--bootstrap-config',
    valid,
    '--json',
  ]);
  assert.equal(rejected.status, 1);
  assert.equal(sha(sentinel), before);
  assert.deepEqual(readdirSync(existing), ['keep.txt']);

  const okOut = newOut('ok');
  const ok = runCli([
    'host',
    'bundle',
    '--host',
    'pi',
    '--host-version',
    '1.3.0',
    '--out',
    okOut,
    '--bootstrap-config',
    valid,
    '--json',
  ]);
  assert.equal(ok.status, 0, ok.stderr);
  const body = parse(ok);
  assert.equal(body['ok'], true);
  const bootstrap = body['bootstrap'] as Record<string, unknown>;
  assert.equal(bootstrap['registeredByExport'], false);
  assert.equal(
    bootstrap['configDigest'],
    sha(join(okOut, 'extensions/pappra-bootstrap/bootstrap.json')),
  );
  assert.equal(statSync(okOut).mode & 0o777, 0o700);
  assert.deepEqual(
    (body['files'] as string[]).every((file) => !file.startsWith('/')),
    true,
  );
});

type FsPatchName = 'rename' | 'lstat' | 'mkdir' | 'writeFile';

async function withPatchedFs<T>(
  patches: Partial<Record<FsPatchName, unknown>>,
  run: () => Promise<T>,
): Promise<T> {
  const fspRecord = fsp as unknown as Record<string, unknown>;
  const originals: Partial<Record<FsPatchName, unknown>> = {};
  for (const [name, replacement] of Object.entries(patches) as [
    FsPatchName,
    unknown,
  ][]) {
    originals[name] = fspRecord[name];
    fspRecord[name] = replacement;
  }
  syncBuiltinESMExports();
  try {
    return await run();
  } finally {
    for (const name of Object.keys(patches) as FsPatchName[])
      fspRecord[name] = originals[name];
    syncBuiltinESMExports();
  }
}

async function exportDirect(
  fixture: TaskFixture,
  label: string,
): Promise<Awaited<ReturnType<typeof exportHostPluginBundle>>> {
  const configFile = writeConfig(
    join(TMP, `${label}.json`),
    configValue(fixture),
  );
  const loaded = readPiBootstrapConfig(configFile);
  if (!loaded.ok) assert.fail(JSON.stringify(loaded));
  return exportHostPluginBundle({
    host: 'pi',
    hostVersion: '1.3.0',
    outDir: join(TMP, label),
    packageVersion: PACKAGE_VERSION,
    bootstrap: {
      config: loaded.config,
      configBytes: loaded.bytes,
      configDigest: loaded.digest,
      artifactPath: ARTIFACT,
    },
  });
}

function stagedLeftovers(): Set<string> {
  return new Set(
    readdirSync(TMP).filter((name) => name.startsWith('.pappra-bootstrap-')),
  );
}

function stageRootOf(target: string): string | null {
  const match = /^(.*\/\.pappra-bootstrap-[^/]+)\//.exec(target);
  return match === null ? null : (match[1] as string);
}

test('an existing empty destination is preserved', async () => {
  const fixture = startTask('empty-dest-fixture', true);
  const out = join(TMP, 'empty-dest-out');
  mkdirSync(out);
  const inode = lstatSync(out).ino;
  const before = stagedLeftovers();
  await assert.rejects(exportDirect(fixture, 'empty-dest-out'));
  assert.equal(lstatSync(out).ino, inode);
  assert.deepEqual(readdirSync(out), []);
  const after = stagedLeftovers();
  assert.deepEqual(
    [...after].filter((name) => !before.has(name)),
    [],
  );
});

test('an existing populated destination is preserved', async () => {
  const fixture = startTask('populated-dest-fixture', true);
  const out = join(TMP, 'populated-dest-out');
  mkdirSync(out);
  writeFileSync(join(out, 'user.txt'), 'user content\n');
  const inode = lstatSync(out).ino;
  await assert.rejects(exportDirect(fixture, 'populated-dest-out'));
  assert.equal(lstatSync(out).ino, inode);
  assert.equal(readFileSync(join(out, 'user.txt'), 'utf8'), 'user content\n');
});

test('a competing empty directory created at the claim is preserved', async () => {
  const fixture = startTask('claim-conflict-fixture', true);
  const out = join(TMP, 'claim-conflict-out');
  const before = stagedLeftovers();
  const originalMkdir = fsp.mkdir as unknown as (
    ...args: unknown[]
  ) => Promise<unknown>;
  const patchedMkdir = async (
    path: unknown,
    options?: unknown,
  ): Promise<unknown> => {
    if (String(path) === out) mkdirSync(out);
    return originalMkdir(path, options);
  };
  await assert.rejects(
    withPatchedFs({ mkdir: patchedMkdir }, () =>
      exportDirect(fixture, 'claim-conflict-out'),
    ),
  );
  assert.equal(lstatSync(out).isDirectory(), true);
  assert.deepEqual(readdirSync(out), []);
  const after = stagedLeftovers();
  assert.deepEqual(
    [...after].filter((name) => !before.has(name)),
    [],
  );
});

test('a claim replaced by another empty directory is detected and retained', async () => {
  const fixture = startTask('claim-substitute-fixture', true);
  const out = join(TMP, 'claim-substitute-out');
  let calls = 0;
  const originalLstat = fsp.lstat as unknown as (
    ...args: unknown[]
  ) => Promise<unknown>;
  const patchedLstat = async (
    path: unknown,
    options?: unknown,
  ): Promise<unknown> => {
    if (String(path) === out) {
      calls += 1;
      // The third lookup is the pre-publication claim verification. Create the
      // replacement while the claim still exists, then move it into place: both
      // directories are alive at the same time, so the replacement is guaranteed a
      // different inode. Remove-then-create can reuse the freed inode on Linux and
      // would make this simulation silently become a no-op.
      if (calls === 3) {
        const substitute = `${out}.substitute`;
        mkdirSync(substitute);
        rmSync(out, { recursive: true, force: true });
        renameSync(substitute, out);
      }
    }
    return originalLstat(path, options);
  };
  await assert.rejects(
    withPatchedFs({ lstat: patchedLstat }, () =>
      exportDirect(fixture, 'claim-substitute-out'),
    ),
  );
  assert.equal(lstatSync(out).isDirectory(), true);
  assert.deepEqual(readdirSync(out), []);
  assert.equal(existsSync(`${out}.substitute`), false);
});

test('staging substitution at the first write is detected before the private binding', async () => {
  const fixture = startTask('stage-first-write-fixture', true);
  const out = join(TMP, 'stage-first-write-out');
  const escaped = join(TMP, 'stage-first-write-escaped');
  mkdirSync(escaped);
  let stagePath: string | null = null;
  const originalWrite = fsp.writeFile as unknown as (
    ...args: unknown[]
  ) => Promise<unknown>;
  const patchedWrite = async (
    target: unknown,
    data: unknown,
    options?: unknown,
  ): Promise<unknown> => {
    const root = stageRootOf(String(target));
    if (stagePath === null && root !== null) {
      stagePath = root;
      rmSync(root, { recursive: true, force: true });
      symlinkSync(escaped, root);
    }
    return originalWrite(target, data, options);
  };
  await assert.rejects(
    withPatchedFs({ writeFile: patchedWrite }, () =>
      exportDirect(fixture, 'stage-first-write-out'),
    ),
  );
  assert.ok(stagePath);
  assert.equal(lstatSync(stagePath).isSymbolicLink(), true);
  assert.equal(
    existsSync(join(escaped, 'extensions/pappra-bootstrap/bootstrap.json')),
    false,
  );
  assert.equal(existsSync(out), false);
  rmSync(stagePath, { force: true });
});

test('a substitution exactly at the private-binding write fails closed without publishing', async () => {
  const fixture = startTask('stage-binding-write-fixture', true);
  const out = join(TMP, 'stage-binding-write-out');
  const escaped = join(TMP, 'stage-binding-write-escaped');
  // Pre-create the destination subdirectory so this injected check/use substitution can
  // actually deliver the write outside; that is the residual portable limit modeled here.
  mkdirSync(join(escaped, 'extensions/pappra-bootstrap'), { recursive: true });
  let stagePath: string | null = null;
  const originalWrite = fsp.writeFile as unknown as (
    ...args: unknown[]
  ) => Promise<unknown>;
  const patchedWrite = async (
    targetPath: unknown,
    data: unknown,
    options?: unknown,
  ): Promise<unknown> => {
    const target = String(targetPath);
    if (stagePath === null && target.endsWith('/bootstrap.json')) {
      const root = stageRootOf(target);
      if (root !== null) {
        stagePath = root;
        rmSync(root, { recursive: true, force: true });
        symlinkSync(escaped, root);
      }
    }
    return originalWrite(targetPath, data, options);
  };
  await assert.rejects(
    withPatchedFs({ writeFile: patchedWrite }, () =>
      exportDirect(fixture, 'stage-binding-write-out'),
    ),
  );
  // Portable Node cannot fence this exact check/use boundary: the write follows the
  // substituted path. The exporter fails closed and never publishes; this is the documented
  // limitation, not a claimed prevention.
  assert.equal(
    existsSync(join(escaped, 'extensions/pappra-bootstrap/bootstrap.json')),
    true,
  );
  assert.equal(existsSync(out), false);
  assert.ok(stagePath);
  assert.equal(lstatSync(stagePath).isSymbolicLink(), true);
  rmSync(stagePath, { force: true });
});

test('cleanup never deletes a substituted staging path', async () => {
  const fixture = startTask('redirect-cleanup-fixture', true);
  const user = join(TMP, 'cleanup-user-tree');
  mkdirSync(user);
  writeFileSync(join(user, 'keep.txt'), 'user data\n');
  let substituted: string | null = null;
  const patchedRename = async (
    fromPath: unknown,
    _toPath: unknown,
  ): Promise<unknown> => {
    const from = String(fromPath);
    rmSync(from, { recursive: true, force: true });
    symlinkSync(user, from);
    substituted = from;
    throw new Error('publish refused');
  };
  await assert.rejects(
    withPatchedFs({ rename: patchedRename }, () =>
      exportDirect(fixture, 'redirect-cleanup-out'),
    ),
  );
  assert.ok(substituted);
  assert.equal(readFileSync(join(user, 'keep.txt'), 'utf8'), 'user data\n');
  assert.equal(lstatSync(substituted).isSymbolicLink(), true);
  rmSync(substituted, { force: true });
});

test('an injected publication failure removes the owned empty claim and allows a retry', async () => {
  const fixture = startTask('publish-retry-fixture', true);
  const out = join(TMP, 'publish-retry-out');
  const before = stagedLeftovers();
  let attempts = 0;
  const patchedRename = async (
    _fromPath: unknown,
    _toPath: unknown,
  ): Promise<unknown> => {
    attempts += 1;
    throw new Error('injected publication failure');
  };
  await assert.rejects(
    withPatchedFs({ rename: patchedRename }, () =>
      exportDirect(fixture, 'publish-retry-out'),
    ),
  );
  assert.equal(attempts, 1);
  // The owned empty claim is removed, so the same path is usable again.
  assert.equal(existsSync(out), false);
  const after = stagedLeftovers();
  assert.deepEqual(
    [...after].filter((name) => !before.has(name)),
    [],
  );

  const exported = await exportDirect(fixture, 'publish-retry-out');
  assert.equal(exported.outDir, out);
  assert.ok(
    existsSync(join(out, 'extensions/pappra-bootstrap/bootstrap.json')),
  );
  assert.ok(existsSync(join(out, 'extensions/pappra-bootstrap/runtime.mjs')));
  assert.ok(existsSync(join(out, 'package.json')));
});

test('a throwing initialization value is formatted without escaping the loader', async () => {
  const fixture = startTask('throwing-init', true);
  const throwingMessage = (): unknown =>
    Object.defineProperty(new Error('bad lifecycle'), 'message', {
      get() {
        throw new Error('message getter throws');
      },
    });
  const throwingToString = (): unknown => ({
    toString() {
      throw new Error('toString throws');
    },
    valueOf() {
      throw new Error('valueOf throws');
    },
  });
  const throwingProxy = (): unknown =>
    new Proxy(
      {},
      {
        get() {
          throw new Error('proxy get throws');
        },
        getPrototypeOf() {
          throw new Error('proxy prototype throws');
        },
        ownKeys() {
          throw new Error('proxy keys throws');
        },
      },
    );
  for (const [label, factory] of [
    ['message', throwingMessage],
    ['tostring', throwingToString],
    ['proxy', throwingProxy],
  ] as const) {
    const bundle = await exportBundle(fixture, `throwing-${label}`);
    const host = fakeHost({
      failCommand: 'pappra-checkpoint',
      failError: factory,
    });
    let escaped: unknown = null;
    try {
      (await loadBundle(bundle))(host.pi);
    } catch (error) {
      escaped = error;
    }
    assert.equal(
      escaped,
      null,
      `${label}: the loader must not receive a throw`,
    );
    const blocked = await host.callTool('write', NEXT.session_id);
    assert.equal(blocked?.block, true, `${label}: default deny must persist`);
    assert.equal(typeof blocked?.reason, 'string');
    assert.ok(String(blocked?.reason).length > 0);
    const first = host.runStatus();
    const second = host.runStatus();
    assert.deepEqual(first, second);
    assert.equal(first['state'], 'denied');
    assert.equal(first['registered'], false);
    assert.equal(first['write_permitted'], 'not-asserted');
    assert.equal(typeof first['reason'], 'string');
    const repeated = await host.callTool('bash', NEXT.session_id);
    assert.equal(repeated?.block, true);
  }
});
