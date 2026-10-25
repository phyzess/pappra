import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  COLLAB_SESSION_TRANSITION_REQUEST_SCHEMA,
  loadSessionTransitionRequest,
  validateSessionTransitionRequest,
} from '../../src/app/collab-session-transition.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;

interface Fixture {
  readonly root: string;
  readonly taskRoot: string;
  readonly workspaceRoot: string;
  readonly bootstrapFile: string;
  readonly request: Record<string, unknown>;
}

function identity(agent: string, session: string, cwd: string) {
  return { agent_id: agent, session_id: session, harness: 'pi', cwd };
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'pappra-transition-request-'));
  const taskRoot = join(root, 'task-1');
  const workspaceRoot = join(root, 'workspace');
  const sourceCwd = join(root, 'source-cwd');
  const successorCwd = join(root, 'successor-cwd');
  for (const directory of [taskRoot, workspaceRoot, sourceCwd, successorCwd])
    mkdirSync(directory, { recursive: true });
  const bootstrapFile = join(root, 'bootstrap.json');
  writeFileSync(bootstrapFile, '{}\n');
  return {
    root,
    taskRoot,
    workspaceRoot,
    bootstrapFile,
    request: {
      schema: COLLAB_SESSION_TRANSITION_REQUEST_SCHEMA,
      task_root: taskRoot,
      transition_id: 'intent-1',
      intent: {
        intent_id: 'intent-1',
        generation: 1,
        handoff_id: 'handoff-1',
        subtask_id: 'subtask-1',
        attempt: 1,
        input_revision: DIGEST,
        from: identity('agent-a', 'session-a', sourceCwd),
        to: identity('agent-b', 'session-b', successorCwd),
        claims: [{ claim_id: 'claim-1', resource_epoch: 0 }],
        coordinator_epoch: 1,
      },
      bundle: {
        root: workspaceRoot,
        continuity_task_id: 'continuity-1',
        bundle_id: 'bundle-1',
        digest: DIGEST,
      },
      bootstrap_request: { ref: bootstrapFile, digest: DIGEST },
      evidence: { ack_message_id: null, first_work_report_id: null },
      archive_mode: 'task-retirement',
    },
  };
}

function withFixture(body: (fixture: Fixture) => void): void {
  const created = fixture();
  try {
    body(created);
  } finally {
    rmSync(created.root, { recursive: true, force: true });
  }
}

function writeRequest(fixture: Fixture, value: unknown, name: string): string {
  const file = join(fixture.root, name);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function mutable(fixture: Fixture): Record<string, unknown> {
  return JSON.parse(JSON.stringify(fixture.request));
}

function rejection(value: unknown): string {
  const result = validateSessionTransitionRequest(value);
  assert.equal(result.ok, false, 'expected the request to be rejected');
  return result.ok ? '' : result.code;
}

test('a complete request is accepted and normalized', () => {
  withFixture((base) => {
    const result = validateSessionTransitionRequest(base.request);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.request, base.request);
    assert.equal(
      result.request.schema,
      COLLAB_SESSION_TRANSITION_REQUEST_SCHEMA,
    );
    assert.equal(result.request.archive_mode, 'task-retirement');
    assert.equal(result.request.intent.claims[0]?.resource_epoch, 0);
  });
});

test('shape and schema violations are rejected with their own codes', () => {
  withFixture((base) => {
    const extra = { ...mutable(base), undocumented: true };
    const shape = validateSessionTransitionRequest(extra);
    assert.equal(shape.ok, false);
    assert.equal(shape.ok === false && shape.code, 'request_shape_invalid');

    const wrongSchema = { ...mutable(base), schema: 'pappra/wrong/1' };
    const schema = validateSessionTransitionRequest(wrongSchema);
    assert.equal(schema.ok === false && schema.code, 'request_schema_invalid');
    assert.match(
      schema.ok === false ? schema.message : '',
      /collaboration-session-transition-request\/1/,
    );
  });
});

test('task root, transition id and intent violations are rejected', () => {
  withFixture((base) => {
    const relativeRoot = { ...mutable(base), task_root: 'task-1' };
    assert.equal(rejection(relativeRoot), 'task_root_invalid');

    const mismatched = { ...mutable(base), transition_id: 'intent-2' };
    assert.equal(rejection(mismatched), 'transition_id_mismatch');

    const badIntent = mutable(base);
    badIntent['intent'] = {
      ...(badIntent['intent'] as Record<string, unknown>),
      claims: [],
    };
    assert.equal(rejection(badIntent), 'intent_invalid');

    const sameSourceSuccessor = mutable(base);
    const duplicated = sameSourceSuccessor['intent'] as Record<string, unknown>;
    duplicated['to'] = duplicated['from'];
    assert.equal(rejection(sameSourceSuccessor), 'intent_invalid');
  });
});

test('bundle, bootstrap, evidence and archive violations are rejected', () => {
  withFixture((base) => {
    const badBundle = mutable(base);
    badBundle['bundle'] = {
      ...(badBundle['bundle'] as object),
      digest: 'nope',
    };
    const bundle = validateSessionTransitionRequest(badBundle);
    assert.equal(bundle.ok === false && bundle.code, 'bundle_invalid');

    const badBootstrap = mutable(base);
    badBootstrap['bootstrap_request'] = {
      ref: 'relative.json',
      digest: DIGEST,
    };
    const bootstrap = validateSessionTransitionRequest(badBootstrap);
    assert.equal(
      bootstrap.ok === false && bootstrap.code,
      'bootstrap_request_invalid',
    );

    const evidenceShape = mutable(base);
    evidenceShape['evidence'] = {
      ack_message_id: null,
      first_work_report_id: null,
      consumed: true,
    };
    const evidence = validateSessionTransitionRequest(evidenceShape);
    assert.equal(evidence.ok === false && evidence.code, 'evidence_invalid');

    const missingEvidenceField = mutable(base);
    missingEvidenceField['evidence'] = { ack_message_id: null };
    assert.equal(rejection(missingEvidenceField), 'evidence_id_invalid');

    const evidenceId = mutable(base);
    evidenceId['evidence'] = {
      ack_message_id: 'not a safe id',
      first_work_report_id: null,
    };
    const id = validateSessionTransitionRequest(evidenceId);
    assert.equal(id.ok === false && id.code, 'evidence_id_invalid');

    const archive = { ...mutable(base), archive_mode: 'native-archive' };
    const mode = validateSessionTransitionRequest(archive);
    assert.equal(mode.ok === false && mode.code, 'archive_mode_invalid');
  });
});

test('a mismatched managed execution scope is rejected, a pinned one is kept', () => {
  withFixture((base) => {
    const pinned = mutable(base);
    const pinnedIntent = pinned['intent'] as Record<string, unknown>;
    pinnedIntent['claims'] = [{ claim_id: 'claim-1', resource_epoch: 1 }];
    const scope = {
      schema: 'pappra/managed-pi-execution-scope/1',
      task_id: 'task-1',
      task_root: base.taskRoot,
      session_id: 'session-a',
      cwd: join(base.root, 'source-cwd'),
      subtask_id: 'subtask-1',
      attempt: 1,
      owner_epoch: 1,
      claim_epochs: [{ claim_id: 'claim-1', resource_epoch: 1 }],
    };
    const accepted = validateSessionTransitionRequest({
      ...pinned,
      managed_execution_scope: scope,
    });
    assert.equal(accepted.ok, true);
    assert.deepEqual(
      accepted.ok ? accepted.request.managed_execution_scope : null,
      scope,
    );

    const mismatched = validateSessionTransitionRequest({
      ...pinned,
      managed_execution_scope: { ...scope, subtask_id: 'other-subtask' },
    });
    assert.equal(
      mismatched.ok === false && mismatched.code,
      'managed_execution_scope_mismatch',
    );
  });
});

test('the immutable digest ignores evidence but tracks the documented fields', () => {
  withFixture((base) => {
    const withoutEvidence = writeRequest(
      base,
      base.request,
      'no-evidence.json',
    );
    const withEvidence = writeRequest(
      base,
      {
        ...mutable(base),
        evidence: {
          ack_message_id: 'ack-1',
          first_work_report_id: 'report-1',
        },
      },
      'with-evidence.json',
    );
    const loadedA = loadSessionTransitionRequest(withoutEvidence);
    const loadedB = loadSessionTransitionRequest(withEvidence);
    assert.equal(loadedA.ok && loadedB.ok, true);
    if (!loadedA.ok || !loadedB.ok) return;
    assert.equal(
      loadedA.value.immutable_digest,
      loadedB.value.immutable_digest,
    );
    assert.notEqual(loadedA.value.file_digest, loadedB.value.file_digest);
    assert.deepEqual(loadedB.value.request.evidence, {
      ack_message_id: 'ack-1',
      first_work_report_id: 'report-1',
    });

    const nextGeneration = writeRequest(
      base,
      {
        ...mutable(base),
        transition_id: 'intent-2',
        intent: {
          ...(base.request['intent'] as Record<string, unknown>),
          intent_id: 'intent-2',
          generation: 2,
        },
      },
      'generation-2.json',
    );
    const loadedC = loadSessionTransitionRequest(nextGeneration);
    assert.equal(loadedC.ok, true);
    assert.notEqual(
      loadedC.ok ? loadedC.value.immutable_digest : null,
      loadedA.value.immutable_digest,
    );

    const retargeted = writeRequest(
      base,
      { ...mutable(base), task_root: base.root },
      'other-root.json',
    );
    const loadedD = loadSessionTransitionRequest(retargeted);
    assert.equal(loadedD.ok, true);
    assert.notEqual(
      loadedD.ok ? loadedD.value.immutable_digest : null,
      loadedA.value.immutable_digest,
    );
  });
});

test('the loader keeps kind and next_action semantics for unreadable input', () => {
  withFixture((base) => {
    const missing = loadSessionTransitionRequest(
      join(base.root, 'absent', 'request.json'),
    );
    assert.equal(missing.ok, false);
    if (missing.ok) return;
    assert.equal(missing.kind, 'invalid');
    assert.equal(missing.code, 'request_unreadable');
    assert.match(missing.message, /absolute bounded regular file/);
    assert.notEqual(missing.next_action, null);

    const malformed = join(base.root, 'malformed.json');
    writeFileSync(malformed, '{ not json\n');
    const invalidJson = loadSessionTransitionRequest(malformed);
    assert.equal(invalidJson.ok, false);
    if (invalidJson.ok) return;
    assert.equal(invalidJson.code, 'request_invalid_json');
    assert.equal(invalidJson.kind, 'invalid');

    const invalidBody = writeRequest(
      base,
      { ...mutable(base), archive_mode: 'native-archive' },
      'invalid-body.json',
    );
    const invalid = loadSessionTransitionRequest(invalidBody);
    assert.equal(invalid.ok, false);
    if (invalid.ok) return;
    assert.equal(invalid.code, 'archive_mode_invalid');
    assert.equal(invalid.next_action, null);
  });
});

test('the loader reports the raw file digest for an accepted request', () => {
  withFixture((base) => {
    const file = writeRequest(base, base.request, 'request.json');
    const loaded = loadSessionTransitionRequest(file);
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.equal(loaded.value.file, file);
    assert.match(loaded.value.file_digest, /^sha256:[0-9a-f]{64}$/);
    assert.match(loaded.value.immutable_digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(loaded.value.request.task_root, base.taskRoot);
  });
});
