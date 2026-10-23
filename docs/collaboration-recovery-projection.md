# Collaboration recovery projection (R1)

`inspectRecoveryProjection` is a bounded, read-only product API that analyses the persisted collaboration
record, a work plan and the registered-message namespace to report the unresolved message-driven actions a
recovery executor would still owe after an interruption. It is an **advisory projection only**: it never
acknowledges, claims, reserves, notifies, starts a model, mutates a file or grants authority.

It is the first (R1) component of interrupted-workflow recovery. Durable per-action reservation and one-shot
execution (R2) and an opt-in supported host startup/settled/manual continuation surface (R3) are separate,
later modules. Public CLI/router and host-export registration are handled by the integrator; this module
exposes only a programmatic API.

## API

```ts
import {
  inspectRecoveryProjection,
  type RecoveryInspectionOptions,
  type RecoveryProjection,
  type RecoveryProjectionResult,
  type RecoveryAction,
  type RecoveryPolicy,
} from '../app/collab-recovery-projection.js';

const result: RecoveryProjectionResult = await inspectRecoveryProjection({
  taskRoot,  // absolute path to the task record directory
  planFile,  // absolute path to the work-plan JSON document
  self,      // full { agent_id, session_id, harness } identity of the caller
  policy,    // { role: 'writer' | 'coordinator' | 'reviewer', authorizedSubtasks?: string[] }
});
```

`inspectRecoveryProjection` is asynchronous (it reuses the bounded work-plan inspection) and returns a
discriminated result:

- `{ ok: true, value: RecoveryProjection }`
- `{ ok: false, reason, message, next_action }` for invalid input or a missing/corrupt task record.

### `RecoveryProjection`

| field | meaning |
| --- | --- |
| `schema` | `pappra/collab-recovery-projection/1` |
| `self` | the caller identity the projection was computed for |
| `task_root` / `task_id` | the inspected task |
| `plan_digest` | the plan digest of the consistent snapshot |
| `record_revision` | the record `state_revision` at read time |
| `coverage` | `complete` or `incomplete` |
| `coordinator_verified` | whether `self` is the current record coordinator (relevant for the coordinator role) |
| `actions` | the advisory `RecoveryAction[]` |
| `notes` | human-readable evidence/limitation notes |
| `limits` | fixed read-only/advisory limitations |

### `RecoveryAction`

Each action carries a stable, unambiguous `key` (encoding the exact identity a later reservation/executor
reserves on), a `kind`, the `subtask_id`/`attempt`, `prerequisites`, `evidence` and a `status`.

| kind | when | status |
| --- | --- | --- |
| `resume_work` | a running attempt owned by `self` with no admissible corrective answer | `pending` |
| `answer_supersedes_wait` | a registered coordinator ANSWER, digest-verified and correlated to this exact task/subtask/attempt/input/epoch, supersedes an obsolete wait | `pending` |
| `progress_report_to_review` | the current coordinator has a registered `applied` owner report for the latest attempt/input awaiting review dispatch | `pending` / `observed` |
| `report_unadmitted` | an awaiting node whose report is late/superseded/withheld/unregistered or digest-unverifiable | `unknown` |
| `blocked_awaiting_gate` | an approval, cancellation or revoked-claim gate holds the attempt | `blocked` |
| `ambiguous_effect` | an unresolved persisted uncertainty is an unknown external effect; it blocks conflicting continuation/review | `unknown` |
| `verified_completion` | the node is completed and coordinator-accepted; nothing to resume | `complete` |
| `none` | nothing actionable | `pending` / `unknown` |

## Guarantees and limits

- **Consistent snapshot.** The record is read (through the bounded no-follow reader) before the evaluation,
  and the record revision/bytes, plan digest and task namespace are revalidated AFTER all registered-envelope
  reads. The namespace anchor pins the task root, its messages directory and two ancestors by device and
  inode (`anchorTaskNamespace`/`verifyTaskNamespace`), so a same-revision replacement or a redirected
  task-root/messages directory is caught; a symlinked component makes the anchor unavailable. A changed
  revision, changed bytes, a redirected namespace, a stale work-plan, a changed plan digest, an
  evidence-budget overflow or a join gap makes every affected recommendation non-actionable
  (`coverage: incomplete`). A
  corrupt, oversized, redirected or missing record returns a structured refusal rather than throwing. The
  bootstrap writer may concurrently edit its own disjoint source and messages; that is not treated as drift
  of this task record.
- **Bounded.** Record/registry/node scans and file reads are bounded by explicit count and byte limits. A
  latest-page listing is never assumed to be a complete inbox; truncation, refusal, a missing join or an
  overflow is reported as non-actionable.
- **Fail-closed correlation.** A continuation ANSWER must be a registered envelope, re-read and
  digest-verified against the authoritative record registry, sent by the current coordinator to `self` for
  exactly this task/subtask/attempt/input/epoch. A supplied string digest, an arbitrary envelope object or a
  matching `message_id` alone is not proof. Missing correlation stays insufficient; the projection falls back
  to `resume_work` rather than overriding a wait.
- **Strict roles.** A writer or reviewer never receives coordinator review-dispatch work. The coordinator
  role is honoured only when the policy role is `coordinator` AND `self` matches the current record
  coordinator identity; a policy role string alone is insufficient. Other role recommendations are scoped to
  the real record attempt owner, not only the harness-less plan assignee.
- **Admission.** Review requires the current `applied` owner report for the latest matching attempt/input and
  its exact registered envelope identity/digest; late, superseded, withheld and stale-sender evidence is
  retained but never promoted. Coordinator acceptance is read from the work-plan model, not inferred from
  report text or native idle.
- **Report correlation and current claims.** A report is admitted only when the registered entry and the
  re-read envelope fully correlate (type, id, task, owner, recipient, subtask, attempt, input, status) and
  the attempt is under the current coordinator epoch; a digest matches bytes, not authority. When several
  valid coordinator corrections exist, the newest in authoritative application order is selected. A
  historical released claim never vetoes a valid current held grant; only a current held claim pending
  cancellation, or a revocation with no current grant, gates recovery.
- **No caller-supplied authority (R1).** R1 does not accept a caller-supplied future action-evidence input as
  authority; an unknown external effect blocks conflicting continuation/review. Trusted action evidence and
  reservation arrive in R2.
- **Incomplete evidence is non-actionable.** When coverage is incomplete, actionable recommendations are
  downgraded to `unknown` with a `complete_evidence` prerequisite; the projection never emits a quiet
  completion or an unqualified pending continuation from incomplete evidence.
- **Read-only.** Inspection performs no writes, host calls, native queries, model turns, locks, reservations
  or notifications, and holds no task write lock. This API alone is not automatic recovery; final
  installation and live-flow proof occur after integration.
