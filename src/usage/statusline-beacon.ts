import { spawn } from 'node:child_process';
import {
  parseClaudeStatusline,
  writeUsageObservation,
  type UsageObservation,
} from './observation.js';

const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_CHAIN_OUTPUT_BYTES = 64 * 1024;
const CHAIN_TIMEOUT_MS = 4000;

export interface BeaconResult {
  /** Exactly what the status line should print. */
  readonly stdout: string;
  readonly exitCode: number;
  readonly observation: UsageObservation | null;
  /** Why no observation was recorded, for diagnostics only; never shown to the host. */
  readonly note: string | null;
}

export interface BeaconDependencies {
  readonly dataDir: string;
  readonly now?: () => Date;
  /** Runs the chained command with the original payload on stdin. */
  readonly runChain?: (
    command: string,
    stdin: string,
  ) => Promise<{ stdout: string; exitCode: number }>;
}

/**
 * The user's own status-line command, run unchanged with the original payload. It is the
 * command the user already configured, so this adds no new execution authority; the output
 * and exit code are passed through.
 */
export function runChainedCommand(
  command: string,
  stdin: string,
  timeoutMs: number = CHAIN_TIMEOUT_MS,
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    // A new process group lets the deadline stop the whole pipeline, not just `sh`: an orphaned
    // grandchild would otherwise keep the inherited stdout open and hold the host waiting.
    const child = spawn('/bin/sh', ['-c', command], {
      stdio: ['pipe', 'pipe', 'ignore'],
      detached: true,
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let exitCode: number | null = null;
    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Release the pipes so a leftover descendant cannot keep this process alive.
      child.stdout.destroy();
      child.stdin.destroy();
      resolve({
        stdout: Buffer.concat(chunks).toString('utf8'),
        exitCode: code,
      });
    };
    const timer = setTimeout(() => {
      // A command that already exited keeps its own status even if `close` lags behind.
      if (exitCode !== null) {
        finish(exitCode);
        return;
      }
      killGroup();
      finish(1);
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (bytes >= MAX_CHAIN_OUTPUT_BYTES) return;
      bytes += chunk.length;
      chunks.push(chunk);
    });
    child.on('error', () => finish(1));
    child.on('exit', (code) => {
      exitCode = code ?? 1;
    });
    child.on('close', (code) => finish(code ?? 1));
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin);
  });
}

/**
 * Status-line beacon: record the session's context usage, then print what the status line
 * would have printed anyway. It must never disturb the host: every failure to record is
 * swallowed, and with a chained command the host sees that command's own output.
 */
export async function runStatuslineBeacon(
  stdin: string,
  chain: string | null,
  dependencies: BeaconDependencies,
): Promise<BeaconResult> {
  const now = dependencies.now ?? (() => new Date());
  let observation: UsageObservation | null = null;
  let note: string | null = null;
  try {
    if (Buffer.byteLength(stdin) > MAX_STDIN_BYTES) note = 'payload_too_large';
    else {
      observation = parseClaudeStatusline(JSON.parse(stdin) as unknown, now());
      if (observation === null) note = 'no_usage_in_payload';
      else writeUsageObservation(dependencies.dataDir, observation);
    }
  } catch (error) {
    note = error instanceof SyntaxError ? 'payload_not_json' : 'write_failed';
  }
  if (chain === null) {
    return {
      stdout:
        observation === null ? '' : `ctx ${String(observation.used_percent)}%`,
      exitCode: 0,
      observation,
      note,
    };
  }
  const run = dependencies.runChain ?? runChainedCommand;
  try {
    const chained = await run(chain, stdin);
    return {
      stdout: chained.stdout,
      exitCode: chained.exitCode,
      observation,
      note,
    };
  } catch {
    return { stdout: '', exitCode: 1, observation, note: 'chain_failed' };
  }
}

/** Longest base64 chain the beacon will decode; the plan refuses anything larger. */
export const MAX_CHAIN_BASE64 = 16 * 1024;

/** The chained command travels base64-encoded so no shell quoting can alter it. */
export function decodeChain(value: string | undefined): string | null {
  if (value === undefined || value.length === 0) return null;
  if (value.length > MAX_CHAIN_BASE64 || !/^[A-Za-z0-9+/=]+$/.test(value))
    return null;
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  return decoded.length > 0 && !decoded.includes('\u0000') ? decoded : null;
}

export function encodeChain(command: string): string {
  return Buffer.from(command, 'utf8').toString('base64');
}
