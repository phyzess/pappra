# Collaboration messages and notification

Pappra's collaboration protocol lets two agent sessions exchange task-scoped
messages without a daemon, a scheduler, or model polling, and this surface carries
the persisted message commands, their notification transport, and the supporting
controls built on the same task record: capability evidence, readiness preflight,
task state and resource claims, recorded ownership handoff, explicit recovery, and
portable task bindings. Every command here plans by default and performs its
effect only with `--apply`.

The environment entry (direct versus visible Herdr operation, sibling-pane
bootstrap versus exact-peer reuse) is documented in the shipped skill's
`references/environment.md`, and the typed cohort workflow that drives these
commands is documented in [the workflow](collaboration-workflow.md).

## Before you start

A task root is `<domain>/tasks/<task-id>` and already contains `task.json`,
`messages/` and `ledger.jsonl`; `pappra collab prepare` creates it. All commands
on this surface require an explicit absolute `--task-root`. Nothing is inferred
from the current directory, from chat text, or from another task.

`pappra collab prepare` is not plan-only: it writes task/prepared state, claims
resources and registers the initial `ASSIGN`. Read the registered assignment and
notify it; never send a second one. `message send` and `message notify` plan by
default. `notify` assumes a bound recipient already exists; it never starts or
discovers one. A pane is routing/visibility evidence, not native ownership or
process authentication.

## Message commands

```sh
pappra collab message send   --task-root <abs> --message <abs-envelope.json> [--apply]
pappra collab message list   --task-root <abs> [--limit <1-100>]
pappra collab message read   --task-root <abs> --message-id <id>
pappra collab message notify --task-root <abs> --message-id <id> \
                             --binding <abs-binding.json> [--caller-pane <id>] \
                             [--apply] [--retry]
```

`--json` returns `pappra/collaboration-message/1` for every action.

- `send` validates one envelope file and, with `--apply`, registers and applies it
  through the existing protocol. It reports `planned`, `accepted`, `duplicate`
  (same id and content, no second side effect), `conflict` (same id, different
  content), or `rejected` with the protocol reason, and returns the registered
  message path and the SHA-256 of the file. It never notifies anyone and never
  claims native delivery or task acceptance.
- `list` reports the most recent registered messages from the authoritative
  record, including both `applied` and `recorded` entries, with their delivery
  status when notification was attempted. The default limit is 20; the maximum
  is 100.
- `read` returns one registered message, its record entry and its delivery
  record. Both read commands are read-only.

Five facts stay distinct and are never collapsed:

1. **persisted** — `send --apply` registered and applied the envelope through
   `submitMessage` (record, message file, ledger).
2. **notified/submitted** — `notify --apply` handed one pointer line to a named
   Herdr agent; `delivery: submitted` only says the prompt was accepted.
3. **consumed/acknowledged** — the recipient's own `ACK` message.
4. **reported** — the recipient's `REPORT` message and stored result.
5. **accepted** — the coordinator's explicit decision, outside this surface.

Successful `notify` JSON results carry `consumed: false` and
`taskAccepted: false`. Successful `send` results return
`delivery: "persisted-not-notified"`, `notified: false` and `taskAccepted: false`.

## Envelope

Messages use `harness-collab/message/1` and are validated with the same rules the
protocol applies on apply: an explicit `from` identity, the per-type required
`to`/`reply_to`/`subtask_id`/`attempt` fields, and the per-type required `body`
keys. `body.status` is restricted to the report statuses (`running`, `completed`,
`needs_input`, `failed`, `cancelled`, `unknown`); `BLOCK` kinds are
`clarification` and `approval`; `HANDOFF` kinds are `writer` and `coordinator`.
Unknown extension fields are tolerated on purpose; unknown semantics are never
inferred.

Current apply behaviour per type:

- `ASSIGN` registers or updates the attempt and opens a
  `registered_not_started` uncertainty; it does not launch anything.
- `ACK` correlates to the assignment (or to a pending handoff) and records
  consumption, not progress.
- `ASK` is evidence only: it is recorded with `state: "recorded"` and changes no
  attempt state. Blocking a clarification remains `BLOCK(kind=clarification)`.
- `ANSWER` resolves a correlated `needs_input`/clarification attempt back to
  `running`; an uncorrelated answer is recorded without a transition; an
  `ANSWER` to an approval block is refused (`approval_not_auto_answerable`).
- `REPORT` is admitted only from the attempt's current assignee; a stale sender's
  report is retained as evidence with an uncertainty (`classification:
  "stale_sender"`) and changes nothing.
- `CANCEL` records intent, marks the holder's claims `cancel_pending` and opens a
  `cancel_unconfirmed` uncertainty; `CANCELLED` requires stop evidence, confirms
  the stop, releases exactly that execution's claims and resolves the
  uncertainty.
- `STATUS`, `STATUS_QUERY` and `HANDOFF` notifications are recorded without a
  state change; a `HANDOFF` request phase moves ownership through the handoff
  primitives.

Message ids are single path segments
(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`), so `..`, separators and control
characters are refused before any path is built.

## Task-root validation

`openMessageTask` proves the root is `<domain>/tasks/<task-id>` with a real
`task.json`, a real `messages/` directory, no final-component symlinks, and a
record whose `task_id`/`task_root`/`domain_root` match. A system-level ancestor
symlink (for example `/var` on macOS) is resolved, but the domain entry itself,
the `tasks` parent, the task root, the messages directory and the record must be
real: a symlinked domain, `tasks` parent, task root, messages directory or record
fails closed. Message ids are single path segments, so `..` and separators are
refused before a path is built.

## Protocol sender authority

The owner epoch identifies an authority generation; it does not authorize an
arbitrary sender. Before mutating an attempt, the protocol matches both
`agent_id` and `session_id` against the recorded role: `ASSIGN` and `CANCEL`
require the current coordinator; `ACK` and `CANCELLED` require the current
attempt's assignee (a registered handoff receiver may acknowledge that exact
pending handoff without changing the source writer's attempt); `BLOCK` accepts
the current assignee or coordinator so coordinator approval gates remain
enforceable; handoff requests require the corresponding coordinator or writer. An
`ANSWER` must correlate with the recorded question, its intended recipient and
the current assignee, so a worker cannot unblock another attempt by creating and
answering its own question. Coordinator `ANSWER` decisions replying to
assignments or reports are recorded as evidence for downstream validation and
cannot resolve a clarification. Rejected sender-role checks do not mutate
attempts, uncertainty or resource ownership; stale-epoch refusals are recorded as
uncertainty; stale `REPORT` messages remain evidence rather than authority over
current work.

These are protocol consistency checks within a cooperative, same-user
environment. Envelope fields are not independently authenticated credentials;
copying another participant's complete known identity is outside the identity
guarantees of this CLI.

## Notify

`notify` only forwards an **already registered** message pointer:

```text
COLLAB_MESSAGE task=<id> type=<type> message=<abs path> digest=sha256:<file digest>
```

No body, transcript, prompt or report text is included. It requires a task-local
binding (`pappra/collab-binding/1`, `channel: "herdr"`, at most 16 participants)
whose `task_id` and `task_root` match the record and which contains both the
message sender and recipient, with one participant per agent id and per Herdr
agent name. `native_session_id` may be `null` when the harness exposes no native
session.

Routing has two modes, neither of which authenticates the sender:

- **current context (default):** requires the Herdr marker (`HERDR_ENV=1`) and a
  nonempty inherited `HERDR_PANE_ID` before `herdr pane current --current`.
  Missing context refuses with `herdr_caller_unverified` and a `--caller-pane`
  hint; stale or inconsistent workspace/pane ids fail visibly. It never resolves
  through focus.
- **explicit task-bound (`--caller-pane <id>`):** uses
  `herdr pane current --pane <id>` without changing the environment or using
  focus. Stale inherited ids do not override it. The pane is a routing candidate,
  not process proof.

The selected caller pane must equal the sender binding pane. Both participants
are then verified against live Herdr observations: exactly one agent per bound
name, and the live pane, harness and cwd must match the binding. Sender and
recipient native sessions are compared exactly when Herdr reports them, even
when the binding leaves `native_session_id` null: for Pi (`kind: "path"`) only
the final `_<session-id>` segment of the session file is the native identity, so
a different session in an ancestor directory is a mismatch; other kinds are
compared as reported ids; a missing session stays `native_session: "unknown"`
rather than claiming a match. Process affiliation is **not established** by pane
selection: recorded caller evidence says
`process_affiliation: "not-established"`, and hosted or detached agents whose
process tree differs from the pane are supported through the task-bound binding,
not by ancestry claims.

For ordinary Herdr targets the delivery is one `herdr agent prompt <name> <text>`;
for a verified owned Pi SDK target it calls the owned controller's `deliver`
operation instead after revalidating the recorded identity. In both cases the
command runs without `--wait`, without shell interpolation, without pane
creation, without focus changes, and never answers a blocked agent.

The task namespace and the registered bytes are revalidated after awaited
transport work and immediately before any delivery mutation or prompt: a root
renamed, replaced or redirected in the meantime, a changed binding participant, a
changed message digest, or an unproven succession route fails closed without
creating state outside the task. The registered message is read through one
bounded, identity-checked reader, so a final symlink, special file, oversized
file or id/content mismatch is never treated as protocol content.

Delivery metadata is stored in `<task-root>/notifications/<message-id>.json`
(`pappra/collab-delivery/1`). A successful submission, a refusal, a blocked
target and an unknown outcome are recorded distinctly. Repeating `notify` after a
recorded outcome reports `already_recorded` without sending another prompt. An
explicit `--retry` repeats the same message identity up to 3 recorded attempts
(`retry_limit` afterwards). A `submitting` reservation — in flight, or crashed
before its outcome was recorded — is reported as `in_flight_unknown` and is never
retried or reclaimed by age; an operator must inspect the delivery evidence.
Concurrent retries serialize on a task-private lock: one reserves, the other is
refused without a wakeup, and a residual lock directory stays visible evidence.

Outcome classification is conservative: a spawn failure before a process exists
is `failed` (nothing submitted); `agent_blocked` is `blocked`; only the
recognized pre-submission refusal set (`agent_not_found`) is `refused`;
`timeout`/`agent_prompt_stalled` are `unknown`; and any other error envelope —
including an unrecognized code from a future Herdr version — is `unknown` with
the code preserved, because a parseable error does not prove the command stopped
before submitting. There is no automatic resend.

## Native capability evidence

```sh
pappra collab capabilities derive --harness <pi|codex|claude> \
  --assignment <abs assignment.json> --template <abs card.declared.json> \
  [--execution <abs execution.json> | --live] \
  [--session <abs pi-session.jsonl> | --events <abs events.jsonl>] [--json]
```

`derive` produces a runtime capability card from saved native evidence using the
maintained Pi, Codex and Claude adapter semantics. It is read-only: deriving
writes no file, launches no process, spends no model turn, authenticates nothing
and dispatches nothing. Pi requires `--session`; Codex and Claude require
`--events`; duplicate, unknown or cross-host flags are rejected. Exit codes are
`0` derived, `1` needs_input, `2` invalid request/configuration. JSON results use
`pappra/collaboration-capabilities/1`.

For an interactive Pi session, `--live` replaces `--execution` and derives a
settled saved-session snapshot without a process-exit receipt. Pending tool
results, a trailing user message or a later model change are refused, as is a
turn that ended while a tool call was still outstanding.

Configuration files are bounded at 1 MiB and each native evidence file at
16 MiB. All paths must be absolute; final symlinks, FIFOs and other special
files are refused without blocking, with descriptor-level type and size checks
and bounded reads. Diagnostics stay generic and never include evidence content.

Observed semantics are preserved rather than generalized:

- **Pi:** a tool is `verified` only when a recorded call correlates with a
  successful result; a skill is `verified` only when the session actually read
  that skill's `SKILL.md` successfully. Message-level numeric timestamps and
  record-level zoned timestamps are both honored; observation time is the native
  session's own last usable timestamp. Incomplete results and an indeterminate
  `toolUse` turn end are refused.
- **Codex:** only explicitly mapped completed items promote tools
  (`command_execution` → `shell`, `file_change` → `apply_patch`,
  `mcp_tool_call` → `mcp`, `web_search` → `web_search`). `exec --json` does not
  report skill invocation, so skills stay `unknown` and a required skill still
  blocks preflight. Unknown row/item shapes fail closed.
- **Claude:** discovery/bootstrap executions may use only `Read` and `Skill`;
  successful call/result correlation promotes tools, and a skill is `verified`
  only when the injected skill base directory matches the fingerprinted source.
  Otherwise states stay `discovered`, `callable` or `unknown`.

Observation time always comes from the native evidence; replaying old artifacts
does not refresh freshness. Supplying a supported fixture shape is not proof that
a newer live CLI version emits the same stream. A derived card remains a claim
from the supplied evidence: preflight still checks it separately, and no
authentication, ownership, admission, launch or completion is implied.

Persist a derived card deliberately, then run preflight:

```nu
let derived = (pappra collab capabilities derive --harness pi \
  --assignment /abs/assignment.json --template /abs/card.declared.json \
  --execution /abs/execution.json --session /abs/session.jsonl --json | from json)
$derived.card | to json | save --raw /abs/task/card.runtime.json
pappra collab preflight --assignment /abs/assignment.json \
  --capabilities /abs/task/card.runtime.json --json
```

Deriving alone neither persists the card nor dispatches work.

## Readiness preflight

```sh
pappra collab preflight --assignment <abs assignment.json> \
  --capabilities <abs card.json> [--max-age-minutes <n>] [--json]
```

`preflight` runs the existing readiness primitive without launching, claiming,
mutating a task record, refreshing evidence or printing file contents. Exit codes
are `0` ready, `1` needs_input, `2` invalid request/JSON/contract/card; `ok` is
true only for `ready`. The default freshness window is 30 minutes; an explicit
positive finite `--max-age-minutes` overrides it. JSON results use
`pappra/collaboration-preflight/1` and preserve reported readiness, task /
assignment / attempt / checked time, errors, blockers, warnings and limits.

A declared template is useful for planning only: it blocks with
`runtime_capabilities_unconfirmed`. Do not edit `evidence_level` or otherwise
relabel a declared template as runtime — derive a runtime card from native
evidence with `pappra collab capabilities derive`, or pass a separately obtained
card. `ready` reports only current reported capability/evidence readiness; it
does not authenticate self-reported facts, authorize dispatch, acquire
resources, verify ownership epochs, launch, prove completion or replace launch
admission. Advisory warnings (for example a write resource whose ownership is
not enforced) and limits stay visible.

## Task state and resource controls

Read-only task projections reuse the existing record, lock, transaction and
doctor primitives:

```sh
pappra collab state show --task-root /abs/tasks/<task-id> [--json]
pappra collab state doctor --task-root /abs/tasks/<task-id> [--json]
pappra collab state epoch-check --task-root /abs/tasks/<task-id> --owner-epoch 1 [--json]
```

`show` reports stored identity/revision/coordinator/freeze, bounded attempt,
claim, handoff, uncertainty, result and lock summaries; `doctor` only diagnoses
locks/transactions/records/messages and never repairs, breaks a lock, releases,
reconciles or launches anything. `doctor` returns needs-input (exit 1) for
unresolved uncertain or invalid findings; merely observing a live lock is
reported as an active finding but is not by itself a readiness failure.
`epoch-check` uses the existing owner-epoch check. State collections are capped
at 50 rows and report totals and actual truncation.

Domain claims and explicit cooperative mutation use:

```sh
pappra collab resource list --task-root /abs/tasks/<task-id> [--json]
pappra collab resource claim --task-root /abs/tasks/<task-id> \
  --request /abs/request.json [--apply] [--json]
pappra collab resource release --task-root /abs/tasks/<task-id> \
  --request /abs/request.json [--apply] [--json]
```

Requests use `pappra/collaboration-resource-request/1`; the action must match the
command, and the holder carries explicit nonempty agent/session identity. A claim
names at most 256 resources with `access: "read" | "write"` and uses the
existing canonical resource kinds: paths (`scope: "file" | "tree"`), git index,
git HEAD, shared git common dir, build cache, file, port and opaque/process
values. A tree-scoped path claim derives the worktree's git index and HEAD
resources, and the shared git common dir only with `include_shared_git: true`;
expansion keeps one claim per canonical key.

The holder must match the current coordinator, or an `assigned`, `accepted`, or
`running` attempt's assignee with explicit `subtask_id` and `attempt`. A frozen
dispatch refuses new worker claims. The participant check runs again inside the
claim transaction; a plan does not reserve that authority:

```json
{
  "schema": "pappra/collaboration-resource-request/1",
  "action": "claim",
  "holder": { "agent_id": "worker", "session_id": "session-1", "harness": "pi" },
  "subtask_id": "implementation",
  "attempt": 1,
  "resources": [{ "kind": "path", "path": "/abs/target" }],
  "access": "write",
  "include_shared_git": false
}
```

A release names one `claim_id` and the same holder; the low-level release API
also requires an explicit holder. There is no unowned or mass release. These
checks enforce recorded protocol roles, not caller authentication: this same-user
CLI has no trusted caller identity and cannot distinguish an actor that
deliberately copies another known agent/session identity. Request JSON is bounded
at 1 MiB and read through the special-file-safe loader. Without `--apply`, a plan
validates the strict request, task namespace and, for a claim, current holder
participation: it creates no reservation, lock, transaction or claim. With
`--apply`, the namespace is revalidated and exactly the existing
`claimResources` or `releaseClaim` primitive runs. This is cooperative record
mutation, not OS fencing or proof that another process stopped.

The namespace proof reuses the message task validator and additionally refuses
redirected or special nested state before reading/mutating it: the write lock
and transaction files, ledger, aborted/broken-lock directories, domain lock and
neighboring task roots/records used by domain scans. System aliases above the
domain remain valid; original domain/tasks/task redirects, symlinked locks,
records or transactions, and FIFOs fail closed. `resource list` reports
unreadable neighboring records as `state: "unknown"` with their task ids instead
of treating the domain as empty, and exits 1 for that uncertainty. Displayed
resource claims share one global 500-claim budget across at most 100 tasks; full
counts are retained separately and `omitted`/`truncated` reflect actual omitted
rows.

Exit codes are 0 for a successful read/plan/apply, 1 for state conflict,
uncertainty or a core refusal, and 2 for invalid request/options.

## Recorded ownership handoff

```sh
pappra collab handoff inventory --task-root /abs/tasks/<task-id> \
  [--subtask-id <id>] [--attempt <positive integer>] [--json]
pappra collab handoff check --task-root /abs/tasks/<task-id> [--json]
pappra collab handoff check-mid-cohort --task-root /abs/tasks/<task-id> [--json]
pappra collab handoff successor --request <abs successor.json> [--apply] [--json]
pappra collab handoff ack --task-root <abs> --request <successor request id> \
  [--apply] [--json]
pappra collab handoff <begin|stopped|rebind|transfer|confirm|complete|abort|release-dispatch> \
  --task-root /abs/tasks/<task-id> --request /abs/request.json [--apply] [--json]
```

Handoff requests use `pappra/collaboration-handoff-request/1`; the action must
match the command. Every mutation carries an explicit actor identifier, a
positive current `owner_epoch` and an optional `expect_revision` for the existing
transaction revision check. These editable fields are protocol inputs, not caller
authentication. Request JSON is bounded at 1 MiB and read through the shared
special-file-safe loader. No clock override or inline confirmation envelope is
accepted.

A writer `begin` names `handoff_id`, `kind`, exact `from`/`to` identities,
resource claim ids and the writer subtask/attempt. A coordinator `begin` uses
`kind: "coordinator"` and moves coordinator ownership. Later actions map directly
to the maintained primitives:

- `stopped`: explicit observation and evidence ref; an unconfirmed stop refuses
  and opens uncertainty.
- `rebind`: explicit receiver identity and evidence ref; refused after
  confirmation, because one party's acknowledgement must not authorize a transfer
  to another party.
- `transfer`: bounded inventory arrays recorded as data, not approval authority,
  plus an ownership snapshot (claim id, holder, resource epoch) that completion
  must match exactly.
- `confirm`: only a registered `confirmation_message_id`.
- `complete`, `abort`: existing completion/abort behaviour.
- `release-dispatch`: explicit current epoch; completion never releases the
  freeze automatically.

Plan without `--apply` validates the request and task namespace only; it writes
nothing, acquires no lock and makes no ownership reservation. Apply revalidates
the namespace/confirmation evidence, checks the request epoch inside the guarded
transaction before the primitive, and uses the existing transaction/ledger path
exactly once. A primitive refusal leaves the authoritative record unchanged; an
in-memory partial mutation is never committed accidentally. This is cooperative
record ownership transfer, not OS fencing, stop proof or a launch mechanism.

Receiver confirmation is stricter than the core message note. The referenced
message must be safely registered and present in the authoritative record as an
accepted/recorded `ACK` or `HANDOFF` entry. It must match the stored content
digest, come from the receiver identity to the current coordinator, carry the
current owner epoch, and explicitly correlate via `body.handoff_id` or
`reply_to` to this handoff without a conflicting body id. A `HANDOFF`
confirmation must use a non-request phase; `confirmation` is the documented
phase. Missing, unregistered, rejected/unapplied, wrong-recipient/session,
wrong-epoch, replayed or unrelated messages cannot authorize a transfer; symlink
and FIFO registrations are refused.

Writer completion raises the affected claim resource epochs and transfers the
recorded claim holder; coordinator completion raises `owner_epoch`, changes the
coordinator and keeps `dispatch_frozen` until an explicit current-epoch
`release-dispatch`. Existing overlapping-handoff, old-writer-stop,
ownership-drift, holder, stale-epoch and rebound-receiver refusals remain in
force.

`handoff inventory` is stored-state-only and read-only. It reports bounded
summaries with full counts and actual omission for inflight/closed attempts,
pending approvals, uncertainty, resources, results (output counts, not payloads)
and handoffs. It never prints message bodies, stop artifact bodies or arbitrary
inventory payloads, and never queries pane idle, kills a process or launches an
agent.

`handoff check` is also stored-state-only and read-only. It answers one question:
is the task at a cohort boundary where the coordinator can change safely? A
coordinator handoff raises `owner_epoch` and nothing re-stamps attempts or the
sealed work plan afterwards, so a successor cannot accept work registered under
the old epoch. From the task record it blocks on: `attempt_in_flight`,
`attempt_needs_input`, `source_holds_claims` (the outgoing coordinator itself
holds a claim; a protocol-only handoff does not stop that session),
`claims_unreleased` (other holders), `uncertainty_open`, `handoff_open` and
`no_coordinator`. An unresolved uncertainty on an attempt that already ended is a
warning, not a blocker.

A task is workflow-driven when a sealed `workflow/work-plan.json` or
`workflow/manifest.json` exists, judged without following links, so a missing or
redirected artifact never downgrades the answer. For such a task the check
reuses the dispatch evaluator: the sealed plan, the record and the registered
decision envelopes must show every node as `accepted`, otherwise
`cohort_node_not_accepted` (a deferred reviewer that never started is such a
node). An unreadable, invalid or refused plan evaluation, or a registered
decision without a readable envelope, is a blocker with the evaluator's own code
(`work_plan_missing`, `work_plan_invalid`, `work_plan_evaluation_refused`,
`decision_envelope_missing`). Acceptance is never inferred from a message id.

The result always states `fence: protocol_fenced, process_quiescence:
unavailable`: a passing check means the stored state allows the handoff, never
that the outgoing session has stopped. When ready it lists the ordered `begin`,
`transfer`, `confirm`, `complete`, `release-dispatch` steps, in human output as
well as JSON. Exit code 0 means ready and 1 means blocked; an unreadable task
reports `status: unreadable`.

### Mid-cohort handoff

`check-mid-cohort` answers a different question: can the coordinator change
safely **now**, with transferable attempts still in flight? It keeps the boundary
blockers and relaxes only what a successor can inherit: attempts that are
`accepted` or `running` with native evidence bound (an attempt whose only
evidence is an ACK keeps blocking, because an acknowledgement does not prove the
native run started), attempts that already ended, and the claims those attempts
hold under their own subtask and attempt. Attempts that were only `assigned`,
that wait for input, or whose `registered_not_started` uncertainty is unresolved
keep blocking, and every relaxed item is reported with its reason. For each
acknowledged-only attempt the human output lists reconcile guidance: the
uncertainty id, the applied ACK id to cite, the request fields to fill and the
exact command.

### Coordinator successor launch and acknowledgement

A coordinator handoff to a fresh Claude Code or Codex session of the same harness
is driven by two more actions, `successor` and `ack`. The protocol fence is
unchanged: nothing stops or observes the outgoing session, and the old
coordinator is refused by the owner epoch after `complete`.

`successor` takes a `pappra/collab-successor-request/1` document: a durable
`request_id`, the `task_root`, an existing coordinator `handoff_id` in `requested`
state whose receiver agent id is the planned Herdr `agent_name`, the `harness`
(it must equal the coordinator's), the coordinator's `cwd` and Herdr
`caller_pane`, an optional split `direction` (`right` or `down`), an optional
`mode` (`boundary` by default, `mid_cohort`), and a `checkpoint` file with its
pinned sha256 digest (at most 24 KiB). Plan is read-only. It refuses unless the
matching handoff check is ready (the handoff being driven does not block itself;
`mid_cohort` requires `check-mid-cohort` instead), the pane's cwd matches, Herdr's
session for the pane (when it reports one) is the recorded coordinator, the agent
name is free, and the checkpoint matches its digest.

Apply journals every native effect first in `<task_root>/successor/` (not in
`task.json`): the request, the intent with the exact seed, and one step file per
effect (`split`, `start`, `prompt`). A recorded outcome is returned as is; a step
without an outcome is `reconcile_required` and nothing is repeated. After a
definite failure use a new `request_id`. It then splits a sibling pane without
changing focus, starts the agent, waits until Herdr reports the session
interactive (a trust or approval dialog is reported and never answered or typed
over), and delivers the seed with `herdr agent prompt`. The seed is a fixed
template that only substitutes the task id, handoff id and one command; it is
never passed as an argv because Herdr rejects newlines and rewrites single quotes
there. The launcher confirms the turn started and otherwise warns without
re-sending.

Identity comes from observed evidence and is not authentication. Claude: the
launcher pre-assigns `--session-id` (derived from the request id) and requires
Herdr to report exactly that id before any seed is typed. Codex: exactly one
thread loaded in the shared app-server daemon whose `cwd` equals the pane's and
whose `preview` equals the delivered seed, created at or after the launch second;
none or several is `identity_unavailable` and the handoff is left untouched. On
success the launcher rebinds the observed identity into the handoff and records
the transfer through the existing `rebind` and `transfer` actions; both are
idempotent, so rerunning a request whose outcome is recorded finishes a bind that
a crash interrupted, without launching again. A recorded `identity_unavailable`
is reported as a failure (exit 1): the agent it started may still be running,
Pappra never stops it, so close that pane and use a new `request_id`.

`ack` is the **only** command the successor is asked to run. It verifies that the
caller is the recorded successor, checks the checkpoint digest **before**
registering anything, registers one `HANDOFF` confirmation message
(`handoff-ack-<request id>`) from the recorded identity to the current
coordinator, writes an ack marker, and prints the digest-pinned checkpoint as the
briefing. The caller is the pane named by `HERDR_PANE_ID` for Claude. Codex runs
tool commands in the shared daemon, whose `HERDR_PANE_ID` belongs to the daemon
and says nothing about the session, so a Codex successor is bound by
`CODEX_THREAD_ID`, which must equal the thread the launcher recorded. A wrong
caller is refused and registers nothing. The coordinator then explicitly runs
`confirm` (confirmation message `handoff-ack-<request id>`) and `complete`; the
successor runs `release-dispatch` at the new epoch. Neither action completes the
handoff by itself.

Limits: the outgoing session is neither stopped nor observed; for a Codex
coordinator the launch precondition only checks the pane's cwd (Herdr reports no
session for it) and warns, and the acknowledgement proves the command ran in the
recorded pane or thread, not that the recorded session is still alive; a launched
session runs under the user's own permission mode, so its one command may raise
an approval prompt in its visible pane that only the user answers; the
checkpoint text is coordinator-authored and digest-pinned but is printed to the
successor model as briefing, so it must not contain instructions you would not
give it.

Exit codes are 0 for a successful read/plan/apply, 1 for a core refusal,
conflict, stale epoch/revision or uncertainty, and 2 for invalid
request/options.

## Explicit recovery

```sh
pappra collab recovery inspect --task-root /abs/tasks/<task-id> [--json]
pappra collab recovery reconcile --task-root /abs/tasks/<task-id> \
  --request /abs/request.json [--apply] [--json]
pappra collab recovery lock-break --task-root /abs/tasks/<task-id> \
  --request /abs/request.json [--apply] [--json]
```

Results use `pappra/collaboration-recovery/1`; mutations use the strict
`pappra/collaboration-recovery-request/1` schema. Request JSON is bounded at
1 MiB through the shared special-file-safe loader; no public clock override or
raw evidence body is accepted.

`inspect` is read-only. It reports task/revision/current coordinator epoch,
bounded open/resolved uncertainty summaries with full counts and omission, the
task write-lock/transaction observation and a stable content fingerprint. The
fingerprint hashes sorted lock entry names and bounded regular-file bytes; PID
liveness is a separate observation and is not part of content identity. Exit 1
when open uncertainty, interrupted transactions or an unavailable/oversized lock
snapshot needs attention; a clean state exits 0. A live PID is not execution
ownership or stop proof.

`reconcile` names one uncertainty, a nonempty resolution and explicit
`resolution_evidence` reference, with current `owner_epoch` and optional
`expect_revision`. An optional `set_state` applies the existing transition for
the uncertainty entry's exact subtask/attempt. Resolution and transition run in
one guarded transaction: an invalid/denied transition, missing attempt context or
approval boundary refuses the entire operation, so the resolution is not
committed first. Resolution is the caller's recorded conclusion, not a Pappra
native query or proof. It does not auto-release claims, clear `cancel_pending`
or invent stop/completion evidence. An unexpected reconcile transaction exception
is reported conservatively as `reconcile_uncertain`: the record commit may
already have happened even if ledger evidence failed. Inspect the task record and
ledger before any explicit retry; no automatic rollback, retry or second journal
is created.

`lock-break` requires explicit actor, current epoch, nonempty reason,
`confirm_holder_stopped: true` and the exact `expected_lock_fingerprint` from
`inspect`; the confirmation is a caller assertion, never supplied by Pappra.
Plan validates request/namespace only and writes nothing. Apply revalidates task
identity, nested namespace, epoch and the exact lock fingerprint immediately
before the existing `breakLock`; a changed lock or unavailable snapshot is
refused. The old lock directory, holder, transaction evidence and break record
are archived without overwriting prior archives, deleting unknown evidence or
reclaiming by age. If a filesystem failure may occur after archiving, the result
is reported as uncertain rather than success. This recovers only the task write
lock, not the resource-domain lock or a running execution.

Exit codes are 0 for success/clean read/plan, 1 for needs-input/refusal/
uncertainty, and 2 for invalid request/options.

## Portable task bindings

```sh
pappra collab binding list [--root /abs/workspace] [--json]
pappra collab binding resolve --task-id <alias> [--root /abs/workspace] \
  [--roots /abs/roots.json] [--json]
pappra collab binding bind --task-id <alias> --record /abs/task/task.json \
  [--root /abs/workspace] [--apply] [--json]
pappra collab binding unbind --task-id <alias> [--root /abs/workspace] [--apply] [--json]
```

`--root` selects a registered workspace using the existing nearest-workspace
resolution; without it the current cwd is used. There is no home scan and an
incomplete `.pappra` marker never falls back to an outer workspace. The alias is
the collaboration 128-character safe segment rule and may differ from the
record's protocol `task_id`.

The index is workspace-local
`<workspace>/.pappra/local/collab-bindings.json`, schema
`pappra/collaboration-bindings/1`, tied to the selected `workspaceId`. It stores
only alias/record paths, canonical task/domain roots, protocol task ID, domain
identity, immutable record `created_at` and bind time. It never copies messages,
results, claims, transcripts, prompts or runtime cards. Missing index means an
empty table; a present invalid, unreadable, unsafe or oversized index fails
closed and is never overwritten or bypassed.

The same 1 MiB ceiling applies to exact serialized publications: bind/unbind
returns `bindings_capacity` before index replacement if the new bytes exceed the
limit; previous bytes and every pointer/tombstone stay intact. Pappra never drops
entries to fit.

An alias present in both `bindings` and `unbound` makes the index invalid for
every action; the bytes are preserved and resolution never falls through to
discovery. A valid tombstone is removed only by a later explicit bind.

`bind` validates the target as a real authoritative record before writing:
absolute `<task_root>/task.json`, schema/layout/domain/task identity, safe
protocol task ID, immutable `created_at`, and a regular bounded file. Normal
record transactions may replace the file and increase revision; these do not
change the binding identity. Reinitialization at the same path, a different
target or a changed identity is a conflict until explicit `unbind`. Binding the
same canonical target through another supported alias updates only the stored
path; the same path/identity is unchanged. Plan is default and writes nothing;
`apply` serializes through the existing private-state lock, rereads the index,
revalidates the target and publishes atomically. Busy/stale locks are never
reclaimed by age.

`unbind` never reads or mutates the target; it removes the pointer and keeps an
explicit tombstone (including previous pointer metadata), so discovery and stale
metadata cannot resurrect it. Repeated unbind is idempotent; a later explicit
bind clears the tombstone. Corrupt metadata remains byte-for-byte unchanged on
refused operations, and aliases such as `constructor`/`toString` are handled as
own properties.

`resolve` precedence is fixed:

1. present invalid index → fail with no target/fallback;
2. explicit binding → exclusive; missing/malformed/identity-changed target is
   reported without a usable snapshot and without another record;
3. tombstone → `unbound`, no discovery;
4. explicit `--roots` → bounded array (≤32) of absolute collaboration domain
   roots, inspecting only `<root>/tasks/<alias>/task.json`; canonical candidates
   are deduplicated, exactly one resolves, multiple are ambiguous, and any
   unavailable/unreadable root or candidate makes discovery incomplete/unknown;
5. otherwise `none`.

Discovery never reads private atlas manifests, home registries or arbitrary
directories and never persists a discovered target. A usable target reports
persisted `state_revision`, coordinator epoch, freeze, bounded attempt identities
and counts with `scope: "persisted-history"` and `liveStatus: "unknown"`; it does
not prove a native execution is running, stopped or accepted. `list`/`resolve`/
plan are read-only. Exit 0 for a clean read/plan/usable/unbound/none result, 1
for unusable targets, conflict, ambiguity or incomplete discovery, and 2 for
invalid workspace/options or corrupt metadata.

Every action emits one versioned JSON result
(`pappra/collaboration-binding-result/1`) with `--json`; human output is a
summary of the same fields. Examples, run from an unrelated directory with an
explicit workspace root:

```sh
cd /tmp
pappra collab binding bind --root /abs/ws --task-id workspace-experience \
  --record /abs/domain/tasks/workspace-experience/task.json
# Bind plan validates the alias, target and index; nothing was written.
pappra collab binding bind --root /abs/ws --task-id workspace-experience \
  --record /abs/domain/tasks/workspace-experience/task.json --apply
# Bind bound; applied true.
pappra collab binding resolve --root /abs/ws --task-id workspace-experience
# Alias workspace-experience: binding (usable true).
#   record: /abs/domain/tasks/workspace-experience/task.json revision 12; …
#   attempts: 1; scope: persisted-history; live status: unknown
pappra collab binding resolve --root /abs/ws --task-id workspace-experience \
  --roots /abs/roots.json
# Same exclusive binding result; explicit roots are only consulted when unbound.
pappra collab binding unbind --root /abs/ws --task-id workspace-experience --apply
# Unbind unbound; applied true.
pappra collab binding resolve --root /abs/ws --task-id workspace-experience
# Alias workspace-experience: unbound (usable false).
```

Without `--root`, the caller's nearest registered workspace is used; a caller
outside any workspace fails with `workspace_unavailable` (exit 2) instead of
scanning home or an outer registry.

## Limits

- No polling, timers, sequential status inspection, or blocking `--wait`.
- No daemon, scheduler, parallel task store, automatic retry or automatic pane
  manager.
- Notification is a transport event, not proof of consumption, execution, stop or
  acceptance.
- `read`/`list`/plan do not spawn Herdr and do not write task bytes.
- Secrets, transcripts and prompt bodies are never placed in a notification.
- Pane selection is task-bound routing, not sender authentication or process
  affiliation; hosted agents (for example Codex under a launch daemon) are
  supported, and no ancestry claim is required or made.
- Envelope identities and request actor/epoch fields are cooperative protocol
  inputs, never authenticated caller credentials.
- Collaboration task ids keep the 128-character wire rule; continuity and
  task-pin identifiers are unaffected.
