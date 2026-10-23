# W7 acceptance: clearer, editable init choices

Accepted including repair R1. Original/repair delivery correlation, all pinned input/output/assignment/review digests and current 88-file manifests verified. Repair changes only CLI init and wizard tests, leaving the other 86 baseline files unchanged. Historical receiver verification is recorded at `2026-10-21T17:23:45.774Z`; the later report timestamp is not a fresh runtime observation for another assignment.

The wizard explains resolved workspace/new-versus-existing context, existing knowledge sources versus future authored-document destination, folder coverage limits, private policy and repository access. Defaults are visibly editable, malformed fields can be corrected, section Back/edit/review retains values, and advanced settings have an explicit retain/skip default. Shared host collection no longer exposes P03. Existing reconfiguration preservation and final apply gate remain intact.

Known recoverable interactive planning choice errors retain the draft for review/correction/cancel. One deliberately corrected read-only plan is retried; continuing without changing the draft returns the original failure without replanning. Stale/config conflicts stay closed. Explicit JSON/config/non-TTY/yes paths remain prompt-free.

Independent test compilation, 28 focused plan/wizard tests and type checking passed. Original flow probe now observes zero advanced prompts and an explicit skip option on the default basic route; the uncorrected binding-error flow receives a second retained review and returns failure without writes. Regressions exercise a real correction followed by plan/decline, cancellation, unchanged continue and stale conflict. Pi reports 50 init tests; this entire set was not independently repeated for the narrow repair.

Scripted UI evidence is not a real TTY integration claim. Runtime operation preview/final completion, arbitrary explicit new-path addition and integration/docs remain pending. No full-suite/package repetition was required here.

W10 integration finding: the real Clack adapter still passed text seeds only as `defaultValue`, leaving the visible input blank. The earlier scripted initial-value checks did not establish real adapter display. Visible editable prefill remains unfulfilled until the bounded W10 adapter correction and actual PTY regression pass; other accepted W7 behavior is unchanged.

Resolved in the W10 continuation: the adapter now passes `initialValue` without silently restoring cleared text. Independent actual PTY tests show fresh/existing values before input, edit them, retain Back/review edits and preserve bytes on cancel/decline. All three PTY scenarios and both mirror tests passed independently; final W10 documentation review remains separate.
