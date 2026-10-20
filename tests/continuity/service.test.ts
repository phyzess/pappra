import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { CheckpointService } from '../../src/continuity/index.js';
import { writeContinuityBytes } from '../../src/continuity/paths.js';
import * as store from '../../src/collab/store.js';
import { sha256Digest } from '../../src/infra/fs.js';
import type { ResumePacket } from '../../src/schemas/continuity.js';
import {
  baseMachineConfig,
  baseWorkspaceConfig,
  cleanup,
  createRepository,
  makeTempDir,
  snapshotTree,
  writeMachineConfig,
  writeText,
  writeWorkspaceConfig,
} from '../workspace/fixtures.js';

function makeWorkspace(
  overrides: Record<string, unknown> = {},
  rootPath?: string,
): string {
  const root = rootPath ?? makeTempDir('continuity');
  writeWorkspaceConfig(root, baseWorkspaceConfig(overrides));
  writeMachineConfig(root, baseMachineConfig(root));
  return root;
}

function makeRepoWorkspace(): string {
  const root = makeWorkspace({
    repositories: [{ id: 'app', path: '.', access: 'write' }],
  });
  createRepository(root);
  return root;
}

function initialInput(taskId = 'task-p07') {
  return {
    taskId,
    objective: 'Implement a bounded recovery packet',
    acceptance: ['Preserve decisions', 'Do not start an agent'],
    constraints: ['No P08'],
    decisions: ['Use explicit checkpoint identity'],
    attempted: ['Observed repositories'],
    nextActions: ['Run independent review'],
    limitations: ['Synthetic tests only'],
    authorSession: 'pi-session-a',
    contextCompleteness: 'complete' as const,
    nativeRefs: [
      {
        harness: 'pi' as const,
        sessionId: 'pi-session-a',
        turnId: 'turn-1',
        runId: 'run-1',
      },
    ],
  };
}

test('saves a task context and checkpoint with a stable revision chain', async () => {
  const root = makeWorkspace();
  try {
    const service = new CheckpointService(root);
    const first = await service.save(initialInput());
    assert.equal(first.ok, true, first.diagnostics[0]?.message);
    assert(first.checkpoint !== null);
    assert.equal(first.checkpoint.revision, 1);
    assert.equal(first.checkpoint.previousDigest, null);
    assert.equal(
      existsSync(join(root, '.pappra', 'local', 'tasks', 'task-p07')),
      true,
    );
    const firstDigest = sha256Digest(readFileSync(first.checkpointPath!));
    const second = await service.save({
      taskId: 'task-p07',
      decisions: ['Second decision'],
      nextActions: ['Review the second checkpoint'],
      authorSession: 'pi-session-a',
      contextCompleteness: 'complete',
    });
    assert.equal(second.ok, true, second.diagnostics[0]?.message);
    assert.equal(second.checkpoint?.revision, 2);
    assert.equal(second.checkpoint?.previousDigest, firstDigest);
    const pointer = JSON.parse(
      readFileSync(
        join(root, '.pappra', 'local', 'tasks', 'task-p07', 'latest.json'),
        'utf8',
      ),
    ) as { revision: number; checkpointDigest: string };
    assert.equal(pointer.revision, 2);
    assert.equal(
      pointer.checkpointDigest,
      sha256Digest(readFileSync(second.checkpointPath!)),
    );
  } finally {
    cleanup(root);
  }
});

test('resume is read-only, bounded, and preserves semantic fields', async () => {
  const root = makeWorkspace();
  try {
    const service = new CheckpointService(root);
    const saved = await service.save(initialInput());
    assert.equal(saved.ok, true, saved.diagnostics[0]?.message);
    const before = snapshotTree(root);
    const resumed = await service.resume({
      taskId: 'task-p07',
      currentSession: 'pi-session-a',
    });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.status, 'blocked');
    assert(resumed.packet !== null);
    assert.equal(resumed.packet.executionAllowed, false);
    assert(
      resumed.packet.blockingReasons.some(
        (entry) => entry.code === 'live_writer_unverified',
      ),
    );
    assert.equal(
      resumed.packet.boundedContext.objective,
      'Implement a bounded recovery packet',
    );
    assert.deepEqual(resumed.packet.boundedContext.decisions, [
      'Use explicit checkpoint identity',
    ]);
    assert.deepEqual(resumed.packet.boundedContext.nextActions, [
      'Run independent review',
    ]);
    assert.equal(
      resumed.packet.executionObservations[0]?.scope,
      'stored-snapshot',
    );
    assert.equal(
      resumed.packet.executionObservations[0]?.liveStatus,
      'unknown',
    );
    assert.equal(
      resumed.packet.collaborationObservation.status,
      'not-referenced',
    );
    assert.equal(resumed.packet.collaborationObservation.digest, null);
    assert.deepEqual(snapshotTree(root), before);
  } finally {
    cleanup(root);
  }
});

test('an interrupted latest pointer preserves the previous readable checkpoint', async () => {
  const root = makeWorkspace();
  try {
    const first = await new CheckpointService(root).save(initialInput());
    assert.equal(first.ok, true);
    const broken = new CheckpointService(root, {
      beforeLatestPointerPersist: () => {
        throw new Error('injected pointer failure');
      },
    });
    const interrupted = await broken.save({
      taskId: 'task-p07',
      decisions: ['Not committed'],
      authorSession: 'pi-session-a',
      contextCompleteness: 'complete',
    });
    assert.equal(interrupted.ok, false);
    assert.equal(interrupted.status, 'partial');
    assert(interrupted.residualPaths.length > 0);
    const resumed = await new CheckpointService(root).resume({
      taskId: 'task-p07',
      currentSession: 'pi-session-a',
    });
    assert.equal(resumed.status, 'blocked');
    assert.equal(resumed.packet?.checkpoint.revision, 1);
    assert.deepEqual(resumed.packet?.boundedContext.decisions, [
      'Use explicit checkpoint identity',
    ]);
  } finally {
    cleanup(root);
  }
});

test('corrupt or missing pointers never guess another task', async () => {
  const root = makeWorkspace();
  try {
    const service = new CheckpointService(root);
    const saved = await service.save(initialInput());
    assert.equal(saved.ok, true);
    const latest = join(
      root,
      '.pappra',
      'local',
      'tasks',
      'task-p07',
      'latest.json',
    );
    writeFileSync(latest, '{"schema":"broken"}\n');
    const corrupt = await service.resume({
      taskId: 'task-p07',
      currentSession: 'pi-session-a',
    });
    assert.equal(corrupt.status, 'invalid');
    assert.equal(corrupt.packet, null);
    const missing = await service.resume({
      taskId: 'another-task',
      currentSession: 'pi-session-a',
    });
    assert.equal(missing.status, 'not-found');
  } finally {
    cleanup(root);
  }
});

test('unknown writer and partial context fail closed', async () => {
  const root = makeWorkspace();
  try {
    const service = new CheckpointService(root);
    const unknown = await service.save({
      ...initialInput('task-unknown'),
      authorSession: null,
      nativeRefs: [],
    });
    assert.equal(unknown.ok, true);
    const unknownResume = await service.resume({
      taskId: 'task-unknown',
      currentSession: 'pi-session-a',
    });
    assert.equal(unknownResume.ok, true);
    assert.equal(unknownResume.status, 'blocked');
    assert.equal(unknownResume.packet?.executionAllowed, false);
    assert(
      unknownResume.packet?.blockingReasons.some(
        (entry) => entry.code === 'unknown_writer',
      ),
    );

    const partial = await service.save({
      ...initialInput('task-partial'),
      decisions: [],
      attempted: [],
      nextActions: [],
      contextCompleteness: 'partial',
    });
    assert.equal(partial.ok, true);
    const partialResume = await service.resume({
      taskId: 'task-partial',
      currentSession: 'pi-session-a',
    });
    assert.equal(partialResume.status, 'blocked');
    assert.equal(partialResume.packet?.contextCompleteness, 'partial');
    assert(
      partialResume.packet?.blockingReasons.some(
        (entry) => entry.code === 'context_partial',
      ),
    );
  } finally {
    cleanup(root);
  }
});

test('HEAD and dirty changes mark verification stale while preserving decisions', async () => {
  const root = makeRepoWorkspace();
  try {
    const service = new CheckpointService(root);
    const saved = await service.save(initialInput());
    assert.equal(saved.ok, true, saved.diagnostics[0]?.message);
    writeText(join(root, 'tracked.txt'), 'changed\n');
    const resumed = await service.resume({
      taskId: 'task-p07',
      currentSession: 'pi-session-a',
    });
    assert.equal(resumed.packet?.codeDrift.status, 'changed');
    assert.equal(resumed.packet?.verificationStatus, 'stale');
    assert.deepEqual(resumed.packet?.boundedContext.decisions, [
      'Use explicit checkpoint identity',
    ]);
  } finally {
    cleanup(root);
  }
});

test('artifact changes and missing collaboration records are reported read-only', async () => {
  const root = makeWorkspace();
  try {
    const artifact = join(root, 'docs', 'artifact.txt');
    writeText(artifact, 'artifact\n');
    const service = new CheckpointService(root);
    const saved = await service.save({
      ...initialInput('task-artifact'),
      artifacts: ['docs/artifact.txt'],
      collaborationRecordRef: 'missing-collaboration.json',
    });
    assert.equal(saved.ok, true, saved.diagnostics[0]?.message);
    writeText(artifact, 'changed artifact\n');
    const resumed = await service.resume({
      taskId: 'task-artifact',
      currentSession: 'pi-session-a',
    });
    assert.equal(resumed.packet?.artifactChecks[0]?.status, 'changed');
    assert.equal(resumed.packet?.collaborationObservation.status, 'missing');
    assert.equal(resumed.packet?.executionAllowed, false);
    assert(
      resumed.packet?.blockingReasons.some(
        (entry) => entry.code === 'collaboration_record_unavailable',
      ),
    );
  } finally {
    cleanup(root);
  }
});

test('relocated space-containing repository paths are diagnosed before execution', async () => {
  const base = makeTempDir('continuity-relocate');
  const root = join(base, 'workspace with spaces');
  const moved = join(base, 'moved workspace with spaces');
  try {
    mkdirSync(root, { recursive: true });
    makeWorkspace(
      {
        repositories: [{ id: 'app', path: '.', access: 'write' }],
      },
      root,
    );
    createRepository(root);
    const service = new CheckpointService(root);
    const saved = await service.save(initialInput());
    assert.equal(saved.ok, true, saved.diagnostics[0]?.message);
    renameSync(root, moved);
    const resumed = await new CheckpointService(moved).resume({
      taskId: 'task-p07',
      currentSession: 'pi-session-a',
    });
    assert.equal(resumed.packet?.codeDrift.status, 'relocated');
    assert.equal(resumed.packet?.executionAllowed, false);
    assert(
      resumed.packet?.codeDrift.repositories[0]?.detail?.includes(
        'space-containing path',
      ),
    );
  } finally {
    cleanup(base);
  }
});

test('resume packet schema rejects unbounded or private patch content', async () => {
  const root = makeRepoWorkspace();
  try {
    const service = new CheckpointService(root);
    const saved = await service.save(initialInput());
    assert.equal(saved.ok, true);
    const resumed = await service.resume({
      taskId: 'task-p07',
      currentSession: 'pi-session-a',
    });
    assert(resumed.packet !== null);
    const packet: ResumePacket = resumed.packet;
    assert.equal('patchBytes' in packet, false);
    assert.equal(packet.boundedContext.repositories.length <= 16, true);
    assert.equal(packet.boundedContext.artifacts.length <= 16, true);
    assert.equal(JSON.stringify(packet).includes('diff --git'), false);
  } finally {
    cleanup(root);
  }
});

test('rejects a private task directory redirected into shared docs', async () => {
  const root = makeRepoWorkspace();
  try {
    writeText(join(root, 'docs/shared/review-task/keep.txt'), 'shared\n');
    mkdirSync(join(root, '.pappra', 'local'), { recursive: true });
    symlinkSync(
      join(root, 'docs', 'shared'),
      join(root, '.pappra', 'local', 'tasks'),
      'dir',
    );
    const result = await new CheckpointService(root).save(initialInput());
    assert.equal(result.ok, false);
    const shared = join(root, 'docs', 'shared', 'review-task');
    assert.deepEqual(readdirSync(shared), ['keep.txt']);
  } finally {
    cleanup(root);
  }
});

test('pointer CAS rejects a concurrent pointer change after the hook', async () => {
  const root = makeWorkspace();
  try {
    const first = await new CheckpointService(root).save(initialInput());
    assert.equal(first.ok, true);
    const latest = first.latestPath!;
    let concurrent = '';
    const racing = new CheckpointService(root, {
      beforeLatestPointerPersist: () => {
        const value = JSON.parse(readFileSync(latest, 'utf8')) as {
          updatedAt: string;
        };
        value.updatedAt = '2030-01-01T00:00:00.000Z';
        concurrent = `${JSON.stringify(value, null, 2)}\n`;
        writeFileSync(latest, concurrent);
      },
    });
    const second = await racing.save({
      taskId: 'task-p07',
      decisions: ['must not overwrite pointer'],
      authorSession: 'pi-session-a',
      contextCompleteness: 'complete',
    });
    assert.equal(second.ok, false);
    assert.equal(second.status, 'conflict');
    assert.equal(readFileSync(latest, 'utf8'), concurrent);
  } finally {
    cleanup(root);
  }
});

test('rejects artifact symlinks that resolve outside the workspace', async () => {
  const root = makeWorkspace();
  const outside = makeTempDir('continuity-artifact-outside');
  try {
    writeText(join(outside, 'sentinel.txt'), 'outside sentinel\n');
    symlinkSync(join(outside, 'sentinel.txt'), join(root, 'artifact.txt'));
    const saved = await new CheckpointService(root).save({
      ...initialInput(),
      artifacts: ['artifact.txt'],
    });
    assert.equal(saved.ok, false);
    assert.equal(saved.checkpoint, null);
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test('captures untracked file bodies in the private patch and detects body drift', async () => {
  const root = makeRepoWorkspace();
  try {
    writeText(join(root, 'untracked.txt'), 'untracked version A\n');
    const service = new CheckpointService(root);
    const saved = await service.save(initialInput());
    assert.equal(saved.ok, true, saved.diagnostics[0]?.message);
    assert(saved.checkpoint !== null);
    const patchDigest = saved.checkpoint.repositories[0]?.patchDigest;
    assert.notEqual(patchDigest, null);
    const patchPath = join(
      root,
      '.pappra/local/tasks/task-p07/patches',
      `${patchDigest!.slice('sha256:'.length)}.patch`,
    );
    assert(readFileSync(patchPath, 'utf8').includes('untracked version A'));
    writeText(join(root, 'untracked.txt'), 'untracked version B\n');
    const resumed = await service.resume({
      taskId: 'task-p07',
      currentSession: 'pi-session-a',
    });
    assert.equal(resumed.packet?.codeDrift.status, 'changed');
    assert.equal(resumed.packet?.verificationStatus, 'stale');
  } finally {
    cleanup(root);
  }
});

test('missing private patch is diagnosed and cannot verify current', async () => {
  const root = makeRepoWorkspace();
  try {
    writeText(join(root, 'tracked.txt'), 'changed tracked body\n');
    const service = new CheckpointService(root);
    const saved = await service.save(initialInput());
    assert.equal(saved.ok, true);
    const checkpoint = saved.checkpoint!;
    const digest = checkpoint.repositories[0]?.patchDigest;
    assert.notEqual(digest, null);
    const patch = join(
      root,
      '.pappra/local/tasks/task-p07/patches',
      `${digest!.slice('sha256:'.length)}.patch`,
    );
    unlinkSync(patch);
    const resumed = await service.resume({
      taskId: 'task-p07',
      currentSession: 'pi-session-a',
    });
    assert.equal(
      resumed.packet?.codeDrift.repositories[0]?.patchStatus,
      'missing',
    );
    assert.equal(resumed.packet?.verificationStatus, 'unknown');
    assert(
      resumed.packet?.blockingReasons.some(
        (entry) => entry.code === 'private_patch_unavailable',
      ),
    );
  } finally {
    cleanup(root);
  }
});

test('exclusive publication preserves a target created at the commit boundary', async () => {
  const root = makeWorkspace();
  try {
    const taskId = 'race-task';
    const taskDir = join(root, '.pappra', 'local', 'tasks', taskId);
    mkdirSync(taskDir, { recursive: true });
    const target = join(taskDir, 'task-context.json');
    const result = await writeContinuityBytes(
      root,
      taskId,
      target,
      Buffer.from('new private state'),
      true,
      {
        beforeExclusivePublish: async () => {
          writeFileSync(target, 'concurrent user state', { flag: 'wx' });
        },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(readFileSync(target, 'utf8'), 'concurrent user state');
    assert.equal(
      readdirSync(taskDir).some((name) => name.includes('.tmp-')),
      false,
    );
  } finally {
    cleanup(root);
  }
});

test('tampered private patch makes aggregate verification non-current', async () => {
  const root = makeRepoWorkspace();
  try {
    writeText(join(root, 'tracked.txt'), 'dirty tracked body\n');
    const service = new CheckpointService(root);
    const saved = await service.save(initialInput());
    assert.equal(saved.ok, true, saved.diagnostics[0]?.message);
    const digest = saved.checkpoint?.repositories[0]?.patchDigest;
    assert.notEqual(digest, null);
    const patch = join(
      root,
      '.pappra/local/tasks/task-p07/patches',
      `${digest!.slice('sha256:'.length)}.patch`,
    );
    writeFileSync(patch, 'tampered private payload\n');
    const resumed = await service.resume({
      taskId: 'task-p07',
      currentSession: 'pi-session-a',
    });
    assert.equal(
      resumed.packet?.codeDrift.repositories[0]?.patchStatus,
      'changed',
    );
    assert.notEqual(resumed.packet?.verificationStatus, 'current');
    assert(
      resumed.packet?.blockingReasons.some(
        (entry) => entry.code === 'private_patch_unavailable',
      ),
    );
  } finally {
    cleanup(root);
  }
});

test('length-framed untracked payloads detect delimiter redistribution', async () => {
  const root = makeRepoWorkspace();
  try {
    const delimiter = '\nUNTRACKED b.txt\n';
    writeText(join(root, 'a.txt'), `X${delimiter}Y`);
    writeText(join(root, 'b.txt'), 'Z');
    const service = new CheckpointService(root);
    const saved = await service.save(initialInput());
    assert.equal(saved.ok, true, saved.diagnostics[0]?.message);
    const storedDigest = saved.checkpoint?.repositories[0]?.patchDigest;
    assert.notEqual(storedDigest, null);

    writeText(join(root, 'a.txt'), 'X');
    writeText(join(root, 'b.txt'), `Y${delimiter}Z`);
    const resumed = await service.resume({
      taskId: 'task-p07',
      currentSession: 'pi-session-a',
    });
    const repository = resumed.packet?.codeDrift.repositories[0];
    assert.notEqual(repository?.currentPatchDigest, storedDigest);
    assert.equal(repository?.status, 'changed');
    assert.equal(resumed.packet?.verificationStatus, 'stale');
  } finally {
    cleanup(root);
  }
});

test('untracked file-kind transitions change identity without following targets', async () => {
  const root = makeRepoWorkspace();
  try {
    const untracked = join(root, 'untracked.txt');
    writeText(untracked, 'tracked.txt');
    const service = new CheckpointService(root);
    const fileSaved = await service.save(initialInput());
    assert.equal(fileSaved.ok, true, fileSaved.diagnostics[0]?.message);
    assert.equal(
      fileSaved.checkpoint?.repositories[0]?.captureStatus,
      'complete',
    );
    const fileDigest = fileSaved.checkpoint?.repositories[0]?.patchDigest;
    assert.notEqual(fileDigest, null);
    const filePatch = join(
      root,
      '.pappra/local/tasks/task-p07/patches',
      `${fileDigest!.slice('sha256:'.length)}.patch`,
    );
    const fileBytes = readFileSync(filePatch, 'utf8');
    assert(fileBytes.startsWith('PAPPRA-UNTRACKED/2'));
    assert(fileBytes.includes('\nF '));

    unlinkSync(untracked);
    symlinkSync('tracked.txt', untracked);
    const symlinkResume = await service.resume({
      taskId: 'task-p07',
      currentSession: 'pi-session-a',
    });
    const symlinkRepository = symlinkResume.packet?.codeDrift.repositories[0];
    assert.notEqual(symlinkRepository?.currentPatchDigest, fileDigest);
    assert.equal(symlinkRepository?.status, 'changed');
    assert.equal(symlinkResume.packet?.verificationStatus, 'stale');

    const symlinkSaved = await service.save(initialInput());
    assert.equal(symlinkSaved.ok, true, symlinkSaved.diagnostics[0]?.message);
    assert.equal(
      symlinkSaved.checkpoint?.repositories[0]?.captureStatus,
      'complete',
    );
    const symlinkDigest = symlinkSaved.checkpoint?.repositories[0]?.patchDigest;
    assert.notEqual(symlinkDigest, null);
    const symlinkPatch = join(
      root,
      '.pappra/local/tasks/task-p07/patches',
      `${symlinkDigest!.slice('sha256:'.length)}.patch`,
    );
    const symlinkBytes = readFileSync(symlinkPatch, 'utf8');
    assert(symlinkBytes.startsWith('PAPPRA-UNTRACKED/2'));
    assert(symlinkBytes.includes('\nL '));

    unlinkSync(untracked);
    writeText(untracked, 'tracked.txt');
    const fileResume = await service.resume({
      taskId: 'task-p07',
      currentSession: 'pi-session-a',
    });
    const fileRepository = fileResume.packet?.codeDrift.repositories[0];
    assert.notEqual(fileRepository?.currentPatchDigest, symlinkDigest);
    assert.equal(fileRepository?.status, 'changed');
    assert.equal(fileResume.packet?.verificationStatus, 'stale');
  } finally {
    cleanup(root);
  }
});

test('missing repositories return a valid diagnostic packet', async () => {
  const root = makeRepoWorkspace();
  try {
    const service = new CheckpointService(root);
    const saved = await service.save(initialInput());
    assert.equal(saved.ok, true, saved.diagnostics[0]?.message);
    writeWorkspaceConfig(root, baseWorkspaceConfig({ repositories: [] }));
    const resumed = await service.resume({
      taskId: 'task-p07',
      currentSession: 'pi-session-a',
    });
    assert.notEqual(resumed.packet, null);
    assert.equal(resumed.status, 'blocked');
    assert.equal(resumed.packet?.codeDrift.repositories[0]?.status, 'missing');
    assert.equal(
      resumed.packet?.codeDrift.repositories[0]?.currentCheckoutId,
      null,
    );
    assert.equal(
      resumed.packet?.boundedContext.objective,
      'Implement a bounded recovery packet',
    );
    assert.notEqual(resumed.packet?.verificationStatus, 'current');
  } finally {
    cleanup(root);
  }
});

test('capture and resume share the private payload bound', async () => {
  const root = makeRepoWorkspace();
  try {
    for (let index = 0; index < 3; index += 1) {
      writeFileSync(
        join(root, `blob-${index}.bin`),
        Buffer.alloc(3 * 1024 * 1024, 65 + index),
      );
    }
    const service = new CheckpointService(root);
    const saved = await service.save(initialInput());
    assert.equal(saved.ok, true, saved.diagnostics[0]?.message);
    assert.equal(saved.checkpoint?.repositories[0]?.captureStatus, 'complete');
    const resumed = await service.resume({
      taskId: 'task-p07',
      currentSession: 'pi-session-a',
    });
    assert.equal(
      resumed.packet?.codeDrift.repositories[0]?.patchStatus,
      'unchanged',
    );
    assert.equal(resumed.packet?.verificationStatus, 'current');
    assert(
      !resumed.packet?.blockingReasons.some(
        (entry) => entry.code === 'snapshot_incomplete',
      ),
    );
  } finally {
    cleanup(root);
  }
});

test('oversized aggregate capture is reported partial and stays readable', async () => {
  const root = makeRepoWorkspace();
  try {
    for (let index = 0; index < 4; index += 1) {
      writeFileSync(
        join(root, `large-${index}.bin`),
        Buffer.alloc(4.25 * 1024 * 1024, 65 + index),
      );
    }
    const service = new CheckpointService(root);
    const saved = await service.save(initialInput());
    assert.equal(saved.ok, true, saved.diagnostics[0]?.message);
    assert.equal(saved.checkpoint?.repositories[0]?.captureStatus, 'partial');
    const resumed = await service.resume({
      taskId: 'task-p07',
      currentSession: 'pi-session-a',
    });
    assert.notEqual(resumed.packet, null);
    assert.equal(
      resumed.packet?.codeDrift.repositories[0]?.patchStatus,
      'unchanged',
    );
    assert.equal(resumed.packet?.verificationStatus, 'unknown');
    assert(
      resumed.packet?.blockingReasons.some(
        (entry) => entry.code === 'snapshot_incomplete',
      ),
    );
  } finally {
    cleanup(root);
  }
});

test('rejects a task-context identity mismatch and a foreign predecessor', async () => {
  const root = makeWorkspace();
  try {
    const service = new CheckpointService(root);
    const first = await service.save(initialInput());
    assert.equal(first.ok, true);
    const contextPath = join(
      root,
      '.pappra/local/tasks/task-p07/task-context.json',
    );
    const context = JSON.parse(readFileSync(contextPath, 'utf8')) as {
      taskId: string;
    };
    context.taskId = 'different-task';
    writeFileSync(contextPath, JSON.stringify(context));
    const mismatched = await service.resume({
      taskId: 'task-p07',
      currentSession: 'pi-session-a',
    });
    assert.equal(mismatched.status, 'invalid');

    const root2 = makeWorkspace();
    try {
      const service2 = new CheckpointService(root2);
      const saved = await service2.save(initialInput());
      assert.equal(saved.ok, true);
      const checkpoint = JSON.parse(
        readFileSync(saved.checkpointPath!, 'utf8'),
      ) as { taskId: string };
      checkpoint.taskId = 'foreign-task';
      const bytes = Buffer.from(JSON.stringify(checkpoint));
      writeFileSync(saved.checkpointPath!, bytes);
      const pointer = JSON.parse(readFileSync(saved.latestPath!, 'utf8')) as {
        checkpointDigest: string;
      };
      pointer.checkpointDigest = sha256Digest(bytes);
      writeFileSync(saved.latestPath!, JSON.stringify(pointer));
      const next = await service2.save({
        taskId: 'task-p07',
        decisions: ['must not build on foreign checkpoint'],
        authorSession: 'pi-session-a',
      });
      assert.equal(next.ok, false);
      assert.equal(next.status, 'failed');
    } finally {
      cleanup(root2);
    }
  } finally {
    cleanup(root);
  }
});

test('checkout identity change is diagnosed and blocks execution', async () => {
  const root = makeRepoWorkspace();
  try {
    const service = new CheckpointService(root);
    const saved = await service.save(initialInput());
    assert.equal(saved.ok, true);
    writeMachineConfig(
      root,
      baseMachineConfig(root, {
        checkoutId: '22222222-2222-4222-8222-222222222222',
      }),
    );
    const resumed = await service.resume({
      taskId: 'task-p07',
      currentSession: 'pi-session-a',
    });
    assert.equal(resumed.packet?.codeDrift.status, 'changed');
    assert.equal(resumed.packet?.executionAllowed, false);
    assert(
      resumed.packet?.blockingReasons.some(
        (entry) => entry.code === 'checkout_identity_changed',
      ),
    );
  } finally {
    cleanup(root);
  }
});

test('forced complete without semantic content is downgraded to partial', async () => {
  const root = makeWorkspace();
  try {
    const saved = await new CheckpointService(root).save({
      ...initialInput(),
      decisions: [],
      attempted: [],
      nextActions: [],
      contextCompleteness: 'complete',
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.checkpoint?.contextCompleteness, 'partial');
    assert(
      saved.diagnostics.some(
        (entry) => entry.code === 'document_write_partial',
      ),
    );
    const resumed = await new CheckpointService(root).resume({
      taskId: 'task-p07',
      currentSession: 'pi-session-a',
    });
    assert.equal(resumed.packet?.contextCompleteness, 'partial');
    assert(
      resumed.packet?.blockingReasons.some(
        (entry) => entry.code === 'context_partial',
      ),
    );
  } finally {
    cleanup(root);
  }
});

test('unknown supported-authority record fails closed instead of granting execution', async () => {
  const root = makeWorkspace();
  try {
    writeText(
      join(root, 'record.json'),
      '{"schema":"unsupported","writer":"unknown","dispatch_frozen":true}',
    );
    const service = new CheckpointService(root);
    const saved = await service.save({
      ...initialInput(),
      collaborationRecordRef: 'record.json',
    });
    assert.equal(saved.ok, true);
    const resumed = await service.resume({
      taskId: 'task-p07',
      currentSession: 'pi-session-a',
    });
    assert.equal(resumed.packet?.executionAllowed, false);
    assert.equal(
      resumed.packet?.collaborationObservation.status,
      'unsupported',
    );
    assert.equal(
      resumed.packet?.collaborationObservation.authority.valid,
      false,
    );
    assert(
      resumed.packet?.blockingReasons.some(
        (entry) => entry.code === 'collaboration_authority_invalid',
      ),
    );
  } finally {
    cleanup(root);
  }
});

test('oversized Git diff capture is unknown and cannot verify current', async () => {
  const root = makeRepoWorkspace();
  try {
    writeText(join(root, 'tracked.txt'), 'A'.repeat(5 * 1024 * 1024));
    const service = new CheckpointService(root);
    const saved = await service.save(initialInput());
    assert.equal(saved.ok, true, saved.diagnostics[0]?.message);
    assert.equal(saved.checkpoint?.repositories[0]?.captureStatus, 'unknown');
    assert.equal(saved.checkpoint?.repositories[0]?.patchDigest, null);
    writeText(join(root, 'tracked.txt'), 'B'.repeat(5 * 1024 * 1024));
    const resumed = await service.resume({
      taskId: 'task-p07',
      currentSession: 'pi-session-a',
    });
    assert.equal(resumed.packet?.codeDrift.status, 'unknown');
    assert.equal(resumed.packet?.verificationStatus, 'unknown');
    assert(
      resumed.packet?.blockingReasons.some(
        (entry) => entry.code === 'snapshot_incomplete',
      ),
    );
  } finally {
    cleanup(root);
  }
});

test('reads a valid P01 authority but still requires live writer proof', async () => {
  const root = makeWorkspace();
  try {
    const taskRoot = join(root, 'collab-task');
    store.initTask(taskRoot, { taskId: 'review-task' });
    const saved = await new CheckpointService(root).save({
      ...initialInput(),
      collaborationRecordRef: join(taskRoot, 'task.json'),
    });
    assert.equal(saved.ok, true, saved.diagnostics[0]?.message);
    const resumed = await new CheckpointService(root).resume({
      taskId: 'task-p07',
      currentSession: 'pi-session-a',
    });
    assert.equal(resumed.packet?.executionAllowed, false);
    assert.equal(resumed.packet?.collaborationObservation.status, 'read');
    assert.equal(
      resumed.packet?.collaborationObservation.authority.valid,
      true,
    );
    assert(
      resumed.packet?.blockingReasons.some(
        (entry) => entry.code === 'live_writer_unverified',
      ),
    );
  } finally {
    cleanup(root);
  }
});
