import assert from 'node:assert/strict';
import test from 'node:test';
import * as nativeApi from '../../src/hosts/pi/managed-sdk-session.js';
import {
  assertManagedPiSdkResumeAuthorization,
  issueManagedPiResumeCapability,
  markManagedPiResumeCapabilityRegistered,
  revokeManagedPiResumeCapability,
  type ManagedPiResumeCapabilityData,
  type ManagedPiSdkResumeAuthorization,
} from '../../src/hosts/pi/resume-capability.js';

const data: ManagedPiResumeCapabilityData = {
  sessionId: 'session',
  cwd: '/repo',
  sessionFile: '/repo/session.jsonl',
  transcriptDigest: 'sha256:transcript',
  checkpointSequence: 1,
  checkpointDigest: 'checkpoint',
  sourceRunId: 'old-run',
  sourcePid: 42,
  hostIdentity: 'host',
  registeredInputs: [],
  scope: {
    schema: 'pappra/managed-pi-execution-scope/1',
    task_id: 'task',
    task_root: '/domain/tasks/task',
    session_id: 'session',
    cwd: '/repo',
    subtask_id: 'work',
    attempt: 1,
    owner_epoch: 1,
    claim_epochs: [],
  },
};
const expected = { sessionId: 'session', cwd: '/repo' };

test('opaque native resume capability requires fresh issuer validation and rejects copied or revoked data', () => {
  assert.throws(
    () =>
      Reflect.apply(issueManagedPiResumeCapability, null, [data, undefined]),
    /freshness_validator_required/,
  );
  let checks = 0;
  let fresh = true;
  const token = issueManagedPiResumeCapability(data, () => {
    checks += 1;
    if (!fresh) throw new Error('authority_changed');
  });
  assert(Object.isFrozen(token));
  assertManagedPiSdkResumeAuthorization(token, expected);
  assertManagedPiSdkResumeAuthorization(token, expected);
  assert.equal(checks, 2);
  for (const fake of [
    JSON.parse(JSON.stringify(token)),
    { ...token },
  ] as ManagedPiSdkResumeAuthorization[]) {
    assert.throws(
      () => assertManagedPiSdkResumeAuthorization(fake, expected),
      /authorization_invalid/,
    );
  }
  fresh = false;
  assert.throws(
    () => assertManagedPiSdkResumeAuthorization(token, expected),
    /authority_changed/,
  );
  fresh = true;
  revokeManagedPiResumeCapability(token);
  assert.throws(
    () => assertManagedPiSdkResumeAuthorization(token, expected),
    /authorization_invalid/,
  );
  assert.equal('issueManagedPiResumeCapability' in nativeApi, false);
  assert.equal('markManagedPiResumeCapabilityRegistered' in nativeApi, false);
});

test('a durably registered capability is consumed and cannot reopen the native session', () => {
  const token = issueManagedPiResumeCapability(data, () => undefined);
  markManagedPiResumeCapabilityRegistered(token);
  assert.throws(
    () => assertManagedPiSdkResumeAuthorization(token, expected),
    /authorization_invalid/,
  );
  revokeManagedPiResumeCapability(token);
  assert.throws(
    () => markManagedPiResumeCapabilityRegistered(token),
    /authorization_invalid/,
  );
});
