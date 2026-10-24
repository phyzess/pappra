# Managed Pi lifecycle integration acceptance

Date: 2026-10-24. This report supersedes the open lifecycle items in the v3
acceptance report. Existing unrelated work was preserved. No commit, publication,
credential change, global model change or machine network change was performed.

## Implemented scope

Fresh visible sessions use the controller-owned Pi SDK 1.4.0 runtime with explicit
OpenRouter `openai/gpt-6-luna`. Startup verifies the pinned SDK implementation,
publishes actual native identity to Herdr and exposes authenticated private
control. Task-scoped execution checks current assignment, attempt, coordinator,
resource claims and approval state before admitting work. A pending launch record
is discovery information, never execution authority.

Native readiness is produced after actual TUI/resource initialization, before the
first model input. Asynchronous tool registry updates publish fresh observations.
Historical Assignment approval is distinguished from a pending approval dialog;
another parallel task's input revision does not revoke a valid pinned attempt.

Automatic handoff uses native compaction, immutable handoff context, a fresh owned
successor, native import/ACK, claim transfer and actual first-work evidence.
Only then is the old SDK runtime disposed and its original transcript retained
with a digest-checked archive copy. Continuous handoff derives a bounded current
source admission from verified succession rather than rewriting the original
Assignment. Native compaction eligibility is checked before fencing the source.

Role scheduling dispatches assigned-but-undispatched work, persists intent before
effects and unlocks dependants only after coordinator acceptance. Approved repair
stops the owned old runtime, rechecks task authority after the asynchronous stop,
then advances claims and the exact approved next attempt. A known no-effect
journal-lock collision has bounded retries; ambiguous delivery is not replayed.
Watch subscriptions perform one delayed state reconciliation after rebinding,
covering an event missed while the OS attaches the subscription without periodic
model polling.

## Native evidence

Evidence paths below are local, sanitized campaign artifacts, not distributable
fixtures. The model outputs are real; coordinator acceptance checks actual files
and registered protocol evidence independently.

| Scenario | Observed result | Evidence |
| --- | --- | --- |
| Owned visible SDK control | Herdr identity, authenticated control, OS socket/foreground PID and actual OpenRouter output agree | `/private/tmp/pappra-v4-native-control.fdQoTm/acceptance.json` |
| Registered native delivery | One real registered input, native model response and duplicate suppression | `/private/tmp/pappra-v4-native-delivery.tefTBu/acceptance.json` |
| Startup readiness | Actual readiness before model input or persisted transcript; no card edits | `/private/tmp/pappra-v4-native-readiness.cWnaw8/acceptance.json` |
| Deferred first Assignment | No provider calls before admission; real registered Assignment binds and permits actual work | `/private/tmp/pappra-v4-native-handoff.4yLu0n/initial-acceptance.json` |
| Single handoff | Fresh successor writes real output; claims advance; source runtime disposes and transcript hashes match | `/private/tmp/pappra-v4-native-handoff.gwiVfF/acceptance.json` |
| Two successive automatic handoffs | Three native sessions, two successions, claim epoch 3, Task still running, original Assignment unchanged, both old transcripts retained | `/private/tmp/pappra-v4-native-handoff.YqqIw6/chain-acceptance.json` |
| Planner, parallel writers, reviewer | All four roles accepted; writer executions overlap; reviewer begins after both coordinator acceptances; one native input per role | `/private/tmp/pappra-v5-native-roles.vMJpGr/restart-acceptance.json` |
| Rejected work and approved repair | Deliberately incorrect source output rejected; source stopped once; fresh approved native attempt accepted at claim epoch 2, without readiness edits | `/private/tmp/pappra-v5-native-repair.azLzwy/acceptance.json` |
| Network failure and executor restart | Actual connection refusal before response bytes, old executor exit 86, new executor resumes the same cause/budget and actual native OpenRouter work completes | `/private/tmp/pappra-v4-network-native.Rol022/evidence.jsonl` |
| Interrupted native stream | Actual partial stream followed by worker death; new process preserves unknown outcome with zero controller calls/redeliveries | `/private/tmp/pappra-v3-native-stream-outage-v2-evidence.jsonl` |

The two-handoff harness seeds genuine initial native context so compaction is
eligible. Its `real_context_inputs: 0` field counts extra second-source diagnostic
inputs, not all inputs in the campaign.

The roles evidence calls dispatcher replacement `controller_restarted`. The old
observer was still alive while the corrected dispatcher completed the work:
this demonstrates replacement/coexistence without duplicate native inputs, not
forced termination of that old observer. Actual dead-owner restart evidence is
the separate network executor scenario.

The rejected-work campaign has a retained earlier unsuccessful probe at
`/private/tmp/pappra-v5-native-repair.rsBt2r`: asynchronous MCP startup made its
readiness observation stale, so replacement dispatch stayed closed. The final
campaign waits for genuine current readiness and passed. Failed evidence was not
overwritten.

## Verification

Final central regression passed: **930 tests, 926 passed, zero failed/cancelled,
four skipped**, in 633.8 seconds. Log:
`/private/tmp/pappra-v5-full-tests-verified.log`. Skips cover the absent-engine
branch when CodeGraph is installed, two explicitly opt-in native outage tests,
and the conditional Unix peer-PID test. Native outage and OS ownership evidence
above were exercised separately, not inferred from skipped tests.

Strict TypeScript, source-language policy, formatting and whitespace checks
passed. The six event-watcher tests passed in **24 concurrent stress runs**
(144 test executions), including deliberately suppressed new-directory events.
Logs: `/private/tmp/pappra-v5-watch-stress.gzr4G5`.

Two earlier full runs are not acceptance: the first had one stale bootstrap
fixture failure (corrected), and the second timed out in an unbounded file-watch
test. That test now suppresses the actual new-directory callback to verify the
bounded reconciliation, and has an explicit deadline.

Final package verification passed with **412 files**, including installed ESM/API
and bundled recovery/transition exports, durable self-install without a checkout,
owned cleanup with edited-file/user-content preservation, isolated workspace
init/doctor/checkpoint/resume with spaces and Unicode, and a selected-project
walkthrough that verifies the real repository remains unchanged. Log:
`/private/tmp/pappra-v5-package-final.log`.

## Operational boundaries

- `runtime_disposed` proves the owned SDK executor stopped. Receipts explicitly
  retain `process_exit: not_owned`; they do not prove arbitrary process-tree exit.
- Archive means immutable digest-checked transcript retention. Native Pi history
  remains in place; the installed SDK exposes no native history archive API.
- Recovery proves an owned per-request route failure and executor process restart,
  not machine-wide airplane mode. Unknown admitted effects remain closed for
  reconciliation rather than receiving an automatic second execution.
- Role structure, resource scopes, approvals, budgets and native identities are
  explicit. Models do not invent approval or grant themselves coordinator rights.
- An old implementation worker's pane and control endpoint disappeared before
  cleanup could prove current ownership. Cleanup sent no signal to its former
  PID. This is not a verified SDK-disposal receipt for that legacy worker.
- The original two long sessions' OpenRouter connection-error cause remains
  unverified, as described in the v3 investigation. Later coordinator aborts are
  not evidence of spontaneous Pi crashes.
