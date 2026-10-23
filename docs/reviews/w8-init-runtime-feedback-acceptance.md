# W8 acceptance: truthful runtime operation feedback

Accepted with repair R1. Original/repair correlation, input/output/assignment/review digests and all 88 current combined-manifest files verified. Repair changes only CLI description/confirmation and existing init CLI tests; execution order remains unchanged.

Preview and final confirmation now identify default self-package, explicit tarball/exact version, target user-data runtime path and machine binding, or intentional no-runtime behavior. Preview stays read-only. Completion separates applied/reused config from installed/verified/reused/bound runtime, failures/residuals and deferred knowledge/code/host work. Existing regular executable presence no longer substitutes for installer verification/reuse. Public JSON fields/schema versions remain unchanged.

Default self-package version mismatch is conditional: an existing verified workspace-target runtime can be reused before source inspection; without one, an incompatible self-package cannot install that target. Explicit requested-version mismatch remains rejected before installation. The independent original managed/offline probe now reports this conditional preview and succeeds with `reused`, `ok:true`, `initComplete:true` for target `0.0.7`.

Independent verification after repair: test compilation, type checking and 11 selected runtime/preview/version/mismatch CLI tests passed, including missing older target, explicit mismatch, corruption, residuals, no-runtime and valid reuse. Prior independent original checks passed 28 plan/wizard tests, 10 selected runtime/feedback tests and type checking. Pi reports all 18 init CLI tests after repair; they were not all independently repeated. Test operations used synthetic local packages and isolated temporary data, not real user runtime/workspace state. No full-suite/package repetition here; integration remains pending.

This accepts runtime feedback within scope. Explicit new path selection, real TTY workflow verification, cross-entry documentation and final integration checks remain outstanding. Native/three-host collaboration parity gaps remain separately documented.
