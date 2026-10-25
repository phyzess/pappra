import * as rollover from '../../collab/rollover.js';
import type {
  FreezeOutcome,
  FreezeStatus,
  FreezeToken,
} from '../../hosts/integration/pi-rollover-extension.js';
import type { NativeFactsSnapshot } from '../../hosts/integration/pi-native-events.js';
import type {
  LoadedVisibleBootstrapRequest,
  VisibleBootstrapDependencies,
  VisibleBootstrapReport,
} from '../collab-bootstrap.js';
import type { HerdrBootstrapOps } from '../collab-bootstrap-transport.js';
import type { RegisteredMessage } from '../collab-messages.js';
import type { RolloverReport } from '../collab-rollover.js';
import type { OpenedTaskStore } from '../collab-task-store.js';
import type { SessionTransitionRequest } from '../collab-session-transition-request.js';
import type { ManagedPiExecutionScope } from '../../schemas/managed-pi-execution.js';
export const COLLAB_SESSION_TRANSITION_REPORT_SCHEMA =
  'pappra/collaboration-session-transition/1';
export const SESSION_TRANSITION_ARCHIVE_SCHEMA =
  'pappra/session-transition-archive/1';

export interface SessionTransitionRetirementMarker {
  readonly schema: typeof SESSION_TRANSITION_ARCHIVE_SCHEMA;
  readonly mode: 'task-retirement';
  readonly task_id: string;
  readonly task_root: string;
  readonly transition_id: string;
  readonly intent_id: string;
  readonly handoff_id: string;
  readonly generation: number;
  readonly recorded_at: string;
  readonly first_work: {
    readonly message_id: string;
    readonly digest: string;
  };
  readonly successor_route_binding: {
    readonly ref: string;
    readonly digest: string;
  };
  readonly native_archive: 'unavailable';
  readonly original_transcript: 'retained-in-place';
  readonly reversible: true;
}
export type SessionTransitionAction = 'plan' | 'apply';
export type SessionTransitionStatus =
  | 'planned'
  | 'progressed'
  | 'waiting'
  | 'needs_input'
  | 'reconcile_required'
  | 'unknown'
  | 'invalid';
export type SessionTransitionStage =
  | 'not_started'
  | 'intent_created'
  | 'awaiting_quiescence'
  | 'prepared'
  | 'successor_bootstrap'
  | 'awaiting_receiver_ack'
  | 'receiver_confirmed'
  | 'ownership_transferred'
  | 'awaiting_first_work'
  | 'first_work_recorded'
  | 'task_retired'
  | 'unknown';

export const MANAGED_PI_SCOPED_PROOF_ADAPTER_ID =
  'pappra/managed-pi-session-transition-host/2';
export const MANAGED_PI_SCOPED_RECEIPT_SCHEMA =
  'pappra/session-transition-quiescence-receipt/2';

export interface SessionTransitionQuiescenceProof {
  readonly adapter_id:
    | 'pappra/pi-session-transition-host/1'
    | typeof MANAGED_PI_SCOPED_PROOF_ADAPTER_ID;
  readonly session_id: string;
  readonly cwd: string;
  readonly observed_at: string;
  readonly sequence: number;
  readonly evidence_ref: string;
  readonly freeze_token: FreezeToken;
  readonly inventory: rollover.RolloverInventory;
  readonly scope?: 'pinned_pi_1_4_owned_runtime';
  readonly execution_scope?: ManagedPiExecutionScope;
  readonly execution_scope_digest?: string;
  readonly excluded_scope?: readonly [
    'arbitrary_external_writers',
    'unowned_processes_and_descendants',
  ];
  readonly runtime_quiescent?: boolean;
  readonly runtime_blockers?: readonly string[];
  readonly controller_sequence?: number;
  readonly controller_head_digest?: string;
  readonly controller_journal_healthy?: boolean;
}

export interface SessionTransitionQuiescenceReceipt {
  readonly schema:
    | 'pappra/session-transition-quiescence-receipt/1'
    | typeof MANAGED_PI_SCOPED_RECEIPT_SCHEMA;
  readonly adapter_id:
    | 'pappra/pi-session-transition-host/1'
    | typeof MANAGED_PI_SCOPED_PROOF_ADAPTER_ID;
  readonly session_id: string;
  readonly cwd: string;
  readonly observed_at: string;
  readonly sequence: number;
  readonly evidence_ref: string;
  readonly freeze_token: FreezeToken;
  readonly inventory_digest: string;
  readonly execution_scope_digest?: string;
}

export interface SessionTransitionHostObservation {
  readonly session_id: string | null;
  readonly cwd: string | null;
  readonly pane_id: string | null;
  readonly proof_support: 'available' | 'unavailable';
  readonly proof: SessionTransitionQuiescenceProof | null;
  readonly freeze_status: FreezeStatus | null;
  readonly native_facts: NativeFactsSnapshot | null;
  readonly unavailable_code: string | null;
  readonly detail: string | null;
}

/**
 * In-process adapter supplied only by the opt-in Pi extension. The installed producer currently
 * cannot return a complete quiescence proof; its production adapter must report that boundary
 * rather than promote idle, settled, or a freeze latch to stop proof.
 */
export interface SessionTransitionHost {
  readonly id: string;
  observe(): Promise<SessionTransitionHostObservation>;
  freeze(token: FreezeToken): Promise<FreezeOutcome>;
}

export interface SessionTransitionBootstrapExecutor {
  plan(request: LoadedVisibleBootstrapRequest): Promise<VisibleBootstrapReport>;
  apply(
    request: LoadedVisibleBootstrapRequest,
  ): Promise<VisibleBootstrapReport>;
}

export interface SessionTransitionDependencies {
  readonly host?: SessionTransitionHost;
  readonly bootstrap?: SessionTransitionBootstrapExecutor;
  readonly bootstrapDependencies?: VisibleBootstrapDependencies;
  readonly herdr?: HerdrBootstrapOps;
  readonly clock?: () => number;
  readonly signal?: AbortSignal;
}

export interface SessionTransitionStep {
  readonly step: string;
  readonly status: string;
  readonly code: string | null;
  readonly detail: string | null;
}

export interface SessionTransitionReport {
  readonly schema: typeof COLLAB_SESSION_TRANSITION_REPORT_SCHEMA;
  readonly action: SessionTransitionAction;
  readonly ok: boolean;
  readonly status: SessionTransitionStatus;
  readonly code: string | null;
  readonly message: string | null;
  readonly next_action: string | null;
  readonly task_id: string | null;
  readonly task_root: string;
  readonly state_revision: number | null;
  readonly transition_id: string;
  readonly cause_ref: string;
  readonly stage: SessionTransitionStage;
  readonly intent: Record<string, unknown> | null;
  readonly handoff: Record<string, unknown> | null;
  readonly rollover: RolloverReport | null;
  readonly bootstrap: VisibleBootstrapReport | null;
  readonly receiver_ack: Record<string, unknown> | null;
  readonly transfer: Record<string, unknown> | null;
  readonly first_work: Record<string, unknown> | null;
  readonly route_transfer: Record<string, unknown> | null;
  readonly archive: Record<string, unknown> | null;
  readonly host: Record<string, unknown> | null;
  readonly steps: readonly SessionTransitionStep[];
  readonly capabilities: {
    readonly record_reducer: 'available';
    readonly bootstrap: 'available';
    readonly pi_host_extension: 'available' | 'not_loaded';
    readonly supported_quiescence: 'available' | 'unavailable' | 'unknown';
    readonly native_session_archive: 'unavailable';
    readonly task_retirement_archive: 'available';
    readonly task_route_transfer: 'available';
    readonly notification_route_exclusion:
      'active' | 'pending' | 'excluded' | 'unknown';
  };
  readonly limits: readonly string[];
}

export interface TransitionFailure {
  readonly ok: false;
  readonly kind: 'invalid' | 'needs_input';
  readonly code: string;
  readonly message: string;
  readonly nextAction: string | null;
}

export interface TransitionContext {
  readonly request: SessionTransitionRequest;
  readonly requestDigest: string;
  readonly task: OpenedTaskStore;
  readonly bootstrap: LoadedVisibleBootstrapRequest;
  readonly contactMessage: RegisteredMessage;
}

export interface SessionTransitionEffectReceipt {
  readonly state: 'pending' | 'completed' | 'unknown' | 'failed';
  readonly intent_at: string;
  readonly outcome_at?: string;
  readonly code?: string;
  readonly digest?: string;
  readonly ref?: string;
}

export interface SessionTransitionJournalEntry {
  readonly transition_id: string;
  readonly request_digest: string;
  readonly bootstrap_request_digest: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly effects: Readonly<Record<string, SessionTransitionEffectReceipt>>;
  readonly route_binding_ref?: string | null;
  readonly route_binding_digest?: string | null;
  readonly archive_ref?: string | null;
  readonly archive_digest?: string | null;
  readonly source_quiescence_receipt?: SessionTransitionQuiescenceReceipt;
  readonly transfer_quiescence_receipt?: SessionTransitionQuiescenceReceipt;
}

export interface SessionTransitionJournal {
  readonly schema: 'pappra/session-transition-journal/1';
  readonly entries: readonly SessionTransitionJournalEntry[];
}
