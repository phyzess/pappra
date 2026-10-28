# Collaboration reference

Contracts for the lower-level collaboration subsystems. The typed entry point is
[the workflow](collaboration-workflow.md); message envelopes are in
[collaboration messages](collaboration-messages.md).

- [Public consumer APIs](#public-consumer-apis)
- [Visible Pi bootstrap](#visible-pi-bootstrap)
- [Bounded collaboration work execution](#bounded-collaboration-work-execution)
- [Collaboration role-plan adapter](#collaboration-role-plan-adapter)
- [Collaboration role orchestration](#collaboration-role-orchestration)
- [Collaboration recovery](#collaboration-recovery)
- [Collaboration recovery projection](#collaboration-recovery-projection)
- [Optional Pi host packages](#optional-pi-host-packages)
- [Collaboration session transition](#collaboration-session-transition)
- [Session transition architecture](#session-transition-architecture)
- [Startup and delivery reliability](#startup-and-delivery-reliability)

## Public consumer APIs

Pappra exposes bounded collaboration planning, work notification and recovery
through the experimental package entrypoints. Planning, notification, recovery
and session transition stay separate operations: an intent, submitted
notification, ACK or task-local retirement marker is not proof of completed work
or native session takeover.

These namespaces are exported only by the `@phyzess/pappra/experimental` subpath,
not by the package root or `@phyzess/pappra/collab`. Beta 0.1.0 publishes no
per-surface subpaths for them; take each namespace from the curated experimental
barrel:

```ts
import * as collab from '@phyzess/pappra/collab';
import * as experimental from '@phyzess/pappra/experimental';

const { validateWorkPlan, evaluateWorkPlan } = collab.workPlan;
const { inspectWorkPlan } = experimental.collabWorkPlanInspection;
const { runWorkExecution } = experimental.collabWorkExecution;
const { executeRecovery } = experimental.collabRecoveryExecutor;
```

Read-only recovery inspection, guarded recovery and resumable session transition
live in `experimental.collabRecovery`, `experimental.collabRecoveryProjection`
and `experimental.collabSessionTransition`. Host-specific Pi APIs live in
`@phyzess/pappra/experimental/pi` (`piRecovery`, `piSessionTransition`,
`piManaged`, `piManagedSdk`). The earlier `pappra/collab/*`, `pappra/hosts/pi-*`
and `pappra/collaboration` specifiers are removed and fail with
`ERR_PACKAGE_PATH_NOT_EXPORTED`; [API boundaries](api.md) carries the migration
and reset policy.

## Visible Pi bootstrap

`pappra collab bootstrap` prepares or performs one explicit, task-bound Pi
bootstrap. It does not start a hidden pilot, create another workspace, or change
the user's daily Pi settings.

```text
pappra collab bootstrap <plan|apply> --task-root <absolute-task-root> --request <absolute-request.json> [--json]
```

`plan` is read-only. `apply` is the only effectful command. The `--task-root`
value must resolve to the same canonical task root as `request.task_root`.

### Request inputs

The bounded request uses schema `pappra/collab-bootstrap-request/1`. It pins:

- `request_id`: durable idempotency key. Reusing it with different request bytes
  is a content conflict.
- `admission`: the exact assignment/subtask/attempt/input revision and a
  capability-card path plus raw-file digest. The assignment and card are checked
  with the existing collaboration preflight, including its freshness bound.
- `caller`: requires the Herdr environment and may give an explicit pane id. A
  missing pane id uses only Herdr's verified inherited caller context; it never
  selects a focused pane.
- `participant`: the Pi agent id, harness and UUID session selector. The identity
  must match the accepted bootstrap config's successor. A reuse request may also
  provide a participant capability-card path/digest.
- `target`: an explicit `sibling` or `reuse`, absolute admitted cwd, optional
  `right`/`down` split direction and `preserve_focus: true`.
- `selected_model: { "preserve_daily": true, "openrouter_model"?: "provider/model" }`:
  the optional model selects OpenRouter explicitly; unrelated configuration
  overrides are rejected.
- Optional `managed_runtime: { sdk_module_path, journal_path,
  automatic_handoff_file?, handoff_context_file? }` selects the managed SDK
  successor only for a fresh sibling with an explicit
  `selected_model.openrouter_model`. The SDK entry must be an absolute pinned
  regular file; the new journal and generated config live in an already-private
  real directory; both optional config paths are absolute future files.
  `handoff_context_file` is reserved for the root controller's private immutable
  receiver context.
- `bootstrap`: absolute exported bundle path, canonical bundle-manifest digest,
  colocated config path/digest and exact extension entry.
- `message_pointer`: one already-registered message id/path/digest. Arbitrary
  prompt text is not accepted.
- `binding_ref`: a task-local `pappra/collab-binding/1` file. This is needed by
  the existing registered-message router to resolve the caller and recipient
  explicitly. If it is absent, plan/apply returns `binding_ref_required`; no
  focused-pane or workspace-default route is inferred.
- Optional `readiness` limits can only tighten the fixed 10,000 ms / 100 ms /
  100-sample maximum.

The optional top-level request `action: "apply"` is accepted for compatibility
with early request examples; the CLI's `plan|apply` argument remains
authoritative. A null/non-UUID session selector, model override, unsupported
field, stale assignment/card or mismatched digest is rejected before effects.

The `bundle_digest` is SHA-256 of the canonical JSON encoding of manifest entries
sorted by UTF-8 relative-path bytes:

```json
[{"path":"relative/posix/path","digest":"sha256:<file-bytes>"}]
```

Every bundle entry must be a regular file within the bounded file/count/total-byte
limits. Symlinks and special files are refused. The config must be the exact
colocated `extensions/pappra-bootstrap/bootstrap.json`; the entry must be the
accepted generated wrapper; and `runtime.mjs` must match the package's accepted
bootstrap artifact digest.

### Read-only plan

Plan checks the current task namespace, recorded attempt/assignment, coordinator
epoch, claims and rollover intent; runs the current capability preflight;
resolves the exact Herdr caller and task binding; reads the registered message;
validates the accepted bootstrap config/bundle; and checks the selected
participant route. It may query caller/list metadata, but it performs no
reservation, split, shell poll, start, close, binding write or notification.

The report contains the projected split/start argv, readiness contract,
bundle/config digests, participant-selection result and downstream limits. A
report is not an authorization, lock, gate-registration proof or delivery
receipt.

### One-shot apply

Apply repeats the checks and reserves `request_id` plus request digest in the
task record before any native effect. It records intent before each effect and
bounded typed Herdr receipts/results after the command. A repeated request
returns the recorded result or `reconcile_required`; it does not
split/start/prompt again. A same-key/different-content request is rejected.

For `target.choice: "sibling"`, apply:

1. Creates one sibling pane in the admitted cwd without changing focus.
2. Verifies that exact returned pane and waits for its available-shell process
   observation before queueing the single approved launch.
3. Without `managed_runtime`, starts legacy native Pi in that pane with the exact
   UUID and accepted gate entry, equivalent to:

   ```text
   herdr agent start <name> --kind pi --pane <created-pane-id> --timeout 180000 -- \
     --session-id <successor-uuid> --name <name> --extension <absolute-entry>
   ```

   An admitted OpenRouter model appends `--provider openrouter --model <model>`.
   Legacy launch preserves daily settings and otherwise uses the daily default.
   It does **not** prove inheritance of another session's mutable selected model.

   With `managed_runtime`, it instead writes a private immutable SDK request
   containing the pinned SDK module, explicit model, successor UUID, verified
   `bootstrapExtensionPath`, exact `herdrAgentName`, owned `herdrPaneId`,
   journal/control paths and optional future handoff config. It queues only the
   current package CLI using `herdr pane run <created-pane-id> <fixed Nushell
   command>`; argument values are encoded as literal Nushell strings, with no
   configurable executable or shell command. It never falls back to
   `herdr agent start`.
   The config supplies no `executionScope`: the successor is not yet the
   assignee. The root CLI loads the default-deny extension and publishes only the
   actual SDK identity after verifying pane/process ownership; execution scope
   and any future handoff watcher wait for authoritative completed transfer.
   When supplied, the root writes the immutable `handoff_context_file` from the
   captured transition and verified bundle before SDK launch. The receiver
   verifies/imports it and emits the native handoff ACK before starting work;
   bootstrap only validates and forwards its path.
4. Legacy mode requires a live start result matching the requested agent, pane,
   workspace, terminal, UUID and interactive-ready state. Managed mode treats
   `pane run` as queue submission only, then requires matching Herdr name/cwd/
   live state and authenticated SDK control launch metadata for the actual UUID,
   model, SDK module, loaded extension and journal. It also matches the control
   socket's OS peer PID to the actual pane foreground PID; the attached native
   identity is explicitly `owned-pi-sdk-control`, never a raw Herdr session
   report. A separate task-local binding is written only after this exact
   SDK-native identity is verified.
5. Notifies the registered message pointer once through the existing message
   protocol. A successful prompt submission is reported as `submitted`, not as
   consumed or accepted.

If readiness fails or is unknown before startup, cleanup is limited to the pane
returned by this request's successful split. Before `pane close`, apply rechecks
the owned pane identity/cwd, confirms there is no agent, and requires the
expected available-shell process facts. It never closes a reused or unrelated
pane. After a managed CLI may have been submitted, unknown/late/mismatched
startup is not auto-closed or reissued; the reservation remains for
reconciliation and no binding or notification is written.

`target.start_timeout_ms` optionally sets the startup budget from 1 to 600,000
ms; the default is 180,000 ms for both native and managed SDK starts. Session
transitions verify the successor SDK package version and pinned private source
before freezing the source, and recheck immediately before the first freeze. An
interrupted reservation can be reclaimed only when its exact owner is proven
dead and it still has no native intent, receipt or created pane. Ambiguous
split/start outcomes remain for reconciliation. A known failed start releases its
reservation only after the exact owned pane is verified empty and closed.

For `target.choice: "reuse"`, the task-local binding, live Herdr occupant,
exact native session/cwd and a fresh runtime capability card must match. The
existing participant receives the one registered message. Reuse does not inspect
process-info, wait for a shell, split, start, or close anything. A mismatch
returns `unsupported_reuse`; it never falls back to a sibling launch.

### Outcomes and boundaries

- `planned`: read-only plan completed.
- `applied`: one-shot effect path completed and message submission was confirmed.
- `already_recorded`: the same request/message was already completed; no effect
  was repeated.
- `needs_input` / `invalid`: a required identity, pin or current-state fact is
  missing or conflicts.
- `failed`: a definite start or effect failure; inspect the recorded reservation
  and any cleanup outcome before creating a new request.
- `unknown` / `reconcile_required`: an effect or notification outcome is
  ambiguous. Inspect the recorded reservation and original Herdr/message state
  before creating a new request.

This slice does not prove extension registration from a report, synthesize
successor capabilities, transfer task authority, stop/quiesce the old writer,
remove production routing, prove first work, archive a native session, or set
automatic rollover thresholds. The accepted gate remains the authority and denies
writes until its recorded transfer conditions are satisfied. Herdr pane/session
metadata is routing evidence, not authentication or OS-level process
affiliation. Shell readiness is bounded local polling, not an event or
worker-completion guarantee.
Managed SDK identity additionally requires the authenticated SDK control launch
record, matching socket-owner PID and pane foreground PID; it is not inferred
from Herdr `agent_session` fields.

## Bounded collaboration work execution

`pappra collab work-run` is the explicit apply boundary for an existing, pinned
collaboration work plan. It dispatches already-registered assignments to their
task-bound visible participants; it does not create sessions, run models, merge
code, review output, or grant authority based on role names.

```sh
pappra collab work-run --request /absolute/path/to/work-execution.json --json    # plan
pappra collab work-run --request /absolute/path/to/work-execution.json --apply --json
```

Plan mode performs no writes and sends no notifications. Apply re-reads the plan
and task, verifies the current coordinator/epoch, registered assignment and
pinned input, matching capability preflight, task-bound sender/recipient
binding, and active resource claims. Nodes whose matching assignments are
already recorded as assigned-but-not-started can be notified; a report status
alone does not create or relaunch work. Independent eligible nodes are sent in a
bounded concurrent batch (default two, maximum eight). Overlapping write scopes
block instead of running concurrently; dependency edges are what serialize work.
Existing/unknown intents are reconciliation only and are never automatically
replayed.

### Define a planner/writer/reviewer/integrator workflow

The planner produces one `pappra/collab-work-plan/1` document. Every node pins an
existing subtask assignment, attempt, input revision, assignee, dependencies,
and normalized resources. Two writer nodes can begin together only when their
write scopes are disjoint. A reviewer consumes their pinned reports after
coordinator acceptance, and an integrator consumes accepted review output:

```json
{
  "schema": "pappra/collab-work-plan/1",
  "plan_id": "workspace-experience-v1",
  "task_id": "workspace-experience",
  "owner_epoch": 4,
  "nodes": [
    {
      "node_id": "writer-a",
      "role": "writer",
      "assignment_id": "writer-a",
      "attempt": 1,
      "input_revision": "sha256:…",
      "assignee": { "agent_id": "writer-a", "session_id": "session-a" },
      "depends_on": [],
      "resources": [{ "path": "/repo/src/feature-a.ts", "access": "write" }]
    },
    {
      "node_id": "writer-b",
      "role": "writer",
      "assignment_id": "writer-b",
      "attempt": 1,
      "input_revision": "sha256:…",
      "assignee": { "agent_id": "writer-b", "session_id": "session-b" },
      "depends_on": [],
      "resources": [{ "path": "/repo/src/feature-b.ts", "access": "write" }]
    },
    {
      "node_id": "review",
      "role": "reviewer",
      "assignment_id": "review",
      "attempt": 1,
      "input_revision": "sha256:…",
      "assignee": { "agent_id": "reviewer", "session_id": "session-review" },
      "depends_on": ["writer-a", "writer-b"],
      "resources": [{ "path": "/repo/src", "access": "read" }]
    },
    {
      "node_id": "integrate",
      "role": "integrator",
      "assignment_id": "integrate",
      "attempt": 1,
      "input_revision": "sha256:…",
      "assignee": { "agent_id": "integrator", "session_id": "session-integrate" },
      "depends_on": ["review"],
      "resources": [{ "path": "/repo/src", "access": "write" }]
    }
  ]
}
```

The example is illustrative: the planner must substitute the current task ID,
epoch, assignment IDs, attempts, input revisions, identities, and exact resource
paths. The corresponding current assignments, matching capability cards, and
participant binding must already exist. The CLI request's `capability_cards`
entries map each `assignment_id` to its current runtime card:

```json
{
  "schema": "pappra/collab-work-execution-request/1",
  "task_root": "/state/domain/tasks/workspace-experience",
  "plan_file": "/state/workspace-experience/work-plan.json",
  "binding_file": "/state/workspace-experience/binding.json",
  "caller": {
    "agent_id": "coordinator",
    "session_id": "coordinator-session",
    "harness": "codex",
    "cwd": "/repo"
  },
  "caller_pane": "w3:p1",
  "max_concurrency": 2,
  "capability_cards": [
    { "assignment_id": "writer-a", "capabilities_file": "/state/cards/writer-a.json" },
    { "assignment_id": "writer-b", "capabilities_file": "/state/cards/writer-b.json" },
    { "assignment_id": "review", "capabilities_file": "/state/cards/reviewer.json" },
    { "assignment_id": "integrate", "capabilities_file": "/state/cards/integrator.json" }
  ]
}
```

### Acceptance, results, and recovery

A dependency becomes eligible only after the current coordinator has explicitly
accepted the predecessor's exact registered report for the pinned attempt, input
revision, and owner epoch. A reviewer role does not authorize acceptance; a
writer cannot accept its own report. Rejected work stays blocked and points to an
explicit repair under a deliberately issued new attempt. The integrator never
merges code automatically. Aggregated results contain stable registered report
message IDs, content digests, input revisions, evidence pointers, and output
reference/digest pairs, sorted deterministically.

Before the first notification, apply persists a deterministic per-assignment
`STATUS_QUERY` intent through the existing collaboration message transaction; it
is recorded without delivering that query or changing attempt state. A duplicate
intent is never dispatched again. If the process crashes after intent
persistence, or notification ends `unknown`, `in_flight_unknown`, or
`already_recorded`, the node reports `reconciliation-required` (the report has
status `needs-reconciliation`); other notification failures, including blocked,
refused and failed, report `blocked`. A later apply does not replay the intent.
Inspect current delivery and native evidence, reconcile through the existing
supported flow, and create an explicit repair/new attempt if needed. Do not
delete the intent or claim that notification means the participant consumed the
assignment, completed work, or received acceptance.

The application layer revalidates after asynchronous participant preflight, uses
the core task-record revision when persisting each intent, and wraps the
production Herdr prompt with a final authority callback after live caller/agent
observations. The callback re-reads task state, assignment, capability, binding,
claims, dependency acceptance, and the exact persisted intent immediately before
the underlying prompt. Those checks reduce stale dispatches but do not provide
native OS/process fencing or an atomic transaction with Herdr. Missing, stale,
foreign, or ambiguous assignment, capability, claim, identity, epoch, or binding
evidence blocks the affected node. The work plan's read-only acceptance
evaluation remains authoritative for dependency unlocks.

## Collaboration role-plan adapter

`src/app/collab-role-plan.ts` is a pure adapter from an explicit
writer/reviewer request to the existing `WorkPlan` contract. It does not create a
second scheduler, inspect runtime state, dispatch work, or grant authority. The
package exposes the module as `collabRolePlan` from
`@phyzess/pappra/experimental`. The public CLI provides
`pappra collab role-plan expand --request <abs role-plan.json>` and
`pappra collab role-plan aggregate --request <abs role-plan.json> --task-root <abs> --config <abs expanded-plan.json>`.
Aggregate re-expands the request, requires the persisted plan to match, and uses
`inspectWorkPlan`'s authoritative core; it does not accept a supplied evaluation
artifact.

### Request and expansion

`expandRolePlan(request: RolePlanRequest)` requires:

- `schema`, `plan_id`, `task_id`, and a caller-pinned positive `owner_epoch`;
- explicitly declared `participants`, each with a unique `participant_id`,
  `planner`, `writer` or `reviewer` role, and `agent_id`/`session_id` assignee;
- one or more `writer` assignments and exactly one `reviewer` assignment;
- each assignment's unique `node_id` and `assignment_id`, attempt, input
  revision, participant reference, and non-empty explicit resource list.

The participant role must match each assignment role, and the reviewer must use a
different agent/session identity from every writer. Undeclared, mismatched,
duplicate, and unused participants are refused rather than inferred. Every
resource uses the existing work-plan `{ path, access: 'read' | 'write' }` shape
and is validated by `validateWorkPlan` after expansion. As in the existing
evaluator, writer resource paths may not overlap when either side writes;
read/read overlap is allowed. Conflicting writer scopes, including overlapping
writes assigned to the same participant, are refused rather than serialized. This
is path-scope validation, not resource fencing.

The success result contains the validated existing `WorkPlan` and `roles`:
optional `planner_node_id`, `writer_node_ids`, and `reviewer_node_id`. Without a
planner, writer nodes have no dependencies and remain independently schedulable
by the existing executor; when a planner is declared, every writer depends on
that planner's acceptance. The reviewer node depends on every writer node. The
existing evaluator gates each dependency on a completed report plus registered
coordinator acceptance; a report, a role label, or a completed writer alone does
not unlock review.

```ts
const expanded = expandRolePlan(request);
if (expanded.ok) {
  const { plan, roles } = expanded;
  // Reuse the existing inspect/evaluate/execute flow with `plan`.
}
```

The planner does not decide that an assignee is currently ready, available,
authorized, or able to claim the declared resources. `owner_epoch`, participant
identities, assignment IDs/attempts, input revisions, and resource scopes are
caller-supplied pins, not proof of live state.

### Aggregation

`aggregateRolePlan(expansion, evaluation)` consumes only the existing
`WorkPlanEvaluation` or `WorkPlanRefusal`. It preserves per-node `accepted`,
`rejected`, `unknown`, `missing`, `pending`, and `blocked` outcomes, along with
observed work-plan status and blocker codes.

The aggregate outcome is `accepted` only when every planned planner (when
present), writer and reviewer node is explicitly `accepted` in a matching
work-plan evaluation. A rejection, uncertainty, absent result, or other
non-accepted state cannot be folded into success. Evaluation refusals and
unrecognized/malformed node statuses remain `unknown`; omitted expected nodes
remain `missing`. Per-node arrays retain those states even when the aggregate
outcome prioritizes a rejection or uncertainty.

Delivery is intentionally not an aggregation input. A submitted,
successful-looking, or otherwise known delivery does not establish completion or
acceptance. The work-plan evaluator's registered evidence and acceptance
semantics remain authoritative for these statuses; this adapter performs no
native query or readiness inference.

### Bounds and refusal behavior

The adapter accepts at most 64 assignments/participants and at most 16 resources
per assignment, matching the existing work-plan node/dependency bounds. Malformed
requests, missing roles or pins, invalid work-plan resources, duplicate
assignment IDs, and conflicting writer scopes return typed diagnostics. No
partial plan is returned on refusal.

## Collaboration role orchestration

`src/app/collab-role-orchestration.ts` adds the reusable
`tickRoleOrchestration(request, deps)` service. The caller supplies the already
explicit `RolePlanRequest`, existing `WorkExecutionRequest` pins, a stable
session-event ID, a task-local journal path, and fixed bounds.
`src/app/collab-role-events.ts` supplies the event watcher and shared request
loader; `src/cli/commands/collaboration-role-run.ts` supports one-shot and watch
operation. Root owns package exports and top-level CLI flag parsing.

```ts
const result = await tickRoleOrchestration({
  role_plan: explicitRolePlanRequest,
  execution: existingWorkExecutionRequest,
  event_id: appliedSessionEventId,
  journal_file: `${taskRoot}/role-orchestration.json`,
  limits: { max_rounds: 12, max_actions: 8, max_attempts: 3 },
});
```

### Event watch and CLI

`watchRoleOrchestration(requestFile, onResult)` reuses `loadRoleRunRequest`; it
does not parse a second request format. It watches the request, task record, and
current capability-card files, then rebinds subscriptions when the request
changes. One delayed read after subscription changes covers an event missed
during attachment; unchanged cause digests cannot dispatch work again. Watched
parent directories are canonicalized and pinned by device/inode. Each event
reopens the task store, verifies the original task-root/messages-directory
identities, and checks the freshly opened record snapshot before deriving a tick.
Atomic replacement of `task.json` is expected; the watcher never keeps using the
original record-file inode.

The orchestration journal is excluded from watched inputs and named journal
events are ignored. Events without a filename may trigger a read-only cause
check, but journal contents are not part of the cause fingerprint, so writing a
reservation cannot self-schedule another tick. Watch errors expose stable generic
codes rather than filesystem paths or request contents.
`pappra collab role-run --watch` requires `--apply`; SIGINT/SIGTERM closes the
watcher and removes the command's signal listeners (exit codes 130/143).

The journal parent must already exist as a real directory inside `task_root`. The
journal is a bounded event/action receipt, not task state: the persisted
`WorkPlan`, current task record, registered envelopes, and the existing
evaluator remain authoritative. It reserves a tick and its conservative action
budget atomically before `runWorkExecution` can cause native notification
effects. The runner separately persists each dispatch intent before
notification. A repeated event ID is never executed twice. An unfinished
reservation returns `duplicate` with a reconciliation indication; it is not
automatically redelivered. A new evidence event can re-inspect authoritative
state and continue. A journal-lock collision with no reserved tick or native
effect gets two bounded retries. A stale lock, corrupt journal or ambiguous
effect then remains closed for operator reconciliation.

### Tick behavior

1. Expand and validate the caller-pinned role request, and require the persisted
   plan file to match it exactly.
2. Inspect via `inspectWorkPlan`, which re-reads the current task record and only
   the registered REPORT/ANSWER evidence relevant to the planned attempts. No
   caller-supplied evaluation can establish readiness or acceptance.
3. Reserve the event round and bounded dispatch opportunities. Re-inspect after
   reservation; include assigned `running` nodes explicitly marked
   `dispatch_pending`, as well as evaluator-ready nodes, with matching
   capability-card inputs. A native execution observation or durable dispatch
   intent removes the pending marker; it never authorizes redelivery.
4. Invoke `runWorkExecution` with `apply: true`, the selected cards, and bounded
   concurrency. That existing runner repeats task, assignment, resource-claim,
   capability, participant, and native-routing checks and durably reserves
   dispatch intent before notification.
5. Re-inspect and aggregate again. Only evaluator-accepted nodes contribute to
   final `accepted`; delivery submission is not acceptance.

An optional explicit planner assignment runs first. Writers depend on its
coordinator acceptance and then remain independent according to the existing
`WorkPlan` graph. The reviewer is not sent until every writer dependency has
completed and has the existing registered coordinator acceptance required by the
evaluator. Omitting the planner preserves direct writer dispatch. Planner output
cannot rewrite assignments or grant execution authority.

`max_rounds` counts distinct event ticks, including waiting and reconciliation
ticks. `max_actions` counts reserved assignment dispatch opportunities across the
plan and is charged conservatively before effects; a crash may consume budget
even if no notification occurred. These bounds cannot be increased for a plan
after its first journal entry. Bounds are capped at 64 rounds/actions and 1,000
attempts.

### Rejected work and repair

A registered rejection stops ordinary dispatch. Without `repair_policy`, the
service returns `repair-required` below `max_attempts`, or `repair-exhausted` at
the bound. Modern evaluator output distinguishes each node's own
`acceptance_blocker` from dependency blockers: rejection of a writer does not
authorize replacing its reviewer. Rejections pass the same report, assignment,
input, epoch and coordinator correlation checks as acceptance.

An explicit `repair_policy.authorizations` entry may pre-authorize one exact
source-to-next transition. It pins coordinator identity/epoch, source
node/attempt/input/resources, next assignee/session/attempt/input/resources, the
immutable next assignment artifact (`assignment_ref` and `assignment_digest`),
approval fields and any changed `next_execution` pins. The next attempt must be
sequential and within the original budget. The artifact must satisfy the real
Assignment contract and match those identity/resource pins. No approval is
generated from model output.

The repair service requires a trusted source-bound native stop receipt before
retiring the old holder, including when its task state is already terminal.
Production CLI/watch supplies this through the task's pre-start managed SDK
runtime registration, authenticated private control socket and OS socket-owner
PID check. An ambiguous stop is durably reserved and never automatically
repeated. This covers the pinned owned SDK runtime, not arbitrary processes or
external writers.

Repair persists intent, closes the source attempt through the existing protocol
when necessary, releases its scoped claims, registers the approved next ASSIGN,
acquires next claims and atomically publishes the matching WorkPlan. Each stage
can fail closed for reconciliation. On subsequent ticks the watcher can keep the
original request: recovery validates current task authority, registered
assignment, claims and published plan before deriving the promoted
plan/execution internally. Original request lineage retains the same round/action
budgets. The normal runner must independently verify fresh capabilities and
native binding before dispatch; a successful repair alone is not readiness.

### Native Pi startup readiness

The managed-Pi readiness consumer derives startup capability availability from
the latest matching `resources_ready` record in the existing
`.pi-events.jsonl` sidecar, paired with the real `session_start`. It does not
wait for `agent_settled`, send a dummy prompt, or require a transcript file to
have been flushed. The record carries the public native header and actual
nullable session-file path; when a transcript already exists, its header is
checked, otherwise no transcript read is claimed. Root emits this observation
only after `InteractiveMode.init()` and actual resource reads.

Readiness validates live session/cwd/model facts, identity pins from the
validated Assignment or bootstrap authority, `SettingsManager.isProjectTrusted()`,
full `getAllTools()`/`getActiveToolNames()` inventory,
`resourceLoader.getSkills()` availability, and the existing bounded SDK
queue/work/approval snapshot. Tools and skills are `callable` at most—not
`verified`—and skill body loading remains `not_observed`. The readiness artifact
pins the sidecar digest; task preflight remains separate and still checks the
current Assignment inputs, required capabilities, freshness, and evidence pins.

The watcher awaits an optional root-owned `beforeRefresh` callback to bind late
valid identity and capture a genuine current resource observation. It retries
corrected/missing Assignment or template inputs without operator card edits. For
SDK-only reload/tool-selection events, root forces the native snapshot with
`publishResourcesReady(true)` before calling `readiness.refresh()`; the callback
then appends only an actual current snapshot and the cause digest prevents that
write from self-scheduling. Watched inputs are the sidecar, Assignment, and
template, never the output card. The watcher pins directories, publishes
atomically, and deduplicates unchanged causes across restart. Existing capability
preflight remains separate and unchanged; it checks current Assignment inputs,
required capabilities, freshness, and evidence pins. Unit fixtures cover protocol
repair and recovery flows; they are not evidence of a live native replacement
launch.

### Boundaries

This is event-driven, not a periodic model poller. It does not infer participant
readiness, approve or merge work, or grant coordinator rights. Only an explicitly
approved repair may mutate assignments/claims and stop an already registered
owned SDK runtime; it does not launch a replacement session. Capability cards,
assignee identities, assignment artifacts, resource scopes, owner epoch and event
IDs remain explicit pins.

## Collaboration recovery

Durable, opt-in recovery for interrupted collaboration tasks. Recovery is layered
so each layer is independently testable and the only component that can touch a
live host is an injected controller that verifies the live target before
dispatching.

- **Projection (advisory).** `inspectRecoveryProjection` (see
  [the recovery projection](#collaboration-recovery-projection)) reads a task
  record and work plan through a bounded, no-follow, namespace-anchored reader
  and reports the single safe recovery recommendation. It writes nothing, queries
  no host, and is not an authorization.
- **Executor (durable).** `executeRecovery`
  (`src/app/collab-recovery-executor.ts`) turns one actionable projection into at
  most one issued continuation/review wake, guarded by an atomic durable
  reservation keyed on the canonical cause.
- **Opt-in Pi controller.** `recoveryExtension`
  (`src/adapters/pi/recovery-extension.ts`) reconciles on supported
  startup/settled/manual triggers, gated by the actual host session.
- **CLI handler.** `runCollaborationRecoveryRunCommand`
  (`src/cli/commands/collaboration-recovery-run.ts`) exposes a `plan`/`apply`
  boundary for the integration router.

New-session handoff, old-writer stop, ownership transfer and archive are a
separate subsystem; see
[collaboration session transition](#collaboration-session-transition).

### Executor (`executeRecovery`)

```ts
const result = await executeRecovery(
  { taskRoot, planFile, self, policy, requestId, mode, expectedSession?, maxRetries? },
  { controller, now?, sleep? },
);
```

- **Plan vs apply.** `plan` validates authority, namespace and the single
  actionable recommendation and writes nothing. `apply` reserves, then issues one
  wake.
- **Canonical-cause reservation.** The durable dedup key is derived from the
  canonical cause identity (task, actor, role, attempt, input, owner epoch and
  the admitted answer/report identity carried in the action key) — **not** from
  the caller `requestId`. A different request id for the same cause does not
  create a second right to send; it returns the recorded outcome. A genuinely
  different cause (a new attempt, input or coordinator answer) is a distinct key
  and is never suppressed by an earlier reservation.
- **Anchored, no-follow sidecars.** The reservation lives at
  `<taskRoot>/.recovery/reservations/<causeKey>.json`. Every sidecar directory
  component is `lstat`-checked to be a real directory inside the task root with
  its inode pinned, and the reservation **file** is created exclusively
  (`O_EXCL`) and updated only through an `O_NOFOLLOW` descriptor whose inode must
  still match the pinned file. A pre-created or swapped `.recovery`/reservation
  symlink — even one installed during a retry backoff — is refused, so a write
  can never escape the task root or overwrite an outside path. The reservation,
  cause, journal and final fields are validated before use; malformed JSON and
  failed field checks stay a conservative unknown. Persistence failures become
  structured blocked/unknown outcomes and never throw out of the host callback,
  and a final receipt is never written through an unsafe path. The initial task
  namespace anchor is retained and re-verified across the whole operation. No OS
  atomic fence or cross-process exactly-once is claimed; writes are fsync'd.
- **Per-attempt journal + fresh re-validation.** Each dispatch attempt appends an
  intent to the durable journal (persisted before the controller call) and
  records its outcome after. Immediately before **every** attempt — including
  after a backoff — the namespace anchor, sidecar anchor, record, plan and
  authority (actor/attempt/input/epoch/approval/cancellation) are re-validated; a
  CANCEL admitted during backoff, a redirect, or a changed recommendation stops
  with no further wake.
- **Known-no-effect-only retry.** A controller reports an `observation`: `none`
  (supported evidence of no effect), `queued`/`applied` (effect issued), or
  `unknown` (a possible/ambiguous effect). Only a `failed`/`unavailable` result
  with observation `none` retries, within a bounded budget and backoff. A thrown
  controller, a post-dispatch failure, or any `unknown`/`queued`/`applied`
  observation stops and is recorded as an actionable unknown — never blindly
  replayed. A `submitted`/`queued` wake is a submission acceptance only, never
  consumption or completion. Numeric retry inputs are bounded (NaN/Infinity fall
  back to the default). After a blocked, refused or unknown final result, a later
  explicit invocation may retry the same cause only when every retained journal
  entry has a completed, known-no-effect outcome and the final observation is
  also `none`. Each invocation gets a fresh bounded retry budget; an exclusive
  generation claim prevents concurrent callers from both resuming that boundary.
  Recorded successful or deferred effects return a successful `noop`; ambiguous
  effects remain `ok: false` / `unknown` and are never silently converted to
  success or reissued. A verified dead owner with no dispatch intent can be
  resumed. Interrupted generation claims are followed through exclusive immutable
  successors instead of deleting a possibly replaced lock; live, malformed or
  excessively long claim chains remain unknown. An incomplete dispatch intent
  still requires supported observation before recovery.
- **Authority and identity.** The acting `self` must match the expected session.
  For a resume the attempt's bound native session must match too; for a
  coordinator review the actor is validated by role and is **not** compared to
  the completed writer's native binding.

The injected `controller` is the only live-host touch.
`herdrRecoveryController` / `createHerdrRecoveryController` list the live Herdr
participants and verify the target agent **exactly**: the live participant's
parsed session identity (via `reportedSessionIdentity`, not a substring) must
equal the expected session, its cwd (required when an expected cwd is pinned) and
pane must match, and — when a task binding is supplied — its live participant and
a recomputed `binding_digest` must match the admitted binding. Task authority is
re-checked through `confirmAuthority` after the awaited live lookup and
immediately before the prompt (closing the lookup-to-send gap). A missing,
foreign or mismatched live target, or revoked authority, is refused without
fallback. They never spawn a process.

### Opt-in Pi controller (`recoveryExtension`)

Loading the extension reads a sibling `recovery.json`
(`PI_RECOVERY_CONFIG_SCHEMA`) and installs `session_start`, `agent_settled` and a
manual `pappra-recovery` trigger. Each trigger observes **genuine host facts**
(`observeHostFacts`) from the pinned installed Pi context —
`ctx.sessionManager.getSessionId()` and `ctx.cwd`, the same shape the accepted
native-event producer uses — and reconciles only when the actual host
session matches the configured expected session — a config loaded in a foreign
session is skipped, and a missing host observation stays explicit (never
fabricated). Reconciliations never overlap.

There is no permanent per-event lock: every supported trigger may reconcile, and
re-issue is prevented durably by the executor's canonical-cause reservation. An
initial no-op therefore does not suppress a later genuine cause, while recovery's
own settled event cannot repeatedly wake an already-reserved cause (no
self-loop). There is no known reconnect event, no completion polling, hidden
daemon or approval auto-answer, and the accepted observation-only native-event
producer is left unchanged.
`createRecoveryReconciler(config, { controller, now?, sleep?, execute? }).reconcile(trigger, hostFacts)`
is exported for tests and for a CLI/manual controller.

### CLI handler (`recovery-run`)

```
pappra collab recovery-run --request <abs recovery-run.json> [--apply] [--json]
```

The request file (`pappra/collab-recovery-run-request/1`) carries `taskRoot`,
`planFile`, `self`, `policy`, `requestId`, optional `expected`, and (for
`--apply`) `target.agent`. Apply requires a complete expected session, cwd,
harness, pane, task-local `binding_ref` and pinned `binding_digest`; it rejects
missing/null identity, participant or binding evidence. The bounded regular
binding file must use `pappra/collab-binding/1`, identify the current task
root/id, and admit exactly the acting native participant and requested Herdr
agent. The executor re-reads and revalidates that binding, current task
actor/attempt/coordinator authority and current projection before every attempt
and after the awaited live lookup immediately before prompting. The callback uses
the actual live Pi `sessionManager.getSessionId()` / `cwd` shape; a completed
writer's native identity is never compared to the coordinator performing a
progress review. Without `--apply`, the handler runs a strict zero-write dry
plan.

An apply request pins the binding file itself, rather than submitting a
caller-created participant hash:

```json
{
  "schema": "pappra/collab-recovery-run-request/1",
  "taskRoot": "/abs/domain/tasks/TASK-1",
  "planFile": "/abs/domain/tasks/TASK-1/work-plan.json",
  "self": { "agent_id": "writer", "session_id": "native-session", "harness": "pi" },
  "policy": { "role": "writer" },
  "requestId": "recovery-request-1",
  "expected": {
    "session_id": "native-session",
    "cwd": "/abs/project",
    "harness": "pi",
    "pane_id": "w3:p4",
    "binding_ref": "/abs/domain/tasks/TASK-1/routing-binding.json",
    "binding_digest": "sha256:<64 lowercase hex digits>"
  },
  "target": { "agent": "herdr-writer" }
}
```

The binding participant must match `self`, every expected native pin, and
`target.agent`; it must name the same `task_root` and `task_id` as the current
task record. Use the digest of the exact binding bytes.

`pappra collab recovery-run` is registered in the public CLI router and help. The
argument parser rejects missing, duplicate and unknown options, while the request
parser rejects malformed and incomplete apply evidence. The handler exports
`parseCollaborationRecoveryRunArgs` and `runCollaborationRecoveryRunCommand` for
tests and future consumers.

### Honest limits

- Recovery is advisory + a single guarded wake; it is **not** automatic
  every-outage recovery and does not prove exactly-once delivery across a crash —
  a `queued` observation is not completion.
- No new session, hidden process, arbitrary command, model override, automatic
  approval or uncertain-effect replay. A possible/ambiguous effect remains an
  actionable unknown until supported observation resolves it.
- Host bundle export is a separate artifact operation (see
  [optional Pi host packages](#optional-pi-host-packages)); session transition is
  its own subsystem.

## Collaboration recovery projection

`inspectRecoveryProjection` is a bounded, read-only product API that analyses the
persisted collaboration record, a work plan and the registered-message namespace
to report the unresolved message-driven actions a recovery executor would still
owe after an interruption. It is an **advisory projection only**: it never
acknowledges, claims, reserves, notifies, starts a model, mutates a file or
grants authority.

It is the first layer of interrupted-workflow recovery; the durable executor and
the opt-in Pi controller build on it. This module exposes only a programmatic
API; the CLI router reaches it through `recovery-run`.

### API

```ts
import * as experimental from '@phyzess/pappra/experimental';

const { inspectRecoveryProjection } = experimental.collabRecoveryProjection;

const result = await inspectRecoveryProjection({
  taskRoot,  // absolute path to the task record directory
  planFile,  // absolute path to the work-plan JSON document
  self,      // full { agent_id, session_id, harness } identity of the caller
  policy,    // { role: 'writer' | 'coordinator' | 'reviewer', authorizedSubtasks?: string[] }
});
```

`inspectRecoveryProjection` is asynchronous (it reuses the bounded work-plan
inspection) and returns a discriminated result:

- `{ ok: true, value: RecoveryProjection }`
- `{ ok: false, reason, message, next_action }` for invalid input or a
  missing/corrupt task record.

#### `RecoveryProjection`

| field | meaning |
| --- | --- |
| `schema` | `pappra/collab-recovery-projection/1` |
| `self` | the caller identity the projection was computed for |
| `task_root` / `task_id` | the inspected task |
| `plan_digest` | the plan digest of the consistent snapshot |
| `record_revision` | the record `state_revision` at read time |
| `coverage` | `complete` or `incomplete` |
| `coordinator_verified` | whether `self` is the current record coordinator (relevant for the coordinator role) |
| `actions` | the advisory `RecoveryAction[]` |
| `notes` | human-readable evidence/limitation notes |
| `limits` | fixed read-only/advisory limitations |

#### `RecoveryAction`

Each action carries a stable, unambiguous `key` (encoding the exact identity a
later reservation/executor reserves on), a `kind`, the
`subtask_id`/`attempt`, `prerequisites`, `evidence` and a `status`.

| kind | when | status |
| --- | --- | --- |
| `resume_work` | a running attempt owned by `self` with no admissible corrective answer | `pending` |
| `answer_supersedes_wait` | a registered coordinator ANSWER, digest-verified and correlated to this exact task/subtask/attempt/input/epoch, supersedes an obsolete wait | `pending` |
| `progress_report_to_review` | the current coordinator has a registered `applied` owner report for the latest attempt/input awaiting review dispatch | `pending` |
| `report_unadmitted` | an awaiting node whose report is late/superseded/withheld/unregistered or digest-unverifiable | `unknown` |
| `blocked_awaiting_gate` | an approval, cancellation or revoked-claim gate holds the attempt | `blocked` |
| `ambiguous_effect` | an unresolved persisted uncertainty is an unknown external effect; it blocks conflicting continuation/review | `unknown` |
| `verified_completion` | the node is completed and coordinator-accepted; nothing to resume | `complete` |
| `none` | nothing actionable | `pending` / `unknown` |

### Guarantees and limits

- **Consistent snapshot.** The record is read (through the bounded no-follow
  reader) before the evaluation, and the record revision/bytes, plan digest and
  task namespace are revalidated AFTER all registered-envelope reads. The
  namespace anchor pins the task root, its messages directory and two ancestors
  by device and inode (`anchorTaskNamespace`/`verifyTaskNamespace`), so a
  same-revision replacement or a redirected task-root/messages directory is
  caught; a symlinked component makes the anchor unavailable. A changed revision,
  changed bytes, a redirected namespace, a stale work-plan, a changed plan digest,
  an evidence-budget overflow or a join gap makes every affected recommendation
  non-actionable (`coverage: incomplete`). A corrupt, oversized, redirected or
  missing record returns a structured refusal rather than throwing. The bootstrap
  writer may concurrently edit its own disjoint source and messages; that is not
  treated as drift of this task record.
- **Bounded.** Record/registry/node scans and file reads are bounded by explicit
  count and byte limits. A latest-page listing is never assumed to be a complete
  inbox; truncation, refusal, a missing join or an overflow is reported as
  non-actionable.
- **Fail-closed correlation.** A continuation ANSWER must be a registered
  envelope, re-read and digest-verified against the authoritative record
  registry, sent by the current coordinator to `self` for exactly this
  task/subtask/attempt/input/epoch. A supplied string digest, an arbitrary
  envelope object or a matching `message_id` alone is not proof. Missing
  correlation stays insufficient; the projection falls back to `resume_work`
  rather than overriding a wait.
- **Strict roles.** A writer or reviewer never receives coordinator
  review-dispatch work. The coordinator role is honoured only when the policy
  role is `coordinator` AND `self` matches the current record coordinator
  identity; a policy role string alone is insufficient. Other role
  recommendations are scoped to the real record attempt owner, not only the
  harness-less plan assignee.
- **Admission.** Review requires the current `applied` owner report for the
  latest matching attempt/input and its exact registered envelope identity/digest;
  late, superseded, withheld and stale-sender evidence is retained but never
  promoted. Coordinator acceptance is read from the work-plan model, not inferred
  from report text or native idle.
- **Report correlation and current claims.** A report is admitted only when the
  registered entry and the re-read envelope fully correlate (type, id, task,
  owner, recipient, subtask, attempt, input, status) and the attempt is under the
  current coordinator epoch; a digest matches bytes, not authority. When several
  valid coordinator corrections exist, the newest in authoritative application
  order is selected. A historical released claim never vetoes a valid current
  held grant; only a current held claim pending cancellation, or a revocation
  with no current grant, gates recovery.
- **No caller-supplied authority.** The projection does not accept a
  caller-supplied future action-evidence input as authority; an unknown external
  effect blocks conflicting continuation/review. Trusted action evidence and
  reservation arrive in the durable executor.
- **Incomplete evidence is non-actionable.** When coverage is incomplete,
  actionable recommendations are downgraded to `unknown` with a
  `complete_evidence` prerequisite; the projection never emits a quiet completion
  or an unqualified pending continuation from incomplete evidence.
- **Read-only.** Inspection performs no writes, host calls, native queries,
  model turns, locks, reservations or notifications, and holds no task write
  lock. This API alone is not automatic recovery.

## Optional Pi host packages

Host bundle export is an artifact operation. It never edits host settings and
does not install, trust, enable, register, load, launch or transfer an
extension. Choose the recovery or transition extension explicitly; no effectful
recovery configuration is loaded by default.

Export an opt-in recovery extension only with an explicitly selected, bounded
private configuration file that satisfies `pappra/pi-recovery-config/1`, includes
the exact session/cwd/harness/pane and task-local binding digest, and points to
the intended task and plan:

```sh
pappra host bundle --host pi --out /absolute/new-private-directory \
  --recovery-config /absolute/private/recovery.json
```

The exported config is written as a private sibling file (mode `0600`) next to
the self-contained extension. Protect the whole exported directory as task-local
sensitive state. Do not copy credentials, transcripts or unrelated task data into
the config or package. Inspect the extension and config before taking any
separate, explicit Pi installation/trust action.

Export the separate session-transition command extension with:

```sh
pappra host bundle --host pi --out /absolute/new-private-directory \
  --transition-extension
```

It exposes `/collab-transition plan|apply <absolute-request.json>` for an
already-bound task. The extension does not start a successor or change settings
when exported or loaded. Its current production Pi adapter cannot prove complete
native quiescence, pending approvals or external writers, so source stop and
claim transfer remain blocked. A reversible task-retirement marker preserves the
original transcript in place; it is not native archive or external route removal.
These artifacts make no automatic takeover or context-handoff support claim.

The existing `--bootstrap-config` flag is a separate opt-in default-deny
successor gate. It is not a recovery switch. Bootstrap, recovery and transition
exports do not weaken the existing staging, identity, trust or no-overwrite
checks.

For host registration and verification limits, see
[host plugin validation](./host-plugin-validation.md); for the transition stage
ordering and native quiescence boundary, see
[collaboration session transition](#collaboration-session-transition).

## Collaboration session transition

`pappra collab transition` is the public, resumable path for moving one
collaboration attempt from an exact source Pi session to a prepared successor.
The implementation composes the existing rollover reducer and visible-bootstrap
flow; it does not replace their ownership rules.

### Commands

```text
pappra collab transition plan  --task-root <absolute-task-root> --request <absolute-request.json> [--json]
pappra collab transition apply --task-root <absolute-task-root> --request <absolute-request.json> [--json]
```

`plan` is read-only. `apply` advances at most the next currently authorized stage
and records an effect intent before any effect that may be ambiguous. Before
source quiescence and claim transfer, CLI-only `apply` returns
`pi_transition_host_required`; those stages require the in-process opt-in Pi
controller. Once the core handoff is completed, registered first-work evidence
and the reversible task-retirement marker can be resumed from the CLI without a
live Pi host. The opt-in Pi extension exposes `/collab-transition plan
<absolute-request.json>` and `/collab-transition apply <absolute-request.json>`;
loading that extension does not itself launch a successor, change Pi settings, or
claim stop-proof capability.

The request uses schema `pappra/collaboration-session-transition-request/1` and
contains:

- `task_root` and `transition_id` (which must equal `intent.intent_id`);
- the exact rollover `intent` (generation, handoff, attempt, input revision,
  source/successor identities, coordinator epoch, and claim IDs/resource epochs);
- one linked continuity bundle root/task/id/digest;
- `bootstrap_request.ref` and the raw-file `sha256:` digest for the explicit
  visible sibling request;
- optional `managed_execution_scope`, pinning the managed-SDK task, source
  session, attempt, owner epoch and ordered claim epochs;
- `evidence.ack_message_id` and `evidence.first_work_report_id`, initially
  nullable; and
- `archive_mode: "task-retirement"`.

All paths are absolute. The transition pins intent, bundle and bootstrap inputs.
ACK/REPORT pointer IDs are later-stage evidence and may be added to the request
without changing its immutable transition digest. Every pointer is still re-read
from the task message store and validated against the current record before use.

### Stage ordering and claims

1. **Plan and intent.** Planning reads the exact task, assignment/card preflight,
   linked continuity bundle, bootstrap request and registered transition STATUS
   pointer. The first apply durably creates/reconciles one rollover intent. The
   current attempt, input revision, owner epoch, source identity,
   cancellation/approval state and source-held claim epochs are revalidated at
   each reducer boundary.
2. **Source quiescence.** A complete, fresh, session-bound proof is required
   before the source is frozen/prepared and before the successor bootstrap can
   run. A freeze receipt by itself is not enough.
3. **Visible successor bootstrap.** The exact task-bound sibling request is
   applied once. Its reservation, output binding and notification state must be
   reconciled after an ambiguous outcome; the transition never silently retries a
   split, start or prompt.
4. **Receiver ACK.** A registered and applied ACK must have the exact successor
   sender, current coordinator recipient/epoch, assignment reply pointer,
   attempt, input revision, handoff, intent and generation. Notification
   submission is not consumption or acceptance.
5. **Ownership and claim transfer.** Only after that ACK does the core reducer
   complete the handoff, reassign the attempt, bind the successor native session
   reference and increment each pinned claim resource epoch. Immediately before
   this step the app re-observes the live successor through its task-local Herdr
   binding and revalidates source proof and current task authority. Herdr
   metadata is not process-affiliation proof; reports continue to say
   `process_affiliation: not-established`.
6. **Successor-only route binding.** A deterministic, task-local successor-only
   binding is written after the core transfer and journaled by absolute path and
   digest. This is a routing input artifact, not proof that external dispatch
   configuration was changed. The original task binding is not overwritten.
7. **First work.** A registered and applied successor REPORT must be after the
   saved transfer boundary and admitted as a completed result for the pinned
   attempt/input. Until then no retirement marker is written.
8. **Reversible task retirement.** After validated first work and route-binding
   receipt, the transition writes
   `archive/session-transitions/<transition-id>.json` and records its digest. The
   marker records `task_id`, `task_root`, `transition_id`, `intent_id`,
   `handoff_id`, `generation`, `recorded_at`, first-work message ID/digest,
   successor-route-binding path/digest, `native_archive: "unavailable"`,
   `original_transcript: "retained-in-place"` and `reversible: true`. It is a
   reversible task-local marker only: the source transcript/session remains in
   place and native Pi session archival is unavailable.

The report keeps `successor-binding-written`, notify exclusion, task retirement
and native archive distinct. A validated succession can make the old identity
excluded from Pappra's notify path while the succession's `routing` field remains
`pending`; this is not external route removal.

### Durable resume and reconciliation

The task record stores `session_transition_journal`
(`pappra/session-transition-journal/1`). Each transition entry pins the immutable
request and bootstrap digests, creation/update times, per-effect
`pending`/`completed`/`unknown`/`failed` receipts, and route/archive paths and
digests when present.

- A completed core reducer stage is inspected, not replayed.
- A pending/unknown freeze is reconciled from the exact in-process freeze token.
  The freeze is never blindly repeated after an ambiguous call.
- Pending/unknown route or retirement writes are continued only when the exact
  task-local bytes and digest are already present. Missing or conflicting
  artifacts stay `reconcile_required`; they are not overwritten or recreated.
- Approval/cancellation, coordinator epoch, attempt/input, task namespace,
  assignment, native identity, claim holder/epoch, ACK/REPORT admission and abort
  are checked again at their relevant effect boundaries.
- An unknown or crashed outcome requires inspection of the authoritative task
  record, message ledger, reservation, host and artifact. A notification or
  report pointer alone is never promoted to consumption or acceptance.

### Pi quiescence boundary

The current opt-in Pi adapter reports the exact blocker
`pi_native_quiescence_proof_unavailable`. It consumes the existing in-process
native-event producer and managed-tool freeze controller, but deliberately does
**not** promote their observations to stop proof:

- `agent_settled`, `ctx.isIdle()`, observed-open-tool counts and a clean callback
  sequence are not a complete inventory;
- queue depth and global pending approvals are unknown;
- observed in-flight tool events are not complete and do not cover
  background/external writers;
- `nativeStop` is always false in the producer; and
- the managed freeze latch is in memory, can be lost on reload, and is not an
  OS/process fence.

The legacy accepted host receipt shape used by the reducer is
`SessionTransitionQuiescenceProof`: adapter id
`pappra/pi-session-transition-host/1`; exact `session_id` and `cwd`; fresh
`observed_at`; monotonic `sequence`; durable `evidence_ref`; the exact
`freeze_token` (`sessionId`, `taskId`, `handoffId`, `generation`); and
`inventory` with `completeness: "complete"`, arrays for `inflight`,
`pending_approvals`, `pending_messages` and optional `partial_outputs`. Before
`prepareRolloverTransfer`, all three pending/in-flight arrays must be empty and
the observed freeze status must carry the same token. This is an interface
contract, not a claim that the installed Pi API can produce it.
For a pinned managed-SDK transition, the v2 proof uses adapter id
`pappra/managed-pi-session-transition-host/2` and additionally pins `scope`,
`execution_scope` and `execution_scope_digest`, `excluded_scope`, runtime
quiescence/blockers, and controller sequence/head/journal health. Its journal
receipt uses schema `pappra/session-transition-quiescence-receipt/2` and retains
`execution_scope_digest`.

The task journal and transition report retain `source_quiescence_receipt` before
preparation and `transfer_quiescence_receipt` immediately before claim movement.
Each receipt records `schema`, `adapter_id`, `session_id`, `cwd`, `observed_at`,
`sequence`, `evidence_ref`, the exact `freeze_token`, the core
`inventory_digest`, and, for v2 scoped receipts, `execution_scope_digest`;
malformed or mismatched receipts invalidate the journal instead of being inferred
from event history.

The generic interactive-Pi production path needs a trusted host operation that
atomically fences the source session against new managed and external writers and
returns a complete session-bound inventory/stop receipt with a durable evidence
reference. At minimum that dependency must define how queued messages,
approvals, nested/background tools and external writers are included, how session
identity and generation are authenticated, and how receipt freshness/replay are
checked. The pinned managed-SDK path instead requires the v2 scoped proof bound
by `managed_execution_scope`; it covers the owned runtime and explicitly excludes
arbitrary external writers and unowned processes. Without the applicable trusted
proof, each path remains blocked before successor launch and claim transfer.
Tests inject a deterministic supported adapter only to verify ordering and
reducers; those fixtures are **not** evidence of Pi host capability.

### Deliberate non-claims

A task binding, Pi event sample, freeze latch, Herdr status, message submission,
applied ACK, admitted REPORT, task-retirement marker, or test-only proof fixture
is not process ownership, native archive, automatic route removal, or end-to-end
takeover acceptance. The implementation changes no model, provider, reasoning
setting, or user Pi configuration.

## Session transition architecture

The session transition path moves a collaboration task from one native Pi session
to its successor. It is a fail-closed state machine split across cohesive
modules; every side effect records durable intent and an outcome receipt so a
crash never promotes an unproven step.

### Module responsibilities

| Module | Responsibility |
| --- | --- |
| `types.ts` | Contracts only: status/stage unions, report, journal and effect receipts, quiescence proof and receipt, host and bootstrap-executor interfaces, dependencies, retirement marker, schema literal constants. No behaviour, no I/O, no import of any sibling module. |
| `context.ts` | Shared primitives and the typed transition context. Owns the small helpers every other module needs (`failure`, `nowIso`, `requestOf`, `immutableDigestOf`, `sameHarnessIdentity`, `parseRegisteredMessageEntry`), the bounded task-local file primitives (`ensureTaskLocalDirectory`, `readTaskLocalFile`, `writeTaskLocalExclusive`, `bootstrapData`), `loadContext` and `validateBootstrapTransition`. |
| `journal.ts` | The durable record: journal bounds and key, `parseQuiescenceReceipt`, `readJournal`/`journalEntry`, the current-state drift checks (`currentStateDrift`, `managedExecutionScopeDrift`), intent/handoff lookup and `sameIntentRequest`, the append/receipt writers (`addJournalEntry`, `setJournalEffect`, `setJournalQuiescenceReceipt`), `intentTransaction` and `hasJournalConflict`. |
| `report.ts` | Report assembly: limitations, capability block, `emptyReport`/`step`, the exact receipt validators (`exactQuiescenceReceipt`, `exactRouteBindingReceipt`, `exactRetirementReceipt`), `reportForContext` and `failureReport`. |
| `effects.ts` | The effect journal protocol: `SessionTransitionEffectName`, `effectPhase`, `recordEffectIntent` and `recordEffectOutcome`. This is the only place that asserts intent-before-effect ordering and reconciles uncertain outcomes. |
| `freeze.ts` | Freeze and quiescence: `plannedSteps`, host identity and proof-support validation, freeze-token equality, the quiescence receipt digest, and `freezeAndPrepare` (freeze, reconcile, prepare-transfer). |
| `routing.ts` | Successor route binding: bootstrap reservation lookup, `validateSuccessorBinding`, and `ensureSuccessorRouteBinding` with its write/reconcile paths. |
| `retirement.ts` | Task retirement: `ensureTaskRetirementMarker`, the reversible marker write and its receipt reconciliation. |
| `collab-session-transition.ts` | The public `plan`/`apply` facade and the orchestration order: preflight, context load, intent, freeze, transfer, successor bootstrap, route binding, first work and retirement, plus the CLI/transport adapters that call them. |

Import direction is one-way and acyclic:

```
types  <-  context  <-  journal  <-  report
                              \  <-  effects  <-  freeze
                                              \  <-  routing  <-  retirement
                                                     \        /
                                                      facade
```

Within this module group, `types.ts` imports no sibling and `context.ts` imports
only `types`. The modules also use existing collaboration, persistence and native
host primitives. No sibling imports the facade or the CLI. Shared state travels
as an explicit typed `TransitionContext`; no module takes a callback bag.

### Invariants

These hold at every step and are covered by the request, transition,
scoped-contract and boundary suites:

1. **Authority and epoch.** A transition acts only for the recorded coordinator
   and only while the task record, resource claims and owner epoch still match.
   Every mutation re-reads the current record under `transact` instead of trusting
   the record loaded earlier.
2. **Journal first, then effect.** `recordEffectIntent` writes a `pending`
   receipt before a side effect starts; `recordEffectOutcome` records
   `completed`, `failed` or `unknown` afterwards. A `pending` receipt found by a
   later run is an uncertain outcome, reported as `reconcile_required`, never a
   silent retry.
3. **Idempotence.** Re-applying an identical request against an identical journal
   reproduces the same report without repeating a completed effect. A different
   request digest for the same transition id is `transition_request_conflict`.
4. **Quiescence proof.** `supported_quiescence` is `available` only with a
   complete scoped proof: matching session, cwd, adapter, freshness, inventory
   digest and freeze token. Idle, settled, a freeze latch, an unscoped receipt or
   a stale proof are all reported as unavailable; the excluded scope (arbitrary
   external writers, unowned processes and descendants) is stated rather than
   assumed away.
5. **Route binding.** The successor route is validated against the live binding
   and the completed bootstrap reservation before ownership moves, and the
   accepted binding digest is what retirement and the report cite. A route that
   cannot be validated fails closed.
6. **Retirement is not archive.** Retirement writes a reversible task-local
   marker and keeps the original transcript in place; `native_session_archive`
   stays `unavailable`. No native session data is deleted or rewritten.
7. **Request behaviour is preserved.** Raw and loaded requests behave identically
   at the public boundary: same kind, same `next_action` semantics, same codes
   for unreadable input, and the same digest of the accepted raw file.
8. **Public names are stable.** The facade keeps its exported names, report
   schema literal and journal key. Module-internal helpers (`TransitionFailure`,
   `TransitionContext`, `ValidatedSuccessorBinding`, `EnsuredRouteBinding`,
   `EnsuredRetirementMarker`) are exported for sibling modules but are not part
   of the facade's public surface.

### Journal and effects

The journal is a single bounded record (`SESSION_TRANSITION_JOURNAL_KEY`, at most
32 entries and 64 KiB). Each entry is keyed by transition id and carries the
request digest, the bootstrap request digest, per-effect receipts and the source
and transfer quiescence receipts. Effect receipts are the only record of whether
a side effect happened, so the intent timestamp is preserved when the outcome is
written and the absence of an outcome is reported as `unknown` rather than
inferred from a clean transport exit. Completed artifacts (route binding,
retirement marker) are pinned to the entry's `*_ref`/`*_digest` fields, and a
receipt that no longer matches its exact task-local file is a reconciliation
failure, not a rewrite.

### Failure reporting

Every report carries a stage, a cause reference, ordered steps and the honest
capability block. Anything the implementation cannot observe (native archive,
in-flight approval completeness, Herdr process affiliation) is reported as
unavailable or unknown; a step that did not run is not reported as done.

## Startup and delivery reliability

### Self-source runtime installation

`pappra runtime install --apply` defaults to the currently executing package
(`source: self`). A self install still creates an npm tarball for source identity
and keeps the existing stage, journal, lock, verification, and atomic-publish
protocol. When every declared dependency is already installed beside the running
package, the installer also copies the resolved dependency tree into the isolated
staging package and materializes that package directly under the staging
`node_modules` tree. This makes self-install independent of registry availability
and the invoking user's npm cache while preserving the package versions already
used by the executing CLI.

If a required dependency is not locally installed, or the dependency manifest is
unusable, the installer keeps the existing npm install path. Missing optional
dependencies are skipped. Exact-version installs and local tarball installs also
continue to use npm. The fast path does not edit the source package, its
manifest, or its package-manager state; the runtime's content digest still covers
the complete installed package tree.

The runtime regression test self-installs a bounded package fixture whose CLI
imports a local dependency. It gives npm a fresh fixture `HOME`/cache and an
unreachable registry, then validates the installed CLI with its version smoke
check.

### Deterministic asset builds

The generated Pi/host bundles use `projectRoot` as esbuild's `absWorkingDir`.
Source-comment paths in the emitted bundles stay relative to the package root
regardless of the caller's current working directory.

### Verification deadlines

The selected-project package smoke test runs the installed CLI with a clean
fixture home. Its runtime-install command has a 150-second outer limit, derived
from the installer's 120-second npm deadline plus a 30-second
diagnostic/cleanup margin. This lets the installer report its bounded failure
instead of having the package-check runner kill it first. Other selected-project
commands and the full test-suite deadline are unchanged.
