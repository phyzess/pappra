# Visible bootstrap functional batch review

Status: changes requested before independent acceptance. Scope: the eleven-file public bootstrap batch reported on 2026-10-23. No full regression, package, installation or live model campaign was run.

Independent verification used `/private/tmp/bootstrap-product-review.kSAnWc`, private copied dependencies and a strict TypeScript compile including all three new tests. The original 27 tests pass. Two additional deterministic cancellation regressions fail. Reproduction helper: `/tmp/bootstrap-product-review-cases.mjs` (appends cases only to private compiled tests, leaving source untouched). The private package uses the repository package metadata for self-resolution; a preliminary missing-metadata CLI failure was a review setup issue, subsequently corrected.

## P1: stale authorization survives awaited observations before native effects

In `src/app/collab-bootstrap.ts`, `applySibling` checks current task state before awaiting `liveCallerAgain`; the subsequent `split_pending` transaction validates only the reservation digest/released state. A CANCEL admitted during that caller lookup still allows `splitPane`. Similarly, after `beforeStart` revalidation, caller and pane observations are awaited before `agent_start_pending`; a CANCEL admitted by the final pane observation still allows `startAgent`.

Reproductions use the existing real task fixture and valid coordinator CANCEL envelopes:

- Wrap the second `verifyCaller` call, admit CANCEL before returning the valid observation: split count is **1**, expected **0**. The later pre-start check catches cancellation, after the pane mutation.
- Wrap the third `paneGet` call, admit CANCEL before returning the valid observation: native start count is **1**, expected **0**. The later pre-notify check catches cancellation, after starting the successor.

Repair the batch together: validate authoritative current task/attempt/input/coordinator epoch, cancellation/approval/dispatch state and relevant current claims inside the final durable intent transaction after asynchronous observations, immediately before each effect. Reuse this guard for split/start and registered-message submission/reuse where applicable. Reconcile namespace identity and explicit abort signals at effect boundaries. Do not claim atomicity across Herdr or filesystem processes: this fix must close the deterministic stale-state window and preserve unknown outcomes without blind retries. Add meaningful delayed-observation tests for cancellation, approval and revoked claim/epoch drift; retain duplicate/concurrent/crash-window checks. No additional full or live campaign is required for this repair.

## Evidence correction

The final verification JSON records an incorrect digest for `docs/collaboration-bootstrap.md` (`f1fad43b...ec20dec`). The implementation report's digest (`f1fad43b...842c273`) matches the current file. The ten other source/test pins match the final verification. Correct the evidence with the repaired batch; this alone requires no new model/preparation or coordinator approval cycle.

## Integration and cadence

Keep the current eleven-file ownership and selected model. B continues the disjoint recovery executor/opt-in extension/CLI handler. No changes to B files or accepted core guards. Run isolated strict compilation and affected tests, then return one complete repair REPORT with stable API and accurate hashes. Public bootstrap APIs remain the integration contract; real session transition, first-work-before-archive and automatic context policy remain subsequent functional batches.
