# E7 R1 source: bounded read-only recovery analysis

The investigation has converged on the missing inbox/continuation layer. Stop expanding temporary prototypes. Implement the first product component using existing typed contracts, bounded loaders and work-plan evaluation. The temporary R2 reference is illustrative, not approved production code; its `typeof content_digest` and `provenance: validated` checks are not validation.

The existing investigator Pi now becomes writer for this separate, disjoint slice. Original Pi continues public bootstrap. Coordinator is the independent reviewer; this writer cannot accept its own work. Retire only the completed C0 task's historical broad `src/app` and `tests/collab` claims, retaining all eleven exact bootstrap claims. Only the three exact new claims in this assignment authorize edits.

## Writable scope

- `src/app/collab-recovery-projection.ts`
- `tests/collab/recovery-projection.test.ts`
- `docs/collaboration-recovery-projection.md`

Do not change any existing file, CLI router/help, shared schema, accepted hook/guard, bootstrap source, package/dependency/configuration or generated output. This is an app API with documented programmatic use; public CLI integration follows after bootstrap. Source and comments use English. The API remains read-only at runtime.

## Public app contract

Expose a bounded inspection function taking absolute task-root and plan-file paths, a strict self identity and explicit role/subtask policy. Prefer `inspectRecoveryProjection(options)` and existing `TaskStoreResult`/report conventions. It returns a typed advisory report of unresolved continuation/review/observation actions, evidence identities and prerequisites; it never ACKs, claims, starts a model, notifies, reserves, mutates files or grants authority. State explicit persisted-snapshot limitations.

Reuse `inspectWorkPlan`/`evaluateWorkPlan`, `validateWorkPlan`, bounded file readers, task namespace anchoring and registered message validation. Do not create a second dependency/acceptance evaluator or scheduler. Join real evaluation node_id through validated WorkPlan assignment_id/attempt/input/assignee and the current task record. Active assigned/accepted/running attempts correspond to work-plan running; completed and coordinator-accepted work never resumes. A writer/reviewer must never receive coordinator review-dispatch work. Match coordinator self identity explicitly; a policy role string alone is insufficient.

Use one consistent record revision/epoch and plan digest across reads; if concurrent mutation or namespace/identity drift prevents a consistent snapshot, return incomplete/unknown with a useful next action. The original bootstrap writer may concurrently modify its own source and task messages; do not declare its expected disjoint source edits unexplained drift. Do not hold a task write lock while running host calls; this API needs no host calls or effects.

Bound every record/message/node scan and file read with explicit count/byte limits. A latest-page listing is not a complete inbox: detect truncation/refusal/app stale or incomplete reports, missing joins and overflow. Return non-actionable unknown/blocked recommendations with complete-evidence prerequisites, never a quiet complete/none or an unqualified pending continuation. Preserve approval, cancellation including cancel_requested_at/claim cancel_pending/uncertainty, revoked resources, superseded attempts, changed input and coordinator/session mismatch.

Read full registered envelopes only as needed from the validated task namespace. Recompute and validate their real envelope content digests and correlate them against authoritative record entries, exact task/subtask/attempt/input/epoch/recipient/sender/reply. A supplied string digest, arbitrary envelope object or same message_id is not proof of registration or permission. Missing correlation stays insufficient. A corrective coordinator ANSWER may explain why an old wait is obsolete, but it cannot cancel an approval or grant new scope. Describe required fresh capability/claim checks without manufacturing runtime observations.

Review actions require the current `applied` owner REPORT for the latest matching attempt/input and its exact registered envelope identity/digest. Late/superseded/withheld/stale-sender evidence is retained, never promoted. Key review actions on report ID/digest/input/attempt/coordinator epoch, and continuation actions on exact cause/intent and corresponding identity, using stable unambiguous encoding. Reuse explicit coordinator acceptance in the work-plan model rather than inferring completion from report text or native idle.

R1 does not accept caller-supplied future `actionEvidence` as authority. Surface existing persisted uncertainty/delivery ambiguity conservatively where supported; unknown external effects must block conflicting continuation/review recommendations. Do not invent attempt.dispatch or result.review_result fields, and do not infer no pending effect merely from an absent receipt. R2 will add a separately reviewed trusted action-evidence/reservation adapter. Registration, transport submission, acceptance and actual work remain distinct.

## Tests and evidence

Use the real evaluator and envelope builders with real temporary task/registered-message files. Cover the original accepted unfinished task, node-to-assignment join, genuine completed coordinator acceptance, corrective ANSWER, wrong attempt/input/epoch/sender/recipient, changed coordinator self, writer/reviewer denied coordinator action, absent registration and forged digest/report, unadmitted result, cancellation/approval/revocation, missing/truncated/stale/refused/overflow inputs and namespace redirect, stable keys and ambiguity precedence. Prove inspection leaves its input tree unchanged. Negative tests must assert actual recommendations and effect absence, not repeat implementation branches. No live model/session/pane/network fixture.

The nineteen accepted bootstrap/core pins and the existing work-plan/message/recovery modules stay unchanged. A fresh matching source preflight and exact claims are required before edits. The current card reports callable read/bash: those suffice for this scoped implementation through the authorized shell; do not invent an unobserved native write-tool claim. If another tool is needed, genuinely observe it first. Preserve selected model/settings. Routine genuine freshness updates within this unchanged assignment need no model-reversion approval.

Compile/test only this slice and necessary dependencies in isolated output. Do not run a whole-source build while the other writer is editing, clean shared dist/.build, mutate dependency symlinks, install, commit or publish. A shared dist disappearance was observed by coordinator; use the existing private CLI `/private/tmp/bootstrap-r3-review.i0lrTX/dist/cli/main.js` for protocol operations if necessary and do not repair shared output as part of this assignment. Save exact source/test/protected hashes, commands/results, own before-action preflight and limitations in a proactive REPORT. R1 does not claim public CLI integration or automatic restart/continuation; R2/R3 remain required.
