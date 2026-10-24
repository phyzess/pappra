import type { LocalProcessIdentity } from '../../infra/process-identity.js';
import type { ManagedPiExecutionScope } from '../../schemas/managed-pi-execution.js';

const brand = Symbol('managed-pi-resume-authorization');
export interface ManagedPiResumeCapabilityData {
  readonly sessionId: string;
  readonly cwd: string;
  readonly sessionFile: string;
  readonly transcriptDigest: string;
  readonly scope: ManagedPiExecutionScope;
  readonly checkpointSequence: number;
  readonly checkpointDigest: string;
  readonly sourceRunId: string;
  readonly sourcePid: number;
  readonly sourceProcessIdentity?: LocalProcessIdentity;
  readonly hostIdentity: string;
  readonly registeredInputs: readonly {
    readonly requestId: string;
    readonly inputDigest: string;
  }[];
}

/** Serialization preserves context, never the private in-memory admission. */
export interface ManagedPiSdkResumeAuthorization extends ManagedPiResumeCapabilityData {
  readonly [brand]: true;
}
interface Admission {
  phase: 'reserved' | 'registered';
  readonly assertFresh: (expected: { sessionId: string; cwd: string }) => void;
}
const admissions = new WeakMap<object, Admission>();

/** Internal issuer port, deliberately absent from every public package export. */
export function issueManagedPiResumeCapability(
  data: ManagedPiResumeCapabilityData,
  assertFresh: Admission['assertFresh'],
): ManagedPiSdkResumeAuthorization {
  if (typeof assertFresh !== 'function')
    throw new Error('managed_pi_resume_freshness_validator_required');
  const capability = Object.freeze({ ...data, [brand]: true as const });
  admissions.set(capability, { phase: 'reserved', assertFresh });
  return capability;
}

export function isManagedPiResumeCapabilityReserved(
  value: ManagedPiSdkResumeAuthorization,
): boolean {
  return admissions.get(value)?.phase === 'reserved';
}

export function assertManagedPiSdkResumeAuthorization(
  value: ManagedPiSdkResumeAuthorization,
  expected: { sessionId: string; cwd: string },
): void {
  const admission = admissions.get(value);
  if (
    !admission ||
    admission.phase !== 'reserved' ||
    value.sessionId !== expected.sessionId ||
    value.cwd !== expected.cwd
  )
    throw new Error('managed_pi_resume_authorization_invalid');
  // The issuer supplies current authority/namespace/transcript checks. The native
  // adapter knows this port, rather than importing application orchestration.
  admission.assertFresh(expected);
}

export function markManagedPiResumeCapabilityRegistered(
  value: ManagedPiSdkResumeAuthorization,
): void {
  const admission = admissions.get(value);
  if (!admission) throw new Error('managed_pi_resume_authorization_invalid');
  admission.phase = 'registered';
}

export function revokeManagedPiResumeCapability(
  value: ManagedPiSdkResumeAuthorization,
): void {
  admissions.delete(value);
}
