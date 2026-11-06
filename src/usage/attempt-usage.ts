import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { Attempt, TaskRecord } from '../schemas/collaboration-state.js';
import type {
  AttemptUsage,
  AttemptUsageProjection,
} from '../schemas/attempt-usage.js';
import { readBoundedFile } from '../infra/bounded-file.js';
import { record } from '../app/capability-evidence/shared.js';
import {
  claudeInvocationAttempt,
  codexRolloutAttempt,
  piSessionAttempt,
} from './native-attempt-evidence.js';

const MAX_ATTEMPTS = 16;
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAX_EXECUTION_BYTES = 64 * 1024;
const TERMINAL_REPORTS = new Set(['completed', 'failed', 'cancelled']);
const EVIDENCE_NAME = {
  codex: 'codex-rollout.jsonl',
  claude: 'claude-events.jsonl',
  pi: 'pi-session.jsonl',
} as const;
type EvidenceRead =
  | { readonly text: string; readonly digest: string }
  | {
      readonly reason: Extract<
        AttemptUsage,
        { state: 'unavailable' }
      >['reason'];
    };

function validAttemptKey(attempt: Attempt): boolean {
  return (
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(attempt.subtask_id) &&
    Number.isSafeInteger(attempt.attempt) &&
    attempt.attempt >= 1
  );
}

function taskEvidenceDir(taskRoot: string): string | null {
  if (!isAbsolute(taskRoot)) return null;
  try {
    const root = realpathSync(taskRoot);
    const dir = join(root, 'native-usage');
    if (!lstatSync(dir).isDirectory() || realpathSync(dir) !== dir) return null;
    return dir;
  } catch {
    return null;
  }
}

function isEvidenceRef(ref: unknown, dir: string, name: string): boolean {
  if (typeof ref !== 'string' || !isAbsolute(ref) || basename(ref) !== name)
    return false;
  try {
    // A platform alias such as /var can name the same parent. Only the
    // computed canonical task path is opened for content below.
    return realpathSync(dirname(ref)) === dir;
  } catch {
    return false;
  }
}

export function projectAttemptUsage(
  taskRoot: string,
  task: TaskRecord,
  attempts: readonly Attempt[],
): AttemptUsageProjection {
  let bytesLeft = MAX_EVIDENCE_BYTES;
  const evidenceDir = taskEvidenceDir(taskRoot);
  const attemptsToRead = attempts.slice(-MAX_ATTEMPTS).filter(validAttemptKey);
  const results = new Map<string, TaskRecord['results'][number]>();
  for (const result of task.results) {
    if (
      result.classification === 'applied' &&
      TERMINAL_REPORTS.has(result.status)
    ) {
      results.set(JSON.stringify([result.subtask_id, result.attempt]), result);
    }
  }

  function observe(attempt: Attempt): AttemptUsage {
    const unavailable = (
      reason: Extract<AttemptUsage, { state: 'unavailable' }>['reason'],
    ): AttemptUsage => ({ state: 'unavailable', reason });
    const harness = attempt.assignee.harness;
    if (harness !== 'codex' && harness !== 'claude' && harness !== 'pi')
      return unavailable('unsupported_harness');
    const key = JSON.stringify([attempt.subtask_id, attempt.attempt]);
    const result = results.get(key);
    if (result === undefined) return unavailable('evidence_not_registered');
    const sessionId = attempt.assignee.session_id;
    const started = Date.parse(attempt.created_at);
    const finished = Date.parse(result.recorded_at);
    if (
      !sessionId ||
      (attempt.native?.session_id != null &&
        attempt.native.session_id !== sessionId) ||
      !Number.isFinite(started) ||
      !Number.isFinite(finished) ||
      finished < started
    )
      return unavailable('attempt_boundary_unproven');
    const overlaps = task.attempts.some((other) => {
      if (
        (other.subtask_id === attempt.subtask_id &&
          other.attempt === attempt.attempt) ||
        other.assignee.harness !== harness ||
        (other.assignee.session_id !== sessionId &&
          other.native?.session_id !== sessionId)
      )
        return false;
      const otherStart = Date.parse(other.created_at);
      const otherEnd =
        other.closed_at === undefined ? Infinity : Date.parse(other.closed_at);
      return (
        !Number.isFinite(otherStart) ||
        Number.isNaN(otherEnd) ||
        (otherStart <= finished && otherEnd >= started)
      );
    });
    if (overlaps) return unavailable('attempt_boundary_unproven');
    const dir = evidenceDir;
    if (dir === null) return unavailable('evidence_not_registered');
    const prefix = `${attempt.subtask_id}-${attempt.attempt}.`;
    const outputs = result.outputs;
    if (outputs.length > 128) return unavailable('evidence_budget_exceeded');

    const read = (suffix: string, limit: number): EvidenceRead => {
      const name = prefix + suffix;
      const expected = join(dir, name);
      const pins = outputs.filter(
        (output) => record(output) && isEvidenceRef(output['ref'], dir, name),
      );
      const pin = pins[0];
      if (
        pins.length !== 1 ||
        !record(pin) ||
        typeof pin['digest'] !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/.test(pin['digest'])
      )
        return { reason: 'evidence_not_registered' };
      if (bytesLeft <= 0) return { reason: 'evidence_budget_exceeded' };
      if (taskEvidenceDir(taskRoot) !== evidenceDir)
        return { reason: 'evidence_unreadable_or_changed' };
      const contents = readBoundedFile(expected, Math.min(bytesLeft, limit));
      if (!contents.ok)
        return {
          reason:
            contents.code === 'too_large'
              ? 'evidence_budget_exceeded'
              : 'evidence_unreadable_or_changed',
        };
      bytesLeft -= contents.bytes.length;
      if (
        contents.digest !== pin['digest'] ||
        taskEvidenceDir(taskRoot) !== evidenceDir
      )
        return { reason: 'evidence_unreadable_or_changed' };
      return contents;
    };

    const evidence = read(EVIDENCE_NAME[harness], MAX_EVIDENCE_BYTES);
    if ('reason' in evidence) return unavailable(evidence.reason);
    const window = { sessionId, started, finished };
    const evidence_digests = [evidence.digest];
    let counts;
    if (harness === 'codex') {
      counts = codexRolloutAttempt(evidence.text, window);
    } else if (harness === 'pi') {
      counts = piSessionAttempt(evidence.text, window);
    } else {
      const execution = read('claude-execution.json', MAX_EXECUTION_BYTES);
      if ('reason' in execution) return unavailable(execution.reason);
      evidence_digests.push(execution.digest);
      let metadata: unknown;
      try {
        metadata = JSON.parse(execution.text);
      } catch {
        metadata = null;
      }
      // The execution capture must identify the exact registered event stream.
      const expectedEvents = prefix + EVIDENCE_NAME.claude;
      if (
        !record(metadata) ||
        !isEvidenceRef(metadata['events_file'], dir, expectedEvents)
      )
        return unavailable('native_usage_unproven');
      counts = claudeInvocationAttempt(evidence.text, metadata, window);
    }
    return counts === null
      ? unavailable('native_usage_unproven')
      : { state: 'available', harness, ...counts, evidence_digests };
  }

  return {
    attempts: attemptsToRead.map((attempt) => ({
      subtask_id: attempt.subtask_id,
      attempt: attempt.attempt,
      token_usage: observe(attempt),
    })),
    omitted: attempts.length - attemptsToRead.length,
    accounting: 'completed_native_work_input_includes_cache_reads',
  };
}
