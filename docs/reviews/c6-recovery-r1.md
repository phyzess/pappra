# C6 explicit recovery review — round 1

Decision: changes requested for two reproduced outcome-reporting defects. No native-control or lock-framework expansion is requested.

## Independent evidence

- REPORT `msg-c6-recovery-report`, notification SHA-256 `1ff26f28813576734ac032dd5b6b59849cd8cea60dfa424e5f9399cf1c0b39c6`: native/task correlation, assignment/input and output digests verified.
- All 47 current manifest entries match `sha256:7f8298ad157b5f32cc5be08a6a646e23839e5df90af28da4dce93c8ba6ccd0b2`.
- Independent type checking and 33 focused C4-C6 tests passed. The excluded reliability patch passes reverse-apply checking and remains separately unaccepted.
- Source review covered recovery request handling, readonly inspection/fingerprint, reconciliation transaction guards, lock archive handling and CLI output.
- Driver `/tmp/pappra-c6-repros.mjs`; fixture evidence root `/private/tmp/pappra-c6-review-Nr4xrn`. The failure probe injects ledger EIO only in its own Node process, and all record mutations occur in a fresh fixture domain. No live task/lock/claim, model or Herdr prompt is touched.

## R1 — P2: human preview reports a committed reconciliation

Without `--apply`, the installed CLI prints `Reconcile applied: resolution recorded; state transition none.` The task's uncertainty entry remains unresolved, correctly, but the text tells the operator that the recovery conclusion was committed. `emitHuman` checks the action and `ok` before distinguishing `status: planned` / `applied: false`.

Handle plans before applied/refused formatting. Say that the plan validates the request/namespace and writes nothing; do not imply semantic readiness or a committed resolution. Keep JSON and actual no-write behavior unchanged. Add installed human-output regressions for both reconcile and lock-break plans and verify unchanged bytes/mtimes.

## R2 — P2: a post-commit ledger error is classified as a generic operation failure

The transaction can rename task.json successfully before appending the ledger. Injected EIO on that append leaves `resolved_at` committed, but `applyRecovery` returns `code: recovery_operation_failed` with no explicit uncertain-effect classification. The public contract requires unknown outcomes to be distinguished; an agent must not infer that the resolution was unapplied from a generic failure and redispatch blindly.

Classify an unexpected reconcile transaction exception conservatively as an uncertain effect (for example `reconcile_uncertain`), unless the existing primitive supplies reliable pre-mutation refusal evidence. State that the resolution/state transition may already be committed; inspect record and ledger before any explicit retry. Preserve ordinary known epoch/revision/transition/lock refusals and transaction atomicity. Do not add automatic rollback, retry, reconciliation or a second journal.

Add a deterministic late-ledger-error regression that verifies the actual committed record and the uncertain diagnostic. Also cover an early unexpected failure conservatively without claiming a commit. Keep all raw injected error/body text out of user output and retain explicit uncertainty exit behavior.

## Repair scope

R1/R2 and meaningful focused regressions only; update guidance if needed for these result semantics. Same Pi session and source claims, preserve excluded files and coordinator plans/reviews. Run preflight for the new pinned repair contract before source writes, using genuinely fresh same-session capability evidence (refresh the previous observation if stale). Return a current manifest/input revision/pre-write check evidence via one product REPORT/notification. No native fallback, polling, waiting, extra agent, publication or live recovery test.
