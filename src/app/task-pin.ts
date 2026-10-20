import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readTextFileBounded } from '../infra/fs.js';
import { workspaceConfigSchema } from '../schemas/workspace.js';

export const TASK_PIN_SCHEMA = 'pappra/task-pin/1';

export interface TaskPin {
  readonly schema: typeof TASK_PIN_SCHEMA;
  readonly taskId: string;
  readonly pinnedAt: string;
}

export interface TaskPinFailure {
  readonly ok: false;
  readonly message: string;
}

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function pinPath(root: string): string {
  return join(root, '.pappra', 'local', 'current-task');
}

export async function readTaskPin(root: string): Promise<TaskPin | null> {
  const read = await readTextFileBounded(pinPath(root), 64 * 1024);
  if (!read.ok) return null;
  try {
    const value: unknown = JSON.parse(read.value.text);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('schema' in value) ||
      value.schema !== TASK_PIN_SCHEMA ||
      !('taskId' in value) ||
      typeof value.taskId !== 'string' ||
      !TASK_ID.test(value.taskId)
    ) {
      return null;
    }
    return value as TaskPin;
  } catch {
    return null;
  }
}

export async function pinTask(
  root: string,
  taskId: string,
): Promise<TaskPin | TaskPinFailure> {
  if (!TASK_ID.test(taskId)) {
    return {
      ok: false,
      message:
        'task id must be a short identifier (letters, digits, dot, dash, underscore).',
    };
  }
  const pin: TaskPin = {
    schema: TASK_PIN_SCHEMA,
    taskId,
    pinnedAt: new Date().toISOString(),
  };
  const target = pinPath(root);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(pin, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, target);
  return pin;
}

export async function unpinTask(root: string): Promise<{ ok: true }> {
  const target = pinPath(root);
  const { rm } = await import('node:fs/promises');
  await rm(target, { force: true });
  return { ok: true };
}

/**
 * Toggles the workspace-level auto-resume switch. The hook only injects a resume
 * packet when this switch is on and a task pin exists; neither is inferred.
 */
export async function setAutoResume(
  root: string,
  enabled: boolean,
): Promise<{ ok: true } | TaskPinFailure> {
  const configPath = join(root, '.pappra', 'workspace.json');
  const read = await readTextFileBounded(configPath, 1024 * 1024);
  if (!read.ok) {
    return { ok: false, message: read.message };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(read.value.text);
  } catch (error) {
    return {
      ok: false,
      message: `workspace.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const parsed = workspaceConfigSchema.safeParse({
    ...(typeof raw === 'object' && raw !== null ? raw : {}),
    continuity: { autoResume: enabled },
  });
  if (!parsed.success) {
    return {
      ok: false,
      message: `workspace.json rejected the continuity switch: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    };
  }
  const backup = join(
    root,
    '.pappra',
    'local',
    'backups',
    `task-pin-${randomUUID()}`,
    'workspace.json',
  );
  await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
  await writeFile(backup, read.value.text, { mode: 0o600 });
  const temporary = `${configPath}.tmp-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(parsed.data, null, 2)}\n`);
  await rename(temporary, configPath);
  return { ok: true };
}

export async function readAutoResume(root: string): Promise<boolean> {
  const read = await readFile(join(root, '.pappra', 'workspace.json'), 'utf8');
  try {
    const raw: unknown = JSON.parse(read);
    if (typeof raw !== 'object' || raw === null || !('continuity' in raw)) {
      return false;
    }
    const continuity = raw.continuity;
    return (
      typeof continuity === 'object' &&
      continuity !== null &&
      'autoResume' in continuity &&
      continuity.autoResume === true
    );
  } catch {
    return false;
  }
}
