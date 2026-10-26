# Typed collaboration workflow

`pappra collab workflow` is the formal orchestration facade for a task-scoped
cohort. One declared request per step replaces hand-built envelopes, manual
digest bookkeeping and ad-hoc ACK/REPORT/accept clients.

It is a facade, not a second authority. Attempts, claims, messages, capability
cards, results and acceptances stay in `task.json` and are reached through the
existing engines: `transact`, `upsertAssignment`, `registerMessage` +
`applyMessage`, `claimResources`, `releaseClaim` and the work-plan evaluator.

## Commands

```sh
pappra collab workflow prepare  --request <abs prepare.json>       [--apply] [--json]
pappra collab workflow dispatch --request <abs dispatch.json>      [--apply] [--json]
pappra collab workflow ack      --request <abs participant.json>   [--apply] [--json]
pappra collab workflow report   --request <abs participant.json>   [--apply] [--json]
pappra collab workflow release  --request <abs participant.json>   [--apply] [--json]
pappra collab workflow accept   --request <abs accept.json>        [--apply] [--json]
pappra collab workflow inspect  --task-root <abs task root>        [--json]
```

`--goal` is accepted as an alias for `--request` on `prepare`.

The family parses its own argv and is routed before the global option parser,
so request documents never mix with the global flag surface. Without `--apply`
every action is a plan: no document is sealed, no claim is made, no message is
registered and nothing is notified.

Exit codes: `0` planned/applied, `1` blocked/refused/needs reconciliation, `2`
invalid arguments or an invalid document.

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
  filter, `activate_deferred` and a `max_age_minutes` bound that may only tighten
  the shared 30-minute default. A target is either an explicit
  `capabilities_file` or `template_file` plus the observed native source
  (`session_file` for pi, `events_file` for codex), which is derived into a
  fresh card at dispatch time.
- `pappra/collab-workflow-participant-request/1` — action (`ack`, `report`,
  `release`), caller, subtask, attempt and either a report declaration or a
  release declaration.
- `pappra/collab-workflow-accept-request/1` — coordinator caller, subtask,
  attempt, the report message id being decided and a reason. It deliberately
  carries no plan or node id: both are resolved from the sealed work plan.

A `bindings` entry may also name the coordinator. The sealed binding then holds
exactly one coordinator entry (never a second one when the coordinator is also a
declared participant). Without it dispatch refuses every ASSIGN with
`binding_sender_missing`, because the notifier requires the sender to be described
by the binding.

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

- `workflow/manifest.json` — immutable input/reference bookkeeping: goal,
  input revision, coordinator identity, participants, bindings and per-assignment
  digests, resources, derived resource keys and deferral state. It is never
  rewritten; a different derived manifest is a conflict, not an update.
- `workflow/goal.json` — the derived goal document, used as the pinned input when
  the request declares no external input file. Assignment `inputs` always pin
  real bytes; a native session log is mutable observation input and never an
  assignment input.
- `workflow/work-plan.json` — the sealed `pappra/collab-work-plan/1` projection
  derived from the assignments. It is the only source of node identity,
  dependencies and acceptance.
- `workflow/assignments/<subtask>.json` — the sealed
  `harness-collab/assignment/1` document, created once with `wx`. Resources carry
  the `resource_epoch` actually held by the claim. A rerun whose derived
  declaration differs is refused as `sealed_input_conflict`.

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

- `messages/assign-<subtask>.json` — the derived ASSIGN envelope. The message id
  is deterministic, so a rerun is a protocol duplicate instead of a second
  ASSIGN.
- Resource claims for the sealed footprint, taken by the assignee after the
  attempt exists (`requireAssignedHolder`).

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
checkout conflict. An explicit `file` claims exactly that path and derives no Git
reservation, which is what lets two disjoint file-scoped writers prepare and run
in the same Git checkout. Pappra never guesses that a path is a file from its
name; only the declaration decides.

Duplicate declarations of one canonical target are canonicalized to a single
entry, preserving first-occurrence order. The same target declared with two
different access levels is refused before any effect. After canonicalization an
assignment may hold at most 16 resources, the work-plan node bound; exceeding it
is refused, never truncated. Derived `.git/index` and `.git/HEAD` resources stay
claim-only and are not part of the sealed declaration.

Reviewer assignments are sealed but neither registered nor claimed: their ASSIGN
and read claims stay deferred until accepted writers release. A reviewer cannot
declare a `write` resource: deferred assignments are sealed without real resource
epochs, so such a request is refused at plan time. Use a writer-role assignment
when the assignee must write a review file.

## What apply validates first

Apply re-derives the plan and refuses when anything is wrong, before writing:

- the task exists with a different coordinator identity or epoch;
- an attempt for the subtask is already registered outside `assigned`;
- a sealed assignment no longer matches the derived bytes;
- writer write scopes overlap each other;
- any claim in the domain conflicts, including derived Git resources and
  unreadable task records (unknown ownership is never treated as free).

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

Each attempt gets one durable intent under `workflow/intents/`. A second dispatch
sees the intent and reports `dispatch_already_attempted`; a possibly delivered
notification is never replayed. Delivery status is reported as recorded, and
never implies consumption, execution or acceptance.

A refusal that is provably pre-effect also records a typed
`dispatch-<subtask>-<attempt>.outcome.json` with `effect: "none"` beside the
intent. Provably pre-effect means a binding or message validation failure such as
`binding_sender_missing`, an unavailable Herdr caller or agent list before any
delivery reservation, a final-authority refusal, or a recognized refusal such as
`agent_not_found`; an absent effect signal always counts as possible. After the
cause is corrected, a later dispatch of the same attempt may proceed and reports
the earlier refusal as a warning. The intent is never deleted and keeps its
original evidence fields (card source, digest, state, timestamp); the attempt
identity must still match. An unknown, ambiguous, submitted, post-reservation,
missing, corrupt or self-contradictory outcome keeps `dispatch_already_attempted`.

A Pi capability card is derived from a settled saved-session snapshot. While the
assignee is mid-turn, for example already working on another assignment,
derivation can be unavailable (`capability_derivation_unavailable`); dispatch once
it is idle. Observations are accepted for at most 30 minutes, so an idle assignee
needs fresh native evidence, such as one more settled turn, before a later
dispatch.

`activate_deferred` registers and claims sealed reviewer assignments only after
the sealed work plan evaluates every other node as `accepted`, re-derived from
the record and the registered decision envelopes. A completed report, a released
claim or a final result is not acceptance.

## Participant actions

`ack`, `report` and `release` are self-call only. The request's caller must equal
the registered attempt assignee on agent id, session id and harness; anything
else is `sender_denied`. There is no on-behalf-of path: a coordinator that
submitted a peer identity would fabricate a participant.

- `report` computes output digests from the files that actually exist inside the
  attempt's own write claims. An output outside the claim, or an unreadable
  output, is refused: no digest is invented.
- `needs_input` requires at least one concrete blocker, so a blocked review stays
  distinguishable from a completed report.
- `release` verifies its correlation first: when `release.correlates_to` names a
  message, it must be a registered coordinator ASK/ANSWER from the current
  coordinator, and an invented id is refused **before** any claim effect. It then
  records a release intent, frees the attempt's own claims, optionally cancels a
  non-terminal attempt, and emits a registered `STATUS` envelope correlated to
  that decision. It never claims acceptance.
- `ack`, `report`, `release` and `accept` carry the observed `caller_pane` and
  deliver once through the durable notification reservation. Persistence and
  delivery are separate facts: an undelivered or ambiguous notification is
  reported as a warning and never rolls the record back, and a duplicate resend
  never wakes the recipient twice.

## Acceptance

`accept` is a separate coordinator decision. It refuses a caller that is not the
coordinator, refuses the assignee (self-review), refuses a stale owner epoch and
refuses any report that is not `completed`.

Acceptance first resolves the node from the sealed plan and refuses an unknown
node, a stale plan epoch or a report that is not the completed applied result.
The emitted `ANSWER` envelope then carries exactly what the work-plan evaluator
re-derives: the plan's `plan_id` and node's `node_id` (never caller-supplied),
`assignment_id`, `attempt`, `input_revision`, the digest of the accepted report
and `decision: "accepted"`, addressed to the assignee and replying to the report. Dependent work is unlocked only when the
work plan re-evaluates that decision.

## Inspect

`inspect` is read-only and reports what is actually present: the sealed manifest
and binding digests, attempts with their state, native observation, active claim
count and applied result, deferred assignments, open uncertainty and registered
messages. A missing manifest or binding is reported as absent, never
reconstructed from the request that once produced it.

## Relationship to lower-level commands

The facade is the preferred entry for a new cohort. The lower-level commands
remain available and unchanged: `collab message <send|list|read|notify>`,
`collab resource`, `collab capabilities derive`, `collab preflight`,
`collab work-run`, `collab role-run`, `collab bootstrap`, `collab transition`,
`collab handoff`, `collab recovery` and `collab state`. Use them when a step
needs a capability the facade does not model — for example a manual resend of one
already-registered pointer, a claim transfer, or a managed-Pi transition. The
facade never weakens those checks and never replays their effects.
