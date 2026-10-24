# Managed Pi initial task admission

`watchManagedPiInitialAdmission` bridges a controller-owned Pi session to its first task-owned execution scope. It does not start or adopt a process, create an ASSIGN, grant readiness, or manufacture native evidence.

## Admission sequence

1. The host supplies the canonical task root and a startup `assignmentFile` preview path. The helper pins that path's parent-directory identity. The preview's contents are advisory only: they may be missing or replaced before the task store admits dispatch, and they grant no authority.
2. The helper waits for a current Task attempt and an applied `ASSIGN` message matching the configured subtask/attempt, owner epoch, coordinator actor, assignee and input revision. The Assignment artifact is reread through the bounded file reader and must match the attempt's exact `assignment_ref` and `assignment_digest`. The `assignment_id` is deliberately not used as the task-store subtask id.
3. It requires the latest active attempt, no pending approval, awaiting state, cancellation or dispatch freeze, and current unreleased claims held by the exact Pi agent/session. Every Assignment resource must match a claim's canonical path, access and (when specified) resource epoch. The scope contains the current claims; the artifact never adds or widens claims.
4. It waits for complete, idle native inventory and calls the real `bindManagedPiExecutionScope`. The supplied callback must complete before the binding is published. A failed callback does not publish a binding, and refreshes are serialized/coalesced.
5. After binding, `canExecute()` rereads the bounded task record and authoritative artifact synchronously, checks the task namespace, attempt/epoch/input/ASSIGN/claim and observed native identity pins, and denies on drift or close. No polling timer is used.

The managed SDK CLI wires this helper through the optional `initialAssignment` request field:

```json
{
  "taskRoot": "/absolute/private/domain/tasks/task-id",
  "assignmentFile": "/absolute/private/role.assignment.json",
  "subtaskId": "writer-a",
  "attempt": 1,
  "ownerEpoch": 1,
  "inputRevision": "sha256:<64 hexadecimal characters>"
}
```

This mode requires a fresh SDK UUID and cannot be combined with an immediate execution scope, bootstrap receiver, or automatic-handoff source. The preview grants no execution authority. A task-local pending-launch entry supports discovery only after authenticated SDK control, OS socket-owner PID and foreground-pane PID agree.

The CLI creates the watcher before native input and gates semantic methods, provider runs and managed tools with the current authority check. Binding the idle runtime records its owned endpoint; task-native execution is confirmed from the real `agent_start`, so an assigned session is not mistaken for an already-dispatched task. Historical retry approval must match its registered ASSIGN; an actual pending approval still blocks. Settlement refreshes admission on the next event-loop turn, after the SDK has finalized idle state.

Startup readiness may precede ASSIGN with zero model input. MCP discovery and tool selection changes trigger coalesced observations of actual native resources and refresh the card without an operator editing evidence. Registered-message delivery rechecks admission before passing the pointer to the owned SDK.

## Test boundary

`tests/hosts/managed-initial-admission.test.ts` uses real local task-store message/claim protocols with a controlled SDK port. Native startup, deferred ASSIGN, actual OpenRouter work and multi-role acceptance are separately recorded in the integration acceptance report; unit fixtures alone are not native evidence.
