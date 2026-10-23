# W6 independent review: validation command can rebind to a different checkout

Verdict: W6 remains unaccepted pending a narrow binding correction. Report/correlation, all output/input/assignment/direction digests and the 88 current combined-manifest files were verified. Prefilled editing and preservation improvements are present; readiness is independent evidence rather than acceptance.

Independent validation completed: test compilation, all 41 init plan/wizard/CLI/apply tests and type checking passed. These checks omit the identity-reuse scenario reproduced below. The dispatch snapshot predates this validation completion; its finding and repair scope are unchanged.

## High-priority finding

`findSelectedRepositoryForCandidate` in `src/app/init.ts` treats a match with either the repository's original ID or its newly selected ID as equivalent. For a configured validation candidate this allows a different checkout to reuse the removed repository's ID and inherit its commands. The new strict unbound-validation guard is bypassed because that incorrect binding is considered resolved.

Independent reproduction `/tmp/pappra-w6-binding-probe.mjs`, using only a temporary workspace:

1. Configure checkouts `a` (ID `a`) and `b` (ID `b`), with custom validation `check-a`, repositoryId `a`, executable `a-specific-check`, args `["--only-a"]`.
2. Convert existing configuration to choices, retain `workspace-config:check-a`, remove checkout `a`, and select only checkout `b` with new ID `a`.
3. Plan reconfiguration. Actual result is `ok: true`, repository `{id:"a",path:"b"}`, validation `{id:"check-a",repositoryId:"a",executable:"a-specific-check",args:["--only-a"]}`.

The selected original command lost its checkout and should fail with an actionable unbound diagnostic. Instead the plan authorizes its declaration against another checkout. No command was executed and the temporary source tree remained byte-identical during this reproduction.

Bind configured validation candidates to their original discovered/configured repository identity, then translate to that same selected checkout's final ID. Never let a different checkout's newly chosen ID satisfy the original binding. Keep intentional ID renaming of the same checkout functional. Avoid order-dependent behavior when selected repositories swap IDs or are reordered. Existing candidate working-directory evidence must not override a known configured repository identity and accidentally rebind it.

Limit the repair to app init binding and directly related init plan regression tests, with any needed existing CLI regression only if necessary. Test removed-original/ID-reuse failure, a retained-original rename, and reordered/swapped-ID selections retaining original checkout bindings. Preserve custom executable/args/validation IDs, new-candidate allocation, prior W6 preservation and all accepted changes. Do not change schema, execute validations, broaden discovery or redesign the planner.

## Next dispatch

The actual receiver card is based on the `2026-10-21T16:13:49Z` observation and is now expired under the existing 30-minute rule. Refresh actual same-session tool/cwd/pane/configuration evidence in a new temporary directory through one product request before coordinator preflights the new repair assignment. Preserve historical bytes/times. The evidence-only request authorizes no source/test edits. Continue the original visible Pi/message route; no completion polling/timer/native fallback.
