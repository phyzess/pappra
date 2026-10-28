# Typed collaboration workflow

`pappra collab workflow` is the orchestration facade for a task-scoped cohort:
one declared request document per step replaces hand-built envelopes, manual
digest bookkeeping and ad-hoc ACK/REPORT/accept clients.

It is a facade, not a second authority. Attempts, claims, messages, capability
cards, results and acceptances stay in `task.json` and are reached through the
existing engines: `transact`, `upsertAssignment`, `registerMessage` +
`applyMessage`, `claimResources`, `releaseClaim` and the work-plan evaluator.
Every action is either a read-only plan (no document is sealed, no claim is
made, no message is registered, nothing is notified) or an explicit `--apply`
write, and no action ever launches a session, consumes a notification or proves
execution.

## Cohort roles

The coordinator assesses the work, plans, writes briefs, dispatches, accepts
or rejects reports, and runs the single final integration gate. It does not
implement repository source itself: implementation and review are done by
other participants, visible Pi peers by default, and small trivially-local
edits are not exempt for repository source. The coordinator edits only
coordination artifacts (briefs, request JSON, scratch) directly; if no capable
participant can be launched it reports the exact blocker instead of
implementing.

When the coordinator starts Pi participants it picks a suitable GLM or Kimi
model explicitly (`--provider openrouter --model moonshotai/kimi-k2.7-code`
for code work, `~z-ai/glm-latest` for general work, or `moonshotai/kimi-k3`
for long-context review) and never falls back to a default model silently. A
bootstrap request pins the same choice through `selected_model.openrouter_model`.

## Commands

```sh
pappra collab workflow <prepare|dispatch|ack|report|accept|await|release|reclaim|adopt|inspect> [options]
  prepare  --request <abs prepare.json> [--apply] [--json]
  dispatch --request <abs dispatch.json> [--apply] [--json]
  ack      --request <abs participant.json> [--apply] [--json]
  report   --request <abs participant.json> [--apply] [--json]
  accept   --request <abs accept.json|accept-batch.json> [--apply] [--json]
  await    --request <abs await.json> [--json]
  release  --request <abs participant.json> [--apply] [--json]
  reclaim  --request <abs reclaim.json> [--apply] [--json]
  adopt    --request <abs adopt.json> [--apply] [--json]
  inspect  --task-root <abs task root> [--limit <1-500>] [--json]
```

`--goal` is accepted as an alias for `--request` on `prepare`.

The family parses its own argv and is routed before the global option parser
(see [CLI routing](cli-routing.md)), so request documents never mix with the
global flag surface. Exit codes: `0` when the result is `ok` (a plan that is
genuinely `planned`, an `applied` write, an `await` that is `decided`); `1` for
every non-ok result — `blocked`, `refused`, `needs-reconciliation`, `timeout`,
`invalid`; `2` for invalid arguments or an invalid request document.

`await` has nothing to apply: it only reads, so it accepts and ignores
`--apply`. It exits `0` only for `decided`; a `timeout` exits `1` with status
`timeout`, so `await && release` never releases without a decision — see
[Awaiting the decision](#awaiting-the-decision).

## Request documents

All documents are validated strictly before any effect: exact key set, bounded
strings, absolute paths, `sha256:` digest shape and safe identifiers. Unknown
fields are refused rather than ignored.

- `pappra/collab-workflow-prepare-request/1` — goal, observed coordinator,
  observed participants and bindings, one entry per subtask with objective,
  acceptance, disjoint resources, required skills/tools and native evidence
  sources, plus the runner profile.
- `pappra/collab-workflow-dispatch-request/1` — task root, coordinator caller,
  observed caller pane, one capability _target_ per attempt, optional subtask
  filter, `activate_deferred` and a `max_age_minutes` bound that may only
  tighten the shared 30-minute default. A target is either an explicit
  `capabilities_file` or `template_file` plus the observed native source
  (`session_file` for pi, or `events_file` plus `execution_file` for codex or
  claude), which is derived into a fresh card at dispatch time.
- `pappra/collab-workflow-participant-request/1` — action (`ack`, `report`,
  `release`), caller, subtask, attempt, an optional observed `caller_pane` and
  either a report declaration or a release declaration.
- `pappra/collab-workflow-await-request/1` — task root, the participant caller,
  subtask, attempt, an explicit `timeout_seconds` (integer 0–600; above the
  maximum is refused, never clamped) and an optional `poll_interval_seconds`
  (integer 1–60, default 5). The identity fields are validated exactly like the
  participant request's.
- `pappra/collab-workflow-accept-request/1` — coordinator caller, subtask,
  attempt, the report message id being decided and a reason. It deliberately
  carries no plan or node id: both are resolved from the sealed work plan.
- `pappra/collab-workflow-accept-batch-request/1` — the same coordinator caller
  with 1–32 `accepts` entries (subtask, attempt, report message id, reason),
  each naming a distinct attempt. `accept --request` selects the document by its
  `schema` field.
- `pappra/collab-workflow-reclaim-request/1` — coordinator caller and task root
  only. It names no pane; eligibility is derived from the record.
- `pappra/collab-workflow-adopt-request/1` — task root, coordinator caller, the
  caller's own pane and optional `extra_paths` (see [Coordinator succession and
  adoption](#coordinator-succession-and-adoption)).

A `bindings` entry may also name the coordinator. The sealed binding then holds
exactly one coordinator entry (never a second one when the coordinator is also a
declared participant). Without it dispatch refuses every ASSIGN with
`binding_sender_missing`, because the notifier requires the sender to be
described by the binding.
A binding entry may optionally carry `herdr_agent`: the live Herdr agent name for that participant when it differs from `agent_id`. The default is `agent_id`, so existing requests stay byte-identical. Duplicate `herdr_agent` values across bindings are refused at plan time.

A minimal prepare request with placeholders only — no real identity, path or
observed evidence is implied:

```json
{
  "schema": "pappra/collab-workflow-prepare-request/1",
  "domain_root": "/absolute/path/to/domain",
  "task_id": "example-task",
  "goal": {
    "objective": "One bounded objective.",
    "input_ref": null,
    "input_digest": null
  },
  "coordinator": {
    "agent_id": "coordinator-id",
    "session_id": "coordinator-session",
    "harness": "pi",
    "owner_epoch": 1,
    "since": "1970-01-01T00:00:00.000Z",
    "cwd": "/absolute/path/to/domain/tasks/example-task",
    "surface": "cli",
    "configuration_id": "daily-visible"
  },
  "participants": [
    {
      "agent_id": "writer-id",
      "session_id": "writer-session",
      "harness": "pi",
      "cwd": "/absolute/path/to/repository",
      "surface": "cli",
      "configuration_id": "daily-visible"
    }
  ],
  "bindings": [],
  "assignments": [
    {
      "subtask_id": "write-docs",
      "role": "writer",
      "assignee": "writer-id",
      "objective": "Update the declared document.",
      "acceptance": ["The declared document is updated."],
      "resources": [
        {
          "path": "/absolute/path/to/repository/docs/example.md",
          "access": "write"
        }
      ],
      "required_skills": [],
      "required_tools": [],
      "native_evidence": []
    }
  ],
  "runner": { "name": "pi-cli", "mode": "native-session", "profile": "daily" }
}
```

Run `pappra collab workflow prepare --request <file> --json` for the read-only
plan, then the same request with `--apply` to seal it. Replace every placeholder
with the identities and paths of your own cohort.

## What prepare derives

`prepare` declares a goal once and derives everything the protocol repeats:

- `workflow/manifest.json` — immutable input/reference bookkeeping: goal, input
  revision, coordinator identity, participants, bindings and per-assignment
  digests, resources, derived resource keys and deferral state. It is never
  rewritten; a different derived manifest is a conflict, not an update.
- `workflow/goal.json` — the derived goal document, used as the pinned input
  when the request declares no external input file. Assignment `inputs` always
  pin real bytes; a native session log is mutable observation input and never an
  assignment input.
- `workflow/work-plan.json` — the sealed `pappra/collab-work-plan/1` projection
  derived from the assignments. It is the only source of node identity and
  dependencies used for acceptance evaluation.
- `workflow/assignments/<subtask>.json` — the sealed
  `harness-collab/assignment/1` document, created once with `wx`. Resources
  carry the `resource_epoch` actually held by the claim. A rerun whose derived
  declaration differs is refused as `sealed_input_conflict`.
- `messages/assign-<subtask>.json` — the derived ASSIGN envelope. The message id
  is deterministic, so a rerun is a protocol duplicate instead of a second
  ASSIGN.
- Resource claims stamped with the assignee's identity and the assignment's
  subtask id and attempt, taken for the sealed footprint. Deferred reviewers
  claim nothing yet (below).

This workflow keeps two digests apart on purpose:

| Digest               | Covers                                                       | Used for                                                                                                         |
| -------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| declaration identity | the normalized document, with `resource_epoch` projected out | plan ↔ sealed ↔ rerun idempotence, before any claim exists                                                       |
| wire pin             | the SHA-256 of the exact sealed file bytes, epochs included  | `assignment_digest` in the ASSIGN body, the stored attempt, the applied manifest, and every admission comparison |

The ASSIGN's `assignment_digest` is the wire pin. Launch admission re-reads the
sealed file through a bounded, no-follow read and compares those exact bytes, so
a document whose only change is one `resource_epoch` is refused — the epoch is
never normalized away on the wire. A read-only plan cannot promise the wire pin,
so it reports `declaration_digest` plus an explicitly null `assignment_digest`
and `message_digest` until the bytes are sealed.

Each declared resource may also carry an explicit `scope`:

```json
{
  "path": "/absolute/path/repo/src/module.ts",
  "access": "write",
  "scope": "file"
}
```

`scope` is optional and conservative. Absent means `tree`: a write claim on that
path also reserves the derived Git index/HEAD resources, so two writers in one
checkout conflict. An explicit `file` claims exactly that path and derives no
Git reservation, which is what lets two disjoint file-scoped writers prepare and
run in the same Git checkout. Pappra never guesses that a path is a file from
its name; only the declaration decides. The derived `.git/index` and `.git/HEAD`
resources stay claim-only and are not part of the sealed declaration.

Duplicate declarations of one canonical target are canonicalized to a single
entry, preserving first-occurrence order. The same target declared with two
different access levels is refused before any effect. After canonicalization an
assignment may hold at most 16 resources, the work-plan node bound; exceeding it
is refused, never truncated.

Reviewer assignments are sealed but neither registered nor claimed: their ASSIGN
and read claims stay deferred until accepted writers release. A reviewer cannot
declare a `write` resource: deferred assignments are sealed without real
resource epochs, so such a request is refused at plan time. Use a writer-role
assignment when the assignee must write a review file.

## What apply validates first

Apply re-derives the plan and refuses when anything is wrong, before writing:

- the task exists with a different coordinator identity or epoch;
- an attempt for the subtask is already registered outside `assigned`;
- a sealed assignment no longer matches the derived bytes;
- writer write scopes overlap each other;
- any claim in the domain conflicts, including derived Git resources and
  unreadable task records (unknown ownership is never treated as free).

Prepare also refuses read/write overlap between different non-deferred assignments at plan time (`assignment_scope_overlap`): if one assignment writes a path and another non-deferred assignment reads the same path, the plan is blocked with both subtasks, both paths and which side reads/writes in the message. Read/read overlap stays allowed, and deferred reviewers are exempt. Apply never takes any claim when the plan would have refused.

Only then does it initialize the task, seal documents, stamp the input revision,
register ASSIGN messages and claim footprints. A partial run reports
`needs-reconciliation` with a concrete next action; a later apply reuses what is
already sealed and held.

## Dispatch

Dispatch is a coordinator action. Immediately before notifying it re-reads the
record, resolves the capability target and judges readiness with the shared
`preflight` contract — never a second, weaker implementation. It refuses when:

- the caller is not the current coordinator;
- the attempt is not dispatchable or holds no active claim;
- there is no capability target for the attempt;
- a derived card cannot be produced from the declared observed source, or the
  supplied card is not a valid card;
- preflight blocks it: assignee identity, realpath cwd, a stale or future
  observation, `evidence_level` other than `runtime`, a required capability
  omitted by the runner, or an unready skill/tool whose evidence or fingerprint
  does not match.

Each attempt gets one durable intent under `workflow/intents/`. A second
dispatch sees the intent and reports `dispatch_already_attempted`; a possibly
delivered notification is never replayed. Delivery status is reported as
recorded, and never implies consumption, execution or acceptance.

Dispatch also derives ready-to-run participant request files for each dispatched attempt under `workflow/participant-requests/<subtask>-<attempt>/`: `ack.json`, `report.json` and `release.json`. They are valid `pappra/collab-workflow-participant-request/1` documents with the assignee as caller, the bound pane as `caller_pane`, the write resources as report `outputs` and the deterministic accept message id as `release.correlates_to`. They are created once with an exclusive write, are digest-stable on rerun, and are never overwritten once present. Edit only the `summary` field of `report.json`; never hand-write a `COLLAB_MESSAGE` line in chat, because that is not a registered message and is never accepted.

A refusal that is provably pre-effect also records a typed
`dispatch-<subtask>-<attempt>.outcome.json` with `effect: "none"` beside the
intent. Provably pre-effect means a binding or message validation failure such
as `binding_sender_missing`, an unavailable Herdr caller or agent list before
any delivery reservation, a final-authority refusal, or a recognized refusal
such as `agent_not_found`; an absent effect signal always counts as possible.
After the cause is corrected, a later dispatch of the same attempt may proceed
and reports the earlier refusal as a warning. The intent is never deleted and
keeps its original evidence fields (card source, digest, state, timestamp); the
attempt identity must still match. An unknown, ambiguous, submitted,
post-reservation, missing, corrupt or self-contradictory outcome keeps
`dispatch_already_attempted`.

A Pi capability card is derived from a settled saved-session snapshot. While the
assignee is mid-turn, for example already working on another assignment,
derivation can be unavailable (`capability_derivation_unavailable`); dispatch
once it is idle. Observations are accepted for at most 30 minutes, so an idle
assignee needs fresh native evidence, such as one more settled turn, before a
later dispatch.

`activate_deferred` registers and claims sealed reviewer assignments only after
the sealed work plan evaluates every other node as `accepted` and every writer
has released its claims, re-derived from the record and the registered decision
envelopes. A completed report, a released claim or a final result is not
acceptance. Activation reuses the delivery path of a writer node: without a
capability target for the reviewer, only its attempt and claims are registered
and nothing is delivered.

## Participant actions

`ack`, `report`, `await` and `release` are self-call only. The request's caller
must equal the registered attempt assignee on agent id, session id and harness;
anything else is `sender_denied`. There is no on-behalf-of path: a coordinator
that submitted a peer identity would fabricate a participant.

For each dispatched attempt the coordinator has already written `workflow/participant-requests/<subtask>-<attempt>/{ack,report,release}.json`. Use those files exactly as given: `node dist/cli/main.js collab workflow ack|report|release --request <file> --apply --json`. A typed `COLLAB_MESSAGE` line in chat is not registered and is never accepted.

- `report` computes output digests from the files that actually exist inside the
  attempt's own write claims. An output outside the claim, or an unreadable
  output, is refused: no digest is invented. A report id is deterministic per
  attempt and content, so an honest resend is a duplicate while a genuinely
  different later report gets its own id. Only an admission classified `applied`
  completes the attempt; a late or superseded report stays evidence.
- `needs_input` requires at least one concrete blocker, so a blocked review
  stays distinguishable from a completed report.
- `release` verifies its correlation first: when `release.correlates_to` names a
  message, it must be a registered coordinator ASK/ANSWER from the current
  coordinator — or, after a succession, from the coordinator of its own epoch
  (see [Coordinator succession and
  adoption](#coordinator-succession-and-adoption)) — and an invented id is
  refused **before** any claim effect. It then records a release intent, frees
  the attempt's own claims, optionally cancels a non-terminal attempt, and emits
  a registered `STATUS` envelope correlated to that decision. It never claims
  acceptance.
- `ack`, `report`, `release` and `accept` carry the observed `caller_pane` and
  deliver once through the durable notification reservation. Persistence and
  delivery are separate facts: an undelivered or ambiguous notification is
  reported as a warning and never rolls the record back, and a duplicate resend
  never wakes the recipient twice.
- `await` is read-only: it never notifies (so it has no `caller_pane`),
  registers no message and touches no claim. See [Awaiting the
  decision](#awaiting-the-decision).

## Acceptance

`accept` is a separate coordinator decision. It refuses a caller that is not the
coordinator, refuses the assignee (self-review), refuses a stale owner epoch and
refuses any report that is not `completed`.

Acceptance first resolves the node from the sealed plan and refuses an unknown
node, a stale plan epoch or a report whose body status is not `completed`; the
work-plan evaluator separately requires the completed applied result. The
emitted `ANSWER` envelope then carries exactly what the work-plan evaluator
re-derives: the plan's `plan_id` and node's `node_id` (never caller-supplied),
`assignment_id`, `attempt`, `input_revision`, the digest of the accepted report
and `decision: "accepted"`, addressed to the assignee and replying to the
report. Dependent work is unlocked only when the work plan re-evaluates that
decision.

When the notification after a recorded decision fails or is not `submitted`
(for example a Codex coordinator, whose sandbox cannot reach the Herdr socket),
the decision stays final and the result's `detail.delivery_fallback` (`reason`,
`worker_next_action`) names what the worker does instead: wait with
`collab workflow await`, then `release`. Batch items carry the same field. If
the exclusive create of the base accept id loses a race to a message registered
under another epoch after a succession, the call retries once with the
epoch-qualified id, only while the caller is still the coordinator at that
epoch.

An accept batch is N explicit decisions in one invocation, not a blanket
approval. Each entry runs through the single-accept path in order: it is
validated, written and notified on its own, and a refused entry neither blocks
nor rewrites its neighbours. The aggregate result is `ok` only when every entry
is; `detail.items` reports each entry's status, and each blocker is prefixed
with its `subtask#attempt`; warnings are prefixed the same way. Re-running a
batch with unchanged reasons is safe because an already-recorded decision is a
protocol duplicate; a changed reason for a recorded decision is refused as a
content conflict. An unexpected failure stops the batch: earlier decisions stay
recorded, later entries are reported `not-attempted` and the aggregate is
`needs-reconciliation`. An empty batch is refused.

## Awaiting the decision

A coordinator that cannot reach the Herdr socket still records its decision, but
it cannot wake the worker: a Codex coordinator runs in a sandbox, and `accept`
then reports a delivery warning ("Operation not permitted"). `await` is the
file-based channel for that case, a bounded wait on the worker side that needs
no Herdr, no pane and no wake-up.

```json
{
  "schema": "pappra/collab-workflow-await-request/1",
  "task_root": "/absolute/path/to/domain/tasks/example-task",
  "caller": {
    "agent_id": "writer-id",
    "session_id": "writer-session",
    "harness": "pi",
    "cwd": "/absolute/path/to/repository"
  },
  "subtask_id": "write-docs",
  "attempt": 1,
  "timeout_seconds": 300,
  "poll_interval_seconds": 5
}
```

`pappra collab workflow await --request <file> --json` observes the persisted
task record and the registered message files once, then every
`poll_interval_seconds`, until a valid accept decision for the caller's own
attempt exists or `timeout_seconds` has passed. The last sleep is cut short so
the wait never overshoots its bound, and `timeout_seconds: 0` observes exactly
once. It reads only `task.json` and `messages/` in the task root: no Herdr, no
pane, no log, no native query. It writes nothing, registers nothing, notifies
nobody and claims nothing, and it is not acceptance — it observes a decision, it
never makes or confirms one, and the work-plan evaluator stays the authority
that unlocks dependent work. `--apply` is accepted and ignored: there is nothing
to apply.

It is self-call only: the caller must equal the registered attempt assignee
(agent id, session id and the harness when one is recorded), otherwise
`sender_denied`; an attempt that was never registered is
`attempt_not_registered`. A task root that cannot be opened, or that changes or
disappears during the wait, is `invalid` and ends the wait, so a swapped
namespace is never followed.

A decision counts only when all of these hold:

- it is an applied `ANSWER` replying to the attempt's current report: the last
  admitted `applied` result of the attempt, which must be `completed`;
- it passes the evidence the release path demands of `release.correlates_to`: a
  regular registered file whose content digest still equals the record's,
  addressed to the caller, task and attempt, signed by the current coordinator —
  or, after a coordinator succession, by the coordinator of its own epoch, with
  that epoch in the lineage and the decision applied at or before the instant
  the epoch ended (an invalid lineage reduces this to the current coordinator
  only);
- its payload is an acceptance for this attempt and this report with
  `decision: "accepted"`.

A decision that was only registered, an informational answer, a rejection, a
decision on another report, or one that fails the evidence never ends the wait.
It is listed in `detail.ignored` (at most 16, with `detail.ignored_total` always
exact) and in `warnings`, each with the first rule it failed. Among the
decisions that pass, the last registered one counts, and one that fails never
blocks it.

`await` uses the same evidence as the release correlation, so `decided` is not
the work-plan evaluator's verdict. The evaluator also checks the sealed plan,
node, input revision and plan epoch, and without a succession it judges the last
applied decision whether or not that decision passes these checks. So `await`
can say `decided` while the evaluator does not accept the node, for example
after an extra decision sent through the lower-level message path. Dependent
work is unlocked only when the work plan re-evaluates the decision (see
[Acceptance](#acceptance)).

| `status`  | `ok`    | Exit | Meaning                                                                                                                                                        |
| --------- | ------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decided` | `true`  | `0`  | A valid accept decision exists. `detail.decision` names it and `messages` lists it; the next action is `release`.                                              |
| `timeout` | `false` | `1`  | No valid decision appeared within `timeout_seconds` (one `await_timeout` blocker). Not a refusal and not a decision: run `await` again or ask the coordinator. |
| `refused` | `false` | `1`  | The caller is not the attempt's participant, or the attempt is not registered.                                                                                 |
| `invalid` | `false` | `1`  | The task could not be read, or changed during the wait. An invalid document or argument is exit `2` and never reaches the wait.                                |

Only `decided` exits `0`, so `await && release` stops at a timeout instead of
releasing without a decision. `timeout`, `refused` and `invalid` all exit `1`:
read `status` to tell a timeout (wait again) from the other two (stop).
`timeout_seconds: 0` observes once and exits `1` unless a decision already
exists. `detail` also carries `report_message_id` (null until a completed report
is admitted, which the `await_timeout` blocker then says), `attempt_state`,
`polls` and `waited_ms`. After `decided`, run `release`; its optional
`release.correlates_to` may cite `detail.decision.message_id`, which the same
evidence rules accept. A release records its intent once per attempt, so cite
the decision on the first release: a later release with a different
`correlates_to` is refused as a conflicting release (`release_status_conflict`
or `release_intent_conflict`).

## Pane reclaim

`reclaim --request <abs reclaim.json> [--apply]` closes panes that Pappra's own
bootstrap split for a worker whose work is finished. `accept` and `dispatch
--apply` run the same sweep automatically; a worker normally releases its claims
after acceptance, so the pane is usually closed by the next dispatch or reclaim,
not instantly. There is no background daemon.

A pane is closed only when all of these hold: the bootstrap reservation
completed and recorded the created pane id/workspace/terminal/cwd; the attempt
completed and the coordinator registered its acceptance; the assignee holds no
unreleased claim and has no other active attempt; and the live pane still
matches the recorded identity and cwd, hosts only the exact assignee session (or
an available shell), is not working or blocked, and is not the caller's pane.
Panes started by hand, reused panes and anything that fails a check are kept and
reported in `detail.pane_reclaim` with a reason. The close intent is recorded
first; an ambiguous close is reconciled, never replayed, while a definite
failure stays retryable.

## Adaptive pane placement

`collab bootstrap` splits panes adaptively so the coordinator pane stays large
instead of being halved for every extra participant. `--ratio` is the fraction
the original pane keeps; the new pane takes the rest. A task-owned sibling is
a pane the task's own launch reservations created (the bootstrap's recorded
`created_pane_id`) that is still present in the current layout.

1. The first split of the caller pane goes `right` with ratio 0.6, keeping the
   coordinator at roughly half the tab width or more. Once a task-owned
   sibling exists, the coordinator pane is never split again.
2. With one or more task-owned siblings, the next sibling splits the largest
   existing sibling (by area; ties go to the earliest created) along its
   longer visual dimension (`right` when its width exceeds twice its height,
   else `down`) at ratio 0.5.
3. Refuse to pick an anchor whose result would be narrower than 40 columns or
   shorter than 10 rows. When no sibling can host another pane and the
   coordinator is at its protected floor, the bootstrap reports
   `pane_layout_exhausted` with a short message telling the host to close or
   reclaim finished panes, or reuse one; it never squeezes the coordinator.
4. An explicit `target.direction` in the request keeps the legacy behaviour
   exactly: split the caller pane in that direction with no ratio. Absence of
   `direction` selects the adaptive policy; no request field is added or
   renamed.
5. Geometry that cannot be read (a Herdr error or an unparsable layout) falls
   back to the legacy caller split with `--ratio 0.6` and direction `right`;
   the launch never fails only because the layout was unreadable.

The post-split identity checks keep holding with any anchor: the new pane must
stay in the caller's workspace, differ from the caller and from the anchor,
have no agent, and match the target cwd. Pane reclaim keeps closing only panes
Pappra itself created; closing a sibling that anchored a later sibling is fine
because Herdr re-flows the tree.

## Coordinator succession and adoption

A coordinator handoff raises `owner_epoch`; the specification of what stays
valid across one is [the mid-cohort succession
spec](mid-cohort-succession-spec.md). Three facade pieces implement it.

**`adopt`** is run by the successor coordinator after the handoff completed. Its
request names the task root, the caller and the caller's own pane. The plan is
read-only; apply writes the next binding generation `binding.e<epoch>.json`
beside the sealed `binding.json` and changes nothing else, so notifications
reach the successor. It refuses unless the caller is the current coordinator,
the lineage is valid and its pane is observed as that session — through the
Herdr agent listing for a Claude or Pi coordinator, or through `CODEX_THREAD_ID`
plus the pane and agent name the launcher recorded for that thread for a Codex
coordinator — and it refuses a task that uses managed Pi, session transition,
rollover or role artifacts. A binding generation that would hold more than 16
participants is refused instead of truncated.

Role plans, role orchestration requests and journals live at caller-chosen
paths, so `adopt` cannot find them by itself. List them in the optional
`extra_paths` of the adopt request (absolute, unique, at most 16). `adopt` reads
each one (bounded, read-only, symlinks refused) and warns, per file, whether it
pins an owner epoch and whether that is the current epoch; a file it cannot read
or recognize is reported as not checked. Findings are warnings, never blockers.
Role-named files next to the task are detected and refused on their own. Without
`extra_paths` the generic warning is unchanged.

`accept` and `dispatch` do not refuse before `adopt`; they warn that
notifications will not reach the successor, so a missed adoption never blocks
the cohort.

**`collab handoff check-mid-cohort`** is the read-only check for handing off
while transferable attempts are still in flight. It classifies every attempt —
acknowledged or running (without an open `registered_not_started` uncertainty),
completed, failed and cancelled are transferable; `assigned`, `needs_input` and
`unknown` are not — blocks on every non-transferable attempt and lists what it
relaxed: in-flight transferable attempts, unaccepted cohort nodes the successor
will decide, and claims tied to a transferable attempt's own subtask and
attempt. A claim without that stamp keeps blocking. The launcher's successor
request can require this mode with `mode: "mid_cohort"` (default `boundary`).

An attempt that only acknowledged keeps blocking `check-mid-cohort`, because an
ACK is not a native observation. The mid-cohort result adds a `reconcile` entry
per such attempt: the open uncertainty, the applied ACK to cite, the exact
`pappra/collaboration-recovery-request/1` document (operator-asserted fields
left as placeholders) and the `collab recovery reconcile` command, and points
the blocker's `next_action` at it. It resolves nothing by itself.

## Inspect

`inspect` is read-only and reports what is actually present: the sealed manifest
and binding digests, attempts with their state, native observation, active claim
count and applied result, deferred assignments, open uncertainty and registered
messages. A missing manifest or binding is reported as absent, never
reconstructed from the request that once produced it.

`inspect` warns `ack_not_registered` for every dispatched attempt whose dispatch intent exists but has no applied ACK message. The warning is read-only, never a blocker, and never starts a timer.

`inspect --limit <1-500>` keeps only the last entries of each projected list
(attempts, messages, open uncertainty, deferred) in record order — the newest
for attempts and messages, declaration order for deferred reviewers so a long
task cannot flood the coordinator's context. `detail.totals` always carries the
full counts and a per-state attempt tally, and `detail.truncated` says which
lists were cut; a truncated list is never presented as complete. Without
`--limit` the output is unchanged apart from those two fields.

## Relationship to lower-level commands

The facade is the preferred entry for a new cohort. The lower-level commands
remain available and unchanged: `collab message <send|list|read|notify>`,
`collab resource`, `collab capabilities derive`, `collab preflight`,
`collab work-run`, `collab role-run`, `collab bootstrap`, `collab transition`,
`collab handoff`, `collab recovery` and `collab state`. Use them when a step
needs a capability the facade does not model — for example a manual resend of one
already-registered pointer, a claim transfer, or a managed-Pi transition. The
facade never weakens those checks and never replays their effects.
