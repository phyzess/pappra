# Collaboration session transition

`pappra collab transition` is the public, resumable path for moving one collaboration attempt from an exact source Pi session to a prepared successor. The implementation composes the existing rollover reducer and visible-bootstrap flow; it does not replace their ownership rules.

## Commands

```text
pappra collab transition plan  --task-root <absolute-task-root> --request <absolute-request.json> [--json]
pappra collab transition apply --task-root <absolute-task-root> --request <absolute-request.json> [--json]
```

`plan` is read-only. `apply` advances at most the next currently authorized stage and records an effect intent before any effect that may be ambiguous. Before source quiescence and claim transfer, CLI-only `apply` returns `pi_transition_host_required`; those stages require the in-process opt-in Pi controller. Once the core handoff is completed, registered first-work evidence and the reversible task-retirement marker can be resumed from the CLI without a live Pi host. The opt-in Pi extension exposes `/collab-transition plan <absolute-request.json>` and `/collab-transition apply <absolute-request.json>`; loading that extension does not itself launch a successor, change Pi settings, or claim stop-proof capability.

The request uses schema `pappra/collaboration-session-transition-request/1` and contains:

- `task_root` and `transition_id` (which must equal `intent.intent_id`);
- the exact rollover `intent` (generation, handoff, attempt, input revision, source/successor identities, coordinator epoch, and claim IDs/resource epochs);
- one linked continuity bundle root/task/id/digest;
- `bootstrap_request.ref` and the raw-file `sha256:` digest for the explicit visible sibling request;
- optional `managed_execution_scope`, pinning the managed-SDK task, source session, attempt, owner epoch and ordered claim epochs;
- `evidence.ack_message_id` and `evidence.first_work_report_id`, initially nullable; and
- `archive_mode: "task-retirement"`.

All paths are absolute. The transition pins intent, bundle and bootstrap inputs. ACK/REPORT pointer IDs are later-stage evidence and may be added to the request without changing its immutable transition digest. Every pointer is still re-read from the task message store and validated against the current record before use.

## Stage ordering and claims

1. **Plan and intent.** Planning reads the exact task, assignment/card preflight, linked continuity bundle, bootstrap request and registered transition STATUS pointer. The first apply durably creates/reconciles one rollover intent. The current attempt, input revision, owner epoch, source identity, cancellation/approval state and source-held claim epochs are revalidated at each reducer boundary.
2. **Source quiescence.** A complete, fresh, session-bound proof is required before the source is frozen/prepared and before the successor bootstrap can run. A freeze receipt by itself is not enough.
3. **Visible successor bootstrap.** The exact task-bound sibling request is applied once. Its reservation, output binding and notification state must be reconciled after an ambiguous outcome; the transition never silently retries a split, start or prompt.
4. **Receiver ACK.** A registered and applied ACK must have the exact successor sender, current coordinator recipient/epoch, assignment reply pointer, attempt, input revision, handoff, intent and generation. Notification submission is not consumption or acceptance.
5. **Ownership and claim transfer.** Only after that ACK does the core reducer complete the handoff, reassign the attempt, bind the successor native session reference and increment each pinned claim resource epoch. Immediately before this step the app re-observes the live successor through its task-local Herdr binding and revalidates source proof and current task authority. Herdr metadata is not process-affiliation proof; reports continue to say `process_affiliation: not-established`.
6. **Successor-only route binding.** A deterministic, task-local successor-only binding is written after the core transfer and journaled by absolute path and digest. This is a routing input artifact, not proof that external dispatch configuration was changed. The original task binding is not overwritten.
7. **First work.** A registered and applied successor REPORT must be after the saved transfer boundary and admitted as a completed result for the pinned attempt/input. Until then no retirement marker is written.
8. **Reversible task retirement.** After validated first work and route-binding receipt, the transition writes `archive/session-transitions/<transition-id>.json` and records its digest. The marker records `task_id`, `task_root`, `transition_id`, `intent_id`, `handoff_id`, `generation`, `recorded_at`, first-work message ID/digest, successor-route-binding path/digest, `native_archive: "unavailable"`, `original_transcript: "retained-in-place"` and `reversible: true`. It is a reversible task-local marker only: the source transcript/session remains in place and native Pi session archival is unavailable.

The report keeps `successor-binding-written`, notify exclusion, task retirement and native archive distinct. A validated succession can make the old identity excluded from Pappra's notify path while the succession's `routing` field remains `pending`; this is not external route removal.

## Durable resume and reconciliation

The task record stores `session_transition_journal` (`pappra/session-transition-journal/1`). Each transition entry pins the immutable request and bootstrap digests, creation/update times, per-effect `pending`/`completed`/`unknown`/`failed` receipts, and route/archive paths and digests when present.

- A completed core reducer stage is inspected, not replayed.
- A pending/unknown freeze is reconciled from the exact in-process freeze token. The freeze is never blindly repeated after an ambiguous call.
- Pending/unknown route or retirement writes are continued only when the exact task-local bytes and digest are already present. Missing or conflicting artifacts stay `reconcile_required`; they are not overwritten or recreated.
- Approval/cancellation, coordinator epoch, attempt/input, task namespace, assignment, native identity, claim holder/epoch, ACK/REPORT admission and abort are checked again at their relevant effect boundaries.
- An unknown or crashed outcome requires inspection of the authoritative task record, message ledger, reservation, host and artifact. A notification or report pointer alone is never promoted to consumption or acceptance.

## Pi quiescence boundary

The current opt-in Pi adapter reports the exact blocker `pi_native_quiescence_proof_unavailable`. It consumes the existing in-process native-event producer and managed-tool freeze controller, but deliberately does **not** promote their observations to stop proof:

- `agent_settled`, `ctx.isIdle()`, observed-open-tool counts and a clean callback sequence are not a complete inventory;
- queue depth and global pending approvals are unknown;
- observed in-flight tool events are not complete and do not cover background/external writers;
- `nativeStop` is always false in the producer; and
- the managed freeze latch is in memory, can be lost on reload, and is not an OS/process fence.

The legacy accepted host receipt shape used by the reducer is `SessionTransitionQuiescenceProof`: adapter id `pappra/pi-session-transition-host/1`; exact `session_id` and `cwd`; fresh `observed_at`; monotonic `sequence`; durable `evidence_ref`; the exact `freeze_token` (`sessionId`, `taskId`, `handoffId`, `generation`); and `inventory` with `completeness: "complete"`, arrays for `inflight`, `pending_approvals`, `pending_messages` and optional `partial_outputs`. Before `prepareRolloverTransfer`, all three pending/in-flight arrays must be empty and the observed freeze status must carry the same token. This is an interface contract, not a claim that the installed Pi API can produce it.
For a pinned managed-SDK transition, the v2 proof uses adapter id `pappra/managed-pi-session-transition-host/2` and additionally pins `scope`, `execution_scope` and `execution_scope_digest`, `excluded_scope`, runtime quiescence/blockers, and controller sequence/head/journal health. Its journal receipt uses schema `pappra/session-transition-quiescence-receipt/2` and retains `execution_scope_digest`.


The task journal and transition report retain `source_quiescence_receipt` before preparation and `transfer_quiescence_receipt` immediately before claim movement. Each receipt records `schema`, `adapter_id`, `session_id`, `cwd`, `observed_at`, `sequence`, `evidence_ref`, the exact `freeze_token`, the core `inventory_digest`, and, for v2 scoped receipts, `execution_scope_digest`; malformed or mismatched receipts invalidate the journal instead of being inferred from event history.

The generic interactive-Pi production path needs a trusted host operation that atomically fences the source session against new managed and external writers and returns a complete session-bound inventory/stop receipt with a durable evidence reference. At minimum that dependency must define how queued messages, approvals, nested/background tools and external writers are included, how session identity and generation are authenticated, and how receipt freshness/replay are checked. The pinned managed-SDK path instead requires the v2 scoped proof bound by `managed_execution_scope`; it covers the owned runtime and explicitly excludes arbitrary external writers and unowned processes. Without the applicable trusted proof, each path remains blocked before successor launch and claim transfer. Tests inject a deterministic supported adapter only to verify ordering and reducers; those fixtures are **not** evidence of Pi host capability.

## Deliberate non-claims

A task binding, Pi event sample, freeze latch, Herdr status, message submission, applied ACK, admitted REPORT, task-retirement marker, or test-only proof fixture is not process ownership, native archive, automatic route removal, or end-to-end takeover acceptance. The implementation changes no model, provider, reasoning setting, or user Pi configuration.
