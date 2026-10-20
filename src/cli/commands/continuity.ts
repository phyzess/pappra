import type { Diagnostic } from '../../schemas/diagnostics.js';
import { formatDiagnostic } from '../../schemas/diagnostics.js';
import {
  CheckpointService,
  type SaveCheckpointInput,
} from '../../continuity/index.js';
import type { CliOutput } from '../output.js';
import { resolveWorkspaceRoot } from '../../workspace/resolve.js';

export const checkpointUsage =
  'pappra checkpoint --task <id> [options]\n' +
  '  --objective <text> --acceptance <text> [--acceptance <text> ...]\n' +
  '  [--constraint <text> ...] [--decision <text> ...]\n' +
  '  [--attempted <text> ...] [--next-action <text> ...]\n' +
  '  [--limitation <text> ...] [--artifact <path> ...]\n' +
  '  [--collaboration-record <path>] [--context-completeness complete|partial]\n' +
  '  [--author-session <id>] [--native-harness pi|codex|claude|unknown]\n' +
  '  [--native-session <id>] [--json]';

export const resumeUsage =
  'pappra resume <taskId> [--session <native-session-id>] [--json]';

export interface CheckpointCommandOptions {
  readonly cwd: string;
  readonly json: boolean;
  readonly task: string | null;
  readonly objective: string | null;
  readonly acceptance: readonly string[];
  readonly constraints: readonly string[];
  readonly decisions: readonly string[];
  readonly attempted: readonly string[];
  readonly nextActions: readonly string[];
  readonly limitations: readonly string[];
  readonly artifacts: readonly string[];
  readonly collaborationRecordRef: string | null;
  readonly contextCompleteness: 'complete' | 'partial' | null;
  readonly authorSession: string | null;
  readonly nativeHarness: 'pi' | 'codex' | 'claude' | 'unknown' | null;
  readonly nativeSession: string | null;
}

export interface ResumeCommandOptions {
  readonly cwd: string;
  readonly json: boolean;
  readonly taskId: string;
  readonly currentSession: string | null;
}

function printDiagnostics(
  output: CliOutput,
  diagnostics: readonly Diagnostic[],
): void {
  for (const diagnostic of diagnostics) {
    output.stderr(`${formatDiagnostic(diagnostic)}\n`);
  }
}

async function serviceRoot(cwd: string): Promise<string> {
  const resolution = await resolveWorkspaceRoot({ startPath: cwd });
  return resolution.root ?? cwd;
}

export async function runCheckpointCommand(
  options: CheckpointCommandOptions,
  output: CliOutput,
): Promise<number> {
  if (options.task === null) {
    output.stderr('pappra: checkpoint requires --task\n');
    return 2;
  }
  const root = await serviceRoot(options.cwd);
  const service = new CheckpointService(root);
  const nativeSession = options.nativeSession ?? options.authorSession;
  const input: SaveCheckpointInput = {
    taskId: options.task,
    ...(options.objective === null ? {} : { objective: options.objective }),
    ...(options.acceptance.length === 0
      ? {}
      : { acceptance: options.acceptance }),
    constraints: options.constraints,
    decisions: options.decisions,
    attempted: options.attempted,
    nextActions: options.nextActions,
    limitations: options.limitations,
    artifacts: options.artifacts,
    ...(options.collaborationRecordRef === null
      ? {}
      : { collaborationRecordRef: options.collaborationRecordRef }),
    ...(options.contextCompleteness === null
      ? {}
      : { contextCompleteness: options.contextCompleteness }),
    authorSession: options.authorSession,
    ...(nativeSession === null
      ? {}
      : {
          nativeRefs: [
            {
              harness: options.nativeHarness ?? 'pi',
              sessionId: nativeSession,
              turnId: null,
              runId: null,
            },
          ],
        }),
  };
  const result = await service.save(input);
  if (options.json) {
    output.stdout(
      `${JSON.stringify({
        schema: 'pappra/checkpoint-result/1',
        ok: result.ok,
        status: result.status,
        checkpoint: result.checkpoint,
        checkpointPath: result.checkpointPath,
        latestPath: result.latestPath,
        diagnostics: result.diagnostics,
        residualPaths: result.residualPaths,
      })}\n`,
    );
  } else if (result.checkpoint !== null) {
    output.stdout(
      `checkpoint ${result.checkpoint.revision} saved: ${result.checkpointPath ?? 'unknown'}\n`,
    );
    printDiagnostics(output, result.diagnostics);
  } else {
    printDiagnostics(output, result.diagnostics);
  }
  return result.ok ? 0 : 1;
}

export async function runResumeCommand(
  options: ResumeCommandOptions,
  output: CliOutput,
): Promise<number> {
  const root = await serviceRoot(options.cwd);
  const service = new CheckpointService(root);
  const result = await service.resume({
    taskId: options.taskId,
    currentSession: options.currentSession,
  });
  if (options.json) {
    if (result.packet !== null) {
      output.stdout(`${JSON.stringify(result.packet)}\n`);
    } else {
      output.stdout(
        `${JSON.stringify({
          schema: 'pappra/resume-result/1',
          ok: false,
          status: result.status,
          diagnostics: result.diagnostics,
        })}\n`,
      );
    }
  } else if (result.packet !== null) {
    const packet = result.packet;
    output.stdout(`Task: ${packet.taskId}\n`);
    output.stdout(
      `Checkpoint: ${packet.checkpoint.ref}@${packet.checkpoint.revision}\n`,
    );
    output.stdout(
      `Execution allowed: ${packet.executionAllowed ? 'yes' : 'no'}\n`,
    );
    output.stdout(`Context: ${packet.contextCompleteness}\n`);
    output.stdout(`Code drift: ${packet.codeDrift.status}\n`);
    output.stdout(`Verification: ${packet.verificationStatus}\n`);
    output.stdout(`Objective: ${packet.boundedContext.objective}\n`);
    for (const reason of packet.blockingReasons) {
      output.stdout(`Blocked: ${reason.code}: ${reason.message}\n`);
    }
    for (const action of packet.boundedContext.nextActions) {
      output.stdout(`Next: ${action}\n`);
    }
    for (const observation of packet.executionObservations) {
      output.stdout(
        `Observation: ${observation.harness}/${observation.sessionId ?? 'unknown'} stored-snapshot live=${observation.liveStatus}\n`,
      );
    }
    printDiagnostics(output, result.diagnostics);
  } else {
    printDiagnostics(output, result.diagnostics);
  }
  return result.ok &&
    result.packet !== null &&
    result.packet.executionAllowed &&
    result.packet.verificationStatus === 'current'
    ? 0
    : 1;
}
