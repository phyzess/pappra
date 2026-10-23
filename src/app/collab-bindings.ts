import fs from 'node:fs';
import path from 'node:path';
import {
  acquireInstallLock,
  ensureStatePathBoundary,
  releaseInstallLock,
  writeBytesAtomic,
} from '../install/ownership.js';
import { inspectWorkspaceConfig } from '../workspace/config.js';
import { resolveWorkspaceRoot } from '../workspace/resolve.js';
import { readBoundedFile } from './bounded-file.js';
import { openTaskStore, type TaskStoreFailure } from './collab-task-store.js';
import type { TaskRecord } from '../collab/types.js';

export const COLLAB_BINDINGS_SCHEMA = 'pappra/collaboration-bindings/1';
export const COLLAB_BINDING_RESULT_SCHEMA =
  'pappra/collaboration-binding-result/1';
const MAX_INDEX_BYTES = 1024 * 1024;
const MAX_ROOTS_BYTES = 1024 * 1024;
const MAX_ROOTS = 32;
const MAX_OUTPUT_ROWS = 50;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface BindingEntry {
  readonly alias: string;
  readonly record: string;
  readonly record_realpath: string;
  readonly task_root: string;
  readonly domain_root: string;
  readonly protocol_task_id: string;
  readonly domain_id: string;
  readonly record_created_at: string;
  readonly bound_at: string;
}

export interface BindingTombstone {
  readonly alias: string;
  readonly at: string;
  readonly previous: BindingEntry | null;
}

interface BindingTable {
  readonly schema: typeof COLLAB_BINDINGS_SCHEMA;
  readonly workspace_id: string;
  readonly bindings: Record<string, BindingEntry>;
  readonly unbound: Record<string, BindingTombstone>;
}

interface IndexState {
  readonly present: boolean;
  readonly table: BindingTable;
}

export interface BindingServiceFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly nextAction: string | null;
  readonly details?: readonly string[];
}

export type BindingServiceResult<T> =
  { readonly ok: true; readonly value: T } | BindingServiceFailure;

export interface TargetIdentity {
  readonly record: string;
  readonly record_realpath: string;
  readonly task_root: string;
  readonly domain_root: string;
  readonly protocol_task_id: string;
  readonly domain_id: string;
  readonly record_created_at: string;
}

export interface TargetSnapshot extends TargetIdentity {
  readonly state_revision: number;
  readonly coordinator_epoch: number | null;
  readonly dispatch_frozen: boolean;
  readonly attempts: readonly Record<string, unknown>[];
  readonly attempt_count: number;
  readonly truncated: boolean;
}

interface ResolvedTarget {
  readonly target: TargetSnapshot;
  readonly record: TaskRecord;
}

interface DiscoveredCandidate {
  readonly target: ResolvedTarget;
  readonly candidate: string;
}

type TargetInspection =
  { readonly ok: true; readonly value: ResolvedTarget } | BindingServiceFailure;

function failure(
  code: string,
  message: string,
  nextAction: string | null = null,
  details?: readonly string[],
): BindingServiceFailure {
  return {
    ok: false,
    code,
    message,
    nextAction,
    ...(details === undefined ? {} : { details }),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeAlias(value: unknown): value is string {
  return typeof value === 'string' && TASK_ID_PATTERN.test(value);
}

function emptyTable<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function own<T>(table: Record<string, T>, key: string): boolean {
  return Object.hasOwn(table, key);
}

function absoluteText(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && path.isAbsolute(value)
  );
}

function validTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function indexFile(root: string): string {
  return path.join(root, '.pappra', 'local', 'collab-bindings.json');
}

function indexLockFile(root: string): string {
  return path.join(root, '.pappra', 'local', 'collab-bindings.lock');
}

async function selectWorkspace(
  rootOption: string | null,
): Promise<
  BindingServiceResult<{ readonly root: string; readonly workspace_id: string }>
> {
  if (rootOption !== null && !path.isAbsolute(rootOption))
    return failure(
      'invalid_options',
      '--root must be an absolute workspace path.',
      'Pass an absolute root or omit it to use the current workspace.',
    );
  const resolution = await resolveWorkspaceRoot({
    startPath: rootOption ?? process.cwd(),
  });
  if (resolution.state !== 'registered' || resolution.root === null)
    return failure(
      'workspace_unavailable',
      `No usable registered workspace was selected (${resolution.state}).`,
      'Pass --root for a registered workspace or run pappra init.',
      resolution.diagnostics.map((item) => item.code),
    );
  const config = await inspectWorkspaceConfig(resolution.root, {
    missing: 'error',
  });
  if (config.value === null)
    return failure(
      'workspace_unavailable',
      'The selected workspace configuration is missing or invalid.',
      'Repair workspace.json explicitly; binding metadata is not read or written.',
      config.diagnostics.map((item) => item.code),
    );
  return {
    ok: true,
    value: {
      root: config.root,
      workspace_id: config.value.workspaceId,
    },
  };
}

function validateBindingEntry(
  alias: string,
  value: unknown,
  errors: string[],
): BindingEntry | null {
  if (!safeAlias(alias)) {
    errors.push(`binding_entry_invalid:${alias}:unsafe_alias`);
    return null;
  }
  if (!isPlainObject(value)) {
    errors.push(`binding_entry_invalid:${alias}:not_an_object`);
    return null;
  }
  const keys = Object.keys(value).sort();
  const expected = [
    'alias',
    'bound_at',
    'domain_id',
    'domain_root',
    'protocol_task_id',
    'record',
    'record_created_at',
    'record_realpath',
    'task_root',
  ];
  if (keys.join('|') !== expected.join('|')) {
    errors.push(`binding_entry_invalid:${alias}:unexpected_fields`);
    return null;
  }
  if (value.alias !== alias) {
    errors.push(`binding_entry_invalid:${alias}:alias_mismatch`);
    return null;
  }
  if (
    !absoluteText(value.record) ||
    path.basename(value.record) !== 'task.json' ||
    !absoluteText(value.record_realpath) ||
    !absoluteText(value.task_root) ||
    !absoluteText(value.domain_root)
  ) {
    errors.push(`binding_entry_invalid:${alias}:path_invalid`);
    return null;
  }
  if (!safeAlias(value.protocol_task_id)) {
    errors.push(`binding_entry_invalid:${alias}:protocol_task_id_invalid`);
    return null;
  }
  if (typeof value.domain_id !== 'string' || !value.domain_id.trim()) {
    errors.push(`binding_entry_invalid:${alias}:domain_id_invalid`);
    return null;
  }
  if (!validTimestamp(value.record_created_at)) {
    errors.push(`binding_entry_invalid:${alias}:record_created_at_invalid`);
    return null;
  }
  if (!validTimestamp(value.bound_at)) {
    errors.push(`binding_entry_invalid:${alias}:bound_at_invalid`);
    return null;
  }
  return {
    alias,
    record: value.record,
    record_realpath: value.record_realpath,
    task_root: value.task_root,
    domain_root: value.domain_root,
    protocol_task_id: value.protocol_task_id,
    domain_id: value.domain_id,
    record_created_at: value.record_created_at,
    bound_at: value.bound_at,
  };
}

function validateTombstone(
  alias: string,
  value: unknown,
  errors: string[],
): BindingTombstone | null {
  if (!safeAlias(alias)) {
    errors.push(`unbound_entry_invalid:${alias}:unsafe_alias`);
    return null;
  }
  if (!isPlainObject(value) || value.alias !== alias) {
    errors.push(`unbound_entry_invalid:${alias}:not_an_object`);
    return null;
  }
  const keys = Object.keys(value).sort();
  if (keys.join('|') !== 'alias|at|previous') {
    errors.push(`unbound_entry_invalid:${alias}:unexpected_fields`);
    return null;
  }
  if (!validTimestamp(value.at)) {
    errors.push(`unbound_entry_invalid:${alias}:at_invalid`);
    return null;
  }
  let previous: BindingEntry | null = null;
  if (value.previous !== null) {
    previous = validateBindingEntry(alias, value.previous, errors);
    if (!previous) return null;
  }
  return { alias, at: value.at, previous };
}

function parseIndex(
  text: string,
  workspaceId: string,
): BindingServiceResult<BindingTable> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return failure(
      'bindings_invalid',
      'The collaboration bindings index is not valid JSON.',
      'Inspect and repair the index explicitly; it was not overwritten.',
    );
  }
  const errors: string[] = [];
  if (!isPlainObject(parsed)) {
    return failure(
      'bindings_invalid',
      'The collaboration bindings index is not a JSON object.',
      'Inspect and repair the index explicitly; it was not overwritten.',
    );
  }
  const keys = Object.keys(parsed).sort();
  if (keys.join('|') !== 'bindings|schema|unbound|workspace_id') {
    errors.push('bindings_unexpected_fields');
  }
  if (parsed.schema !== COLLAB_BINDINGS_SCHEMA)
    errors.push('bindings_schema_mismatch');
  if (parsed.workspace_id !== workspaceId)
    errors.push('bindings_workspace_mismatch');
  if (!isPlainObject(parsed.bindings)) errors.push('bindings_field_invalid');
  if (!isPlainObject(parsed.unbound)) errors.push('unbound_field_invalid');
  if (errors.length)
    return failure(
      'bindings_invalid',
      'The collaboration bindings index has an unsupported shape or workspace identity.',
      'Inspect and repair the index explicitly; it was not overwritten.',
      errors,
    );
  const bindings = emptyTable<BindingEntry>();
  for (const [alias, value] of Object.entries(
    parsed.bindings as Record<string, unknown>,
  )) {
    const entry = validateBindingEntry(alias, value, errors);
    if (entry) bindings[alias] = entry;
  }
  const unbound = emptyTable<BindingTombstone>();
  for (const [alias, value] of Object.entries(
    parsed.unbound as Record<string, unknown>,
  )) {
    const tombstone = validateTombstone(alias, value, errors);
    if (tombstone) unbound[alias] = tombstone;
  }
  if (Object.keys(bindings).some((alias) => own(unbound, alias)))
    errors.push('binding_unbound_overlap');
  if (errors.length)
    return failure(
      'bindings_invalid',
      'The collaboration bindings index contains invalid entries.',
      'Inspect and repair the index explicitly; it was not overwritten.',
      errors,
    );
  return {
    ok: true,
    value: {
      schema: COLLAB_BINDINGS_SCHEMA,
      workspace_id: workspaceId,
      bindings,
      unbound,
    },
  };
}

async function readIndex(
  root: string,
  workspaceId: string,
): Promise<BindingServiceResult<IndexState>> {
  const file = indexFile(root);
  const boundary = await ensureStatePathBoundary(root, file);
  if (!boundary.ok)
    return failure(
      'bindings_invalid',
      'The workspace private state path is redirected.',
      'Restore .pappra/local as a real directory inside the workspace.',
      [boundary.code],
    );
  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : null;
    if (code !== null && (code === 'ENOENT' || code === 'ENOTDIR'))
      return {
        ok: true,
        value: {
          present: false,
          table: {
            schema: COLLAB_BINDINGS_SCHEMA,
            workspace_id: workspaceId,
            bindings: emptyTable(),
            unbound: emptyTable(),
          },
        },
      };
    return failure(
      'bindings_invalid',
      'The collaboration bindings index could not be inspected.',
      'Inspect permissions and the private state path; nothing was written.',
    );
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_INDEX_BYTES)
    return failure(
      'bindings_invalid',
      'The collaboration bindings index is not a supported regular file within 1 MiB.',
      'Restore a regular index inside .pappra/local; nothing was written.',
    );
  const read = readBoundedFile(file, MAX_INDEX_BYTES);
  if (!read.ok)
    return failure(
      'bindings_invalid',
      'The collaboration bindings index could not be read as a bounded regular file.',
      'Inspect the index and private state; nothing was written.',
    );
  const parsed = parseIndex(read.text, workspaceId);
  if (!parsed.ok) return parsed;
  return { ok: true, value: { present: true, table: parsed.value } };
}

function tableJson(table: BindingTable): Record<string, unknown> {
  return {
    schema: COLLAB_BINDINGS_SCHEMA,
    workspace_id: table.workspace_id,
    bindings: { ...table.bindings },
    unbound: { ...table.unbound },
  };
}

function mapTargetFailure(error: TaskStoreFailure): BindingServiceFailure {
  if (error.code === 'task_record_missing')
    return failure(
      'target_missing',
      'The bound task record is missing.',
      'Inspect the target path; no fallback record is selected.',
    );
  return failure(
    'target_invalid',
    'The target is not a usable authoritative collaboration record.',
    'Inspect the record and task layout; no repair was attempted.',
    [error.code],
  );
}

async function inspectTarget(recordPath: string): Promise<TargetInspection> {
  if (!absoluteText(recordPath) || path.basename(recordPath) !== 'task.json')
    return failure(
      'target_invalid',
      'A binding target must be an absolute <task_root>/task.json path.',
      'Pass an absolute authoritative task.json path.',
    );
  const opened = await openTaskStore(path.dirname(recordPath));
  if (!opened.ok) return mapTargetFailure(opened);
  let recordRealpath: string;
  try {
    recordRealpath = fs.realpathSync(recordPath);
  } catch {
    return failure(
      'target_missing',
      'The bound task record is missing.',
      'Inspect the target path; no fallback record is selected.',
    );
  }
  if (recordRealpath !== opened.value.recordFile)
    return failure(
      'target_invalid',
      'The supplied record path is not the authoritative record for its task root.',
      'Pass the real <task_root>/task.json path.',
    );
  const record = opened.value.record;
  if (
    !safeAlias(record.task_id) ||
    !absoluteText(record.domain_root) ||
    typeof record.domain_id !== 'string' ||
    !record.domain_id.trim() ||
    !validTimestamp(record.created_at)
  )
    return failure(
      'target_invalid',
      'The task record does not expose a valid collaboration identity.',
      'Inspect the record; it was not repaired or imported.',
    );
  const attempts = Array.isArray(record.attempts) ? record.attempts : [];
  const attemptRows = attempts.slice(0, MAX_OUTPUT_ROWS).map((item) => {
    const attempt = item as unknown as Record<string, unknown>;
    const native = isPlainObject(attempt.native) ? attempt.native : null;
    const assignee = isPlainObject(attempt.assignee) ? attempt.assignee : null;
    return {
      subtask_id:
        typeof attempt.subtask_id === 'string' ? attempt.subtask_id : null,
      attempt: typeof attempt.attempt === 'number' ? attempt.attempt : null,
      state: typeof attempt.state === 'string' ? attempt.state : 'unknown',
      ownership:
        typeof attempt.ownership === 'string' ? attempt.ownership : null,
      assignee: assignee
        ? {
            agent_id: assignee.agent_id ?? null,
            session_id: assignee.session_id ?? null,
            harness: assignee.harness ?? null,
          }
        : null,
      native: native
        ? {
            runner: native.runner ?? null,
            session_id: native.session_id ?? null,
            run_id: native.run_id ?? null,
            mission_id: native.mission_id ?? null,
            observation: native.observation ?? 'unknown',
            evidence_ref: native.evidence_ref ?? null,
          }
        : null,
    };
  });
  const target: TargetSnapshot = {
    record: recordPath,
    record_realpath: opened.value.recordFile,
    task_root: opened.value.taskRoot,
    domain_root: opened.value.domainRoot,
    protocol_task_id: record.task_id,
    domain_id: record.domain_id,
    record_created_at: record.created_at,
    state_revision: record.state_revision,
    coordinator_epoch: record.coordinator?.owner_epoch ?? null,
    dispatch_frozen: record.dispatch_frozen === true,
    attempts: attemptRows,
    attempt_count: attempts.length,
    truncated: attempts.length > MAX_OUTPUT_ROWS,
  };
  return { ok: true, value: { target, record } };
}

function sameTargetIdentity(
  left: TargetIdentity,
  right: TargetIdentity,
): boolean {
  return (
    left.record_realpath === right.record_realpath &&
    left.task_root === right.task_root &&
    left.domain_root === right.domain_root &&
    left.protocol_task_id === right.protocol_task_id &&
    left.domain_id === right.domain_id &&
    left.record_created_at === right.record_created_at
  );
}

function bindingMatches(
  binding: BindingEntry,
  target: TargetIdentity,
): boolean {
  return sameTargetIdentity(pinnedIdentity(binding), target);
}

function pinnedIdentity(binding: BindingEntry): TargetIdentity {
  return {
    record: binding.record,
    record_realpath: binding.record_realpath,
    task_root: binding.task_root,
    domain_root: binding.domain_root,
    protocol_task_id: binding.protocol_task_id,
    domain_id: binding.domain_id,
    record_created_at: binding.record_created_at,
  };
}

type BindingStatus =
  | 'binding'
  | 'binding-missing'
  | 'binding-malformed'
  | 'binding-identity-changed';

async function inspectBinding(binding: BindingEntry): Promise<{
  readonly status: BindingStatus;
  readonly target: ResolvedTarget | null;
  readonly errors: readonly string[];
}> {
  const inspected = await inspectTarget(binding.record);
  if (!inspected.ok) {
    return {
      status:
        inspected.code === 'target_missing'
          ? 'binding-missing'
          : 'binding-malformed',
      target: null,
      errors: [inspected.code],
    };
  }
  if (!bindingMatches(binding, inspected.value.target))
    return {
      status: 'binding-identity-changed',
      target: null,
      errors: ['record_identity_changed'],
    };
  return {
    status: 'binding',
    target: inspected.value,
    errors: [],
  };
}

function bounded<T>(items: readonly T[]) {
  return {
    rows: items.slice(0, MAX_OUTPUT_ROWS),
    total: items.length,
    omitted: Math.max(0, items.length - MAX_OUTPUT_ROWS),
    truncated: items.length > MAX_OUTPUT_ROWS,
  };
}

export interface BindingCommandOptions {
  readonly root: string | null;
  readonly taskId: string | null;
  readonly record: string | null;
  readonly roots: string | null;
  readonly apply: boolean;
}

export async function listBindings(
  options: BindingCommandOptions,
): Promise<BindingServiceResult<Record<string, unknown>>> {
  const workspace = await selectWorkspace(options.root);
  if (!workspace.ok) return workspace;
  const index = await readIndex(
    workspace.value.root,
    workspace.value.workspace_id,
  );
  if (!index.ok) return index;
  const aliases = Object.keys(index.value.table.bindings).sort();
  const limited = bounded(aliases);
  const entries = [];
  for (const alias of limited.rows) {
    const binding = index.value.table.bindings[alias]!;
    const checked = await inspectBinding(binding);
    entries.push({
      alias,
      status: checked.status,
      record: binding.record,
      record_realpath: binding.record_realpath,
      task_root: binding.task_root,
      domain_root: binding.domain_root,
      protocol_task_id: binding.protocol_task_id,
      domain_id: binding.domain_id,
      record_created_at: binding.record_created_at,
      bound_at: binding.bound_at,
      errors: checked.errors,
    });
  }
  const tombstones = bounded(Object.keys(index.value.table.unbound).sort());
  return {
    ok: true,
    value: {
      schema: COLLAB_BINDING_RESULT_SCHEMA,
      ok: true,
      action: 'list',
      workspace_id: workspace.value.workspace_id,
      workspace_root: workspace.value.root,
      index_path: indexFile(workspace.value.root),
      present: index.value.present,
      bindings: entries,
      unbound: tombstones.rows.map((alias) => {
        const tombstone = index.value.table.unbound[alias]!;
        return {
          alias,
          at: tombstone.at,
          previous: tombstone.previous
            ? pinnedIdentity(tombstone.previous)
            : null,
        };
      }),
      counts: {
        bindings: limited.total,
        unbound: tombstones.total,
      },
      omitted: {
        bindings: limited.omitted,
        unbound: tombstones.omitted,
      },
      truncated: limited.truncated || tombstones.truncated,
      limits: ['pointer_metadata_only', 'no_protocol_content'],
    },
  };
}

export async function resolveBinding(
  options: BindingCommandOptions,
): Promise<BindingServiceResult<Record<string, unknown>>> {
  if (!safeAlias(options.taskId))
    return failure(
      'invalid_options',
      '--task-id must be a safe collaboration alias of 128 characters or fewer.',
      'Use a single path segment of letters, digits, dot, dash or underscore.',
    );
  const workspace = await selectWorkspace(options.root);
  if (!workspace.ok) return workspace;
  const index = await readIndex(
    workspace.value.root,
    workspace.value.workspace_id,
  );
  if (!index.ok) return index;
  // An explicit roots file is part of the request: validate it even when an
  // explicit binding or tombstone wins precedence, so a malformed option never
  // hides behind a usable pointer.
  let roots: readonly string[] | null = null;
  if (options.roots !== null) {
    const loaded = await loadRoots(options.roots);
    if (!loaded.ok) return loaded;
    roots = loaded.value;
  }
  const alias = options.taskId;
  const table = index.value.table;
  if (own(table.bindings, alias)) {
    const binding = table.bindings[alias]!;
    const checked = await inspectBinding(binding);
    return {
      ok: true,
      value: {
        schema: COLLAB_BINDING_RESULT_SCHEMA,
        ok: checked.status === 'binding',
        status: checked.status,
        action: 'resolve',
        alias,
        source: 'binding',
        usable: checked.status === 'binding',
        scope: checked.status === 'binding' ? 'persisted-history' : null,
        liveStatus: 'unknown',
        workspace_id: workspace.value.workspace_id,
        workspace_root: workspace.value.root,
        index_path: indexFile(workspace.value.root),
        pointer: pinnedIdentity(binding),
        target: checked.target?.target ?? null,
        candidates: [],
        errors: checked.errors,
        limits: ['persisted_history_only', 'native_live_status_unknown'],
      },
    };
  }
  if (own(table.unbound, alias)) {
    const marker = table.unbound[alias]!;
    return {
      ok: true,
      value: {
        schema: COLLAB_BINDING_RESULT_SCHEMA,
        ok: true,
        status: 'unbound',
        action: 'resolve',
        alias,
        source: null,
        usable: false,
        scope: null,
        liveStatus: 'unknown',
        workspace_id: workspace.value.workspace_id,
        workspace_root: workspace.value.root,
        index_path: indexFile(workspace.value.root),
        pointer: marker.previous ? pinnedIdentity(marker.previous) : null,
        target: null,
        candidates: [],
        errors: [`explicitly_unbound_at: ${marker.at}`],
        limits: ['explicit_tombstone', 'no_discovery_fallback'],
      },
    };
  }

  if (roots !== null) {
    const discovery = await discoverByRoots(alias, roots);
    if (!discovery.ok) return discovery;
    return {
      ok: true,
      value: {
        schema: COLLAB_BINDING_RESULT_SCHEMA,
        ok: discovery.value.status === 'discovery-unique',
        status: discovery.value.status,
        action: 'resolve',
        alias,
        source:
          discovery.value.status === 'discovery-unique' ? 'discovery' : null,
        usable: discovery.value.status === 'discovery-unique',
        scope:
          discovery.value.status === 'discovery-unique'
            ? 'persisted-history'
            : null,
        liveStatus: 'unknown',
        workspace_id: workspace.value.workspace_id,
        workspace_root: workspace.value.root,
        index_path: indexFile(workspace.value.root),
        pointer: null,
        target: discovery.value.target ?? null,
        candidates: discovery.value.candidates,
        errors: discovery.value.errors,
        limits: ['explicit_roots_only', 'native_live_status_unknown'],
      },
    };
  }

  return {
    ok: true,
    value: {
      schema: COLLAB_BINDING_RESULT_SCHEMA,
      ok: true,
      status: 'none',
      action: 'resolve',
      alias,
      source: null,
      usable: false,
      scope: null,
      liveStatus: 'unknown',
      workspace_id: workspace.value.workspace_id,
      workspace_root: workspace.value.root,
      index_path: indexFile(workspace.value.root),
      pointer: null,
      target: null,
      candidates: [],
      errors: [],
      limits: ['no_binding_or_explicit_roots'],
    },
  };
}

async function loadRoots(
  file: string,
): Promise<BindingServiceResult<readonly string[]>> {
  if (!path.isAbsolute(file))
    return failure(
      'roots_invalid',
      '--roots must be an absolute roots.json path.',
      'Pass an absolute roots file.',
    );
  const read = readBoundedFile(file, MAX_ROOTS_BYTES);
  if (!read.ok)
    return failure(
      'roots_invalid',
      'roots.json must be a readable regular JSON file within 1 MiB.',
      'Inspect the roots file; nothing was written.',
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text) as unknown;
  } catch {
    return failure(
      'roots_invalid',
      'roots.json is not valid JSON.',
      'Provide a strict array of absolute collaboration domain roots.',
    );
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_ROOTS)
    return failure(
      'roots_invalid',
      `roots.json must be an array of at most ${MAX_ROOTS} absolute roots.`,
      'Fix the roots file; nothing was written.',
    );
  const roots: string[] = [];
  for (const root of parsed) {
    if (!absoluteText(root))
      return failure(
        'roots_invalid',
        'Each discovery root must be an absolute path.',
        'Fix the roots file; nothing was written.',
      );
    roots.push(root);
  }
  return { ok: true, value: [...new Set(roots)].sort() };
}

async function discoverByRoots(
  alias: string,
  roots: readonly string[],
): Promise<
  BindingServiceResult<{
    readonly status:
      | 'discovery-unique'
      | 'discovery-ambiguous'
      | 'discovery-incomplete'
      | 'none';
    readonly target: TargetSnapshot | null;
    readonly candidates: readonly string[];
    readonly errors: readonly string[];
  }>
> {
  const errors: string[] = [];
  const candidates: DiscoveredCandidate[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let canonicalRoot: string | null;
    try {
      canonicalRoot = fs.realpathSync(root);
    } catch {
      errors.push('root_unavailable');
      continue;
    }
    let observation: fs.Stats;
    try {
      observation = fs.statSync(canonicalRoot);
    } catch {
      errors.push('root_unavailable');
      continue;
    }
    if (!observation.isDirectory()) {
      errors.push('root_not_directory');
      continue;
    }
    const tasksDir = path.join(canonicalRoot, 'tasks');
    let tasksStats: fs.Stats;
    try {
      tasksStats = fs.lstatSync(tasksDir);
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : null;
      if (code !== null && (code === 'ENOENT' || code === 'ENOTDIR')) continue;
      errors.push('root_unavailable');
      continue;
    }
    if (tasksStats.isSymbolicLink() || !tasksStats.isDirectory()) {
      errors.push('root_tasks_not_regular');
      continue;
    }
    const candidate = path.join(tasksDir, alias, 'task.json');
    let candidateStats: fs.Stats;
    try {
      candidateStats = fs.lstatSync(candidate);
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : null;
      if (code !== null && (code === 'ENOENT' || code === 'ENOTDIR')) continue;
      errors.push('candidate_unreadable');
      continue;
    }
    if (candidateStats.isSymbolicLink() || !candidateStats.isFile()) {
      errors.push('candidate_not_regular');
      continue;
    }
    const inspected = await inspectTarget(candidate);
    if (!inspected.ok) {
      errors.push(
        inspected.code === 'target_missing'
          ? 'candidate_unreadable'
          : 'candidate_invalid',
      );
      continue;
    }
    if (inspected.value.target.protocol_task_id !== alias) {
      errors.push('candidate_task_id_mismatch');
      continue;
    }
    if (
      inspected.value.target.domain_root !== canonicalRoot ||
      inspected.value.target.task_root !== path.join(tasksDir, alias)
    ) {
      errors.push('candidate_identity_mismatch');
      continue;
    }
    if (seen.has(inspected.value.target.record_realpath)) continue;
    seen.add(inspected.value.target.record_realpath);
    candidates.push({
      target: inspected.value,
      candidate: inspected.value.target.record_realpath,
    });
  }
  candidates.sort((left, right) =>
    left.candidate.localeCompare(right.candidate),
  );
  const paths = candidates.map((item) => item.candidate);
  if (errors.length)
    return {
      ok: true,
      value: {
        status: 'discovery-incomplete',
        target: null,
        candidates: paths,
        errors: [...new Set(errors)].sort(),
      },
    };
  if (candidates.length === 1)
    return {
      ok: true,
      value: {
        status: 'discovery-unique',
        target: candidates[0]!.target.target,
        candidates: paths,
        errors: [],
      },
    };
  if (candidates.length > 1)
    return {
      ok: true,
      value: {
        status: 'discovery-ambiguous',
        target: null,
        candidates: paths,
        errors: ['multiple_discovery_candidates'],
      },
    };
  return {
    ok: true,
    value: {
      status: 'none',
      target: null,
      candidates: [],
      errors: [],
    },
  };
}

async function withBindingLock<T>(
  root: string,
  task: () => Promise<BindingServiceResult<T>>,
): Promise<BindingServiceResult<T>> {
  const lockPath = indexLockFile(root);
  const boundary = await ensureStatePathBoundary(root, lockPath);
  if (!boundary.ok)
    return failure(
      'bindings_invalid',
      'The binding lock path is redirected.',
      'Restore .pappra/local as a real directory inside the workspace.',
      [boundary.code],
    );
  let existing: fs.Stats | null = null;
  try {
    existing = fs.lstatSync(lockPath);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : null;
    if (code !== null && code !== 'ENOENT' && code !== 'ENOTDIR')
      return failure(
        'bindings_invalid',
        'The binding lock path could not be inspected.',
        'Inspect .pappra/local; nothing was written.',
      );
  }
  if (existing && !existing.isFile())
    return failure(
      'bindings_invalid',
      'The binding lock path is not a regular file.',
      'Remove or repair the lock explicitly; it was not overwritten.',
    );
  // Reuse the existing workspace private-state lock helper. The install lock
  // schema is intentionally unchanged; the operation label is its existing
  // local-configuration value while this dedicated lock path carries the intent.
  let acquired = await acquireInstallLock(
    lockPath,
    'set-auto-resume',
    indexFile(root),
    root,
  );
  const deadline = Date.now() + 2_000;
  while (
    !acquired.ok &&
    acquired.status === 'locked' &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    acquired = await acquireInstallLock(
      lockPath,
      'set-auto-resume',
      indexFile(root),
      root,
    );
  }
  if (!acquired.ok)
    return failure(
      acquired.status === 'locked' ? 'bindings_locked' : 'bindings_invalid',
      acquired.message ?? 'The binding lock could not be acquired.',
      'Inspect the lock; it is never reclaimed by age.',
    );
  try {
    return await task();
  } finally {
    await releaseInstallLock(lockPath, acquired.lock!.token);
  }
}

async function writeIndex(
  root: string,
  table: BindingTable,
): Promise<BindingServiceResult<null>> {
  const document = tableJson(table);
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
  if (bytes.byteLength > MAX_INDEX_BYTES)
    return failure(
      'bindings_capacity',
      `The collaboration bindings index would exceed its ${MAX_INDEX_BYTES}-byte publication limit.`,
      'Review an explicit bounded index-size plan before retrying; the index was not replaced and no entries were discarded.',
      [`serialized_bytes=${bytes.byteLength}`, `max_bytes=${MAX_INDEX_BYTES}`],
    );
  const written = await writeBytesAtomic(indexFile(root), bytes, root);
  if (!written.ok)
    return failure(
      'bindings_write_failed',
      'The collaboration bindings index could not be written atomically.',
      'Inspect .pappra/local and permissions; the previous index is preserved if it was valid.',
    );
  return { ok: true, value: null };
}

function bindingForTarget(
  alias: string,
  target: TargetIdentity,
  boundAt: string,
): BindingEntry {
  return {
    alias,
    record: target.record,
    record_realpath: target.record_realpath,
    task_root: target.task_root,
    domain_root: target.domain_root,
    protocol_task_id: target.protocol_task_id,
    domain_id: target.domain_id,
    record_created_at: target.record_created_at,
    bound_at: boundAt,
  };
}

export async function bindAlias(
  options: BindingCommandOptions,
): Promise<BindingServiceResult<Record<string, unknown>>> {
  if (!safeAlias(options.taskId))
    return failure(
      'invalid_options',
      '--task-id must be a safe collaboration alias of 128 characters or fewer.',
      'Use a single path segment of letters, digits, dot, dash or underscore.',
    );
  if (
    !absoluteText(options.record) ||
    path.basename(options.record) !== 'task.json'
  )
    return failure(
      'invalid_options',
      '--record must be an absolute <task_root>/task.json path.',
      'Pass the authoritative record path.',
    );
  const recordPath = options.record as string;
  const workspace = await selectWorkspace(options.root);
  if (!workspace.ok) return workspace;
  const initial = await readIndex(
    workspace.value.root,
    workspace.value.workspace_id,
  );
  if (!initial.ok) return initial;
  const target = await inspectTarget(recordPath);
  if (!target.ok) return target;
  const alias = options.taskId;
  const existing = own(initial.value.table.bindings, alias)
    ? initial.value.table.bindings[alias]!
    : null;
  const targetIdentity: TargetIdentity = target.value.target;
  const conflict =
    existing !== null && !bindingMatches(existing, targetIdentity);
  if (conflict)
    return failure(
      'binding_conflict',
      'An existing binding has a different or changed target identity.',
      'Unbind the alias explicitly before binding a replacement.',
    );
  const wouldChange = existing === null || existing.record !== recordPath;

  if (!options.apply)
    return {
      ok: true,
      value: {
        schema: COLLAB_BINDING_RESULT_SCHEMA,
        ok: true,
        status: 'planned',
        action: 'bind',
        applied: false,
        workspace_id: workspace.value.workspace_id,
        workspace_root: workspace.value.root,
        index_path: indexFile(workspace.value.root),
        alias,
        target: targetIdentity,
        would_change: wouldChange,
        limits: ['plan_validates_alias_index_and_target_only', 'no_write'],
      },
    };

  const applied = await withBindingLock<Record<string, unknown>>(
    workspace.value.root,
    async () => {
      const index = await readIndex(
        workspace.value.root,
        workspace.value.workspace_id,
      );
      if (!index.ok) return index;
      const freshTarget = await inspectTarget(recordPath);
      if (!freshTarget.ok) return freshTarget;
      if (!sameTargetIdentity(targetIdentity, freshTarget.value.target))
        return failure(
          'binding_identity_changed',
          'The target immutable identity changed between initial inspection and apply.',
          'Re-inspect the task and explicitly bind the intended incarnation; the index was not written.',
          ['target_identity_changed'],
        );
      const current = own(index.value.table.bindings, alias)
        ? index.value.table.bindings[alias]!
        : null;
      if (current && !bindingMatches(current, freshTarget.value.target))
        return failure(
          'binding_conflict',
          'The target identity changed before the binding could be applied.',
          'Unbind the alias explicitly before binding a replacement.',
        );
      if (current && current.record === recordPath)
        return {
          ok: true,
          value: {
            schema: COLLAB_BINDING_RESULT_SCHEMA,
            ok: true,
            status: 'unchanged',
            action: 'bind',
            applied: false,
            workspace_id: workspace.value.workspace_id,
            workspace_root: workspace.value.root,
            index_path: indexFile(workspace.value.root),
            alias,
            target: freshTarget.value.target,
            limits: ['pointer_unchanged'],
          },
        };
      const table = {
        ...index.value.table,
        bindings: { ...index.value.table.bindings },
        unbound: { ...index.value.table.unbound },
      };
      table.bindings[alias] = bindingForTarget(
        alias,
        freshTarget.value.target,
        new Date().toISOString(),
      );
      delete table.unbound[alias];
      const written = await writeIndex(workspace.value.root, table);
      if (!written.ok) return written;
      return {
        ok: true,
        value: {
          schema: COLLAB_BINDING_RESULT_SCHEMA,
          ok: true,
          status: 'bound',
          action: 'bind',
          applied: true,
          workspace_id: workspace.value.workspace_id,
          workspace_root: workspace.value.root,
          index_path: indexFile(workspace.value.root),
          alias,
          target: freshTarget.value.target,
          limits: ['pointer_metadata_only'],
        },
      };
    },
  );
  return applied;
}

export async function unbindAlias(
  options: BindingCommandOptions,
): Promise<BindingServiceResult<Record<string, unknown>>> {
  if (!safeAlias(options.taskId))
    return failure(
      'invalid_options',
      '--task-id must be a safe collaboration alias of 128 characters or fewer.',
      'Use a single path segment of letters, digits, dot, dash or underscore.',
    );
  const workspace = await selectWorkspace(options.root);
  if (!workspace.ok) return workspace;
  const initial = await readIndex(
    workspace.value.root,
    workspace.value.workspace_id,
  );
  if (!initial.ok) return initial;
  const alias = options.taskId;
  const existing = own(initial.value.table.bindings, alias)
    ? initial.value.table.bindings[alias]!
    : null;
  const already = own(initial.value.table.unbound, alias);

  if (!options.apply)
    return {
      ok: true,
      value: {
        schema: COLLAB_BINDING_RESULT_SCHEMA,
        ok: true,
        status: 'planned',
        action: 'unbind',
        applied: false,
        workspace_id: workspace.value.workspace_id,
        workspace_root: workspace.value.root,
        index_path: indexFile(workspace.value.root),
        alias,
        would_remove: existing !== null,
        would_suppress: existing !== null || !already,
        already_unbound: already,
        limits: ['plan_validates_alias_and_index_only', 'no_write'],
      },
    };

  const applied = await withBindingLock<Record<string, unknown>>(
    workspace.value.root,
    async () => {
      const index = await readIndex(
        workspace.value.root,
        workspace.value.workspace_id,
      );
      if (!index.ok) return index;
      const current = own(index.value.table.bindings, alias)
        ? index.value.table.bindings[alias]!
        : null;
      const alreadyNow = own(index.value.table.unbound, alias);
      if (!current) {
        if (alreadyNow)
          return {
            ok: true,
            value: {
              schema: COLLAB_BINDING_RESULT_SCHEMA,
              ok: true,
              status: 'already-unbound',
              action: 'unbind',
              applied: false,
              workspace_id: workspace.value.workspace_id,
              workspace_root: workspace.value.root,
              index_path: indexFile(workspace.value.root),
              alias,
              limits: ['pointer_unchanged'],
            },
          };
        const table = {
          ...index.value.table,
          bindings: { ...index.value.table.bindings },
          unbound: { ...index.value.table.unbound },
        };
        table.unbound[alias] = {
          alias,
          at: new Date().toISOString(),
          previous: null,
        };
        const written = await writeIndex(workspace.value.root, table);
        if (!written.ok) return written;
        return {
          ok: true,
          value: {
            schema: COLLAB_BINDING_RESULT_SCHEMA,
            ok: true,
            status: 'unbound',
            action: 'unbind',
            applied: true,
            workspace_id: workspace.value.workspace_id,
            workspace_root: workspace.value.root,
            index_path: indexFile(workspace.value.root),
            alias,
            previous: null,
            limits: ['tombstone_only'],
          },
        };
      }
      const table = {
        ...index.value.table,
        bindings: { ...index.value.table.bindings },
        unbound: { ...index.value.table.unbound },
      };
      delete table.bindings[alias];
      table.unbound[alias] = {
        alias,
        at: new Date().toISOString(),
        previous: current,
      };
      const written = await writeIndex(workspace.value.root, table);
      if (!written.ok) return written;
      return {
        ok: true,
        value: {
          schema: COLLAB_BINDING_RESULT_SCHEMA,
          ok: true,
          status: 'unbound',
          action: 'unbind',
          applied: true,
          workspace_id: workspace.value.workspace_id,
          workspace_root: workspace.value.root,
          index_path: indexFile(workspace.value.root),
          alias,
          previous: pinnedIdentity(current),
          limits: ['tombstone_metadata_only'],
        },
      };
    },
  );
  return applied;
}
