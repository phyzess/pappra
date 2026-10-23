import path from 'node:path';
import type { Assignment, CapabilityCard } from '../../collab/contracts.js';
import { nowIso } from '../../collab/store.js';
import {
  argumentStrings,
  assertTemplateIdentity,
  deriveOutcome,
  evidenceRecords,
  fail,
  fingerprintTemplateSkill,
  isTimestamp,
  MAX_EVENTS,
  parseExecution,
  piTimestamp,
  readNativeEvidence,
  record,
  samePath,
  type CapabilityDerivation,
} from './shared.js';

/**
 * Derive a runtime capability card from a saved native Pi session.
 *
 * Observed Pi 1.2/1.3 session shape: a JSONL file whose first record is
 *   { type: "session", id, cwd, timestamp, version }
 * followed by { type: "message", id, parentId, timestamp,
 *   message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments }] } }
 * and { type: "message", ..., message: { role: "toolResult", toolCallId, toolName, isError, ... } }.
 *
 * Only positively observed facts become `verified`. A tool is `verified` when a
 * call was correlated with a successful result; a skill is `verified` when the
 * session read its SKILL.md through a successful tool call, which is how Pi loads
 * a skill. Everything else stays `unknown`.
 */

interface PiCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly at: unknown;
}

interface PiResult {
  readonly isError: boolean;
  readonly at: unknown;
  readonly toolName: unknown;
}

interface PiTurn {
  readonly model: unknown;
  readonly provider: unknown;
  readonly stop_reason: unknown;
  readonly usage: unknown;
  readonly timestamp: unknown;
}

export interface PiNativeExecution {
  readonly records: Record<string, unknown>[];
  readonly execution: Record<string, unknown>;
  readonly session: Record<string, unknown>;
  readonly calls: Map<string, PiCall>;
  readonly results: Map<string, PiResult>;
  readonly assistantTurns: PiTurn[];
  readonly lastTurn: PiTurn;
  readonly evidenceRecords: { ref: string; digest: string }[];
}

export interface PiEvidenceOptions {
  readonly sessionFile: string;
  readonly executionFile: string;
  readonly sessionId: string;
  readonly cwd: string;
}

/**
 * The observation time is the native session's own last usable timestamp. A
 * message-level value that is missing or unusable falls back to that record's
 * own timestamp; the adapter never substitutes its own clock, so replaying old
 * evidence cannot make it look fresh.
 */
function nativeObservationTime(
  records: readonly Record<string, unknown>[],
): string {
  const stamps: number[] = [];
  for (const row of records) {
    const message = record(row.message) ? row.message : null;
    const candidates =
      row.type === 'message'
        ? [message?.timestamp, row.timestamp]
        : [row.timestamp];
    let millis: number | null = null;
    for (const candidate of candidates) {
      millis = piTimestamp(candidate);
      if (millis !== null) break;
    }
    if (millis !== null) stamps.push(millis);
  }
  if (!stamps.length) fail('no_native_observation_time');
  return nowIso(stamps[stamps.length - 1]!);
}

export function readPiExecution(options: PiEvidenceOptions): PiNativeExecution {
  const sessionBytes = readNativeEvidence(options.sessionFile);
  const executionBytes = readNativeEvidence(options.executionFile);
  let records: Record<string, unknown>[];
  let execution: Record<string, unknown>;
  try {
    const lines = sessionBytes.text
      .split('\n')
      .filter((line) => line.trim().length);
    if (lines.length > MAX_EVENTS) fail('event_limit');
    records = lines.map((line) => {
      const value = JSON.parse(line) as unknown;
      if (!record(value)) fail('unsupported_event_shape');
      return value;
    });
    execution = parseExecution(executionBytes.text);
  } catch {
    fail('invalid_native_json');
  }
  if (execution.status !== 'exited' || execution.exit_code !== 0)
    fail('native_process_not_successfully_exited');
  if (
    !isTimestamp(execution.started_at) ||
    !isTimestamp(execution.finished_at) ||
    Date.parse(execution.finished_at as string) <
      Date.parse(execution.started_at as string)
  )
    fail('invalid_execution_clock');
  if (
    execution.native_evidence &&
    !samePath(execution.native_evidence, options.sessionFile)
  )
    fail('execution_evidence_mismatch');
  if (records.some((row) => !record(row) || typeof row.type !== 'string'))
    fail('unsupported_event_shape');
  const sessions = records.filter((row) => row.type === 'session');
  if (sessions.length !== 1 || records[0] !== sessions[0])
    fail('ambiguous_native_lifecycle');
  const session = sessions[0]!;
  if (session.id !== options.sessionId) fail('native_identity_mismatch');
  if (typeof session.cwd !== 'string' || !samePath(session.cwd, options.cwd))
    fail('native_cwd_mismatch');
  const calls = new Map<string, PiCall>();
  const results = new Map<string, PiResult>();
  const assistantTurns: PiTurn[] = [];
  for (const row of records) {
    if (row.type !== 'message') continue;
    const message = record(row.message)
      ? row.message
      : fail('unsupported_message_shape');
    if (typeof message.role !== 'string') fail('unsupported_message_shape');
    const content = message.content;
    if (!Array.isArray(content)) {
      // Only the system prompt record carries plain text in the observed shape.
      if (message.role !== 'system' || typeof content !== 'string')
        fail('unsupported_message_shape');
      continue;
    }
    if (message.role === 'assistant') {
      assistantTurns.push({
        model: message.model ?? null,
        provider: message.provider ?? null,
        stop_reason: message.stopReason ?? null,
        usage: message.usage ?? null,
        timestamp: message.timestamp ?? row.timestamp ?? null,
      });
    }
    for (const part of content) {
      if (!record(part)) continue;
      if (part.type === 'toolCall') {
        if (
          message.role !== 'assistant' ||
          typeof part.id !== 'string' ||
          typeof part.name !== 'string' ||
          calls.has(part.id)
        )
          fail('unsupported_tool_call');
        calls.set(part.id, {
          id: part.id,
          name: part.name,
          arguments: part.arguments ?? {},
          at: row.timestamp,
        });
      }
    }
    if (message.role === 'toolResult') {
      if (
        typeof message.toolCallId !== 'string' ||
        !calls.has(message.toolCallId) ||
        results.has(message.toolCallId) ||
        typeof message.isError !== 'boolean'
      )
        fail('unsupported_tool_result');
      results.set(message.toolCallId, {
        isError: message.isError,
        at: message.timestamp ?? row.timestamp,
        toolName: message.toolName,
      });
    }
  }
  if ([...calls.keys()].some((id) => !results.has(id)))
    fail('incomplete_tool_results');
  if (!assistantTurns.length) fail('no_assistant_turn');
  const lastTurn = assistantTurns[assistantTurns.length - 1]!;
  // A turn that ended while a tool call was still outstanding is an
  // indeterminate lifecycle, not a completed observation.
  if (lastTurn.stop_reason === 'toolUse') fail('indeterminate_turn_end');
  return {
    records,
    execution,
    session,
    calls,
    results,
    assistantTurns,
    lastTurn,
    evidenceRecords: evidenceRecords(
      sessionBytes,
      options.sessionFile,
      executionBytes,
      options.executionFile,
    ),
  };
}

export function derivePiCard(options: {
  readonly assignment: Assignment;
  readonly template: CapabilityCard;
  readonly sessionFile: string;
  readonly executionFile: string;
}): CapabilityDerivation {
  return deriveOutcome(options.assignment, options.template, () => {
    assertTemplateIdentity(options.assignment, options.template, 'pi');
    const native = readPiExecution({
      sessionFile: options.sessionFile,
      executionFile: options.executionFile,
      sessionId: options.template.session_id,
      cwd: options.template.cwd,
    });
    const successful = (name: string) =>
      [...native.calls.values()].some(
        (call) =>
          call.name === name && native.results.get(call.id)?.isError === false,
      );
    // Pi loads a skill by reading its SKILL.md. Only an actual successful `read`
    // of that entry counts: a path in a write argument or shell string does not.
    const loadedSkillEntry = (file: string, cwd: string) =>
      [...native.calls.values()].some((call) => {
        if (call.name !== 'read') return false;
        if (native.results.get(call.id)?.isError !== false) return false;
        return argumentStrings(call.arguments).some((candidate) => {
          if (candidate === file) return true;
          const resolved = path.isAbsolute(candidate)
            ? candidate
            : path.resolve(cwd, candidate);
          return samePath(resolved, file);
        });
      });
    const card = structuredClone(options.template);
    card.evidence_level = 'runtime';
    card.observed_at = nativeObservationTime(native.records);
    card.evidence_records = native.evidenceRecords;
    card.native_observation = {
      source: 'pi-session-jsonl',
      launcher_clock: {
        started_at: native.execution.started_at,
        finished_at: native.execution.finished_at,
      },
      session_id: native.session.id,
      cwd: native.session.cwd,
      pi_version: native.session.version ?? null,
      phase: native.execution.phase ?? null,
      tool_allowlist: native.execution.tool_allowlist ?? null,
      tools_observed: [
        ...new Set([...native.calls.values()].map((call) => call.name)),
      ].sort(),
      project_trust: native.execution.project_trust ?? null,
      model: native.lastTurn.model,
      provider: native.lastTurn.provider,
      stop_reason: native.lastTurn.stop_reason,
      usage: native.lastTurn.usage,
      assistant_turns: native.assistantTurns.length,
      // Cost is not reported by the Pi session record; it is accounted for separately.
      cost: { reported_usd: null, source: 'not_reported_by_pi_session_record' },
    };
    card.tools = card.tools.map((tool) => {
      const verified = successful(tool.id);
      const next = { ...tool, state: verified ? 'verified' : 'unknown' };
      if (verified) next.evidence_ref = options.sessionFile;
      return next;
    });
    card.skills = card.skills.map((skill) => {
      const snapshot = fingerprintTemplateSkill(skill);
      const loaded = loadedSkillEntry(snapshot.entry, options.template.cwd);
      const next = {
        ...skill,
        state: loaded ? 'verified' : 'unknown',
      };
      if (loaded) next.evidence_ref = options.sessionFile;
      return next;
    });
    return { card };
  });
}
