# Interrupted workflow recovery: observed case and next slice

The user reports an intervening network outage and asks to include automatic restart/resume in the workflow. Recovery must cover durable collaboration progress, not merely resume a model transcript.

## Observed current case

- Both existing visible Pi agents are idle with their original native session and pane identities intact.
- Investigator's design STATUS is persisted; its assigned design work is complete.
- `e3-visible-bootstrap-product` attempt 1 remains `assigned`, without a corresponding implementation ACK/REPORT. All eleven implementation source paths match the pre-implementation baseline (the eight new files are absent).
- The writer's last assistant turn ended normally at `2026-10-23T00:08:28.521Z`, still claiming a coordinator/runtime reconciliation was pending. Its current local preflight had already been ready.
- The coordinator's runtime-continuation ANSWER was persisted, submitted and appears as a native user-message pointer at `2026-10-23T00:07:16.313Z`, before that final assistant turn. Thus this observation is not evidence of an absent native delivery. Pointer receipt did not produce reconciled workflow progress. Whether interruption, message handling or stale reasoning caused that gap needs investigation.
- A bounded read of the last 256 KiB per session found no error on the most recent assistant terminal turns. This does not disprove the user's earlier outage or establish its exact provider/transport cause. No raw transcripts, environment or credentials are copied into this review.

## Immediate recovery

Send one explicit continuation message to the same writer, referencing the original assignment and the already persisted reconciliation. Preserve model, task, attempt and claims; do not repeat ASSIGN, create a new agent or treat idle as completion. The writer must reconcile pending messages and authoritative task/claims/input state, capture genuine current runtime evidence and save matching own preflight if the previous card is stale. A changed model alone needs no repeated coordinator approval. After valid checks, ACK the original task and continue the authorized implementation, rather than returning another readiness-only terminal response. Report a concrete blocker if identity, ownership, capability or source state actually prevents progress.

## Product recovery requirements

1. On a supported startup/reconnect/turn-boundary event, reconcile durable open assignments, unread/unfinished message effects, accepted reports and the workflow's next action. An event is a wakeup hint; persisted state is authoritative. No model-completion polling loop.
2. Separate message submitted, native pointer observed, protocol ACK, work started, result persisted and reviewer/integrator progression. A received pointer is not consumed work; idle is not success. A network interruption must not drop a pending continuation or strand a completed result before review.
3. Retain a stable task/attempt/request identity and last confirmed effect. Retry transient transport operations only with bounded backoff and a retry budget, after reconciling potentially completed side effects. Never blindly duplicate prompts, file operations, pane launches or ownership transfer after ambiguous responses.
4. Same-session recovery refreshes only stale or materially changed evidence, preserving current model/settings. A genuinely new session follows explicit identity/bootstrap/handoff rules; never adopt arbitrary processes or grant ownership from a transcript alone.
5. Resume only already authorized unfinished work under an explicit recovery policy. Cancellation, approval wait, revoked claims, mismatched identity and nonretryable failure remain respected. After exhausted retries, persist an actionable state instead of silently claiming completion.
6. Completed writer reports must be replayable into review/integration without rerunning work. Outbox delivery and workflow transitions need stable deduplication so a coordinator restart also recovers its next action.
7. Test disconnected/reconnected transport, interruption during tool work, a continuation arriving while a participant is busy, crash after effect before receipt, duplicate lifecycle events, completed report awaiting review, model change, stale evidence, cancellation and retry exhaustion. Validate continuation effects and no duplicate writers/prompts, not just process restart.

The existing public bootstrap implementation continues unchanged in parallel. Investigator audits existing message/store/recovery/native event surfaces read-only and proposes the smallest scoped product implementation using these contracts. New recovery source work follows a separate coordinator-reviewed assignment; this document does not authorize editing the bootstrap writer's files or shipping an unbounded supervisor.
