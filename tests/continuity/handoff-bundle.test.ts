import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test, { after } from 'node:test';
import {
  HANDOFF_BUNDLE_SCHEMA,
  buildHandoffBundle,
  handoffBundleRelativeRef,
  parseHandoffBundle,
  readHandoffBundle,
  saveHandoffBundle,
  serializeHandoffBundle,
  verifyHandoffBundle,
  type HandoffBundle,
  type SaveHandoffBundleInput,
} from '../../src/continuity/index.js';
import {
  continuityTaskPaths,
  writeContinuityBytes,
} from '../../src/continuity/paths.js';
import { sha256Digest } from '../../src/infra/fs.js';
import {
  baseMachineConfig,
  baseWorkspaceConfig,
  cleanup,
  makeTempDir,
  workspaceId as FIXTURE_WORKSPACE_ID,
  writeMachineConfig,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';

const roots: string[] = [];
function tempDir(): string {
  const root = makeTempDir('handoff-bundle');
  roots.push(root);
  return root;
}
/** A realistic registered workspace (workspace.json carries FIXTURE_WORKSPACE_ID). */
function makeWorkspace(): string {
  const root = tempDir();
  writeWorkspaceConfig(root, baseWorkspaceConfig());
  writeMachineConfig(root, baseMachineConfig(root));
  return root;
}
after(() => {
  for (const root of roots) cleanup(root);
});

const CONTINUITY_TASK = 'wsx-e3-handoff';

interface CheckpointOverrides {
  readonly checkpointId?: string;
  readonly workspaceId?: string;
  readonly authorSession?: string | null;
  readonly contextCompleteness?: 'complete' | 'partial';
  readonly artifacts?: ReadonlyArray<{
    readonly path: string;
    readonly digest: string;
    readonly inputVersion: string | null;
    readonly observedAt: string;
  }>;
}

function buildCheckpoint(taskId: string, overrides: CheckpointOverrides = {}) {
  return {
    schema: 'pappra/checkpoint/1' as const,
    checkpointId: overrides.checkpointId ?? randomUUID(),
    taskId,
    workspaceId: overrides.workspaceId ?? FIXTURE_WORKSPACE_ID,
    revision: 1,
    previousDigest: null,
    createdAt: '2026-10-22T00:00:00.000Z',
    authorSession:
      overrides.authorSession === undefined
        ? 'pi-session-handoff'
        : overrides.authorSession,
    objective: 'Durable context prerequisite for rollover',
    acceptance: ['Preserve decisions'],
    constraints: ['No authority transfer'],
    decisions: ['Use a linked bundle, not a copy'],
    attempted: ['Captured the checkpoint'],
    nextActions: ['Hand off to a replacement'],
    limitations: ['Advisory snapshot only'],
    repositories: [],
    artifacts: overrides.artifacts ?? [],
    validations: [],
    nativeRefs: [],
    collaborationRecordRef: null,
    contextCompleteness: overrides.contextCompleteness ?? 'complete',
  };
}

async function publishCheckpoint(
  root: string,
  taskId: string,
  checkpoint: ReturnType<typeof buildCheckpoint>,
): Promise<{ ref: string; digest: string; abs: string }> {
  const paths = continuityTaskPaths(root, taskId);
  const name = `${checkpoint.checkpointId}.json`;
  const abs = join(paths.checkpointsDir, name);
  const bytes = Buffer.from(`${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
  const write = await writeContinuityBytes(root, taskId, abs, bytes, true, {});
  assert.ok(write.ok, 'checkpoint fixture must publish');
  return { ref: `checkpoints/${name}`, digest: write.value.digest, abs };
}

/** Create a workspace artifact and return its reference entry. */
function writeArtifact(root: string, relPath: string, content: string) {
  const abs = join(root, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
  return {
    path: relPath,
    digest: sha256Digest(readFileSync(abs)),
    inputVersion: null,
    observedAt: '2026-10-22T00:00:00.000Z',
  };
}

function baseSnapshot(): SaveHandoffBundleInput['handoff'] {
  return {
    claims: [
      {
        claimId: 'claim-1',
        resource: 'src/continuity/handoff-bundle.ts',
        resourceEpoch: 1,
        holder: 'pappra-investigator',
      },
    ],
    claimsCompleteness: 'complete',
    pendingTools: { items: [], completeness: 'complete' },
    pendingMessages: {
      items: ['msg-e3-handoff-bundle-assign'],
      completeness: 'partial',
    },
    pendingApprovals: { items: [], completeness: 'unknown' },
    nextAction: 'Replacement performs its first bounded authorized work',
    recovery: ['Re-read the pinned direction and current authority'],
    executionAuthority: 'none',
    advisory: true,
  };
}

function baseInput(
  root: string,
  taskId: string,
  reference: { ref: string; digest: string },
  checkpoint: ReturnType<typeof buildCheckpoint>,
  overrides: Partial<SaveHandoffBundleInput> = {},
): SaveHandoffBundleInput {
  return {
    root,
    continuityTaskId: taskId,
    checkpoint: {
      checkpointId: checkpoint.checkpointId,
      taskId,
      workspaceId: checkpoint.workspaceId,
      ref: reference.ref,
      digest: reference.digest,
      authorSession: checkpoint.authorSession,
      contextCompleteness: checkpoint.contextCompleteness,
    },
    collaboration: {
      taskId: 'workspace-experience',
      attempt: 1,
      ownerEpoch: 1,
      subtaskId: 'e3-handoff-bundle',
      inputRevision: `sha256:${'a'.repeat(64)}`,
      association:
        'continuity task wsx-e3-handoff backs collaboration workspace-experience',
    },
    sourceNativeSession: {
      harness: 'pi',
      sessionId: checkpoint.authorSession ?? 'pi-session-handoff',
      agentId: 'pappra-investigator',
      paneId: 'w3:p4',
      surface: 'cli',
      configurationId: 'daily-herdr',
      modelObservation: {
        model: 'claude-opus-4-8',
        provider: 'anthropic',
        reasoning: 'max',
      },
    },
    handoff: baseSnapshot(),
    limitations: ['Reported runtime evidence only'],
    notes: null,
    now: () => new Date('2026-10-22T13:10:00.000Z'),
    ...overrides,
  };
}

test('saves, reads and verifies a bundle linked to a real checkpoint', async () => {
  const root = makeWorkspace();
  const checkpoint = buildCheckpoint(CONTINUITY_TASK);
  const reference = await publishCheckpoint(root, CONTINUITY_TASK, checkpoint);
  const saved = await saveHandoffBundle(
    baseInput(root, CONTINUITY_TASK, reference, checkpoint, {
      bundleId: '11111111-1111-4111-8111-111111111111',
    }),
  );
  assert.ok(saved.ok, JSON.stringify(saved));
  assert.equal(
    saved.value.relativeRef,
    handoffBundleRelativeRef(saved.value.bundleId),
  );

  const read = await readHandoffBundle({
    root,
    continuityTaskId: CONTINUITY_TASK,
    bundleId: saved.value.bundleId,
  });
  assert.ok(read.ok);
  assert.equal(read.value.bundle.schema, HANDOFF_BUNDLE_SCHEMA);
  assert.deepEqual(read.value.bundle, saved.value.bundle);

  const verified = await verifyHandoffBundle({
    root,
    continuityTaskId: CONTINUITY_TASK,
    bundleId: saved.value.bundleId,
  });
  assert.ok(verified.ok);
  assert.equal(verified.value.executionAllowed, false);
  assert.equal(verified.value.workspaceIdentityMatches, true);
  assert.equal(verified.value.checkpointContextCompleteness, 'complete');
  assert.equal(verified.value.contextIntegrity, 'complete');
  assert.deepEqual(verified.value.artifactChecks, []);
  assert.deepEqual(verified.value.completeness, {
    claims: 'complete',
    pendingTools: 'complete',
    pendingMessages: 'partial',
    pendingApprovals: 'unknown',
  });
});

test('a partial checkpoint can never be reported as complete context', async () => {
  const root = makeWorkspace();
  const checkpoint = buildCheckpoint(CONTINUITY_TASK, {
    contextCompleteness: 'partial',
  });
  const reference = await publishCheckpoint(root, CONTINUITY_TASK, checkpoint);
  const saved = await saveHandoffBundle(
    baseInput(root, CONTINUITY_TASK, reference, checkpoint),
  );
  assert.ok(saved.ok);
  const verified = await verifyHandoffBundle({
    root,
    continuityTaskId: CONTINUITY_TASK,
    bundleId: saved.value.bundleId,
  });
  assert.ok(verified.ok);
  assert.equal(verified.value.checkpointContextCompleteness, 'partial');
  assert.equal(verified.value.contextIntegrity, 'incomplete');
});

test('D1: a bundle copied under another task is refused for the requested task', async () => {
  const root = makeWorkspace();
  const checkpoint = buildCheckpoint(CONTINUITY_TASK);
  const reference = await publishCheckpoint(root, CONTINUITY_TASK, checkpoint);
  const saved = await saveHandoffBundle(
    baseInput(root, CONTINUITY_TASK, reference, checkpoint, {
      bundleId: '55555555-5555-4555-8555-555555555555',
    }),
  );
  assert.ok(saved.ok);
  const otherTask = 'wsx-e3-other';
  const otherPaths = continuityTaskPaths(root, otherTask);
  const copyAbs = join(
    otherPaths.taskDir,
    'handoff-bundles',
    `${saved.value.bundleId}.json`,
  );
  const copy = await writeContinuityBytes(
    root,
    otherTask,
    copyAbs,
    readFileSync(saved.value.path),
    true,
    {},
  );
  assert.ok(copy.ok);

  const read = await readHandoffBundle({
    root,
    continuityTaskId: otherTask,
    bundleId: saved.value.bundleId,
  });
  assert.ok(!read.ok);
  assert.equal(read.code, 'document_source_invalid');

  const verified = await verifyHandoffBundle({
    root,
    continuityTaskId: otherTask,
    bundleId: saved.value.bundleId,
  });
  assert.ok(!verified.ok);
  assert.equal(verified.code, 'document_source_invalid');
});

test('D2: a checkpoint from another workspace is refused', async () => {
  const root = makeWorkspace();
  const foreignWorkspace = '87abd88c-af5b-4e87-bad3-4818cc926324';
  const checkpoint = buildCheckpoint(CONTINUITY_TASK, {
    workspaceId: foreignWorkspace,
  });
  const reference = await publishCheckpoint(root, CONTINUITY_TASK, checkpoint);
  const saved = await saveHandoffBundle(
    baseInput(root, CONTINUITY_TASK, reference, checkpoint),
  );
  assert.ok(!saved.ok);
  assert.equal(saved.code, 'document_source_invalid');
});

test('D2: an unregistered current workspace stays unavailable, not initialized', async () => {
  const root = tempDir(); // no workspace.json
  const checkpoint = buildCheckpoint(CONTINUITY_TASK);
  const reference = await publishCheckpoint(root, CONTINUITY_TASK, checkpoint);
  const saved = await saveHandoffBundle(
    baseInput(root, CONTINUITY_TASK, reference, checkpoint),
  );
  assert.ok(!saved.ok);
  assert.ok(!existsSync(join(root, '.pappra', 'workspace.json')));
});

test('D3: a missing referenced artifact is never reported as complete', async () => {
  const root = makeWorkspace();
  mkdirSync(join(root, 'notes'), { recursive: true });
  const checkpoint = buildCheckpoint(CONTINUITY_TASK, {
    artifacts: [
      {
        path: 'notes/missing-document.md',
        digest: `sha256:${'b'.repeat(64)}`,
        inputVersion: null,
        observedAt: '2026-10-22T00:00:00.000Z',
      },
    ],
  });
  const reference = await publishCheckpoint(root, CONTINUITY_TASK, checkpoint);
  const saved = await saveHandoffBundle(
    baseInput(root, CONTINUITY_TASK, reference, checkpoint),
  );
  assert.ok(saved.ok);
  const verified = await verifyHandoffBundle({
    root,
    continuityTaskId: CONTINUITY_TASK,
    bundleId: saved.value.bundleId,
  });
  assert.ok(verified.ok);
  assert.equal(verified.value.contextIntegrity, 'incomplete');
  assert.deepEqual(verified.value.artifactChecks, [
    { path: 'notes/missing-document.md', status: 'missing' },
  ]);
});

test('D3: a changed referenced artifact is incomplete; an unchanged one is complete', async () => {
  const root = makeWorkspace();
  const present = writeArtifact(
    root,
    'notes/handoff.md',
    'checkpoint artifact',
  );
  const unchanged = buildCheckpoint(CONTINUITY_TASK, { artifacts: [present] });
  const unchangedRef = await publishCheckpoint(
    root,
    CONTINUITY_TASK,
    unchanged,
  );
  const okSaved = await saveHandoffBundle(
    baseInput(root, CONTINUITY_TASK, unchangedRef, unchanged, {
      bundleId: '66666666-6666-4666-8666-666666666666',
    }),
  );
  assert.ok(okSaved.ok);
  const okVerified = await verifyHandoffBundle({
    root,
    continuityTaskId: CONTINUITY_TASK,
    bundleId: okSaved.value.bundleId,
  });
  assert.ok(okVerified.ok);
  assert.equal(okVerified.value.contextIntegrity, 'complete');
  assert.deepEqual(okVerified.value.artifactChecks, [
    { path: 'notes/handoff.md', status: 'unchanged' },
  ]);

  const changed = buildCheckpoint(CONTINUITY_TASK, {
    artifacts: [{ ...present, digest: `sha256:${'c'.repeat(64)}` }],
  });
  const changedRef = await publishCheckpoint(root, CONTINUITY_TASK, changed);
  const changedSaved = await saveHandoffBundle(
    baseInput(root, CONTINUITY_TASK, changedRef, changed, {
      bundleId: '77777777-7777-4777-8777-777777777777',
    }),
  );
  assert.ok(changedSaved.ok);
  const changedVerified = await verifyHandoffBundle({
    root,
    continuityTaskId: CONTINUITY_TASK,
    bundleId: changedSaved.value.bundleId,
  });
  assert.ok(changedVerified.ok);
  assert.equal(changedVerified.value.contextIntegrity, 'incomplete');
  assert.equal(changedVerified.value.artifactChecks[0]?.status, 'changed');
});

test('regression: a parent redirected during publish writes nothing outside', async () => {
  const root = makeWorkspace();
  const outside = tempDir();
  const checkpoint = buildCheckpoint(CONTINUITY_TASK);
  const reference = await publishCheckpoint(root, CONTINUITY_TASK, checkpoint);
  const bundleId = '88888888-8888-4888-8888-888888888888';
  const bundlesDir = join(
    continuityTaskPaths(root, CONTINUITY_TASK).taskDir,
    'handoff-bundles',
  );
  const saved = await saveHandoffBundle(
    baseInput(root, CONTINUITY_TASK, reference, checkpoint, {
      bundleId,
      writeOptions: {
        beforeExclusivePublish: async () => {
          rmSync(bundlesDir, { recursive: true, force: true });
          symlinkSync(outside, bundlesDir);
        },
      },
    }),
  );
  assert.ok(!saved.ok);
  assert.ok(!existsSync(join(outside, `${bundleId}.json`)));
  assert.deepEqual(readdirSync(outside), []);
});

test('rejects a checkpoint reference whose digest does not match', async () => {
  const root = makeWorkspace();
  const checkpoint = buildCheckpoint(CONTINUITY_TASK);
  const reference = await publishCheckpoint(root, CONTINUITY_TASK, checkpoint);
  const saved = await saveHandoffBundle(
    baseInput(root, CONTINUITY_TASK, reference, checkpoint, {
      checkpoint: {
        checkpointId: checkpoint.checkpointId,
        taskId: CONTINUITY_TASK,
        workspaceId: checkpoint.workspaceId,
        ref: reference.ref,
        digest: `sha256:${'0'.repeat(64)}`,
        authorSession: checkpoint.authorSession,
        contextCompleteness: checkpoint.contextCompleteness,
      },
    }),
  );
  assert.ok(!saved.ok);
  assert.equal(saved.code, 'document_file_changed');
});

test('verify fails when the bound checkpoint digest is tampered', async () => {
  const root = makeWorkspace();
  const checkpoint = buildCheckpoint(CONTINUITY_TASK);
  const reference = await publishCheckpoint(root, CONTINUITY_TASK, checkpoint);
  const saved = await saveHandoffBundle(
    baseInput(root, CONTINUITY_TASK, reference, checkpoint),
  );
  assert.ok(saved.ok);
  const tampered: HandoffBundle = {
    ...saved.value.bundle,
    checkpoint: {
      ...saved.value.bundle.checkpoint,
      digest: `sha256:${'0'.repeat(64)}`,
    },
  };
  const verified = await verifyHandoffBundle({ root, bundle: tampered });
  assert.ok(!verified.ok);
  assert.equal(verified.code, 'document_file_changed');
});

test('rejects a reference whose bound workspace id differs from the checkpoint', async () => {
  const root = makeWorkspace();
  const checkpoint = buildCheckpoint(CONTINUITY_TASK);
  const reference = await publishCheckpoint(root, CONTINUITY_TASK, checkpoint);
  const saved = await saveHandoffBundle(
    baseInput(root, CONTINUITY_TASK, reference, checkpoint, {
      checkpoint: {
        checkpointId: checkpoint.checkpointId,
        taskId: CONTINUITY_TASK,
        workspaceId: randomUUID(),
        ref: reference.ref,
        digest: reference.digest,
        authorSession: checkpoint.authorSession,
        contextCompleteness: checkpoint.contextCompleteness,
      },
    }),
  );
  assert.ok(!saved.ok);
  assert.equal(saved.code, 'document_source_invalid');
});

test('rejects a source session that differs from the checkpoint author', async () => {
  const root = makeWorkspace();
  const checkpoint = buildCheckpoint(CONTINUITY_TASK);
  const reference = await publishCheckpoint(root, CONTINUITY_TASK, checkpoint);
  const saved = await saveHandoffBundle(
    baseInput(root, CONTINUITY_TASK, reference, checkpoint, {
      sourceNativeSession: {
        harness: 'pi',
        sessionId: 'pi-session-other',
        agentId: 'pappra-investigator',
        paneId: 'w3:p4',
        surface: 'cli',
        configurationId: 'daily-herdr',
        modelObservation: { model: null, provider: null, reasoning: null },
      },
    }),
  );
  assert.ok(!saved.ok);
  assert.equal(saved.code, 'document_source_invalid');
});

test('requires an explicit association when ids differ and accepts it otherwise', () => {
  const root = makeWorkspace();
  const checkpoint = buildCheckpoint(CONTINUITY_TASK);
  const common = baseInput(
    root,
    CONTINUITY_TASK,
    { ref: 'checkpoints/x.json', digest: `sha256:${'a'.repeat(64)}` },
    checkpoint,
  );
  const withoutAssociation = buildHandoffBundle({
    ...common,
    collaboration: { ...common.collaboration, association: null },
  });
  assert.ok(!withoutAssociation.ok);
  assert.equal(withoutAssociation.code, 'document_record_invalid');

  const matchingIds = buildHandoffBundle({
    ...common,
    collaboration: {
      ...common.collaboration,
      taskId: CONTINUITY_TASK,
      association: null,
    },
  });
  assert.ok(matchingIds.ok);
});

test('rejects a checkpoint bound to a different task namespace', () => {
  const root = makeWorkspace();
  const checkpoint = buildCheckpoint('other-task');
  const built = buildHandoffBundle(
    baseInput(
      root,
      CONTINUITY_TASK,
      { ref: 'checkpoints/x.json', digest: `sha256:${'a'.repeat(64)}` },
      checkpoint,
      {
        checkpoint: {
          checkpointId: checkpoint.checkpointId,
          taskId: 'other-task',
          workspaceId: checkpoint.workspaceId,
          ref: 'checkpoints/x.json',
          digest: `sha256:${'a'.repeat(64)}`,
          authorSession: checkpoint.authorSession,
          contextCompleteness: 'complete',
        },
      },
    ),
  );
  assert.ok(!built.ok);
  assert.equal(built.code, 'document_record_invalid');
});

test('rejects an invalid continuity task id', async () => {
  const root = makeWorkspace();
  const checkpoint = buildCheckpoint(CONTINUITY_TASK);
  const reference = await publishCheckpoint(root, CONTINUITY_TASK, checkpoint);
  const saved = await saveHandoffBundle(
    baseInput(root, 'x'.repeat(65), reference, checkpoint),
  );
  assert.ok(!saved.ok);
  assert.equal(saved.code, 'document_record_invalid');
});

test('refuses an oversized serialized bundle without storing it', async () => {
  const root = makeWorkspace();
  const checkpoint = buildCheckpoint(CONTINUITY_TASK);
  const reference = await publishCheckpoint(root, CONTINUITY_TASK, checkpoint);
  const big = Array.from({ length: 64 }, () => 'x'.repeat(2000));
  const bundleId = '22222222-2222-4222-8222-222222222222';
  const saved = await saveHandoffBundle(
    baseInput(root, CONTINUITY_TASK, reference, checkpoint, {
      bundleId,
      handoff: {
        ...baseSnapshot(),
        pendingTools: { items: big, completeness: 'partial' },
        pendingMessages: { items: big, completeness: 'partial' },
        pendingApprovals: { items: big, completeness: 'partial' },
      },
    }),
  );
  assert.ok(!saved.ok);
  assert.equal(saved.code, 'file_too_large');
  const stored = await readHandoffBundle({
    root,
    continuityTaskId: CONTINUITY_TASK,
    bundleId,
  });
  assert.ok(!stored.ok);
  assert.equal(stored.code, 'file_not_found');
});

test('refuses absolute, parent-redirected and symlinked checkpoint refs', async () => {
  const root = makeWorkspace();
  const checkpoint = buildCheckpoint(CONTINUITY_TASK);
  await publishCheckpoint(root, CONTINUITY_TASK, checkpoint);
  const paths = continuityTaskPaths(root, CONTINUITY_TASK);
  mkdirSync(paths.checkpointsDir, { recursive: true });
  symlinkSync('/etc/hosts', join(paths.checkpointsDir, 'link.json'));

  for (const ref of [
    '/etc/hosts',
    '../../escape.json',
    'checkpoints/link.json',
  ]) {
    const saved = await saveHandoffBundle(
      baseInput(
        root,
        CONTINUITY_TASK,
        { ref, digest: `sha256:${'a'.repeat(64)}` },
        checkpoint,
        {
          checkpoint: {
            checkpointId: checkpoint.checkpointId,
            taskId: CONTINUITY_TASK,
            workspaceId: checkpoint.workspaceId,
            ref,
            digest: `sha256:${'a'.repeat(64)}`,
            authorSession: checkpoint.authorSession,
            contextCompleteness: checkpoint.contextCompleteness,
          },
        },
      ),
    );
    assert.ok(!saved.ok, `ref must be refused: ${ref}`);
    assert.equal(saved.code, 'document_path_unsafe', `ref ${ref}`);
  }
});

test('never replaces an existing bundle and preserves the first bytes', async () => {
  const root = makeWorkspace();
  const checkpoint = buildCheckpoint(CONTINUITY_TASK);
  const reference = await publishCheckpoint(root, CONTINUITY_TASK, checkpoint);
  const bundleId = '33333333-3333-4333-8333-333333333333';
  const first = await saveHandoffBundle(
    baseInput(root, CONTINUITY_TASK, reference, checkpoint, {
      bundleId,
      notes: 'first',
    }),
  );
  assert.ok(first.ok);
  const second = await saveHandoffBundle(
    baseInput(root, CONTINUITY_TASK, reference, checkpoint, {
      bundleId,
      notes: 'second',
    }),
  );
  assert.ok(!second.ok);
  assert.equal(second.code, 'document_write_conflict');
  const read = await readHandoffBundle({
    root,
    continuityTaskId: CONTINUITY_TASK,
    bundleId,
  });
  assert.ok(read.ok);
  assert.equal(read.value.bundle.notes, 'first');
});

test('rejects an unknown bundle schema version on read', async () => {
  const root = makeWorkspace();
  const bundleId = '44444444-4444-4444-8444-444444444444';
  const abs = join(
    continuityTaskPaths(root, CONTINUITY_TASK).taskDir,
    'handoff-bundles',
    `${bundleId}.json`,
  );
  const bytes = Buffer.from(
    `${JSON.stringify({ schema: 'pappra/handoff-bundle/2', bundleId }, null, 2)}\n`,
    'utf8',
  );
  const write = await writeContinuityBytes(
    root,
    CONTINUITY_TASK,
    abs,
    bytes,
    true,
    {},
  );
  assert.ok(write.ok);
  const read = await readHandoffBundle({
    root,
    continuityTaskId: CONTINUITY_TASK,
    bundleId,
  });
  assert.ok(!read.ok);
  assert.equal(read.code, 'config_unsupported_schema');
});

test('reports a missing checkpoint instead of a complete verification', async () => {
  const root = makeWorkspace();
  const checkpoint = buildCheckpoint(CONTINUITY_TASK);
  const missingRef = `checkpoints/${randomUUID()}.json`;
  const built = buildHandoffBundle(
    baseInput(
      root,
      CONTINUITY_TASK,
      { ref: missingRef, digest: `sha256:${'a'.repeat(64)}` },
      checkpoint,
      {
        checkpoint: {
          checkpointId: checkpoint.checkpointId,
          taskId: CONTINUITY_TASK,
          workspaceId: checkpoint.workspaceId,
          ref: missingRef,
          digest: `sha256:${'a'.repeat(64)}`,
          authorSession: checkpoint.authorSession,
          contextCompleteness: checkpoint.contextCompleteness,
        },
      },
    ),
  );
  assert.ok(built.ok);
  const verified = await verifyHandoffBundle({ root, bundle: built.value });
  assert.ok(!verified.ok);
  assert.equal(verified.code, 'file_not_found');
});

test('leaves the referenced checkpoint bytes unchanged across save/read/verify', async () => {
  const root = makeWorkspace();
  const checkpoint = buildCheckpoint(CONTINUITY_TASK);
  const reference = await publishCheckpoint(root, CONTINUITY_TASK, checkpoint);
  const before = readFileSync(reference.abs);
  const saved = await saveHandoffBundle(
    baseInput(root, CONTINUITY_TASK, reference, checkpoint),
  );
  assert.ok(saved.ok);
  await readHandoffBundle({
    root,
    continuityTaskId: CONTINUITY_TASK,
    bundleId: saved.value.bundleId,
  });
  await verifyHandoffBundle({
    root,
    continuityTaskId: CONTINUITY_TASK,
    bundleId: saved.value.bundleId,
  });
  assert.deepEqual(readFileSync(reference.abs), before);
  assert.equal(sha256Digest(readFileSync(reference.abs)), reference.digest);
});

test('serialization is deterministic and parse rejects malformed input', () => {
  const root = makeWorkspace();
  const checkpoint = buildCheckpoint(CONTINUITY_TASK);
  const valid = buildHandoffBundle(
    baseInput(
      root,
      CONTINUITY_TASK,
      { ref: 'checkpoints/x.json', digest: `sha256:${'a'.repeat(64)}` },
      checkpoint,
    ),
  );
  assert.ok(valid.ok);
  assert.deepEqual(
    serializeHandoffBundle(valid.value),
    serializeHandoffBundle(valid.value),
  );
  assert.equal(parseHandoffBundle(42).ok, false);
  assert.equal(parseHandoffBundle(null).ok, false);
  assert.equal(parseHandoffBundle({ schema: HANDOFF_BUNDLE_SCHEMA }).ok, false);
});
