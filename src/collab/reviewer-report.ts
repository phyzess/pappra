import { readBoundedFile } from '../infra/bounded-file.js';
import {
  isSafeWorkflowSubtaskId,
  workflowAssignmentPath,
} from '../schemas/collab-workflow.js';
import { reviewerReportSchema } from '../schemas/reviewer-report.js';
import { isAssignment } from './contracts.js';
import type { Attempt, TaskRecord } from './types.js';

export const REVIEW_REPORT_KIND = 'review_findings';

/** A workflow role comes from the digest-pinned assignment for this attempt. */
export function sealedWorkflowRole(
  record: TaskRecord,
  attempt: Attempt,
): 'reviewer' | 'writer' | null {
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
    assignment.attempt !== attempt.attempt ||
    assignment.assignee.agent_id !== attempt.assignee.agent_id ||
    assignment.assignee.session_id !== attempt.assignee.session_id ||
    assignment.assignee.harness !== attempt.assignee.harness
  )
    return null;
  const [role] = assignment.roles;
  return assignment.roles.length === 1 &&
    (role === 'reviewer' || role === 'writer')
    ? role
    : null;
}

export function reviewAttachmentFailure(
  record: TaskRecord,
  attempt: Attempt,
  review: unknown,
):
  | 'review_findings_invalid'
  | 'review_assignment_unproven'
  | 'reviewer_role_required'
  | null {
  if (!reviewerReportSchema.safeParse(review).success)
    return 'review_findings_invalid';
  const role = sealedWorkflowRole(record, attempt);
  if (role === null) return 'review_assignment_unproven';
  return role === 'reviewer' ? null : 'reviewer_role_required';
}
