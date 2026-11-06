import type {
  BootstrapStatus,
  SiblingExecution,
  VisibleBootstrapReport,
} from '../collab-bootstrap.js';
import type { BootstrapPaneSnapshot } from '../collab-bootstrap-transport.js';
import type { PanePlacementSuccess } from '../collab-pane-layout.js';
import {
  verifyAvailableShell,
  type ShellReadinessResult,
} from '../shell-readiness.js';

export interface ReadySibling {
  readonly pane: BootstrapPaneSnapshot;
  readonly placement: PanePlacementSuccess;
  readonly readiness: ShellReadinessResult;
}

export async function allocateSibling(
  execution: SiblingExecution,
  onReady: (ready: ReadySibling) => Promise<VisibleBootstrapReport>,
): Promise<VisibleBootstrapReport> {
  const {
    context,
    reservationId,
    dependencies,
    now,
    steps,
    phase,
    paneIdPattern,
    safePathEqual,
    resolvePanePlacement,
    commitEffectIntent,
    persistReceipt,
    revalidateCurrent,
    liveCallerAgain,
    closeOwnedEmptyPane,
    terminalReport,
  } = execution;
  const request = context.request;
  const callerNow = await liveCallerAgain(context);
  if (!callerNow.ok) {
    const released = phase({
      phase: 'caller_changed_before_split',
      outcome: 'not_started',
      release: true,
      detail: callerNow.code,
    });
    return terminalReport(
      context,
      'needs_input',
      callerNow.code,
      callerNow.message,
      'Run from the exact task-bound caller pane.',
      {
        state_revision: released.ok ? released.revision : execution.revision,
        reservation: {
          reservation_id: reservationId,
          phase: 'not_started',
          outcome: 'not_started',
        },
        effects: [
          { step: 'split', status: 'not_started', detail: callerNow.code },
        ],
      },
    );
  }

  const current = await revalidateCurrent(context, now());
  if (!current.ok) {
    const released = phase({
      phase: 'not_started_revalidated',
      outcome: 'not_started',
      release: true,
      detail: current.code,
    });
    return terminalReport(
      context,
      'needs_input',
      current.code,
      current.message,
      'Re-plan after reconciling the task/config/message state.',
      {
        state_revision: released.ok ? released.revision : execution.revision,
        reservation: {
          reservation_id: reservationId,
          phase: 'not_started',
          outcome: 'not_started',
        },
        effects: [
          { step: 'split', status: 'not_started', detail: current.code },
        ],
      },
    );
  }
  const pending = commitEffectIntent(
    context,
    reservationId,
    current.task.record.state_revision,
    current.task.identity.recordFile,
    'split_pending',
    now(),
    dependencies.signal,
  );
  if (!pending.ok) {
    const released = phase({
      phase: 'split_intent_refused',
      outcome: 'not_started',
      release: true,
      detail: pending.code,
    });
    return terminalReport(
      context,
      'needs_input',
      pending.code,
      pending.message,
      'Reconcile current authority/cancellation state before a new request.',
      {
        state_revision: released.ok ? released.revision : execution.revision,
        reservation: {
          reservation_id: reservationId,
          phase: 'not_started',
          outcome: 'not_started',
        },
        effects: [
          { step: 'split', status: 'not_started', detail: pending.code },
        ],
      },
    );
  }
  execution.revision = pending.revision;
  const placementResult = await resolvePanePlacement(context);
  if (!placementResult.ok) {
    const released = phase({
      phase: 'split_intent_refused',
      outcome: 'not_started',
      release: true,
      detail: placementResult.code,
    });
    return terminalReport(
      context,
      'failed',
      placementResult.code,
      placementResult.message,
      'Close or reclaim finished panes, or reuse an existing participant before retrying.',
      {
        state_revision: released.ok ? released.revision : execution.revision,
        reservation: {
          reservation_id: reservationId,
          phase: 'not_started',
          outcome: 'not_started',
        },
        effects: [
          {
            step: 'split',
            status: 'not_started',
            detail: placementResult.code,
          },
        ],
      },
    );
  }
  const placement = placementResult.placement;
  if (!placement.ok) {
    const released = phase({
      phase: 'pane_layout_exhausted',
      outcome: 'not_started',
      release: true,
      detail: placement.code,
    });
    return terminalReport(
      context,
      'failed',
      placement.code,
      placement.message,
      'Close or reclaim finished panes, or reuse an existing participant before retrying.',
      {
        state_revision: released.ok ? released.revision : execution.revision,
        reservation: {
          reservation_id: reservationId,
          phase: 'not_started',
          outcome: 'not_started',
        },
        effects: [
          { step: 'split', status: 'not_started', detail: placement.code },
        ],
      },
    );
  }
  const split = await context.ops.splitPane({
    paneId: placement.anchorPaneId,
    cwd: request.target.cwd,
    direction: placement.direction,
    ...(placement.ratio === undefined ? {} : { ratio: placement.ratio }),
    onReceipt: persistReceipt(context, reservationId, now),
  });
  if (!split.ok) {
    const unknown = split.status === 'unknown';
    const saved = phase({
      phase: unknown ? 'split_unknown' : 'split_failed',
      outcome: unknown ? 'unknown' : 'not_started',
      release: !unknown,
      detail: split.code,
    });
    return terminalReport(
      context,
      unknown ? 'unknown' : 'failed',
      split.code,
      split.detail,
      'Inspect the durable request and Herdr pane list; never retry a split with the same request id.',
      {
        state_revision: saved.ok ? saved.revision : execution.revision,
        reservation: {
          reservation_id: reservationId,
          phase: unknown ? 'split_unknown' : 'split_failed',
        },
        effects: [{ step: 'split', status: split.status, detail: split.code }],
      },
    );
  }
  const pane = split.value;
  if (
    !paneIdPattern.test(pane.paneId) ||
    pane.paneId === context.caller.paneId ||
    pane.paneId === placement.anchorPaneId ||
    pane.workspaceId !== context.caller.workspaceId ||
    pane.agent !== null ||
    pane.cwd === null ||
    !safePathEqual(pane.cwd, request.target.cwd)
  ) {
    const saved = phase({
      phase: 'split_identity_unknown',
      outcome: 'unknown',
      detail: 'split result identity mismatch',
      extra: { split_response_received: true },
    });
    return terminalReport(
      context,
      'unknown',
      'split_identity_unverified',
      'Herdr returned a pane whose exact owned identity/cwd could not be confirmed; no guessed cleanup was attempted.',
      null,
      {
        state_revision: saved.ok ? saved.revision : execution.revision,
        effects: [
          { step: 'split', status: 'unknown', detail: 'identity/cwd mismatch' },
        ],
      },
    );
  }
  const created = phase({
    phase: 'pane_created',
    extra: {
      created_pane_id: pane.paneId,
      created_workspace_id: pane.workspaceId,
      created_terminal_id: pane.terminalId,
      created_tab_id: pane.tabId,
      created_cwd: pane.cwd,
      anchor_pane_id: placement.anchorPaneId,
      split_direction: placement.direction,
      split_ratio: placement.ratio ?? null,
    },
  });
  if (!created.ok)
    return terminalReport(
      context,
      'unknown',
      created.code,
      created.message,
      null,
      {
        state_revision: execution.revision,
        target: { ...request.target, pane_id: pane.paneId },
      },
    );
  steps.push({
    step: 'split',
    status: 'completed',
    detail: `owned pane ${pane.paneId} from anchor ${placement.anchorPaneId} (${placement.direction}${placement.ratio === undefined ? '' : ` ratio ${String(placement.ratio)}`})`,
  });

  const readiness = await verifyAvailableShell(
    context.ops,
    {
      paneId: pane.paneId,
      workspaceId: pane.workspaceId,
      terminalId: pane.terminalId,
      cwd: request.target.cwd,
    },
    {
      budgetMs: request.readiness?.budget_ms ?? 10_000,
      intervalMs: request.readiness?.interval_ms ?? 100,
      maxSamples: request.readiness?.max_samples ?? 100,
      clock: now,
      ...(dependencies.sleeper === undefined
        ? {}
        : { sleeper: dependencies.sleeper }),
      shouldAbort: () => dependencies.signal?.aborted === true,
    },
  );
  const readyPhase = phase({
    phase:
      readiness.status === 'ready'
        ? 'shell_ready'
        : `readiness_${readiness.status}`,
    detail: readiness.code,
    extra: { readiness: readiness.evidence },
  });
  if (readiness.status !== 'ready') {
    steps.push({
      step: 'shell-readiness',
      status: readiness.status,
      detail: readiness.code,
    });
    const cleanup = await closeOwnedEmptyPane(
      context,
      reservationId,
      pane,
      now,
    );
    const cleanupConfirmed = cleanup.state === 'closed_owned_pane';
    const saved = phase({
      phase: `readiness_${readiness.status}_complete`,
      outcome: cleanupConfirmed ? 'not_started' : 'unknown',
      release: cleanupConfirmed,
      detail: readiness.code,
      extra: { cleanup: { state: cleanup.state, code: cleanup.code } },
    });
    const status: BootstrapStatus =
      readiness.status === 'unknown' || !cleanupConfirmed
        ? 'unknown'
        : 'failed';
    return terminalReport(
      context,
      status,
      `shell_readiness_${readiness.status}`,
      `No agent was started because the owned pane did not reach verified available-shell state (${readiness.code}).`,
      cleanupConfirmed
        ? 'Inspect readiness samples and create a new request only after the pane is reconciled.'
        : 'Reconcile the owned pane; no automatic close/retry is permitted.',
      {
        state_revision: saved.ok
          ? saved.revision
          : readyPhase.ok
            ? readyPhase.revision
            : execution.revision,
        target: { ...request.target, pane_id: pane.paneId },
        readiness: readiness.evidence,
        reservation: {
          reservation_id: reservationId,
          phase: `readiness_${readiness.status}`,
          cleanup: cleanup.state,
        },
        effects: [
          ...steps,
          { step: 'cleanup', status: cleanup.state, detail: cleanup.code },
        ],
      },
    );
  }
  steps.push({
    step: 'shell-readiness',
    status: 'ready',
    detail: `${readiness.evidence.attempts} samples in ${readiness.evidence.elapsed_ms}ms`,
  });

  return onReady({ pane, placement, readiness });
}
