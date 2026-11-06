import { contentDigest } from '../../collab/envelope.js';
import { readRegisteredMessageSafe } from '../../collab/persisted-messages.js';
import {
  REVIEW_REPORT_KIND,
  sealedWorkflowRole,
} from '../../collab/reviewer-report.js';
import {
  reviewerReportSchema,
  type ReviewerReport,
} from '../../schemas/reviewer-report.js';
import type { OpenedWorkflowTask } from './context.js';

const MAX_REVIEW_REPORTS = 16;
export const REVIEW_ADVICE_RULE = 'pappra/reviewer-advice/1';

function findingReason(
  finding: ReviewerReport['findings'][number],
  base: ReviewerReport['base'],
) {
  if (finding.severity === 'minor' || finding.severity === 'info')
    return 'low_severity' as const;
  if (finding.proof.state === 'unverified')
    return 'unverified_concern' as const;
  if (finding.origin === 'preexisting') return 'preexisting_risk' as const;
  if (finding.scope === 'out_of_scope') return 'out_of_scope_risk' as const;
  if (base.state === 'unavailable')
    return 'introduced_base_unavailable' as const;
  return 'introduced_in_scope_concern' as const;
}

async function candidateStatus(
  task: OpenedWorkflowTask,
  candidate: ReviewerReport['candidate'],
) {
  const { record } = task;
  const reference = record.messages.find(
    (item) =>
      item.message_id === candidate.report_message_id &&
      item.type === 'REPORT' &&
      item.state === 'applied',
  );
  const result = record.results.find(
    (item) =>
      item.message_id === candidate.report_message_id &&
      item.classification === 'applied' &&
      item.status === 'completed',
  );
  if (!reference || !result) return 'candidate_unavailable' as const;
  const attempt = record.attempts.find(
    (item) =>
      item.subtask_id === result.subtask_id && item.attempt === result.attempt,
  );
  if (!attempt) return 'candidate_unavailable' as const;
  if (
    reference.content_digest !== candidate.report_digest ||
    result.input_revision !== candidate.input_revision ||
    attempt.input_revision !== candidate.input_revision ||
    record.attempts.some(
      (item) =>
        item.subtask_id === result.subtask_id && item.attempt > result.attempt,
    )
  )
    return 'candidate_drift' as const;
  if (sealedWorkflowRole(record, attempt) !== 'writer')
    return 'candidate_unavailable' as const;
  const read = await readRegisteredMessageSafe(
    task.opened,
    candidate.report_message_id,
  );
  if (!read.ok) return 'candidate_unavailable' as const;
  const message = read.value.message;
  return message.type === 'REPORT' &&
    message.body.status === 'completed' &&
    message.subtask_id === result.subtask_id &&
    message.attempt === result.attempt &&
    contentDigest(message) === candidate.report_digest
    ? ('registered_candidate_matches' as const)
    : ('candidate_drift' as const);
}

/** Report facts remain evidence. This projection never participates in acceptance. */
export async function projectReviewerAdvice(
  task: OpenedWorkflowTask,
  targetReport?: string,
  limit?: number,
) {
  const marked = task.record.messages.filter(
    (item) =>
      item.type === 'REPORT' &&
      item.state === 'applied' &&
      item.body_kind === REVIEW_REPORT_KIND,
  );
  const count = Number.isSafeInteger(limit)
    ? Math.max(0, Math.min(limit!, MAX_REVIEW_REPORTS))
    : MAX_REVIEW_REPORTS;
  const selected = count === 0 ? [] : marked.slice(-count);
  const reports = await Promise.all(
    selected.map(async (entry) => {
      const read = await readRegisteredMessageSafe(
        task.opened,
        entry.message_id,
      );
      const message = read.ok ? read.value.message : null;
      const review = reviewerReportSchema.safeParse(message?.body.review);
      if (
        message === null ||
        contentDigest(message) !== entry.content_digest ||
        !review.success
      ) {
        if (targetReport !== undefined && entry.message_id !== targetReport)
          return null;
        return {
          review_message_id: entry.message_id,
          state: 'review_evidence_unavailable' as const,
        };
      }
      const { candidate, base, findings } = review.data;
      if (
        targetReport !== undefined &&
        targetReport !== candidate.report_message_id &&
        targetReport !== entry.message_id
      )
        return null;
      const candidate_status = await candidateStatus(task, candidate);
      const evaluated = findings.map((finding) => ({
        ...finding,
        reason: findingReason(finding, base),
      }));
      const reasons = new Set(evaluated.map((item) => item.reason));
      const completed = task.record.results.some(
        (result) =>
          result.message_id === entry.message_id &&
          result.classification === 'applied' &&
          result.status === 'completed',
      );
      const state =
        candidate_status !== 'registered_candidate_matches'
          ? candidate_status
          : !completed
            ? 'review_incomplete'
            : reasons.has('introduced_in_scope_concern')
              ? 'blocking_concerns'
              : reasons.has('unverified_concern') ||
                  reasons.has('introduced_base_unavailable')
                ? 'requires_judgment'
                : reasons.has('preexisting_risk') ||
                    reasons.has('out_of_scope_risk')
                  ? 'delivery_risk'
                  : evaluated.length === 0
                    ? 'no_findings_reported'
                    : 'low_severity_findings';
      return {
        review_message_id: entry.message_id,
        review_digest: entry.content_digest,
        state,
        candidate_status,
        candidate,
        base,
        findings: evaluated,
      };
    }),
  );
  return {
    rule: REVIEW_ADVICE_RULE,
    advisory: true as const,
    omitted: marked.length - selected.length,
    reports: reports.filter((report) => report !== null),
  };
}

export type ReviewerAdvice = Awaited<ReturnType<typeof projectReviewerAdvice>>;
