# Collaboration messages and notification

Status: implemented in C0 over the existing `harness-collab` protocol. This is
the supported replacement for the temporary task-local bootstrap helper.

Before these commands can reach anyone, the operator or agent must choose the
environment and ensure the receiving instance exists. The shipped skill's
`references/environment.md` documents that entry path: direct versus visible
Herdr operation, one bounded read-only discovery contact for a newly started
peer, authorized sibling-pane bootstrap versus exact-peer reuse, task-local
`pappra/collab-binding/1` routing metadata, readiness, and the proactive
no-polling return. Note that `pappra collab prepare` is not plan-only: it writes
task/prepared state, claims resources and registers the initial `ASSIGN`, which
should be read and notified rather than duplicated. `message send` and `notify`
plan by default. `notify` assumes a bound recipient already exists; it never
starts or discovers one. A pane is routing/visibility evidence, not native
ownership or process authentication.

## Purpose

Two agent sessions can exchange task-scoped protocol messages without a daemon,
a scheduler, or model polling:

```sh
pappra collab message send   --task-root <abs> --message <abs-envelope.json> [--apply]
pappra collab message list   --task-root <abs> [--limit <1-100>]
pappra collab message read   --task-root <abs> --message-id <id>
pappra collab message notify --task-root <abs> --message-id <id> \
                             --binding <abs-binding.json> [--apply] [--retry]
```

All commands require an explicit absolute `--task-root`. Nothing is inferred
from the current directory or from prose. `--json` returns
`pappra/collaboration-message/1`.

Five facts stay distinct and are never collapsed:

1. **persisted** — `send --apply` registered and applied the envelope through
   `submitMessage` (record, message file, ledger).
2. **notified/submitted** — `notify --apply` handed one pointer line to a named
   Herdr agent; `delivery: submitted` only says the prompt was accepted.
3. **consumed/acknowledged** — the recipient's own `ACK` message.
4. **reported** — the recipient's `REPORT` message and stored result.
5. **accepted** — the coordinator's explicit decision, outside this surface.

Every JSON result carries `consumed: false` and `taskAccepted: false` for the
message operations; `send` also returns `delivery: "persisted-not-notified"`.

## Task-root validation

`openMessageTask` proves the root is `<domain>/tasks/<task-id>` with a real
`task.json`, a real `messages/` directory, no final-component symlinks, and a
record whose `task_id`/`task_root`/`domain_root` match. A system-level ancestor
symlink (for example `/var` on macOS) is resolved, but the domain entry itself,
the `tasks` parent, the task root, messages directory and record must be real:
a symlinked domain, `tasks` parent, task root, messages directory or record
fails closed. Message ids are single path segments
(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`), so `..` and separators are refused before
a path is built.

## Send

- Plan-only by default: parse, validate the envelope, check task/record identity
  and the target registration path, and write nothing.
- `--apply` reports the protocol outcome: `accepted`, `duplicate` (same id and
  content, no second side effect), `conflict` (same id, different content), or
  `rejected` with the protocol reason.
- Returns the registered message path and SHA-256 of the file.
- Never notifies anyone and never claims native delivery or task acceptance.

## Notify

- Only forwards an **already registered** message pointer:
  `COLLAB_MESSAGE task=<id> type=<type> message=<abs path> digest=sha256:<file digest>`.
  No body, transcript, prompt or report text is included.
- Requires a task-local binding (`pappra/collab-binding/1`); see
  `skills/pappra/references/collaboration.md` for the document shape.
- Two routing modes, neither of which authenticates the sender:
  - **current context (default):** requires the Herdr marker and a nonempty
    inherited `HERDR_PANE_ID` before `pane current --current`. Missing context
    refuses with `herdr_caller_unverified` and a `--caller-pane` hint; stale or
    inconsistent IDs fail visibly. It never resolves through focus.
  - **explicit task-bound (`--caller-pane <id>`):** uses
    `pane current --pane <id>` without changing the environment or using focus.
    Stale inherited IDs do not override it. The pane is a routing candidate, not
    process proof.
- Validates both participants against the binding, message and live observations:
  the binding must contain sender and recipient; the selected pane must equal the
  sender binding pane; sender/recipient live name, pane, harness and cwd must
  match; sender and recipient sessions are compared exactly when Herdr reports
  them. A null binding session never disables comparison with the message's
  explicit session. Missing session stays `unknown` (for example Codex).
- Process affiliation is **not established** by pane selection. Recorded caller
  evidence says `process_affiliation: "not-established"`; hosted or detached
  agents whose process tree differs from the pane are supported through the
  task-bound binding, not by ancestry claims.
- Native session evidence is compared exactly, not by substring. For Pi
  (`kind: "path"`) only the final `_<session-id>` segment of the session file is
  the native identity; a different session in an ancestor directory is a
  mismatch. When Herdr reports no session value the result records
  `native_session: "unknown"` rather than a match.
- Runs `herdr agent prompt <name> <text>` with argv only, **no `--wait`**, no
  shell interpolation, no pane creation, no focus changes, and no blocked-agent
  answering.
- The task namespace and registered bytes are revalidated after awaited transport
  work and immediately before any delivery mutation or prompt; a root renamed,
  replaced or redirected in the meantime fails closed without creating state
  outside the task. The registered message is read through one bounded,
  identity-checked reader, so a final symlink, special file, oversized file or
  id/content mismatch is never treated as protocol content.
- Delivery metadata is stored in `<task-root>/notifications/<message-id>.json`.
  A successful submission, a refusal, a blocked target and an unknown outcome are
  recorded distinctly.
- Repeating `notify` after a recorded outcome reports `already_recorded` without
  sending another prompt. An explicit `--retry` repeats the same message identity
  up to 3 recorded attempts (`retry_limit` afterwards). A `submitting`
  reservation (in flight, or crashed before its outcome was recorded) is reported
  as `in_flight_unknown` and is never retried or reclaimed by age; an operator
  must inspect the delivery evidence. Concurrent retries serialize on a
  task-private lock: one reserves, the other is refused without a wakeup.
- Spawn failure before a process exists is `unavailable` (nothing submitted).
  `agent_blocked` is `blocked`; only the explicit recognized pre-submission
  refusal set (`agent_not_found`) is `refused`; `timeout`/`agent_prompt_stalled`
  are `unknown`. Any other error envelope — including an unrecognized code from a
  future Herdr version — is `unknown` with the code preserved, because a parseable
  error does not prove the command stopped before submitting. There is no
  automatic resend.


## Native capability evidence

`pappra collab capabilities derive --harness <pi|codex|claude> --assignment <abs assignment.json> --template <abs card.declared.json> --execution <abs execution.json> [--session <abs pi-session.jsonl> | --events <abs events.jsonl>] [--json]`
derives a runtime capability card from saved native evidence using the maintained
Pi, Codex and Claude adapter semantics. It is read-only: deriving writes no file,
launches no process, spends no model turn, authenticates nothing and dispatches
nothing. Pi requires `--session`; Codex and Claude require `--events`; other host
options, duplicate flags and unknown flags are rejected. Exit codes are `0`
derived, `1` needs_input, `2` invalid request/configuration. JSON results use
`pappra/collaboration-capabilities/1`.

Configuration files are bounded at 1 MiB and each native evidence file at 16 MiB.
All paths must be absolute; final symlinks, FIFOs and other special files are
refused without blocking, with descriptor-level type and size checks and bounded
reads. Diagnostics stay generic and never include evidence content.

Observed semantics are preserved rather than generalized:

- **Pi:** a tool is `verified` only when a recorded call correlates with a
  successful result; a skill is `verified` only when the session actually read
  that skill's `SKILL.md` successfully. Message-level numeric timestamps and
  record-level zoned timestamps are both honored; observation time is the native
  session's own last usable timestamp. Incomplete results and an indeterminate
  `toolUse` turn end are refused.
- **Codex:** only explicitly mapped completed items promote tools
  (`command_execution` → `shell`, `file_change` → `apply_patch`, `mcp_tool_call` →
  `mcp`, `web_search` → `web_search`). `exec --json` does not report skill
  invocation, so skills stay `unknown` and a required skill still blocks
  preflight. Unknown row/item shapes fail closed.
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
command, and the holder has explicit nonempty agent/session identity. A claim
uses the existing canonical resource kinds and access semantics:

```json
{
  "schema": "pappra/collaboration-resource-request/1",
  "action": "claim",
  "holder": { "agent_id": "worker", "session_id": "session-1", "harness": "pi" },
  "resources": [{ "kind": "path", "path": "/abs/target" }],
  "access": "write",
  "include_shared_git": false
}
```

A release names one `claim_id` and the same holder; there is no unowned or mass
release. Request JSON is bounded at 1 MiB and read through the special-file-safe
loader. Without `--apply`, a plan validates only the strict request and the task
namespace: it creates no reservation, lock, transaction or claim. With `--apply`,
the namespace is revalidated and exactly the existing `claimResources` or
`releaseClaim` primitive runs. This is cooperative record mutation, not OS
fencing or proof that another process stopped.

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
uncertainty or a core refusal, and 2 for invalid request/options. Tests and
examples use fresh fixture domains; they never release or alter live
collaboration claims.

## Recorded ownership handoff

```sh
pappra collab handoff inventory --task-root /abs/tasks/<task-id> \
  [--subtask-id <id>] [--attempt <positive>] [--json]

pappra collab handoff <begin|stopped|rebind|transfer|confirm|complete|abort|release-dispatch> \
  --task-root /abs/tasks/<task-id> --request /abs/request.json [--apply] [--json]
```

Handoff requests use `pappra/collaboration-handoff-request/1`; the action must
match the command. Every mutation carries an explicit actor identifier, a
positive current `owner_epoch` and an optional `expect_revision` for the existing
transaction revision check. These editable fields are protocol inputs, not
caller authentication. Request JSON is bounded at 1 MiB and read through the
shared special-file-safe loader. No clock override or inline confirmation
envelope is accepted.

A writer `begin` names `handoff_id`, `kind`, exact `from`/`to` identities,
resource claim ids and the writer subtask/attempt. A coordinator `begin` uses
`kind: "coordinator"` and moves coordinator ownership. Later actions map directly
to the maintained primitives:

- `stopped`: explicit observation and evidence ref; unknown stop refuses.
- `rebind`: explicit receiver identity and evidence ref; refused after confirmation.
- `transfer`: bounded inventory arrays recorded as data, not approval authority.
- `confirm`: only a registered `confirmation_message_id`.
- `complete`, `abort`: existing completion/abort behavior.
- `release-dispatch`: explicit current epoch; completion never releases the freeze automatically.

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
`reply_to` to this handoff without a conflicting body id. A `HANDOFF` confirmation
must use a non-request phase; `confirmation` is the documented phase. Missing,
unregistered, rejected/unapplied, wrong-recipient/session, wrong-epoch, replayed
or unrelated messages cannot authorize a transfer; symlink and FIFO
registrations are refused.

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

Exit codes are 0 for a successful read/plan/apply, 1 for a core refusal,
conflict, stale epoch/revision or uncertainty, and 2 for invalid
request/options.

## Explicit recovery

```sh
pappra collab recovery inspect --task-root /abs/tasks/<task-id> [--json]
pappra collab recovery reconcile --task-root /abs/tasks/<task-id> --request /abs/request.json [--apply] [--json]
pappra collab recovery lock-break --task-root /abs/tasks/<task-id> --request /abs/request.json [--apply] [--json]
```

Results use `pappra/collaboration-recovery/1`; mutations use the strict
`pappra/collaboration-recovery-request/1` schema. Request JSON is bounded at 1 MiB
through the shared special-file-safe loader; no public clock override or raw
evidence body is accepted.

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
native query or proof. It does not auto-release claims, clear `cancel_pending` or
invent stop/completion evidence.
An unexpected reconcile transaction exception is reported conservatively as
`reconcile_uncertain`: the record commit may already have happened even if ledger
evidence failed. Inspect the task record and ledger before any explicit retry; no
automatic rollback, retry or second journal is created.

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
record’s protocol `task_id`.

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

## Readiness preflight

`pappra collab preflight --assignment <abs assignment.json> --capabilities <abs card.json> [--max-age-minutes <n>] [--json]`
runs the existing `preflight` primitive without launching, claiming, mutating a
task record, refreshing evidence or printing file contents. Exit codes are
`0` ready, `1` needs_input, `2` invalid request/JSON/contract/card; `ok` is true
only for `ready`. The default freshness window is 30 minutes; an explicit
positive finite `--max-age-minutes` overrides it. JSON results use
`pappra/collaboration-preflight/1` and preserve reported readiness, task /
assignment / attempt / checked time, errors, blockers, warnings and limits.

Walkthrough before a dispatch:

```sh
# A card observed from a real receiving session (runtime evidence).
pappra collab preflight --assignment /abs/assignment.json \
  --capabilities /abs/card.runtime.json --json

# A declared template is useful for planning only:
pappra collab preflight --assignment /abs/assignment.json \
  --capabilities /abs/card.declared.json --json
# -> needs_input, blocker runtime_capabilities_unconfirmed
```

Do not edit `evidence_level` or otherwise relabel a declared template as runtime.
Derive a runtime card from native evidence with `pappra collab capabilities
derive`, or pass a separately obtained card. `ready` reports only
current reported capability/evidence readiness — it does not authenticate
self-reported facts, authorize dispatch, acquire resources, verify ownership
epochs, launch, prove completion or replace launch admission. Advisory warnings
(for example a write resource whose ownership is not enforced) and limits stay
visible.

## Protocol compatibility

No task-state authority was added.

- Envelope, registration, dedupe, ledger, epoch, freeze, approval, cancellation
  and stale-report rules are the existing ones.
- `ASK` previously existed in the envelope vocabulary but had no apply branch in
  the legacy or current implementation, so it registered and then failed as
  `unsupported_message_type`. C0 adds an evidence-only branch: the message is
  recorded with `state: "recorded"` and changes no attempt state. Clarification
  blocking remains `BLOCK(kind=clarification)`; a correlated `ANSWER` still moves
  that attempt back to `running`; approval answers are still refused.
- Collaboration task ids keep the 128-character wire rule; this change does not
  touch continuity/task-pin identifiers.

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

## Tests

`tests/collab/messages.test.ts` covers plan/no-write, persistence and dedupe,
unsafe ids, record/task mismatch, redirected state, ASK evidence-only behaviour,
clarification/approval/stale-report boundaries, binding and live-metadata
mismatches, one-prompt delivery, duplicate/retry bounds, blocked/unknown/
unavailable outcomes, and crashed-reservation handling. Repair round 1 adds
regressions for a symlinked `tasks` parent, a registered-message symlink, a task
redirect during awaited transport work, exact Pi session identity, an explicit
recipient session with a null binding session, concurrent retries, caller
resolution/stale caller IDs, and ambiguous post-spawn transport outcomes.
C1 adds regressions for missing inherited pane context (no live or focus
resolution), stale-context recovery hints, explicit sender-pane routing with an
unknown session, foreign-pane refusal, missing/mismatched sender binding, live
sender name/pane/harness/cwd/session mismatches, null sender binding sessions,
and plan-only no-query behavior. CLI coverage includes strict `--caller-pane`
validation and notify-only usage.
`tests/collab/preflight.test.ts` and `preflight-cli.test.ts` cover ready results
with advisory warnings/limits, declared and required-capability blockers,
freshness overrides, changed inputs/evidence, identity/schema/JSON errors,
unsafe file kinds, invalid options, no-write immutability, and the installed CLI
from an unrelated cwd with absolute inputs.
`tests/collab/capabilities.test.ts` and `capabilities-cli.test.ts` cover the three
maintained adapters: positive derivation and preflight integration, identity and
cwd mismatches, changed skills, failed/incomplete/unmatched calls, unsupported
stream rows, native-time freshness, non-promotion of unknown evidence, absent
transcript/payload output, no file mutation, FIFO/symlink/oversize refusal,
strict flag validation and the installed CLI from an unrelated cwd.
`tests/collab/task-state-cli.test.ts` and `task-resources-cli.test.ts` cover
read-only show/doctor/epoch projections with no side effects, bounded collection
counts, plan/apply separation, cross-task conflict, holder and cancel-pending
release boundaries, unreadable-domain uncertainty, nested lock/transaction/
ledger/domain-lock and neighboring-record redirects, parallel CLI claims,
worktree Git resources with explicit shared-Git opt-in, strict/oversized/FIFO
inputs, and installed commands from an unrelated cwd using fresh fixture domains.
`tests/collab/task-handoff-cli.test.ts` covers installed writer and coordinator
sequences, plan/read-only effects, unknown stop refusal, accepted/recorded
confirmation correlation and rejection cases, symlink/FIFO confirmation files,
rebind-after-confirmation, overlapping handoffs, stale epoch/revision, claim
release drift, freeze retention/current-epoch release, bounded inventory, nested
redirects, strict/oversized/FIFO requests and separate-process competing begins,
all on fresh fixture domains.
`tests/collab/task-recovery-cli.test.ts` covers read-only inspect with bounded
uncertainty and lock fingerprints, explicit resolution without implicit state,
atomic legal/illegal transition and missing-context refusal, approval and
cancel-pending boundaries, stale epoch/revision, lock archive/break-record
retention, changed and absent locks, oversized snapshots, strict/oversized/FIFO
requests, and separate-process lock-break contention on fresh fixture domains.
Repair regressions additionally assert human plan wording/no-write behavior and
deterministic late-ledger/early-rename transaction faults classified as
`reconcile_uncertain` with committed/uncommitted record evidence.
`tests/collab/bindings-cli.test.ts` covers read-only list/resolve/plan, explicit
bind and tombstone unbind/rebind, protocol-ID/alias differences, normal
revision/inode replacement usability, reinitialized/missing target refusal,
corrupt/symlink/oversize index preservation, explicit-root unique/ambiguous/
incomplete discovery and canonical dedupe, own-property aliases, unsafe
workspace/private paths, strict options, and concurrent independent mutations.
`tests/collab/messages-cli.test.ts` runs the built CLI for the installed-user
path, including plan-only send, `herdr_unavailable`, argument rejection, and help
text. The transport seam keeps all of this deterministic; no model, pane or real
Herdr prompt is exercised by the suite.
