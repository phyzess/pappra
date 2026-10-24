import assert from 'node:assert/strict';

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  assert.equal(typeof value, 'object', `${label} must be an object`);
  assert.ok(
    value !== null && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value as JsonRecord;
}

function stringField(value: JsonRecord, key: string): string {
  const field = value[key];
  assert.equal(typeof field, 'string', `${key} must be a string`);
  return field as string;
}

function numberField(value: JsonRecord, key: string): number {
  const field = value[key];
  assert.equal(typeof field, 'number', `${key} must be a number`);
  assert.ok(Number.isSafeInteger(field), `${key} must be a safe integer`);
  return field as number;
}

function stringArray(value: unknown, label: string): string[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  for (const item of value)
    assert.equal(typeof item, 'string', `${label} entries must be strings`);
  return value as string[];
}

function budget(value: unknown, label: string): JsonRecord {
  const result = record(value, label);
  numberField(result, 'rounds');
  numberField(result, 'reserved_actions');
  numberField(result, 'events');
  assert.equal(
    typeof result.digest,
    'string',
    `${label}.digest must be a string`,
  );
  return result;
}

/** Validate an OS-observed hard-kill/restart over an unchanged orchestration journal and budget. */
export function assertControllerRestart(
  firstValue: unknown,
  secondValue: unknown,
): void {
  const first = record(firstValue, 'first controller receipt');
  const second = record(secondValue, 'second controller receipt');
  const firstExit = record(first.exit, 'first controller exit');

  assert.equal(
    firstExit.requested_signal,
    'SIGKILL',
    'first dispatcher must be force-killed through its owned handle',
  );
  assert.equal(
    firstExit.signal,
    'SIGKILL',
    'OS must report the hard-kill signal',
  );
  assert.equal(
    firstExit.code,
    null,
    'hard-killed dispatcher must not report a graceful exit code',
  );
  assert.equal(
    firstExit.observed,
    true,
    'first controller OS exit was not observed',
  );
  const exitAt = stringField(firstExit, 'at');
  assert.ok(exitAt.length > 0, 'first controller exit timestamp is required');

  assert.ok(Number.isSafeInteger(first.pid) && Number(first.pid) > 0);
  assert.ok(Number.isSafeInteger(second.pid) && Number(second.pid) > 0);
  assert.notEqual(
    first.pid,
    second.pid,
    'controller processes must be distinct',
  );
  assert.notEqual(first.process_started_at, second.process_started_at);
  assert.ok(
    Date.parse(stringField(second, 'started_at')) > Date.parse(exitAt),
    'replacement started before old process exit',
  );
  for (const key of ['task_root', 'request_file', 'journal_file'])
    assert.equal(
      first[key],
      second[key],
      `${key} must be unchanged across restart`,
    );
  assert.deepEqual(
    first.limits,
    second.limits,
    'task budget must be unchanged across restart',
  );

  const before = budget(first.journal_before_exit, 'journal before exit');
  const after = budget(first.journal_after_exit, 'journal after exit');
  const restarted = budget(second.journal_on_start, 'journal at restart');
  assert.ok(Number(after.rounds) >= Number(before.rounds));
  assert.ok(Number(after.reserved_actions) >= Number(before.reserved_actions));
  assert.equal(
    after.digest,
    restarted.digest,
    'replacement must resume the exact same journal bytes',
  );
  assert.equal(
    after.rounds,
    restarted.rounds,
    'journal round budget must be retained',
  );
  assert.equal(
    after.reserved_actions,
    restarted.reserved_actions,
    'reserved action budget must be retained',
  );
}

/** Pin each fixture Assignment resource to its current live task claim before launch. */
export function assertRoleAssignmentClaimAccess(
  assignmentValue: unknown,
  claimValues: readonly unknown[],
): boolean {
  const assignment = record(assignmentValue, 'Assignment');
  const assignmentId = stringField(assignment, 'assignment_id');
  const attempt = numberField(assignment, 'attempt');
  assert.ok(
    Array.isArray(assignment.resources),
    'Assignment resources must be an array',
  );
  for (const resourceValue of assignment.resources) {
    const resource = record(resourceValue, 'Assignment resource');
    const resourcePath = stringField(resource, 'path');
    const expectedAccess = stringField(resource, 'access');
    const matches = claimValues
      .map((value) => record(value, 'task claim'))
      .filter(
        (claim) =>
          !claim.released_at &&
          claim.subtask_id === assignmentId &&
          claim.attempt === attempt &&
          claim.path === resourcePath,
      );
    assert.equal(
      matches.length,
      1,
      `expected one active claim for ${assignmentId}:${resourcePath}`,
    );
    const claim = matches[0]!;
    assert.equal(
      claim.access,
      expectedAccess,
      `Assignment and task claim access differ for ${assignmentId}:${resourcePath}`,
    );
    if (resource.resource_epoch !== undefined)
      assert.equal(claim.resource_epoch, resource.resource_epoch);
  }
  return true;
}

/** Validate one pane's cleanup evidence independently of every other pane. */
export function assertNativePaneStopReceipt(receiptValue: unknown): boolean {
  const receipt = record(receiptValue, 'native pane stop receipt');
  assert.equal(
    receipt.safe_to_close_pane,
    true,
    'this pane lacks a successful stop proof',
  );
  assert.equal(
    receipt.pending_work_clear,
    true,
    'pending native work is not proven clear',
  );
  if (
    receipt.cleanup_basis === 'owned_disposal_journal_and_idle_shell_required'
  )
    assert.equal(
      receipt.runtime_disposed_after_stop,
      true,
      'owned SDK disposal journal proof is missing',
    );
  return true;
}

/** Validate native role inputs, registered coordinator decisions, and dependency ordering. */
export function assertNativeRoleAcceptance(
  evidenceValue: unknown,
  expectedRoles: readonly string[],
): void {
  const evidence = record(evidenceValue, 'native role evidence');
  const aggregate = record(evidence.aggregate, 'role aggregate');
  assert.deepEqual(aggregate.outcome, 'accepted');
  assert.deepEqual(
    stringArray(aggregate.accepted_nodes, 'accepted nodes').sort(),
    [...expectedRoles].sort(),
  );
  assert.ok(Array.isArray(evidence.actors), 'native actors must be an array');
  const actors = evidence.actors.map((value) => record(value, 'native actor'));
  assert.deepEqual(
    actors.map((actor) => stringField(actor, 'name')).sort(),
    [...expectedRoles].sort(),
  );

  for (const actor of actors) {
    const name = stringField(actor, 'name');
    assert.equal(actor.provider, 'openrouter');
    assert.equal(actor.model, 'openai/gpt-6-luna');
    assert.equal(
      actor.registered_inputs,
      1,
      `${name} must receive one native input`,
    );
    assert.equal(
      actor.native_agent_starts,
      1,
      `${name} must have one native agent run`,
    );
    assert.equal(
      actor.registered_report,
      true,
      `${name} REPORT was not registered`,
    );
    assert.equal(
      actor.coordinator_acceptance,
      true,
      `${name} acceptance was not registered`,
    );
    const startedAt = stringField(actor, 'started_at');
    const endedAt = stringField(actor, 'ended_at');
    assert.ok(Date.parse(startedAt) < Date.parse(endedAt));
  }

  const byName = new Map(
    actors.map((actor) => [stringField(actor, 'name'), actor]),
  );
  const planner = byName.get('planner');
  const writerA = byName.get('writer-a');
  const writerB = byName.get('writer-b');
  const reviewer = byName.get('reviewer');
  assert.ok(planner && writerA && writerB && reviewer);
  assert.ok(
    stringField(planner, 'ended_at') <= stringField(writerA, 'started_at'),
  );
  assert.ok(
    stringField(planner, 'ended_at') <= stringField(writerB, 'started_at'),
  );
  assert.ok(
    Math.max(
      Date.parse(stringField(writerA, 'started_at')),
      Date.parse(stringField(writerB, 'started_at')),
    ) <
      Math.min(
        Date.parse(stringField(writerA, 'ended_at')),
        Date.parse(stringField(writerB, 'ended_at')),
      ),
    'native writer execution intervals must overlap',
  );
  assert.ok(
    Math.max(
      Date.parse(stringField(writerA, 'accepted_at')),
      Date.parse(stringField(writerB, 'accepted_at')),
    ) < Date.parse(stringField(reviewer, 'started_at')),
    'reviewer must start after both coordinator acceptances',
  );
}
