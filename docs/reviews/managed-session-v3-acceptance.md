# Managed session continuation acceptance

Date: 2026-10-24. The previous v2 campaign is baseline evidence only. Existing
dirty work was retained; no commits, publishing, credential changes, guardrail
changes or machine network changes were performed.

## Interruption investigation

The repair and outage workers recorded OpenRouter Luna connection errors near
01:48 UTC after successful tool turns. Their later exits were coordinator-issued
abort/Ctrl+D operations, not observed Pi crashes. Native transcripts and file
effects survived. A recovery attempt with OpenRouter `openai/gpt-6.1-sol` was
explicitly rejected by the workspace guardrail (404); its smaller context also
made automatic compaction necessary for one transcript. No work was submitted
through the briefly selected OpenAI-Codex provider. Both original session files
were restored with explicit OpenRouter Luna. Tool calls resumed, then connection
errors recurred, so retries were stopped and local integration continued in the
coordinator. The original connection failure's underlying cause is unverified.

## Implemented and verified boundaries

- Fresh bootstrap can explicitly pin an OpenRouter model, and rejects mismatched
  native start receipts before routing the successor.
- Managed SDK startup binds live session/cwd to task, attempt, owner and claim
  epochs before TUI input. Registration rechecks current authority and claims.
- Live scoped version 2 transition proof/receipts retain legacy separation and
  existing successor ACK, transfer, first-work and retirement gates.
- Source retirement disposes only the owned SDK runtime and retains an immutable
  identity-checked transcript copy; native history remains unchanged.
- Approved role repair requires an exact next Assignment artifact, trusted native
  stop, sequential attempt, protocol registration and scoped claim transfer. Two
  real orchestration ticks preserve original budgets and recover next execution
  pins without requiring manual request-file replacement. Missing readiness still
  blocks dispatch.
- Evaluation distinguishes a writer's own rejected decision from its reviewer's
  dependency blocker. Rejection validates current coordinator/report/input pins.
- Private stop control verifies task registration, authenticated socket and actual
  OS peer PID. An ambiguous admitted stop is not reissued after restart. Python
  startup has a bounded ten-second ceiling to accommodate the configured shim.

## Native controlled-runtime evidence

The integrator created a new visible SDK TUI in owned pane `w3:pT`, using pinned
Pi 1.4.0, OpenRouter `openai/gpt-6-luna`, normal daily resources and default `max`
thinking. No model prompt was sent. Native session:
`c7fa69d1-fdf9-46ac-86fc-22fcb5341a53`.

The real CLI bound the task and registered its own runtime before TUI input.
An authenticated snapshot matched that exact task scope. A read-only OS socket
query matched the registered host PID. The real repair stop adapter returned one
confirmed scoped runtime-disposal receipt, then reused the same durable receipt
on duplicate invocation. External pane observation subsequently showed only the
shell in the foreground. The receipt itself still correctly claims
`process_exit: not_owned`, rather than asserting host-process ownership.

Sanitized evidence:
`/private/tmp/pappra-v3-managed-bind.QQyyMr/acceptance.json`. The earlier startup
refusal probe also confirmed pre-TUI callback execution, owned runtime disposal
and zero provider runs: `/private/tmp/pappra-v3-startup-probe.log`.

## Native provider interruption and restart

The final corrected probe passed in 7.3 seconds:
`/private/tmp/pappra-v3-native-stream-outage-v2-evidence.jsonl`. Fresh visible
session `01a16bc2-df55-732a-b199-d933a119ef5e` admitted one OpenRouter Luna
stream, observed a two-byte text delta with both streaming indicators true,
aborted its owned stream and exited the worker with code 86. A distinct restart
process recovered `unknown`, with zero controller calls and zero redeliveries.
This proves the client-induced native-stream interruption/ambiguous recovery
case, not a machine-wide network outage or automatic replay of an unknown effect.

A separate fresh normal-prompt control succeeded through OpenRouter Luna in about
eight seconds (`/private/tmp/pappra-v3-fresh-prompt.dV9c0k/result.json`). The original
long worker sessions' connection-error cause remains unverified.

The actual opt-in probe ran twice in owned visible pane `w3:pS`. Its response
witness timed out at 25 seconds, then at 90 seconds. The second attempt eventually
observed HTTP 200 and 25 bytes while both native streaming indicators were false.
That late response is insufficient to prove interruption of an active stream.
The parent failed before its restart phase. The retained evidence explicitly
ends with `acceptance_passed: false`:
`/private/tmp/pappra-v3-native-outage-evidence.jsonl`.

The probe had incorrectly treated a potentially asynchronous stream factory as
a synchronous iterator. It now awaits that factory, rejects late response
witnesses, leaves native transport unchanged by default, forwards cancellation
into an optional per-request fetch, disposes unsuccessful runtimes, surfaces early
termination and preserves failed observations. Existing loopback tests separately
cover known-no-effect retry; ambiguous admitted effects are not replayed.

## Central checks

Full regression: 886 tests, 884 passed, zero failed/cancelled, two skipped,
635.5 seconds. Installed package smoke passed with 388 files, including isolated
workspace lifecycle, durable runtime installation and user-content preservation.
Subsequent scope tightening and the
Python probe deadline passed ten focused tests. The final provider probe passed
separately with opt-in enabled. Strict TypeScript, source-language policy,
formatting and whitespace checks passed; final packaging rechecks the current
source build.

## Remaining work

Ordinary bootstrap still starts native Pi rather than recursively starting a
scoped SDK controller. The native SDK pane displayed Pi's TUI title, but Herdr did
not expose a recognized Pi agent/session identity; a title is not sufficient.
Managed successor launch/identity publication and repeated automatic handoffs
therefore remain open. End-to-end fresh-native repair dispatch and unattended
readiness recovery also need acceptance. Transcript retention is implemented;
the installed SDK provides no native history archive API. This report does not
declare the original lifecycle work or all parallel workstreams complete.
