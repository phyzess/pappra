import path from 'node:path';
import { object as isRecord } from '../infra/validation.js';
import { canonicalJson } from '../collab/envelope.js';
import type { Identity } from '../collab/types.js';
import {
  MANAGED_PI_EXECUTION_SCOPE_SCHEMA,
  type ManagedPiExecutionScope,
} from '../schemas/managed-pi-execution.js';
import { readBoundedFile } from './bounded-file.js';
import type {
  RolloverBundleRequest,
  RolloverIntentRequest,
} from './collab-rollover.js';
import {
  digestText,
  isDigest,
  isNonNegativeInt,
  isPositiveInt,
  isSafeId,
  isText,
  safePathEqual,
  sameIdentity,
} from './collab-session-transition-validation.js';

export const COLLAB_SESSION_TRANSITION_REQUEST_SCHEMA =
  'pappra/collaboration-session-transition-request/1';

const MAX_REQUEST_BYTES = 64 * 1024;

export interface SessionTransitionRequest {
  readonly schema: typeof COLLAB_SESSION_TRANSITION_REQUEST_SCHEMA;
  readonly managed_execution_scope?: ManagedPiExecutionScope;
  readonly task_root: string;
  readonly transition_id: string;
  readonly intent: RolloverIntentRequest;
  readonly bundle: RolloverBundleRequest;
  readonly bootstrap_request: {
    readonly ref: string;
    readonly digest: string;
  };
  readonly evidence: {
    readonly ack_message_id: string | null;
    readonly first_work_report_id: string | null;
  };
  readonly archive_mode: 'task-retirement';
}

export interface LoadedSessionTransitionRequest {
  readonly request: SessionTransitionRequest;
  readonly file: string;
  readonly file_digest: string;
  readonly immutable_digest: string;
}

export type SessionTransitionRequestResult =
  | { readonly ok: true; readonly value: LoadedSessionTransitionRequest }
  | {
      readonly ok: false;
      readonly kind: 'invalid';
      readonly code: string;
      readonly message: string;
      readonly next_action: string | null;
    };

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

/**
 * The immutable digest deliberately excludes `evidence`: adding an ACK or a
 * first-work REPORT pointer must not change a request's identity.
 */
export function immutableDigest(request: SessionTransitionRequest): string {
  return digestText(
    canonicalJson({
      schema: request.schema,
      task_root: request.task_root,
      transition_id: request.transition_id,
      intent: request.intent,
      bundle: request.bundle,
      bootstrap_request: request.bootstrap_request,
      archive_mode: request.archive_mode,
      ...(request.managed_execution_scope === undefined
        ? {}
        : { managed_execution_scope: request.managed_execution_scope }),
    }),
  );
}

function parseIdentity(value: unknown): Identity | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['agent_id', 'session_id', 'harness', 'cwd'])
  )
    return null;
  if (!isText(value['agent_id'], 128) || !isText(value['session_id'], 256))
    return null;
  if (value['harness'] !== 'pi') return null;
  if (!isText(value['cwd'], 4096) || !path.isAbsolute(value['cwd']))
    return null;
  return {
    agent_id: value['agent_id'],
    session_id: value['session_id'],
    harness: 'pi',
    cwd: value['cwd'],
  };
}

function parseIntent(value: unknown): RolloverIntentRequest | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'intent_id',
      'generation',
      'handoff_id',
      'subtask_id',
      'attempt',
      'input_revision',
      'from',
      'to',
      'claims',
      'coordinator_epoch',
    ])
  )
    return null;
  const from = parseIdentity(value['from']);
  const to = parseIdentity(value['to']);
  const claims = value['claims'];
  if (
    !isSafeId(value['intent_id']) ||
    !isPositiveInt(value['generation']) ||
    !isSafeId(value['handoff_id']) ||
    !isSafeId(value['subtask_id']) ||
    !isPositiveInt(value['attempt']) ||
    !isDigest(value['input_revision']) ||
    from === null ||
    to === null ||
    !isPositiveInt(value['coordinator_epoch']) ||
    !Array.isArray(claims) ||
    claims.length === 0 ||
    claims.length > 64 ||
    sameIdentity(from, to)
  )
    return null;
  const parsedClaims: { claim_id: string; resource_epoch: number }[] = [];
  const seen = new Set<string>();
  for (const claim of claims) {
    if (
      !isRecord(claim) ||
      !hasOnlyKeys(claim, ['claim_id', 'resource_epoch']) ||
      !isSafeId(claim['claim_id']) ||
      !isNonNegativeInt(claim['resource_epoch']) ||
      seen.has(claim['claim_id'])
    )
      return null;
    seen.add(claim['claim_id']);
    parsedClaims.push({
      claim_id: claim['claim_id'],
      resource_epoch: claim['resource_epoch'],
    });
  }
  return {
    intent_id: value['intent_id'],
    generation: value['generation'],
    handoff_id: value['handoff_id'],
    subtask_id: value['subtask_id'],
    attempt: value['attempt'],
    input_revision: value['input_revision'],
    from,
    to,
    claims: parsedClaims,
    coordinator_epoch: value['coordinator_epoch'],
  };
}

function parseManagedPiExecutionScope(
  value: unknown,
): ManagedPiExecutionScope | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'schema',
      'task_id',
      'task_root',
      'session_id',
      'cwd',
      'subtask_id',
      'attempt',
      'owner_epoch',
      'claim_epochs',
    ]) ||
    value['schema'] !== MANAGED_PI_EXECUTION_SCOPE_SCHEMA ||
    !isSafeId(value['task_id']) ||
    !isText(value['task_root'], 4096) ||
    !path.isAbsolute(value['task_root']) ||
    !isText(value['session_id'], 256) ||
    !isText(value['cwd'], 4096) ||
    !path.isAbsolute(value['cwd']) ||
    !isSafeId(value['subtask_id']) ||
    !isPositiveInt(value['attempt']) ||
    !isPositiveInt(value['owner_epoch']) ||
    !Array.isArray(value['claim_epochs']) ||
    value['claim_epochs'].length === 0 ||
    value['claim_epochs'].length > 64
  )
    return null;
  const claim_epochs: { claim_id: string; resource_epoch: number }[] = [];
  const seen = new Set<string>();
  for (const raw of value['claim_epochs']) {
    if (
      !isRecord(raw) ||
      !hasOnlyKeys(raw, ['claim_id', 'resource_epoch']) ||
      !isSafeId(raw['claim_id']) ||
      !isPositiveInt(raw['resource_epoch']) ||
      seen.has(raw['claim_id'])
    )
      return null;
    seen.add(raw['claim_id']);
    claim_epochs.push({
      claim_id: raw['claim_id'],
      resource_epoch: raw['resource_epoch'],
    });
  }
  return {
    schema: MANAGED_PI_EXECUTION_SCOPE_SCHEMA,
    task_id: value['task_id'],
    task_root: value['task_root'],
    session_id: value['session_id'],
    cwd: value['cwd'],
    subtask_id: value['subtask_id'],
    attempt: value['attempt'],
    owner_epoch: value['owner_epoch'],
    claim_epochs,
  };
}
export function validateSessionTransitionRequest(
  value: unknown,
):
  | { readonly ok: true; readonly request: SessionTransitionRequest }
  | { readonly ok: false; readonly code: string; readonly message: string } {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'schema',
      'task_root',
      'transition_id',
      'intent',
      'bundle',
      'bootstrap_request',
      'evidence',
      'archive_mode',
      'managed_execution_scope',
    ])
  )
    return {
      ok: false,
      code: 'request_shape_invalid',
      message: 'Session-transition request must use only documented fields.',
    };
  if (value['schema'] !== COLLAB_SESSION_TRANSITION_REQUEST_SCHEMA)
    return {
      ok: false,
      code: 'request_schema_invalid',
      message: `request.schema must be ${COLLAB_SESSION_TRANSITION_REQUEST_SCHEMA}.`,
    };
  if (!isText(value['task_root'], 4096) || !path.isAbsolute(value['task_root']))
    return {
      ok: false,
      code: 'task_root_invalid',
      message: 'task_root must be an absolute task-root path.',
    };
  const intent = parseIntent(value['intent']);
  if (intent === null)
    return {
      ok: false,
      code: 'intent_invalid',
      message:
        'intent must pin exact source/successor identities, attempt, input, epoch and claims.',
    };
  if (value['transition_id'] !== intent.intent_id)
    return {
      ok: false,
      code: 'transition_id_mismatch',
      message: 'transition_id must equal intent.intent_id.',
    };
  const bundleValue = value['bundle'];
  if (
    !isRecord(bundleValue) ||
    !hasOnlyKeys(bundleValue, [
      'root',
      'continuity_task_id',
      'bundle_id',
      'digest',
    ]) ||
    !isText(bundleValue['root'], 4096) ||
    !path.isAbsolute(bundleValue['root']) ||
    !isSafeId(bundleValue['continuity_task_id']) ||
    !isSafeId(bundleValue['bundle_id']) ||
    !isDigest(bundleValue['digest'])
  )
    return {
      ok: false,
      code: 'bundle_invalid',
      message:
        'bundle must name one absolute workspace root and exact linked bundle digest.',
    };
  const bootstrapValue = value['bootstrap_request'];
  if (
    !isRecord(bootstrapValue) ||
    !hasOnlyKeys(bootstrapValue, ['ref', 'digest']) ||
    !isText(bootstrapValue['ref'], 4096) ||
    !path.isAbsolute(bootstrapValue['ref']) ||
    !isDigest(bootstrapValue['digest'])
  )
    return {
      ok: false,
      code: 'bootstrap_request_invalid',
      message:
        'bootstrap_request must pin one absolute bounded request file and raw digest.',
    };
  const evidenceValue = value['evidence'];
  if (
    !isRecord(evidenceValue) ||
    !hasOnlyKeys(evidenceValue, ['ack_message_id', 'first_work_report_id'])
  )
    return {
      ok: false,
      code: 'evidence_invalid',
      message:
        'evidence must contain only the optional registered ACK and REPORT ids.',
    };
  const ack = evidenceValue['ack_message_id'];
  const report = evidenceValue['first_work_report_id'];
  if (
    (ack !== null && !isSafeId(ack)) ||
    (report !== null && !isSafeId(report))
  )
    return {
      ok: false,
      code: 'evidence_id_invalid',
      message: 'Evidence ids must be null or safe registered message ids.',
    };
  if (value['archive_mode'] !== 'task-retirement')
    return {
      ok: false,
      code: 'archive_mode_invalid',
      message:
        'Only the reversible task-retirement marker is supported; native archive is unavailable.',
    };
  const scopeValue = value['managed_execution_scope'];
  const managedExecutionScope =
    scopeValue === undefined ? null : parseManagedPiExecutionScope(scopeValue);
  if (
    scopeValue !== undefined &&
    (managedExecutionScope === null ||
      managedExecutionScope.task_id !== path.basename(value['task_root']) ||
      !safePathEqual(managedExecutionScope.task_root, value['task_root']) ||
      managedExecutionScope.session_id !== intent.from.session_id ||
      !safePathEqual(managedExecutionScope.cwd, intent.from.cwd ?? '') ||
      managedExecutionScope.subtask_id !== intent.subtask_id ||
      managedExecutionScope.attempt !== intent.attempt ||
      managedExecutionScope.owner_epoch !== intent.coordinator_epoch ||
      managedExecutionScope.claim_epochs.length !== intent.claims.length ||
      managedExecutionScope.claim_epochs.some(
        (pin, index) =>
          pin.claim_id !== intent.claims[index]?.claim_id ||
          pin.resource_epoch !== intent.claims[index]?.resource_epoch,
      ))
  )
    return {
      ok: false,
      code: 'managed_execution_scope_mismatch',
      message:
        'Managed execution scope must exactly match task, source session, attempt, owner epoch and claim pins.',
    };
  return {
    ok: true,
    request: {
      schema: COLLAB_SESSION_TRANSITION_REQUEST_SCHEMA,
      task_root: value['task_root'],
      transition_id: value['transition_id'],
      intent,
      bundle: {
        root: bundleValue['root'],
        continuity_task_id: bundleValue['continuity_task_id'],
        bundle_id: bundleValue['bundle_id'],
        digest: bundleValue['digest'],
      },
      bootstrap_request: {
        ref: bootstrapValue['ref'],
        digest: bootstrapValue['digest'],
      },
      evidence: {
        ack_message_id: typeof ack === 'string' ? ack : null,
        first_work_report_id: typeof report === 'string' ? report : null,
      },
      archive_mode: 'task-retirement',
      ...(managedExecutionScope === null
        ? {}
        : { managed_execution_scope: managedExecutionScope }),
    },
  };
}

export function loadSessionTransitionRequest(
  file: string,
): SessionTransitionRequestResult {
  const read = readBoundedFile(file, MAX_REQUEST_BYTES);
  if (!read.ok)
    return {
      ok: false,
      kind: 'invalid',
      code: 'request_unreadable',
      message: `Request must be an absolute bounded regular file (${read.code}).`,
      next_action:
        'Pass a regular JSON request file; no task mutation was attempted.',
    };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text) as unknown;
  } catch {
    return {
      ok: false,
      kind: 'invalid',
      code: 'request_invalid_json',
      message: 'Session-transition request is not valid JSON.',
      next_action: 'Fix the request document and retry explicitly.',
    };
  }
  const validated = validateSessionTransitionRequest(parsed);
  if (!validated.ok)
    return { ...validated, kind: 'invalid', next_action: null };
  return {
    ok: true,
    value: {
      request: validated.request,
      file,
      file_digest: read.digest,
      immutable_digest: immutableDigest(validated.request),
    },
  };
}
