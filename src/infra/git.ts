import { spawn, type ChildProcess } from 'node:child_process';
import { relative, resolve, sep } from 'node:path';
import type { EvidenceRef } from '../schemas/evidence.js';
import { diagnosticCodes } from '../schemas/errors.js';
import type { Outcome } from '../schemas/outcome.js';
import { errorMessage, failed, succeeded } from '../schemas/outcome.js';
import { samePath } from '../schemas/paths.js';
import { sha256Digest, resolveRealpath } from './fs.js';

export const DEFAULT_GIT_TIMEOUT_MS = 5_000;
export const DEFAULT_GIT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface RunGitOptions {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Exit codes that still produce an observable result. Defaults to [0]. */
  readonly acceptedExitCodes?: readonly number[];
  /** Bytes written to git stdin, for commands such as check-ignore --stdin. */
  readonly input?: string;
  readonly signal?: AbortSignal;
}

export interface GitCommandResult {
  readonly args: readonly string[];
  readonly stdout: string;
  readonly stdoutBytes: number;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
}

function sanitizedGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE',
    'GIT_PREFIX',
    'GIT_CEILING_DIRECTORIES',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_PARAMETERS',
  ]) {
    delete environment[key];
  }
  environment.GIT_OPTIONAL_LOCKS = '0';
  environment.GIT_TERMINAL_PROMPT = '0';
  environment.GIT_PAGER = 'cat';
  environment.LC_ALL = 'C';
  return environment;
}

/**
 * Runs one git command with an argv boundary, a timeout, and bounded output.
 * Discovery never fetches, checks out, or runs hooks here; every call is a
 * read-only query.
 */
export function runGit(
  options: RunGitOptions,
): Promise<Outcome<GitCommandResult>> {
  if (options.signal?.aborted === true) {
    return Promise.resolve(
      failed(diagnosticCodes.gitAborted, 'Git observation was cancelled.', {
        nextAction: 'Retry discovery when cancellation is no longer requested.',
      }),
    );
  }
  const cwd = resolve(options.cwd);
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_GIT_MAX_OUTPUT_BYTES;
  const acceptedExitCodes = options.acceptedExitCodes ?? [0];
  const startedAt = performance.now();

  return new Promise<Outcome<GitCommandResult>>((resolveResult) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let outputExceeded = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;
    let timer: NodeJS.Timeout | null = null;
    let child: ChildProcess;

    const settle = (result: Outcome<GitCommandResult>): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      resolveResult(result);
    };

    const abort = (): void => {
      aborted = true;
      child.kill('SIGKILL');
    };

    try {
      child = spawn('git', ['-c', 'core.fsmonitor=false', ...options.args], {
        cwd,
        shell: false,
        env: sanitizedGitEnvironment(),
        stdio: [
          options.input === undefined ? 'ignore' : 'pipe',
          'pipe',
          'pipe',
        ],
      });
    } catch (error) {
      settle(
        failed(
          diagnosticCodes.gitUnavailable,
          `Cannot start git: ${errorMessage(error)}`,
          { nextAction: 'Install git and ensure it is on PATH.' },
        ),
      );
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    options.signal?.addEventListener('abort', abort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        outputExceeded = true;
        child.kill('SIGKILL');
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        outputExceeded = true;
        child.kill('SIGKILL');
        return;
      }
      stderrChunks.push(chunk);
    });

    child.on('error', (error) => {
      settle(
        failed(
          diagnosticCodes.gitUnavailable,
          `Cannot run git ${options.args.join(' ')}: ${errorMessage(error)}`,
          { nextAction: 'Install git and ensure it is on PATH.' },
        ),
      );
    });

    child.on('close', (exitCode, signal) => {
      const durationMs = Math.round(performance.now() - startedAt);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (timedOut) {
        settle(
          failed(
            diagnosticCodes.gitTimeout,
            `git ${options.args[0] ?? ''} timed out after ${timeoutMs}ms in ${cwd}.`,
            {
              retryable: true,
              nextAction:
                'Retry with a healthy repository or a larger timeout.',
            },
          ),
        );
        return;
      }
      if (aborted) {
        settle(
          failed(diagnosticCodes.gitAborted, 'Git observation was cancelled.', {
            nextAction:
              'Retry discovery when cancellation is no longer requested.',
          }),
        );
        return;
      }
      if (outputExceeded) {
        settle(
          failed(
            diagnosticCodes.gitOutputLimit,
            `git ${options.args[0] ?? ''} exceeded the ${maxOutputBytes}-byte output limit in ${cwd}.`,
            {
              nextAction:
                'Narrow the repository scope; output was not truncated into a success.',
            },
          ),
        );
        return;
      }
      if (exitCode === null) {
        settle(
          failed(
            diagnosticCodes.gitCommandFailed,
            `git ${options.args[0] ?? ''} ended without an exit code (signal ${signal ?? 'unknown'}).`,
            {
              retryable: true,
              nextAction: 'Retry and inspect the repository state.',
            },
          ),
        );
        return;
      }
      if (!acceptedExitCodes.includes(exitCode)) {
        const detail = stderr.trim().split('\n')[0]?.slice(0, 500) ?? '';
        settle(
          failed(
            diagnosticCodes.gitCommandFailed,
            `git ${options.args.join(' ')} exited ${exitCode} in ${cwd}${detail === '' ? '' : `: ${detail}`}`,
            { nextAction: 'Inspect the repository and git installation.' },
          ),
        );
        return;
      }
      settle(
        succeeded({
          args: options.args,
          stdout,
          stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
          stderr,
          exitCode,
          durationMs,
        }),
      );
    });

    if (options.input !== undefined && child.stdin !== null) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(options.input);
    }
  });
}

export type GitRepositoryKind =
  'regular' | 'linked-worktree' | 'submodule' | 'bare';

export interface GitRepositoryObservation {
  readonly kind: GitRepositoryKind;
  readonly root: string;
  readonly gitDir: string;
  readonly commonDir: string;
  readonly superproject: string | null;
  readonly head: string | null;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly dirty: boolean | null;
  readonly limitations: readonly string[];
  readonly evidence: readonly EvidenceRef[];
}

export interface InspectGitRepositoryOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

function gitEvidence(ref: string, stdout: string): EvidenceRef {
  return {
    kind: 'git',
    ref,
    digest: sha256Digest(stdout),
    observedAt: new Date().toISOString(),
    scope: 'live-owned',
  };
}

function splitLines(value: string): readonly string[] {
  return value
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

/**
 * Observes a repository without modifying the index, refs, or working tree.
 * The caller supplies the expected checkout root; a subdirectory of a larger
 * repository is rejected instead of being silently classified as the root.
 */
export async function inspectGitRepository(
  candidateRoot: string,
  options: InspectGitRepositoryOptions = {},
): Promise<Outcome<GitRepositoryObservation>> {
  const root = (await resolveRealpath(candidateRoot)) ?? resolve(candidateRoot);
  const evidence: EvidenceRef[] = [];
  const limitations: string[] = [];
  const run = (args: readonly string[]) =>
    runGit({
      cwd: root,
      args,
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      ...(options.maxOutputBytes === undefined
        ? {}
        : { maxOutputBytes: options.maxOutputBytes }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  const optional = (args: readonly string[]) =>
    runGit({
      cwd: root,
      args,
      acceptedExitCodes: [0, 1],
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      ...(options.maxOutputBytes === undefined
        ? {}
        : { maxOutputBytes: options.maxOutputBytes }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

  const bareResult = await run(['rev-parse', '--is-bare-repository']);
  if (!bareResult.ok) return bareResult;
  evidence.push(
    gitEvidence('git:rev-parse --is-bare-repository', bareResult.value.stdout),
  );
  const isBare = bareResult.value.stdout.trim() === 'true';

  const identity = await run([
    'rev-parse',
    '--path-format=absolute',
    ...(isBare ? [] : ['--show-toplevel']),
    '--absolute-git-dir',
    '--git-common-dir',
  ]);
  if (!identity.ok) return identity;
  evidence.push(gitEvidence('git:rev-parse identity', identity.value.stdout));
  const lines = splitLines(identity.value.stdout);
  const expectedLines = isBare ? 2 : 3;
  if (lines.length < expectedLines) {
    return failed(
      diagnosticCodes.gitCommandFailed,
      `git returned an incomplete repository identity for ${root}.`,
      {
        nextAction:
          'Inspect the repository metadata; no configuration was changed.',
      },
    );
  }
  const observedRoot = isBare ? root : (lines[0] ?? '');
  const gitDir = lines[isBare ? 0 : 1] ?? '';
  const commonDir = lines[isBare ? 1 : 2] ?? '';
  if (!isBare) {
    const realRoot = root;
    if (!samePath(resolve(observedRoot), realRoot)) {
      return failed(
        diagnosticCodes.repositoryNotGit,
        `${root} is not a repository root; git resolves it to ${observedRoot}.`,
        {
          nextAction:
            'Declare the actual repository root, or discover it as part of a scan.',
        },
      );
    }
  }

  const superprojectResult = await run([
    'rev-parse',
    '--show-superproject-working-tree',
  ]);
  let superproject: string | null = null;
  if (superprojectResult.ok) {
    const value = superprojectResult.value.stdout.trim();
    superproject = value === '' ? null : value;
  } else {
    limitations.push('superproject state unavailable');
  }

  const headResult = await optional([
    'rev-parse',
    '--verify',
    '--quiet',
    'HEAD',
  ]);
  let head: string | null = null;
  if (headResult.ok) {
    const value = headResult.value.stdout.trim();
    head = value === '' ? null : value;
  } else {
    limitations.push('HEAD unavailable');
  }

  const branchResult = await optional([
    'symbolic-ref',
    '--short',
    '-q',
    'HEAD',
  ]);
  let branch: string | null = null;
  if (branchResult.ok) {
    const value = branchResult.value.stdout.trim();
    branch = value === '' ? null : value;
  } else {
    limitations.push('branch unavailable');
  }

  let dirty: boolean | null = null;
  const statusResult = await run([
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=normal',
  ]);
  if (statusResult.ok) {
    dirty = statusResult.value.stdout.length > 0;
  } else {
    limitations.push(`working tree state unavailable: ${statusResult.message}`);
  }

  const kind: GitRepositoryKind = isBare
    ? 'bare'
    : !samePath(gitDir, commonDir)
      ? 'linked-worktree'
      : superproject === null
        ? 'regular'
        : 'submodule';

  return succeeded({
    kind,
    root: isBare ? root : resolve(observedRoot),
    gitDir: resolve(gitDir),
    commonDir: resolve(commonDir),
    superproject,
    head,
    branch,
    detached: head !== null && branch === null,
    dirty,
    limitations,
    evidence,
  });
}

/**
 * Returns the absolute paths ignored by git for the supplied candidates.
 * `check-ignore` is read-only; a failure is reported rather than treated as
 * "nothing is ignored".
 */
export async function filterGitIgnored(
  repositoryRoot: string,
  candidates: readonly string[],
  options: InspectGitRepositoryOptions = {},
): Promise<Outcome<readonly string[]>> {
  if (candidates.length === 0) return succeeded([]);
  const root = resolve(repositoryRoot);
  const relativePaths: string[] = [];
  for (const candidate of candidates) {
    const path = relative(root, candidate);
    if (path === '' || path === '..' || path.startsWith(`..${sep}`)) continue;
    relativePaths.push(path.split('\\').join('/'));
  }
  if (relativePaths.length === 0) return succeeded([]);
  const input = `${relativePaths.join('\0')}\0`;
  const result = await runGit({
    cwd: root,
    args: ['check-ignore', '--stdin', '-z'],
    input,
    acceptedExitCodes: [0, 1],
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
    ...(options.maxOutputBytes === undefined
      ? {}
      : { maxOutputBytes: options.maxOutputBytes }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!result.ok) return result;
  const ignored: string[] = [];
  for (const item of result.value.stdout.split('\0')) {
    if (item === '') continue;
    ignored.push(resolve(root, ...item.split('/')));
  }
  return succeeded(ignored);
}
