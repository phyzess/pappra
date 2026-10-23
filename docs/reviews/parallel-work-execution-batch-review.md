# Parallel work execution batch review

Status: changes requested before acceptance. Independent strict private compilation and all 11 supplied tests pass in `/private/tmp/parallel-work-review.Xnl11I`. The report and four output digests match. Real-task fixtures demonstrate overlapping adapter dispatch, dependency acceptance checks and deterministic aggregation. No full/package/install/live verification was repeated.

## P1: an existing intent bypasses unrelated late blockers

In the final concurrent dispatch map, `!live.ok && !live.blockers.includes('dispatch_intent_exists_reconcile')` means any eligibility failure is ignored if the already-created intent is also present. A registered intent is expected here, so a newly revoked claim or changed capability/binding/assignment can be ignored with it.

Deterministic reproduction: persist writer-1's intent; during writer-2's participant revalidation, release writer-1's exact active resource claim; then let the final concurrent dispatch phase run. Both assignment notifications are dispatched, including writer-1 after revocation. Expected: writer-1 is blocked with no dispatch; independent valid writer-2 may progress. Private helper `/tmp/parallel-work-review-cases.mjs` appends this case only to the private compiled test. Observed calls: `msg-assign-writer-1`, `msg-assign-writer-2`.

Permit only the single expected own-intent blocker after validating the exact intent cause/message/ownership; reject **every other blocker**, not merely absence of an intent. Keep cause-based dedup and unknown-effect non-replay. Add late revocation, capability/identity/binding drift and other applicable authority regressions, plus genuinely concurrent duplicate invocations of the same cause. Do not grant another send right because the process sees its own intent.

## P1: final production notification still lacks a current authority boundary

The default adapter calls `notifyRegisteredMessage` after the executor's last eligibility read. That notification performs asynchronous caller/recipient observations, but the adapter supplies no final current work-plan/assignment/claims/cancel/approval/binding authority guard before prompt. This repeats the late-observation class already fixed in bootstrap and recovery. Add a narrowly typed final authority callback/guard consumed by the production adapter after its last awaited native lookup and immediately before the prompt. Revalidate current namespace, plan/assignment/input/epochs, exact binding/card/claims, dependency acceptance and cancellation/approval; preserve correct dispatch-intent ownership. A stale preflight is not authorization. Do not edit accepted generic notification/core modules: compose a guarded transport or adapter in your owned module.

Use a meaningful production-adapter fixture with a real task and injected native transport to admit a cancellation/revocation while live routing is being awaited. Assert zero subsequent prompt for that node and no duplicated side effect. A fake adapter asserting it performed a guard is not proof that the production path does so.

## Integration and execution cadence

Repair these related dispatch boundaries together in the same four-file ownership. Keep exported handler names stable; one material interface notice to the recovery/router owner if callback/adapter fields change. Public apply is not independently accepted yet. Run private strict compile and affected meaningful tests, then send one complete repair REPORT. No full project test compilation while the recovery writer is editing its test file, no packaging/install/live/model campaign, no prototype or routine coordinator freshness wait. Selected OpenRouter model/settings and disjoint scopes remain unchanged. Existing valid concurrency/acceptance/aggregation behavior is credited and should be preserved.
