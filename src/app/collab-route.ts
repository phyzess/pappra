import type {
  AppliedMessage,
  Identity,
  ResultEntry,
  RolloverIntent,
  TaskRecord,
} from '../collab/types.js';
import { isTaskRecord } from '../collab/validation.js';
import { findHandoff } from '../collab/handoff.js';

/**
 * Pure current-record notify route exclusion.
 *
 * A completed, valid succession retains the old native agent/session identity as history.
 * That identity is no longer an active notify sender or recipient. This module only answers
 * the notify question: it never rewrites messages, deliveries or bindings, and it does not
 * claim that dispatch routing or the native session archive changed.
 *
 * A completed handoff alone proves nothing. A succession is usable only when its matching
 * intent, recorded transfer boundary, registered applied first-work REPORT and admitted
 * result entry all agree; anything missing or contradictory is `unknown`, never a silent
 * reroute and never an accepted exclusion.
 */

export const ROUTE_EXCLUSION_SCHEMA = 'pappra/collaboration-route-exclusion/1';

export interface RouteExclusion {
  readonly schema: typeof ROUTE_EXCLUSION_SCHEMA;
  readonly agent_id: string;
  readonly session_id: string;
  readonly intent_id: string;
  readonly handoff_id: string;
  readonly generation: number;
  readonly archived_at: string;
  readonly proof_message_id: string;
  readonly proof_digest: string;
  /** Routing removal is not implemented: the value stays pending. */
  readonly routing: 'pending';
  /** The Pi native session archive is unavailable. */
  readonly native_archive: 'unavailable';
}

export interface RouteExclusionLookup {
  readonly state: 'active' | 'excluded' | 'unknown';
  readonly exclusion: RouteExclusion | null;
  readonly conflict: string | null;
}

export interface SuccessionFailure {
  readonly ok: false;
  readonly code: string;
  readonly detail: string;
}

export type SuccessionValidation =
  | {
      readonly ok: true;
      readonly intent: RolloverIntent;
      readonly proof: AppliedMessage;
      readonly result: ResultEntry;
      readonly exclusion: RouteExclusion;
    }
  | SuccessionFailure;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value: unknown, max = 2048): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !value.includes('\u0000');

const sameIdentity = (
  left: { agent_id?: string | null; session_id?: string | null } | null,
  right: { agent_id: string; session_id: string },
): boolean =>
  left !== null &&
  left.agent_id === right.agent_id &&
  left.session_id === right.session_id;

const rejected = (code: string, detail: string): SuccessionFailure => ({
  ok: false,
  code,
  detail,
});

const nativeMatchesIdentity = (
  native: { agent_id?: string | null; session_id?: string | null } | null,
  identity: { agent_id: string; session_id: string },
): boolean => sameIdentity(native, identity);

/**
 * Validates one recorded succession end to end against the record it belongs to. The check
 * is purely historical: it reads the immutable intent, the registered message ledger, the
 * admitted result entry and the recorded transfer boundary. Live claims and later attempt
 * states are not required, so an intact historical chain stays valid after further work.
 */
export function validateSuccession(
  record: TaskRecord,
  entry: unknown,
): SuccessionValidation {
  if (!isTaskRecord(record))
    return rejected('record_invalid', 'task record failed validation');
  if (!isRecord(entry))
    return rejected('succession_malformed', 'succession is not an object');
  const handoffId = entry['handoff_id'];
  const intentId = entry['intent_id'];
  const generation = entry['generation'];
  const archivedAt = entry['archived_at'];
  const oldNative = entry['old_native'];
  const successorNative = entry['successor_native'];
  const proof = entry['proof'];
  if (
    !isText(handoffId, 256) ||
    !isText(intentId, 256) ||
    !isText(archivedAt, 64) ||
    !Number.isSafeInteger(generation) ||
    (generation as number) < 1 ||
    !isRecord(oldNative) ||
    !isRecord(successorNative) ||
    !isRecord(proof)
  )
    return rejected(
      'succession_malformed',
      'succession is missing intent, handoff, generation, native identities or proof',
    );
  const oldAgent = oldNative['agent_id'];
  const oldSession = oldNative['session_id'];
  const successorAgent = successorNative['agent_id'];
  const successorSession = successorNative['session_id'];
  const proofMessageId = proof['message_id'];
  const proofDigest = proof['digest'];
  if (
    !isText(oldAgent, 256) ||
    !isText(oldSession, 256) ||
    !isText(successorAgent, 256) ||
    !isText(successorSession, 256) ||
    !isText(proofMessageId, 256) ||
    !isText(proofDigest, 128)
  )
    return rejected(
      'succession_native_missing',
      'succession has an incomplete native identity or proof pointer',
    );
  if (
    entry['history_retained'] !== true ||
    entry['routing'] !== 'pending' ||
    entry['native_archive'] !== 'unavailable'
  )
    return rejected(
      'succession_history_invalid',
      'succession does not record retained history, pending routing and an unavailable native archive',
    );
  if (successorAgent === oldAgent && successorSession === oldSession)
    return rejected(
      'succession_native_inherited',
      'succession successor reuses the archived source native identity',
    );

  const handoff = findHandoff(record, handoffId);
  if (handoff === null)
    return rejected(
      'succession_handoff_unknown',
      `succession references unknown handoff ${handoffId}`,
    );
  if (handoff.state !== 'completed')
    return rejected(
      'succession_handoff_not_completed',
      `handoff ${handoffId} is in state ${handoff.state}`,
    );
  if (
    !sameIdentity(handoff.from, { agent_id: oldAgent, session_id: oldSession })
  )
    return rejected(
      'succession_handoff_identity_mismatch',
      `handoff ${handoffId} source does not match the archived old native identity`,
    );
  if (
    !sameIdentity(handoff.to, {
      agent_id: successorAgent,
      session_id: successorSession,
    })
  )
    return rejected(
      'succession_handoff_identity_mismatch',
      `handoff ${handoffId} receiver does not match the successor native identity`,
    );

  const intent = (record.rollover ?? []).find(
    (item) => item.intent_id === intentId,
  );
  if (intent === undefined)
    return rejected(
      'succession_intent_missing',
      `succession references no recorded intent ${intentId}`,
    );
  if (
    intent.task_id !== record.task_id ||
    intent.handoff_id !== handoffId ||
    intent.generation !== generation
  )
    return rejected(
      'succession_intent_mismatch',
      `intent ${intentId} does not belong to this task, handoff or generation`,
    );
  if (
    !nativeMatchesIdentity(intent.from, {
      agent_id: oldAgent,
      session_id: oldSession,
    })
  )
    return rejected(
      'succession_intent_source_mismatch',
      `intent ${intentId} source is not the archived old native identity`,
    );
  if (
    !nativeMatchesIdentity(intent.to, {
      agent_id: successorAgent,
      session_id: successorSession,
    })
  )
    return rejected(
      'succession_intent_successor_mismatch',
      `intent ${intentId} receiver is not the successor native identity`,
    );
  if (
    !nativeMatchesIdentity(intent.source_native, {
      agent_id: oldAgent,
      session_id: oldSession,
    }) ||
    intent.source_native.runner !== (oldNative['runner'] ?? null) ||
    intent.source_native.run_id !== (oldNative['run_id'] ?? null)
  )
    return rejected(
      'succession_source_native_mismatch',
      `intent ${intentId} pinned source native identity does not match the archived history`,
    );
  const pinnedSuccessor = intent.successor_native ?? null;
  if (
    pinnedSuccessor === null ||
    !nativeMatchesIdentity(pinnedSuccessor, {
      agent_id: successorAgent,
      session_id: successorSession,
    }) ||
    pinnedSuccessor.runner !== (successorNative['runner'] ?? null) ||
    pinnedSuccessor.run_id !== (successorNative['run_id'] ?? null)
  )
    return rejected(
      'succession_successor_native_mismatch',
      `intent ${intentId} pinned successor native identity does not match the archived history`,
    );
  const boundary = intent.transfer_boundary ?? null;
  if (boundary === null)
    return rejected(
      'succession_boundary_missing',
      `intent ${intentId} has no recorded transfer boundary`,
    );

  const messages = record.messages ?? [];
  const index = messages.findIndex(
    (item) => item.message_id === proofMessageId,
  );
  if (index < 0)
    return rejected(
      'succession_proof_missing',
      `first-work REPORT ${proofMessageId} is not registered`,
    );
  const applied = messages[index]!;
  if (applied.state !== 'applied')
    return rejected(
      'succession_proof_not_applied',
      `first-work REPORT ${proofMessageId} is ${applied.state}, not applied`,
    );
  if (applied.content_digest !== proofDigest)
    return rejected(
      'succession_proof_digest_mismatch',
      `first-work REPORT ${proofMessageId} digest differs from the retained proof`,
    );
  if (applied.type !== 'REPORT')
    return rejected(
      'succession_proof_type_mismatch',
      `first-work proof ${proofMessageId} is ${applied.type}, not REPORT`,
    );
  if (index < boundary.message_count)
    return rejected(
      'succession_proof_pre_transfer',
      `first-work REPORT is registered before the recorded transfer boundary`,
    );
  if (
    !sameIdentity(applied.from, {
      agent_id: successorAgent,
      session_id: successorSession,
    })
  )
    return rejected(
      'succession_proof_sender_mismatch',
      'first-work REPORT was not sent by the successor native identity',
    );
  if (
    applied.subtask_id !== intent.subtask_id ||
    applied.attempt !== intent.attempt
  )
    return rejected(
      'succession_proof_correlation_mismatch',
      'first-work REPORT does not match the intent subtask and attempt',
    );

  const result = (record.results ?? []).find(
    (item) => item.message_id === proofMessageId,
  );
  if (result === undefined)
    return rejected(
      'succession_result_missing',
      `first-work REPORT ${proofMessageId} has no admitted result`,
    );
  if (result.classification !== 'applied')
    return rejected(
      'succession_result_not_admitted',
      `first-work result is ${result.classification}, not applied`,
    );
  if (result.status !== 'completed')
    return rejected(
      'succession_result_not_completed',
      `first-work result is ${result.status}, not completed`,
    );
  if (
    result.subtask_id !== intent.subtask_id ||
    result.attempt !== intent.attempt ||
    result.input_revision !== intent.input_revision
  )
    return rejected(
      'succession_result_mismatch',
      'first-work result does not match the intent subtask, attempt and input',
    );

  return {
    ok: true,
    intent,
    proof: applied,
    result,
    exclusion: {
      schema: ROUTE_EXCLUSION_SCHEMA,
      agent_id: oldAgent,
      session_id: oldSession,
      intent_id: intentId,
      handoff_id: handoffId,
      generation: generation as number,
      archived_at: archivedAt,
      proof_message_id: proofMessageId,
      proof_digest: proofDigest,
      routing: 'pending',
      native_archive: 'unavailable',
    },
  };
}

interface SuccessionMatch {
  readonly old: boolean;
  readonly successor: boolean;
}

function matchOf(entry: unknown, identity: Identity): SuccessionMatch | null {
  if (!isRecord(entry)) return null;
  const oldNative = entry['old_native'];
  const successorNative = entry['successor_native'];
  const old =
    isRecord(oldNative) &&
    oldNative['agent_id'] === identity.agent_id &&
    oldNative['session_id'] === identity.session_id;
  const successor =
    isRecord(successorNative) &&
    successorNative['agent_id'] === identity.agent_id &&
    successorNative['session_id'] === identity.session_id;
  if (!old && !successor) return null;
  return { old, successor };
}

export function routeExclusions(record: TaskRecord): readonly RouteExclusion[] {
  if (!isTaskRecord(record)) return [];
  const exclusions: RouteExclusion[] = [];
  for (const entry of record.successions ?? []) {
    const validated = validateSuccession(record, entry);
    if (validated.ok) exclusions.push(validated.exclusion);
  }
  return exclusions;
}

/**
 * Answers the notify question for one identity: is it an archived old native identity
 * (`excluded`), an active identity (`active`), or is a relevant succession contradictory
 * (`unknown`, which notify must refuse rather than guess)?
 *
 * A successor match is validated too: a succession that names this identity as its receiver
 * but cannot prove the transfer is `unknown`, never a silent pass.
 */
export function routeExclusionFor(
  record: TaskRecord,
  identity: Identity,
): RouteExclusionLookup {
  if (!isTaskRecord(record))
    return {
      state: 'unknown',
      exclusion: null,
      conflict: 'task record failed validation',
    };
  let conflict: string | null = null;
  for (const entry of record.successions ?? []) {
    const match = matchOf(entry, identity);
    if (match === null) continue;
    const validated = validateSuccession(record, entry);
    if (validated.ok) {
      // A successor identity is the current route; only an archived old identity excludes.
      if (match.old)
        return {
          state: 'excluded',
          exclusion: validated.exclusion,
          conflict: null,
        };
      continue;
    }
    conflict = `${validated.code}: ${validated.detail}`;
  }
  if (conflict !== null) return { state: 'unknown', exclusion: null, conflict };
  return { state: 'active', exclusion: null, conflict: null };
}
