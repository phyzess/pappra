import {
  isTimestamp,
  MAX_EVENTS,
  record,
} from '../app/capability-evidence/shared.js';
import {
  claudeAttemptCounters,
  codexAttemptCounters,
  piAttemptCounters,
  type AttemptTokenCounters,
} from './attempt-counters.js';

export interface NativeAttemptWindow {
  readonly sessionId: string;
  readonly started: number;
  readonly finished: number;
}

function jsonRows(text: string): Record<string, unknown>[] | null {
  try {
    const lines = text.trim().split('\n');
    if (lines.length > MAX_EVENTS) return null;
    const rows: unknown[] = lines.map((line) => JSON.parse(line) as unknown);
    return rows.every(record) ? rows : null;
  } catch {
    return null;
  }
}

function millis(value: unknown): number {
  return isTimestamp(value) ? Date.parse(value as string) : NaN;
}

function inside(at: number, window: NativeAttemptWindow): boolean {
  return at >= window.started && at <= window.finished;
}

/** A rollout can contain work before and after this attempt in the same thread. */
export function codexRolloutAttempt(
  text: string,
  window: NativeAttemptWindow,
): AttemptTokenCounters | null {
  const rows = jsonRows(text);
  const header = rows?.[0];
  if (
    rows === null ||
    header?.['type'] !== 'session_meta' ||
    !record(header['payload']) ||
    header['payload']['id'] !== window.sessionId ||
    !Number.isFinite(millis(header['timestamp']))
  )
    return null;

  const fresh =
    inside(millis(header['timestamp']), window) &&
    header['payload']['parent_thread_id'] == null &&
    header['payload']['forked_from_id'] == null &&
    header['payload']['history_base'] == null &&
    !rows.some((row) => row['type'] === 'history_base');
  let prior: unknown = fresh
    ? {
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        cache_write_input_tokens: 0,
      }
    : null;
  let before: unknown = null;
  let after: unknown = null;
  let turn: { id: string; started: number; usage: unknown } | null = null;
  let lastAt = millis(header['timestamp']);
  for (const row of rows.slice(1)) {
    if (row['type'] === 'session_meta') return null;
    if (row['type'] !== 'event_msg' || !record(row['payload'])) continue;
    const event = row['payload'];
    const at = millis(row['timestamp']);
    if (!Number.isFinite(at) || at < lastAt) return null;
    if (at > window.finished) break;
    lastAt = at;
    switch (event['type']) {
      case 'task_started':
        if (turn !== null || typeof event['turn_id'] !== 'string') return null;
        turn = { id: event['turn_id'], started: at, usage: null };
        break;
      case 'token_count':
        if (
          turn !== null &&
          record(event['info']) &&
          record(event['info']['total_token_usage'])
        )
          turn.usage = event['info']['total_token_usage'];
        break;
      case 'task_complete': {
        if (turn === null || turn.id !== event['turn_id']) return null;
        if (inside(at, window)) {
          if (
            !inside(turn.started, window) ||
            turn.usage === null ||
            prior === null ||
            codexAttemptCounters(turn.usage, prior) === null
          )
            return null;
          before ??= prior;
          after = turn.usage;
        }
        prior = turn.usage;
        turn = null;
        break;
      }
      case 'turn_aborted':
        if (inside(at, window)) return null;
        // Counters from aborted work cannot be used as a complete baseline.
        prior = null;
        turn = null;
        break;
    }
  }
  // An in-flight tail cannot change the last completed cumulative snapshot.
  return after === null ? null : codexAttemptCounters(after, before);
}

/** The execution envelope bounds one captured Claude invocation. */
export function claudeInvocationAttempt(
  text: string,
  execution: Record<string, unknown>,
  window: NativeAttemptWindow,
): AttemptTokenCounters | null {
  const rows = jsonRows(text);
  const init = rows?.[0];
  const result = rows?.at(-1);
  const started = millis(execution['started_at']);
  const finished = millis(execution['finished_at']);
  if (
    execution['status'] !== 'exited' ||
    execution['exit_code'] !== 0 ||
    !inside(started, window) ||
    !inside(finished, window) ||
    finished < started ||
    init?.['type'] !== 'system' ||
    init['subtype'] !== 'init' ||
    init['session_id'] !== window.sessionId ||
    result?.['type'] !== 'result' ||
    result['subtype'] !== 'success' ||
    result['is_error'] !== false ||
    result['session_id'] !== window.sessionId ||
    rows?.filter((row) => row['type'] === 'system' && row['subtype'] === 'init')
      .length !== 1 ||
    rows?.filter((row) => row['type'] === 'result').length !== 1
  )
    return null;
  return claudeAttemptCounters(result['usage']);
}

/** Pi records usage per persisted response and separately for some operations. */
export function piSessionAttempt(
  text: string,
  window: NativeAttemptWindow,
): AttemptTokenCounters | null {
  const rows = jsonRows(text);
  const session = rows?.[0];
  if (
    rows === null ||
    session?.['type'] !== 'session' ||
    session['id'] !== window.sessionId
  )
    return null;
  const attributed: unknown[] = [];
  const seen = new Set<string>();
  let tip: string | null = null;
  let lastAt = -Infinity;
  let openTurn = false;
  let completedRows = 0;
  let tools: { pending: Set<string> | null; received: boolean } | null = null;
  for (const row of rows.slice(1)) {
    if (row['type'] === 'session') return null;
    const message = record(row['message']) ? row['message'] : null;
    const user = row['type'] === 'message' && message?.['role'] === 'user';
    const assistant =
      row['type'] === 'message' && message?.['role'] === 'assistant';
    const toolResult =
      row['type'] === 'message' && message?.['role'] === 'toolResult';
    const usage =
      row['type'] === 'usage' ||
      ((row['type'] === 'compaction' || row['type'] === 'branch_summary') &&
        row['usage'] !== undefined);
    if (tip === null && !user && !assistant && !toolResult && !usage) continue;
    const at = millis(row['timestamp']);
    if (!Number.isFinite(at) || at < lastAt) return null;
    lastAt = at;
    if (!inside(at, window)) continue;
    const id = row['id'];
    if (
      typeof id !== 'string' ||
      seen.has(id) ||
      (tip === null ? !user : row['parentId'] !== tip)
    )
      return null;
    seen.add(id);
    tip = id;
    if (user) {
      if (openTurn) return null;
      openTurn = true;
    }
    if (assistant) {
      const stop = message['stopReason'];
      if (!openTurn || (stop !== 'stop' && stop !== 'toolUse')) return null;
      if (tools !== null && (!tools.received || (tools.pending?.size ?? 0) > 0))
        return null;
      attributed.push(message['usage']);
      if (stop === 'stop') {
        openTurn = false;
        completedRows = attributed.length;
        tools = null;
      } else {
        const content = message['content'];
        const pending = Array.isArray(content) ? new Set<string>() : null;
        if (pending !== null && Array.isArray(content)) {
          for (const part of content) {
            if (!record(part) || part['type'] !== 'toolCall') continue;
            const callId = part['id'];
            if (typeof callId !== 'string' || pending.has(callId)) return null;
            pending.add(callId);
          }
          if (pending.size === 0) return null;
        }
        tools = { pending, received: false };
      }
    } else if (toolResult) {
      if (tools === null) return null;
      const callId = message['toolCallId'];
      if (
        tools.pending !== null &&
        (typeof callId !== 'string' || !tools.pending.delete(callId))
      )
        return null;
      tools.received = true;
    } else if (usage) {
      attributed.push(row['usage']);
      if (!openTurn && completedRows > 0) completedRows = attributed.length;
    }
  }
  return piAttemptCounters(attributed.slice(0, completedRows));
}
