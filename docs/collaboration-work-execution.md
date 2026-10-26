# Bounded collaboration work execution

`pappra collab work-run` is the explicit apply boundary for an existing, pinned collaboration work plan. It dispatches already-registered assignments to their task-bound visible participants; it does not create sessions, run models, merge code, review output, or grant authority based on role names.

## Define a planner/writer/reviewer/integrator workflow

The planner produces one `pappra/collab-work-plan/1` document. Every node pins an existing subtask assignment, attempt, input revision, assignee, dependencies, and normalized resources. Two writer nodes can begin together only when their write scopes are disjoint. A reviewer consumes their pinned reports after coordinator acceptance, and an integrator consumes accepted review output:

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

The example is illustrative: the planner must substitute the current task ID, epoch, assignment IDs, attempts, input revisions, identities, and exact resource paths. The corresponding current assignments, matching capability cards, and participant binding must already exist. The CLI request's `capability_cards` entries map each `assignment_id` to its current runtime card:

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

Use the same command for inspection and application:

```sh
pappra collab work-run --request /state/work-execution.json --json
pappra collab work-run --request /state/work-execution.json --apply --json
```

Plan mode performs no writes and sends no notifications. Apply re-reads the plan and task, verifies the current coordinator/epoch, registered assignment and pinned input, matching capability preflight, task-bound sender/recipient binding, and active resource claims. Nodes whose matching assignments are already recorded as assigned-but-not-started can be notified; a report status alone does not create or relaunch work. Independent eligible nodes are sent in a bounded concurrent batch (default two, maximum eight). Conflicting scopes are not launched concurrently.

## Acceptance, results, and recovery

A dependency becomes eligible only after the current coordinator has explicitly accepted the predecessor's exact registered report for the pinned attempt, input revision, and owner epoch. A reviewer role does not authorize acceptance; a writer cannot accept its own report. Rejected work stays blocked and points to an explicit repair under a deliberately issued new attempt. The integrator never merges code automatically. Aggregated results contain stable registered report message IDs, content digests, input revisions, evidence pointers, and output reference/digest pairs, sorted deterministically.

Before the first notification, apply persists a deterministic per-assignment `STATUS_QUERY` intent through the existing collaboration message transaction; it is recorded without delivering that query or changing attempt state. A duplicate intent is never dispatched again. If the process crashes after intent persistence, or notification ends `unknown`, `in_flight_unknown`, or `already_recorded`, the node reports `reconciliation-required` (the report has status `needs-reconciliation`); other notification failures, including blocked, refused and failed, report `blocked`. A later apply does not replay the intent. Inspect current delivery and native evidence, reconcile through the existing supported flow, and create an explicit repair/new attempt if needed. Do not delete the intent or claim that notification means the participant consumed the assignment, completed work, or received acceptance.

The application layer revalidates after asynchronous participant preflight, uses the core task-record revision when persisting each intent, and wraps the production Herdr prompt with a final authority callback after live caller/agent observations. The callback re-reads task state, assignment, capability, binding, claims, dependency acceptance, and the exact persisted intent immediately before the underlying prompt. Those checks reduce stale dispatches but do not provide native OS/process fencing or an atomic transaction with Herdr. Missing, stale, foreign, or ambiguous assignment, capability, claim, identity, epoch, or binding evidence blocks the affected node. The work plan's read-only acceptance evaluation remains authoritative for dependency unlocks.
