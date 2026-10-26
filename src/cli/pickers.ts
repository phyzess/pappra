import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { HostCapabilities } from '../schemas/host.js';
import { taskContextSchema } from '../schemas/continuity.js';
import { readTextFileBounded } from '../infra/fs.js';
import { loadWorkspaceConfig } from '../workspace/config.js';
import type { SelectOption } from './interactive.js';

/**
 * Read-only candidate listings shared by interactive commands. Each helper only
 * observes declared or already-stored state; nothing here registers, resolves a
 * host callable, or writes.
 */

/** Declared workspace repositories from the resolved workspace configuration. */
export async function workspaceRepositoryOptions(
  root: string,
): Promise<SelectOption[]> {
  const config = await loadWorkspaceConfig(root, { missing: 'info' });
  if (!config.ok) return [];
  return config.value.repositories.map((repository) => ({
    value: repository.id,
    label: repository.id,
    hint: repository.path,
  }));
}

/**
 * Passive host labels. A caller-supplied `--host-version` is not host-specific,
 * so the hint only reports installation, never a version.
 */
export function hostOptions(
  capabilities: readonly HostCapabilities[],
): SelectOption[] {
  return capabilities.map((capability) => ({
    value: capability.host,
    label: capability.host,
    hint: capability.executablePath === null ? 'not installed' : 'installed',
  }));
}

interface StoredTask {
  readonly taskId: string;
  readonly objective: string;
  readonly updatedAt: string;
}

/**
 * Tasks with a readable private task context, newest first. Unreadable or
 * invalid task directories are skipped instead of reported as resumable.
 */
export async function checkpointTaskOptions(
  root: string,
): Promise<SelectOption[]> {
  const tasksDir = join(root, '.pappra', 'local', 'tasks');
  let entries;
  try {
    entries = await readdir(tasksDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const tasks: StoredTask[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const read = await readTextFileBounded(
      join(tasksDir, entry.name, 'task-context.json'),
      64 * 1024,
    );
    if (!read.ok) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(read.value.text);
    } catch {
      continue;
    }
    const parsed = taskContextSchema.safeParse(raw);
    if (!parsed.success || parsed.data.taskId !== entry.name) continue;
    tasks.push({
      taskId: parsed.data.taskId,
      objective: parsed.data.objective,
      updatedAt: parsed.data.updatedAt,
    });
  }
  tasks.sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.taskId.localeCompare(right.taskId),
  );
  return tasks.map((task) => ({
    value: task.taskId,
    label: task.taskId,
    hint: task.objective,
  }));
}
