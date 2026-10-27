import {
  parseWorkflowAcceptRequest,
  parseWorkflowDispatchRequest,
  parseWorkflowParticipantRequest,
  parseWorkflowPrepareRequest,
  parseWorkflowReclaimRequest,
  WORKFLOW_ACCEPT_REQUEST_SCHEMA,
  WORKFLOW_DISPATCH_REQUEST_SCHEMA,
  WORKFLOW_PARTICIPANT_REQUEST_SCHEMA,
  WORKFLOW_PREPARE_REQUEST_SCHEMA,
  WORKFLOW_RECLAIM_REQUEST_SCHEMA,
  type WorkflowAcceptRequest,
  type WorkflowDispatchRequest,
  type WorkflowParticipantRequest,
  type WorkflowPrepareRequest,
  type WorkflowReclaimRequest,
} from '../schemas/collab-workflow.js';
import { readBoundedJson } from './collab-workflow/context.js';
import {
  workflowFailure,
  type WorkflowOutcome,
} from './collab-workflow/types.js';

export * from './collab-workflow/types.js';
export {
  applyPrepare,
  deriveCohort,
  planPrepare,
  type DerivedAssignment,
  type DerivedCohort,
  type PreparePlanReport,
} from './collab-workflow/prepare.js';
export {
  applyDispatch,
  planDispatch,
  type DispatchPlanReport,
} from './collab-workflow/dispatch.js';
export { applyParticipant } from './collab-workflow/participant.js';
export { applyAccept } from './collab-workflow/acceptance.js';
export { applyReclaim } from './collab-workflow/reclaim.js';
export { inspectWorkflow } from './collab-workflow/inspect.js';
export {
  workflowAssignmentPath,
  workflowBindingPath,
  workflowIntentsDir,
  workflowManifestPath,
  WORKFLOW_ACCEPT_REQUEST_SCHEMA,
  WORKFLOW_DISPATCH_REQUEST_SCHEMA,
  WORKFLOW_MANIFEST_SCHEMA,
  WORKFLOW_PARTICIPANT_REQUEST_SCHEMA,
  WORKFLOW_PLAN_SCHEMA,
  WORKFLOW_PREPARE_REQUEST_SCHEMA,
  WORKFLOW_RECLAIM_REQUEST_SCHEMA,
  WORKFLOW_RESULT_SCHEMA,
} from '../schemas/collab-workflow.js';
export type {
  WorkflowAcceptRequest,
  WorkflowAssignmentDeclaration,
  WorkflowBinding,
  WorkflowCaller,
  WorkflowCoordinator,
  WorkflowDispatchRequest,
  WorkflowParticipantRequest,
  WorkflowPrepareRequest,
  WorkflowReclaimRequest,
  WorkflowReportDeclaration,
  WorkflowResourceDeclaration,
} from '../schemas/collab-workflow.js';

/**
 * The typed orchestration facade.
 *
 * Callers hand one declared request per step. Every value the protocol repeats — task root,
 * assignment documents, digests, message ids, correlated envelopes, claim lists — is derived
 * here, and every authority decision stays with the existing engines.
 */

function loadDocument<T>(
  file: string,
  schema: string,
  parse: (
    input: unknown,
  ) =>
    | { ok: true; value: T }
    | { ok: false; message: string; nextAction: string | null },
): WorkflowOutcome<T> {
  const read = readBoundedJson(file, 'workflow request');
  if (!read.ok) return read;
  const candidate = read.value;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    (candidate as { schema?: unknown }).schema !== schema
  )
    return workflowFailure(
      'request_schema_invalid',
      `Expected a ${schema} document at ${file}.`,
      'Pass the request file for this action; a mismatched schema is refused.',
    );
  const parsed = parse(candidate);
  if (!parsed.ok)
    return workflowFailure(
      'request_invalid',
      parsed.message,
      parsed.nextAction,
    );
  return { ok: true, value: parsed.value };
}

export function loadPrepareRequest(
  file: string,
): WorkflowOutcome<WorkflowPrepareRequest> {
  return loadDocument(
    file,
    WORKFLOW_PREPARE_REQUEST_SCHEMA,
    parseWorkflowPrepareRequest,
  );
}

export function loadDispatchRequest(
  file: string,
): WorkflowOutcome<WorkflowDispatchRequest> {
  return loadDocument(
    file,
    WORKFLOW_DISPATCH_REQUEST_SCHEMA,
    parseWorkflowDispatchRequest,
  );
}

export function loadParticipantRequest(
  file: string,
): WorkflowOutcome<WorkflowParticipantRequest> {
  return loadDocument(
    file,
    WORKFLOW_PARTICIPANT_REQUEST_SCHEMA,
    parseWorkflowParticipantRequest,
  );
}

export function loadAcceptRequest(
  file: string,
): WorkflowOutcome<WorkflowAcceptRequest> {
  return loadDocument(
    file,
    WORKFLOW_ACCEPT_REQUEST_SCHEMA,
    parseWorkflowAcceptRequest,
  );
}

export function loadReclaimRequest(
  file: string,
): WorkflowOutcome<WorkflowReclaimRequest> {
  return loadDocument(
    file,
    WORKFLOW_RECLAIM_REQUEST_SCHEMA,
    parseWorkflowReclaimRequest,
  );
}
