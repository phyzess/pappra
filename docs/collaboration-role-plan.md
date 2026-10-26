# Collaboration role-plan slice

`src/app/collab-role-plan.ts` is a pure adapter from an explicit writer/reviewer request to the existing `WorkPlan` contract. It does not create a second scheduler, inspect runtime state, dispatch work, or grant authority. The package exposes the module as `collabRolePlan` from `@phyzess/pappra/experimental`. The public CLI provides `pappra collab role-plan expand --request <abs role-plan.json>` and `pappra collab role-plan aggregate --request <abs role-plan.json> --task-root <abs> --config <abs expanded-plan.json>`. Aggregate re-expands the request, requires the persisted plan to match, and uses `inspectWorkPlan`'s authoritative core; it does not accept a supplied evaluation artifact.

## Request and expansion

`expandRolePlan(request: RolePlanRequest)` requires:

- `schema`, `plan_id`, `task_id`, and a caller-pinned positive `owner_epoch`;
- explicitly declared `participants`, each with a unique `participant_id`, `planner`, `writer` or `reviewer` role, and `agent_id`/`session_id` assignee;
- one or more `writer` assignments and exactly one `reviewer` assignment;
- each assignment's unique `node_id` and `assignment_id`, attempt, input revision, participant reference, and non-empty explicit resource list.

The participant role must match each assignment role, and the reviewer must use a different agent/session identity from every writer. Undeclared, mismatched, duplicate, and unused participants are refused rather than inferred. Every resource uses the existing work-plan `{ path, access: 'read' | 'write' }` shape and is validated by `validateWorkPlan` after expansion. As in the existing evaluator, writer resource paths may not overlap when either side writes; read/read overlap is allowed. Conflicting writer scopes, including overlapping writes assigned to the same participant, are refused rather than serialized. This is path-scope validation, not resource fencing.

The success result contains the validated existing `WorkPlan` and `roles`: optional `planner_node_id`, `writer_node_ids`, and `reviewer_node_id`. Without a planner, writer nodes have no dependencies and remain independently schedulable by the existing executor; when a planner is declared, every writer depends on that planner's acceptance. The reviewer node depends on every writer node. The existing evaluator gates each dependency on a completed report plus registered coordinator acceptance; a report, a role label, or a completed writer alone does not unlock review.

```ts
const expanded = expandRolePlan(request);
if (expanded.ok) {
  const { plan, roles } = expanded;
  // Reuse the existing inspect/evaluate/execute flow with `plan`.
}
```

The planner does not decide that an assignee is currently ready, available, authorized, or able to claim the declared resources. `owner_epoch`, participant identities, assignment IDs/attempts, input revisions, and resource scopes are caller-supplied pins, not proof of live state.

## Aggregation

`aggregateRolePlan(expansion, evaluation)` consumes only the existing `WorkPlanEvaluation` or `WorkPlanRefusal`. It preserves per-node `accepted`, `rejected`, `unknown`, `missing`, `pending`, and `blocked` outcomes, along with observed work-plan status and blocker codes.

The aggregate outcome is `accepted` only when every planned planner (when present), writer and reviewer node is explicitly `accepted` in a matching work-plan evaluation. A rejection, uncertainty, absent result, or other non-accepted state cannot be folded into success. Evaluation refusals and unrecognized/malformed node statuses remain `unknown`; omitted expected nodes remain `missing`. Per-node arrays retain those states even when the aggregate outcome prioritizes a rejection or uncertainty.

Delivery is intentionally not an aggregation input. A submitted, successful-looking, or otherwise known delivery does not establish completion or acceptance. The work-plan evaluator's registered evidence and acceptance semantics remain authoritative for these statuses; this adapter performs no native query or readiness inference.

## Bounds and refusal behavior

The slice accepts at most 64 assignments/participants and at most 16 resources per assignment, matching the existing work-plan node/dependency bounds. Malformed requests, missing roles or pins, invalid work-plan resources, duplicate assignment IDs, and conflicting writer scopes return typed diagnostics. No partial plan is returned on refusal.
