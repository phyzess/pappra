import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { initTask } from '../../src/collab/store.js';
import type { Identity } from '../../src/collab/types.js';
import { cleanup, makeTempDir } from '../workspace/fixtures.js';
import { owner } from './scenarios.js';

export interface TaskDomainFixture {
  readonly root: string;
  readonly domainRoot: string;
  readonly tasks: Readonly<Record<string, string>>;
  readonly outside: string;
  cleanup(): void;
}

export const CLAIMANT: Identity = {
  agent_id: 'claimant',
  session_id: 'claimant-session',
  harness: 'pi',
};

export const OTHER: Identity = {
  agent_id: 'other',
  session_id: 'other-session',
  harness: 'codex',
};

export function makeTaskDomain(
  label: string,
  taskIds: readonly string[],
  options: {
    readonly initialize?: readonly string[];
    readonly coordinators?: Readonly<Record<string, Identity>>;
  } = {},
): TaskDomainFixture {
  const root = realpathSync(makeTempDir(label));
  const domainRoot = join(root, 'domain');
  mkdirSync(domainRoot, { recursive: true });
  const outside = join(root, 'outside');
  mkdirSync(outside, { recursive: true });
  const tasks: Record<string, string> = {};
  const initialize = options.initialize ?? taskIds;
  for (const taskId of taskIds) {
    const taskRoot = join(domainRoot, 'tasks', taskId);
    tasks[taskId] = taskRoot;
    if (initialize.includes(taskId))
      initTask(taskRoot, {
        taskId,
        domainRoot,
        coordinator: { ...owner, ...options.coordinators?.[taskId] },
      });
  }
  return {
    root,
    domainRoot,
    tasks,
    outside,
    cleanup: () => cleanup(root),
  };
}

export function claimRequest(
  holder: Identity,
  resources: readonly Record<string, unknown>[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: 'pappra/collaboration-resource-request/1',
    action: 'claim',
    holder,
    resources,
    access: 'write',
    ...extra,
  };
}

export function releaseRequest(
  holder: Identity,
  claimId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: 'pappra/collaboration-resource-request/1',
    action: 'release',
    holder,
    claim_id: claimId,
    ...extra,
  };
}

export function writeRequest(
  root: string,
  name: string,
  value: unknown,
): string {
  const file = join(root, name);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function digestFile(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Snapshot every file under the fixture for no-write assertions. */
export function snapshotTree(root: string): string[] {
  const rows: string[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) {
        rows.push(`${file}:symlink:${readlinkSync(file)}`);
      } else if (stat.isDirectory()) {
        visit(file);
      } else if (stat.isFile()) {
        rows.push(`${file}:${String(stat.mtimeMs)}:${digestFile(file)}`);
      } else {
        rows.push(`${file}:special`);
      }
    }
  };
  visit(root);
  return rows;
}
