# C6 explicit task recovery acceptance

Decision: accept the scoped recovery inspection, recorded reconciliation and explicit task-lock recovery entry after the outcome-reporting correction.

- REPORT `msg-c6-recovery-repair-r1-report`, notification SHA-256 `92d6cdb409a0e3b221c01dbc4156b49749958b93caa553002ddda05998139151`: native/task correlation, pinned assignment/input and all output digests verified.
- All 47 current manifest entries match `sha256:715b1b534aebf5d3ece97e9d75a1fca92aadc9b8e28c9710591318c8c8cc9749`.
- Independent type checking and 35 focused C4-C6 tests passed. Runtime rebuilt/test sources recompiled; broader collaboration/CLI/MCP/skill-mirror/task-pin selection passed 152 tests, 0 failures.
- Independent reproduction confirms human reconcile preview says nothing was written and leaves uncertainty unresolved. Injected ledger EIO after record commit returns `reconcile_uncertain`, explicitly directing inspection before retry, while the committed record remains visible. Driver `/tmp/pappra-c6-repros.mjs`; evidence root `/private/tmp/pappra-c6-review-DREfjF`.
- Known epoch/revision/transition/approval refusals remain distinct. Source review confirms explicit state transitions share the resolution transaction and refused transitions do not commit a resolution first. No automatic rollback/retry or additional journal was introduced.
- The matching repair preflight is ready at `2026-10-21T04:21:57.552Z` with actual fresh same-session receipt/card, reported persisted before source editing. The original C4 late-check deviation remains documented separately.
- The earlier excluded reliability patch still passes reverse-apply checking and remains separately unaccepted. Pi's additional full-suite/package/source-policy results are attributed to Pi, not an independent rerun.

All recovery probes used fresh fixture domains; no live task lock, execution or claim was recovered. Lock fingerprints/operator assertions and path checks are cooperative recovery mechanisms, not authenticated native stop proof or OS fencing. Portable pointer bindings and native lifecycle/installed-workflow verification remain open before downstream init/knowledge work resumes.
