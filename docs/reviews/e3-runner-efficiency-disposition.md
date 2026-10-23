# Runner investigation disposition

Accept the decision to defer scheduler changes and collect file/test identities and timing during the next already-planned integration run. No extra suite, custom process pool, timeout change or source edit is assigned. The existing suite status remains 541 passes, one skip and 11 cancelled file entries, followed by a separate 139-pass rerun; neither the totals nor repeated partial-file cases establish a single clean run.

Corrected STATUS `msg-e3-runner-efficiency-r1-status`, delivery `sha256:15471ef57f489e2ce7c05ff33ea0d9af148b6adb88acb996e2b4bfc469ed8355`: six output pins and reply/session/epoch correlation verified. The correction appropriately withdraws predicted speedups, arbitrary adoption thresholds and additive batch counts. Sixteen dynamic test titles remain unattributed; source-title matching is incomplete evidence, not canonical test identity.

Two residual statements are explicitly not accepted:

1. “No native sharding” is false for the installed Node runtime: local `node --help` advertises `--test-shard=...`. Sharding exists; it is distinct from persistent resume and has not been measured or selected as the solution here. Do not carry the negative capability claim forward.
2. A single file taking approximately 342 seconds does not show that the other 61 files have only the remaining 18 seconds; four workers overlap. It establishes a long per-file critical path under that workload, while complete schedule/occupancy remains unknown. Do not present this as a standalone impossibility proof.

Direct aggregate-timeout evidence remains valid. Duration comparisons are consistent with workload-dependent slowdown, without uniquely proving contention or excluding other causes. The next integration run should use supported native reporter output to capture actual file/test identities and durations without changing concurrency. Preserve finite bounds and record incomplete work honestly if the deadline is reached. Defer performance choices until those observations exist. Session handoff remains the primary implementation dependency; the native-event producer is still under separate review.
