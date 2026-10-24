# Collaboration role orchestration

`src/app/collab-role-orchestration.ts` adds the reusable `tickRoleOrchestration(request, deps)` service. The caller supplies the already explicit `RolePlanRequest`, existing `WorkExecutionRequest` pins, a stable session-event ID, a task-local journal path, and fixed bounds. `src/app/collab-role-events.ts` supplies the event watcher and shared request loader; `src/cli/commands/collaboration-role-run.ts` supports one-shot and watch operation. Root owns package exports and top-level CLI flag parsing.

```ts
const result = await tickRoleOrchestration({
  role_plan: explicitRolePlanRequest,
  execution: existingWorkExecutionRequest,
  event_id: appliedSessionEventId,
  journal_file: `${taskRoot}/role-orchestration.json`,
  limits: { max_rounds: 12, max_actions: 8, max_attempts: 3 },
});
```


## Event watch and CLI

`watchRoleOrchestration(requestFile, onResult)` reuses `loadRoleRunRequest`; it does not parse a second request format. It watches the request, task record, and current capability-card files, then rebinds subscriptions when the request changes. One delayed read after subscription changes covers an event missed during attachment; unchanged cause digests cannot dispatch work again. Watched parent directories are canonicalized and pinned by device/inode. Each event reopens the task store, verifies the original task-root/messages-directory identities, and checks the freshly opened record snapshot before deriving a tick. Atomic replacement of `task.json` is expected; the watcher never keeps using the original record-file inode.

The orchestration journal is excluded from watched inputs and named journal events are ignored. Events without a filename may trigger a read-only cause check, but journal contents are not part of the cause fingerprint, so writing a reservation cannot self-schedule another tick. Watch errors expose stable generic codes rather than filesystem paths or request contents. `pappra collab role-run --watch` requires `--apply`; SIGINT/SIGTERM closes the watcher and removes the command's signal listeners (exit codes 130/143).

The journal parent must already exist as a real directory inside `task_root`. The journal is a bounded event/action receipt, not task state: the persisted `WorkPlan`, current task record, registered envelopes, and the existing evaluator remain authoritative. It reserves a tick and its conservative action budget atomically before `runWorkExecution` can cause native notification effects. The runner separately persists each dispatch intent before notification. A repeated event ID is never executed twice. An unfinished reservation returns `duplicate` with a reconciliation indication; it is not automatically redelivered. A new evidence event can re-inspect authoritative state and continue. A journal-lock collision with no reserved tick or native effect gets two bounded retries. A stale lock, corrupt journal or ambiguous effect then remains closed for operator reconciliation.

## Tick behavior

1. Expand and validate the caller-pinned role request, and require the persisted plan file to match it exactly.
2. Inspect via `inspectWorkPlan`, which re-reads the current task record and only the registered REPORT/ANSWER evidence relevant to the planned attempts. No caller-supplied evaluation can establish readiness or acceptance.
3. Reserve the event round and bounded dispatch opportunities. Re-inspect after reservation; include assigned `running` nodes explicitly marked `dispatch_pending`, as well as evaluator-ready nodes, with matching capability-card inputs. A native execution observation or durable dispatch intent removes the pending marker; it never authorizes redelivery.
4. Invoke `runWorkExecution` with `apply: true`, the selected cards, and bounded concurrency. That existing runner repeats task, assignment, resource-claim, capability, participant, and native-routing checks and durably reserves dispatch intent before notification.
5. Re-inspect and aggregate again. Only evaluator-accepted nodes contribute to final `accepted`; delivery submission is not acceptance.

An optional explicit planner assignment runs first. Writers depend on its coordinator acceptance and then remain independent according to the existing `WorkPlan` graph. The reviewer is not sent until every writer dependency has completed and has the existing registered coordinator acceptance required by the evaluator. Omitting the planner preserves direct writer dispatch. Planner output cannot rewrite assignments or grant execution authority.

`max_rounds` counts distinct event ticks, including waiting and reconciliation ticks. `max_actions` counts reserved assignment dispatch opportunities across the plan and is charged conservatively before effects; a crash may consume budget even if no notification occurred. These bounds cannot be increased for a plan after its first journal entry. Bounds are capped at 64 rounds/actions and 1,000 attempts.

## Rejected work and repair

A registered rejection stops ordinary dispatch. Without `repair_policy`, the service returns `repair-required` below `max_attempts`, or `repair-exhausted` at the bound. Modern evaluator output distinguishes each node's own `acceptance_blocker` from dependency blockers: rejection of a writer does not authorize replacing its reviewer. Rejections pass the same report, assignment, input, epoch and coordinator correlation checks as acceptance.

An explicit `repair_policy.authorizations` entry may pre-authorize one exact source-to-next transition. It pins coordinator identity/epoch, source node/attempt/input/resources, next assignee/session/attempt/input/resources, the immutable next assignment artifact (`assignment_ref` and `assignment_digest`), approval fields and any changed `next_execution` pins. The next attempt must be sequential and within the original budget. The artifact must satisfy the real Assignment contract and match those identity/resource pins. No approval is generated from model output.

The repair service requires a trusted source-bound native stop receipt before retiring the old holder, including when its task state is already terminal. Production CLI/watch supplies this through the task's pre-start managed SDK runtime registration, authenticated private control socket and OS socket-owner PID check. An ambiguous stop is durably reserved and never automatically repeated. This covers the pinned owned SDK runtime, not arbitrary processes or external writers.

Repair persists intent, closes the source attempt through the existing protocol when necessary, releases its scoped claims, registers the approved next ASSIGN, acquires next claims and atomically publishes the matching WorkPlan. Each stage can fail closed for reconciliation. On subsequent ticks the watcher can keep the original request: recovery validates current task authority, registered assignment, claims and published plan before deriving the promoted plan/execution internally. Original request lineage retains the same round/action budgets. The normal runner must independently verify fresh capabilities and native binding before dispatch; a successful repair alone is not readiness.

## Native Pi startup readiness

The managed-Pi readiness consumer now derives startup capability availability from the latest matching `resources_ready` record in the existing `.pi-events.jsonl` sidecar, paired with the real `session_start`. It does not wait for `agent_settled`, send a dummy prompt, or require a transcript file to have been flushed. The record carries the public native header and actual nullable session-file path; when a transcript already exists, its header is checked, otherwise no transcript read is claimed. Root emits this observation only after `InteractiveMode.init()` and actual resource reads.

Readiness validates live session/cwd/model facts, identity pins from the validated Assignment or bootstrap authority, `SettingsManager.isProjectTrusted()`, full `getAllTools()`/`getActiveToolNames()` inventory, `resourceLoader.getSkills()` availability, and the existing bounded SDK queue/work/approval snapshot. Tools and skills are `callable` at most—not `verified`—and skill body loading remains `not_observed`. The readiness artifact pins the sidecar digest; task preflight remains separate and still checks the current Assignment inputs, required capabilities, freshness, and evidence pins.

The watcher awaits an optional root-owned `beforeRefresh` callback to bind late valid identity and capture a genuine current resource observation. It retries corrected/missing Assignment or template inputs without operator card edits. For SDK-only reload/tool-selection events, root calls `readiness.refresh(true)`; the callback then appends only an actual current snapshot and the cause digest prevents that write from self-scheduling. Watched inputs are the sidecar, Assignment, and template, never the output card. The watcher pins directories, publishes atomically, and deduplicates unchanged causes across restart. Existing capability preflight remains separate and unchanged; it checks current Assignment inputs, required capabilities, freshness, and evidence pins. Producer and managed-SDK startup are integrated independently of the unit fixtures. Native acceptance evidence is recorded separately; unit tests alone do not prove a live replacement launch.

## Boundaries

This is event-driven, not a periodic model poller. It does not infer participant readiness, approve or merge work, or grant coordinator rights. Only an explicitly approved repair may mutate assignments/claims and stop an already registered owned SDK runtime; it does not launch a replacement session. Capability cards, assignee identities, assignment artifacts, resource scopes, owner epoch and event IDs remain explicit pins. Tests cover real protocol repair and two-tick recovery with missing readiness; successful fresh-native replacement dispatch is checked separately in the integration acceptance report.
