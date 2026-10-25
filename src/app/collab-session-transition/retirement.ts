import path from 'node:path';
import { validateSuccession } from '../collab-route.js';
import { digestText } from '../collab-session-transition-validation.js';
import type { OpenedTaskStore } from '../collab-task-store.js';
import { readTaskLocalFile, writeTaskLocalExclusive } from './context.js';
import { recordEffectIntent, recordEffectOutcome } from './effects.js';
import {
  MAX_ARCHIVE_BYTES,
  currentStateDrift,
  journalEntry,
} from './journal.js';
import { failureReport } from './report.js';
import type { EnsuredRouteBinding } from './routing.js';
import {
  SESSION_TRANSITION_ARCHIVE_SCHEMA,
  type SessionTransitionDependencies,
  type SessionTransitionReport,
  type SessionTransitionRetirementMarker,
  type TransitionContext,
} from './types.js';

export { ensureTaskRetirementMarker, type EnsuredRetirementMarker };
interface EnsuredRetirementMarker {
  readonly ok: true;
  readonly task: OpenedTaskStore;
  readonly ref: string;
  readonly digest: string;
}

type RetirementEnsureResult =
  | EnsuredRetirementMarker
  | { readonly ok: false; readonly report: SessionTransitionReport };

async function ensureTaskRetirementMarker(
  context: TransitionContext,
  initialTask: OpenedTaskStore,
  routeBinding: EnsuredRouteBinding,
  dependencies: SessionTransitionDependencies,
  now: () => number,
): Promise<RetirementEnsureResult> {
  const request = context.request;
  const drift = currentStateDrift(initialTask.record, request, 'retired');
  if (drift !== null)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'needs_input',
        drift.code,
        drift.message,
        'Reconcile successor authority and claim epochs before task retirement.',
        initialTask,
      ),
    };
  const succession = (initialTask.record.successions ?? []).find(
    (item) =>
      item.intent_id === request.intent.intent_id &&
      item.handoff_id === request.intent.handoff_id &&
      item.generation === request.intent.generation,
  );
  if (succession === undefined)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'needs_input',
        'first_work_not_recorded',
        'No exact core succession proves successor first work.',
        'Register and apply the admitted successor REPORT before task retirement.',
        initialTask,
      ),
    };
  const validation = validateSuccession(initialTask.record, succession);
  if (!validation.ok)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'needs_input',
        validation.code,
        validation.detail,
        'Reconcile the first-work REPORT and recorded transfer boundary before task retirement.',
        initialTask,
      ),
    };
  const routeReceipt = journalEntry(
    initialTask.record,
    request,
    context.requestDigest,
  );
  if (
    routeReceipt?.effects['successor-route-binding']?.state !== 'completed' ||
    routeReceipt?.route_binding_ref !== routeBinding.ref ||
    routeReceipt?.route_binding_digest !== routeBinding.digest
  )
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'reconcile_required',
        'successor_route_binding_receipt_missing',
        'Task retirement requires the exact durable successor route-binding receipt.',
        'Reconcile the route binding before creating a retirement marker.',
        initialTask,
      ),
    };
  const routeFile = readTaskLocalFile(
    routeBinding.ref,
    initialTask.taskRoot,
    64 * 1024,
  );
  if (!routeFile.ok || routeFile.digest !== routeBinding.digest)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'reconcile_required',
        'successor_route_binding_missing',
        'The recorded successor route binding is missing or has changed.',
        'Reconcile the task-local binding before retirement; no archive marker was written.',
        initialTask,
      ),
    };
  const file = path.join(
    initialTask.taskRoot,
    'archive',
    'session-transitions',
    `${request.transition_id}.json`,
  );
  let task = initialTask;
  let journal = journalEntry(task.record, request, context.requestDigest);
  if (journal === null)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'unknown',
        'transition_journal_missing',
        'The retirement marker has no matching durable transition journal.',
        'Inspect the task record before writing an archive marker.',
        task,
      ),
    };
  let receipt = journal.effects['task-retirement-marker'];
  let effectJustCreated = false;
  if (receipt?.state === 'failed')
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'needs_input',
        'task_retirement_marker_failed',
        'A prior retirement marker write has a known failed receipt and will not be replayed.',
        'Inspect the exact task-local marker and journal before continuing.',
        task,
      ),
    };
  if (receipt === undefined) {
    const intent = await recordEffectIntent(
      context,
      task,
      'task-retirement-marker',
      now,
      dependencies.signal,
    );
    if (!intent.ok)
      return {
        ok: false,
        report: failureReport(
          'apply',
          request,
          intent.kind === 'invalid' ? 'needs_input' : 'reconcile_required',
          intent.code,
          intent.message,
          intent.nextAction,
          task,
        ),
      };
    task = intent.task;
    effectJustCreated = true;
    journal = journalEntry(task.record, request, context.requestDigest);
    receipt = journal?.effects['task-retirement-marker'];
  }
  if (receipt === undefined)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'unknown',
        'task_retirement_intent_unconfirmed',
        'The retirement intent was not durably recorded.',
        'Inspect the transition journal; do not write an unjournaled marker.',
        task,
      ),
    };
  const marker: SessionTransitionRetirementMarker = {
    schema: SESSION_TRANSITION_ARCHIVE_SCHEMA,
    mode: 'task-retirement',
    task_id: task.record.task_id,
    task_root: task.taskRoot,
    transition_id: request.transition_id,
    intent_id: request.intent.intent_id,
    handoff_id: request.intent.handoff_id,
    generation: request.intent.generation,
    recorded_at: receipt.intent_at,
    first_work: {
      message_id: validation.proof.message_id,
      digest: validation.proof.content_digest,
    },
    successor_route_binding: {
      ref: routeBinding.ref,
      digest: routeBinding.digest,
    },
    native_archive: 'unavailable',
    original_transcript: 'retained-in-place',
    reversible: true,
  } as const;
  const bytes = Buffer.from(`${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  const expectedDigest = digestText(bytes);
  if (receipt.state === 'completed') {
    const read = readTaskLocalFile(file, task.taskRoot, MAX_ARCHIVE_BYTES);
    if (
      receipt.ref !== file ||
      receipt.digest !== expectedDigest ||
      journal?.archive_ref !== file ||
      journal.archive_digest !== expectedDigest ||
      !read.ok ||
      read.digest !== expectedDigest ||
      !read.bytes.equals(bytes)
    )
      return {
        ok: false,
        report: failureReport(
          'apply',
          request,
          'reconcile_required',
          'task_retirement_receipt_mismatch',
          'The completed reversible retirement marker no longer matches its durable receipt.',
          'Reconcile the marker and task journal; do not overwrite or re-create it.',
          task,
        ),
      };
    return { ok: true, task, ref: file, digest: expectedDigest };
  }
  if (
    (receipt.state === 'pending' || receipt.state === 'unknown') &&
    !effectJustCreated
  ) {
    const read = readTaskLocalFile(file, task.taskRoot, MAX_ARCHIVE_BYTES);
    if (!read.ok || read.digest !== expectedDigest || !read.bytes.equals(bytes))
      return {
        ok: false,
        report: failureReport(
          'apply',
          request,
          'reconcile_required',
          'task_retirement_outcome_unknown',
          'A prior retirement marker effect is pending/unknown and its exact artifact is not available for reconciliation.',
          'Inspect the task-local path and journal; never replay an ambiguous archive write.',
          task,
        ),
      };
    const reconciled = await recordEffectOutcome(
      context,
      task,
      'task-retirement-marker',
      'completed',
      now(),
      null,
      {
        digest: expectedDigest,
        ref: file,
        artifact: 'task-retirement',
      },
    );
    if (!reconciled.ok)
      return {
        ok: false,
        report: failureReport(
          'apply',
          request,
          'unknown',
          reconciled.code,
          'The exact retirement marker exists but its durable receipt could not be reconciled.',
          'Inspect the file and task journal before continuing.',
          task,
        ),
      };
    return {
      ok: true,
      task: reconciled.task,
      ref: file,
      digest: expectedDigest,
    };
  }
  const written = writeTaskLocalExclusive(
    file,
    task.taskRoot,
    bytes,
    MAX_ARCHIVE_BYTES,
  );
  if (!written.ok) {
    const unknown = await recordEffectOutcome(
      context,
      task,
      'task-retirement-marker',
      'unknown',
      now(),
      written.code,
    );
    const resultTask = unknown.ok ? unknown.task : task;
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'reconcile_required',
        'task_retirement_outcome_unknown',
        `The retirement marker write did not return a confirmed result (${written.code}).`,
        'Inspect the exact task-local artifact and journal; do not replay the write blindly.',
        resultTask,
      ),
    };
  }
  const recorded = await recordEffectOutcome(
    context,
    task,
    'task-retirement-marker',
    'completed',
    now(),
    null,
    {
      digest: written.digest,
      ref: file,
      artifact: 'task-retirement',
    },
  );
  if (!recorded.ok)
    return {
      ok: false,
      report: failureReport(
        'apply',
        request,
        'unknown',
        recorded.code,
        'The reversible retirement marker is written but its outcome receipt could not be persisted.',
        'Inspect the marker and task journal; do not overwrite or repeat the transfer.',
        task,
      ),
    };
  return { ok: true, task: recorded.task, ref: file, digest: written.digest };
}
