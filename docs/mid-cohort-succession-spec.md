# Mid-cohort coordinator succession (specification)

Status: implemented in steps 4a to 4e (commits `cdd182f`, `cb750f9`, `6ce1257`, `da34206`, `23f1476`, with the
follow-ups in section 9). It is phase 4 of [cross-host coordinator continuity](cross-host-coordinator-continuity.md).

## 1. Problem

A coordinator handoff raises `owner_epoch`. Nothing in the typed workflow, the work-plan
evaluator or the sealed documents knows that the new epoch is the same authority line as the
old one, so a cohort still in progress at the moment of succession cannot be finished by the
successor. Today the only safe handoff point is a cohort boundary, which `collab handoff check`
enforces.

Verified by running the real code (a throwaway test, since deleted): prepare a cohort, let a
writer report, then apply what `completeHandoff` does to the record (new coordinator, epoch + 1).
The new coordinator's `workflow accept` is refused with `acceptance_stale` and
`plan_epoch_stale`.

What breaks after succession (each row checked against the code):

| What breaks | Where | Why |
| --- | --- | --- |
| Accepting a report | `acceptance.ts:104,151` | `attempt.owner_epoch` and the sealed plan epoch must equal the current epoch |
| Evaluating the plan | `work-plan.ts:812,987,1016-1024,1106` | plan epoch must equal the current epoch; an accept envelope must carry the plan's epoch **and be signed by the current coordinator**; attempts must match the plan epoch |
| A worker cancelling its attempt | `messages.ts:254` | `CANCELLED` is in `DISPATCH_TYPES` and is epoch-gated. `ACK`, `BLOCK`, `REPORT`, `STATUS` are **not** epoch-gated and keep working |
| Dispatching or activating work from a sealed assignment | `dispatch.ts:894,895,910,1255-1260,1548` | the sealed assignment's `coordinator` block (old identity, old epoch) is compared with the attempt's epoch and with the current coordinator |
| The goal-based worker path | `admission.ts:273-284`, `collab-work-execution.ts:745-856` | the same sealed-block and epoch equalities (out of scope, section 8) |
| Reclaiming panes | `collab-pane-reclaim.ts:117-127` | the acceptance `ANSWER`'s sender and epoch must equal the current coordinator |
| Re-registering a deterministic message | `envelope.ts:214-266`, ids in `prepare.ts`, `dispatch.ts`, `participant.ts`, `acceptance.ts` | ids carry no epoch; the same id with different bytes is `content_conflict` |
| Notifications | the sealed `workflow/binding.json` passed by `accept`, `dispatch`, participant actions | it names the old coordinator's pane |

Re-stamping is not an option. The old coordinator's identity and epoch are baked into sealed
documents (each assignment's `coordinator` block; the ASSIGN message's `assignment_digest`, which
pins the exact sealed bytes). Rewriting an epoch would change those bytes and falsify history.

## 2. Goals and non-goals

Goals:

- A successor that completed a coordinator handoff mid-cohort can accept reports, dispatch or
  activate the remaining work, and see workers' messages, with no change to any sealed document,
  registered message or attempt.
- A decision, ASSIGN or CANCEL by a non-current coordinator is refused. Honest limits are in
  section 10.
- Behaviour is identical for every task that has never completed a coordinator handoff.

Non-goals:

- Pi managed sessions, session-transition rollover, role plans, role repair, recovery and the
  goal-based `collab prepare`/`start`/`work-run` path stay exactly as they are (section 8).
- Stopping or observing the old session. The fence is the epoch.
- Authentication. The protocol stays cooperative; this adds no credential.
- A new persisted protocol state or schema.
- Re-issuing or re-delivering an ASSIGN for an attempt that is already registered, across a
  succession. Today a never-started reviewer attempt can be retried by re-delivering its existing
  ASSIGN (`canRetryReviewClaims`, `dispatch.ts:812-861,1176-1213`), but only by the coordinator that
  sent it. The ASSIGN is delivered to the **worker's** pane, and what a successor cannot do is
  re-notify it (the notifier requires the caller's pane to equal the **sender's** bound pane,
  `collab-notify.ts:1488-1494`) or re-issue it (a different ASSIGN under the same id fails at
  registration with `content_conflict`, `envelope.ts:236-244`). A successor therefore cannot finish an
  attempt whose ASSIGN may never have reached the worker. The rule is to **never enter that state**:
  an attempt that is `assigned` and has not been acknowledged is not transferable, and the outgoing
  coordinator must deliver or cancel it before handing off (section 7, `check` and `adopt`). "Never
  acknowledged" means "possibly never delivered": a worker that did receive the prompt can still ACK
  late, ACK is not epoch-gated (`messages.ts:329-350`) and such an ACK stays valid; implementations
  must not "fix" the state by refusing late ACKs.

## 3. Principles

1. **History is immutable.** No sealed document, registered message or attempt is rewritten.
2. **Authority is current-only.** A check of *who may act now* still requires the current epoch
   and the current coordinator.
3. **Evidence is lineage-aware and time-bounded.** A check of *whether an old artifact is valid*
   accepts it when the artifact's own epoch is in the lineage, its signer was the coordinator of
   **that** epoch, and, for anything other than the current epoch, it was applied **before that
   epoch ended**.
4. **Every comparison names its anchor epoch.** After succession the attempt's epoch, the
   sealed block's own epoch, the message's epoch and the current epoch differ; a rule that does
   not say which one it compares is a defect.
5. **Nothing new is persisted in the protocol record.** The lineage is derived from completed
   coordinator handoffs that already exist.
6. **Zero change without succession.** With no completed coordinator handoff the lineage has one
   entry and every rule reduces to today's equality check.
7. **Fail closed.** A lineage that cannot be established reduces to the current epoch only.

## 4. Epoch lineage

`coordinatorLineage(record)` returns, for each epoch of the current authority line, the
coordinator identity that held it and when the epoch ended, or `{ valid: false }`.

Derivation from `record.handoffs`:

1. Take the handoffs with `kind: "coordinator"` and `state: "completed"` and order them by
   `owner_epoch` (set to the **new** epoch by `completeHandoff`). Array order must agree with that
   order, otherwise the lineage is invalid.
2. Each such entry `h` records `h.owner_epoch` (the epoch it created), `h.to` (the new coordinator,
   confirmed by the receiver's own message) and `h.previous_coordinator` (identity and epoch
   before the handoff). The first handoff's `previous_coordinator` is the task's original
   coordinator.
3. The lineage maps `h.previous_coordinator.owner_epoch` to the previous identity and `h.owner_epoch`
   to `h.to`. The `until` of an epoch is the completion instant of the handoff that created the
   **next** epoch (the time of that handoff's `completed` step). The current epoch has no `until`.
   Times are compared as parsed instants (milliseconds), never as strings, and only full ISO-8601
   instants with an offset (what `nowIso` writes) are trusted: a bare date or a locale format that
   `Date.parse` would accept is treated as unparseable; evidence applied at
   exactly `until` is valid (`applied_at <= until`). All records of one task are written by processes
   on one machine, so clock skew between writers is not modelled; a step time that cannot be parsed
   makes the lineage invalid.

Validity (all required, otherwise the lineage is `[current]` only):

- epochs are contiguous: each handoff's `previous_coordinator.owner_epoch` equals the epoch the
  handoff before it created;
- no two entries claim the same epoch;
- the last entry's `to` equals `record.coordinator` (agent id and session id) and its
  `owner_epoch` equals `record.coordinator.owner_epoch`;
- each handoff after the first was made by the coordinator the earlier handoff installed (agent id and
  session id), so a chain with a stranger in the middle is invalid;
- every completed handoff has a usable completion time: the last of its steps whose state is
  `completed`, parseable as a time;
- `record.coordinator.previous` (kept by `completeHandoff`) equals the last entry's
  `previous_coordinator`; any disagreement invalidates the lineage.

Verified against the code: `record.coordinator` is rewritten only by `completeHandoff`; the epoch
is exactly previous + 1; `record.handoffs` is never pruned; aborted handoffs are excluded by the
state filter; `rebindReceiver` refuses completed handoffs, so a completed `h.to` cannot be
rebound. The function is pure, takes the record only, and is the single place the rule lives.

## 5. Check classes and anchors

Every `owner_epoch` or coordinator-identity comparison on the paths in scope is assigned a class
and an **anchor** (the epoch it compares). A comparison not listed keeps today's behaviour.

| Class | Meaning | Rule after succession |
| --- | --- | --- |
| **A. Authority** | who may act now | unchanged: current epoch and current coordinator |
| **E. Evidence** | is this historic artifact valid | the artifact's own epoch is in the lineage, its signer equals the lineage identity of that epoch, and if that epoch is not current it was applied at or before that epoch's `until` |
| **N. New artifact** | the successor creates it | carries the current epoch and is signed by the current coordinator; validators later treat it as E |
| **P. Participant** | a worker acts on its own attempt | see section 6 |

**Identity comparison drops `harness`, on purpose.** The lineage and the evidence rule identify a
coordinator by agent id and session id only. Today `sameCoordinator` (`collab-workflow/context.ts`)
and the release correlation (`participant.ts:689-691`) also compare `harness` when one is recorded.
Converting the evidence checks to the lineage rule in 4c drops that comparison deliberately: a session
id already belongs to exactly one harness session, and the harness of a historic coordinator is not
recorded in every artifact. Authority checks (class A) keep comparing exactly what they compare today.

Anchors used below: **own** = the epoch recorded inside the artifact being judged; **attempt** =
`attempt.owner_epoch`; **current** = `record.coordinator.owner_epoch`.

| Site | Today | Class | Anchor | New rule |
| --- | --- | --- | --- | --- |
| `acceptance.ts:96-101` caller is coordinator | identity | A | current | unchanged |
| `acceptance.ts:102-110` attempt epoch | equals current | E | attempt | attempt epoch in lineage |
| `acceptance.ts:150-158` plan epoch | equals current | E | own (plan) | plan epoch in lineage |
| `acceptance.ts:250-253` accept `ANSWER` | current | N | current | unchanged; see section 7 for the id and for an existing decision |
| `work-plan.ts:812` `epochCurrent` | equals current | E | own (plan) | plan epoch in lineage |
| `work-plan.ts:987` accept envelope epoch | equals plan epoch | E | own (envelope) | envelope epoch in lineage, at or above the plan epoch, and time-bounded if not current |
| `work-plan.ts:1016-1024` `acceptance_not_coordinator` | signer is the current coordinator | E | own (envelope) | signer equals the lineage identity of the envelope's epoch |
| `work-plan.ts:1106` attempt epoch vs plan epoch | equals plan epoch | E | attempt | attempt epoch in lineage and not below the plan epoch (an attempt cannot predate its plan; a successor's new attempt is above it, which is allowed) |
| `work-plan.ts:941-946` witness choice | last registered decision | E | own | only decisions that pass the rows above count; an **applied** decision is final (section 7) |
| `app/collab-work-plan.ts:636` stale flag | inequality | E | own (plan) | plan epoch not in lineage |
| `dispatch.ts:894` reviewer activation: attempt epoch equals current | equality | E | attempt | attempt epoch in lineage |
| `dispatch.ts:895,1257-1259,1548` sealed assignment `coordinator` block | equals attempt or current | E | **own (sealed block)** | block's agent id, session id and epoch equal the lineage entry **of the block's own epoch**, independent of the attempt's and the current epoch |
| `dispatch.ts:910` ASSIGN `owner_epoch` and `from` | equals attempt epoch; from equals current | E | own (ASSIGN) | ASSIGN epoch equals the attempt epoch; `from` equals the lineage identity of that epoch |
| `dispatch.ts:1255-1260` final authority check | fresh record epoch equals attempt epoch | A | current | the **caller** is the current coordinator and the fresh record is unchanged; the attempt epoch need only be in the lineage. A new attempt registered under the current epoch against an older sealed assignment passes through the sealed-block row above |
| `participant.ts:684-695` release correlation | registered epoch equals current | E | own (decision) | decision epoch in lineage, signer equals that epoch's lineage identity, time-bounded if not current |
| `participant.ts:735` ASSIGN epoch vs attempt | equals attempt | E | own (ASSIGN) | unchanged |
| `collab-pane-reclaim.ts:117-127` accept `ANSWER` | from and epoch equal current | E | own (answer) | same as `work-plan.ts:987,1016-1024` |
| `messages.ts:254` epoch gate | equals current | by type | | section 6 |

Authority sites that stay exactly as they are: every `collab handoff` action
(`handoff.ts:110,525,643`, `collab-handoff.ts:317-320,508`), `checkOwnerEpoch` for state, resource
and recovery operations, and the sender-role checks that require the current coordinator for
`ASSIGN`, `CANCEL` and decision `ANSWER`s.

## 6. Message layer

The real role table (`messages.ts:34,44-93,247-291,329-561`):

| Type | Sender gate at apply | Epoch gate at apply | Origin |
| --- | --- | --- | --- |
| ASSIGN | `record.coordinator` | yes | coordinator |
| CANCEL | `record.coordinator` | yes | coordinator |
| HANDOFF | handoff `from`/`to`, coordinator for a coordinator handoff, or the writer | yes | either |
| CANCELLED | attempt assignee | yes | participant (the only epoch-gated participant type) |
| ACK | assignee, or the handoff receiver for a handoff ack | no | participant |
| BLOCK | assignee or coordinator | no | participant |
| REPORT | attempt assignee (a mismatch is recorded as `stale_sender` evidence, not refused) | no | participant |
| ANSWER | decision: `record.coordinator`; clarification: the asked party | no | coordinator / asked party |
| ASK | none | no | either |
| STATUS | none | no | either |
| STATUS_QUERY | none | no | either |

Consequences:

- Only `CANCELLED` is a participant type refused by the epoch gate today. The new participant
  rule applies to **`CANCELLED` only**: a message whose `owner_epoch` is not current is accepted
  when all hold: the epoch is in the lineage and lower than current; an attempt for the message's
  subtask and attempt exists and was registered under exactly that epoch; the sender is that
  attempt's assignee. Otherwise it is refused exactly as today, including the `stale_epoch`
  uncertainty. For an invalid lineage the rule never applies, so behaviour is today's.
- `ACK`, `BLOCK`, `REPORT` and `STATUS` already apply regardless of epoch. Their bytes change after
  succession because `to` is stamped with the current coordinator (section 7).
- `ASSIGN`, `CANCEL` and `HANDOFF` stay epoch-gated and coordinator-gated: the old coordinator's
  copies are refused.
- **`ASK` is neither sender- nor epoch-gated.** After succession the old coordinator can still send
  a clarification `ASK`, and the asked worker's `ANSWER` is authorized against that question. This is
  unchanged behaviour and it has no execution authority (`messages.ts:60-66`). It is recorded as a
  residual limit (section 10), not changed here, to keep principle 6.

## 7. Work-plan, decisions, message ids and workflow behaviour

- Sealed `work-plan.json` and every sealed assignment are never changed; their old `owner_epoch`
  stays and the evaluator reads the lineage.
- **What the successor can do.** Decide reports (including ones reported before succession), let
  workers carry on, dispatch sealed assignments that have **no attempt registered yet**, and
  activate a deferred reviewer for the first time. A reviewer or writer activated this way registers
  an `ASSIGN` under the current epoch, `from` the successor, `assignment_digest` pinning the
  unchanged sealed bytes (class N); the sealed block is judged against its own epoch (section 5).
  The base ids (`assign-<subtask>`) are free, so no id change is needed.
- **Transferable and non-transferable attempts.** Succession mid-cohort is supported for attempts
  that the worker itself can carry on: acknowledged (`accepted`), running, or finished with a report
  that has not been decided. It is **not** supported for an attempt that is `assigned` with no ACK, no
  native binding and no results: its delivery depends on the outgoing coordinator's own pane. Such an
  attempt must be delivered (and acknowledged) or cancelled before the handoff. Every attempt is
  classified: `accepted` and `running` are transferable; `completed` with no valid applied decision for
  its report is transferable (the successor decides it); an attempt in state `unknown`, **including one
  with a bound native session whose observation could not be proven**, is non-transferable and blocks
  with a reconcile next action; `needs_input` is non-transferable (below); `assigned` with no ACK is
  non-transferable; attempts that are `completed` with a valid applied decision, `failed` or `cancelled`
  are terminal and out of scope for the classification.
  `collab handoff check` therefore gains a **mid-cohort mode** that does not block on in-flight work
  but lists, per attempt, whether it is transferable, and blocks on every non-transferable one with
  the exact next action; `workflow adopt` runs the same classification and refuses on one that
  slipped through (for example one dispatched under the old coordinator and never acknowledged).
  Re-issuing or re-delivering an existing attempt's ASSIGN stays refused with the codes it has today.
- **What the mid-cohort mode of `check` relaxes and keeps.** The mode exists so a coordinator can learn
  whether handing off *now* is safe, so it must say precisely what changes against the boundary check,
  using the codes the check really emits (`handoff.ts`, `collab-handoff.ts`). Relaxed, because the
  successor can handle it: `attempt_in_flight` for transferable attempts; `cohort_node_not_accepted`,
  since the successor decides the reports; the evaluation's `owner_epoch_mismatch` **when the plan's
  epoch is in the lineage** (class E); `claims_unreleased` for a claim held by the assignee of a
  transferable attempt and stamped with that attempt's `subtask_id` and `attempt` (the claims
  `workflow prepare` makes are stamped, `resources.ts:462-463`; a hand-made claim without the stamp
  keeps blocking, with the next action to release it and claim it tied to its attempt). Still blocking:
  a non-transferable attempt (new blocker `attempt_not_transferable`, naming the attempt and the next
  action); `attempt_needs_input` (an answer to a `BLOCK` is authorized against the party the question
  was addressed to, which is the outgoing coordinator, `messages.ts:145-152`, so the successor could not
  unblock it); `source_holds_claims`; any other open handoff; `uncertainty_open`; a plan that is
  unreadable or invalid, a plan whose epoch is **not in the lineage**, or a decision without a readable
  envelope; any unsupported surface of section 8; and an invalid lineage. The mode never turns a
  blocker into a warning silently: the result lists every relaxed item with the reason.
- **Decision lookup is by `reply_to`, never by constructed id.** Every reader that decides whether a
  report has been decided, or which decision applies, finds it as: type `ANSWER`, `reply_to` equal to
  the report's message id, state applied, passing the evidence rules of section 5. Readers known to
  construct the id today include `collab-pane-reclaim.ts:110-116`, the acceptance path, the dispatch
  intent and delivery bookkeeping and release idempotency; step 4c must enumerate every reader of
  `accept-<subtask>-<attempt>` and `released-<subtask>-<attempt>` and convert each.
- **A valid applied decision per attempt is final: a new one is prevented, not re-ordered.**
  Detection scans `record.messages` for applied `ANSWER`s with this `reply_to` that pass the evidence
  rules (signer equals the lineage identity of its epoch; applied at or before that epoch's `until`
  when the epoch is not current). If one exists, `accept` refuses with a clear code. The evaluator
  keeps **today's witness rule unchanged**: among valid applied decisions the last by registration
  order is the witness (`work-plan.ts:941-946`), so the corner of two valid decisions (reachable today
  only with a hand-crafted id) behaves as it does now. An applied decision that fails the evidence
  rules (wrong signer, applied after its epoch ended, or skewed past `until`) does not count and does
  not block the successor, who can then re-decide. A decision that was only **registered**, not
  applied, is not evidence.
- **The accept id after succession.** `accept-<subtask>-<attempt>` stays the id. The only collision
  succession can cause is a message with that id registered under a **different epoch** that is not a
  valid applied decision (the old coordinator stopped between register and apply). The trigger is
  epoch-based, not byte-based, and is decided by reading the registered message file itself (a
  registered-but-unapplied message is not in `record.messages`): only then is the successor's accept created as
  `accept-<subtask>-<attempt>-e<current epoch>`. A difference in content alone (for example
  a different `reason`) never triggers it and stays today's `content_conflict`, and a `created_at`-only
  difference is not even that: the content digest excludes it, so it is a plain duplicate. With a
  one-entry lineage the suffix therefore cannot appear (principle 6). The accept decides the id once,
  from the registered file it read; if its exclusive create then loses a race with a base-id message
  it did not see, the call retries exactly once with the suffixed id when the winner can be re-read, sits
  under a different epoch and is not a valid applied decision for this report, and the caller is still the coordinator at the same epoch (otherwise it is refused and registers nothing) (as built in the follow-up
  to step 4e); a same-content winner stays a duplicate, and every other outcome is today's `content_conflict`. Authority-path ids are never suffixed: `handoff-ack-<request id>` is created before the epoch changes,
  and the managed-Pi ids are out of scope (section 8). Two successor processes creating the same suffixed id with identical bytes are
  duplicates, and with different bytes `content_conflict` as today (registration is exclusive-create).
- **Participant duplicates.** `participant.ts` stamps `to` with the coordinator at action time, so a
  worker re-sending an identical message after succession differs only in `to`. For **`ACK`, `REPORT`
  and the release `STATUS` only**, a registered message with the same id, task, subtask and attempt,
  whose sender is the attempt's assignee, whose body is equal, and whose only difference (ignoring
  `created_at`) is a `to` that was the coordinator of the registered message's own epoch, is a
  protocol duplicate: no second registration, no `content_conflict`. The result reports
  `registered-to-earlier-coordinator` and does not pretend a fresh delivery: the registered copy
  addresses the earlier coordinator, and notifying it fails closed after adoption. An `ASSIGN`, a
  decision or any other coordinator-created message, and a `to` pointing at a different worker, are
  never subject to this rule. The rule lives at **two sites**: `registerMessage` (reached by the `ACK`
  and `REPORT` paths through `submitMessage`, `participant.ts:405-411,536-542`) and the release flow's
  pre-registration digest comparison (`participant.ts:816-843`, `release_status_conflict`), which
  compares before any registration and must treat a `to`-only or `created_at`-only difference as the
  same duplicate.
- **The successor's startup sequence** is explicit: `collab handoff release-dispatch` (dispatch stays
  frozen after `complete`, `handoff.ts:558`; `accept` is not blocked by the freeze, every dispatch is),
  then `collab workflow adopt` (section 9).
- `collab handoff check` keeps its meaning. After succession it becomes `ready` once the cohort is
  accepted and released: the plan evaluation no longer reports `owner_epoch_mismatch` when the plan's
  epoch is in the lineage (the accept path's `plan_epoch_stale` and `acceptance_stale` follow the same
  rule).
- A task whose lineage is invalid keeps today's behaviour for every check, and `workflow adopt`
  refuses.

## 8. Unsupported surfaces

These keep current-epoch equality and gain no lineage awareness. They fail closed (`stale_epoch`,
`owner_epoch_changed`) after succession, which is safe:

- Pi managed sessions and their execution scope (`managed-pi-*`).
- Session-transition and rollover (`collab-session-transition/*`, `collab/rollover.ts`).
- Role plans, role orchestration and role repair (`collab-role-*`).
- Recovery executors keyed to a coordinator epoch.
- The goal-based worker path: `collab prepare`/`start` admission (`admission.ts:273-284`) and
  `collab work-run` validation (`collab-work-execution.ts:745-856`). A worker that resumes through it
  after a succession is refused `stale_epoch`; mid-cohort succession must not be attempted while that
  surface is in use.

`workflow adopt` refuses when any of these is in use, detected as follows:

- managed Pi: any entry in `record.managed_pi_source_admissions`, `managed_pi_resume_admissions` or
  `managed_pi_runtime_registry`;
- session transition: any entry in `record.rollover` or `record.successions`;
- role plans: **not visible in the record** (sealed `pappra/collab-role-plan/1` documents and role
  event journals live under the task directory). `adopt` scans the task root and refuses on any file the
  role subsystem writes. Step 4d must enumerate those paths; until it does, the safe default is to
  refuse on any role-plan artifact.
- the goal-based path: reported as a warning, because it cannot be detected reliably from the record.

## 9. Routing and adoption

The sealed `workflow/binding.json` names the old coordinator's pane, and the workflow actions pass
that one file to the notifier. A sealed file is never edited, so routing uses **binding
generations**:

- generation 0 is the sealed `workflow/binding.json`;
- generation N is `workflow/binding.e<epoch>.json`, created exclusively, copying every participant
  entry of the previous generation and replacing the coordinator entry with the successor's pane and
  native session, plus the id of the completed handoff it belongs to.

`currentBindingFile(taskRoot)` returns the highest generation whose coordinator entry equals the
record's current coordinator (agent id and session id), falling back to generation 0. Consumers:

- the workflow facade (`accept`, `dispatch`, participant actions, `reclaim`, `inspect`) uses the
  resolver instead of the fixed path;
- consumers that take an **explicit** binding path keep working unchanged and fail closed with
  `binding_sender_mismatch` or `binding_recipient_mismatch` if given a stale generation:
  `collab work-run` (`binding_file` in its request), `collab message notify --binding`, and role
  orchestration. `workflow adopt` and `workflow inspect` print the current generation path so a
  caller knows which file to pass.

The generation is written by a new explicit action run by the **new coordinator**:

```sh
pappra collab workflow adopt --task-root <abs> --pane <w:p> [--apply] [--json]
```

Plan is read-only. It verifies the lineage is valid and the last handoff completed, that the caller
is the current coordinator and its pane is observed through Herdr, and that nothing in section 8 is
in use. It reports what is being adopted: attempts per epoch, reports not yet decided, deferred
reviewers, open uncertainty. Apply writes the binding generation and nothing else. It changes no
attempt, plan, assignment or message.

`accept` and `dispatch` do not refuse before `adopt`; they warn that notifications will not reach the
successor, so a missed adoption never blocks the cohort. `collab handoff successor` (phase 3) is
unchanged: adoption is a separate step after `complete`.

**As built (step 4d).** The request is a document, not flags: `pappra/collab-workflow-adopt-request/1`
(task root, caller, caller pane), like every other workflow action. The sealed binding is
`<task root>/binding.json`, so generation N is `<task root>/binding.e<epoch>.json`; it carries the
participants only (the binding schema is strict and unchanged), and the epoch in the name identifies
the completed handoff that created it. The previous coordinator's entry is dropped unless that agent
also holds an attempt of the task. The pane is observed with the Herdr agent listing: the agent in
that pane must report the coordinator's harness and session id. Role plans and role event journals sit
at caller-chosen paths, not under the task root, so only files with `role` in their name next to the
task are detected unless the request lists them in the optional `extra_paths` (reported as warnings, per
file); a warning always names the rest. The mid-cohort mode of `check` is the separate
action `collab handoff check-mid-cohort`; an attempt that only acknowledged still carries its
`registered_not_started` uncertainty, which keeps blocking until a native observation or an explicit operator resolution (`collab recovery reconcile`) resolves it.

**Real-session findings (step 4e, 2026-10-28).** Claude to Claude and Codex to Codex, each with a
plain visible Pi CLI writer in flight, both ended with the boundary check `ready`, the writer's
claim released and the decision made by the successor at epoch 2. They changed three things:

- `collab handoff successor` ran the boundary check, which refuses any in-flight work. The request
  gains an optional `mode` (`boundary` by default, `mid_cohort`), so the launcher can require the
  mid-cohort check instead; a request recorded before the field existed keeps its meaning.
- A Codex coordinator cannot be adopted through a Herdr listing. Codex tools run in a sandboxed
  shared daemon that cannot reach the Herdr socket ("Operation not permitted"), and Herdr reports no
  session for a Codex pane. `adopt` therefore binds a Codex coordinator by `CODEX_THREAD_ID` (as `ack`
  does) and by the pane and Herdr agent name the launcher recorded for that very thread in
  `<task root>/successor/*.outcome.json`; it never consults Herdr for Codex. A Codex successor that was
  not launched by `collab handoff successor` cannot adopt.
- For the same reason a Codex coordinator cannot notify anyone (`accept` records the decision and
  reports a delivery warning). This is not specific to succession. The decision is final in the record;
  the operator tells the worker to run `release`, or the worker waits with `collab workflow await`
  (file-only, bounded, read-only), and `accept` adds `detail.delivery_fallback` naming that action.
- An acknowledged-only worker keeps its `registered_not_started` uncertainty (an ACK is not a native
  observation); the operator resolves it with `collab recovery reconcile` citing the ACK before the
  mid-cohort check turns `ready`. `check-mid-cohort` now lists a `reconcile` entry per such attempt (uncertainty id, ACK id, the exact request document and command); it still blocks.

## 10. Threat model

| Attack or fault | Outcome |
| --- | --- |
| The old coordinator sends `accept`, `ASSIGN`, `CANCEL` or a decision `ANSWER` after succession | refused: class A or N need the current coordinator and epoch |
| A forged decision `ANSWER` signed with the old coordinator's identity and an old epoch, registered after succession | not evidence: for a non-current epoch the decision must have been **applied at or before that epoch's `until`**; a later one is ignored |
| A forged decision registered before succession | out of the threat model: whoever could do that was the coordinator then, and the protocol is cooperative |
| A decision applied before succession is overridden by a later one | not possible: the first valid applied decision per attempt is final |
| A suffixed accept id appears with no succession | not possible: the trigger needs an existing message under the base id with a different epoch |
| The old coordinator's clock runs ahead and a legitimate decision lands after `until` | the decision is excluded as evidence and does not block; the successor re-decides (section 7) |
| A decision applied exactly at, or just after, an epoch's end | `applied_at <= until` is valid; later is ignored; the comparison is on parsed instants |
| A worker `CANCELLED` with a forged older epoch | accepted only when the epoch is in the lineage and lower than current, an attempt exists registered under that exact epoch, and the sender is its assignee |
| A forged coordinator handoff record to fabricate a lineage | the lineage is read from the record; a handoff reaches `completed` only through the existing confirm and complete checks; this design adds no weaker path |
| Skipped, duplicated or out-of-order epochs; `record.coordinator.previous` disagreeing | the lineage is invalid and every check falls back to current-only |
| Two successions racing | `beginHandoff` already refuses overlapping coordinator handoffs |
| Evidence from another task | every check already compares `task_id`; the lineage is per record |
| Adoption by a non-coordinator | refused: the caller must be the current coordinator and its pane observed |
| **The old coordinator keeps sending clarification `ASK`s** | **still possible and unchanged.** It has no execution authority, but the old session has a live channel to workers; the worker's `ANSWER` is authorized and, until `adopt`, routed to the old pane. Noted as a residual limit |
| The old session keeps running | unchanged: nothing stops or observes it; the epoch refuses its coordinator-origin actions except `ASK` |

## 11. Compatibility

- No schema, journal or sealed-document change. No migration.
- A task with no completed coordinator handoff has a one-entry lineage and every rule equals today's;
  epoch-qualified ids and `to`-only duplicate handling never trigger.
- A task that already had a coordinator handoff gains the new behaviour when its lineage is valid and
  keeps today's otherwise.
- `workflow adopt` and the binding generation are additive.

## 12. Test plan

Unit, lineage as a pure function: none, one, two and three successions; broken chain (gap, duplicate,
out of order, last `to` not equal to the record's coordinator, `coordinator.previous` disagreeing); a
handoff not completed; an aborted handoff in between; `until` values.

Per site in section 5: (a) unchanged behaviour with a one-entry lineage, (b) accepted evidence under a
valid multi-entry lineage, (c) refusal under an invalid lineage, (d) refusal when the signer is not the
lineage identity of the artifact's epoch, (e) refusal when the artifact was applied **after** its
epoch's `until`.

Message layer: a test over `MESSAGE_TYPES` that fails when a type is added without a role in section 6;
`CANCELLED` accepted and refused cases; `ASK` after succession documented as unchanged.

Scenarios, with real workflow fixtures:

1. writer reported, not accepted, succession, successor accepts, writer releases, cohort finishes,
   `check` becomes ready;
2. writer still running at succession, writer reports afterwards, successor accepts;
3. a sealed assignment with **no attempt yet** is dispatched by the successor: the new attempt is
   registered under the current epoch against the older sealed block, the final authority check passes
   and delivery proceeds (the H1 case);
4. a deferred reviewer is activated for the first time by the successor, reports, and is accepted;
5. an attempt that is `assigned` and never acknowledged is **non-transferable**: `check` in mid-cohort mode
   blocks on it with the exact next action and `adopt` refuses it; so does an attempt in state `unknown`
   (with and without a bound native session) and a `needs_input` attempt; re-issuing or re-delivering its
   ASSIGN after succession is refused with the codes it has before succession (`content_conflict` for a
   direct re-submit, `dispatch_already_attempted` for a writer re-dispatch,
   `review_activation_not_retryable` for a reviewer re-activation whose notification exists); no suffixed
   `assign` id ever appears; a late ACK is still applied; acknowledged, running and reported attempts are
   transferable, and terminal ones are not classified;
6. an accept registered under epoch 1 but never applied, then the successor's accept registers as
   `accept-<subtask>-<attempt>-e<epoch>`, is applied, and decides the report;
7. a content difference alone (a different `reason`) between two registrations of the base accept id
   never produces a suffixed id, and with a one-entry lineage the suffix cannot appear;
8. a valid decision applied before succession stays final: the successor's `accept` is refused with a
   clear code; a decision that fails the evidence rules (signer, time, or skewed past `until`) neither
   counts nor blocks, and the successor re-decides; with two valid applied decisions the evaluator picks
   the last by registration order, exactly as today;
9. a forged old-epoch decision registered and applied **after** succession is ignored, including for pane
   reclaim and release correlation (the H3 case); a decision applied at exactly `until` is valid and one
   a millisecond later is not;
10. the old coordinator then tries `accept`, `dispatch`, `ASSIGN`, `CANCEL` and a replayed accept: all
    refused; its clarification `ASK` still applies, as documented;
11. two successions, with evidence from the first epoch still accepted inside its `until`;
12. a worker re-sending an identical `ACK`, `REPORT` or release `STATUS` after succession is a duplicate
    reported as `registered-to-earlier-coordinator`; an `ASSIGN`, or a message whose `to` is a different
    worker, is never treated as one;
12b. a re-run of `accept` or `ack` after a register-then-fail with **no succession** behaves exactly as
    today (`content_conflict`); no suffixed id is created;
13. every reader of `accept-<subtask>-<attempt>` and `released-<subtask>-<attempt>` finds a decision that
    carries the suffixed id (pane reclaim, acceptance, dispatch bookkeeping, release idempotency, inspect);
14. `workflow adopt`: plan and apply, refusal for a non-coordinator, an invalid lineage, each unsupported
    surface in section 8, and the binding generation resolver; `collab work-run` and
    `collab message notify` given the right and a stale generation.

Each scenario asserts that no sealed document, registered message file or attempt was modified.

Real session: a Claude to Claude mid-cohort succession with a Pi CLI writer (a plain visible pane, not a
managed SDK session) in the cohort, then a Codex to Codex one.

## 13. Phasing

| Step | Content | State |
| --- | --- | --- |
| 4a | `coordinatorLineage` (including `until`) and its unit tests | done |
| 4b | message layer (`CANCELLED` rule, role-table test) and the work-plan evaluator rows | done |
| 4c | workflow facade rows: accept, dispatch and activation, release correlation, pane reclaim; epoch-qualified ids; `to`-only duplicates | done |
| 4d | binding generations, the resolver, `workflow adopt` and its unsupported-surface detection, and the mid-cohort mode of `collab handoff check` | done |
| 4e | real-session acceptance (Claude to Claude, Codex to Codex) | done |

Every step touched authorization or the interpretation of persisted state and was independently reviewed.

## 14. Remaining limits

1. **The `ASK` channel.** Left unchanged on purpose. Gating `ASK` on the current coordinator would alter
   behaviour for tasks that never had a succession.
2. **Unsupported surfaces.** Role plans, managed Pi, rollover and session transition keep strict
   current-epoch checks (section 8). `adopt` reports role artifacts it can find by name or by the
   optional `extra_paths`.
3. **Codex coordinator delivery.** A Codex coordinator cannot reach the Herdr socket, so `accept` reports
   a `delivery_fallback` and the worker uses `collab workflow await` (section 9).
