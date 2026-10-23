# C5 recorded ownership handoff: implementation direction

Restore public access to the existing writer/coordinator handoff sequence. Keep the authoritative task record and existing handoff/lifecycle/store primitives. This slice records cooperative intent/evidence and transfers recorded ownership; it never stops, launches, adopts or resumes an execution.

## CLI and request contract

`pappra collab handoff inventory --task-root <abs> [--subtask-id <id>] [--attempt <positive integer>] [--json]`

`pappra collab handoff <begin|stopped|rebind|transfer|confirm|complete|abort|release-dispatch> --task-root <abs> --request <abs request.json> [--apply] [--json]`

Use a strict action-discriminated `pappra/collaboration-handoff-request/1`. Action must match CLI. Require an explicit actor identifier and positive current `owner_epoch` on each mutation; optional `expect_revision` uses the existing transaction revision check. Do not imply these editable identifiers authenticate the caller. Input JSON is bounded to 1 MiB via the shared special-file-safe loader. Invalid/duplicate/wrong-action flags or fields fail explicitly. No public clock override.

Operation fields map to existing primitive inputs without invented defaults:

- begin: explicit handoff_id, kind writer/coordinator, from/to identities, resource claim IDs, subtask_id/attempt when writer, optional reason; call beginHandoff.
- stopped: handoff_id, explicit observation and evidence_ref, optional detail; call markOldWriterStopped. Unknown stop must refuse; a recorded claim of confirmed stop is not Pappra's own native stop proof.
- rebind: handoff_id, explicit receiver identity and evidence_ref; call rebindReceiver. Never rebind after confirmation.
- transfer: handoff_id and bounded partial_outputs/inflight/pending_approvals inventory; call markTransferring. Inventory is recorded data, not authorization to answer approvals.
- confirm: handoff_id and registered confirmation_message_id only; no inline fabricated envelope. Read the registered message safely and validate task/from/to/native identities and current owner epoch. Require the authoritative record to include its accepted/recorded protocol entry. It must be ACK/HANDOFF and explicitly correlate via body.handoff_id or reply_to to this handoff, without a conflicting body ID. A rejected/unapplied, wrong-recipient/session/epoch or unrelated confirmation cannot authorize transfer. These are additional public boundary checks; do not weaken core validation. Recommend a HANDOFF notification phase other than request for the receiving agent's confirmation because it records through the existing message route without pretending to be an assignment ACK.
- complete/abort: handoff_id, optional reason for abort; call the existing completion/abort primitive.
- release-dispatch: explicit owner_epoch and actor; only the current epoch can release the recorded freeze. Never release automatically on completion.

Check request owner_epoch inside the transaction immediately before the selected primitive. If a primitive refuses, preserve existing transaction semantics: do not accidentally commit its in-memory partial mutation or report a committed side effect. Success must use the existing transaction/ledger mechanism exactly once.

## Behavior and safety boundaries

- Plan by default validates request/task namespace only and writes nothing; do not call a mutation, register a confirmation, acquire locks or reserve ownership. No promise that later apply succeeds.
- Apply reuses current task-store namespace and identity checks, including nested locks/transactions/ledger. Revalidate all selected confirmation bytes/identity before the transaction and against the transaction's current record where relevant. Do not add another namespace or lock framework.
- Preserve existing sequence and coordinator-specific behavior, overlapping-handoff refusal, old-writer stop requirements, receiver confirmation, ownership snapshot/drift, claim cancellation state, stale epoch and rebound-receiver rules. Preserve the distinction: writer handoff raises resource epochs; coordinator handoff raises owner_epoch and leaves dispatch frozen. No OS fencing claim.
- Use only bounded summaries/inventory with full counts and accurate truncation/omission. Never print message/transcript bodies, stop artifact bodies or arbitrary inventory payloads in summaries. Result output refs/digests may be included as existing inventory metadata.
- Inventory is read-only and stored-state-only. Handoff command never inspects pane idle as stop, answers approval, kills a process or launches another agent. Existing C0-C4 routes and wire IDs remain compatible.
- No uncertain work is automatically retried/reconciled, no lock is broken, no resource is released outside the sequence. Portable task bindings, uncertainty reconciliation/lock recovery and native lifecycle operations remain later slices.

## Tests and delivery

Use only new fixture domains and deterministic native stop/confirmation artifacts. Never hand off this live collaboration's coordinator or writer.

Test installed writer and coordinator sequences; plan/read-only no effects; unknown stop and absent evidence refusal; missing/wrong/replayed/unregistered/rejected confirmation; receiver rebind refusal after confirmation; overlapping requests; holder/claim release or epoch drift; stale owner epoch and stale revision; freeze retained until explicit current-epoch release; transaction refusal leaves authoritative state unchanged; nested path and confirmation symlink/FIFO checks; separate-process competing operations; bounded inventory and strict CLI/input. Preserve representative existing protocol regressions.

Keep implementation to app/CLI/schema glue, collaboration tests and both shipped guidance mirrors. Core behavior should not need redesign; BLOCK a concrete mismatch before weakening checks or broadening authority. Same Pi native session/source claims. Reuse a fresh actual capability observation where valid and run preflight against the new pinned assignment before the first source write; refresh observation if stale. Deliver report/current manifest/input revision/prewrite evidence via product REPORT and one product notification, without polling, waiting, native fallback, new agents, commits or publication.
