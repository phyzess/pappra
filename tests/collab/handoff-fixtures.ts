import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMessage } from '../../src/collab/envelope.js';
import { submitMessage } from '../../src/collab/messages.js';
import type { Message } from '../../src/collab/types.js';
import { claimResources } from '../../src/collab/resources.js';
import { upsertAssignment } from '../../src/collab/lifecycle.js';
import { transact } from '../../src/collab/store.js';
import type { Identity } from '../../src/collab/types.js';
import {
  makeTaskDomain,
  type TaskDomainFixture,
} from './task-resources-fixtures.js';

export const COORDINATOR: Identity = {
  agent_id: 'coordinator',
  session_id: 'coord-session',
  harness: 'pi',
};
export const WRITER: Identity = {
  agent_id: 'writer',
  session_id: 'writer-session',
  harness: 'codex',
};
export const RECEIVER: Identity = {
  agent_id: 'receiver',
  session_id: 'receiver-session',
  harness: 'claude',
};
export const NEXT_COORDINATOR: Identity = {
  agent_id: 'next-coordinator',
  session_id: 'next-coord-session',
  harness: 'codex',
};

export interface HandoffFixture {
  readonly domain: TaskDomainFixture;
  readonly task: string;
  readonly claimId: string;
}

export function makeHandoffFixture(label: string): HandoffFixture {
  const domain = makeTaskDomain(label, ['sample']);
  const task = domain.tasks.sample!;
  const assignment = buildMessage({
    message_id: 'msg-c5-seed-assignment',
    type: 'ASSIGN',
    task_id: 'sample',
    from: COORDINATOR,
    to: WRITER,
    subtask_id: 'work',
    attempt: 1,
    owner_epoch: 1,
    body: {
      assignment_digest: 'sha256:fixture',
      input_revision: 'input-a',
    },
  });
  const seeded = transact(task, {
    actor: 'fixture',
    purpose: 'seed-assignment',
    apply: (record) => {
      const result = upsertAssignment(record, { message: assignment });
      if (!result.ok) return result;
      return {
        record,
        op: 'seed-assignment',
        summary: { subtask_id: 'work', attempt: 1 },
        result,
      };
    },
  });
  if (!seeded.ok)
    throw new Error(`Could not seed handoff assignment: ${seeded.reason}`);
  const claim = claimResources(task, {
    resources: [{ kind: 'path', path: join(domain.root, 'work') }],
    holder: WRITER,
    subtaskId: 'work',
    attempt: 1,
  });
  if (!claim.ok)
    throw new Error(`Could not seed handoff claim: ${claim.reason}`);
  return { domain, task, claimId: claim.claims[0]!.claim_id };
}

export interface ConfirmationSeed {
  readonly handoffId: string;
  readonly messageId?: string;
  readonly from?: Identity;
  readonly to?: Identity;
  readonly ownerEpoch?: number;
  readonly phase?: string;
  readonly type?: 'HANDOFF' | 'ACK';
  readonly body?: Record<string, unknown>;
}

export function seedConfirmation(
  task: string,
  seed: ConfirmationSeed,
): Message {
  const message = buildMessage({
    message_id: seed.messageId ?? 'msg-c5-confirmation',
    type: seed.type ?? 'HANDOFF',
    task_id: 'sample',
    from: seed.from ?? RECEIVER,
    to: seed.to ?? COORDINATOR,
    subtask_id: 'work',
    owner_epoch: seed.ownerEpoch ?? 1,
    body: {
      handoff_id: seed.handoffId,
      phase: seed.phase ?? 'confirmation',
      ...(seed.body ?? {}),
    },
  });
  const outcome = submitMessage(task, message);
  if (!outcome.ok)
    throw new Error(`Could not seed confirmation: ${String(outcome.reason)}`);
  return message;
}

export function writeRequest(
  domain: TaskDomainFixture,
  name: string,
  value: unknown,
): string {
  const file = join(domain.root, name);
  writeJson(file, value);
  return file;
}
function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
