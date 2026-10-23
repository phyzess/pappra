# Visible collaboration workflow

Choose the collaboration channel before preparing a task, and keep the two
environment choices distinct from the work itself: a channel decides where a
participant runs and how messages reach it. It never grants permissions,
capabilities, ownership, or task success. Existing guidance starts after
participants exist; this reference covers the entry path from a new authorized
request to a bound, ready receiving instance.

## 1. Detect the environment, not the installed tools

Inspect only the non-sensitive Herdr markers and caller IDs, for example:

```nu
$env.HERDR_ENV? == '1'
```

- **False or absent** — use **direct mode**: keep the current session as
  coordinator and use the host's own supported tools. Do not query a Herdr
  server, inspect its focus, split panes, or open a terminal merely because a
  `herdr` binary is installed. A binary, an open window, or an old pane ID in a
  task record proves no caller affiliation. Do not print the process
  environment.
- **True** — you are inside a Herdr caller. Read that installation's own
  `herdr --skill` and the relevant `--help` before acting (pane ids and flags
  are version-sensitive), then resolve the current caller, for example
  `herdr pane current --current`. If the claim cannot be resolved
  unambiguously, record **herdr unavailable** with the reason and fall back to
  direct mode only when the user's instructions allow it.
- The UI-focused pane is never a fallback. Do not spoof `HERDR_*` values.
- If the task requires visible delivery and it is unavailable, report the
  blocker. Do not start a hidden duplicate of the required participant.

`pappra collab message notify` supports two caller routes. The default requires
the inherited Herdr context; `--caller-pane <id>` names the sender pane
explicitly for hosted or stale inherited contexts. Either way the pane is
routing evidence, not process authentication, and recorded delivery evidence
stays `process_affiliation: "not-established"`.

## 2. Decide participants and bootstrap the receiving instance

Pick participants, roles, harness, and configuration from the task rather than a
fixed agent count. Everyone can implement, review, or verify; assign by need.

Reuse an existing peer only when all of the following match what the task will
bind: current agent name, pane, harness, cwd, native session (where the host
reports one), and the capabilities the assignment will require. Otherwise, when
a new visible participant is authorized, create a **sibling** shell pane with
the task's cwd and the installed layout/`--no-focus` options you verified above,
start the intended interactive agent there, and keep the user's focus unchanged.
Do not add worktrees, workspaces, or tabs just to get a pane, and never take over
an arbitrary idle pane.

### One-time bounded discovery contact

A newly started interactive instance has not told you its identity yet. Before
any task preparation that depends on it, make exactly **one** bounded,
read-only discovery contact through the installed visible tool (for example the
installed `herdr agent prompt` command; confirm its syntax from
`herdr --help`/`--skill`). Ask only for:

- the agent/host name and harness actually running;
- the exact native session identity the host accepts (or an explicit "unknown"
  when the host cannot report one);
- the actual cwd and configuration/model in use;
- where the instance can leave a bounded native evidence file (for example a Pi
  session JSONL path) if that evidence route exists.

State explicitly in that contact that it is a read-only identity handshake: do
not start implementation, do not answer approvals, do not change settings, and
reply with the identity packet only. This contact is **bootstrap**, not a
product notification and not an ASSIGN. It must be clearly separate from normal
`COLLAB_MESSAGE` delivery, which needs a binding that does not exist yet.

If that first contact route is unavailable (direct mode without a visible
channel, missing host capability, refused prompt), report the concrete blocker.
Do not fabricate a runtime card, assume a session identity, or launch an owned
child as a stand-in for the visible participant.

Starting and contacting the interactive instance is not a readiness check and
not permission to dispatch source work. Do not send an implementation prompt at
this point, and do not substitute the isolated pilot launcher or bypass host
approvals. Preserve the daily native model, tools, MCP, hooks, and permission
settings.

## 3. Bind routing metadata

Record the observed routing identity in the existing task-local binding
`pappra/collab-binding/1`. Use the discovered values; use JSON `null` (not a
quoted string) only when the host genuinely cannot report a native session. A
null/unknown worker session can be recorded for routing, but it cannot be bound
to an admitted work assignment: the goal schema requires an exact assignee
session, so report the identity blocker instead of preparing work for an
unknown instance.

```json
{
  "schema": "pappra/collab-binding/1",
  "task_id": "<task-id>",
  "task_root": "/absolute/domain/tasks/<task-id>",
  "channel": "herdr",
  "participants": [
    {
      "agent_id": "<coordinator-agent>",
      "harness": "<codex|pi|claude>",
      "cwd": "/absolute/coordinator/cwd",
      "herdr_agent": "<named-coordinator-agent>",
      "pane_id": "<wN:pN>",
      "native_session_id": "<exact-coordinator-session>"
    },
    {
      "agent_id": "<worker-agent>",
      "harness": "<codex|pi|claude>",
      "cwd": "/absolute/receiving/cwd",
      "herdr_agent": "<named-worker-agent>",
      "pane_id": "<wN:pN>",
      "native_session_id": "<exact-worker-session-or-null>"
    }
  ]
}
```

Placeholders such as `<task-id>` and `<exact-worker-session>` are literal
substitution points, not values. A pane ID is not a native session ID, and this
binding is routing metadata, not a second ownership store and not proof that a
native session exists. Revalidate it before later sends, resume, or handoff.

## 4. Prepare the task and admit the new assignment

`pappra collab prepare` is **not** a preview command: it has no plan/apply mode.
With explicit operator/agent authorization it writes the private task record and
prepared files, claims the listed resources, and registers the initial
`ASSIGN`. Do not run it expecting a dry run, and do not treat the message-level
`send`/`notify` plan behavior as applying to preparation. Resource, message,
binding, handoff, and recovery commands are the ones with plan/apply modes; see
`references/collaboration.md`.

```sh
# Mutates task/prepared state and claims. Requires explicit authorization.
pappra collab prepare \
  --goal /abs/example/goal.json \
  --domain-root /abs/example/domain
```

Preparation creates no declared capability template or card. If you need a
derivation template, write one yourself from the assignment's expected
capabilities and mark it clearly as declared, for example:

```json
{
  "schema": "harness-collab/capabilities/1",
  "agent_id": "<worker-agent>",
  "session_id": "<exact-worker-session-or-null>",
  "harness": "<pi|codex|claude>",
  "surface": "cli",
  "configuration_id": "<observed-configuration>",
  "cwd": "/absolute/receiving/cwd",
  "observed_at": "<ISO time from actual evidence>",
  "evidence_level": "declared",
  "skills": [],
  "tools": [{ "id": "<expected-tool>", "state": "declared" }]
}
```

A declared template is not evidence and cannot authorize a launch. Derive a
runtime card from evidence the receiving instance actually produced (native
session/events), and save only the returned `card`; derivation prints a result
wrapper and writes nothing:

```nu
# Literal example values: substitute the real harness and absolute paths.
let harness = "pi"
let assignment = "/abs/example/assignment.json"
let template = "/abs/example/card.declared.json"
let execution = "/abs/example/execution.json"
let session = "/abs/example/pi-session.jsonl"
let deriveArgs = [
  'collab' 'capabilities' 'derive'
  '--harness' $harness
  '--assignment' $assignment
  '--template' $template
  '--execution' $execution
  '--session' $session
  '--json'
]
let derived = (^pappra ...$deriveArgs | from json)
if $derived.status != 'derived' { error make {msg: $"derive refused: ($derived.status)"} }
$derived.card | to json | save --raw /abs/example/card.runtime.json
```

For Codex or Claude replace the session flag with the events flag accepted by
the installed command (`pappra collab capabilities derive --help`), and set
`--harness` to the participant's actual harness. `save --raw` refuses to
overwrite, so use a new path. Observation time and
freshness come from the native evidence; replaying old artifacts does not
refresh them. If the evidence route does not exist, record the blocker instead
of inventing a card, then check reported readiness:

```sh
pappra collab preflight \
  --assignment /abs/example/assignment.json \
  --capabilities /abs/example/card.runtime.json --json
```

Ready is not authorization, locking, or dispatch. A declared, stale,
mismatched, or missing-evidence card stays refused; fix the evidence or report
the gap.

## 5. Dispatch once and return a correlated result

Preparation already persisted the initial `ASSIGN`. Do not send a second ASSIGN
for the same attempt. Locate the exact registered message by its own fields
(current `task_id`, `subtask_id`, `attempt`, `owner_epoch`, recipient, and input
revision) and read it back through the product:

```nu
# Literal example paths: replace them with the actual prepared file and values.
let prepared = (open /abs/example-domain/tasks/example-task/p10/prepared.json)
let record = (open ($prepared.task_root + "/task.json"))
let assignEntries = ($record.messages | where { |m| $m.type == "ASSIGN" and $m.subtask_id == $prepared.subtask_id and $m.attempt == $prepared.attempt and $m.to.agent_id == "worker-agent" and $m.to.session_id == "worker-session" })
if ($assignEntries | length) != 1 { error make {msg: "expected exactly one prepared ASSIGN for this attempt"} }
let registered = (pappra collab message read --task-root $prepared.task_root --message-id $assignEntries.0.message_id --json | from json)
if $registered.message.body.input_revision != $prepared.prompt_digest { error make {msg: "prepared ASSIGN input mismatch"} }
if $registered.message.body.assignment_digest != $prepared.assignment_digest { error make {msg: "prepared ASSIGN digest mismatch"} }
```

`message read` returns the full envelope and its recorded/applied state. Send
additional `message send --apply` envelopes only for a genuinely new bounded
assignment (for example a later attempt) or a message that is not already
persisted. Then send exactly one pointer-only notification for that registered
message:

```sh
# Literal example values: substitute the real task root, message id, binding and pane.
pappra collab message notify --task-root /abs/example/domain/tasks/example-task \
  --message-id msg-example-assign \
  --binding /abs/example/binding.json --caller-pane w9:p1 --apply
```

Never loop notifications, never use `--wait`, and never treat `submitted` as
consumption or acceptance.

The receiving instance verifies the pointer digest and **its own** exact
identity before working: its `to.agent_id`/`to.session_id` must match the
envelope, and the task/subtask/attempt/owner epoch/input revision must match its
prepared state. It then records a correlated `ACK` (one envelope, registered
with `--apply`), does admitted work, and persists one `REPORT`, `BLOCK`, or
`STATUS` followed by one product notification to the coordinator.

Minimal correlated envelopes (placeholders are substitution points; keep
`content_digest: null` — registration records the real digest):

```json
{
  "schema": "harness-collab/message/1",
  "message_id": "msg-<unique>-ack",
  "type": "ACK",
  "task_id": "<task-id>",
  "from": {
    "agent_id": "<worker-agent>",
    "session_id": "<exact-worker-session>",
    "harness": "<harness>"
  },
  "to": {
    "agent_id": "<coordinator-agent>",
    "session_id": "<exact-coordinator-session>",
    "harness": "<harness>"
  },
  "reply_to": "<assign-message-id>",
  "subtask_id": "<subtask-id>",
  "attempt": 1,
  "owner_epoch": 1,
  "created_at": "<ISO-8601>",
  "content_digest": null,
  "body": {}
}
```

```json
{
  "schema": "harness-collab/message/1",
  "message_id": "msg-<unique>-report",
  "type": "REPORT",
  "task_id": "<task-id>",
  "from": {
    "agent_id": "<worker-agent>",
    "session_id": "<exact-worker-session>",
    "harness": "<harness>"
  },
  "to": {
    "agent_id": "<coordinator-agent>",
    "session_id": "<exact-coordinator-session>",
    "harness": "<harness>"
  },
  "reply_to": "<assign-message-id>",
  "subtask_id": "<subtask-id>",
  "attempt": 1,
  "owner_epoch": 1,
  "created_at": "<ISO-8601>",
  "content_digest": null,
  "body": {
    "status": "completed",
    "outputs": [],
    "native_ref": null,
    "evidence_ref": "/absolute/evidence/report.json"
  }
}
```

The worker registers each envelope (`message send --apply`) and reads it back.
Registration may report `accepted`, `duplicate`, or a classification such as
`rejected`; check the actual status rather than assuming acceptance, and do not
resend a rejected REPORT with a new id unless the underlying evidence changed.
The worker then notifies the coordinator once with the same task-local binding
and its own `--caller-pane` where needed. The coordinator verifies the
artifacts, the exact correlation and the pinned input before deciding business
acceptance; protocol application and acceptance remain separate facts.

The owned `pappra collab run --controller pi-rpc` path remains a separate,
explicit option for an owned Pi RPC child with its own admission and evidence
limits. Do not present it as the default collaboration channel, and do not use
it to imitate a visible participant.

## 6. Yield, then verify

After sending the notification, yield. Independent work continues in the
receiving session; do not poll panes, status endpoints, or logs, do not install
completion timers, and do not re-wake yourself. An idle or finished pane is not
a result, a stopped process, or acceptance.

When the coordinator's next turn arrives, verify the reported artifacts and
inputs yourself. If a delivery or execution outcome is uncertain, inspect the
original evidence through the existing recovery surface
(`pappra collab recovery inspect`) before any explicit retry or handoff. A
fresh history client cannot adopt native control of an unknown execution, and
claimed resources stay held until the protocol permits release.

## Known limits

- `notify` does not create, start, or discover a participant. Bootstrap contact
  remains a one-time, read-only operator/agent action inside the authorized
  visible environment, separate from product notifications.
- A pane is a visibility aid: it is not authentication, native identity, or
  stop proof. Live ownership of an existing native session cannot be rebuilt
  from stored pointers.
- Herdr command shapes change between versions. Treat the examples here as
  product-side routing patterns and confirm the actual flags with the installed
  `herdr --help`/`--skill` at use time.
- Without a working visible channel, persisted messaging and the owned Pi RPC
  run may still be available, but they do not satisfy a visible-delivery
  requirement.
