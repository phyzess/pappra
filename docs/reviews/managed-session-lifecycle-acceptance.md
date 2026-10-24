# Controller-owned native Pi lifecycle integration

The integration adds a fresh, visible native Pi TUI owned by its controller from
launch. It does not adopt an old interactive session. The public entry is
`pappra session plan|start|status|fence|stop --config <absolute-file>`; the package
exports `hosts/pi-managed`. Terminal input is durably journaled before forwarding,
the private endpoint can fence ingress, and child-stop evidence comes from the
PTY helper reaping its exact child. Normal Pi configuration remains active.

Three fresh visible OpenRouter Pi sessions implemented disjoint controller,
role-plan and recovery-test scopes. The integrator owns the public CLI, package
exports, live capability derivation and consolidated acceptance. No global
configuration, installed Pi binary or existing session was replaced. No commit
or publication was made.

## Native verification

On 2026-10-23 the integrator launched the built CLI in a fresh visible Herdr pane.
The native screen showed Pi 1.4.0, OpenRouter, `openai/gpt-6-luna`, daily `max`
thinking, and the existing extensions and skills. The managed observer was also
loaded. No model prompt was submitted. Harmless editor keystrokes exercised real
terminal ingress; the journal then recorded the ingress fence and the exact
owned-child exit. Both Pi and its helper exited with code zero, and the pane
returned to its shell.

The private evidence directory is `/private/tmp/pappra-managed-live.dO7jgT`:
`status.json`, `fence.json`, `stop.json` and `ingress.jsonl`. The native session is
`a61c840e-8f1b-44a5-a958-f4cf8a4941f9`; the observed helper/Pi PIDs were
62613/63686. These identify this observation only and are never adoption targets.
Do not expose its private control descriptor or replay journaled terminal bytes.

The same integration directly derived a schema-valid runtime card from the
completed role-plan worker's saved native session using `capabilities derive
--harness pi --live`; preflight returned `ready` without hand-editing the card.
Raw transcript observation time and content digests were retained. This snapshot
does not authenticate the writer or prove current tool registration.

## Parallel results and verification

- Role requests expand into the existing work-plan model: writers remain
  independent, review depends on their coordinator acceptance, and aggregation
  preserves rejected, unknown, missing and pending results. The CLI aggregate
  checks the saved plan against the request and reads authoritative task evidence.
- Recovery tests use real loopback TCP disconnection and distinct controller
  processes. A sent-but-unacknowledged effect remains unknown after restart and
  is never redelivered; only proven no-effect failures permit retry. This is
  controlled network fault injection, not a real OpenRouter outage.
- The integrator independently passed 24 focused capability/role/recovery/CLI
  tests and 9 final controller tests, including an actual stdlib PTY child and
  OS auto-reaping without a usable `waitpid` receipt. The latter must not invent
  a successful exit. Strict TypeScript, formatting and source-language checks pass.
- The normal full-suite runner reached its existing 360-second deadline after
  695 passes, zero failures, one optional-engine skip and 15 cancelled files.
  A bounded continuation of those files skipped completed case names and added
  the controller tests: 143 passes, zero failures, zero cancellations, one
  optional-engine skip. The retained `full-tests.log`, `resumed-tests.log` and
  continuation driver document the split campaign; duplicate literal test names
  were checked before combining coverage. The final additional missing-waitpid
  regression passed with all 9 controller tests in a separate focused run.
- Standard package verification passed installed ESM exports (including the new
  subpaths), bundled assets, opt-in host bundle smoke, durable self-install,
  managed cleanup and workspace lifecycle. Its later selected-project
  `runtime install` step timed out; the complete package gate is not accepted.
  A separate temporary staging attempt was rejected by the existing private-path
  guard because bundling was invoked from outside that staging root. Neither
  failed campaign was represented as a successful package check.
- After the missing-waitpid correction, a fresh final tarball was installed
  offline into a separate temporary consumer. The installed ESM API/asset
  consumer and installed `session plan` CLI passed. This narrower final-package
  check does not relabel the earlier runtime-install timeout as a full gate pass.

## Remaining lifecycle dependency

The managed controller proves ownership and exit of its exact child. Complete
native queued payloads, approval state, in-flight work, arbitrary descendants
and external writers remain unknown. `transferReady` therefore remains false.
The existing session-transition and resource-transfer guards remain unchanged.
Raw terminal input is evidence, not a recoverable semantic queue.

Archive support copies and verifies a stopped source transcript only after
caller-supplied receiver confirmation and first-work receipts; it retains the
original transcript and does not authenticate those receipts or perform native
session archival. Automatic context-threshold handoff, resource transfer,
successor continuation and end-to-end provider-outage recovery are unfinished.
This native ownership milestone must not be represented as their acceptance.
