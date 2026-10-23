import fs from 'node:fs';
import path from 'node:path';
import {
  FixtureController,
  PiRpcController,
  driveRun,
  inspectPreparedHistory,
  prepareCollaboration,
  startPrepared,
  type CollaborationController,
} from '../../app/collaboration.js';
import type { CliOutput } from '../output.js';

/** One source of truth for the full collaboration command family in help output. */
export const collaborationCommandLine =
  'pappra collab <prepare|run|work-run|query|preflight|plan|bootstrap|rollover|transition|message|capabilities|state|resource|handoff|recovery|recovery-run|binding> [options]';

export const collaborationUsage =
  `${collaborationCommandLine}\n` +
  '  prepare --goal <file> --domain-root <dir> [--json]\n' +
  '  run --prepared <file> --capabilities <card> --controller <fixture|pi-rpc>\n' +
  '  work-run --request <abs work-execution.json> [--apply] [--json]\n' +
  '    Apply records bounded notification intents; plans write and notify nothing.\n' +
  '  query --prepared <file> [--json]\n' +
  '  preflight --assignment <file> --capabilities <card> [--max-age-minutes <n>] [--json]\n' +
  '  plan --task-root <dir> --config <plan.json> [--json]\n' +
  '  rollover <inspect|plan> --task-root <dir> --request <request.json> [--json]\n' +
  '  bootstrap <plan|apply> --task-root <abs> --request <abs request.json> [--json]\n' +
  '    Plan is read-only; apply launches only a visible Pi sibling or verified task-bound reuse.\n' +
  '    Unknown effects are reconciled, not retried; submission is not acceptance.\n' +
  '    Rollover remains read-only: no apply, native stop proof, route removal or session archive.\n' +
  '  transition <plan|apply> --task-root <abs> --request <abs request.json> [--json]\n' +
  '    Pre-transfer apply requires the opt-in Pi host; first-work and retirement resume from CLI.\n' +
  '    Unsupported native-quiescence proof blocks before successor launch or claim transfer.\n' +
  '    Applied ACK and REPORT pointers are required; retirement retains the original transcript.\n' +
  '  message <send|list|read|notify> --task-root <dir> [options]\n' +
  '  capabilities derive --harness <pi|codex|claude> --assignment <file> --template <file> --execution <file> [--session <file> | --events <file>] [--json]\n' +
  '  state <show|doctor|epoch-check> --task-root <dir> [options]\n' +
  '  resource <list|claim|release> --task-root <dir> [options]\n' +
  '  handoff <inventory|begin|stopped|rebind|transfer|confirm|complete|abort|release-dispatch> --task-root <dir> [options]\n' +
  '  recovery <inspect|reconcile|lock-break> --task-root <dir> [options]\n' +
  '  recovery-run --request <abs recovery-run.json> [--apply] [--json]\n' +
  '    Apply requires exact session/cwd/harness/pane and a task-local digest-pinned binding.\n' +
  '  binding <list|resolve|bind|unbind> [--root <dir>] [options]\n' +
  '  run reads pappra/collaboration-command/1 JSONL from stdin and writes\n' +
  '  pappra/collaboration-event/1 JSONL to stdout.';

export interface CollaborationCommandOptions {
  readonly cwd: string;
  readonly action: string | null;
  readonly json: boolean;
  readonly goalFile: string | null;
  readonly preparedFile: string | null;
  readonly capabilitiesFile: string | null;
  readonly controller: string | null;
  readonly domainRoot: string | null;
}

function failure(code: string, message: string): Record<string, unknown> {
  return { schema: 'pappra/collaboration-result/1', ok: false, code, message };
}

function readGoal(file: string): unknown {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 1024 * 1024) {
    throw new Error('goal file must be a regular file no larger than 1 MiB');
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
}

function controllerFor(name: string | null): CollaborationController | null {
  if (name === 'fixture') return new FixtureController();
  if (name === 'pi-rpc') return new PiRpcController();
  return null;
}

const MAX_COMMAND_LINE_BYTES = 256 * 1024;
const MAX_COMMAND_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_QUEUED_COMMANDS = 64;

function lines(stream: NodeJS.ReadableStream): AsyncIterable<string> {
  let buffer = '';
  const queue: string[] = [];
  let ended = false;
  let error: Error | null = null;
  let total = 0;
  let notify: (() => void) | null = null;
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    if (error !== null) return;
    total += Buffer.byteLength(chunk);
    if (total > MAX_COMMAND_TOTAL_BYTES) {
      error = new Error('run command input exceeded its aggregate bound');
      ended = true;
      notify?.();
      return;
    }
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_COMMAND_LINE_BYTES) {
      error = new Error('run command line exceeded its bound');
      ended = true;
      notify?.();
      return;
    }
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      queue.push(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (queue.length > MAX_QUEUED_COMMANDS) {
        error = new Error('run command queue exceeded its bound');
        ended = true;
        notify?.();
        return;
      }
    }
    notify?.();
  });
  stream.on('error', (streamError: Error) => {
    error = streamError;
    ended = true;
    notify?.();
  });
  stream.on('end', () => {
    if (buffer.length > 0) queue.push(buffer);
    ended = true;
    notify?.();
  });
  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (error !== null) throw error;
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = null;
      }
    },
  };
}

export async function runCollaborationCommand(
  options: CollaborationCommandOptions,
  output: CliOutput,
  input: NodeJS.ReadableStream = process.stdin,
): Promise<number> {
  if (options.action === 'prepare') {
    if (options.goalFile === null) {
      output.stderr('pappra: collab prepare requires --goal <file>\n');
      return 2;
    }
    if (options.domainRoot === null) {
      output.stdout(
        `${JSON.stringify(
          failure(
            'domain_root_required',
            'collab prepare requires --domain-root so shared-resource conflicts use one explicit domain',
          ),
        )}\n`,
      );
      return 2;
    }
    const domainRoot = options.domainRoot;
    let goal: unknown;
    try {
      goal = readGoal(options.goalFile);
    } catch (error) {
      output.stdout(
        `${JSON.stringify(failure('goal_unreadable', error instanceof Error ? error.message : String(error)))}\n`,
      );
      return 2;
    }
    const result = await prepareCollaboration(goal, {
      domainRoot: path.resolve(domainRoot),
    });
    if (!result.ok) {
      output.stdout(`${JSON.stringify(result)}\n`);
      return 1;
    }
    output.stdout(
      `${JSON.stringify({
        schema: 'pappra/collaboration-prepared/1',
        ok: true,
        status: 'prepared',
        prepared: result.value.prepared,
      })}\n`,
    );
    return 0;
  }
  if (options.action === 'query') {
    if (options.preparedFile === null) {
      output.stderr('pappra: collab query requires --prepared <file>\n');
      return 2;
    }
    const result = inspectPreparedHistory(path.resolve(options.preparedFile));
    output.stdout(`${JSON.stringify(result)}\n`);
    return result.ok ? 0 : 1;
  }
  if (options.action === 'run') {
    if (options.preparedFile === null || options.capabilitiesFile === null) {
      output.stderr(
        'pappra: collab run requires --prepared <file> and --capabilities <card>\n',
      );
      return 2;
    }
    const controller = controllerFor(options.controller);
    if (controller === null) {
      output.stderr(
        'pappra: collab run requires --controller <fixture|pi-rpc>\n',
      );
      return 2;
    }
    const started = await startPrepared(path.resolve(options.preparedFile), {
      capabilitiesFile: path.resolve(options.capabilitiesFile),
      controller,
      controllerId: controller.id,
    });
    if (!started.ok) {
      output.stdout(`${JSON.stringify(started)}\n`);
      return 1;
    }
    const commands = (async function* () {
      for await (const line of lines(input)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          yield JSON.parse(trimmed) as unknown;
        } catch {
          yield { schema: 'pappra/collaboration-command/1', action: 'invalid' };
        }
      }
    })();
    const result = await driveRun(started.value, commands, (event) => {
      output.stdout(`${JSON.stringify(event)}\n`);
    });
    if (!result.ok) {
      output.stderr(`pappra: ${result.code}: ${result.message}\n`);
      return 1;
    }
    return result.value.ok ? 0 : 1;
  }
  output.stderr('pappra: collab requires prepare, run, or query\n');
  return 2;
}
