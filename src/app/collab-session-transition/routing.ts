import path from 'node:path';
import { canonicalJson } from '../../collab/envelope.js';
import type { LaunchReservation, TaskRecord } from '../../collab/types.js';
import {
  collabBindingSchema,
  type CollabBinding,
  type CollabBindingParticipant,
} from '../../schemas/collaboration.js';
import {
  digestText,
  isText,
  safePathEqual,
} from '../collab-session-transition-validation.js';
import type { OpenedTaskStore } from '../collab-task-store.js';
import {
  bootstrapData,
  readTaskLocalFile,
  sameHarnessIdentity,
  writeTaskLocalExclusive,
} from './context.js';
import { recordEffectIntent, recordEffectOutcome } from './effects.js';
import { currentStateDrift, journalEntry } from './journal.js';
import { failureReport } from './report.js';
import type {
  SessionTransitionDependencies,
  SessionTransitionReport,
  TransitionContext,
} from './types.js';

export {
  ensureSuccessorRouteBinding,
  type EnsuredRouteBinding,
  type ValidatedSuccessorBinding,
  validateSuccessorBinding,
};
function findBootstrapReservation(
  record: TaskRecord,
  context: TransitionContext,
): LaunchReservation | null | 'ambiguous' {
  const requestId = context.bootstrap.request.request_id;
  const matches = (record.launch_reservations ?? []).filter((entry) => {
    const data = bootstrapData(entry);
    return data['request_id'] === requestId;
  });
  return matches.length > 1 ? 'ambiguous' : (matches[0] ?? null);
}

interface ValidatedSuccessorBinding {
  readonly source_file: string;
  readonly source_digest: string;
  readonly participant: CollabBindingParticipant;
  readonly successor_binding: CollabBinding;
  readonly herdr_agent: string;
}

function validateSuccessorBinding(
  context: TransitionContext,
  record: TaskRecord,
):
  | { readonly ok: true; readonly value: ValidatedSuccessorBinding }
  | { readonly ok: false; readonly code: string; readonly message: string } {
  const request = context.request;
  const reservation = findBootstrapReservation(record, context);
  if (reservation === 'ambiguous')
    return {
      ok: false,
      code: 'bootstrap_reservation_ambiguous',
      message: 'More than one bootstrap reservation matches this transition.',
    };
  if (reservation === null)
    return {
      ok: false,
      code: 'bootstrap_reservation_missing',
      message: 'No task-bound successor bootstrap reservation is recorded.',
    };
  const data = bootstrapData(reservation);
  if (
    reservation.subtask_id !== request.intent.subtask_id ||
    reservation.attempt !== request.intent.attempt ||
    reservation.requested_session_id !== request.intent.to.session_id ||
    !sameHarnessIdentity(reservation.holder, request.intent.from) ||
    typeof reservation.released_at !== 'string' ||
    !Number.isFinite(Date.parse(reservation.released_at)) ||
    reservation.phase !== 'completed' ||
    !['submitted', 'already_recorded'].includes(String(reservation.outcome)) ||
    data['request_id'] !== context.bootstrap.request.request_id ||
    data['request_digest'] !== context.bootstrap.digest ||
    data['request_file'] !== context.bootstrap.file ||
    data['config_digest'] !==
      context.bootstrap.request.bootstrap.config_digest ||
    data['bundle_manifest_digest'] !==
      context.bootstrap.request.bootstrap.bundle_digest ||
    data['target_choice'] !== 'sibling' ||
    data['participant_agent_id'] !== request.intent.to.agent_id ||
    data['participant_session_id'] !== request.intent.to.session_id ||
    data['message_id'] !==
      context.bootstrap.request.message_pointer.message_id ||
    data['message_digest'] !==
      context.bootstrap.request.message_pointer.content_digest ||
    data['phase'] !== 'completed' ||
    !isText(data['binding_file'], 4096) ||
    !isText(data['herdr_agent'], 32)
  )
    return {
      ok: false,
      code: 'bootstrap_reservation_mismatch',
      message:
        'The durable bootstrap reservation does not prove this exact completed successor request.',
    };
  const file = data['binding_file'];
  const read = readTaskLocalFile(file, context.task.taskRoot, 64 * 1024);
  if (!read.ok)
    return {
      ok: false,
      code:
        read.code === 'missing'
          ? 'successor_binding_missing'
          : 'successor_binding_unreadable',
      message:
        'The exact task-local bootstrap binding is unavailable or unsafe.',
    };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.bytes.toString('utf8')) as unknown;
  } catch {
    return {
      ok: false,
      code: 'successor_binding_invalid',
      message: 'The task-local bootstrap binding is not valid JSON.',
    };
  }
  const result = collabBindingSchema.safeParse(parsed);
  if (
    !result.success ||
    result.data.task_id !== record.task_id ||
    !safePathEqual(result.data.task_root, context.task.taskRoot)
  )
    return {
      ok: false,
      code: 'successor_binding_invalid',
      message: 'The task-local binding schema or task identity is invalid.',
    };
  const participants = result.data.participants.filter(
    (participant) => participant.agent_id === request.intent.to.agent_id,
  );
  if (participants.length !== 1)
    return {
      ok: false,
      code: 'successor_binding_ambiguous',
      message: 'The binding must contain exactly one successor participant.',
    };
  const participant = participants[0]!;
  if (
    participant.harness !== request.intent.to.harness ||
    participant.native_session_id !== request.intent.to.session_id ||
    !safePathEqual(participant.cwd, request.intent.to.cwd ?? '') ||
    participant.herdr_agent !== data['herdr_agent']
  )
    return {
      ok: false,
      code: 'successor_binding_identity_mismatch',
      message:
        'The successor binding differs from the pinned agent, harness, cwd or Herdr name.',
    };
  const successorBinding = collabBindingSchema.safeParse({
    ...result.data,
    participants: [participant],
  });
  if (!successorBinding.success)
    return {
      ok: false,
      code: 'successor_route_binding_invalid',
      message:
        'A successor-only task-local route binding could not be validated.',
    };
  return {
    ok: true,
    value: {
      source_file: read.file,
      source_digest: read.digest,
      participant,
      successor_binding: successorBinding.data,
      herdr_agent: participant.herdr_agent,
    },
  };
}

interface EnsuredRouteBinding {
  readonly ok: true;
  readonly task: OpenedTaskStore;
  readonly ref: string;
  readonly digest: string;
  readonly binding: CollabBinding;
}

type RouteBindingEnsureResult =
  | EnsuredRouteBinding
  | { readonly ok: false; readonly report: SessionTransitionReport };

function routeBindingFailure(
  context: TransitionContext,
  task: OpenedTaskStore,
  status: 'needs_input' | 'reconcile_required' | 'unknown',
  code: string,
  message: string,
  nextAction: string | null,
): RouteBindingEnsureResult {
  return {
    ok: false,
    report: failureReport(
      'apply',
      context.request,
      status,
      code,
      message,
      nextAction,
      task,
    ),
  };
}

async function ensureSuccessorRouteBinding(
  context: TransitionContext,
  initialTask: OpenedTaskStore,
  dependencies: SessionTransitionDependencies,
  now: () => number,
): Promise<RouteBindingEnsureResult> {
  const request = context.request;
  const drift = currentStateDrift(initialTask.record, request, 'successor');
  if (drift !== null)
    return routeBindingFailure(
      context,
      initialTask,
      'needs_input',
      drift.code,
      drift.message,
      'Reconcile successor assignment, claim epochs and coordinator authority before route changes.',
    );
  const validated = validateSuccessorBinding(context, initialTask.record);
  if (!validated.ok)
    return routeBindingFailure(
      context,
      initialTask,
      'needs_input',
      validated.code,
      validated.message,
      'Reconcile the exact completed bootstrap reservation and task-local binding; do not infer a route.',
    );
  const file = path.join(
    initialTask.taskRoot,
    'notifications',
    'session-transition-bindings',
    `${request.transition_id}.json`,
  );
  const bytes = Buffer.from(
    `${JSON.stringify(validated.value.successor_binding, null, 2)}\n`,
    'utf8',
  );
  const expectedDigest = digestText(bytes);
  let task = initialTask;
  let journal = journalEntry(task.record, request, context.requestDigest);
  if (journal === null)
    return routeBindingFailure(
      context,
      task,
      'unknown',
      'transition_journal_missing',
      'The transition journal is missing or conflicts with its immutable request.',
      'Inspect the authoritative task record before any route-binding effect.',
    );
  const receipt = journal.effects['successor-route-binding'];
  if (receipt?.state === 'failed')
    return routeBindingFailure(
      context,
      task,
      'needs_input',
      'successor_route_binding_failed',
      'A prior route-binding write has a known failed receipt and will not be replayed.',
      'Inspect the exact task-local file and journal before continuing.',
    );
  if (receipt?.state === 'completed') {
    const read = readTaskLocalFile(file, task.taskRoot, 64 * 1024);
    if (
      receipt.ref !== file ||
      receipt.digest !== expectedDigest ||
      journal.route_binding_ref !== file ||
      journal.route_binding_digest !== expectedDigest ||
      !read.ok ||
      read.digest !== expectedDigest ||
      !read.bytes.equals(bytes)
    )
      return routeBindingFailure(
        context,
        task,
        'reconcile_required',
        'successor_route_binding_receipt_mismatch',
        'The completed route-binding receipt no longer matches its exact task-local artifact.',
        'Reconcile the binding file and journal; do not overwrite or re-create it.',
      );
    return {
      ok: true,
      task,
      ref: file,
      digest: expectedDigest,
      binding: validated.value.successor_binding,
    };
  }
  if (receipt?.state === 'pending' || receipt?.state === 'unknown') {
    const read = readTaskLocalFile(file, task.taskRoot, 64 * 1024);
    if (!read.ok || read.digest !== expectedDigest || !read.bytes.equals(bytes))
      return routeBindingFailure(
        context,
        task,
        'reconcile_required',
        'successor_route_binding_outcome_unknown',
        'A prior route-binding effect is pending/unknown and its exact artifact is not present for reconciliation.',
        'Inspect the task-local path and journal; never replay an ambiguous write.',
      );
    const reconciled = await recordEffectOutcome(
      context,
      task,
      'successor-route-binding',
      'completed',
      now(),
      null,
      {
        digest: expectedDigest,
        ref: file,
        artifact: 'route-binding',
      },
    );
    if (!reconciled.ok)
      return routeBindingFailure(
        context,
        task,
        'unknown',
        reconciled.code,
        'The exact route binding exists but its durable receipt could not be reconciled.',
        'Inspect the file and task journal before continuing.',
      );
    task = reconciled.task;
    return {
      ok: true,
      task,
      ref: file,
      digest: expectedDigest,
      binding: validated.value.successor_binding,
    };
  }
  const intent = await recordEffectIntent(
    context,
    task,
    'successor-route-binding',
    now,
    dependencies.signal,
  );
  if (!intent.ok)
    return routeBindingFailure(
      context,
      task,
      intent.kind === 'invalid' ? 'needs_input' : 'reconcile_required',
      intent.code,
      intent.message,
      intent.nextAction,
    );
  task = intent.task;
  const currentBinding = validateSuccessorBinding(context, task.record);
  if (
    !currentBinding.ok ||
    currentBinding.value.source_file !== validated.value.source_file ||
    currentBinding.value.source_digest !== validated.value.source_digest ||
    canonicalJson(currentBinding.value.successor_binding) !==
      canonicalJson(validated.value.successor_binding)
  ) {
    const failed = await recordEffectOutcome(
      context,
      task,
      'successor-route-binding',
      'failed',
      now(),
      'successor_binding_changed_before_write',
    );
    const resultTask = failed.ok ? failed.task : task;
    return routeBindingFailure(
      context,
      resultTask,
      'needs_input',
      'successor_binding_changed_before_write',
      'The source binding or bootstrap reservation changed after the durable effect intent.',
      'Reconcile the exact binding and re-plan before any route file is written.',
    );
  }
  const written = writeTaskLocalExclusive(
    file,
    task.taskRoot,
    bytes,
    64 * 1024,
  );
  if (!written.ok) {
    const unknown = await recordEffectOutcome(
      context,
      task,
      'successor-route-binding',
      'unknown',
      now(),
      written.code,
    );
    const resultTask = unknown.ok ? unknown.task : task;
    return routeBindingFailure(
      context,
      resultTask,
      'reconcile_required',
      'successor_route_binding_outcome_unknown',
      `The successor route binding write did not return a confirmed result (${written.code}).`,
      'Inspect the exact task-local artifact and journal; do not replay the write blindly.',
    );
  }
  const recorded = await recordEffectOutcome(
    context,
    task,
    'successor-route-binding',
    'completed',
    now(),
    null,
    {
      digest: written.digest,
      ref: file,
      artifact: 'route-binding',
    },
  );
  if (!recorded.ok)
    return routeBindingFailure(
      context,
      task,
      'unknown',
      recorded.code,
      'The route-binding file is written but its outcome receipt could not be persisted.',
      'Inspect the binding and journal; do not overwrite or repeat the transfer.',
    );
  return {
    ok: true,
    task: recorded.task,
    ref: file,
    digest: written.digest,
    binding: currentBinding.value.successor_binding,
  };
}
