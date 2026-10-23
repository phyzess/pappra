import type { Assignment, CapabilityCard } from '../../collab/contracts.js';
import {
  assertTemplateIdentity,
  deriveOutcome,
  evidenceRecords,
  fail,
  fingerprintTemplateSkill,
  isTimestamp,
  MAX_EVENTS,
  parseExecution,
  payloadStrings,
  readNativeEvidence,
  record,
  samePath,
  type CapabilityDerivation,
} from './shared.js';

/**
 * Derive a runtime capability card from a saved `codex exec --json` run.
 *
 * Observed Codex CLI 0.162.1 event shape:
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"..."}}
 *   {"type":"turn.completed","usage":{...}}
 *
 * Limits this parser states rather than hides:
 *   * Only the shapes above are understood. An unknown row type, an unknown item
 *     type or a bare `turn.failed` fails closed instead of being guessed into a
 *     success.
 *   * The exec stream does not report skill invocation in this version, so a skill
 *     can never be promoted to `verified` here; it stays `unknown` and a required
 *     skill fails closed.
 *   * Tool ids are the receiving runtime's own reported item types, mapped
 *     explicitly by ITEM_TOOL_MAP below; no aliasing by display name.
 */

const TERMINAL_ROWS = new Set(['turn.completed']);
const FAILURE_ROWS = new Set(['turn.failed', 'error']);
const NON_TOOL_ITEMS = new Set(['agent_message', 'reasoning', 'message']);
const ITEM_TOOL_MAP: Record<string, string> = {
  command_execution: 'shell',
  file_change: 'apply_patch',
  mcp_tool_call: 'mcp',
  web_search: 'web_search',
};

interface CodexToolCall {
  readonly id: unknown;
  readonly tool: string;
  readonly item_type: string;
  readonly succeeded: boolean;
  readonly payload: string[];
}

export interface CodexNativeExecution {
  readonly rows: Record<string, unknown>[];
  readonly execution: Record<string, unknown>;
  readonly items: Record<string, unknown>[];
  readonly toolCalls: CodexToolCall[];
  readonly unknownItemTypes: string[];
  readonly usage: unknown;
  readonly evidenceRecords: { ref: string; digest: string }[];
}

export interface CodexEvidenceOptions {
  readonly eventsFile: string;
  readonly executionFile: string;
  readonly sessionId: string;
  readonly cwd: string;
}

/** True when the item reports success: no explicit failure signal and a non-failed status. */
function itemSucceeded(item: Record<string, unknown>): boolean {
  if (typeof item.status === 'string' && item.status !== 'completed')
    return false;
  if (
    item.exit_code !== undefined &&
    item.exit_code !== null &&
    item.exit_code !== 0
  )
    return false;
  return true;
}

export function readCodexExecution(
  options: CodexEvidenceOptions,
): CodexNativeExecution {
  const eventsBytes = readNativeEvidence(options.eventsFile);
  const executionBytes = readNativeEvidence(options.executionFile);
  let rows: Record<string, unknown>[];
  let execution: Record<string, unknown>;
  try {
    const lines = eventsBytes.text
      .split('\n')
      .filter((line) => line.trim().length);
    if (lines.length > MAX_EVENTS) fail('event_limit');
    rows = lines.map((line) => {
      const value = JSON.parse(line) as unknown;
      if (!record(value)) fail('unsupported_event_shape');
      return value;
    });
    execution = parseExecution(executionBytes.text);
  } catch {
    return fail('invalid_native_json');
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
    execution.events_file &&
    !samePath(execution.events_file, options.eventsFile)
  )
    fail('execution_evidence_mismatch');
  if (execution.cwd && !samePath(execution.cwd, options.cwd))
    fail('native_cwd_mismatch');
  if (rows.some((row) => typeof row.type !== 'string'))
    fail('unsupported_event_shape');
  const started = rows.filter((row) => row.type === 'thread.started');
  if (started.length !== 1 || rows[0] !== started[0])
    fail('ambiguous_native_lifecycle');
  const terminal = rows.filter(
    (row) =>
      TERMINAL_ROWS.has(row.type as string) ||
      FAILURE_ROWS.has(row.type as string),
  );
  if (terminal.length !== 1 || rows[rows.length - 1] !== terminal[0])
    fail('ambiguous_native_lifecycle');
  const terminalItem = terminal[0]!;
  if (
    FAILURE_ROWS.has(terminalItem.type as string) ||
    terminalItem.success === false
  )
    fail('native_result_failed');
  if (started[0]!.thread_id !== options.sessionId)
    fail('native_identity_mismatch');
  const known = new Set([
    'thread.started',
    'turn.started',
    'item.started',
    'item.updated',
    'item.completed',
    ...TERMINAL_ROWS,
  ]);
  const unknownRows = [
    ...new Set(
      rows.map((row) => String(row.type)).filter((type) => !known.has(type)),
    ),
  ];
  if (unknownRows.length)
    fail(`unsupported_row_types:${unknownRows.join(',')}`);
  const items: Record<string, unknown>[] = [];
  const unknownItemTypes = new Set<string>();
  for (const row of rows) {
    if (row.type !== 'item.completed' && row.type !== 'item.started') continue;
    const item = row.item;
    if (!record(item) || typeof item.type !== 'string')
      fail('unsupported_item_shape');
    if (!NON_TOOL_ITEMS.has(item.type) && !ITEM_TOOL_MAP[item.type])
      unknownItemTypes.add(item.type);
    items.push({ ...item, __row: row.type });
  }
  const completed = items.filter((item) => item.__row === 'item.completed');
  const toolCalls = completed
    .filter(
      (item) =>
        typeof item.type === 'string' && ITEM_TOOL_MAP[item.type] !== undefined,
    )
    .map((item) => ({
      id: item.id ?? null,
      tool: ITEM_TOOL_MAP[item.type as string]!,
      item_type: item.type as string,
      succeeded: itemSucceeded(item),
      payload: payloadStrings(item).slice(0, 40),
    }));
  return {
    rows,
    execution,
    items,
    toolCalls,
    unknownItemTypes: [...unknownItemTypes].sort(),
    usage: terminalItem.usage ?? null,
    evidenceRecords: evidenceRecords(
      eventsBytes,
      options.eventsFile,
      executionBytes,
      options.executionFile,
    ),
  };
}

export function deriveCodexCard(options: {
  readonly assignment: Assignment;
  readonly template: CapabilityCard;
  readonly eventsFile: string;
  readonly executionFile: string;
}): CapabilityDerivation {
  return deriveOutcome(options.assignment, options.template, () => {
    assertTemplateIdentity(options.assignment, options.template, 'codex');
    const native = readCodexExecution({
      eventsFile: options.eventsFile,
      executionFile: options.executionFile,
      sessionId: options.template.session_id,
      cwd: options.template.cwd,
    });
    const successfulTool = (tool: string) =>
      native.toolCalls.some((call) => call.tool === tool && call.succeeded);
    const card = structuredClone(options.template);
    card.evidence_level = 'runtime';
    card.observed_at = native.execution.finished_at as string;
    card.evidence_records = native.evidenceRecords;
    card.native_observation = {
      source: 'codex-exec-json',
      thread_id: options.template.session_id,
      cwd: native.execution.cwd,
      sandbox: native.execution.sandbox ?? null,
      resumed_from: native.execution.resumed_from ?? null,
      item_types_observed: [
        ...new Set(native.items.map((item) => String(item.type))),
      ].sort(),
      unmapped_item_types: native.unknownItemTypes,
      tool_calls: native.toolCalls.map((call) => ({
        tool: call.tool,
        item_type: call.item_type,
        succeeded: call.succeeded,
      })),
      usage: native.usage,
      skill_evidence:
        'not_reported_by_this_cli_version: skills stay unknown and can never satisfy a required capability from this stream alone',
    };
    card.tools = card.tools.map((tool) => {
      const known = Object.values(ITEM_TOOL_MAP).includes(tool.id);
      const verified = known && successfulTool(tool.id);
      const next = {
        ...tool,
        state: verified ? 'verified' : 'unknown',
      };
      if (verified) next.evidence_ref = options.eventsFile;
      return next;
    });
    card.skills = card.skills.map((skill) => {
      fingerprintTemplateSkill(skill);
      // `codex exec --json` does not report skill invocation and shell payloads
      // cannot prove that a skill was loaded or followed. Skills therefore never
      // reach `verified` here; they stay `unknown` so a required skill fails
      // closed and the caller must use `preferred` or provide in-host evidence.
      return { ...skill, state: 'unknown' };
    });
    return {
      card,
      limitations: [
        'skill_invocation_not_reported_by_codex_exec_json',
        'unmapped_item_types_are_not_promoted',
      ],
    };
  });
}
