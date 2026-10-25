import path from 'node:path';
import { transact } from '../../collab/store.js';
import { isTaskRecord } from '../../collab/validation.js';
import {
  assertTaskStoreCurrent,
  openTaskStore,
  type OpenedTaskStore,
} from '../collab-task-store.js';
import { safePathEqual } from '../collab-session-transition-validation.js';
import { currentStateDrift, hasJournalConflict } from './journal.js';
import { journalEntry, setJournalEffect } from './journal.js';
import { nowIso } from './context.js';
import type { TransitionContext } from './types.js';
export { recordEffectIntent, recordEffectOutcome };
export type { EffectJournalFailure, EffectJournalSuccess };

export type SessionTransitionEffectName =
  'source-freeze' | 'successor-route-binding' | 'task-retirement-marker';

type EffectJournalFailure = {
  readonly ok: false;
  readonly kind: 'invalid' | 'needs_input';
  readonly code: string;
  readonly message: string;
  readonly nextAction: string | null;
};

type EffectJournalSuccess = {
  readonly ok: true;
  readonly task: OpenedTaskStore;
  readonly replayed: boolean;
};

function effectPhase(
  name: SessionTransitionEffectName,
): 'source' | 'successor' | 'retired' {
  if (name === 'source-freeze') return 'source';
  if (name === 'successor-route-binding') return 'successor';
  return 'retired';
}

async function recordEffectIntent(
  context: TransitionContext,
  currentTask: OpenedTaskStore,
  name: SessionTransitionEffectName,
  now: () => number,
  signal?: AbortSignal,
): Promise<EffectJournalSuccess | EffectJournalFailure> {
  if (signal?.aborted)
    return {
      ok: false,
      kind: 'needs_input',
      code: 'abort_requested',
      message:
        'The transition was aborted before the effect intent was committed.',
      nextAction: 'Reconcile the current task before a new explicit apply.',
    };
  const current = await assertTaskStoreCurrent(currentTask);
  if (current !== null)
    return {
      ok: false,
      kind: 'needs_input',
      code: current.code,
      message: current.message,
      nextAction: current.nextAction,
    };
  if (
    hasJournalConflict(
      currentTask.record,
      context.request,
      context.requestDigest,
    )
  )
    return {
      ok: false,
      kind: 'invalid',
      code: 'transition_journal_conflict',
      message:
        'The durable journal is invalid or pins different immutable request inputs.',
      nextAction: 'Inspect the task record; do not perform the effect.',
    };
  const journal = journalEntry(
    currentTask.record,
    context.request,
    context.requestDigest,
  );
  if (journal === null)
    return {
      ok: false,
      kind: 'needs_input',
      code: 'transition_journal_missing',
      message: 'The transition effect has no matching durable intent journal.',
      nextAction: 'Inspect the task record before any effect.',
    };
  const prior = journal.effects[name];
  if (prior !== undefined) {
    if (prior.state === 'completed')
      return { ok: true, task: currentTask, replayed: true };
    return {
      ok: false,
      kind: 'needs_input',
      code:
        prior.state === 'failed'
          ? `${name.replaceAll('-', '_')}_failed`
          : `${name.replaceAll('-', '_')}_reconcile_required`,
      message: `The ${name} effect already has a ${prior.state} journal receipt; it will not be replayed.`,
      nextAction:
        'Reconcile the exact host/file effect and journal before continuing.',
    };
  }
  const outcome = transact(currentTask.taskRoot, {
    actor: context.request.intent.from.agent_id,
    purpose: `session-transition:${name}:intent`,
    expectRevision: currentTask.record.state_revision,
    clock: now(),
    apply: (record) => {
      if (signal?.aborted)
        return { ok: false as const, reason: 'abort_requested' };
      const drift = currentStateDrift(
        record,
        context.request,
        effectPhase(name),
      );
      if (drift !== null) return { ok: false as const, reason: drift.code };
      if (hasJournalConflict(record, context.request, context.requestDigest))
        return { ok: false as const, reason: 'transition_journal_conflict' };
      const entry = journalEntry(
        record,
        context.request,
        context.requestDigest,
      );
      if (entry === null)
        return { ok: false as const, reason: 'transition_journal_missing' };
      if (entry.effects[name] !== undefined)
        return { ok: false as const, reason: 'effect_intent_raced' };
      const saved = setJournalEffect(record, context.request.transition_id, {
        name,
        state: 'pending',
        at: nowIso(now),
      });
      if (!saved.ok) return { ok: false as const, reason: saved.code };
      return {
        record,
        op: 'session-transition-effect-intent',
        summary: { transition_id: context.request.transition_id, effect: name },
        result: { effect: name, state: 'pending' },
      };
    },
  });
  if (!outcome.ok)
    return {
      ok: false,
      kind: 'needs_input',
      code: outcome.reason,
      message: 'The durable effect intent was not committed.',
      nextAction:
        'Re-read current task authority and journal before any retry.',
    };
  const savedTask = await openTaskStore(currentTask.taskRoot);
  if (!savedTask.ok)
    return {
      ok: false,
      kind: 'needs_input',
      code: savedTask.code,
      message: savedTask.message,
      nextAction: savedTask.nextAction,
    };
  const savedJournal = journalEntry(
    savedTask.value.record,
    context.request,
    context.requestDigest,
  );
  if (savedJournal?.effects[name]?.state !== 'pending')
    return {
      ok: false,
      kind: 'needs_input',
      code: 'effect_intent_unconfirmed',
      message:
        'The effect-intent transaction returned without a matching durable pending receipt.',
      nextAction: 'Inspect the task journal; do not invoke the effect.',
    };
  return { ok: true, task: savedTask.value, replayed: false };
}

async function recordEffectOutcome(
  context: TransitionContext,
  currentTask: OpenedTaskStore,
  name: SessionTransitionEffectName,
  state: 'completed' | 'failed' | 'unknown',
  clock: number,
  code: string | null,
  options: {
    readonly digest?: string;
    readonly ref?: string;
    readonly artifact?: 'route-binding' | 'task-retirement';
  } = {},
): Promise<
  | { readonly ok: true; readonly task: OpenedTaskStore }
  | { readonly ok: false; readonly code: string }
> {
  const current = await assertTaskStoreCurrent(currentTask);
  if (current !== null) return { ok: false, code: current.code };
  const outcome = transact(currentTask.taskRoot, {
    actor: context.request.intent.from.agent_id,
    purpose: `session-transition:${name}:outcome`,
    expectRevision: currentTask.record.state_revision,
    clock,
    apply: (record) => {
      if (
        !isTaskRecord(record) ||
        record.task_id !== path.basename(context.request.task_root) ||
        !safePathEqual(record.task_root, context.request.task_root)
      )
        return { ok: false as const, reason: 'task_namespace_changed' };
      if (hasJournalConflict(record, context.request, context.requestDigest))
        return { ok: false as const, reason: 'transition_journal_conflict' };
      const journal = journalEntry(
        record,
        context.request,
        context.requestDigest,
      );
      if (journal === null)
        return { ok: false as const, reason: 'transition_journal_missing' };
      const prior = journal.effects[name];
      if (prior === undefined)
        return { ok: false as const, reason: 'effect_intent_missing' };
      if (prior.state === state) {
        const same =
          (options.digest === undefined || prior.digest === options.digest) &&
          (options.ref === undefined || prior.ref === options.ref) &&
          (code === null || prior.code === code);
        if (!same)
          return { ok: false as const, reason: 'effect_outcome_conflict' };
        return {
          record,
          op: 'session-transition-effect-outcome-replay',
          summary: {
            transition_id: context.request.transition_id,
            effect: name,
            state,
          },
          result: { effect: name, state, replayed: true },
        };
      }
      if (prior.state !== 'pending' && prior.state !== 'unknown')
        return { ok: false as const, reason: 'effect_outcome_conflict' };
      const saved = setJournalEffect(record, context.request.transition_id, {
        name,
        state,
        at: new Date(clock).toISOString(),
        ...(code === null ? {} : { code }),
        ...(options.digest === undefined ? {} : { digest: options.digest }),
        ...(options.ref === undefined ? {} : { ref: options.ref }),
        ...(options.artifact === undefined
          ? {}
          : { artifact: options.artifact }),
      });
      if (!saved.ok) return { ok: false as const, reason: saved.code };
      return {
        record,
        op: 'session-transition-effect-outcome',
        summary: {
          transition_id: context.request.transition_id,
          effect: name,
          state,
        },
        result: { effect: name, state, replayed: false },
      };
    },
  });
  if (!outcome.ok) return { ok: false, code: outcome.reason };
  const savedTask = await openTaskStore(currentTask.taskRoot);
  if (!savedTask.ok) return { ok: false, code: savedTask.code };
  const savedJournal = journalEntry(
    savedTask.value.record,
    context.request,
    context.requestDigest,
  );
  const savedEffect = savedJournal?.effects[name];
  if (
    savedEffect?.state !== state ||
    (options.digest !== undefined && savedEffect.digest !== options.digest) ||
    (options.ref !== undefined && savedEffect.ref !== options.ref)
  )
    return { ok: false, code: 'effect_outcome_unconfirmed' };
  return { ok: true, task: savedTask.value };
}
