import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

export const workspaceId = '87f86ed7-e827-48aa-94bf-72ee57ab4138';
export const checkoutId = '11111111-1111-4111-8111-111111111111';

export function makeTempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `pappra-${label}-`));
}

export function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

export function runGit(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    shell: false,
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (${String(result.status)}): ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

export function createRepository(
  root: string,
  options: { readonly commit?: boolean } = {},
): void {
  mkdirSync(root, { recursive: true });
  runGit(root, ['init', '-q', '-b', 'main']);
  writeFileSync(join(root, 'tracked.txt'), 'tracked\n');
  if (options.commit !== false) {
    runGit(root, ['add', 'tracked.txt']);
    runGit(root, [
      '-c',
      'user.email=fixture@example.com',
      '-c',
      'user.name=Fixture',
      'commit',
      '-q',
      '-m',
      'initial',
    ]);
  }
}

export function addLinkedWorktree(
  mainRepository: string,
  worktreePath: string,
  branch: string,
): void {
  runGit(mainRepository, ['worktree', 'add', '-q', '-b', branch, worktreePath]);
}

export function removeLinkedWorktree(
  mainRepository: string,
  worktreePath: string,
): void {
  if (!existsSync(worktreePath)) return;
  runGit(mainRepository, ['worktree', 'remove', '--force', worktreePath]);
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeText(path: string, value: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, value);
}

export function baseWorkspaceConfig(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: 'pappra/workspace/1',
    workspaceId,
    name: 'test-workspace',
    runtimeVersion: '0.1.0-dev.0',
    repositories: [],
    knowledge: {
      sources: [],
      newDocuments: '.pappra/knowledge',
      taskVisibility: 'private',
    },
    code: { graph: 'none', symbols: 'none', prepare: 'manual' },
    validation: [],
    excludes: [],
    extensions: {},
    ...overrides,
  };
}

export function writeWorkspaceConfig(
  root: string,
  value: Record<string, unknown>,
): string {
  const path = join(root, '.pappra', 'workspace.json');
  writeJson(path, value);
  return path;
}

export function baseMachineConfig(
  root: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: 'pappra/machine/1',
    workspaceRealpath: realpathSync(root),
    checkoutId,
    externalRepositories: [],
    selectedHosts: [],
    runtime: null,
    ...overrides,
  };
}

export function writeMachineConfig(
  root: string,
  value: Record<string, unknown>,
): string {
  const path = join(root, '.pappra', 'local', 'machine.json');
  writeJson(path, value);
  return path;
}

export function linkDirectory(target: string, linkPath: string): void {
  mkdirSync(join(linkPath, '..'), { recursive: true });
  symlinkSync(target, linkPath, 'dir');
}

export function realpath(path: string): string {
  return realpathSync(path);
}

function digestFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Captures bytes, symlink targets, and mtimes for every entry. Comparing the
 * map before and after discovery proves that no file or Git index was written.
 */
export function snapshotTree(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relativePath = relative(root, path).split(sep).join('/');
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) {
        snapshot.set(relativePath, 'symlink');
      } else if (stats.isDirectory()) {
        snapshot.set(relativePath, `dir:${stats.mtimeMs}`);
        visit(path);
      } else if (stats.isFile()) {
        snapshot.set(relativePath, `file:${digestFile(path)}:${stats.mtimeMs}`);
      } else {
        snapshot.set(relativePath, 'other');
      }
    }
  };
  visit(root);
  return snapshot;
}
