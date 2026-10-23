import path from 'node:path';
import type { Assignment, CapabilityCard } from '../../collab/contracts.js';
import {
  assertTemplateIdentity,
  deriveOutcome,
  evidenceRecords,
  fail,
  fingerprintTemplateSkill,
  isTimestamp,
  parseExecution,
  readNativeEvidence,
  realPath,
  record,
  samePath,
  type CapabilityDerivation,
} from './shared.js';

/**
 * Derive a runtime capability card from a saved Claude CLI stream.
 *
 * Preserved maintained semantics: a discovery/bootstrap execution may only use
 * Read and Skill; successful call/result correlation is required for `verified`;
 * a skill is `verified` only when the injected base directory matches the
 * fingerprinted skill source. Unknown or unobserved states stay unknown.
 */
const MAX_CLAUDE_EVENTS = 10000;

interface ClaudeCall {
  readonly id: string;
  readonly name: string;
  readonly input?: Record<string, unknown>;
}

interface ClaudeResult {
  readonly is_error?: boolean;
}

export interface ClaudeNativeExecution {
  readonly rows: Record<string, unknown>[];
  readonly execution: Record<string, unknown>;
  readonly init: Record<string, unknown>;
  readonly result: Record<string, unknown>;
  readonly calls: Map<string, ClaudeCall>;
  readonly results: Map<string, ClaudeResult>;
  readonly injections: Map<string, string>;
  readonly evidenceRecords: { ref: string; digest: string }[];
}

export interface ClaudeEvidenceOptions {
  readonly eventsFile: string;
  readonly executionFile: string;
  readonly sessionId: string;
  readonly cwd: string;
}

function stringArray(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string') ||
    new Set(value).size !== value.length
  )
    return fail('unsupported_native_tools');
  return value as string[];
}

export function readClaudeExecution(
  options: ClaudeEvidenceOptions,
): ClaudeNativeExecution {
  const eventsBytes = readNativeEvidence(options.eventsFile);
  const executionBytes = readNativeEvidence(options.executionFile);
  let rows: Record<string, unknown>[];
  let execution: Record<string, unknown>;
  try {
    const lines = eventsBytes.text.trim().split('\n');
    if (lines.length > MAX_CLAUDE_EVENTS) fail('event_limit');
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
  if (rows.some((row) => typeof row.type !== 'string'))
    fail('unsupported_event_shape');
  const inits = rows.filter(
    (row) => row.type === 'system' && row.subtype === 'init',
  );
  const terminals = rows.filter((row) => row.type === 'result');
  if (
    inits.length !== 1 ||
    terminals.length !== 1 ||
    rows[rows.length - 1] !== terminals[0]
  )
    fail('ambiguous_native_lifecycle');
  const init = inits[0]!;
  const result = terminals[0]!;
  if (result.is_error !== false || result.subtype !== 'success')
    fail('native_result_failed');
  if (
    init.session_id !== options.sessionId ||
    result.session_id !== options.sessionId
  )
    fail('native_identity_mismatch');
  if (typeof init.cwd !== 'string' || !samePath(init.cwd, options.cwd))
    fail('native_cwd_mismatch');
  const tools = stringArray(init.tools);
  const calls = new Map<string, ClaudeCall>();
  const results = new Map<string, ClaudeResult>();
  const injections = new Map<string, string>();
  let initialized = false;
  let pendingSkill: ClaudeCall | undefined;
  for (const row of rows) {
    if (row === init) initialized = true;
    if (row.type !== 'assistant' && row.type !== 'user') continue;
    if (!initialized) fail('message_before_native_init');
    if (row.session_id !== options.sessionId || row.parent_tool_use_id != null)
      fail('foreign_or_nested_session_event');
    const message = record(row.message) ? row.message : null;
    if (!message || !Array.isArray(message.content))
      fail('unsupported_message_shape');
    for (const item of message.content) {
      if (!record(item)) continue;
      if (item.type === 'tool_use') {
        if (
          row.type !== 'assistant' ||
          typeof item.id !== 'string' ||
          !item.id ||
          calls.has(item.id) ||
          typeof item.name !== 'string' ||
          !tools.includes(item.name)
        )
          fail('unsupported_tool_call');
        const call: ClaudeCall = {
          id: item.id,
          name: item.name,
          ...(record(item.input) ? { input: item.input } : {}),
        };
        calls.set(item.id, call);
        pendingSkill = undefined;
      } else if (item.type === 'tool_result') {
        if (
          row.type !== 'user' ||
          typeof item.tool_use_id !== 'string' ||
          !calls.has(item.tool_use_id) ||
          results.has(item.tool_use_id) ||
          (item.is_error !== undefined && typeof item.is_error !== 'boolean')
        )
          fail('unsupported_tool_result');
        const outcome: ClaudeResult =
          item.is_error === undefined ? {} : { is_error: item.is_error };
        results.set(item.tool_use_id, outcome);
        const call = calls.get(item.tool_use_id)!;
        pendingSkill =
          call.name === 'Skill' && !outcome.is_error ? call : undefined;
      } else if (
        row.type === 'user' &&
        row.isSynthetic === true &&
        item.type === 'text' &&
        typeof item.text === 'string' &&
        item.text.startsWith('Base directory for this skill: ')
      ) {
        const base = item.text
          .split('\n')[0]!
          .slice('Base directory for this skill: '.length)
          .trim();
        if (!pendingSkill || !path.isAbsolute(base))
          fail('ambiguous_skill_injection');
        injections.set(pendingSkill.id, realPath(base));
        pendingSkill = undefined;
      }
    }
  }
  if ([...calls.keys()].some((id) => !results.has(id)))
    fail('incomplete_tool_results');
  return {
    rows,
    execution,
    init,
    result,
    calls,
    results,
    injections,
    evidenceRecords: evidenceRecords(
      eventsBytes,
      options.eventsFile,
      executionBytes,
      options.executionFile,
    ),
  };
}

export function deriveClaudeCard(options: {
  readonly assignment: Assignment;
  readonly template: CapabilityCard;
  readonly eventsFile: string;
  readonly executionFile: string;
}): CapabilityDerivation {
  return deriveOutcome(options.assignment, options.template, () => {
    if (
      options.assignment.assignee.harness !== 'claude' ||
      options.assignment.assignee.surface !== 'cli'
    )
      fail('unsupported_harness_surface');
    assertTemplateIdentity(options.assignment, options.template, 'claude');
    const native = readClaudeExecution({
      eventsFile: options.eventsFile,
      executionFile: options.executionFile,
      sessionId: options.template.session_id,
      cwd: options.template.cwd,
    });
    if (!['bootstrap', 'discovery'].includes(String(native.execution.phase)))
      fail('not_a_discovery_execution');
    if (
      [...native.calls.values()].some(
        (call) => !['Read', 'Skill'].includes(call.name),
      )
    )
      fail('discovery_performed_unexpected_action');
    const successful = (name: string) =>
      [...native.calls.values()].some(
        (call) => call.name === name && !native.results.get(call.id)?.is_error,
      );
    const card = structuredClone(options.template);
    card.evidence_level = 'runtime';
    card.observed_at = native.execution.finished_at as string;
    card.evidence_records = native.evidenceRecords;
    card.native_observation = {
      model: native.init.model,
      tools: native.init.tools,
      source: 'claude-cli-stream',
    };
    card.tools = card.tools.map((tool) => ({
      ...tool,
      state: !stringArray(native.init.tools).includes(tool.id)
        ? 'unknown'
        : successful(tool.id)
          ? 'verified'
          : 'callable',
      evidence_ref: options.eventsFile,
    }));
    card.skills = card.skills.map((skill) => {
      const snapshot = fingerprintTemplateSkill(skill);
      const pinned = skill as typeof skill & { native_name?: unknown };
      const nativeName =
        typeof pinned.native_name === 'string'
          ? pinned.native_name
          : path.basename(path.dirname(snapshot.entry));
      const discoveredNames = [
        ...(Array.isArray(native.init.skills) ? native.init.skills : []),
        ...(Array.isArray(native.init.slash_commands)
          ? native.init.slash_commands
          : []),
      ];
      const discovered = discoveredNames.includes(nativeName);
      const loaded = [...native.calls.values()].filter(
        (call) =>
          call.name === 'Skill' &&
          call.input?.skill === nativeName &&
          !native.results.get(call.id)?.is_error,
      );
      const sourceMatched = loaded.some(
        (call) => native.injections.get(call.id) === snapshot.directory,
      );
      return {
        ...skill,
        state: sourceMatched
          ? 'verified'
          : discovered
            ? 'discovered'
            : 'unknown',
        evidence_ref: options.eventsFile,
      };
    });
    return { card };
  });
}
