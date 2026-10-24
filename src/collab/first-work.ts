import type { ResultEntry, RolloverIntent } from './types.js';

/** A native turn may prove succession while the attempt remains active. */
export function isNativeFirstWorkResult(
  result: ResultEntry,
  intent: RolloverIntent,
): boolean {
  if (
    result.status !== 'running' ||
    typeof result.native_ref !== 'object' ||
    result.native_ref === null
  )
    return false;
  const ref = result.native_ref as Record<string, unknown>;
  return (
    ref.schema === 'pappra/native-first-work/1' &&
    ref.handoff_id === intent.handoff_id &&
    ref.generation === intent.generation &&
    ref.session_id === intent.to.session_id &&
    ref.observation === 'native_agent_settled' &&
    typeof ref.evidence_ref === 'string' &&
    ref.evidence_ref.length > 0
  );
}
