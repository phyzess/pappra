import path from 'node:path';
import { coordinatorLineage, hasSuccession } from '../../collab/lineage.js';
import { readRecord } from '../../collab/store.js';
import {
  collabBindingSchema,
  type CollabBinding,
} from '../../schemas/collaboration.js';
import { workflowBindingPath } from '../../schemas/collab-workflow.js';
import { readBoundedJson } from './context.js';

/**
 * Binding generations (docs/mid-cohort-succession-spec.md, section 9).
 *
 * The sealed `binding.json` is generation 0 and names the coordinator that prepared the cohort.
 * It is never edited. After a coordinator succession the successor adopts the task, which creates
 * `binding.e<epoch>.json` exclusively: the previous generation's participants with the successor's
 * own pane and native session as the coordinator entry. Routing then follows the highest
 * generation that describes the coordinator the record names now.
 */
export function bindingGenerationPath(taskRoot: string, epoch: number): string {
  return path.join(taskRoot, `binding.e${epoch}.json`);
}

/** Reads one generation; an unreadable or malformed file is simply not a usable generation. */
export function readBindingGeneration(file: string): CollabBinding | null {
  const read = readBoundedJson(file, 'task binding');
  if (!read.ok) return null;
  const parsed = collabBindingSchema.safeParse(read.value);
  return parsed.success ? parsed.data : null;
}

/**
 * The binding file the workflow facade passes to the notifier. Without a succession, or when no
 * generation describes the current coordinator, it is the sealed generation 0, so a task that
 * was never adopted routes exactly as before.
 */
export function currentBindingFile(taskRoot: string): string {
  const sealed = workflowBindingPath(taskRoot);
  const record = readRecord(taskRoot);
  if (record === null || record.coordinator === null) return sealed;
  const lineage = coordinatorLineage(record);
  if (!hasSuccession(lineage) || lineage.current === null) return sealed;
  const coordinator = record.coordinator;
  for (let epoch = lineage.current; epoch >= 2; epoch -= 1) {
    const file = bindingGenerationPath(taskRoot, epoch);
    const binding = readBindingGeneration(file);
    if (
      binding !== null &&
      binding.participants.some(
        (item) =>
          item.agent_id === coordinator.agent_id &&
          item.native_session_id === coordinator.session_id,
      )
    )
      return file;
  }
  return sealed;
}

/**
 * After a coordinator succession and before `workflow adopt`, accept and dispatch still work but
 * their notifications are routed by the sealed binding, which does not describe the successor.
 * They warn instead of refusing, so a missed adoption never blocks the cohort.
 */
export function unadoptedWarning(taskRoot: string): string | null {
  const record = readRecord(taskRoot);
  if (record === null || !hasSuccession(coordinatorLineage(record)))
    return null;
  return currentBindingFile(taskRoot) === workflowBindingPath(taskRoot)
    ? 'The coordinator changed and this task is not adopted: notifications will not reach the successor until `collab workflow adopt` writes the binding generation.'
    : null;
}
