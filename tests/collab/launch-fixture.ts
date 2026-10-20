import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '../../src/collab/index.js';
import type { Assignment, CapabilityCard } from '../../src/collab/contracts.js';
import type { AdmissionOptions } from '../../src/collab/admission.js';
import { owner } from './scenarios.js';

export function launchFixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'pappra-launch-'));
  const taskRoot = join(root, 'domain', 'tasks', 'sample');
  const writer = {
    agent_id: 'writer',
    session_id: '12345678-1234-4234-8234-123456789012',
    harness: 'pi',
    cwd: root,
    surface: 'rpc',
    configuration_id: 'fixture',
  };
  core.store.initTask(taskRoot, { taskId: 'sample', coordinator: owner });
  const claims = core.resources.claimResources(taskRoot, {
    holder: writer,
    resources: [{ path: join(root, 'work') }],
    subtaskId: 'work',
    attempt: 1,
  });
  assert(claims.ok);
  const input = join(root, 'input.md');
  const promptFile = join(root, 'prompt.md');
  writeFileSync(input, 'Synthetic input.');
  writeFileSync(promptFile, 'Synthetic prompt for the fake runtime only.');
  const assignment: Assignment = {
    schema: 'harness-collab/assignment/1',
    task_id: 'sample',
    assignment_id: 'work',
    objective: 'Exercise the fixture runtime',
    attempt: 1,
    roles: ['implementation'],
    acceptance: ['The fake runtime retains identity.'],
    coordinator: owner,
    assignee: writer,
    inputs: [{ ref: input, digest: core.envelope.sha256File(input) }],
    resources: [
      {
        path: join(root, 'work'),
        access: 'write',
        resource_epoch: claims.resource_epoch,
      },
    ],
    runner: {
      name: 'pi-cli',
      mode: 'fixture',
      profile: 'writer',
      omitted_capabilities: ['mcp'],
    },
    required: { skills: [], tools: [] },
    preferred: { skills: [], tools: [] },
  };
  const card: CapabilityCard = {
    schema: 'harness-collab/capabilities/1',
    ...writer,
    observed_at: new Date().toISOString(),
    evidence_level: 'runtime',
    skills: [],
    tools: [],
  };
  const assignmentFile = join(root, 'assignment.json');
  const capabilitiesFile = join(root, 'capabilities.json');
  writeFileSync(assignmentFile, JSON.stringify(assignment));
  writeFileSync(capabilitiesFile, JSON.stringify(card));
  core.messages.submitMessage(
    taskRoot,
    core.envelope.buildMessage({
      type: 'ASSIGN',
      task_id: 'sample',
      from: owner,
      to: writer,
      subtask_id: 'work',
      attempt: 1,
      owner_epoch: 1,
      body: {
        assignment_ref: assignmentFile,
        assignment_digest: core.envelope.sha256File(assignmentFile),
        input_revision: core.envelope.sha256File(input),
      },
    }),
  );
  const options: AdmissionOptions = {
    assignmentFile,
    capabilitiesFile,
    taskRoot,
    cwd: root,
    sessionId: writer.session_id,
    harness: 'pi',
    profile: 'writer',
  };
  return {
    root,
    taskRoot,
    writer,
    assignment,
    card,
    assignmentFile,
    capabilitiesFile,
    promptFile,
    options,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
