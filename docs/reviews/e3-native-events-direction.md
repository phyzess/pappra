# E3 native event facts and source-policy closure

Corrected STATUS `msg-e3-native-loader-r1-status`, digest `sha256:8e7ef4c4e45c406184c730b593882c108139dd1981569039902be990739f17ca`, its ten outputs and nested card evidence were verified. The wrapper really imports the privately compiled accepted source and calls `registerPiRolloverFreeze` during `session_start`; the marker records the real controller and commands. Accept only actual-module loading, registration and initial conservative status. No actual tool callback was exercised. `getContextUsage()` returned `{tokens:0, contextWindow:1000000, percent:0}` in this fixture; this is a host-specific observed signal, not validated automation policy. The earlier dummy probe remains generic-loader evidence only.

The HMAC/origin proposal remains withdrawn. Unknown queue/global approval facts remain unknown. Do not turn the present bounded evidence into a universal impossibility claim about future host adapters or owned controllers.

## Exact writer scope

1. New `src/hosts/integration/pi-native-events.ts`.
2. New `tests/hosts/pi-native-events.test.ts`.
3. Existing `src/hosts/integration/pi-rollover-extension.ts`: **one comment wording change only**, replacing the prose `snapshot: any omitted` so source policy no longer matches it. All executable code and the accepted freeze test stay unchanged.

## Native event producer

Implement the proposed small in-process event-fact capture module against the pinned installed Pi 1.3.0 docs/examples. Subscribe only to supported `session_start`, `before_agent_start`, `agent_settled`, `tool_execution_start`, `tool_execution_end`. Keep a structural host interface; no SDK/dependency addition or launch/install/export/default lifecycle wiring. It produces observations and invalidation notifications, not authority, external control or a stop proof. Do not call the accepted controller's `observe()`.

Use exact native session identity from callback context. Unknown, throwing or malformed session/idle observations stay unknown and invalidate confidence; never coerce them to idle/settled. At initial or late registration, settled/tool completeness is unknown. An observed settled boundary can record settled while still retaining other unknowns. Session change clears old session facts and tracked IDs, but **does not reset the producer's monotonic sequence**. Bump sequence for every subscribed callback, including malformed events and changes; prevent overflow from creating a replayable sequence.

Track tools by bounded `toolCallId` set, including nested IDs, rather than a clamped +/- counter. Duplicate starts, unmatched ends, missing/malformed IDs, oversized IDs, tracking overflow, and incomplete observation history must not produce a falsely complete zero. A local observed count may be reported separately from complete in-flight knowledge; if completeness is not established, expose it as unknown. Do not infer queue depth, global approvals, external/background process completion, writer fencing or native stop from balanced events. Keep queue and approvals explicitly unknown, and include an explicit non-authority limitation. Avoid retaining tool arguments, results, prompts or the full host context.

Return immutable/copy snapshots. Listener mutation, exceptions or reentrancy must not corrupt producer state or prevent subsequent listeners from receiving invalidation. Keep the implementation small and bounded, with no timer, watcher, filesystem, process, transcript, network, controller or rollover imports. Restart loses in-memory facts; say so. No thaw or transfer behavior.

## Verification and report

Test actual registered callback invocations with host-shaped contexts, not direct caller-supplied fact JSON: event ordering, session drift, strictly monotonic sequence across session changes, late/unknown state, keyed concurrent/nested tools, duplicates/unmatched/overflow/malformed IDs, throwing/missing context methods, immutable snapshots and listener isolation. Queue/approvals and stop authority remain unknown/false in every case. No tests that merely repeat implementation constants.

Use private compiler/test output. Run focused new-module tests and accepted freeze regressions once, source-policy check and scoped format/type checks. Verify executable freeze code and its test hash unchanged except the exact comment. The prior cumulative stage is immutable and predates these new files; do not attribute its passes/package to this addition. Report source/API/command/output hashes, actual counts and limits proactively. No shared build, full-suite rerun, package/host install, real native fixture/prompt, model/settings change, hidden worker, poll, transfer/archive, commit or publication.
