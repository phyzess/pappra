import { spawn, type ChildProcess } from 'node:child_process';
import type { Outcome } from '../schemas/outcome.js';
import { failed, succeeded } from '../schemas/outcome.js';
import { diagnosticCodes } from '../schemas/errors.js';

export interface CommandOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

export interface CommandResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly bytes: number;
  readonly durationMs: number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The process already exited.
    }
  }
}

/**
 * Executes one argv-delimited local command without a shell. Output and time
 * are bounded; a failure never becomes an empty successful result.
 */
export function runCommand(
  options: CommandOptions,
): Promise<Outcome<CommandResult>> {
  if (options.signal?.aborted === true) {
    return Promise.resolve(
      failed(diagnosticCodes.code_engine_failed, 'Command was cancelled.', {
        nextAction: 'Retry when cancellation is no longer requested.',
      }),
    );
  }
  const startedAt = performance.now();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;
  return new Promise<Outcome<CommandResult>>((resolveResult) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let outputExceeded = false;
    let bytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timer: NodeJS.Timeout | null = null;
    let child: ChildProcess | undefined;

    const settle = (result: Outcome<CommandResult>): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      resolveResult(result);
    };
    const abort = (): void => {
      aborted = true;
      killGroup(child?.pid);
    };

    try {
      child = spawn(options.command, [...options.args], {
        cwd: options.cwd,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NO_COLOR: '1',
          FORCE_COLOR: '0',
          CI: '1',
        },
      });
    } catch (error) {
      settle(
        failed(
          diagnosticCodes.code_engine_unavailable,
          `Cannot start ${options.command}: ${errorText(error)}`,
          {
            nextAction:
              'Install the selected code engine or use text fallback.',
          },
        ),
      );
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });

    const collect = (chunks: Buffer[], chunk: Buffer): void => {
      bytes += chunk.byteLength;
      if (bytes > maxOutputBytes) {
        outputExceeded = true;
        killGroup(child.pid);
        return;
      }
      chunks.push(chunk);
    };
    child.stdout?.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.on('error', (error) => {
      settle(
        failed(
          diagnosticCodes.code_engine_unavailable,
          `Cannot run ${options.command}: ${errorText(error)}`,
          {
            nextAction:
              'Install the selected code engine or use text fallback.',
          },
        ),
      );
    });
    child.on('close', (exitCode, signal) => {
      const durationMs = Math.round(performance.now() - startedAt);
      if (timedOut) {
        settle(
          failed(
            diagnosticCodes.code_engine_failed,
            `${options.command} timed out after ${timeoutMs}ms.`,
            {
              retryable: true,
              nextAction: 'Retry with a bounded smaller target.',
            },
          ),
        );
        return;
      }
      if (aborted) {
        settle(
          failed(diagnosticCodes.code_engine_failed, 'Command was cancelled.', {
            nextAction: 'Retry when cancellation is no longer requested.',
          }),
        );
        return;
      }
      if (outputExceeded) {
        settle(
          failed(
            diagnosticCodes.code_output_limit,
            `${options.command} exceeded the ${maxOutputBytes}-byte output limit.`,
            { nextAction: 'Narrow the query or selected repository scope.' },
          ),
        );
        return;
      }
      if (exitCode === null) {
        settle(
          failed(
            diagnosticCodes.code_engine_failed,
            `${options.command} ended without an exit code (signal ${signal ?? 'unknown'}).`,
            { retryable: true, nextAction: 'Inspect the engine and retry.' },
          ),
        );
        return;
      }
      settle(
        succeeded({
          command: options.command,
          args: [...options.args],
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode,
          bytes,
          durationMs,
        }),
      );
    });
  });
}
