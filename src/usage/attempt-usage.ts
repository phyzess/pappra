import { z } from 'zod';
import type { Attempt, TaskRecord } from '../schemas/collaboration-state.js';
import {
  attemptUsageReceiptSchema,
  type AttemptUsage,
  type AttemptUsageProjection,
  type AttemptUsageReceipt,
} from '../schemas/attempt-usage.js';
import { sha256Digest } from '../infra/fs.js';
import { record } from '../app/capability-evidence/shared.js';
import {
  claudeInvocationAttempt,
  codexRolloutAttempt,
  piSessionAttempt,
} from './native-attempt-evidence.js';

const MAX_ATTEMPTS = 16;
const MAX_CAPTURE_BYTES = 512 * 1024;
const TERMINAL_REPORTS = new Set(['completed', 'failed', 'cancelled']);

const captureSchema = z.strictObject({
  through: z.iso.datetime({ offset: true }),
  jsonl: z.string(),
  execution: z
    .strictObject({
      status: z.literal('exited'),
      exit_code: z.number().int(),
      started_at: z.iso.datetime({ offset: true }),
      finished_at: z.iso.datetime({ offset: true }),
    })
    .optional(),
});

type UnavailableReason = Extract<
  AttemptUsage,
  { state: 'unavailable' }
>['reason'];
const unavailable = (reason: UnavailableReason): AttemptUsage => ({
  state: 'unavailable',
  reason,
});

/** Derive a numbers-only receipt from the private workflow report request. */
export function captureAttemptUsage(
  attempt: Attempt,
  input: unknown,
  clock: number,
): AttemptUsageReceipt {
  const session_id = attempt.assignee.session_id;
  const receipt = (token_usage: AttemptUsage): AttemptUsageReceipt => ({
    schema: 'pappra/attempt-usage-receipt/1',
    session_id,
    token_usage,
  });
  const harness = attempt.assignee.harness;
  if (harness !== 'codex' && harness !== 'claude' && harness !== 'pi')
    return receipt(unavailable('unsupported_harness'));

  const capture = captureSchema.safeParse(input);
  if (!capture.success) return receipt(unavailable('native_usage_unproven'));
  const { jsonl, through, execution } = capture.data;
  if ((harness === 'claude') !== (execution !== undefined))
    return receipt(unavailable('native_usage_unproven'));
  if (Buffer.byteLength(jsonl) > MAX_CAPTURE_BYTES)
    return receipt(unavailable('evidence_budget_exceeded'));

  const started = Date.parse(attempt.created_at);
  const finished = Date.parse(through);
  if (
    !session_id ||
    (attempt.native?.session_id != null &&
      attempt.native.session_id !== session_id) ||
    !Number.isFinite(started) ||
    !Number.isFinite(finished) ||
    finished < started ||
    finished > clock
  )
    return receipt(unavailable('attempt_boundary_unproven'));
  const window = { sessionId: session_id, started, finished };
  const counts =
    harness === 'codex'
      ? codexRolloutAttempt(jsonl, window)
      : harness === 'pi'
        ? piSessionAttempt(jsonl, window)
        : execution === undefined
          ? null
          : claudeInvocationAttempt(jsonl, execution, window);

  if (counts === null) return receipt(unavailable('native_usage_unproven'));
  return receipt({
    state: 'available',
    harness,
    through,
    ...counts,
    evidence_digests: [
      sha256Digest(jsonl),
      ...(execution === undefined
        ? []
        : [sha256Digest(JSON.stringify(execution))]),
    ],
  });
}

const keyOf = (item: { subtask_id: string; attempt: number }) =>
  JSON.stringify([item.subtask_id, item.attempt]);

export function projectAttemptUsage(
  task: TaskRecord,
  attempts: readonly Attempt[],
): AttemptUsageProjection {
  const selected = attempts
    .slice(-MAX_ATTEMPTS)
    .filter((item) => Number.isSafeInteger(item.attempt) && item.attempt >= 1);
  const results = new Map<string, TaskRecord['results'][number]>();
  for (const result of task.results) {
    if (
      result.classification === 'applied' &&
      TERMINAL_REPORTS.has(result.status)
    )
      results.set(keyOf(result), result);
  }

  function observe(attempt: Attempt): AttemptUsage {
    const result = results.get(keyOf(attempt));
    if (result === undefined) return unavailable('evidence_not_registered');
    const ref = result.native_ref;
    if (!record(ref) || ref['usage_observation'] === undefined)
      return unavailable('evidence_not_registered');
    const read = attemptUsageReceiptSchema.safeParse(ref['usage_observation']);
    if (!read.success) return unavailable('native_usage_unproven');
    const receipt = read.data;
    const sessionId = attempt.assignee.session_id;
    if (
      receipt.session_id !== sessionId ||
      (attempt.native?.session_id != null &&
        attempt.native.session_id !== sessionId)
    )
      return unavailable('attempt_boundary_unproven');
    if (receipt.token_usage.state === 'unavailable') return receipt.token_usage;
    const started = Date.parse(attempt.created_at);
    const reportedAt = Date.parse(result.recorded_at);
    const through = Date.parse(receipt.token_usage.through);
    if (
      receipt.token_usage.harness !== attempt.assignee.harness ||
      !Number.isFinite(started) ||
      !Number.isFinite(reportedAt) ||
      !Number.isFinite(through) ||
      through < started ||
      through > reportedAt
    )
      return unavailable('attempt_boundary_unproven');

    const overlaps = task.attempts.some((other) => {
      if (
        keyOf(other) === keyOf(attempt) ||
        other.assignee.harness !== attempt.assignee.harness ||
        (other.assignee.session_id !== sessionId &&
          other.native?.session_id !== sessionId)
      )
        return false;
      const otherStart = Date.parse(other.created_at);
      const otherEnd =
        other.closed_at === undefined ? Infinity : Date.parse(other.closed_at);
      return (
        !Number.isFinite(otherStart) ||
        Number.isNaN(otherEnd) ||
        (otherStart <= through && otherEnd >= started)
      );
    });
    return overlaps
      ? unavailable('attempt_boundary_unproven')
      : receipt.token_usage;
  }

  return {
    attempts: selected.map((item) => ({
      subtask_id: item.subtask_id,
      attempt: item.attempt,
      token_usage: observe(item),
    })),
    omitted: attempts.length - selected.length,
    accounting: 'completed_native_work_input_includes_cache_reads',
    provenance: 'attempt_owner_report',
  };
}
