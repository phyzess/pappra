# Automatic handoff events

`pappra/automatic-handoff/1` pins a context threshold, workspace, checkpoint
objective and acceptance criteria, bundle ID, next action and an existing
session-transition request. It does not derive execution authority from prose.

`tickAutomaticHandoff(config, runtime, dependencies)` reads the actual native
context percentage. Below-threshold and unavailable-usage observations do not
capture a summary. At the threshold it verifies the exact current task attempt,
source session, claim epochs and coordinator epoch before reserving a durable
capture intent. A crash or provider error after reservation requires
reconciliation; restarting never repeats an ambiguous model request.

The summary comes from native Pi compaction. It remains explicitly lossy. When
the runtime supplies its full native JSONL file, capture verifies the session
header and a stable bounded read, then retains the full source under the
private continuity task directory. The checkpoint records and hashes that
artifact. A foreign, unstable, redirected or oversized source is refused.
Without complete context, the existing transfer guard remains in force.

Fresh visible SDK sessions opt in through the managed session request:

```json
{
  "schema": "pappra/managed-pi-session-request/1",
  "runtime": "sdk",
  "cwd": "/absolute/workspace",
  "model": "openai/gpt-6-luna",
  "sdkModulePath": "/absolute/pi-1.4.0/dist/index.js",
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "journalPath": "/absolute/private-directory/native.jsonl",
  "automaticHandoffFile": "/absolute/automatic-handoff.json"
}
```

`session plan` is read-only. `session start` requires a visible TTY and a fresh
session ID. Native settled events and registered task updates drive the
watcher, with single-flight reconciliation and no model polling. Its own
journal writes cannot create an event loop. Readiness can independently pin
`assignmentFile`, `templateFile` and `cardFile`; actual settled observations
publish the standard capability card without hand-editing the assignment.

This integration deliberately retains the session-transition host boundary:
the SDK inventory describes its owned runtime, including pinned internal
queues and native dialogs, and excludes arbitrary external writers and
unowned descendants. It is not a global process stop proof. Without a matching
supported transition host and prepared successor bootstrap, automatic capture
can complete while ownership transfer remains waiting. SDK runtime disposal
returns `runtime_disposed`, never a fabricated operating-system exit receipt.

## Continuous owned succession

The SDK checks native compaction eligibility before reserving the summary call or fencing input. A short native branch waits for more history instead of fencing a session that Pi cannot compact. After compaction, the source publishes a genuine resource observation and creates a new immutable bootstrap admission pin; it preserves the approved launch template and resolves an unspecified caller pane from the owned runtime.

Managed bootstrap imports the digest-verified checkpoint and artifacts as a native custom message without starting a model. It registers the correlated receiver ACK, waits for actual claim/route transfer, binds the new scope and then submits the next action. A settled, non-aborted native assistant result registers a correlated `running` / `handoff-first-work` REPORT. This proves the handoff's first work without falsely completing the task.

A successor can inherit a preapproved `automaticHandoffFile`. Its config may include `sourceReadiness: { assignmentFile, templateFile, cardFile }`, with distinct absolute paths in private real directories. Once its first work and the previous source's retained-transcript retirement are verified, the owned process derives a source Assignment view from the immutable original ASSIGN, completed succession, exact runtime registration and incremented claims. It changes only the current source identity and claim epochs; the original ASSIGN path/digest remains unchanged. The next capability card is derived from this session's own native observations.

The following generation starts only after the previous owned runtime is disposed and its original transcript and archive copy match the receipt digest. Ambiguous capture, launch or stop effects remain reserved for reconciliation; no native input or provider call is blindly replayed.
