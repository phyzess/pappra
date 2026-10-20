import { readlink } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { inspectGitRepository } from '../infra/git.js';
import { runGit } from '../infra/git.js';
import { observePath, readFileBounded, sha256Digest } from '../infra/fs.js';
import { diagnosticCodes } from '../schemas/errors.js';
import { failed, succeeded, type Outcome } from '../schemas/outcome.js';
import { isPathInside } from '../schemas/paths.js';
import {
  codeIdentitySchema,
  type CodeIdentity,
  type CodeWorkingTree,
} from '../schemas/code.js';

const MAX_WORKTREE_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;

const EXCLUDES = [
  ':(exclude).codegraph',
  ':(exclude).pappra/local',
  ':(exclude).pappra/generated',
];

export interface ComputeCodeIdentityInput {
  readonly repositoryId: string;
  readonly root: string;
  readonly engineVersion: string;
  readonly configDigest: string;
  readonly configStatus?: 'default' | 'observed' | 'unknown';
  readonly excludedRoots?: readonly string[];
  readonly signal?: AbortSignal;
}

interface WorkingTreeResult {
  readonly observation: CodeWorkingTree;
  readonly bytes: Buffer;
}

async function observeWorkingTree(
  root: string,
  excludedRoots: readonly string[],
  signal?: AbortSignal,
): Promise<WorkingTreeResult> {
  const reasons: string[] = [];
  let completeness: CodeWorkingTree['completeness'] = 'complete';
  const readDiff = async (args: readonly string[]) =>
    runGit({
      cwd: root,
      args,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: MAX_WORKTREE_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });

  const trackedExcludes = [...EXCLUDES];
  for (const excluded of excludedRoots) {
    const rel = relative(root, excluded);
    if (rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`)) {
      trackedExcludes.push(`:(exclude)${rel.split(sep).join('/')}`);
    }
  }

  const cached = await readDiff([
    'diff',
    '--binary',
    '--cached',
    '--',
    '.',
    ...trackedExcludes,
  ]);
  const unstaged = await readDiff([
    'diff',
    '--binary',
    '--',
    '.',
    ...trackedExcludes,
  ]);
  const cachedBytes = cached.ok
    ? Buffer.from(cached.value.stdout, 'utf8')
    : Buffer.alloc(0);
  const unstagedBytes = unstaged.ok
    ? Buffer.from(unstaged.value.stdout, 'utf8')
    : Buffer.alloc(0);
  if (!cached.ok) {
    completeness =
      cached.code === diagnosticCodes.gitOutputLimit ? 'partial' : 'unknown';
    reasons.push('tracked_staged_diff_unavailable');
  }
  if (!unstaged.ok) {
    completeness =
      unstaged.code === diagnosticCodes.gitOutputLimit ? 'partial' : 'unknown';
    reasons.push('tracked_unstaged_diff_unavailable');
  }
  const diffBytes = cachedBytes.length + unstagedBytes.length;
  if (diffBytes > MAX_WORKTREE_BYTES) {
    completeness = 'partial';
    reasons.push('tracked_diff_output_limit');
  }

  const untracked = await runGit({
    cwd: root,
    args: [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      '.',
      ...trackedExcludes,
    ],
    timeoutMs: GIT_TIMEOUT_MS,
    maxOutputBytes: 2 * 1024 * 1024,
    ...(signal === undefined ? {} : { signal }),
  });
  const parts: Buffer[] = [
    Buffer.from(
      `PAPPRA-CODE-WORKTREE/2\nD ${cachedBytes.length} ${unstagedBytes.length}\n`,
      'utf8',
    ),
    cachedBytes,
    unstagedBytes,
  ];
  let total = parts.reduce((sum, part) => sum + part.length, 0);
  let fileCount = 0;
  if (!untracked.ok) {
    completeness = 'partial';
    reasons.push('untracked_list_unavailable');
  } else {
    const paths = untracked.value.stdout
      .split('\0')
      .filter((path) => path.length > 0);
    for (const path of paths) {
      if (total > MAX_WORKTREE_BYTES) {
        completeness = 'partial';
        reasons.push('working_tree_output_limit');
        break;
      }
      const absolute = join(root, path);
      if (!isPathInside(root, absolute)) {
        completeness = 'partial';
        reasons.push(`untracked_path_unsafe:${path.slice(0, 200)}`);
        continue;
      }
      if (excludedRoots.some((excluded) => isPathInside(excluded, absolute))) {
        continue;
      }
      const observation = await observePath(absolute).catch(() => null);
      if (observation === null) {
        completeness = 'partial';
        reasons.push(`untracked_unreadable:${path.slice(0, 200)}`);
        continue;
      }
      let body: Buffer;
      let kind: 'F' | 'L';
      if (observation.kind === 'file') {
        const read = await readFileBounded(absolute, MAX_FILE_BYTES);
        if (!read.ok) {
          completeness = 'partial';
          reasons.push(`untracked_file_limit:${path.slice(0, 200)}`);
          continue;
        }
        body = read.value.bytes;
        kind = 'F';
      } else if (observation.kind === 'symlink') {
        const target = await readlink(absolute).catch(() => null);
        if (target === null) {
          completeness = 'partial';
          reasons.push(`untracked_symlink_unreadable:${path.slice(0, 200)}`);
          continue;
        }
        body = Buffer.from(target, 'utf8');
        kind = 'L';
      } else {
        completeness = 'partial';
        reasons.push(`untracked_not_regular:${path.slice(0, 200)}`);
        continue;
      }
      const pathBytes = Buffer.from(path, 'utf8');
      const header = Buffer.from(
        `${kind} ${pathBytes.length} ${body.length}\n`,
        'utf8',
      );
      if (
        total + header.length + pathBytes.length + body.length >
        MAX_WORKTREE_BYTES
      ) {
        completeness = 'partial';
        reasons.push('working_tree_output_limit');
        break;
      }
      parts.push(header, pathBytes, body);
      total += header.length + pathBytes.length + body.length;
      fileCount += 1;
    }
  }
  const bytes = Buffer.concat(parts);
  return {
    observation: {
      digest: sha256Digest(bytes),
      completeness,
      fileCount,
      byteCount: bytes.length,
      reasons: [...new Set(reasons)].slice(0, 16),
    },
    bytes,
  };
}

export async function computeCodeIdentity(
  input: ComputeCodeIdentityInput,
): Promise<Outcome<CodeIdentity>> {
  const observed = await inspectGitRepository(input.root, {
    timeoutMs: GIT_TIMEOUT_MS,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!observed.ok) return observed;
  const git = observed.value;
  const working = await observeWorkingTree(
    input.root,
    input.excludedRoots ?? [],
    input.signal,
  );
  const checkoutId = sha256Digest(
    JSON.stringify({
      root: git.root,
      gitDir: git.gitDir,
      commonDir: git.commonDir,
    }),
  );
  const parsed = codeIdentitySchema.safeParse({
    schema: 'pappra/code-identity/1',
    repositoryId: input.repositoryId,
    checkoutId,
    root: git.root,
    gitDir: git.gitDir,
    gitCommonDir: git.commonDir,
    head: git.head,
    branch: git.branch,
    workingTree: working.observation,
    engine: {
      id: 'codegraph',
      version: input.engineVersion,
      configDigest: input.configDigest,
      configStatus: input.configStatus ?? 'observed',
    },
  });
  if (!parsed.success) {
    return failed(
      diagnosticCodes.code_identity_changed,
      `Code identity is invalid: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`,
      {
        nextAction:
          'Inspect the selected repository and code engine configuration.',
      },
    );
  }
  return succeeded(parsed.data);
}

export function codeIdentityDigest(identity: CodeIdentity): string {
  return sha256Digest(JSON.stringify(identity));
}
