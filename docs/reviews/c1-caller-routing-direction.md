# C1 caller routing: evidence review and implementation direction

Decision: accept the report's observed Herdr semantics and missing sender-binding diagnosis as planning evidence. Revise the proposed mandatory ancestry design: it does not support this coordinator's actual execution surface.

## Verified evidence

REPORT `msg-c1-caller-routing-report` SHA-256 `b391afc81fa1ba05befb5673d1a07cd14c949ebadc996534cda279820d53e32e`, identity/correlation, assignment/input and all output digests were independently verified. All 18 source-manifest files are unchanged.

The Pi probe demonstrates its own pane shell and foreground process in its ancestry. However, the coordinator's independent probe runs through Node -> Nu -> Codex daemon -> Codex daemon -> launchd. Neither pane shell 69631 nor foreground Codex 21194 occurs in that chain. Fresh `herdr pane process-info --pane w3:p1` still reports those pane processes. Evidence: `/private/tmp/pappra-pi-batch-1-1792543809003/c1-caller-routing/coordinator-ancestry.json`; driver `/tmp/pappra-c1-review.mjs`.

Therefore a pane ancestry match can corroborate an attached local caller, but absence cannot distinguish an unrelated process from an authorized hosted/detached caller. Do not implement mandatory ancestry as the only recovery route, or claim it fixes the current workflow. Current Herdr context is client supplied; resolution is routing observation, not authenticated sender/process identity.

## Approved C1 implementation scope

Add explicit `--caller-pane <id>` to `collab message notify`, with two accurately described routing modes:

1. Default current-context mode: require the Herdr marker and a nonempty inherited pane ID before `--current`, so missing context cannot resolve through focus. Resolve current context and cross-check its supplied IDs. Fail visibly on stale/unavailable context. Never discover or automatically choose another pane.
2. Explicit task-bound mode: the operator supplies `--caller-pane` intentionally. Use `pane current --pane <id>` without changing the environment or using focus. Stale inherited IDs do not override this explicit selector. The supplied pane is a routing candidate, not proof of process ancestry or native ownership.

In both modes validate both participants against the binding, registered message and live Herdr observations before any delivery reservation or prompt:

- The binding must contain the message sender as well as recipient. Sender binding harness and any explicit native session must match the message's sender identity.
- The selected sender pane must equal the sender binding pane. The unique live sender agent name, pane, harness and cwd must match the binding. Preserve exact native-session comparison when live evidence exists; a different session refuses. Missing session remains explicitly unknown, including this Codex coordinator.
- Keep the current recipient checks, namespace revalidation, reservation/unknown handling and pointer-only transport. No execution or authority transition is added by selecting a route.
- Return and persist additive optional caller-routing evidence: selected mode/source, pane and observed harness/cwd, observation time, native-session match/unknown. State plainly that process affiliation was not established. Older delivery records must remain readable.

The explicit route operates within the existing authorized, same-user, task-bound messaging workflow. It is not sender authentication: the task-local binding and client context are editable by that user. Notify relays an already registered immutable pointer; protocol admission, message acceptance, execution ownership and receiver validation remain independent. Do not imply that selecting a pane authorizes source work or acquires cancellation authority. Do not invent an authenticated caller claim to make the route seem stronger.

## Limits

- No remote selector, remote-server adoption, routing registry, automatic pane discovery, environment spoofing, focus fallback, new pane/agent, process adoption, polling or automatic retry.
- Do not add a process-table scanner for this slice. Document ancestry as corroborating evidence with the actual hosted-daemon limitation. A future stronger caller proof can be additive without excluding supported hosted agents.
- No source changes outside routing, CLI/schema, focused tests and shipped guidance. Preserve the earlier reliability patch. Use the same Pi session and epoch-1 claims, with fresh receiving-runtime evidence/preflight before source writes.

## Acceptance

- Missing inherited pane context refuses before any live focused resolution; stale default context gives an explicit recovery hint.
- Explicit matching pane works with stale inherited IDs and an unknown native session, while reporting task-bound routing and unknown process affiliation honestly.
- Explicit foreign pane, missing sender binding, sender name/harness/cwd/pane mismatch, and reported sender-session mismatch all refuse before delivery writes or prompt. An explicit binding's null session never disables comparison with an explicit message session when live evidence exists.
- Plan-only does not query Herdr or write. Supported option combinations and pane-ID validation are strict; `--caller-pane` is notify-only. Existing idempotency, bounded retry and ambiguous transport tests stay passing.
- Update CLI help, product docs and both skill mirrors with current/direct/explicit routing, hosted-agent limitations and proactive message-only coordination.
- Compile, type-check, run meaningful focused/regression tests and package checks for the shipped route. Report a fixed-file manifest and pinned input revision.
- Following independent review, the coordinator will perform one real product notification using `--caller-pane w3:p1` to the same Pi participant. Pi's proactive correlated reply will establish the reverse route without a native bootstrap fallback; no test should send an extra model prompt before that review.
