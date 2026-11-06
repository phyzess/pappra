import { readBoundedFile } from '../infra/bounded-file.js';
import {
  isSafeWorkflowSubtaskId,
  workflowAssignmentPath,
} from '../schemas/collab-workflow.js';
import { reviewerReportSchema } from '../schemas/reviewer-report.js';
import { isAssignment } from './contracts.js';
import type { Attempt, TaskRecord } from './types.js';

function sealedWorkflowAssignment(record: TaskRecord, attempt: Attempt) {
  if (
    !attempt.assignment_digest ||
    !isSafeWorkflowSubtaskId(attempt.subtask_id)
  )
    return null;
  const sealed = readBoundedFile(
    workflowAssignmentPath(record.task_root, attempt.subtask_id),
    1024 * 1024,
  );
  if (!sealed.ok || sealed.digest !== attempt.assignment_digest) return null;
  let assignment: unknown;
  try {
    assignment = JSON.parse(sealed.text);
  } catch {
    return null;
  }
  if (
    !isAssignment(assignment) ||
    assignment.task_id !== record.task_id ||
    assignment.assignment_id !== attempt.subtask_id ||
    assignment.attempt !== attempt.attempt
  )
    return null;
  return assignment;
}

/** The sealed role remains evidence after a writer handoff changes the owner. */
export function sealedWorkflowRole(record: TaskRecord, attempt: Attempt) {
  const assignment = sealedWorkflowAssignment(record, attempt);
  if (assignment === null) return null;
  const [role] = assignment.roles;
  return assignment.roles.length === 1 &&
    (role === 'reviewer' || role === 'writer')
    ? role
    : null;
}

export function validateReviewAttachment(
  record: TaskRecord,
  attempt: Attempt,
  review: unknown,
):
  | { ok: true; candidateMessageId: string }
  | {
      ok: false;
      code:
        | 'review_findings_invalid'
        | 'review_assignment_unproven'
        | 'reviewer_role_required';
    } {
  const checked = reviewerReportSchema.safeParse(review);
  if (!checked.success) return { ok: false, code: 'review_findings_invalid' };
  const assignment = sealedWorkflowAssignment(record, attempt);
  if (
    assignment === null ||
    assignment.assignee.agent_id !== attempt.assignee.agent_id ||
    assignment.assignee.session_id !== attempt.assignee.session_id ||
    assignment.assignee.harness !== attempt.assignee.harness
  )
    return { ok: false, code: 'review_assignment_unproven' };
  if (assignment.roles.length !== 1 || assignment.roles[0] !== 'reviewer')
    return { ok: false, code: 'reviewer_role_required' };
  return {
    ok: true,
    candidateMessageId: checked.data.candidate.report_message_id,
  };
}
