# W7 review R1: advanced opt-in and retained correction are incomplete

Verdict: unaccepted pending a focused interaction repair. Delivery/correlation, output/input/assignment/direction digests and all 88 current files verified. Source/destination copy, visible defaults, field validators, section navigation and editable selection summary are present. Independent temporary probe `/tmp/pappra-w7-flow-probe.mjs` reproduces the following gaps without writing workspace files.

Independent test compilation, all 23 plan/wizard tests and type checking passed. Existing tests omit the default advanced entry and retained correction scenarios below; passing them is not acceptance of those interactions.

## Advanced settings are still mandatory on the normal path

The section loop unconditionally executes `editSection('advanced')` after the knowledge section. Accepting each normal Continue/next initial choice asks graph, symbols, preparation, hosts and exclusions. There is no explicit skip option (`skipOption: false`). The only workaround is choosing Review early, whose hint says it skips all remaining setup rather than clearly offering optional advanced settings. This does not satisfy the pinned basic-versus-optional-advanced contract.

Add an explicit advanced entry choice: retain current settings and proceed to review by default, or edit advanced preferences deliberately. Back/Cancel remain available and current values remain intact, including edits made during a prior visit. Editing advanced from the review is explicit opt-in and should edit that section directly. Tests must run the normal/default basic route and assert no advanced field prompts, then deliberately enter/edit/revisit/skip advanced without resetting those values. Do not infer optionality solely from an earlier review shortcut.

## Recoverable plan validation exits instead of reopening the retained draft

Configure a repository with custom validation, open TTY reconfigure, deselect that repository but keep its validation, then continue from review. `runInitCommand` calls plan once and returns the failure immediately (`code: 2`, `init_validation_unbound`, only one review prompt). The user loses the editing session instead of receiving an actionable correction path. The strict binding failure is correct; exiting the editor for a fixable choice is not the specified interaction.

Keep the draft and display known recoverable choice diagnostics with an explicit return-to-review/edit or cancel action. Reopen with the same chosen values, including edits unrelated to the error; do not seed again from original config/defaults or recollect every section. Rerun read-only planning only after a deliberate correction. Use an explicit bounded classification of choice errors; stale root/config/input, ownership, unavailable/invalid source config and apply failures must still return/fail closed. Never automatically refresh context, retry writes or loop on a safety conflict. Explicit config/JSON/non-TTY/yes modes remain prompt-free and retain their failure behavior.

Add a meaningful end-to-end fake UI regression through runInitCommand: cause unbound selected command, retain draft, fix via repository or advanced editing, obtain the valid plan, decline apply and prove no writes. Also test cancel from correction and an actual stale/config conflict exiting without offering retry. No changes to validation authority or public schema.

## Remaining copy

`askHosts` still shows `P03 records only` and `Not detected or verified in P03`, including the basic-route reproduction. Remove those internal milestone references from the shared host collection prompts while preserving truthful declaration-versus-install/verification meaning. The runtime/apply completion copy remains the separately planned W8 scope.

## Scope and dispatch

Repair CLI init and related existing wizard/fixture tests only; app helper change only if demonstrably necessary. Preserve source selection/privacy/defaults, W6 identity/binding/preservation, final apply gate and accepted work. No schema/storage/discovery/runtime/collab/dependency changes or arbitrary new paths. Run focused plan/wizard tests, typecheck and these original flow probes; build/CLI tests only as needed, no redundant full suite/package. The actual same-Pi observation at `2026-10-21T17:00:32Z` may still support pre-dispatch readiness if fresh; coordinator must run the new-assignment product preflight before notification. Receiver verifies matching evidence/runtime before first edit. One proactive product REPORT, no polling/timer/native fallback.
