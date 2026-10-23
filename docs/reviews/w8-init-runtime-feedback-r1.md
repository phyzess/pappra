# W8 review R1: default-source version mismatch is not certain failure

Verdict: unaccepted pending a narrow operation-description correction. Delivery/correlation, all output/input/assignment/direction digests and all 88 current files verified. Runtime verification/reuse now uses the established installer, and preview/confirmation/completion are substantially clearer. Independent test compilation, 28 plan/wizard tests and type checking passed.

Ten independently selected runtime/preview/confirmation/failure CLI/wizard tests also passed, including isolated reuse, no-runtime, corrupt runtime/binding, residuals and cancellation. They do not cover the older-target reuse contradiction below.

## Finding

`describeInitRuntimeOperation` unconditionally states that a default self-package version differing from the workspace target will be rejected after config apply. Its confirmation also says the request will fail. The established installer first checks and verifies an existing target runtime, returning `reused` before inspecting/packing the proposed self-package source. Therefore an older workspace with a valid reusable runtime succeeds despite this preview's definite failure claim.

Independent `/tmp/pappra-w8-mismatch-probe.mjs` uses only a temporary workspace/data directory and offline synthetic local runtime tarball:

1. Install a verified runtime for workspace target `0.0.7` in the temporary data directory; create managed workspace/machine config through the normal plan/apply pipeline.
2. Preview default init from the current package `0.1.0-beta.14`.
3. Preview exits 0 but says: `the default runtime request will be rejected after config apply`.
4. Default `--apply --json` exits 0 with `ok:true`, `initComplete:true`, runtime status `reused`.

The fixture uses managed configuration creation and verified runtime reuse. No real user runtime/workspace was touched.

## Narrow repair

Keep the existing install/reuse order. Default mode should describe verifying/reusing the workspace target first, and conditionally installing from the current package only when needed and version-compatible. When source/target versions differ, explain that a verified reusable target can still succeed; if a new self-package installation is required, that source cannot satisfy the target. Neither preview nor confirmation should claim guaranteed reuse or guaranteed failure from the package version alone. Do not inspect/smoke/install during preview to decide which outcome will occur.

Preserve explicit --runtime-version mismatch semantics: installAndRecordRuntime rejects an explicitly requested version differing from workspace target before calling the installer. Do not weaken that guard or generalize the default-mode wording to it. No installer/app execution behavior change is necessary for this finding.

Change CLI operation description/confirmation and directly related existing init tests only. Regression cases: older target with verified reusable runtime (conditional preview, actual success/reused), older target without a reusable runtime (no promise of success; actual existing source validation fails), current target, explicit mismatched version remains rejected, and read-only preview leaves both workspace/runtime evidence unchanged. Use offline temporary fixtures and current public JSON fields. Preserve earlier W8 verification/failure/residual feedback and all accepted work; no schema/installer/discovery/global/dependency changes.

## Dispatch

Previous actual runtime observation is `2026-10-22T03:40:22Z` and is now expired. Obtain fresh actual same-Pi receipt/card evidence in a new temporary directory through one product request before preflighting a separate repair ASSIGN. Evidence-only request permits no source/test edits. Original visible Pi/session and proactive product messages continue; no polling/timer/native fallback.
