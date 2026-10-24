import fs from 'node:fs';
import path from 'node:path';
import { fingerprintSkill } from '../../collab/fingerprint.js';
import type {
  Assignment,
  Capability,
  CapabilityCard,
} from '../../collab/contracts.js';
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
  readonly executionFile?: string | null;
  readonly live?: boolean;
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
  if (options.live && options.executionFile) fail('live_execution_conflict');
  if (!options.live && !options.executionFile) fail('execution_required');
  const executionBytes = options.executionFile
    ? readNativeEvidence(options.executionFile)
    : null;
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
    execution =
      executionBytes === null
        ? { status: 'observed', mode: 'live-session-snapshot' }
        : parseExecution(executionBytes.text);
  } catch {
    fail('invalid_native_json');
  }
  if (
    !options.live &&
    (execution.status !== 'exited' || execution.exit_code !== 0)
  )
    fail('native_process_not_successfully_exited');
  if (
    !options.live &&
    (!isTimestamp(execution.started_at) ||
      !isTimestamp(execution.finished_at) ||
      Date.parse(execution.finished_at as string) <
        Date.parse(execution.started_at as string))
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
        message.toolName !== calls.get(message.toolCallId)?.name ||
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
  if (options.live) {
    if (
      typeof lastTurn.model !== 'string' ||
      !lastTurn.model ||
      typeof lastTurn.provider !== 'string' ||
      !lastTurn.provider
    )
      fail('live_model_observation_missing');
    const lastMessage = records.filter((row) => row.type === 'message').at(-1);
    if (
      !record(lastMessage?.message) ||
      lastMessage.message.role !== 'assistant' ||
      lastTurn.stop_reason !== 'stop'
    )
      fail('live_session_not_settled');
    // A later model change invalidates the old runtime observation; do not
    // present capabilities observed on the previous model as the new runtime.
    const lastIndex = records.lastIndexOf(lastMessage);
    if (records.slice(lastIndex + 1).some((row) => row.type === 'model_change'))
      fail('live_model_changed_since_observation');
  }
  return {
    records,
    execution,
    session,
    calls,
    results,
    assistantTurns,
    lastTurn,
    evidenceRecords:
      executionBytes === null
        ? [{ ref: options.sessionFile, digest: sessionBytes.digest }]
        : evidenceRecords(
            sessionBytes,
            options.sessionFile,
            executionBytes,
            options.executionFile!,
          ),
  };
}

export function derivePiCard(options: {
  readonly assignment: Assignment;
  readonly template: CapabilityCard;
  readonly sessionFile: string;
  readonly executionFile?: string | null;
  readonly live?: boolean;
}): CapabilityDerivation {
  return deriveOutcome(options.assignment, options.template, () => {
    assertTemplateIdentity(options.assignment, options.template, 'pi');
    const native = readPiExecution({
      sessionFile: options.sessionFile,
      executionFile: options.executionFile ?? null,
      live: options.live ?? false,
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
    card.observed_at = nativeObservationTime(
      options.live
        ? native.records.filter((row) => row.type === 'message')
        : native.records,
    );
    card.evidence_records = native.evidenceRecords;
    card.native_observation = {
      source: 'pi-session-jsonl',
      observation_mode: options.live
        ? 'live-session-snapshot'
        : 'exited-process',
      launcher_clock: options.live
        ? null
        : {
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
    return {
      card,
      ...(options.live
        ? {
            limitations: [
              'live_snapshot_does_not_prove_process_state_or_queue_approval_inventory',
              'capabilities_observed_in_saved_session_not_current_tool_registration',
            ],
          }
        : {}),
    };
  });
}

const PI_MANAGED_SESSION_SCHEMA = 'harness-collab/pi-managed-session/1';
const PI_SDK_PACKAGE = '@earendil-works/pi-coding-agent';
const PI_SDK_VERSION = '1.4.0';

function startupRecords(text: string): Record<string, unknown>[] {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length > MAX_EVENTS) fail('event_limit');
  try {
    return lines.map((line) => {
      const value: unknown = JSON.parse(line);
      if (!record(value)) fail('unsupported_event_shape');
      return value;
    });
  } catch {
    return fail('invalid_native_json');
  }
}

function startupNames(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string' && item.length > 0)
  )
    fail('startup_tool_inventory_invalid');
  const names = value as string[];
  if (new Set(names).size !== names.length)
    fail('startup_tool_inventory_duplicate');
  return [...names];
}

function startupCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function sameObservedPath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right) || samePath(left, right);
}

function assertNativeHeader(
  header: Record<string, unknown>,
  sessionId: string,
  cwd: string,
): void {
  if (
    (header.type !== undefined && header.type !== 'session') ||
    header.id !== sessionId ||
    typeof header.cwd !== 'string' ||
    !samePath(header.cwd, cwd)
  )
    fail('native_header_identity_mismatch');
}

/** Derive startup availability from the native SDK observation, never from model settlement. */
export function derivePiStartupCard(options: {
  readonly assignment: Assignment;
  readonly template: CapabilityCard;
  readonly metadataFile: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly expectedProvider?: string;
  readonly expectedModel?: string;
}): CapabilityDerivation {
  return deriveOutcome(options.assignment, options.template, () => {
    assertTemplateIdentity(options.assignment, options.template, 'pi');
    if (
      options.template.session_id !== options.sessionId ||
      !samePath(options.template.cwd, options.cwd)
    )
      fail('startup_native_identity_mismatch');
    const metadata = readNativeEvidence(options.metadataFile);
    const sidecar = startupRecords(metadata.text);
    const starts = sidecar.filter((row) => row.type === 'session_start');
    if (starts.length !== 1) fail('startup_session_start_missing_or_ambiguous');
    const started = starts[0]!;
    if (
      started.schema !== PI_MANAGED_SESSION_SCHEMA ||
      started.session_id !== options.sessionId ||
      typeof started.cwd !== 'string' ||
      !samePath(started.cwd, options.cwd) ||
      !isTimestamp(started.at) ||
      !(
        started.session_file === null ||
        typeof started.session_file === 'string'
      )
    )
      fail('startup_session_start_identity_mismatch');

    // Resource reloads/tool-selection updates append new sidecar observations. The
    // latest one is authoritative; a stale or foreign latest row never falls back.
    const ready = sidecar
      .filter((row) => row.type === 'resources_ready')
      .at(-1);
    if (!ready) fail('native_resources_ready_missing');
    const payload = ready;
    if (
      payload.schema !== PI_MANAGED_SESSION_SCHEMA ||
      payload.type !== 'resources_ready' ||
      payload.phase !== 'interactive_mode_init_complete' ||
      !isTimestamp(payload.at) ||
      Date.parse(payload.at as string) < Date.parse(started.at as string) ||
      payload.session_id !== options.sessionId ||
      typeof payload.cwd !== 'string' ||
      !samePath(payload.cwd, options.cwd)
    )
      fail('native_resources_ready_identity_mismatch');

    const nativeHeader = payload.native_header;
    if (!record(nativeHeader)) fail('startup_native_header_missing');
    assertNativeHeader(nativeHeader, options.sessionId, options.cwd);
    const reportedFile = payload.native_session_file;
    if (!(reportedFile === null || typeof reportedFile === 'string'))
      fail('startup_native_session_file_invalid');
    const startedFile =
      typeof started.session_file === 'string' ? started.session_file : null;
    if (
      (reportedFile !== null && !path.isAbsolute(reportedFile)) ||
      (startedFile !== null && !path.isAbsolute(startedFile))
    )
      fail('startup_native_session_file_invalid');
    if (
      reportedFile !== null &&
      startedFile !== null &&
      !sameObservedPath(reportedFile, startedFile)
    )
      fail('startup_native_session_file_mismatch');
    const sessionFile = reportedFile ?? startedFile;
    let sessionEvidence: ReturnType<typeof readNativeEvidence> | null = null;
    if (sessionFile !== null) {
      let stat: ReturnType<typeof fs.lstatSync> | undefined;
      try {
        stat = fs.lstatSync(sessionFile);
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : null;
        if (code !== 'ENOENT') fail('native_evidence_unavailable');
      }
      if (stat) {
        if (!stat.isFile() || stat.isSymbolicLink())
          fail('unsupported_evidence_file');
        sessionEvidence = readNativeEvidence(sessionFile);
        const nativeRows = startupRecords(sessionEvidence.text);
        const headers = nativeRows.filter((row) => row.type === 'session');
        if (headers.length !== 1 || nativeRows[0] !== headers[0])
          fail('ambiguous_native_lifecycle');
        assertNativeHeader(headers[0]!, options.sessionId, options.cwd);
        for (const key of ['timestamp', 'version'] as const) {
          if (
            nativeHeader[key] !== undefined &&
            headers[0]![key] !== undefined &&
            nativeHeader[key] !== headers[0]![key]
          )
            fail('native_header_mismatch');
        }
      }
    }

    const sdk = payload.sdk;
    if (
      !record(sdk) ||
      sdk.package !== PI_SDK_PACKAGE ||
      sdk.version !== PI_SDK_VERSION
    )
      fail('unsupported_native_sdk');
    const nativeIdentity = payload.native_identity;
    if (!record(nativeIdentity)) fail('startup_native_identity_missing');
    for (const key of [
      'agent_id',
      'harness',
      'surface',
      'configuration_id',
    ] as const) {
      if (
        typeof nativeIdentity[key] !== 'string' ||
        nativeIdentity[key] !== options.template[key]
      )
        fail('startup_native_identity_mismatch');
    }
    if (nativeIdentity.harness !== 'pi') fail('unsupported_harness');

    const model = payload.model;
    if (
      !record(model) ||
      typeof model.provider !== 'string' ||
      model.provider.length === 0 ||
      typeof model.id !== 'string' ||
      model.id.length === 0 ||
      !(
        model.thinking_level === null ||
        typeof model.thinking_level === 'string'
      )
    )
      fail('startup_model_observation_missing');
    if (
      (options.expectedProvider !== undefined &&
        model.provider !== options.expectedProvider) ||
      (options.expectedModel !== undefined &&
        model.id !== options.expectedModel)
    )
      fail('startup_model_identity_mismatch');

    const configuration = payload.configuration;
    if (
      !record(configuration) ||
      configuration.configuration_id !== nativeIdentity.configuration_id
    )
      fail('startup_configuration_identity_mismatch');
    if (configuration.project_trusted !== true)
      fail('startup_project_trust_unresolved');

    const inventory = payload.resource_inventory;
    if (
      !record(inventory) ||
      inventory.completeness !== 'complete' ||
      inventory.source !== 'pi_1_4_runtime_apis'
    )
      fail('startup_resource_inventory_incomplete');
    const tools = inventory.tools;
    if (!record(tools)) fail('startup_tool_inventory_invalid');
    const allToolNames = startupNames(tools.all_names);
    const activeToolNames = startupNames(tools.active_names);
    const allToolSet = new Set(allToolNames);
    if (activeToolNames.some((name) => !allToolSet.has(name)))
      fail('startup_active_tool_not_registered');

    if (
      !Array.isArray(inventory.skills) ||
      inventory.skills.length > MAX_EVENTS
    )
      fail('startup_skill_inventory_invalid');
    const observedSkills: {
      readonly name: string;
      readonly entry: string;
      readonly bundleDigest: string;
    }[] = [];
    const skillNames = new Set<string>();
    const skillEntries = new Set<string>();
    for (const item of inventory.skills) {
      if (
        !record(item) ||
        typeof item.name !== 'string' ||
        item.name.length === 0 ||
        typeof item.entry !== 'string' ||
        !path.isAbsolute(item.entry) ||
        path.basename(item.entry) !== 'SKILL.md' ||
        item.availability !== 'available' ||
        item.body_loaded !== 'not_observed'
      )
        fail('startup_skill_inventory_unresolved');
      if (skillNames.has(item.name)) fail('startup_skill_inventory_duplicate');
      let fingerprint: ReturnType<typeof fingerprintSkill>;
      try {
        fingerprint = fingerprintSkill(item.entry);
      } catch {
        fail('startup_skill_files_unavailable');
      }
      if (!samePath(fingerprint.path, item.entry))
        fail('startup_skill_entry_mismatch');
      const canonicalEntry = path.resolve(fingerprint.path);
      if (skillEntries.has(canonicalEntry))
        fail('startup_skill_inventory_duplicate');
      skillNames.add(item.name);
      skillEntries.add(canonicalEntry);
      observedSkills.push({
        name: item.name,
        entry: fingerprint.path,
        bundleDigest: fingerprint.bundle_digest,
      });
    }

    const runtime = payload.owned_runtime;
    if (
      !record(runtime) ||
      runtime.scope !== 'pinned_pi_1_4_owned_runtime' ||
      runtime.queues_completeness !== 'complete' ||
      !startupCount(runtime.pending_message_count) ||
      runtime.work_observation !== 'complete' ||
      typeof runtime.is_idle !== 'boolean' ||
      typeof runtime.is_streaming !== 'boolean' ||
      typeof runtime.is_compacting !== 'boolean' ||
      typeof runtime.is_bash_running !== 'boolean' ||
      typeof runtime.has_pending_bash_messages !== 'boolean' ||
      !startupCount(runtime.pending_tool_calls) ||
      runtime.extension_dialogs_completeness !== 'complete' ||
      !startupCount(runtime.pending_extension_dialogs) ||
      runtime.built_in_ui_approvals_observation !== 'complete' ||
      !Array.isArray(runtime.uncovered_approval_paths) ||
      !runtime.uncovered_approval_paths.every(
        (item) => typeof item === 'string',
      )
    )
      fail('startup_owned_runtime_inventory_incomplete');
    if (
      runtime.pending_message_count !== 0 ||
      runtime.is_idle !== true ||
      runtime.is_streaming !== false ||
      runtime.is_compacting !== false ||
      runtime.is_bash_running !== false ||
      runtime.has_pending_bash_messages !== false ||
      runtime.pending_tool_calls !== 0
    )
      fail('startup_owned_runtime_work_pending');
    if (
      runtime.pending_extension_dialogs !== 0 ||
      runtime.uncovered_approval_paths.length !== 0
    )
      fail('startup_approval_unresolved');

    const activeToolSet = new Set(activeToolNames);
    const toolsById = new Map<string, Capability>();
    for (const capability of options.template.tools) {
      const { evidence_ref: _evidenceRef, ...declared } = capability;
      const state = activeToolSet.has(capability.id)
        ? 'callable'
        : allToolSet.has(capability.id)
          ? 'disabled'
          : 'unknown';
      toolsById.set(capability.id, {
        ...declared,
        state,
        ...(state === 'callable' ? { evidence_ref: options.metadataFile } : {}),
      });
    }
    for (const name of allToolNames) {
      if (toolsById.has(name)) continue;
      const state = activeToolSet.has(name) ? 'callable' : 'disabled';
      toolsById.set(name, {
        id: name,
        state,
        ...(state === 'callable' ? { evidence_ref: options.metadataFile } : {}),
      });
    }

    const skillsById = new Map<string, Capability>();
    const consumedSkills = new Set<string>();
    for (const capability of options.template.skills) {
      const snapshot = fingerprintTemplateSkill(capability);
      const nativeNameValue = (
        capability as Capability & { native_name?: unknown }
      ).native_name;
      const nativeName =
        typeof nativeNameValue === 'string' ? nativeNameValue : capability.id;
      const observed = observedSkills.find(
        (skill) => skill.name === nativeName,
      );
      if (observed) {
        if (
          !samePath(snapshot.entry, observed.entry) ||
          snapshot.bundleDigest !== observed.bundleDigest
        )
          fail('startup_skill_identity_mismatch');
        consumedSkills.add(observed.name);
      }
      const { evidence_ref: _evidenceRef, ...declared } = capability;
      skillsById.set(capability.id, {
        ...declared,
        state: observed ? 'callable' : 'unknown',
        ...(observed ? { evidence_ref: options.metadataFile } : {}),
      });
    }
    for (const skill of observedSkills) {
      if (consumedSkills.has(skill.name)) continue;
      if (skillsById.has(skill.name)) fail('startup_skill_identity_mismatch');
      skillsById.set(skill.name, {
        id: skill.name,
        state: 'callable',
        path: skill.entry,
        bundle_digest: skill.bundleDigest,
        evidence_ref: options.metadataFile,
      });
    }

    const card = structuredClone(options.template);
    card.evidence_level = 'runtime';
    card.observed_at = payload.at as string;
    card.evidence_records = [
      { ref: options.metadataFile, digest: metadata.digest },
      ...(sessionEvidence && sessionFile
        ? [{ ref: sessionFile, digest: sessionEvidence.digest }]
        : []),
    ];
    card.native_observation = {
      source: 'pi-managed-resources-ready-sidecar',
      observation_mode: 'startup-resource-inventory',
      session_id: options.sessionId,
      cwd: options.cwd,
      session_file: sessionFile,
      native_header: {
        id: nativeHeader.id,
        cwd: nativeHeader.cwd,
        ...(nativeHeader.timestamp === undefined
          ? {}
          : { timestamp: nativeHeader.timestamp }),
        ...(nativeHeader.version === undefined
          ? {}
          : { version: nativeHeader.version }),
      },
      sdk: { package: PI_SDK_PACKAGE, version: PI_SDK_VERSION },
      model: {
        provider: model.provider,
        id: model.id,
        thinking_level: model.thinking_level,
      },
      native_identity: {
        agent_id: nativeIdentity.agent_id,
        harness: nativeIdentity.harness,
        surface: nativeIdentity.surface,
        configuration_id: nativeIdentity.configuration_id,
      },
      configuration: {
        configuration_id: configuration.configuration_id,
        project_trusted: configuration.project_trusted,
      },
      resource_inventory: {
        completeness: 'complete',
        source: 'pi_1_4_runtime_apis',
        tools: {
          all_names: [...allToolNames].sort(),
          active_names: [...activeToolNames].sort(),
        },
        skills: [...observedSkills]
          .sort((left, right) => left.name.localeCompare(right.name))
          .map((skill) => ({
            name: skill.name,
            entry: skill.entry,
            bundle_digest: skill.bundleDigest,
            availability: 'available',
            body_loaded: 'not_observed',
          })),
      },
      owned_runtime: {
        scope: runtime.scope,
        queues_completeness: runtime.queues_completeness,
        pending_message_count: runtime.pending_message_count,
        work_observation: runtime.work_observation,
        is_idle: runtime.is_idle,
        is_streaming: runtime.is_streaming,
        is_compacting: runtime.is_compacting,
        is_bash_running: runtime.is_bash_running,
        has_pending_bash_messages: runtime.has_pending_bash_messages,
        pending_tool_calls: runtime.pending_tool_calls,
        extension_dialogs_completeness: runtime.extension_dialogs_completeness,
        pending_extension_dialogs: runtime.pending_extension_dialogs,
        built_in_ui_approvals_observation:
          runtime.built_in_ui_approvals_observation,
        uncovered_approval_paths: runtime.uncovered_approval_paths,
      },
      limitations: [
        'tool_execution_not_observed',
        'skill_body_loading_not_observed',
        'startup_resource_metadata_not_cryptographically_authenticated',
        ...(sessionEvidence ? [] : ['native_transcript_not_yet_persisted']),
      ],
    };
    card.tools = [...toolsById.values()];
    card.skills = [...skillsById.values()];
    return {
      card,
      limitations: [
        'tool_execution_not_observed',
        'skill_body_loading_not_observed',
        ...(sessionEvidence ? [] : ['native_transcript_not_yet_persisted']),
      ],
    };
  });
}
