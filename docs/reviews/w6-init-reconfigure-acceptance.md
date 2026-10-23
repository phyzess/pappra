# W6 acceptance: prefilled, lossless reconfiguration

Accepted with repair R1. Original and repair correlation/output/input/assignment/review digests and current 88-file manifests were independently verified. The repair changes only app init binding and init plan regression tests; the remaining 86 files match its baseline.

Existing valid workspaces now open prefilled reconfiguration. Current represented selections drive reconfigure print-choices/yes rather than fresh defaults. Workspace identity, extensions/continuity, custom validation IDs/arguments and local machine settings are preserved; explicit host edits produce a managed machine change. Configured unavailable knowledge sources remain explicit retained selections. Conflicting workspace identity and selected unbound configured validations fail rather than silently dropping data.

The independent original two-checkout reproduction now fails with `init_validation_unbound` when a different checkout reuses a removed checkout's ID. Source review and regressions cover legitimate original-checkout rename and reordered/swapped final IDs. The known original repository identity is authoritative before mapping its final ID.

Independent original checks: all 41 init plan/wizard/CLI/apply tests and type checking passed. After repair: test compilation, 20 focused plan/wizard tests, type checking and original binding probe passed. Pi additionally reports 42 full init tests; that entire set was not independently repeated for the two-file repair. No validation commands or real workspace changes were executed. Actual fresh receiver/coordinator/receiver-readiness records are pinned separately.

This accepts prefilled reconfiguration and preservation, not the whole UX workstream. Explicit arbitrary new-path addition, field-local validation, grouping/navigation/basic-versus-advanced, runtime preview/completion and real TTY integration remain open.
