# Collaboration messages and notification

Use this reference when a task needs task-scoped messages between two agent
sessions. Persisting a message, notifying a recipient, the recipient's ACK, its
REPORT, and the coordinator's acceptance are five different facts. This surface
keeps them separate and never infers one from another.

## MCP collaboration preparation

MCP `collab_prepare` uses the same strict `pappra/collaboration-goal/1` as the installed CLI and accepts exactly `{ domainRoot, goal }`:

```json
{
  "domainRoot": "/absolute/domain",
  "goal": {
    "schema": "pappra/collaboration-goal/1",
    "task_id": "FIJI-123456",
    "subtask_id": "implementation-slice",
    "attempt": 1,
    "phase": "implementation",
    "objective": "Prepare one bounded collaboration slice.",
    "acceptance": ["prepared references verify"],
    "prompt": "Use only the frozen prompt.",
    "roles": ["implementer"],
    "coordinator": {
      "agent_id": "pappra-coordinator",
      "session_id": "coordinator-session",
      "harness": "codex",
      "owner_epoch": 1
    },
    "assignee": {
      "agent_id": "pappra-implement",
      "session_id": "assignee-session",
      "harness": "pi",
      "surface": "cli",
      "configuration_id": "daily-herdr",
      "cwd": "/absolute/assignee/workspace"
    },
    "resources": [{ "path": "/absolute/repository", "access": "write" }],
    "required": { "skills": [], "tools": ["read"] },
    "preferred": { "skills": [], "tools": [] }
  }
}
```

The former flat `objective`/`task`/`acceptance`/`resources`/`coordinatorSession`/`assigneeSession`/`harness`/`subtaskId` arguments are rejected before task or claim writes. Migrate by moving those values under `goal` with protocol names (`task_id`, `subtask_id`, snake_case identities and requirements); explicitly supply coordinator `owner_epoch` and assignee `surface`, `configuration_id`, and independent `cwd`. Unknown or mixed legacy fields are errors. Omitted `roles` retains the documented `['implementer']` compatibility default; explicit roles are bounded, unique, and copied to the assignment.

Preparation returns the prepared bundle and goal. It does not create a synthesized declared card and does not return the removed `cardPath`/`card` outputs. Supply actual runtime evidence separately by deriving a card from the receiving session and checking it with preflight. Runner metadata maps `pi`/`codex`/`claude` to `pi-cli`/`codex-exec`/`claude-cli`, but the only real live controller here is `pi-rpc` for Pi; `fixture` remains explicit test-only behavior. `collab_start` returns `cli_required` without launching; the user must run `pappra collab run` with confirmation and admitted runtime evidence in the CLI.

## Before you start

A task root is `<domain>/tasks/<task-id>` and already contains `task.json`,
`messages/` and `ledger.jsonl`. `pappra collab prepare` creates it. All message
commands require the absolute `--task-root`; nothing is discovered from the
current directory, chat text, or another task.

## Commands

```sh
# Validate an envelope without writing anything (default is plan-only).
pappra collab message send --task-root <abs-task-root> \
  --message <abs-envelope.json> --json

# Register and apply the message through the existing protocol.
pappra collab message send --task-root <abs-task-root> \
  --message <abs-envelope.json> --apply --json

# Read one registered message and its record entry (read-only).
pappra collab message read --task-root <abs-task-root> \
  --message-id <id> --json

# List the most recent applied messages (read-only, bounded by --limit 1-100).
pappra collab message list --task-root <abs-task-root> --limit 20 --json

# Validate task, message, binding and recipient without querying Herdr.
pappra collab message notify --task-root <abs-task-root> \
  --message-id <id> --binding <abs-binding.json> --json

# Send exactly one pointer-only Herdr prompt for the registered message.
pappra collab message notify --task-root <abs-task-root> \
  --message-id <id> --binding <abs-binding.json> --apply --json
```

```sh
# Inspect or plan one writer rollover (read-only; there is no apply action).
pappra collab rollover inspect --task-root <abs-task-root> \
  --request <abs-rollover-request.json> --json
pappra collab rollover plan --task-root <abs-task-root> \
  --request <abs-rollover-request.json> --json
```

`send` never notifies and `notify` never changes the task record. A successful
`notify` means one prompt was submitted to a named Herdr agent; it does not mean
the recipient read it, consumed it, or accepted the work.

## Envelope

Messages use `harness-collab/message/1`; validate them with the same rules the
protocol already applies (`type`, explicit `from`/`to` identities, required
`reply_to`/`subtask_id`/`attempt` per type, `body.status` restricted to the
report statuses). Message ids are single path segments: a letter or digit
followed by letters, digits, dot, dash or underscore (maximum 128 characters).

Protocol behaviour is unchanged:

- `ASSIGN` registers or updates the attempt and opens a
  `registered_not_started` uncertainty; it does not launch anything.
- `ACK` correlates to the assignment and records consumption, not progress.
- `ASK` is evidence only. It records the question and changes no task state.
  Blocking a clarification remains `BLOCK(kind=clarification)`.
- `ANSWER` resolves a correlated `needs_input`/clarification attempt back to
  `running`; an uncorrelated ANSWER is recorded without a transition; an ANSWER
  to an approval block is refused (`approval_not_auto_answerable`).
- `REPORT` is admitted only from the attempt's current assignee; a stale sender's
  report is retained as evidence with an uncertainty and changes nothing.
- `CANCEL` records intent and keeps claims; `CANCELLED` requires stop evidence.
- `HANDOFF`, `STATUS`, `STATUS_QUERY` and `BLOCK` keep their existing semantics.

## Binding document

A binding is task-local routing metadata, not authority. It maps the exact
protocol recipient to a named Herdr agent so a notification cannot target a
focused pane or an unrelated session.

```json
{
  "schema": "pappra/collab-binding/1",
  "task_id": "FIJI-123456",
  "task_root": "/absolute/domain/tasks/FIJI-123456",
  "channel": "herdr",
  "participants": [
    {
      "agent_id": "pappra-implement",
      "harness": "pi",
      "cwd": "/absolute/workspace",
      "herdr_agent": "pappra-implement",
      "pane_id": "w3:p3",
      "native_session_id": "b4c18851-d297-4f99-9850-9be1a0f9a9a7"
    }
  ]
}
```

`native_session_id` may be `null` when the harness exposes no native session.
Both sender and recipient must be in the binding. The selected sender pane must
equal the sender binding pane, and live sender/recipient name, pane, harness and
cwd must match. Routing has two modes:

- **current context (default):** requires a nonempty inherited `HERDR_PANE_ID`
  before `herdr pane current --current`; missing context refuses rather than
  resolving through focus, and stale IDs fail visibly.
- **explicit task-bound (`--caller-pane <id>`):** uses
  `herdr pane current --pane <id>` without changing the environment or focus.
  Stale inherited IDs do not override it.

Selecting a pane is routing, not sender authentication or process proof; hosted
or detached agents are supported through the task-bound binding. Native session
evidence is compared exactly, not by substring: for Pi (`kind: "path"`) the
native identity is the final `_<session-id>` segment; a different session in an
ancestor directory is a mismatch. Sender and recipient sessions are checked even
when a binding leaves `native_session_id` null. Missing session stays
`native_session: "unknown"` instead of claiming a match. A moved task or binding
must be revalidated and re-bound; nothing is relocated automatically.

## Controller-owned native Pi sessions

`pappra session plan --config <abs managed-pi.json>` validates a fresh launch
request. `session start` runs the native Pi TUI in the calling visible terminal
with its normal daily configuration and an explicit OpenRouter model. The
request schema is `pappra/managed-pi-session-request/1` with `cwd`, `model` and
`journalPath`; use an existing private directory for the journal.

`session status|fence|stop --config <same-file> --json` uses only that launch's
private endpoint. Fencing stops terminal ingress; stopping waits for the exact
owned child. Neither proves complete queues, approvals or external-writer
quiescence, and automatic handoff/resource transfer remains blocked. Existing
interactive sessions cannot be adopted. Input journals can contain private
keystrokes; preserve their private permissions and never replay raw bytes.

## Role-based planning

`pappra collab role-plan expand --request <abs role-plan.json> --json`
expands explicit participants, assignments and disjoint writer scopes into the
existing work-plan format. Save its `plan` field, then use `collab plan` and
`collab work-run` with their existing admission and capability requirements.
The reviewer depends on all writers and waits for coordinator acceptance.

`pappra collab role-plan aggregate --request <abs role-plan.json> --task-root <abs> --config <abs expanded-plan.json> --json`
checks the persisted plan against the request and reads authoritative task
evidence through the work-plan inspector. Rejected, unknown, missing and pending
outcomes remain visible. A delivery acknowledgement never becomes acceptance.
Neither command launches a model, claims resources or creates an assignment.

## Native capability evidence

`pappra collab capabilities derive --harness <pi|codex|claude> --assignment <abs assignment.json> --template <abs card.declared.json> --execution <abs execution.json> [--session <abs pi-session.jsonl> | --events <abs events.jsonl>] [--json]`
turns saved native evidence into a runtime capability card with the maintained
Pi, Codex and Claude semantics. It is read-only: deriving writes no file, starts
no process, spends no model turn and dispatches nothing. Pi requires `--session`;
Codex and Claude require `--events`; wrong-host, duplicate and unknown flags are
rejected. Exit 0 derived, 1 needs_input, 2 invalid request. JSON uses
`pappra/collaboration-capabilities/1`.

Assignment and template files are bounded at 1 MiB, native evidence at 16 MiB;
all paths must be absolute. Final symlinks, FIFOs and special files are refused
without blocking, with descriptor-level checks. Diagnostics never include
evidence content.

- **Pi:** tools need correlated successful results; a skill is verified only by a
  successful read of its `SKILL.md`. Observation time is the session's own last
  usable timestamp; incomplete results or an indeterminate `toolUse` turn end are
  refused.
- **Codex:** only explicit item-to-tool mappings can promote tools; skills stay
  unknown because `exec --json` does not report invocation. Unknown rows/items
  fail closed.
- **Claude:** discovery/bootstrap may use only `Read` and `Skill`; verified skills
  require the injected base directory to match the fingerprinted source.

Old evidence never becomes fresh and a fixture shape is not live-version proof.
The card remains a claim from the supplied evidence; preflight still checks it
separately and no authentication, ownership, admission or launch is implied.

For an interactive Pi session that is still open, replace `--execution <file>`
with `--live`. This derives the standard card directly from a settled saved
session, without fabricating a process-exit receipt or manually normalizing a
model-written card. Pending tool results, a trailing user message, a non-`stop`
assistant result or a later model change refuse derivation. Metadata appends do
not refresh the observation timestamp. This is a historical snapshot of observed
successful tools and skill reads, not proof of current tool registration, live
process state, queue contents, approvals or ownership.

```nu
let derived = (^pappra collab capabilities derive --harness pi --assignment /abs/assignment.json --template /abs/card.declared.json --live --session /abs/session.jsonl --json | from json)
if $derived.status != 'derived' { error make {msg: $"derive refused: ($derived.status)"} }
$derived.card | to json | save --raw /abs/task/card.runtime.json
```

```nu
let derived = (^pappra collab capabilities derive --harness pi --assignment /abs/assignment.json --template /abs/card.declared.json --execution /abs/execution.json --session /abs/session.jsonl --json | from json)
if $derived.status != 'derived' { error make {msg: $"derive refused: ($derived.status)"} }
$derived.card | to json | save --raw /abs/task/card.runtime.json
^pappra collab preflight --assignment /abs/assignment.json --capabilities /abs/task/card.runtime.json --json
```

## Task state and resource controls

```sh
pappra collab state show|doctor --task-root <abs> [--json]
pappra collab state epoch-check --task-root <abs> --owner-epoch <positive> [--json]
pappra collab resource list --task-root <abs> [--json]
pappra collab resource claim|release --task-root <abs> --request <abs> [--apply] [--json]
```

State commands reuse the existing record/lock/transaction/doctor primitives and
are read-only; doctor never repairs, breaks a lock, releases or launches.
Unresolved uncertain or invalid findings make doctor needs-input (exit 1); a live
lock observation alone is active evidence, not a readiness failure.
`resource list` reports domain claims and unreadable tasks as `state: "unknown"`;
its displayed claims share one global 500-claim budget across at most 100 tasks,
with full counts and actual `omitted`/`truncated` metadata.

Resource requests use `pappra/collaboration-resource-request/1` with an exact
action, explicit holder agent/session, canonical resource kinds and `access:
read|write`; release names one `claim_id`. Files are bounded at 1 MiB and read
with the special-file-safe loader. Plan without `--apply` validates only the
strict request and task namespace; it reserves nothing. Apply revalidates and
calls exactly the existing claim/release primitive. This is cooperative record
mutation, not OS fencing.

The namespace proof reuses the message task validator and also refuses redirected
or special `.write.lock`, transaction, ledger, aborted/broken-lock, `.domain.lock`
and neighboring task-record paths before reading or mutating them. System aliases
above the domain remain valid. Exit 0 success, 1 conflict/uncertainty/refusal,
2 invalid request/options. Use fresh fixture domains in tests; never alter live
claims.

## Recorded ownership handoff

```sh
pappra collab handoff inventory --task-root <abs> [--subtask-id <id>] [--attempt <n>] [--json]
pappra collab handoff <begin|stopped|rebind|transfer|confirm|complete|abort|release-dispatch> \
  --task-root <abs> --request <abs> [--apply] [--json]
```

Requests use `pappra/collaboration-handoff-request/1` with an exact action, actor,
positive current `owner_epoch`, optional `expect_revision`, and action fields that
map to the existing primitives. Actor/epoch are editable protocol inputs, not
authentication. Plan without `--apply` validates request/namespace only and writes
nothing; apply revalidates and checks the epoch inside the guarded transaction,
preserving refusal rollback. This records cooperative ownership transfer; it is
not OS fencing, stop proof or a launch mechanism.

Confirmation is a registered message that is already present in the authoritative
record as an accepted/recorded ACK or HANDOFF entry. It must match its stored
content digest, come from the receiver to the current coordinator, carry the
current owner epoch, and explicitly correlate via `body.handoff_id` or `reply_to`
to the handoff with no conflicting body id. HANDOFF confirmations use a
non-request phase such as `confirmation`. Missing, unapplied, wrong-identity,
wrong-epoch, replayed, unrelated, symlink or FIFO confirmations cannot transfer
ownership. Writer completion transfers recorded claims and raises resource epochs;
coordinator completion raises owner_epoch and keeps dispatch frozen until an
explicit current-epoch `release-dispatch`.

Inventory is stored-state-only, bounded, read-only and never prints message bodies
or arbitrary inventory payloads. No command queries pane idle, stops a process,
answers an approval or launches an agent.

## Explicit recovery

```sh
pappra collab recovery inspect --task-root <abs> [--json]
pappra collab recovery reconcile --task-root <abs> --request <abs> [--apply] [--json]
pappra collab recovery lock-break --task-root <abs> --request <abs> [--apply] [--json]
```

Requests use `pappra/collaboration-recovery-request/1`; results use
`pappra/collaboration-recovery/1`. Request JSON is bounded at 1 MiB through the
special-file-safe loader. Inspect is read-only and reports bounded uncertainty,
task lock/transactions and a stable lock-content fingerprint; PID liveness is an
observation, not stop proof. Exit 1 for open uncertainty, interrupted
transactions or an unavailable/oversized lock snapshot.

Reconcile records one explicit resolution and evidence reference, optionally
applying an existing state transition for that uncertainty's exact
subtask/attempt. Resolution and transition share one guarded transaction: an
invalid/approval-denied transition or missing context refuses both, without
committing resolution first. It does not release claims, clear `cancel_pending`
or invent native evidence.

An unexpected reconcile transaction exception is reported conservatively as
`reconcile_uncertain`: the record commit may already have happened even if ledger
evidence failed. Inspect the task record and ledger before any explicit retry; no
automatic rollback, retry or second journal is created.

Lock-break requires current epoch, reason, a literal `confirm_holder_stopped: true`
and the exact fingerprint from inspect; the operator assertion is not a Pappra
native proof. Plan writes nothing. Apply revalidates namespace, epoch and exact
lock content before the existing `breakLock`; changed/unavailable snapshots are
refused. The old lock, holder, transactions and break record are archived without
overwrite, age-based reclaim or deletion of unknown evidence. Ambiguous
post-mutation failure is reported as uncertain. Only the task write lock is
recovered, never the domain lock or an execution.

## Portable task bindings

```sh
pappra collab binding list [--root <abs>] [--json]
pappra collab binding resolve --task-id <alias> [--root <abs>] [--roots <abs roots.json>] [--json]
pappra collab binding bind --task-id <alias> --record <abs task.json> [--root <abs>] [--apply] [--json]
pappra collab binding unbind --task-id <alias> [--root <abs>] [--apply] [--json]
```

The workspace-local `<workspace>/.pappra/local/collab-bindings.json` table
(schema `pappra/collaboration-bindings/1`, tied to `workspaceId`) stores pointer
metadata only: canonical record/task/domain paths, alias, protocol task ID,
domain identity, immutable record `created_at`, bound time, and explicit
tombstones. It never copies protocol content and is not execution authority.

Bind validates a real `<task_root>/task.json` before writing; normal revision or
inode replacement stays usable, while reinitialization/identity drift is a
conflict requiring explicit unbind. Plan writes nothing; apply serializes via
the existing private-state lock, rereads and atomically publishes. Unbind never
reads the target and leaves a tombstone; a later bind clears it. Present invalid
metadata is preserved and never bypassed.

The same 1 MiB ceiling applies to exact serialized publications: bind/unbind
returns `bindings_capacity` before index replacement if the new bytes exceed the
limit; previous bytes and every pointer/tombstone stay intact. Pappra never drops
entries to fit.

An alias present in both `bindings` and `unbound` makes the index invalid for
every action; the bytes are preserved and resolution never falls through to
discovery. A valid tombstone is removed only by a later explicit bind.

Resolve precedence is invalid index (fail), explicit binding (exclusive),
tombstone, explicit `--roots` discovery (≤32 absolute collaboration domain
roots, only `<root>/tasks/<alias>/task.json`, canonical dedupe, unique or
ambiguous/incomplete), then none. No home registry scan or automatic persistence
of discovered targets. A usable target reports persisted revision/coordinator/
freeze/attempt summaries with `scope: persisted-history` and
`liveStatus: unknown`; it never proves native running/stopped/accepted state.
List/resolve/plan are read-only.

`--json` emits one versioned result (`pappra/collaboration-binding-result/1`).
From an unrelated cwd with an explicit root:

```sh
pappra collab binding bind --root /abs/ws --task-id workspace-experience \
  --record /abs/domain/tasks/workspace-experience/task.json   # plan, no write
pappra collab binding resolve --root /abs/ws --task-id workspace-experience
# Alias workspace-experience: binding (usable true).
pappra collab binding unbind --root /abs/ws --task-id workspace-experience --apply
# Unbind unbound; applied true. Later resolve reports unbound.
```

Without `--root` the caller's nearest registered workspace is used; a caller
outside any workspace fails `workspace_unavailable` (exit 2) rather than
scanning home or an outer registry.

## Readiness preflight

`pappra collab preflight --assignment <abs assignment.json> --capabilities <abs card.json> [--max-age-minutes <n>] [--json]`
checks reported readiness with the existing primitive. It is read-only: no
launch, claim, task mutation, evidence refresh, file-content output or model
turn. Exit codes: 0 ready, 1 needs_input, 2 invalid request/JSON/contract/card.
JSON uses `pappra/collaboration-preflight/1`; `ok` is true only for `ready`.

Pre-dispatch walkthrough:

```sh
# A card observed from the real receiving session.
pappra collab preflight --assignment /abs/assignment.json \
  --capabilities /abs/card.runtime.json --json

# A declared template only plans; it does not pass work readiness.
pappra collab preflight --assignment /abs/assignment.json \
  --capabilities /abs/card.declared.json --json
# -> needs_input, blocker runtime_capabilities_unconfirmed
```

Do not relabel a declared template as runtime. Derive a runtime card from
native evidence with `pappra collab capabilities derive`, or pass a separately
obtained card. `ready` means only current reported capability/evidence readiness;
self-reported facts, authorize dispatch, acquire resources, verify epochs,
launch, prove completion or replace launch admission. Warnings (for example a
write resource whose ownership is not enforced) and limits remain visible. The
default freshness window is 30 minutes; `--max-age-minutes` accepts a positive
finite override.

### Model choice and readiness recovery

Model, provider and reasoning level are mutable **runtime observations** recorded in
a card's `native_observation`; they are not task identity, session identity,
`configuration_id`, ownership epoch or evidence freshness. A user-selected model
change alone therefore requires neither a new task identity nor reverting to the
original model, and no product check compares model or provider today.

Keep the current user model. When readiness fails, apply the recovery that matches
the actual blocker: derive _fresh_ evidence from the current receiving session for
stale evidence (never retimestamp older evidence); compare host and native
timestamps for future-clock evidence; treat an unavailable tool or skill code as
unconfirmed readiness rather than proven absence — inspect the current runtime
exposure, obtain actual current evidence, and restore or enable the capability when
it is in fact missing (changing a requirement is the coordinator's explicit scope
decision, not a worker recovery step); supply evidence for the exact
assignee identity/session/cwd/configuration for identity mismatches. Earlier
successful tool use does not prove the current runtime still exposes that tool, so
re-derive after a material change instead of promoting history into evidence.
Needs-input human output groups these recoveries; JSON status, blockers and exit
codes are unchanged, and unknown blockers keep their code without an invented
remedy.

## Read-only work-plan inspection

```nu
# Plan document: role/dependency nodes over the existing task protocol.
# A ready node is not authorization to run it.
^pappra collab plan --task-root /abs/domain/tasks/example --config /abs/work-plan.json --json
| from json
| select status stale summary
```

`collab plan` loads one bounded regular plan file and the exact task namespace,
then re-reads every registered decision envelope the evaluation needs. Each node
names a role label, the assignment attempt it expects, its pinned input revision,
its dependencies and its intended resource scope. Roles describe
responsibilities only; they grant no authority.

Node `assignment_id` is the existing task subtask identity
(`record.attempts[].subtask_id`); there is no second assignment registry.

Acceptance convention: a dependency advances only after the current coordinator
registers an `ANSWER` that is applied, digest-verifiable, and correlated to the
predecessor's assignment attempt, pinned input revision and registered report
digest. The complete registered decision set is authoritative, so an omitted
later rejection leaves acceptance `unknown`; sender timestamps never order
decisions (record application order does). A finished `REPORT` alone keeps the
node `awaiting_acceptance` and its dependents blocked.

Limits: the report is a persisted snapshot, advisory only, with no claim, launch,
dispatch, refresh, reconcile, native query or message write, and no resource
fencing. Evidence is scoped to the plan: only decisions addressed to the current
applied reports of the planned attempts are read, so unrelated task messages never
become required and are never counted. Plan documents are bounded at 512 KiB;
relevant decision evidence is bounded at 128 envelopes, 1 MiB per file and 4 MiB
aggregate, measured in the raw file bytes consumed by the bounded read (including
files later rejected by validation) before any full parse; record arrays are bounded
at 512 entries. Exceeding a bound reports `incomplete` with an explicit diagnostic
instead of returning truncated readiness. Read the human output for role, node
status, the blocking dependency/resource condition and the next action; message
bodies are never printed.

## Read-only rollover inspection

```nu
# Request: schema pappra/collaboration-rollover-request/1, bounded at 64 KiB.
^pappra collab rollover inspect --task-root /abs/domain/tasks/example \
  --request /abs/rollover-request.json --json
| from json
| select action ok plan_complete intent bundle steps
```

`collab rollover <inspect|plan>` reads the exact authoritative task record and one
exact linked continuity handoff bundle, then reports the current rollover facts and
the steps a later execution would need. `--task-root` must equal the request
`task_root`; the working directory is never used to infer a workspace or task.

The request names the absolute task root, the bundle `root`,
`continuity_task_id`, `bundle_id` and pinned `digest`, and either a recorded
`intent_id` (`inspect`) or a `proposed_intent` (`plan`). A plan with no recorded
intent types the intent against the accepted record reducer on a clone and reports
its refusal code, so nothing is persisted.

A recorded intent pins one exact bundle: the request must name
`handoff-bundles/<bundleId>.json` under its continuity task with the digest recorded
at intent creation. Any other bundle, including a different valid one, is refused
with `bundle_pin_mismatch`; a freshly readable bundle is never substituted for the
originally pinned checkpoint context.

The bundle is read exactly, its digest must equal the pin, and it is verified with
the accepted handoff-bundle verifier. Its workspace, continuity task, collaboration
task/attempt/input/owner-epoch, source session agent/session/harness and the bounded
handoff snapshot must match the plan: the snapshot claims must equal the intent's
original holder/epoch, and claims plus pending tools/messages/approvals must all be
`complete` with no pending items. Partial or unknown inventory stays unknown and
blocks completion. Complete artifact context alone never grants authority;
`execution_allowed` stays `false`.

The report names the current `stage` and evaluates expected facts by stage. Before
transfer it expects the source assignee, the source-held claims at their intent
epochs and the pinned source native identity. After a completed transfer it expects
the successor assignee, the successor-held claims at epoch+1 and the pinned successor
native identity, so archived source history is not reported as current drift. An
aborted handoff is not executable. `plan_complete` is true only when every step is
satisfied, no drift or evidence issue exists, and the bundle association, snapshot
inventory and context integrity all agree.

Optional `evidence` ids name at most two registered `ACK`/`REPORT` envelopes. Each is
read descriptor-bounded through the safe id, namespace and realpath checks, and the
actual raw bytes are charged before JSON or envelope refusal, so a corrupt or padded
file is never inspected for free. Correlations include type, sender, recipient, task,
subtask, attempt, input revision, intent, generation, epoch, ledger identity and
first-work proof ordering; a missing, unreadable or contradictory id is a reported
blocker, never a report that stays complete.

Current-record drift is reported explicitly: coordinator epoch, handoff state, latest
attempt, assignee, input revision, waiting writer, claim holder/epoch/release, pinned
native identity and any missing transfer boundary. `prepare-transfer` stays
`unavailable` because no accepted host adapter produces authenticated quiescence
evidence; a caller-supplied stop observation, exit code or producer label is never
stop proof. `routing_removal` stays `pending` and `native_session_archive` stays
`unavailable`, so an applied transfer never claims that dispatch routing or the old
native session was archived.

There is no apply action: `rollover apply` and unknown actions are rejected with
exit 2. Exit 0 means the inspection ran (`plan_complete` reports whether every step
is satisfied), exit 1 means the exact record or bundle cannot support it, exit 2
means the request is invalid. Nothing is claimed, transferred, launched, archived,
routed, notified or written, and no native query is made.

A validated succession also excludes its archived old native identity from
`collab message notify`: an excluded sender or recipient fails with
`sender_route_excluded`/`recipient_route_excluded` before any caller or live Herdr
query and before any send, while stored messages, deliveries and bindings keep their
history unchanged. The current successor identity stays an active route.

A completed handoff alone is not proof. Exclusion requires the matching intent (task,
handoff, generation, source and successor identities), a recorded transfer boundary,
the registered applied first-work `REPORT` whose digest matches the retained proof and
which was applied after the boundary, and an admitted `completed` result entry for
that report. A missing or contradictory chain makes the queried identity `unknown`,
including when it matches the named successor, so a notify is refused instead of
silently rerouted.

## Notification states

| Status                    | Meaning                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `planned`                 | Task, message, binding and recipient validated; nothing sent.                                                                                                                                           |
| `submitted`               | One `herdr agent prompt` was accepted. Consumption is still unknown.                                                                                                                                    |
| `blocked`                 | Herdr reported `agent_blocked`; a blocked native UI is never answered.                                                                                                                                  |
| `refused`                 | Herdr rejected the prompt with an explicit recognized pre-submission refusal (`agent_not_found`).                                                                                                       |
| `unknown`                 | The prompt may have been submitted (timeout, stalled, signal, nonzero exit without a recognized result, an unrecognized error code, or transport error after the reservation). Never resend implicitly. |
| `failed`                  | The transport failed without a possible submission (for example an unresolvable delivery directory).                                                                                                    |
| `herdr_unavailable`       | Not inside Herdr, or the CLI is not callable. The message stays persisted.                                                                                                                              |
| `herdr_caller_unverified` | The caller pane could not be resolved or the environment caller IDs are stale. Nothing was inspected or sent.                                                                                           |
| `already_recorded`        | Delivery metadata already exists for this message id; no new wakeup was sent.                                                                                                                           |
| `in_flight_unknown`       | A delivery reservation is still in flight or its outcome is unknown; it is never resent or reclaimed by age.                                                                                            |
| `retry_limit`             | Explicit retry attempts are exhausted (3).                                                                                                                                                              |

Notification metadata lives in `<task-root>/notifications/<message-id>.json`; it
is delivery evidence, not a second task record. Each retry reserves a distinct
attempt under a task-private lock, so concurrent retries cannot lose an attempt
or exceed the bound. Retries are explicit operator actions with `--retry` on the
same message identity.

## Working loop

1. The coordinator prepares the task and claims the resources.
2. The coordinator sends one `ASSIGN` envelope, then notifies the recipient once.
3. The recipient ACKs by sending its own envelope and notifying the coordinator
   once; it asks a question with `BLOCK(kind=clarification)` or `ASK`, and
   reports with `REPORT`.
4. The coordinator reads the report, checks the evidence, and answers with a
   correlated message. Acceptance remains a separate decision.

No polling, timers, repeated status reads, or `herdr agent prompt --wait` are
part of this loop. If no reply arrives, the outcome is uncertain; inspect the
record before retrying rather than sending another wakeup.

## Direct mode and receiver verification

This surface works without Herdr for persistence and reading. Notification
requires `HERDR_ENV=1` plus a routing mode: inherited current context (which must
be present and consistent) or an explicit task-bound `--caller-pane <id>` for
stale inherited IDs. Outside Herdr it returns `herdr_unavailable`; missing, stale
or unresolved context returns `herdr_caller_unverified`, with the persisted
pointer and no launch, focus change, pane creation, or channel switch. Direct
coordination uses the same envelopes and explicit sessions.

A pane id is not a native session id, and pane idle is not proof of stop or
acceptance. The receiver verifies its exact `to` identity (agent id, harness,
session id) before consuming a message, and never adopts an arbitrary PID or
session because a notification arrived.
