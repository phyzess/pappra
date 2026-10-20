import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HostName } from '../schemas/host.js';
import type { Diagnostic } from '../schemas/diagnostics.js';
import { prepareCollaboration, type PreparedBundle } from './collaboration.js';

export interface CollabResource {
  readonly path: string;
  readonly access: 'read' | 'write';
}

export interface PrepareFromObjectiveInput {
  readonly domainRoot: string;
  readonly objective: string;
  readonly taskId: string;
  readonly subtaskId?: string;
  readonly attempt?: number;
  readonly phase?:
    'discovery' | 'implementation' | 'review' | 'handoff' | 'fix';
  readonly acceptance: readonly string[];
  readonly prompt?: string;
  readonly coordinatorSession: string;
  readonly assigneeSession: string;
  readonly harness?: HostName;
  readonly resources: readonly CollabResource[];
}

export type PrepareFromObjectiveResult =
  | {
      readonly ok: true;
      readonly prepared: PreparedBundle['prepared'];
      readonly goal: PreparedBundle['goal'];
      readonly cardPath: string;
      readonly card: Record<string, unknown>;
      readonly notes: readonly string[];
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly diagnostics: readonly Diagnostic[];
    };

export async function prepareFromObjective(
  input: PrepareFromObjectiveInput,
): Promise<PrepareFromObjectiveResult> {
  const harness = input.harness ?? 'pi';
  if (input.resources.length === 0) {
    return {
      ok: false,
      code: 'collab_resource_required',
      message:
        'A collaboration goal needs at least one explicit resource (file or directory).',
      diagnostics: [],
    };
  }
  const goal = {
    schema: 'pappra/collaboration-goal/1' as const,
    task_id: input.taskId,
    subtask_id: input.subtaskId ?? 'work',
    attempt: input.attempt ?? 1,
    phase: input.phase ?? ('implementation' as const),
    objective: input.objective,
    acceptance: [...input.acceptance],
    prompt: input.prompt ?? input.objective,
    coordinator: {
      agent_id: 'coordinator',
      session_id: input.coordinatorSession,
      harness: 'codex',
      owner_epoch: 1,
    },
    assignee: {
      agent_id: 'worker',
      session_id: input.assigneeSession,
      harness,
      surface: 'rpc',
      configuration_id: 'daily',
      cwd: input.resources[0]!.path,
    },
    resources: input.resources.map((resource) => ({
      path: resource.path,
      access: resource.access,
    })),
    required: { skills: [], tools: [] },
    preferred: { skills: [], tools: [] },
  };
  const prepared = await prepareCollaboration(goal, {
    domainRoot: input.domainRoot,
  });
  if (!prepared.ok) {
    return {
      ok: false,
      code: prepared.code,
      message: prepared.message,
      diagnostics: prepared.diagnostics ?? [],
    };
  }
  const card = {
    schema: 'harness-collab/capabilities/1',
    agent_id: goal.assignee.agent_id,
    session_id: goal.assignee.session_id,
    harness: goal.assignee.harness,
    surface: goal.assignee.surface,
    configuration_id: goal.assignee.configuration_id,
    cwd: goal.assignee.cwd,
    observed_at: new Date().toISOString(),
    evidence_level: 'declared',
    skills: [],
    tools: [],
  };
  const cardPath = join(
    prepared.value.prepared.prepared_dir,
    'card.declared.json',
  );
  await mkdir(prepared.value.prepared.prepared_dir, { recursive: true });
  await writeFile(cardPath, `${JSON.stringify(card, null, 2)}\n`, {
    mode: 0o600,
  });
  return {
    ok: true,
    prepared: prepared.value.prepared,
    goal: prepared.value.goal,
    cardPath,
    card,
    notes: [
      'The generated capability card is declared, not runtime evidence: a work launch will refuse it.',
      'For a real launch, provide a runtime capability card observed from an admitted session.',
    ],
  };
}
