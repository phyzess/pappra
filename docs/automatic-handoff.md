# Automatic handoff

Automatic handoff moves a coordinator role to a fresh Pi session when the current
session's context fills up. `pappra/automatic-handoff/1` pins the context threshold,
workspace root, checkpoint objective and acceptance criteria, bundle ID, next action and
an existing session-transition request. The document drives the sequence; it never
derives execution authority from prose.

## How a tick runs

`tickAutomaticHandoff(config, runtime, dependencies)` reads the actual native context
percentage from the owned runtime:

- Below the threshold, or when usage is unavailable, nothing happens: no summary is
  captured and no input is fenced.
- At the threshold it verifies the exact current task attempt, source session, claim
  epochs and coordinator epoch, then reserves a durable capture intent. A crash or
  provider error after reservation leaves the intent reserved for reconciliation;
  restarting never repeats an ambiguous model request.
- The summary comes from native Pi compaction. It remains explicitly lossy
  (`complete: false`). When the runtime supplies its full native JSONL file, capture
  verifies the session header and a stable bounded read, then retains the complete source
  under the private continuity task directory; the checkpoint records and hashes that
  artifact and marks context completeness accordingly. A foreign, unstable, redirected or
  oversized source is refused. Without complete context, the existing transfer guard
  stays in force.
- Capture then builds the checkpoint and handoff bundle and applies the guarded
  session-transition request. Without a matching supported transition host and prepared
  successor bootstrap, capture can complete while ownership transfer remains waiting.

## Opting in

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

`session plan` is read-only. `session start` requires a visible TTY and a fresh session
ID. The SDK runtime wires the watcher: native settled events and registered task updates
drive it, with single-flight reconciliation and no model polling. Its own journal writes
cannot create an event loop. Readiness can independently pin `assignmentFile`,
`templateFile` and `cardFile`; actual settled observations publish the standard
capability card without hand-editing the assignment.

## Continuous owned succession

The SDK checks native compaction eligibility before reserving the summary call or fencing
input. A short native branch waits for more history instead of fencing a session that Pi
cannot compact. After compaction, the source publishes a genuine resource observation and
writes a new immutable bootstrap admission pin; it preserves the approved launch template
and resolves an unspecified caller pane from the owned runtime.

Managed bootstrap imports the digest-verified checkpoint and artifacts as a native custom
message without starting a model. It registers the correlated receiver ACK, waits for
actual claim and route transfer, binds the new scope, and only then submits the next
action. A settled, non-aborted native assistant result registers a correlated
`running` / `handoff-first-work` REPORT: this proves the handoff's first work without
falsely completing the task.

A successor can inherit a preapproved `automaticHandoffFile`. Its config may include
`sourceReadiness: { assignmentFile, templateFile, cardFile }` with distinct absolute
paths. Once the successor's first work and the previous source's retained-transcript
retirement are verified, the owned process derives a source Assignment view from the
immutable original ASSIGN, the completed succession, exact runtime registration and
incremented claims. It changes only the current source identity and claim epochs; the
original ASSIGN path and digest remain unchanged. The next capability card is derived
from this session's own native observations.

The following generation starts only after the previous owned runtime is disposed and its
original transcript and archive copy match the receipt digest. Ambiguous capture, launch
or stop effects remain reserved for reconciliation; no native input or provider call is
blindly replayed.

## Limits

- The summary is lossy; the retained native transcript, not the summary flag, is what
  establishes checkpoint completeness.
- The transition host boundary stays in force: the SDK inventory describes its owned
  runtime, including pinned internal queues and native dialogs, and excludes arbitrary
  external writers and unowned descendants. It is not a global process stop proof.
- SDK runtime disposal returns `runtime_disposed`, never a fabricated operating-system
  exit receipt.
