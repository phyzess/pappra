import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Diagnostic } from '../schemas/diagnostics.js';
import {
  collaborationCommandSchema,
  collaborationGoalSchema,
  collaborationPreparedSchema,
  type CollaborationCommand,
  type CollaborationEvent,
  type CollaborationGoal,
  type CollaborationPrepared,
} from '../schemas/collaboration.js';
import {
  admitLaunch,
  reserveLaunch,
  settleLaunch,
  type AdmissionOptions,
} from '../collab/admission.js';
import type { Assignment } from '../collab/contracts.js';
import { buildMessage, sha256File } from '../collab/envelope.js';
import { findAttempt } from '../collab/lifecycle.js';
import { submitMessage } from '../collab/messages.js';
import { claimResources, releaseClaim } from '../collab/resources.js';
import { initTask, nowIso, readRecord, taskRootFor } from '../collab/store.js';
import { observePath, resolveRealpath } from '../infra/fs.js';
import { isPathInside, samePath } from '../schemas/paths.js';
import { ensureStatePathBoundary } from '../install/ownership.js';
import { startOwnedPiRpc } from '../hosts/pi/rpc.js';

const MAX_FILE_BYTES = 1024 * 1024;

export type CollaborationFailureStatus =
  'invalid' | 'needs_input' | 'conflict' | 'unsupported' | 'failed';

export interface CollaborationFailure {
  readonly ok: false;
  readonly status: CollaborationFailureStatus;
  readonly code: string;
  readonly message: string;
  readonly nextAction: string | null;
  readonly diagnostics: readonly Diagnostic[];
}

export type CollaborationResult<T> =
  { readonly ok: true; readonly value: T } | CollaborationFailure;

export interface PrepareOptions {
  readonly domainRoot: string;
  readonly clock?: number;
}

export interface PreparedBundle {
  readonly prepared: CollaborationPrepared;
  readonly goal: CollaborationGoal;
  readonly assignment: Assignment;
}

export interface StartOptions {
  readonly capabilitiesFile: string;
  readonly controller: CollaborationController;
  readonly controllerId: string;
  readonly clock?: number;
}

export interface ControllerStartRequest {
  readonly prepared: CollaborationPrepared;
  readonly goal: CollaborationGoal;
  readonly assignment: Assignment;
  readonly capabilitiesFile: string;
  readonly prompt: string;
  readonly promptFile: string;
  readonly taskRoot: string;
  readonly evidenceDir: string;
  readonly namespace?: PrivateNamespace;
}

export interface ControllerObservation {
  readonly status: string;
  readonly detail: string | null;
  readonly data: unknown;
}

export interface ControllerCancel {
  readonly acknowledged: boolean;
  readonly terminal_observed: boolean;
  readonly stop_evidence: unknown;
}

export interface ControllerFinish {
  readonly outcome: string;
  readonly status: string;
  readonly exitCode: number | null;
  readonly sessionId: string | null;
  readonly outputs: readonly unknown[];
  readonly nativeRef: unknown;
  readonly evidenceRef: string | null;
}

export interface ControllerSession {
  query(): Promise<ControllerObservation>;
  cancel(): Promise<ControllerCancel>;
  finish(): Promise<ControllerFinish>;
  dispose?(): Promise<void>;
}

export interface CollaborationController {
  readonly id: string;
  start(
    token: object,
    request: ControllerStartRequest,
  ): Promise<
    | { readonly ok: true; readonly session: ControllerSession }
    | {
        readonly ok: false;
        readonly status: CollaborationFailureStatus;
        readonly code: string;
        readonly message: string;
        readonly nextAction: string | null;
        readonly possible_start?: boolean;
      }
  >;
}

interface LaunchFacts {
  readonly taskRoot: string;
  readonly assignmentDigest: string;
  readonly subtaskId: string;
  readonly attempt: number;
  readonly reservationId: string | null;
  readonly assignee: Assignment['assignee'];
}

const LAUNCH_TOKENS = new WeakMap<object, LaunchFacts>();

function failure(
  status: CollaborationFailureStatus,
  code: string,
  message: string,
  nextAction: string | null = null,
  diagnostics: readonly Diagnostic[] = [],
): CollaborationFailure {
  return { ok: false, status, code, message, nextAction, diagnostics };
}

function boundedJson(value: unknown, maxBytes: number): string | null {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return null;
  }
  return Buffer.byteLength(encoded) <= maxBytes ? encoded : null;
}

function readBoundedFile(file: string, maxBytes = MAX_FILE_BYTES): string {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > maxBytes) {
    throw new Error(`unsupported file: ${file}`);
  }
  return fs.readFileSync(file, 'utf8');
}

function readJsonFile(file: string): unknown {
  return JSON.parse(readBoundedFile(file)) as unknown;
}

interface NamespaceIdentity {
  readonly path: string;
  readonly canonical: string;
  readonly dev: number;
  readonly ino: number;
}

export interface PrivateNamespace {
  readonly domain: NamespaceIdentity;
  readonly taskRoot: NamespaceIdentity;
  readonly privateDir: NamespaceIdentity;
}

type NamespaceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: CollaborationFailure };

function namespaceFailure(
  code: string,
  message: string,
  nextAction: string,
): NamespaceResult<never> {
  return { ok: false, failure: failure('conflict', code, message, nextAction) };
}

async function directoryIdentity(
  target: string,
  code: string,
  label: string,
): Promise<NamespaceResult<NamespaceIdentity>> {
  const observed = await observePath(target);
  if (observed.kind !== 'directory' || observed.stats === null) {
    return namespaceFailure(
      code,
      `${label} is not a directory: ${target}`,
      'Inspect or remove the redirected path; no metadata was adopted.',
    );
  }
  const canonical = await resolveRealpath(target);
  if (canonical === null || !samePath(canonical, target)) {
    return namespaceFailure(
      code,
      `${label} is redirected or not canonical: ${target}`,
      'Inspect or remove the symlink explicitly; no metadata was written.',
    );
  }
  return {
    ok: true,
    value: {
      path: target,
      canonical,
      dev: observed.stats.dev,
      ino: observed.stats.ino,
    },
  };
}

async function identityStillCurrent(
  identity: NamespaceIdentity,
): Promise<boolean> {
  const observed = await observePath(identity.path);
  if (observed.kind !== 'directory' || observed.stats === null) return false;
  if (
    observed.stats.dev !== identity.dev ||
    observed.stats.ino !== identity.ino
  ) {
    return false;
  }
  const canonical = await resolveRealpath(identity.path);
  return canonical !== null && samePath(canonical, identity.path);
}

async function namespaceStillCurrent(
  namespace: PrivateNamespace,
): Promise<CollaborationFailure | null> {
  for (const [label, identity] of [
    ['domain', namespace.domain],
    ['task', namespace.taskRoot],
    ['private', namespace.privateDir],
  ] as const) {
    if (!(await identityStillCurrent(identity))) {
      return failure(
        'conflict',
        'private_namespace_redirected',
        `The ${label} namespace changed during preparation or admission.`,
        'Inspect the redirected path and reconcile the task record before retrying.',
      );
    }
  }
  return null;
}

function namespaceSyncFailure(namespace: PrivateNamespace): string | null {
  for (const [label, identity] of [
    ['domain', namespace.domain],
    ['task', namespace.taskRoot],
    ['private', namespace.privateDir],
  ] as const) {
    try {
      const observed = fs.lstatSync(identity.path);
      if (
        !observed.isDirectory() ||
        observed.dev !== identity.dev ||
        observed.ino !== identity.ino
      ) {
        return `${label} namespace identity changed`;
      }
      const canonical = fs.realpathSync(identity.path);
      if (!samePath(canonical, identity.path)) {
        return `${label} namespace is redirected`;
      }
    } catch {
      return `${label} namespace is unavailable`;
    }
  }
  return null;
}

async function capturePreparedNamespace(
  preparedFile: string,
): Promise<NamespaceResult<PrivateNamespace>> {
  const privateDir = path.dirname(preparedFile);
  const taskRoot = path.dirname(privateDir);
  const tasksDir = path.dirname(taskRoot);
  const domainRoot = path.dirname(tasksDir);
  const domain = await directoryIdentity(
    domainRoot,
    'prepared_namespace_redirected',
    'Domain root',
  );
  if (!domain.ok) return domain;
  const task = await directoryIdentity(
    taskRoot,
    'prepared_namespace_redirected',
    'Task root',
  );
  if (!task.ok) return task;
  const privateIdentity = await directoryIdentity(
    privateDir,
    'prepared_namespace_redirected',
    'Prepared private directory',
  );
  if (!privateIdentity.ok) return privateIdentity;
  return {
    ok: true,
    value: {
      domain: domain.value,
      taskRoot: task.value,
      privateDir: privateIdentity.value,
    },
  };
}

async function initialNamespace(
  domainRoot: string,
  taskRoot: string,
): Promise<
  NamespaceResult<{
    readonly domain: NamespaceIdentity;
    readonly taskRoot: NamespaceIdentity | null;
  }>
> {
  const domain = await directoryIdentity(
    domainRoot,
    'domain_namespace_redirected',
    'Domain root',
  );
  if (!domain.ok) return domain;
  if (
    !samePath(path.dirname(taskRoot), path.join(domain.value.path, 'tasks'))
  ) {
    return namespaceFailure(
      'task_namespace_redirected',
      `Task root is not a direct child of the private domain: ${taskRoot}`,
      'Use the task root derived from the explicit shared domain.',
    );
  }
  const boundary = await ensureStatePathBoundary(domain.value.path, taskRoot);
  if (!boundary.ok) {
    return namespaceFailure(
      boundary.code,
      boundary.message,
      boundary.nextAction ?? 'Inspect the private task path.',
    );
  }
  const observed = await observePath(taskRoot);
  if (
    observed.kind === 'symlink' ||
    observed.kind === 'file' ||
    observed.kind === 'other'
  ) {
    return namespaceFailure(
      'task_namespace_redirected',
      `Task root is not a real directory: ${taskRoot}`,
      'Inspect or remove the redirected task path; no task metadata was written.',
    );
  }
  if (observed.kind === 'missing') {
    return { ok: true, value: { domain: domain.value, taskRoot: null } };
  }
  const task = await directoryIdentity(
    taskRoot,
    'task_namespace_redirected',
    'Task root',
  );
  if (!task.ok) return task;
  return { ok: true, value: { domain: domain.value, taskRoot: task.value } };
}

async function preparePrivateNamespace(
  domainRoot: string,
  taskRoot: string,
  privateDir: string,
): Promise<NamespaceResult<PrivateNamespace>> {
  const domain = await directoryIdentity(
    domainRoot,
    'domain_namespace_redirected',
    'Domain root',
  );
  if (!domain.ok) return domain;
  const task = await directoryIdentity(
    taskRoot,
    'task_namespace_redirected',
    'Task root',
  );
  if (!task.ok) return task;
  const boundary = await ensureStatePathBoundary(taskRoot, privateDir);
  if (!boundary.ok) {
    return namespaceFailure(
      boundary.code,
      boundary.message,
      boundary.nextAction ?? 'Inspect the private task path.',
    );
  }
  const observed = await observePath(privateDir);
  if (
    observed.kind === 'symlink' ||
    observed.kind === 'file' ||
    observed.kind === 'other'
  ) {
    return namespaceFailure(
      'private_namespace_redirected',
      `Prepared private directory is not a directory: ${privateDir}`,
      'Inspect or remove the redirected path; no task artifacts were adopted.',
    );
  }
  if (observed.kind === 'missing') {
    try {
      fs.mkdirSync(privateDir, { mode: 0o700 });
    } catch (error) {
      return {
        ok: false,
        failure: failure(
          'failed',
          'private_directory_create_failed',
          error instanceof Error ? error.message : String(error),
          'Inspect the task root before retrying.',
        ),
      };
    }
  }
  const privateIdentity = await directoryIdentity(
    privateDir,
    'private_namespace_redirected',
    'Prepared private directory',
  );
  if (!privateIdentity.ok) return privateIdentity;
  return {
    ok: true,
    value: {
      domain: domain.value,
      taskRoot: task.value,
      privateDir: privateIdentity.value,
    },
  };
}

function preparedFilePathFailure(
  preparedFile: string,
): CollaborationFailure | null {
  const privateDir = path.dirname(preparedFile);
  const taskRoot = path.dirname(privateDir);
  const tasksDir = path.dirname(taskRoot);
  const domainRoot = path.dirname(tasksDir);
  if (
    path.basename(privateDir) !== 'p10' ||
    path.basename(tasksDir) !== 'tasks' ||
    path.basename(preparedFile) !== 'prepared.json'
  ) {
    return failure(
      'conflict',
      'prepared_namespace_unrecognized',
      'Prepared file is not inside the private task namespace.',
      'Use a prepared file published under an explicit domain/tasks/<task>/p10 directory.',
    );
  }
  for (const [target, label] of [
    [domainRoot, 'domain'],
    [tasksDir, 'tasks'],
    [taskRoot, 'task'],
    [privateDir, 'private'],
  ] as const) {
    let observed: fs.Stats;
    let canonical: string;
    try {
      observed = fs.lstatSync(target);
      canonical = fs.realpathSync(target);
    } catch {
      return failure(
        'conflict',
        'prepared_namespace_missing',
        `Prepared ${label} namespace is unavailable: ${target}`,
        'Inspect the prepared task path before retrying.',
      );
    }
    if (!observed.isDirectory() || !samePath(canonical, target)) {
      return failure(
        'conflict',
        'prepared_namespace_redirected',
        `Prepared ${label} namespace is redirected: ${target}`,
        'Inspect or remove the symlink explicitly; no artifacts were read.',
      );
    }
  }
  return null;
}

async function writeInNamespace(
  namespace: PrivateNamespace,
  file: string,
  bytes: string,
): Promise<CollaborationFailure | null> {
  const before = await namespaceStillCurrent(namespace);
  if (before !== null) return before;
  try {
    writeOrVerify(file, bytes);
  } catch (error) {
    return failure(
      'failed',
      'prepared_write_failed',
      error instanceof Error ? error.message : String(error),
      'Inspect the private task directory and residual files.',
    );
  }
  return namespaceStillCurrent(namespace);
}

type PublishEvidenceResult =
  | { readonly ok: true; readonly ref: string; readonly digest: string }
  | { readonly ok: false; readonly error: string };

function publishCurrentResult(
  namespace: PrivateNamespace,
  file: string,
  bytes: string,
): PublishEvidenceResult {
  const before = namespaceSyncFailure(namespace);
  if (before !== null) return { ok: false, error: before };
  if (!isPathInside(namespace.privateDir.path, file)) {
    return {
      ok: false,
      error: 'current-result evidence target is outside the private namespace',
    };
  }
  try {
    const existing = fs.lstatSync(file, { throwIfNoEntry: false });
    if (existing) {
      if (!existing.isFile() || existing.size > MAX_FILE_BYTES * 2) {
        return {
          ok: false,
          error: 'current-result evidence target is not an owned regular file',
        };
      }
      const beforeRead = namespaceSyncFailure(namespace);
      if (beforeRead !== null) return { ok: false, error: beforeRead };
      const content = fs.readFileSync(file);
      if (!content.equals(Buffer.from(bytes))) {
        return {
          ok: false,
          error: 'current-result evidence target has different content',
        };
      }
    } else {
      fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    }
    const afterWrite = namespaceSyncFailure(namespace);
    if (afterWrite !== null) return { ok: false, error: afterWrite };
    const after = fs.lstatSync(file);
    if (!after.isFile()) {
      return {
        ok: false,
        error: 'current-result evidence publication could not be verified',
      };
    }
    const beforeVerifyRead = namespaceSyncFailure(namespace);
    if (beforeVerifyRead !== null) {
      return { ok: false, error: beforeVerifyRead };
    }
    if (fs.readFileSync(file).length !== Buffer.byteLength(bytes)) {
      return {
        ok: false,
        error: 'current-result evidence publication could not be verified',
      };
    }
    const namespaceProblem = namespaceSyncFailure(namespace);
    if (namespaceProblem !== null) {
      return { ok: false, error: namespaceProblem };
    }
    return { ok: true, ref: file, digest: sha256File(file) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

interface NativeCurrentResult {
  readonly records: readonly unknown[];
  readonly status: 'completed' | 'failed' | 'cancelled' | 'unknown';
  readonly reason: string | null;
}

interface AssistantRecord {
  readonly text: boolean;
  readonly tool: boolean;
  readonly error: boolean;
  readonly aborted: boolean;
  readonly terminal: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function assistantRecord(record: unknown): AssistantRecord | null {
  if (!isRecord(record)) return null;
  const nested = isRecord(record['message']) ? record['message'] : record;
  if (nested['role'] !== 'assistant') return null;
  const stopReason =
    typeof nested['stopReason'] === 'string'
      ? nested['stopReason'].toLowerCase()
      : '';
  const errorMessage =
    typeof nested['errorMessage'] === 'string' ? nested['errorMessage'] : '';
  const content = nested['content'];
  let text = false;
  let tool = false;
  if (typeof content === 'string') text = content.trim() !== '';
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (!isRecord(part)) continue;
      const type = typeof part['type'] === 'string' ? part['type'] : '';
      if (
        type === 'text' &&
        typeof part['text'] === 'string' &&
        part['text'].trim() !== ''
      ) {
        text = true;
      }
      if (type.includes('tool')) tool = true;
    }
  }
  const terminal =
    stopReason === 'stop' ||
    stopReason === 'end_turn' ||
    stopReason === 'completed' ||
    stopReason === 'complete' ||
    stopReason === 'success' ||
    stopReason === 'finish' ||
    stopReason === 'finished';
  return {
    text,
    tool,
    terminal,
    error:
      errorMessage.trim() !== '' ||
      stopReason.includes('error') ||
      stopReason.includes('failed'),
    aborted:
      stopReason.includes('abort') ||
      stopReason.includes('cancel') ||
      stopReason.includes('interrupt'),
  };
}

function currentNativeResult(
  file: string | null,
  baseline: number | null,
): NativeCurrentResult | null {
  if (
    file === null ||
    baseline === null ||
    !path.isAbsolute(file) ||
    !Number.isSafeInteger(baseline) ||
    baseline < 0
  ) {
    return null;
  }
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size < baseline) return null;
    const available = stat.size - baseline;
    const length = Math.min(available, MAX_FILE_BYTES);
    const truncated = available > length;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, baseline);
    } finally {
      fs.closeSync(fd);
    }
    const text = buffer.toString('utf8');
    // The captured baseline is always the byte length of a previously complete
    // session file, so every byte after it belongs to the current prompt. A
    // malformed line is reported as invalid current evidence, never skipped as
    // if it were part of an older record.
    const lines = text.split('\n');
    const records: unknown[] = [];
    let invalid = false;
    for (const line of lines) {
      if (line.trim() === '') continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isRecord(parsed)) {
          invalid = true;
          continue;
        }
        records.push(parsed);
      } catch {
        invalid = true;
      }
    }
    if (truncated) {
      return {
        records,
        status: 'unknown',
        reason: 'current_result_truncated',
      };
    }
    if (invalid) {
      return {
        records,
        status: 'unknown',
        reason: 'current_result_invalid',
      };
    }
    const assistant = records
      .map((record) => assistantRecord(record))
      .filter((record): record is AssistantRecord => record !== null);
    if (assistant.length === 0) {
      return {
        records,
        status: 'unknown',
        reason: 'no_current_assistant_message',
      };
    }
    const last = assistant[assistant.length - 1]!;
    if (last.error) {
      return {
        records,
        status: 'failed',
        reason: 'current_assistant_error',
      };
    }
    if (last.aborted) {
      return {
        records,
        status: 'cancelled',
        reason: 'current_assistant_aborted',
      };
    }
    if (!last.terminal || last.tool) {
      return {
        records,
        status: 'unknown',
        reason: last.tool
          ? 'current_assistant_tool_intermediate'
          : 'current_assistant_incomplete_terminal',
      };
    }
    if (last.text) {
      return { records, status: 'completed', reason: null };
    }
    return {
      records,
      status: 'unknown',
      reason: 'current_assistant_incomplete',
    };
  } catch {
    return null;
  }
}

function regularFileSize(file: string | null): number | null {
  if (file === null || !path.isAbsolute(file)) return null;
  try {
    const observed = fs.lstatSync(file);
    return observed.isFile() ? observed.size : null;
  } catch {
    return null;
  }
}

function writeNewFile(file: string, bytes: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
}

function writeOrVerify(file: string, bytes: string): void {
  try {
    writeNewFile(file, bytes);
  } catch (error) {
    if (
      !(typeof error === 'object' && error !== null && 'code' in error) ||
      error.code !== 'EEXIST' ||
      !fs.lstatSync(file).isFile() ||
      fs.readFileSync(file, 'utf8') !== bytes
    ) {
      throw error;
    }
  }
}

function prepDir(taskRoot: string): string {
  return path.join(taskRoot, 'p10');
}

function createToken(facts: LaunchFacts): object {
  const token = Object.freeze({});
  LAUNCH_TOKENS.set(token, facts);
  return token;
}

export function validateLaunchToken(
  token: unknown,
  expected: {
    readonly taskRoot: string;
    readonly assignmentDigest: string;
    readonly subtaskId: string;
    readonly attempt: number;
  },
): boolean {
  if (token === null || typeof token !== 'object') return false;
  const facts = LAUNCH_TOKENS.get(token);
  return (
    facts !== undefined &&
    facts.taskRoot === expected.taskRoot &&
    facts.assignmentDigest === expected.assignmentDigest &&
    facts.subtaskId === expected.subtaskId &&
    facts.attempt === expected.attempt
  );
}

function consumeToken(
  token: unknown,
  expected: {
    readonly taskRoot: string;
    readonly assignmentDigest: string;
    readonly subtaskId: string;
    readonly attempt: number;
  },
): LaunchFacts {
  if (!validateLaunchToken(token, expected)) {
    throw new Error('genuine admission token required');
  }
  const facts = LAUNCH_TOKENS.get(token as object);
  if (!facts) throw new Error('genuine admission token required');
  LAUNCH_TOKENS.delete(token as object);
  return facts;
}

function preparedBundle(
  preparedFile: string,
): CollaborationResult<PreparedBundle> {
  try {
    const namespaceProblem = preparedFilePathFailure(preparedFile);
    if (namespaceProblem !== null) return namespaceProblem;
    const prepared = collaborationPreparedSchema.parse(
      readJsonFile(preparedFile),
    );
    const preparedDir = path.dirname(preparedFile);
    if (prepared.prepared_dir !== preparedDir) {
      return failure(
        'conflict',
        'prepared_dir_mismatch',
        'Prepared directory does not match its published location.',
      );
    }
    for (const artifact of [
      prepared.assignment_path,
      prepared.prompt_path,
      prepared.goal_path,
    ]) {
      if (
        path.dirname(artifact) !== preparedDir ||
        !fs.lstatSync(artifact).isFile()
      ) {
        return failure(
          'conflict',
          'prepared_artifact_redirected',
          'Prepared artifacts must be regular files inside the private directory.',
        );
      }
    }
    if (sha256File(prepared.assignment_path) !== prepared.assignment_digest) {
      return failure(
        'conflict',
        'assignment_digest_mismatch',
        'Prepared assignment digest no longer matches.',
      );
    }
    if (sha256File(prepared.prompt_path) !== prepared.prompt_digest) {
      return failure(
        'conflict',
        'prompt_digest_mismatch',
        'Prepared prompt digest no longer matches.',
      );
    }
    const goal = collaborationGoalSchema.parse(
      readJsonFile(prepared.goal_path),
    );
    if (
      goal.task_id !== prepared.task_id ||
      goal.subtask_id !== prepared.subtask_id
    ) {
      return failure(
        'conflict',
        'prepared_identity_mismatch',
        'Prepared identity is inconsistent.',
      );
    }
    const assignment = readJsonFile(prepared.assignment_path) as Assignment;
    return { ok: true, value: { prepared, goal, assignment } };
  } catch (error) {
    return failure(
      'invalid',
      'prepared_invalid',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function prepareCollaboration(
  input: unknown,
  options: PrepareOptions,
): Promise<CollaborationResult<PreparedBundle>> {
  let goal: CollaborationGoal;
  const clock = options.clock ?? Date.now();
  try {
    goal = collaborationGoalSchema.parse(input);
  } catch (error) {
    return failure(
      'invalid',
      'goal_invalid',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!path.isAbsolute(options.domainRoot)) {
    return failure(
      'invalid',
      'domain_root_required',
      'Domain root must be absolute.',
    );
  }
  if (!fs.existsSync(goal.assignee.cwd)) {
    return failure(
      'needs_input',
      'cwd_unavailable',
      'Assignee cwd does not exist.',
    );
  }
  let taskRoot: string;
  let domainRoot: string;
  try {
    taskRoot = taskRootFor(options.domainRoot, goal.task_id);
    domainRoot = fs.realpathSync(options.domainRoot);
  } catch (error) {
    return failure(
      'failed',
      'task_init_failed',
      error instanceof Error ? error.message : String(error),
    );
  }
  const initial = await initialNamespace(domainRoot, taskRoot);
  if (!initial.ok) return initial.failure;
  try {
    initTask(taskRoot, {
      taskId: goal.task_id,
      coordinator: {
        agent_id: goal.coordinator.agent_id,
        session_id: goal.coordinator.session_id,
        harness: goal.coordinator.harness,
        owner_epoch: goal.coordinator.owner_epoch,
        since: nowIso(clock),
        previous: null,
      },
      domainRoot,
      clock: clock,
    });
  } catch (error) {
    return failure(
      'failed',
      'task_init_failed',
      error instanceof Error ? error.message : String(error),
    );
  }
  const taskIdentity = await directoryIdentity(
    taskRoot,
    'task_namespace_redirected',
    'Task root',
  );
  if (!taskIdentity.ok) return taskIdentity.failure;
  const preparedDir = prepDir(taskRoot);
  const privateNamespace = await preparePrivateNamespace(
    domainRoot,
    taskRoot,
    preparedDir,
  );
  if (!privateNamespace.ok) return privateNamespace.failure;
  const namespace = privateNamespace.value;
  const existingPrepared = path.join(preparedDir, 'prepared.json');
  if (fs.existsSync(existingPrepared)) {
    const existing = preparedBundle(existingPrepared);
    if (!existing.ok) return existing;
    if (JSON.stringify(existing.value.goal) !== JSON.stringify(goal)) {
      return failure(
        'conflict',
        'goal_changed',
        'The task already has a prepared goal with different content.',
      );
    }
    return existing;
  }
  const claimIds: string[] = [];
  const resourceEpochs: Record<string, number> = {};
  for (const resource of goal.resources) {
    const claimed = await claimResources(taskRoot, {
      resources: [{ kind: 'path', path: resource.path }],
      access: resource.access,
      holder: {
        agent_id: goal.assignee.agent_id,
        session_id: goal.assignee.session_id,
        harness: goal.assignee.harness,
      },
      subtaskId: goal.subtask_id,
      attempt: goal.attempt,
      clock,
    });
    if (!claimed.ok) {
      for (const claimId of claimIds) {
        releaseClaim(taskRoot, {
          claimId,
          reason: 'prepare resource claim failed',
        });
      }
      return failure(
        claimed.reason === 'resource_conflict' ? 'conflict' : 'failed',
        claimed.reason,
        'Required resources could not be claimed.',
      );
    }
    const requested =
      claimed.claims.find((claim) => claim.path === resource.path) ??
      claimed.claims[0];
    if (requested === undefined) {
      for (const claimId of claimIds) {
        releaseClaim(taskRoot, {
          claimId,
          reason: 'prepare resource epoch missing',
        });
      }
      return failure(
        'failed',
        'resource_epoch_missing',
        'No resource epoch was returned.',
      );
    }
    claimIds.push(...claimed.claims.map((claim) => claim.claim_id));
    resourceEpochs[resource.path] = requested.resource_epoch;
  }
  const goalBytes = `${JSON.stringify(goal, null, 2)}\n`;
  const promptBytes = `${goal.prompt}\n`;
  const goalFile = path.join(preparedDir, 'goal.json');
  const promptFile = path.join(preparedDir, 'prompt.txt');
  const goalProblem = await writeInNamespace(namespace, goalFile, goalBytes);
  if (goalProblem !== null) {
    if (goalProblem.code === 'prepared_write_failed') {
      for (const claimId of claimIds) {
        releaseClaim(taskRoot, {
          claimId,
          reason: 'prepare failed before assignment',
        });
      }
    }
    return goalProblem;
  }
  const promptProblem = await writeInNamespace(
    namespace,
    promptFile,
    promptBytes,
  );
  if (promptProblem !== null) {
    if (promptProblem.code === 'prepared_write_failed') {
      for (const claimId of claimIds) {
        releaseClaim(taskRoot, {
          claimId,
          reason: 'prepare failed before assignment',
        });
      }
    }
    return promptProblem;
  }
  const promptDigest = sha256File(promptFile);
  const goalDigest = sha256File(goalFile);
  const assignment: Assignment = {
    schema: 'harness-collab/assignment/1',
    task_id: goal.task_id,
    assignment_id: goal.subtask_id,
    attempt: goal.attempt,
    objective: goal.objective,
    acceptance: goal.acceptance,
    roles: ['implementer'],
    coordinator: {
      agent_id: goal.coordinator.agent_id,
      session_id: goal.coordinator.session_id,
      harness: goal.coordinator.harness,
      owner_epoch: goal.coordinator.owner_epoch,
    },
    assignee: {
      agent_id: goal.assignee.agent_id,
      session_id: goal.assignee.session_id,
      harness: goal.assignee.harness,
      surface: goal.assignee.surface,
      cwd: goal.assignee.cwd,
      configuration_id: goal.assignee.configuration_id,
    },
    inputs: [
      { ref: promptFile, digest: promptDigest },
      { ref: goalFile, digest: goalDigest },
    ],
    resources: goal.resources.map((item) => ({
      path: item.path,
      access: item.access,
      resource_epoch: resourceEpochs[item.path]!,
    })),
    runner: {
      name: 'pi-cli',
      mode: 'native',
      omitted_capabilities: [],
    },
    required: goal.required,
    preferred: goal.preferred,
    phase: goal.phase,
  };
  const assignmentFile = path.join(preparedDir, 'assignment.json');
  const assignmentBytes = `${JSON.stringify(assignment, null, 2)}\n`;
  const assignmentProblem = await writeInNamespace(
    namespace,
    assignmentFile,
    assignmentBytes,
  );
  if (assignmentProblem !== null) {
    if (assignmentProblem.code === 'prepared_write_failed') {
      for (const claimId of claimIds) {
        releaseClaim(taskRoot, {
          claimId,
          reason: 'prepare failed before assignment',
        });
      }
    }
    return assignmentProblem;
  }
  const beforeAssignment = await namespaceStillCurrent(namespace);
  if (beforeAssignment !== null) return beforeAssignment;
  const assignmentDigest = sha256File(assignmentFile);
  const assignmentMessage = buildMessage(
    {
      type: 'ASSIGN',
      task_id: goal.task_id,
      from: {
        agent_id: goal.coordinator.agent_id,
        session_id: goal.coordinator.session_id,
        harness: goal.coordinator.harness,
      },
      to: {
        agent_id: goal.assignee.agent_id,
        session_id: goal.assignee.session_id,
        harness: goal.assignee.harness,
      },
      subtask_id: goal.subtask_id,
      attempt: goal.attempt,
      owner_epoch: goal.coordinator.owner_epoch,
      body: {
        assignment_ref: assignmentFile,
        assignment_digest: assignmentDigest,
        input_revision: promptDigest,
      },
    },
    { clock: clock },
  );
  const submitted = submitMessage(taskRoot, assignmentMessage, {
    clock: clock,
  });
  if (!submitted.ok) {
    for (const claimId of claimIds) {
      releaseClaim(taskRoot, {
        claimId,
        reason: 'assignment registration failed',
      });
    }
    return failure(
      'failed',
      submitted.reason,
      'Assignment could not be registered.',
    );
  }
  const afterAssignment = await namespaceStillCurrent(namespace);
  if (afterAssignment !== null) {
    return failure(
      'conflict',
      'assignment_registered_namespace_changed',
      `${afterAssignment.message}; assignment is registered and claims remain held`,
      'Inspect the private task path and task/claim state before reconciliation.',
    );
  }
  const record = readRecord(taskRoot);
  const prepared: CollaborationPrepared = {
    schema: 'pappra/collaboration-prepared/1',
    task_id: goal.task_id,
    subtask_id: goal.subtask_id,
    attempt: goal.attempt,
    phase: goal.phase,
    task_root: taskRoot,
    domain_root: fs.realpathSync(options.domainRoot),
    prepared_dir: preparedDir,
    assignment_path: assignmentFile,
    prompt_path: promptFile,
    goal_path: goalFile,
    assignment_digest: assignmentDigest,
    prompt_digest: promptDigest,
    resource_epochs: Object.fromEntries(
      goal.resources.map((item) => [item.path, resourceEpochs[item.path]!]),
    ),
    claim_ids: claimIds,
    state_revision: record?.state_revision ?? submitted.state_revision ?? 0,
    created_at: nowIso(clock),
  };
  const preparedFile = path.join(preparedDir, 'prepared.json');
  const publicationProblem = await writeInNamespace(
    namespace,
    preparedFile,
    `${JSON.stringify(prepared, null, 2)}\n`,
  );
  if (publicationProblem !== null) {
    return failure(
      publicationProblem.status,
      publicationProblem.code === 'private_namespace_redirected'
        ? 'assignment_registered_namespace_changed'
        : 'prepared_publication_failed',
      `${publicationProblem.message}; assignment is registered and claims remain held; prepared residual: ${preparedFile}`,
      'Inspect the prepared residual and task/claim state before reconciliation.',
    );
  }
  return {
    ok: true,
    value: { prepared, goal, assignment },
  };
}

export interface AdmissionResult {
  readonly prepared: CollaborationPrepared;
  readonly goal: CollaborationGoal;
  readonly assignment: Assignment;
  readonly admission: Awaited<ReturnType<typeof admitLaunch>>;
  readonly token: object;
}

export async function admitPrepared(
  preparedFile: string,
  capabilitiesFile: string,
  options: { readonly clock?: number } = {},
): Promise<CollaborationResult<AdmissionResult>> {
  const bundle = preparedBundle(preparedFile);
  if (!bundle.ok) return bundle;
  const { prepared, goal, assignment } = bundle.value;
  const card = (() => {
    try {
      return JSON.parse(fs.readFileSync(capabilitiesFile, 'utf8')) as unknown;
    } catch (error) {
      return error;
    }
  })();
  if (card instanceof Error) {
    return failure('invalid', 'capabilities_invalid', card.message);
  }
  const admissionOptions: AdmissionOptions = {
    assignmentFile: prepared.assignment_path,
    capabilitiesFile,
    taskRoot: prepared.task_root,
    cwd: goal.assignee.cwd,
    sessionId: goal.assignee.session_id,
    harness: goal.assignee.harness,
    launchKind: 'first',
    now: options.clock ?? Date.now(),
  };
  const admission = admitLaunch(admissionOptions);
  if (!admission.ok) {
    return failure(
      admission.reason === 'resource_conflict' ? 'conflict' : 'needs_input',
      admission.reason,
      'Launch admission refused.',
      'Inspect admission checks and supply fresh capability evidence.',
    );
  }
  const token = createToken({
    taskRoot: prepared.task_root,
    assignmentDigest: prepared.assignment_digest,
    subtaskId: prepared.subtask_id,
    attempt: prepared.attempt,
    reservationId: null,
    assignee: assignment.assignee,
  });
  return {
    ok: true,
    value: { prepared, goal, assignment, admission, token },
  };
}

export interface StartedRun {
  readonly prepared: CollaborationPrepared;
  readonly goal: CollaborationGoal;
  readonly assignment: Assignment;
  readonly token: object;
  readonly controller: CollaborationController;
  readonly session: ControllerSession;
  readonly reservationId: string | null;
}

export async function startPrepared(
  preparedFile: string,
  options: StartOptions,
): Promise<CollaborationResult<StartedRun>> {
  const clock = options.clock ?? Date.now();
  const admitted = await admitPrepared(preparedFile, options.capabilitiesFile, {
    clock,
  });
  if (!admitted.ok) return admitted;
  const { prepared, goal, assignment } = admitted.value;
  const namespaceProblem = preparedFilePathFailure(preparedFile);
  if (namespaceProblem !== null) return namespaceProblem;
  const captured = await capturePreparedNamespace(preparedFile);
  if (!captured.ok) return captured.failure;
  let token = admitted.value.token;
  let reservationId: string | null = null;
  if (options.controllerId === 'fixture') {
    const reservation = reserveLaunch(prepared.task_root, {
      expectRevision: prepared.state_revision,
      clock,
      reservation: {
        reservation_id: `p10-${crypto.randomUUID()}`,
        subtask_id: prepared.subtask_id,
        attempt: prepared.attempt,
        kind: 'first',
        mode: 'work',
        phase: prepared.phase,
        holder: assignment.assignee,
        pid: process.pid,
        requested_session_id: assignment.assignee.session_id,
        transport: 'fixture',
      },
    });
    if (!reservation.ok) {
      return failure(
        reservation.reason === 'launch_already_reserved'
          ? 'conflict'
          : 'needs_input',
        reservation.reason,
        'Only one dispatch may reserve this attempt.',
      );
    }
    reservationId = reservation.reservation_id;
    const reservedToken = createToken({
      taskRoot: prepared.task_root,
      assignmentDigest: prepared.assignment_digest,
      subtaskId: prepared.subtask_id,
      attempt: prepared.attempt,
      reservationId,
      assignee: assignment.assignee,
    });
    LAUNCH_TOKENS.delete(token);
    token = reservedToken;
  }
  const promptNamespaceProblem = preparedFilePathFailure(preparedFile);
  if (promptNamespaceProblem !== null) {
    return promptNamespaceProblem;
  }
  let prompt: string;
  try {
    prompt = readBoundedFile(prepared.prompt_path, 64 * 1024);
  } catch (error) {
    if (reservationId !== null) {
      settleLaunch(prepared.task_root, {
        reservationId,
        outcome: 'not_started',
        detail: 'prepared prompt unavailable',
      });
    }
    return failure(
      'invalid',
      'prepared_prompt_invalid',
      error instanceof Error ? error.message : String(error),
    );
  }
  const request: ControllerStartRequest = {
    prepared,
    goal,
    assignment,
    capabilitiesFile: options.capabilitiesFile,
    prompt,
    promptFile: prepared.prompt_path,
    taskRoot: prepared.task_root,
    evidenceDir: path.join(prepared.task_root, 'p10', 'evidence'),
    namespace: captured.value,
  };
  let started: Awaited<ReturnType<CollaborationController['start']>>;
  try {
    started = await options.controller.start(token, request);
  } catch (error) {
    started = {
      ok: false,
      status: 'failed',
      code: 'controller_start_failed',
      message: error instanceof Error ? error.message : String(error),
      nextAction: 'Inspect the controller and native process state.',
      possible_start: true,
    };
  }
  if (!started.ok) {
    if (reservationId !== null) {
      settleLaunch(prepared.task_root, {
        reservationId,
        outcome:
          started.possible_start === true ? 'spawn_failed' : 'not_started',
        detail: started.message,
      });
    }
    return failure(
      started.status,
      started.code,
      started.message,
      started.nextAction,
    );
  }
  return {
    ok: true,
    value: {
      prepared,
      goal,
      assignment,
      token,
      controller: options.controller,
      session: started.session,
      reservationId,
    },
  };
}

export interface ReportResult {
  readonly ok: boolean;
  readonly messageId: string;
  readonly duplicate: boolean;
  readonly classification: string | null;
  readonly detail: string | null;
}

export function submitResultReport(
  started: StartedRun,
  finish: ControllerFinish,
  { clock = Date.now() }: { clock?: number } = {},
): ReportResult {
  const messageId = `report-${started.prepared.task_id}-${started.prepared.subtask_id}-${started.prepared.attempt}`;
  const outputs = finish.outputs.slice(0, 32);
  const body = {
    status: finish.status,
    outputs,
    native_ref: finish.nativeRef,
    evidence_ref: finish.evidenceRef,
  };
  if (boundedJson(body, 64 * 1024) === null) {
    return {
      ok: false,
      messageId,
      duplicate: false,
      classification: null,
      detail: 'result exceeds the bounded report size',
    };
  }
  const message = buildMessage(
    {
      type: 'REPORT',
      message_id: messageId,
      task_id: started.prepared.task_id,
      from: {
        agent_id: started.assignment.assignee.agent_id,
        session_id: started.assignment.assignee.session_id,
        harness: started.assignment.assignee.harness,
      },
      to: {
        agent_id: started.goal.coordinator.agent_id,
        session_id: started.goal.coordinator.session_id,
        harness: started.goal.coordinator.harness,
      },
      subtask_id: started.prepared.subtask_id,
      attempt: started.prepared.attempt,
      owner_epoch: started.goal.coordinator.owner_epoch,
      body,
    },
    { clock },
  );
  const submitted = submitMessage(started.prepared.task_root, message, {
    clock,
  });
  if (!submitted.ok) {
    return {
      ok: false,
      messageId,
      duplicate: false,
      classification: null,
      detail: submitted.reason,
    };
  }
  const record = readRecord(started.prepared.task_root);
  const stored = record?.results?.find(
    (entry) =>
      entry.message_id === messageId &&
      entry.subtask_id === started.prepared.subtask_id &&
      entry.attempt === started.prepared.attempt,
  );
  const appliedMessage = record?.messages?.find(
    (entry) => entry.message_id === messageId,
  );
  const effect = submitted.applied.result as {
    classification?: unknown;
  } | null;
  const classification =
    stored?.classification ??
    (effect && typeof effect.classification === 'string'
      ? effect.classification
      : null);
  const fixedContext =
    stored !== undefined &&
    appliedMessage !== undefined &&
    appliedMessage.from.agent_id === started.assignment.assignee.agent_id &&
    appliedMessage.from.session_id === started.assignment.assignee.session_id &&
    appliedMessage.from.harness === started.assignment.assignee.harness &&
    appliedMessage.owner_epoch === started.goal.coordinator.owner_epoch &&
    stored.input_revision === started.prepared.prompt_digest &&
    stored.status === finish.status;
  const finalStatus = ['completed', 'failed', 'cancelled'].includes(
    finish.status,
  );
  const accepted = finalStatus && fixedContext && classification === 'applied';
  return {
    ok: accepted,
    messageId,
    duplicate: submitted.duplicate === true,
    classification,
    detail: accepted
      ? null
      : `result_not_accepted:${classification ?? 'unknown'}`,
  };
}

export async function finishStarted(
  started: StartedRun,
): Promise<CollaborationResult<ControllerFinish>> {
  let finish: ControllerFinish;
  try {
    finish = await started.session.finish();
  } catch (error) {
    return failure(
      'failed',
      'native_finish_failed',
      error instanceof Error ? error.message : String(error),
    );
  }
  if (
    !['completed', 'failed', 'cancelled', 'needs_input', 'unknown'].includes(
      finish.status,
    ) ||
    finish.outputs.length > 32 ||
    boundedJson(finish.outputs, 64 * 1024) === null
  ) {
    return failure(
      'failed',
      'native_result_invalid',
      'Native result is malformed.',
    );
  }
  if (
    finish.sessionId !== null &&
    finish.sessionId !== started.assignment.assignee.session_id
  ) {
    return failure(
      'conflict',
      'native_session_drift',
      'Native result belongs to a different session.',
    );
  }
  for (const output of finish.outputs) {
    if (
      output === null ||
      typeof output !== 'object' ||
      !('ref' in output) ||
      !('digest' in output) ||
      typeof output.ref !== 'string' ||
      !path.isAbsolute(output.ref) ||
      typeof output.digest !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(output.digest)
    ) {
      return failure(
        'invalid',
        'result_output_invalid',
        'Every result output must be an absolute ref with a SHA-256 digest.',
      );
    }
    try {
      if (sha256File(output.ref) !== output.digest) {
        return failure(
          'conflict',
          'result_output_changed',
          'Result output digest does not match.',
        );
      }
    } catch {
      return failure(
        'failed',
        'result_output_unavailable',
        'Result output is unavailable.',
      );
    }
  }
  if (started.reservationId !== null) {
    const settled = settleLaunch(started.prepared.task_root, {
      reservationId: started.reservationId,
      outcome:
        finish.outcome === 'exited' ||
        finish.outcome === 'exited_nonzero' ||
        finish.outcome === 'timed_out'
          ? finish.outcome
          : 'exited_nonzero',
      exitCode: finish.exitCode,
      sessionId: finish.sessionId,
      runner: started.controller.id,
      evidenceRef: finish.evidenceRef,
      detail: finish.status,
    });
    if (!settled.ok) {
      const record = readRecord(started.prepared.task_root);
      const attempt = record
        ? findAttempt(
            record,
            started.prepared.subtask_id,
            started.prepared.attempt,
          )
        : null;
      if (
        attempt === null ||
        !['completed', 'failed', 'cancelled'].includes(attempt.state)
      ) {
        return failure(
          'failed',
          'settlement_failed',
          `Native settlement failed: ${settled.reason}`,
        );
      }
    }
  }
  return { ok: true, value: finish };
}

export async function driveRun(
  started: StartedRun,
  commands: AsyncIterable<unknown>,
  emit: (event: CollaborationEvent) => void,
  { clock = Date.now() }: { clock?: number } = {},
): Promise<CollaborationResult<ReportResult>> {
  let sequence = 0;
  const seenRequests = new Set<string>();
  const send = (
    kind: CollaborationEvent['kind'],
    requestId: string | null,
    status: string,
    detail: string | null,
    data: unknown,
  ) => {
    sequence += 1;
    const normalizedStatus = status.trim() === '' ? 'unknown' : status;
    const safeStatus =
      normalizedStatus.length > 64
        ? `${normalizedStatus.slice(0, 61)}...`
        : normalizedStatus;
    const safeDetail =
      detail === null
        ? null
        : detail.length > 4096
          ? `${detail.slice(0, 4093)}...`
          : detail;
    const safeData =
      data === null || boundedJson(data, 8192) !== null
        ? data
        : { truncated: true, detail: 'observation exceeded the event budget' };
    emit({
      schema: 'pappra/collaboration-event/1',
      sequence,
      request_id: requestId,
      kind,
      at: nowIso(clock),
      status: safeStatus,
      detail: safeDetail,
      data: safeData,
    });
  };
  try {
    send('started', null, 'started', null, {
      task_id: started.prepared.task_id,
      subtask_id: started.prepared.subtask_id,
      attempt: started.prepared.attempt,
      controller: started.controller.id,
      reservation_id: started.reservationId,
    });
    for await (const raw of commands) {
      let command: CollaborationCommand;
      try {
        command = collaborationCommandSchema.parse(raw);
      } catch (error) {
        send(
          'refused',
          null,
          'invalid',
          error instanceof Error ? error.message : String(error),
          null,
        );
        continue;
      }
      if (seenRequests.has(command.request_id)) {
        send(
          'refused',
          command.request_id,
          'duplicate_request',
          'request_id was already processed by this run',
          null,
        );
        continue;
      }
      seenRequests.add(command.request_id);
      if (command.action === 'query') {
        try {
          const observation = await started.session.query();
          send(
            'query',
            command.request_id,
            observation.status,
            observation.detail,
            observation.data,
          );
        } catch (error) {
          send(
            'refused',
            command.request_id,
            'failed',
            error instanceof Error ? error.message : String(error),
            null,
          );
        }
        continue;
      }
      if (command.action === 'cancel') {
        const intent = buildMessage(
          {
            type: 'CANCEL',
            task_id: started.prepared.task_id,
            from: {
              agent_id: started.goal.coordinator.agent_id,
              session_id: started.goal.coordinator.session_id,
              harness: started.goal.coordinator.harness,
            },
            to: {
              agent_id: started.assignment.assignee.agent_id,
              session_id: started.assignment.assignee.session_id,
              harness: started.assignment.assignee.harness,
            },
            subtask_id: started.prepared.subtask_id,
            attempt: started.prepared.attempt,
            owner_epoch: started.goal.coordinator.owner_epoch,
            body: { reason: 'operator cancellation request' },
          },
          { clock },
        );
        const submitted = submitMessage(started.prepared.task_root, intent, {
          clock,
        });
        if (!submitted.ok) {
          send(
            'cancel',
            command.request_id,
            'cancel-intent-failed',
            'P01 cancellation intent was not recorded',
            {
              intent: false,
              native: {
                called: false,
                reason: submitted.reason,
              },
            },
          );
          continue;
        }
        try {
          const cancel = await started.session.cancel();
          send('cancel', command.request_id, 'cancel-requested', null, {
            intent: true,
            native: cancel,
          });
        } catch (error) {
          send(
            'refused',
            command.request_id,
            'failed',
            error instanceof Error ? error.message : String(error),
            { intent: true, native: { called: true } },
          );
        }
        continue;
      }
      const finished = await finishStarted(started);
      if (!finished.ok) {
        send(
          'refused',
          command.request_id,
          finished.status,
          finished.message,
          null,
        );
        return finished;
      }
      if (finished.value.status !== command.status) {
        send(
          'refused',
          command.request_id,
          'conflict',
          'finish status does not match the native result',
          null,
        );
        continue;
      }
      const report = submitResultReport(started, finished.value, { clock });
      send(
        'finished',
        command.request_id,
        report.ok ? 'finished' : 'failed',
        report.detail,
        {
          status: finished.value.status,
          outcome: finished.value.outcome,
          report,
        },
      );
      return report.ok
        ? { ok: true, value: report }
        : failure('failed', 'report_failed', report.detail ?? 'REPORT failed.');
    }
    return failure(
      'needs_input',
      'run_closed',
      'Run input closed before a final REPORT.',
    );
  } catch (error) {
    send(
      'refused',
      null,
      'failed',
      error instanceof Error ? error.message : String(error),
      null,
    );
    return failure(
      'failed',
      'run_stream_failed',
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    await started.session.dispose?.().catch(() => undefined);
  }
}

export class FixtureController implements CollaborationController {
  readonly id = 'fixture';
  constructor(
    private readonly options: {
      readonly status?: 'completed' | 'failed' | 'cancelled' | 'needs_input';
      readonly outputs?: readonly unknown[];
      readonly sessionId?: string;
    } = {},
  ) {}
  async start(
    token: object,
    request: ControllerStartRequest,
  ): Promise<
    | { readonly ok: true; readonly session: ControllerSession }
    | {
        readonly ok: false;
        readonly status: CollaborationFailureStatus;
        readonly code: string;
        readonly message: string;
        readonly nextAction: string | null;
        readonly possible_start?: boolean;
      }
  > {
    let facts: LaunchFacts;
    try {
      facts = consumeToken(token, {
        taskRoot: request.taskRoot,
        assignmentDigest: request.prepared.assignment_digest,
        subtaskId: request.prepared.subtask_id,
        attempt: request.prepared.attempt,
      });
    } catch (error) {
      return {
        ok: false,
        status: 'invalid',
        code: 'admission_token_required',
        message: error instanceof Error ? error.message : String(error),
        nextAction: 'Use startPrepared; a fabricated token is not authority.',
      };
    }
    const status = this.options.status ?? 'completed';
    return {
      ok: true,
      session: {
        query: async () => ({
          status: 'live',
          detail: 'fixture controller has no native process',
          data: { fixture: true, reservation_id: facts.reservationId },
        }),
        cancel: async () => ({
          acknowledged: true,
          terminal_observed: false,
          stop_evidence: { kind: 'fixture', stopped: false },
        }),
        finish: async () => ({
          outcome: status === 'completed' ? 'exited' : 'exited_nonzero',
          status,
          exitCode: status === 'completed' ? 0 : 1,
          sessionId:
            this.options.sessionId ?? request.assignment.assignee.session_id,
          outputs: this.options.outputs ?? [],
          nativeRef: {
            kind: 'fixture',
            session_id: request.assignment.assignee.session_id,
          },
          evidenceRef: null,
        }),
        dispose: async () => undefined,
      },
    };
  }
}

export class PiRpcController implements CollaborationController {
  readonly id = 'pi-rpc';
  async start(
    token: object,
    request: ControllerStartRequest,
  ): Promise<
    | { readonly ok: true; readonly session: ControllerSession }
    | {
        readonly ok: false;
        readonly status: CollaborationFailureStatus;
        readonly code: string;
        readonly message: string;
        readonly nextAction: string | null;
        readonly possible_start?: boolean;
      }
  > {
    if (
      !validateLaunchToken(token, {
        taskRoot: request.taskRoot,
        assignmentDigest: request.prepared.assignment_digest,
        subtaskId: request.prepared.subtask_id,
        attempt: request.prepared.attempt,
      })
    ) {
      return {
        ok: false,
        status: 'invalid',
        code: 'admission_token_required',
        message: 'genuine admission token required',
        nextAction: 'Use startPrepared; a fabricated token is not authority.',
      };
    }
    const started = await startOwnedPiRpc({
      taskRoot: request.taskRoot,
      cwd: request.assignment.assignee.cwd,
      assignmentFile: request.prepared.assignment_path,
      capabilitiesFile: request.capabilitiesFile,
      promptFile: request.promptFile,
      evidenceDir: request.evidenceDir,
      profile: 'daily',
      phase: request.goal.phase,
      sessionId: request.assignment.assignee.session_id,
      launchKind: 'first',
      ...(request.namespace === undefined
        ? {}
        : {
            namespaceGuard: () => {
              const issue = namespaceSyncFailure(request.namespace!);
              if (issue !== null) throw new Error(issue);
            },
          }),
    });
    if (!started.ok) {
      const reason =
        'reason' in started && typeof started.reason === 'string'
          ? started.reason
          : 'native_refused';
      const stage =
        'stage' in started && typeof started.stage === 'string'
          ? started.stage
          : 'native';
      return {
        ok: false,
        status: reason.includes('conflict') ? 'conflict' : 'needs_input',
        code: reason,
        message: `Pi RPC refused at ${stage}`,
        nextAction: 'Inspect the native admission and reservation evidence.',
        possible_start: stage === 'identity',
      };
    }
    const nativeSessionFile = started.session.sessionFile();
    const nativeSessionBaseline = regularFileSize(nativeSessionFile);
    try {
      await started.session.prompt();
    } catch (error) {
      await started.session.finish().catch(() => undefined);
      return {
        ok: false,
        status: 'failed',
        code: 'native_prompt_failed',
        message: error instanceof Error ? error.message : String(error),
        nextAction:
          'The owned RPC child was shut down; inspect native evidence before reconciliation.',
        possible_start: true,
      };
    }
    let disposed = false;
    let currentResultEvidenceFile: string | null = null;
    const liveNamespaceProblem = (): string | null =>
      request.namespace === undefined
        ? null
        : namespaceSyncFailure(request.namespace);
    return {
      ok: true,
      session: {
        query: async () => {
          if (disposed) {
            return {
              status: 'disposed',
              detail: 'owned Pi RPC child was closed by this run',
              data: null,
            };
          }
          const namespaceProblem = liveNamespaceProblem();
          if (namespaceProblem !== null) {
            return {
              status: 'unknown',
              detail: `private namespace changed: ${namespaceProblem}`,
              data: null,
            };
          }
          try {
            const data = await started.session.query();
            const after = liveNamespaceProblem();
            if (after !== null) {
              return {
                status: 'unknown',
                detail: `private namespace changed during query: ${after}`,
                data: null,
              };
            }
            return {
              status: 'live',
              detail: 'owned Pi RPC handle',
              data,
            };
          } catch (error) {
            return {
              status: 'unknown',
              detail:
                error instanceof Error ? error.message : 'owned query failed',
              data: null,
            };
          }
        },
        cancel: async () => {
          const namespaceProblem = liveNamespaceProblem();
          if (namespaceProblem !== null) {
            return {
              acknowledged: false,
              terminal_observed: false,
              stop_evidence: {
                namespace_changed: true,
                detail: namespaceProblem,
              },
            };
          }
          const cancel = await started.session.cancel();
          const entry =
            cancel !== null && typeof cancel === 'object'
              ? (cancel as Record<string, unknown>)
              : {};
          const abort =
            entry['abort'] !== null && typeof entry['abort'] === 'object'
              ? (entry['abort'] as Record<string, unknown>)
              : {};
          return {
            acknowledged: abort['success'] === true,
            terminal_observed:
              entry['agent_settled'] !== null &&
              entry['agent_settled'] !== undefined,
            stop_evidence: cancel,
          };
        },
        finish: async () => {
          const initialNamespaceProblem = liveNamespaceProblem();
          if (initialNamespaceProblem !== null) {
            disposed = true;
            await started.session.shutdown().catch(() => undefined);
            return {
              outcome: 'unknown',
              status: 'unknown',
              exitCode: null,
              sessionId: null,
              outputs: [],
              nativeRef: {
                reason: 'private_namespace_redirected',
                detail: initialNamespaceProblem,
                current_result_published: false,
              },
              evidenceRef: null,
            };
          }
          try {
            await started.session.awaitSettled();
          } catch {
            // finish() below still records the bounded settlement/failure.
          }
          const result = await started.session.finish();
          const value =
            result !== null && typeof result === 'object'
              ? (result as Record<string, unknown>)
              : {};
          const exit =
            value['exit'] !== null && typeof value['exit'] === 'object'
              ? (value['exit'] as Record<string, unknown>)
              : {};
          const evidence =
            value['evidence'] !== null && typeof value['evidence'] === 'object'
              ? (value['evidence'] as Record<string, unknown>)
              : {};
          const settlement =
            value['settlement'] !== null &&
            typeof value['settlement'] === 'object'
              ? (value['settlement'] as Record<string, unknown>)
              : {};
          const nativeResult =
            value['result'] !== null && typeof value['result'] === 'object'
              ? (value['result'] as Record<string, unknown>)
              : {};
          const outcome =
            typeof value['outcome'] === 'string' ? value['outcome'] : 'unknown';
          const evidenceWritten = evidence['written'] === true;
          const ok =
            value['ok'] === true &&
            outcome === 'exited' &&
            value['identity'] === 'match' &&
            evidenceWritten &&
            settlement['ok'] === true &&
            nativeResult['ok'] === true;
          const executionFile =
            typeof evidence['execution_file'] === 'string'
              ? evidence['execution_file']
              : null;
          const proofFile =
            typeof evidence['proof_file'] === 'string'
              ? evidence['proof_file']
              : null;
          const sessionFile =
            typeof value['session_file'] === 'string' &&
            path.isAbsolute(value['session_file'])
              ? value['session_file']
              : nativeSessionFile;
          const afterLowerProblem = liveNamespaceProblem();
          const sessionFileInside =
            request.namespace === undefined ||
            (sessionFile !== null &&
              isPathInside(request.namespace.privateDir.path, sessionFile));
          const current =
            afterLowerProblem === null && sessionFileInside
              ? currentNativeResult(sessionFile, nativeSessionBaseline)
              : null;
          const currentStatus = current?.status ?? 'unknown';
          const currentReason =
            current?.reason ??
            afterLowerProblem ??
            (sessionFileInside
              ? 'current_result_unavailable'
              : 'native session file is outside the private namespace');
          let publicationError: string | null =
            afterLowerProblem ??
            (sessionFileInside
              ? null
              : 'native session file is outside the private namespace');
          if (current !== null) {
            const resultFile = path.join(
              path.dirname(sessionFile ?? ''),
              `${path.basename(sessionFile ?? 'session')}.current-result.json`,
            );
            const resultBytes = `${JSON.stringify(
              {
                schema: 'harness-collab/native-current-result/1',
                session_file: sessionFile,
                baseline_bytes: nativeSessionBaseline,
                status: currentStatus,
                reason: currentReason,
                record_count: current.records.length,
                records: current.records,
              },
              null,
              2,
            )}\n`;
            if (request.namespace === undefined) {
              publicationError =
                'captured private namespace is unavailable for current-result evidence';
              currentResultEvidenceFile = null;
            } else {
              const published = publishCurrentResult(
                request.namespace,
                resultFile,
                resultBytes,
              );
              if (published.ok) {
                currentResultEvidenceFile = published.ref;
              } else {
                publicationError = published.error;
                currentResultEvidenceFile = null;
              }
            }
          }
          if (afterLowerProblem !== null) currentResultEvidenceFile = null;
          const outputs: { ref: string; digest: string }[] = [];
          for (const ref of [
            afterLowerProblem === null ? executionFile : null,
            afterLowerProblem === null ? proofFile : null,
            currentResultEvidenceFile,
          ]) {
            if (ref === null || !path.isAbsolute(ref)) continue;
            const hashNamespaceProblem = liveNamespaceProblem();
            if (hashNamespaceProblem !== null) {
              publicationError = publicationError ?? hashNamespaceProblem;
              currentResultEvidenceFile = null;
              continue;
            }
            try {
              outputs.push({ ref, digest: sha256File(ref) });
            } catch {
              // Missing evidence cannot be claimed as a result output.
            }
          }
          const finalNamespaceProblem = liveNamespaceProblem();
          if (finalNamespaceProblem !== null) {
            publicationError = publicationError ?? finalNamespaceProblem;
            currentResultEvidenceFile = null;
          }
          const deliveryStatus =
            publicationError === null ? currentStatus : 'unknown';
          disposed = true;
          return {
            outcome,
            status: !ok
              ? outcome === 'timed_out' ||
                outcome === 'spawn_failed' ||
                !evidenceWritten
                ? 'unknown'
                : 'failed'
              : deliveryStatus,
            exitCode:
              typeof exit['exit_code'] === 'number' ? exit['exit_code'] : null,
            sessionId:
              typeof value['session_id'] === 'string'
                ? value['session_id']
                : null,
            outputs,
            nativeRef: {
              ...value,
              task_result:
                current === null
                  ? null
                  : {
                      status: currentStatus,
                      reason: currentReason,
                      record_count: current.records.length,
                    },
              current_result_published: currentResultEvidenceFile !== null,
              current_result_publication_error: publicationError,
            },
            evidenceRef:
              ok && finalNamespaceProblem === null ? executionFile : null,
          };
        },
        dispose: async () => {
          disposed = true;
          if (liveNamespaceProblem() !== null) {
            await started.session.shutdown().catch(() => undefined);
          } else {
            await started.session.finish().catch(() => undefined);
          }
        },
      },
    };
  }
}

export function inspectPreparedHistory(
  preparedFile: string,
): CollaborationResult<Record<string, unknown>> {
  const bundle = preparedBundle(preparedFile);
  if (!bundle.ok) return bundle;
  const record = readRecord(bundle.value.prepared.task_root);
  if (record === null) {
    return failure('failed', 'task_record_missing', 'Task record is missing.');
  }
  const attempt = findAttempt(
    record,
    bundle.value.prepared.subtask_id,
    bundle.value.prepared.attempt,
  );
  return {
    ok: true,
    value: {
      schema: 'pappra/collaboration-history/1',
      task_id: bundle.value.prepared.task_id,
      subtask_id: bundle.value.prepared.subtask_id,
      attempt: bundle.value.prepared.attempt,
      live_owner: 'unknown',
      state: attempt?.state ?? null,
      native: attempt?.native ?? null,
      reconciliation_required: attempt?.native?.observation !== 'confirmed',
    },
  };
}
