import { object as isRecord } from '../infra/validation.js';
import crypto from 'node:crypto';
import {
  captureProcessIdentity,
  observeProcessIdentity,
} from '../infra/process-identity.js';
import { readManagedSourceAssignment } from './managed-pi-source-admission.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isAssignment,
  isCard,
  type Assignment,
  type CapabilityCard,
} from '../collab/contracts.js';
import { hasPendingCancellation } from '../collab/admission.js';
import { findAttempt } from '../collab/lifecycle.js';
import { transact } from '../collab/store.js';
import type {
  Attempt,
  Identity,
  LaunchReservation,
  Message,
  RolloverIntent,
  TaskRecord,
} from '../collab/types.js';
import {
  collabBindingSchema,
  type CollabBinding,
  type CollabBindingParticipant,
} from '../schemas/collaboration.js';
import { isPathInside } from '../schemas/paths.js';
import { getPackageRoot } from '../package-info.js';
import {
  readPiBootstrapConfig,
  type PiBootstrapConfig,
} from '../hosts/integration/bootstrap-config.js';
import { readBoundedFile } from './bounded-file.js';
import { runCollaborationPreflight } from './collab-preflight.js';
import { MANAGED_PI_REQUEST_SCHEMA } from './managed-pi.js';
import {
  assertMessageTaskCurrent,
  openMessageTask,
  readRegisteredMessageSafe,
  type MessageServiceResult,
  type OpenedMessageTask,
} from './collab-messages.js';
import {
  notifyRegisteredMessage,
  reportedSessionIdentity,
  type HerdrAgentObservation,
  type HerdrCallerObservation,
  type HerdrTransport,
  type NotifyResult,
} from './collab-notify.js';
import {
  acceptedManagedSdkStartReceipt,
  managedSdkStartArgs,
  createHerdrBootstrapOps,
  type BootstrapCommandReceipt,
  type BootstrapManagedSdkStartInput,
  type BootstrapPaneSnapshot,
  type BootstrapStartedManagedSdk,
  type HerdrBootstrapOps,
} from './collab-bootstrap-transport.js';
import {
  parsePaneLayout,
  selectPanePlacement,
  type PanePlacement,
} from './collab-pane-layout.js';
import {
  verifyAvailableShell,
  type ShellReadinessEvidence,
} from './shell-readiness.js';

export const COLLAB_BOOTSTRAP_REQUEST_SCHEMA =
  'pappra/collab-bootstrap-request/1';
export const COLLAB_BOOTSTRAP_REPORT_SCHEMA =
  'pappra/collab-bootstrap-report/1';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_ASSIGNMENT_BYTES = 1024 * 1024;
const MAX_BINDING_BYTES = 64 * 1024;
const MAX_CARD_BYTES = 1024 * 1024;
const MAX_BUNDLE_FILES = 512;
const MAX_BUNDLE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_BUNDLE_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_RECEIPTS = 12;
const READ_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 180_000;
const MAX_START_TIMEOUT_MS = 600_000;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PANE_ID = /^[A-Za-z0-9]+:p[A-Za-z0-9]+$/;
const HERDR_AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHELL_NAMES = new Set([
  'sh',
  'bash',
  'dash',
  'zsh',
  'fish',
  'ksh',
  'mksh',
  'csh',
  'tcsh',
  'elvish',
  'xonsh',
  'nu',
  'pwsh',
  'powershell',
  'cmd',
]);
const BOOTSTRAP_ENTRY_SOURCE = `/**
 * Generated Pappra Pi bootstrap extension. It registers the accepted default-deny
 * successor gate from a private relative configuration; it installs, trusts, launches
 * and dispatches nothing by itself.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import bootstrapExtension from "./runtime.mjs";

export default function (pi: ExtensionAPI): void {
  bootstrapExtension(pi);
}`;

export type BootstrapAction = 'plan' | 'apply';
export type BootstrapStatus =
  | 'planned'
  | 'applied'
  | 'already_recorded'
  | 'needs_input'
  | 'invalid'
  | 'failed'
  | 'unknown'
  | 'reconcile_required';

export interface VisibleBootstrapRequest {
  readonly schema: typeof COLLAB_BOOTSTRAP_REQUEST_SCHEMA;
  /** Optional legacy field in request examples; the CLI action remains authoritative. */
  readonly action?: 'apply';
  readonly request_id: string;
  readonly task_root: string;
  readonly admission: {
    readonly assignment_id: string;
    readonly subtask_id: string;
    readonly attempt: number;
    readonly input_revision: string;
    readonly capability_card_ref: string;
    readonly capability_card_digest: string;
  };
  readonly caller: {
    readonly require_herdr_env: true;
    readonly pane_id: string | null;
  };
  readonly participant: {
    readonly agent_id: string;
    readonly harness: 'pi';
    readonly native_session_selector: string;
    readonly herdr_agent?: string;
    readonly capability_card_ref?: string;
    readonly capability_card_digest?: string;
  };
  readonly target: {
    readonly choice: 'reuse' | 'sibling';
    readonly cwd: string;
    readonly direction?: 'right' | 'down';
    readonly preserve_focus: true;
    readonly start_timeout_ms?: number;
  };
  readonly selected_model: {
    readonly preserve_daily: true;
    readonly openrouter_model?: string;
  };
  readonly managed_runtime?: {
    readonly sdk_module_path: string;
    readonly journal_path: string;
    readonly automatic_handoff_file?: string;
    readonly handoff_context_file?: string;
  };
  readonly bootstrap: {
    readonly config_ref: string;
    readonly config_digest: string;
    readonly bundle_ref: string;
    readonly bundle_digest: string;
    readonly extension_entry: string;
  };
  readonly message_pointer: {
    readonly message_id: string;
    readonly content_ref: string;
    readonly content_digest: string;
  };
  /** Required for live routing; remains separate from task authority and the request pointer. */
  readonly binding_ref?: string;
  readonly readiness?: {
    readonly budget_ms?: number;
    readonly interval_ms?: number;
    readonly max_samples?: number;
  };
}

export interface LoadedVisibleBootstrapRequest {
  readonly request: VisibleBootstrapRequest;
  readonly digest: string;
  readonly file: string;
}

export interface BootstrapStep {
  readonly step: string;
  readonly status: string;
  readonly detail: string | null;
}

export interface VisibleBootstrapReport {
  readonly schema: typeof COLLAB_BOOTSTRAP_REPORT_SCHEMA;
  readonly action: BootstrapAction;
  readonly ok: boolean;
  readonly status: BootstrapStatus;
  readonly code: string | null;
  readonly message: string | null;
  readonly next_action: string | null;
  readonly request_id: string | null;
  readonly request_digest: string | null;
  readonly task_id: string | null;
  readonly task_root: string | null;
  readonly state_revision: number | null;
  readonly caller: Record<string, unknown> | null;
  readonly participant: Record<string, unknown> | null;
  readonly target: Record<string, unknown> | null;
  readonly bootstrap: Record<string, unknown> | null;
  readonly reservation: Record<string, unknown> | null;
  readonly readiness: ShellReadinessEvidence | null;
  readonly effects: readonly BootstrapStep[];
  readonly notification: Record<string, unknown> | null;
  readonly downstream: {
    readonly host_stop_proof: 'unavailable';
    readonly first_work: 'unverified';
    readonly routing_removal: 'pending';
    readonly native_archive: 'unavailable';
  };
  readonly limits: readonly string[];
}

export interface VisibleBootstrapDependencies {
  readonly ops?: HerdrBootstrapOps;
  readonly transport?: HerdrTransport;
  readonly clock?: () => number;
  readonly sleeper?: (milliseconds: number) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly acceptedArtifactPath?: string;
  readonly notify?: typeof notifyRegisteredMessage;
}

export type BootstrapRequestLoadResult =
  | { readonly ok: true; readonly value: LoadedVisibleBootstrapRequest }
  | { readonly ok: false; readonly code: string; readonly message: string };

interface BundleFile {
  readonly bytes: Buffer;
  readonly digest: string;
}
interface BundleSnapshot {
  readonly root: string;
  readonly digest: string;
  readonly entries: readonly {
    readonly path: string;
    readonly digest: string;
  }[];
  readonly files: ReadonlyMap<string, BundleFile>;
}
interface BootstrapContext {
  readonly request: VisibleBootstrapRequest;
  readonly requestDigest: string;
  readonly requestFile: string | null;
  readonly task: OpenedMessageTask;
  readonly assignment: Assignment;
  readonly assignmentDigest: string;
  readonly assignmentFile: string;
  readonly admissionAssignmentDigest: string;
  readonly attempt: Attempt;
  readonly callerCard: CapabilityCard;
  readonly caller: HerdrCallerObservation;
  readonly transport: HerdrTransport;
  readonly ops: HerdrBootstrapOps;
  readonly binding: CollabBinding;
  readonly bindingFile: string;
  readonly bindingDigest: string;
  readonly message: Message;
  readonly config: PiBootstrapConfig;
  readonly configDigest: string;
  readonly acceptedArtifactPath: string | null;
  readonly bundle: BundleSnapshot;
  readonly herdrAgent: string;
  readonly derivedBindingFile: string;
}

type Prepared =
  | { readonly ok: true; readonly context: BootstrapContext }
  | { readonly ok: false; readonly report: VisibleBootstrapReport };

function isText(value: unknown, max = 4096): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}
function digestText(value: string | Buffer): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
function safePathEqual(left: string, right: string): boolean {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return false;
  }
}

interface ManagedRuntimePaths {
  readonly sdkModulePath: string;
  readonly journalPath: string;
  readonly configPath: string;
  readonly controlSocketPath: string;
  readonly automaticHandoffFile?: string;
  readonly handoffContextFile?: string;
}

type ManagedRuntimePathResult =
  | { readonly ok: true; readonly paths: ManagedRuntimePaths }
  | { readonly ok: false; readonly code: string; readonly message: string };

function hasUnsafePathCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code === 0 || code === 10 || code === 13;
  });
}

function isPrivateRealDirectory(directory: string): boolean {
  try {
    const stat = fs.lstatSync(directory);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      fs.realpathSync(directory) === directory &&
      (stat.mode & 0o077) === 0 &&
      (typeof process.getuid !== 'function' || stat.uid === process.getuid())
    );
  } catch {
    return false;
  }
}

function isAbsentPath(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return false;
  } catch (error) {
    return isRecord(error) && error['code'] === 'ENOENT';
  }
}

function managedRuntimePathsFor(
  request: VisibleBootstrapRequest,
): ManagedRuntimePathResult {
  const runtime = request.managed_runtime;
  if (runtime === undefined)
    return {
      ok: false,
      code: 'managed_runtime_missing',
      message: 'Managed runtime is not selected.',
    };
  const model = request.selected_model.openrouter_model;
  if (
    request.target.choice !== 'sibling' ||
    typeof model !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(model)
  )
    return {
      ok: false,
      code: 'managed_runtime_invalid',
      message:
        'Managed SDK launch requires a fresh sibling and an explicit OpenRouter model.',
    };
  const { sdk_module_path: sdkPath, journal_path: journalPath } = runtime;
  if (
    !path.isAbsolute(sdkPath) ||
    !path.isAbsolute(journalPath) ||
    path.resolve(sdkPath) !== sdkPath ||
    path.resolve(journalPath) !== journalPath ||
    hasUnsafePathCharacters(sdkPath) ||
    hasUnsafePathCharacters(journalPath)
  )
    return {
      ok: false,
      code: 'managed_path_invalid',
      message: 'SDK and journal paths must be normalized absolute paths.',
    };
  let sdkModulePath: string;
  try {
    const sdkStat = fs.lstatSync(sdkPath);
    if (!sdkStat.isFile() || sdkStat.isSymbolicLink())
      throw new Error('sdk_not_regular');
    sdkModulePath = fs.realpathSync(sdkPath);
  } catch {
    return {
      ok: false,
      code: 'managed_sdk_module_invalid',
      message:
        'Pinned SDK entry must resolve to a regular file before any native effect.',
    };
  }
  const parent = path.dirname(journalPath);
  if (!isPrivateRealDirectory(parent))
    return {
      ok: false,
      code: 'managed_journal_parent_not_private',
      message:
        'Journal parent must already be a private, real, current-user directory.',
    };
  const requestHash = crypto
    .createHash('sha256')
    .update(JSON.stringify([request.task_root, request.request_id]))
    .digest('hex');
  const configPath = path.join(
    parent,
    `.pappra-managed-sdk-${requestHash.slice(0, 20)}.json`,
  );
  let socketDirectory: string;
  try {
    socketDirectory = fs.realpathSync(
      process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(),
    );
    if (!fs.statSync(socketDirectory).isDirectory())
      throw new Error('control_socket_directory_invalid');
  } catch {
    return {
      ok: false,
      code: 'managed_control_socket_directory_unavailable',
      message: 'Managed SDK control socket directory is unavailable.',
    };
  }
  const controlSocketPath = path.join(
    socketDirectory,
    `.pappra-sdk-${requestHash.slice(0, 16)}.sock`,
  );
  if (Buffer.byteLength(controlSocketPath) > 100)
    return {
      ok: false,
      code: 'managed_control_socket_path_too_long',
      message:
        'Managed SDK control socket path exceeds the local Unix socket limit.',
    };
  const handoffContextFile = runtime.handoff_context_file;
  const paths = [
    journalPath,
    `${journalPath}.pi-events.jsonl`,
    `${journalPath}.control.json`,
    configPath,
    controlSocketPath,
  ];
  if (
    paths.some((candidate) => !isAbsentPath(candidate)) ||
    [configPath, controlSocketPath, handoffContextFile]
      .filter((candidate): candidate is string => candidate !== undefined)
      .some((candidate) => candidate === sdkModulePath) ||
    (runtime.automatic_handoff_file !== undefined &&
      (!path.isAbsolute(runtime.automatic_handoff_file) ||
        hasUnsafePathCharacters(runtime.automatic_handoff_file) ||
        [
          sdkModulePath,
          journalPath,
          `${journalPath}.pi-events.jsonl`,
          `${journalPath}.control.json`,
          configPath,
          controlSocketPath,
          handoffContextFile,
        ]
          .filter((candidate): candidate is string => candidate !== undefined)
          .includes(path.resolve(runtime.automatic_handoff_file)))) ||
    (handoffContextFile !== undefined &&
      (!path.isAbsolute(handoffContextFile) ||
        path.resolve(handoffContextFile) !== handoffContextFile ||
        hasUnsafePathCharacters(handoffContextFile) ||
        !isPrivateRealDirectory(path.dirname(handoffContextFile)) ||
        [
          sdkModulePath,
          journalPath,
          `${journalPath}.pi-events.jsonl`,
          `${journalPath}.control.json`,
          configPath,
          controlSocketPath,
        ].includes(handoffContextFile)))
  )
    return {
      ok: false,
      code: 'managed_output_path_unavailable',
      message:
        'Managed journal, config, metadata, handoff or control paths are not fresh/private.',
    };
  return {
    ok: true,
    paths: {
      sdkModulePath,
      journalPath,
      configPath,
      controlSocketPath,
      ...(runtime.automatic_handoff_file === undefined
        ? {}
        : { automaticHandoffFile: runtime.automatic_handoff_file }),
      ...(handoffContextFile === undefined ? {} : { handoffContextFile }),
    },
  };
}

function writeManagedSdkConfig(
  request: VisibleBootstrapRequest,
  context: BootstrapContext,
  paneId: string,
  paths: ManagedRuntimePaths,
):
  | { readonly ok: true; readonly digest: string }
  | { readonly ok: false; readonly code: string } {
  const current = managedRuntimePathsFor(request);
  if (!current.ok || current.paths.configPath !== paths.configPath)
    return {
      ok: false,
      code: current.ok ? 'managed_path_changed' : current.code,
    };
  const model = request.selected_model.openrouter_model;
  if (model === undefined) return { ok: false, code: 'managed_model_missing' };
  const value = {
    schema: MANAGED_PI_REQUEST_SCHEMA,
    cwd: request.target.cwd,
    model,
    journalPath: paths.journalPath,
    controlSocketPath: paths.controlSocketPath,
    runtime: 'sdk',
    sdkModulePath: paths.sdkModulePath,
    sessionId: request.participant.native_session_selector,
    bootstrapExtensionPath: request.bootstrap.extension_entry,
    herdrAgentName: context.herdrAgent,
    herdrPaneId: paneId,
    ...(paths.automaticHandoffFile === undefined
      ? {}
      : { automaticHandoffFile: paths.automaticHandoffFile }),
    ...(paths.handoffContextFile === undefined
      ? {}
      : { handoffContextFile: paths.handoffContextFile }),
  };
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (bytes.byteLength > MAX_REQUEST_BYTES)
    return { ok: false, code: 'managed_config_too_large' };
  let descriptor: number | undefined;
  let identity: { readonly dev: number; readonly ino: number } | undefined;
  try {
    if (!isPrivateRealDirectory(path.dirname(paths.configPath)))
      return { ok: false, code: 'managed_journal_parent_not_private' };
    descriptor = fs.openSync(paths.configPath, 'wx', 0o600);
    fs.fchmodSync(descriptor, 0o400);
    const stat = fs.fstatSync(descriptor);
    identity = { dev: stat.dev, ino: stat.ino };
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    const directory = fs.openSync(path.dirname(paths.configPath), 'r');
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
    const written = fs.lstatSync(paths.configPath);
    const read = readBoundedFile(paths.configPath, MAX_REQUEST_BYTES);
    if (
      written.isSymbolicLink() ||
      !written.isFile() ||
      (written.mode & 0o777) !== 0o400 ||
      (typeof process.getuid === 'function' &&
        written.uid !== process.getuid()) ||
      written.dev !== identity.dev ||
      written.ino !== identity.ino ||
      !read.ok ||
      !read.bytes.equals(bytes)
    )
      throw new Error('managed_config_verification_failed');
    return { ok: true, digest: read.digest };
  } catch {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        /* best effort */
      }
    }
    if (identity !== undefined) {
      try {
        const current = fs.lstatSync(paths.configPath);
        if (
          current.isFile() &&
          !current.isSymbolicLink() &&
          current.dev === identity.dev &&
          current.ino === identity.ino
        )
          fs.unlinkSync(paths.configPath);
      } catch {
        /* preserve unrelated replacements */
      }
    }
    return { ok: false, code: 'managed_config_write_failed' };
  }
}

function sameDirectoryIdentity(
  expected: {
    readonly path: string;
    readonly dev: number;
    readonly ino: number;
  },
  candidate: string,
): boolean {
  try {
    const stat = fs.lstatSync(candidate);
    return (
      !stat.isSymbolicLink() &&
      stat.isDirectory() &&
      fs.realpathSync(candidate) === expected.path &&
      stat.dev === expected.dev &&
      stat.ino === expected.ino
    );
  } catch {
    return false;
  }
}

function sameFileIdentity(
  expected: OpenedMessageTask['identity']['recordFile'],
): boolean {
  try {
    const stat = fs.lstatSync(expected.path);
    return (
      !stat.isSymbolicLink() &&
      stat.isFile() &&
      fs.realpathSync(expected.path) === expected.path &&
      stat.dev === expected.dev &&
      stat.ino === expected.ino
    );
  } catch {
    return false;
  }
}
function sameIdentity(
  left: Identity | null | undefined,
  right: Identity | null | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    left.agent_id === right.agent_id &&
    left.session_id === right.session_id &&
    left.harness === right.harness,
  );
}
function generatedHerdrAgent(requestId: string): string {
  return `pappra-${crypto.createHash('sha256').update(requestId).digest('hex').slice(0, 8)}`;
}
function requestOf(
  value: LoadedVisibleBootstrapRequest | VisibleBootstrapRequest,
): VisibleBootstrapRequest {
  return 'request' in value ? value.request : value;
}
function requestDigestOf(
  value: LoadedVisibleBootstrapRequest | VisibleBootstrapRequest,
): string {
  return 'request' in value ? value.digest : digestText(JSON.stringify(value));
}
function requestFileOf(
  value: LoadedVisibleBootstrapRequest | VisibleBootstrapRequest,
): string | null {
  return 'request' in value ? value.file : null;
}

function failureReport(
  action: BootstrapAction,
  request: VisibleBootstrapRequest | null,
  requestDigest: string | null,
  status: BootstrapStatus,
  code: string,
  message: string,
  nextAction: string | null = null,
  extra: Partial<VisibleBootstrapReport> = {},
): VisibleBootstrapReport {
  return {
    schema: COLLAB_BOOTSTRAP_REPORT_SCHEMA,
    action,
    ok: false,
    status,
    code,
    message,
    next_action: nextAction,
    request_id: request?.request_id ?? null,
    request_digest: requestDigest,
    task_id: request === null ? null : path.basename(request.task_root),
    task_root: request?.task_root ?? null,
    state_revision: null,
    caller: null,
    participant:
      request === null
        ? null
        : {
            agent_id: request.participant.agent_id,
            harness: request.participant.harness,
            session_id: request.participant.native_session_selector,
          },
    target: request === null ? null : { ...request.target },
    bootstrap: null,
    reservation: null,
    readiness: null,
    effects: [],
    notification: null,
    downstream: {
      host_stop_proof: 'unavailable',
      first_work: 'unverified',
      routing_removal: 'pending',
      native_archive: 'unavailable',
    },
    limits: [
      'capability_cards_are_readiness_not_authority',
      'notification_submission_is_not_consumption_or_task_acceptance',
      'native_stop_proof_and_full_takeover_are_out_of_scope',
    ],
    ...extra,
  };
}

function successReport(
  action: BootstrapAction,
  request: VisibleBootstrapRequest,
  requestDigest: string,
  status: BootstrapStatus,
  extra: Partial<VisibleBootstrapReport> = {},
): VisibleBootstrapReport {
  return {
    schema: COLLAB_BOOTSTRAP_REPORT_SCHEMA,
    action,
    ok:
      status === 'planned' ||
      status === 'applied' ||
      status === 'already_recorded',
    status,
    code: null,
    message: null,
    next_action: null,
    request_id: request.request_id,
    request_digest: requestDigest,
    task_id: path.basename(request.task_root),
    task_root: request.task_root,
    state_revision: null,
    caller: null,
    participant: {
      agent_id: request.participant.agent_id,
      harness: request.participant.harness,
      session_id: request.participant.native_session_selector,
    },
    target: { ...request.target },
    bootstrap: null,
    reservation: null,
    readiness: null,
    effects: [],
    notification: null,
    downstream: {
      host_stop_proof: 'unavailable',
      first_work: 'unverified',
      routing_removal: 'pending',
      native_archive: 'unavailable',
    },
    limits: [
      'new-session-registration_and_capabilities_are_not_independently_proven',
      'notification_submission_is_not_consumption_or_task_acceptance',
      'host_stop_proof_and_full_takeover_are_out_of_scope',
    ],
    ...extra,
  };
}

export function validateVisibleBootstrapRequest(
  value: unknown,
):
  | { readonly ok: true; readonly request: VisibleBootstrapRequest }
  | { readonly ok: false; readonly code: string; readonly message: string } {
  const topKeys = [
    'schema',
    'action',
    'request_id',
    'task_root',
    'admission',
    'caller',
    'participant',
    'target',
    'selected_model',
    'bootstrap',
    'message_pointer',
    'binding_ref',
    'readiness',
    'managed_runtime',
  ];
  if (!isRecord(value) || !hasOnlyKeys(value, topKeys))
    return {
      ok: false,
      code: 'request_shape_invalid',
      message: 'Request must be an object with only the documented fields.',
    };
  if (value['schema'] !== COLLAB_BOOTSTRAP_REQUEST_SCHEMA)
    return {
      ok: false,
      code: 'request_schema_invalid',
      message: `request.schema must be ${COLLAB_BOOTSTRAP_REQUEST_SCHEMA}.`,
    };
  if (value['action'] !== undefined && value['action'] !== 'apply')
    return {
      ok: false,
      code: 'request_action_invalid',
      message:
        'Request action, when present, must be apply; the CLI action is authoritative.',
    };
  const requestId = value['request_id'];
  const taskRoot = value['task_root'];
  if (!isText(requestId, 128) || !SAFE_ID.test(requestId))
    return {
      ok: false,
      code: 'request_id_invalid',
      message: 'request_id must be a safe short idempotency key.',
    };
  if (!isText(taskRoot, 4096) || !path.isAbsolute(taskRoot))
    return {
      ok: false,
      code: 'task_root_invalid',
      message: 'task_root must be an absolute path.',
    };
  const admission = value['admission'];
  if (
    !isRecord(admission) ||
    !hasOnlyKeys(admission, [
      'assignment_id',
      'subtask_id',
      'attempt',
      'input_revision',
      'capability_card_ref',
      'capability_card_digest',
    ]) ||
    !isText(admission['assignment_id'], 128) ||
    !SAFE_ID.test(admission['assignment_id']) ||
    !isText(admission['subtask_id'], 128) ||
    !SAFE_ID.test(admission['subtask_id']) ||
    typeof admission['attempt'] !== 'number' ||
    !Number.isSafeInteger(admission['attempt']) ||
    admission['attempt'] < 1 ||
    !isText(admission['input_revision'], 256) ||
    !isText(admission['capability_card_ref'], 4096) ||
    !path.isAbsolute(admission['capability_card_ref']) ||
    !isText(admission['capability_card_digest'], 71) ||
    !DIGEST.test(admission['capability_card_digest'])
  )
    return {
      ok: false,
      code: 'admission_invalid',
      message:
        'admission must pin one exact attempt, input revision and absolute capability-card file/digest.',
    };
  const caller = value['caller'];
  if (
    !isRecord(caller) ||
    !hasOnlyKeys(caller, ['require_herdr_env', 'pane_id']) ||
    caller['require_herdr_env'] !== true ||
    !(
      caller['pane_id'] === undefined ||
      caller['pane_id'] === null ||
      (isText(caller['pane_id'], 64) && PANE_ID.test(caller['pane_id']))
    )
  )
    return {
      ok: false,
      code: 'caller_invalid',
      message:
        'caller must require Herdr and may name only an explicit caller pane.',
    };
  const participant = value['participant'];
  if (
    !isRecord(participant) ||
    !hasOnlyKeys(participant, [
      'agent_id',
      'harness',
      'native_session_selector',
      'herdr_agent',
      'capability_card_ref',
      'capability_card_digest',
    ]) ||
    !isText(participant['agent_id'], 128) ||
    participant['harness'] !== 'pi' ||
    !isText(participant['native_session_selector'], 256) ||
    !UUID.test(participant['native_session_selector']) ||
    (participant['herdr_agent'] !== undefined &&
      (!isText(participant['herdr_agent'], 32) ||
        !HERDR_AGENT_NAME.test(participant['herdr_agent']))) ||
    (participant['capability_card_ref'] !== undefined) !==
      (participant['capability_card_digest'] !== undefined) ||
    (participant['capability_card_ref'] !== undefined &&
      (!isText(participant['capability_card_ref'], 4096) ||
        !path.isAbsolute(participant['capability_card_ref']) ||
        !isText(participant['capability_card_digest'], 71) ||
        !DIGEST.test(participant['capability_card_digest'])))
  )
    return {
      ok: false,
      code: 'participant_invalid',
      message:
        'participant must name a Pi identity with a fixed native session UUID.',
    };
  const target = value['target'];
  if (
    !isRecord(target) ||
    !hasOnlyKeys(target, [
      'choice',
      'cwd',
      'direction',
      'preserve_focus',
      'start_timeout_ms',
    ]) ||
    (target['choice'] !== 'reuse' && target['choice'] !== 'sibling') ||
    !isText(target['cwd'], 4096) ||
    !path.isAbsolute(target['cwd']) ||
    target['preserve_focus'] !== true ||
    (target['start_timeout_ms'] !== undefined &&
      (!Number.isSafeInteger(target['start_timeout_ms']) ||
        Number(target['start_timeout_ms']) < 1 ||
        Number(target['start_timeout_ms']) > MAX_START_TIMEOUT_MS)) ||
    (target['direction'] !== undefined &&
      target['direction'] !== 'right' &&
      target['direction'] !== 'down')
  )
    return {
      ok: false,
      code: 'target_invalid',
      message:
        'target must explicitly choose reuse or sibling, provide an absolute cwd and preserve focus.',
    };
  const selectedModel = value['selected_model'];
  if (
    !isRecord(selectedModel) ||
    !hasOnlyKeys(selectedModel, ['preserve_daily', 'openrouter_model']) ||
    selectedModel['preserve_daily'] !== true ||
    (selectedModel['openrouter_model'] !== undefined &&
      (target['choice'] !== 'sibling' ||
        typeof selectedModel['openrouter_model'] !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(
          selectedModel['openrouter_model'],
        )))
  )
    return {
      ok: false,
      code: 'model_override_refused',
      message:
        'Preserve daily settings; an explicit OpenRouter model requires a fresh sibling launch.',
    };
  const managedRuntime = value['managed_runtime'];
  if (
    managedRuntime !== undefined &&
    (!isRecord(managedRuntime) ||
      !hasOnlyKeys(managedRuntime, [
        'sdk_module_path',
        'journal_path',
        'automatic_handoff_file',
        'handoff_context_file',
      ]) ||
      !isText(managedRuntime['sdk_module_path'], 4096) ||
      !path.isAbsolute(managedRuntime['sdk_module_path']) ||
      hasUnsafePathCharacters(managedRuntime['sdk_module_path']) ||
      !isText(managedRuntime['journal_path'], 4096) ||
      !path.isAbsolute(managedRuntime['journal_path']) ||
      hasUnsafePathCharacters(managedRuntime['journal_path']) ||
      (managedRuntime['automatic_handoff_file'] !== undefined &&
        (!isText(managedRuntime['automatic_handoff_file'], 4096) ||
          !path.isAbsolute(managedRuntime['automatic_handoff_file']) ||
          hasUnsafePathCharacters(managedRuntime['automatic_handoff_file']))) ||
      (managedRuntime['handoff_context_file'] !== undefined &&
        (!isText(managedRuntime['handoff_context_file'], 4096) ||
          !path.isAbsolute(managedRuntime['handoff_context_file']) ||
          hasUnsafePathCharacters(managedRuntime['handoff_context_file']))) ||
      target['choice'] !== 'sibling' ||
      typeof selectedModel['openrouter_model'] !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(
        selectedModel['openrouter_model'],
      ))
  )
    return {
      ok: false,
      code: 'managed_runtime_invalid',
      message:
        'managed_runtime requires a fresh sibling, an explicit OpenRouter model and absolute SDK/journal paths and an optional absolute future config path.',
    };
  const bootstrap = value['bootstrap'];
  if (
    !isRecord(bootstrap) ||
    !hasOnlyKeys(bootstrap, [
      'config_ref',
      'config_digest',
      'bundle_ref',
      'bundle_digest',
      'extension_entry',
    ]) ||
    !isText(bootstrap['config_ref'], 4096) ||
    !path.isAbsolute(bootstrap['config_ref']) ||
    !isText(bootstrap['config_digest'], 71) ||
    !DIGEST.test(bootstrap['config_digest']) ||
    !isText(bootstrap['bundle_ref'], 4096) ||
    !path.isAbsolute(bootstrap['bundle_ref']) ||
    !isText(bootstrap['bundle_digest'], 71) ||
    !DIGEST.test(bootstrap['bundle_digest']) ||
    !isText(bootstrap['extension_entry'], 4096) ||
    !path.isAbsolute(bootstrap['extension_entry'])
  )
    return {
      ok: false,
      code: 'bootstrap_invalid',
      message:
        'bootstrap must pin an absolute exported bundle, manifest digest, config digest and extension entry.',
    };
  const pointer = value['message_pointer'];
  if (
    !isRecord(pointer) ||
    !hasOnlyKeys(pointer, ['message_id', 'content_ref', 'content_digest']) ||
    !isText(pointer['message_id'], 256) ||
    !isText(pointer['content_ref'], 4096) ||
    !path.isAbsolute(pointer['content_ref']) ||
    !isText(pointer['content_digest'], 71) ||
    !DIGEST.test(pointer['content_digest'])
  )
    return {
      ok: false,
      code: 'message_pointer_invalid',
      message:
        'message_pointer must identify a registered message file and exact content digest.',
    };
  const bindingRef = value['binding_ref'];
  if (
    bindingRef !== undefined &&
    (!isText(bindingRef, 4096) || !path.isAbsolute(bindingRef))
  )
    return {
      ok: false,
      code: 'binding_ref_invalid',
      message:
        'binding_ref, when supplied, must be an absolute task-local routing-binding path.',
    };
  const readiness = value['readiness'];
  if (
    readiness !== undefined &&
    (!isRecord(readiness) ||
      !hasOnlyKeys(readiness, ['budget_ms', 'interval_ms', 'max_samples']) ||
      (readiness['budget_ms'] !== undefined &&
        (typeof readiness['budget_ms'] !== 'number' ||
          !Number.isSafeInteger(readiness['budget_ms']) ||
          readiness['budget_ms'] < 1 ||
          readiness['budget_ms'] > 10_000)) ||
      (readiness['interval_ms'] !== undefined &&
        (typeof readiness['interval_ms'] !== 'number' ||
          !Number.isSafeInteger(readiness['interval_ms']) ||
          readiness['interval_ms'] < 1 ||
          readiness['interval_ms'] > 100)) ||
      (readiness['max_samples'] !== undefined &&
        (typeof readiness['max_samples'] !== 'number' ||
          !Number.isSafeInteger(readiness['max_samples']) ||
          readiness['max_samples'] < 1 ||
          readiness['max_samples'] > 100)))
  )
    return {
      ok: false,
      code: 'readiness_invalid',
      message:
        'readiness may only tighten the 10s/100ms/100-sample upper bounds.',
    };
  return {
    ok: true,
    request: {
      schema: COLLAB_BOOTSTRAP_REQUEST_SCHEMA,
      ...(value['action'] === 'apply' ? { action: 'apply' as const } : {}),
      request_id: requestId,
      task_root: taskRoot,
      admission: admission as unknown as VisibleBootstrapRequest['admission'],
      caller: {
        require_herdr_env: true,
        pane_id:
          typeof caller['pane_id'] === 'string' ? caller['pane_id'] : null,
      },
      participant:
        participant as unknown as VisibleBootstrapRequest['participant'],
      target: target as unknown as VisibleBootstrapRequest['target'],
      selected_model: {
        preserve_daily: true,
        ...(typeof selectedModel['openrouter_model'] === 'string'
          ? { openrouter_model: selectedModel['openrouter_model'] }
          : {}),
      },
      ...(managedRuntime === undefined
        ? {}
        : {
            managed_runtime: {
              sdk_module_path: managedRuntime['sdk_module_path'] as string,
              journal_path: managedRuntime['journal_path'] as string,
              ...(typeof managedRuntime['automatic_handoff_file'] === 'string'
                ? {
                    automatic_handoff_file:
                      managedRuntime['automatic_handoff_file'],
                  }
                : {}),
              ...(typeof managedRuntime['handoff_context_file'] === 'string'
                ? {
                    handoff_context_file:
                      managedRuntime['handoff_context_file'],
                  }
                : {}),
            },
          }),
      bootstrap: bootstrap as unknown as VisibleBootstrapRequest['bootstrap'],
      message_pointer:
        pointer as unknown as VisibleBootstrapRequest['message_pointer'],
      ...(typeof bindingRef === 'string' ? { binding_ref: bindingRef } : {}),
      ...(readiness === undefined
        ? {}
        : {
            readiness: readiness as NonNullable<
              VisibleBootstrapRequest['readiness']
            >,
          }),
    },
  };
}

export function loadVisibleBootstrapRequest(
  file: string,
): BootstrapRequestLoadResult {
  const read = readBoundedFile(file, MAX_REQUEST_BYTES);
  if (!read.ok)
    return {
      ok: false,
      code: 'request_unreadable',
      message: `Request must be an absolute bounded regular JSON file (${read.code}).`,
    };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text) as unknown;
  } catch {
    return {
      ok: false,
      code: 'request_invalid_json',
      message: 'Request is not valid JSON.',
    };
  }
  const validated = validateVisibleBootstrapRequest(parsed);
  return validated.ok
    ? {
        ok: true,
        value: { request: validated.request, digest: read.digest, file },
      }
    : validated;
}

function readJson(
  file: string,
  maxBytes: number,
):
  | {
      readonly ok: true;
      readonly value: unknown;
      readonly digest: string;
      readonly bytes: Buffer;
    }
  | { readonly ok: false; readonly code: string } {
  const read = readBoundedFile(file, maxBytes);
  if (!read.ok) return { ok: false, code: read.code };
  try {
    return {
      ok: true,
      value: JSON.parse(read.text) as unknown,
      digest: read.digest,
      bytes: read.bytes,
    };
  } catch {
    return { ok: false, code: 'invalid_json' };
  }
}

function readAssignment(
  file: string,
  attempt: Attempt,
  record?: TaskRecord,
):
  | {
      readonly ok: true;
      readonly assignment: Assignment;
      readonly digest: string;
      readonly file: string;
      readonly admissionDigest: string;
    }
  | { readonly ok: false; readonly code: string; readonly message: string } {
  const read = readJson(file, MAX_ASSIGNMENT_BYTES);
  if (!read.ok)
    return {
      ok: false,
      code: 'assignment_unreadable',
      message: `Recorded assignment is not a bounded regular JSON file (${read.code}).`,
    };
  if (attempt.assignment_digest !== read.digest)
    return {
      ok: false,
      code: 'assignment_digest_mismatch',
      message: 'Recorded assignment digest differs from current bytes.',
    };
  if (!isAssignment(read.value))
    return {
      ok: false,
      code: 'assignment_invalid',
      message: 'Recorded assignment schema is invalid.',
    };
  if (
    record &&
    (read.value.assignee.agent_id !== attempt.assignee.agent_id ||
      read.value.assignee.session_id !== attempt.assignee.session_id)
  ) {
    try {
      const current = readManagedSourceAssignment(record, attempt);
      return {
        ok: true,
        assignment: current.assignment,
        digest: current.originalDigest,
        file: current.file,
        admissionDigest: current.digest,
      };
    } catch {
      return {
        ok: false,
        code: 'source_admission_unverified',
        message:
          'Current source admission does not derive from a completed verified succession.',
      };
    }
  }
  return {
    ok: true,
    assignment: read.value,
    digest: read.digest,
    file,
    admissionDigest: read.digest,
  };
}

function readCapabilityCard(
  file: string,
  digest: string,
):
  | { readonly ok: true; readonly card: CapabilityCard }
  | { readonly ok: false; readonly code: string; readonly message: string } {
  const read = readJson(file, MAX_CARD_BYTES);
  if (!read.ok)
    return {
      ok: false,
      code: 'capability_card_unreadable',
      message: `Capability card is not a bounded regular JSON file (${read.code}).`,
    };
  if (read.digest !== digest)
    return {
      ok: false,
      code: 'capability_card_digest_mismatch',
      message: 'Capability card bytes do not match the request digest.',
    };
  if (!isCard(read.value))
    return {
      ok: false,
      code: 'capability_card_invalid',
      message: 'Capability card schema is invalid.',
    };
  return { ok: true, card: read.value };
}

function readBinding(
  file: string,
  taskRoot: string,
  taskId: string,
):
  | {
      readonly ok: true;
      readonly binding: CollabBinding;
      readonly file: string;
      readonly digest: string;
    }
  | { readonly ok: false; readonly code: string; readonly message: string } {
  const read = readJson(file, MAX_BINDING_BYTES);
  if (!read.ok)
    return {
      ok: false,
      code: 'binding_unreadable',
      message: `Binding must be a bounded regular JSON file (${read.code}).`,
    };
  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch {
    return {
      ok: false,
      code: 'binding_unreadable',
      message: 'Binding path could not be resolved.',
    };
  }
  if (!isPathInside(taskRoot, real))
    return {
      ok: false,
      code: 'binding_not_task_local',
      message: 'Binding must be inside the canonical task root.',
    };
  const parsed = collabBindingSchema.safeParse(read.value);
  if (!parsed.success)
    return {
      ok: false,
      code: 'binding_invalid',
      message: 'Binding does not match pappra/collab-binding/1.',
    };
  if (
    parsed.data.task_id !== taskId ||
    !safePathEqual(parsed.data.task_root, taskRoot)
  )
    return {
      ok: false,
      code: 'binding_identity_mismatch',
      message: 'Binding task identity/root does not match the current task.',
    };
  const agents = new Set<string>();
  const names = new Set<string>();
  for (const item of parsed.data.participants) {
    if (agents.has(item.agent_id) || names.has(item.herdr_agent))
      return {
        ok: false,
        code: 'binding_ambiguous',
        message: 'Binding repeats an agent id or Herdr name.',
      };
    agents.add(item.agent_id);
    names.add(item.herdr_agent);
  }
  return { ok: true, binding: parsed.data, file: real, digest: read.digest };
}

function readBundle(
  root: string,
):
  | { readonly ok: true; readonly bundle: BundleSnapshot }
  | { readonly ok: false; readonly code: string; readonly message: string } {
  let canonicalRoot: string;
  try {
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      return {
        ok: false,
        code: 'bundle_root_unsafe',
        message: 'Bundle root must be a real directory, not a symlink.',
      };
    canonicalRoot = fs.realpathSync(root);
  } catch {
    return {
      ok: false,
      code: 'bundle_root_unavailable',
      message: 'Bundle root could not be inspected.',
    };
  }
  const entries: { path: string; digest: string }[] = [];
  const files = new Map<string, BundleFile>();
  let totalBytes = 0;
  const visit = (directory: string, relative: string): string | null => {
    let names: string[];
    try {
      names = fs.readdirSync(directory).sort();
    } catch {
      return 'bundle_directory_unreadable';
    }
    for (const name of names) {
      const file = path.join(directory, name);
      const rel = relative === '' ? name : `${relative}/${name}`;
      if (!isPathInside(canonicalRoot, file)) return 'bundle_path_escape';
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(file);
      } catch {
        return 'bundle_entry_unreadable';
      }
      if (stat.isSymbolicLink()) return 'bundle_symlink_refused';
      if (stat.isDirectory()) {
        const nested = visit(file, rel);
        if (nested !== null) return nested;
        continue;
      }
      if (!stat.isFile()) return 'bundle_special_file_refused';
      if (stat.size > MAX_BUNDLE_FILE_BYTES) return 'bundle_file_too_large';
      totalBytes += stat.size;
      if (totalBytes > MAX_BUNDLE_TOTAL_BYTES) return 'bundle_too_large';
      const read = readBoundedFile(file, MAX_BUNDLE_FILE_BYTES);
      if (!read.ok) return `bundle_file_${read.code}`;
      entries.push({ path: rel, digest: read.digest });
      files.set(rel, { bytes: read.bytes, digest: read.digest });
      if (entries.length > MAX_BUNDLE_FILES)
        return 'bundle_file_count_exceeded';
    }
    return null;
  };
  const problem = visit(canonicalRoot, '');
  if (problem !== null)
    return {
      ok: false,
      code: problem,
      message: `Bundle manifest rejected (${problem}).`,
    };
  entries.sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.path, 'utf8'),
      Buffer.from(right.path, 'utf8'),
    ),
  );
  return {
    ok: true,
    bundle: {
      root: canonicalRoot,
      digest: digestText(JSON.stringify(entries)),
      entries,
      files,
    },
  };
}

function bindingParticipant(
  binding: CollabBinding,
  agentId: string,
): CollabBindingParticipant | null {
  const matches = binding.participants.filter(
    (participant) => participant.agent_id === agentId,
  );
  return matches.length === 1 ? matches[0]! : null;
}
function herdrNameForRequest(request: VisibleBootstrapRequest): string {
  return (
    request.participant.herdr_agent ?? generatedHerdrAgent(request.request_id)
  );
}

function matchConfigToTask(
  request: VisibleBootstrapRequest,
  record: TaskRecord,
  attempt: Attempt,
  assignment: Assignment,
  config: NonNullable<BootstrapContext['config']>,
):
  | {
      readonly ok: true;
      readonly intent: RolloverIntent;
      readonly handoffState: string;
    }
  | { readonly ok: false; readonly code: string; readonly message: string } {
  const guard = config.guard;
  if (config.taskId !== record.task_id || assignment.task_id !== record.task_id)
    return {
      ok: false,
      code: 'config_task_mismatch',
      message: 'Config, assignment and current task id must agree.',
    };
  if (
    guard.taskId !== record.task_id ||
    guard.subtaskId !== request.admission.subtask_id ||
    guard.attempt !== request.admission.attempt ||
    guard.inputRevision !== request.admission.input_revision
  )
    return {
      ok: false,
      code: 'config_attempt_mismatch',
      message:
        'Bootstrap config must pin the exact requested task attempt/input revision.',
    };
  if (
    guard.coordinatorEpoch !== assignment.coordinator.owner_epoch ||
    attempt.owner_epoch !== guard.coordinatorEpoch ||
    record.coordinator?.owner_epoch !== guard.coordinatorEpoch
  )
    return {
      ok: false,
      code: 'coordinator_epoch_mismatch',
      message:
        'Config, assignment, attempt and current task coordinator epochs must agree.',
    };
  const found = (record.rollover ?? []).filter(
    (intent) => intent.intent_id === guard.intentId,
  );
  if (found.length !== 1)
    return {
      ok: false,
      code: 'rollover_intent_missing_or_ambiguous',
      message: 'The exact config-pinned rollover intent must exist once.',
    };
  const intent = found[0]!;
  if (
    intent.task_id !== record.task_id ||
    intent.handoff_id !== guard.handoffId ||
    intent.generation !== guard.generation ||
    intent.subtask_id !== guard.subtaskId ||
    intent.attempt !== guard.attempt ||
    intent.input_revision !== guard.inputRevision ||
    intent.coordinator_epoch !== guard.coordinatorEpoch ||
    !sameIdentity(intent.to, {
      agent_id: guard.successor.agentId,
      session_id: guard.successor.sessionId,
      harness: guard.successor.harness,
    })
  )
    return {
      ok: false,
      code: 'rollover_intent_mismatch',
      message: 'Recorded rollover intent does not match the accepted config.',
    };
  if (
    request.participant.agent_id !== guard.successor.agentId ||
    request.participant.harness !== guard.successor.harness ||
    request.participant.native_session_selector !== guard.successor.sessionId
  )
    return {
      ok: false,
      code: 'participant_config_mismatch',
      message:
        'Requested participant must exactly match the config-pinned successor identity.',
    };
  const intentClaims = [...intent.claims]
    .map((claim) => ({ claim_id: claim.claim_id, epoch: claim.resource_epoch }))
    .sort((left, right) =>
      left.claim_id < right.claim_id
        ? -1
        : left.claim_id > right.claim_id
          ? 1
          : 0,
    );
  const configClaims = [...guard.claims]
    .map((claim) => ({
      claim_id: claim.claimId,
      epoch: claim.originalResourceEpoch,
    }))
    .sort((left, right) =>
      left.claim_id < right.claim_id
        ? -1
        : left.claim_id > right.claim_id
          ? 1
          : 0,
    );
  if (JSON.stringify(intentClaims) !== JSON.stringify(configClaims))
    return {
      ok: false,
      code: 'config_claims_mismatch',
      message: 'Config claim pins do not match the recorded rollover intent.',
    };
  const handoffs = (record.handoffs ?? []).filter(
    (handoff) => handoff.handoff_id === intent.handoff_id,
  );
  if (handoffs.length !== 1)
    return {
      ok: false,
      code: 'handoff_missing_or_ambiguous',
      message: 'The exact intent must have one recorded handoff.',
    };
  const handoff = handoffs[0]!;
  if (handoff.state === 'aborted')
    return {
      ok: false,
      code: 'handoff_aborted',
      message: 'The recorded handoff was aborted; bootstrap is refused.',
    };
  let sourceClaims = true;
  let successorClaims = true;
  for (const ref of intent.claims) {
    const matches = (record.claims ?? []).filter(
      (claim) => claim.claim_id === ref.claim_id,
    );
    if (matches.length !== 1)
      return {
        ok: false,
        code: 'claim_missing_or_ambiguous',
        message: `Claim ${ref.claim_id} is missing or ambiguous.`,
      };
    const claim = matches[0]!;
    if (claim.released_at !== null)
      return {
        ok: false,
        code: 'claim_released',
        message: `Claim ${ref.claim_id} was released.`,
      };
    sourceClaims &&=
      claim.resource_epoch === ref.resource_epoch &&
      sameIdentity(claim.holder, intent.from);
    successorClaims &&=
      claim.resource_epoch === ref.resource_epoch + 1 &&
      sameIdentity(claim.holder, intent.to);
  }
  if (!sourceClaims && !successorClaims)
    return {
      ok: false,
      code: 'claim_drift',
      message:
        'Current claims are neither the pinned source stage nor the complete successor-transfer stage.',
    };
  if (handoff.state === 'completed' && !successorClaims)
    return {
      ok: false,
      code: 'completed_handoff_claim_mismatch',
      message: 'Completed handoff does not have the exact successor claim set.',
    };
  if (
    successorClaims &&
    handoff.state !== 'completed' &&
    handoff.state !== 'transferring' &&
    handoff.state !== 'receiver_confirmed'
  )
    return {
      ok: false,
      code: 'handoff_claim_stage_mismatch',
      message:
        'Successor claims are present outside a recorded transfer stage.',
    };
  return { ok: true, intent, handoffState: handoff.state };
}

function bundleFile(
  bundle: BundleSnapshot,
  relative: string,
): BundleFile | null {
  return bundle.files.get(relative) ?? null;
}

function verifyBootstrapBundle(
  request: VisibleBootstrapRequest,
  configDigest: string,
  dependencies: VisibleBootstrapDependencies,
):
  | { readonly ok: true; readonly bundle: BundleSnapshot }
  | { readonly ok: false; readonly code: string; readonly message: string } {
  const loaded = readBundle(request.bootstrap.bundle_ref);
  if (!loaded.ok) return loaded;
  const bundle = loaded.bundle;
  if (bundle.digest !== request.bootstrap.bundle_digest)
    return {
      ok: false,
      code: 'bundle_manifest_digest_mismatch',
      message: 'Bundle manifest digest differs from the pinned request.',
    };
  const configRel = 'extensions/pappra-bootstrap/bootstrap.json';
  const entryRel = 'extensions/pappra-bootstrap/index.ts';
  const runtimeRel = 'extensions/pappra-bootstrap/runtime.mjs';
  if (
    !safePathEqual(
      request.bootstrap.config_ref,
      path.join(bundle.root, configRel),
    ) ||
    !safePathEqual(
      request.bootstrap.extension_entry,
      path.join(bundle.root, entryRel),
    )
  )
    return {
      ok: false,
      code: 'bootstrap_paths_mismatch',
      message:
        'Config and entry must be the exact co-located exported bundle files.',
    };
  const config = bundleFile(bundle, configRel);
  const entry = bundleFile(bundle, entryRel);
  const runtime = bundleFile(bundle, runtimeRel);
  if (
    config === null ||
    entry === null ||
    runtime === null ||
    config.digest !== configDigest
  )
    return {
      ok: false,
      code: 'bootstrap_bundle_incomplete',
      message: 'Bundle lacks the pinned config, entry or runtime bytes.',
    };
  if (entry.bytes.toString('utf8').trimEnd() !== BOOTSTRAP_ENTRY_SOURCE)
    return {
      ok: false,
      code: 'bootstrap_entry_mismatch',
      message:
        'Bundle entry is not the accepted generated Pi bootstrap wrapper.',
    };
  const artifactPath =
    dependencies.acceptedArtifactPath ??
    path.join(
      getPackageRoot(),
      'dist/hosts/integration/pappra-bootstrap-extension.mjs',
    );
  const artifact = readBoundedFile(artifactPath, MAX_BUNDLE_FILE_BYTES);
  if (!artifact.ok)
    return {
      ok: false,
      code: 'accepted_artifact_unavailable',
      message: `Accepted bootstrap artifact is unavailable (${artifact.code}).`,
    };
  if (runtime.digest !== artifact.digest)
    return {
      ok: false,
      code: 'bootstrap_runtime_mismatch',
      message:
        'Bundle runtime bytes differ from the accepted bootstrap artifact.',
    };
  const manifest = bundleFile(bundle, 'package.json');
  if (manifest === null)
    return {
      ok: false,
      code: 'bundle_package_manifest_missing',
      message: 'Bundle package.json is missing.',
    };
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(manifest.bytes.toString('utf8')) as unknown;
  } catch {
    return {
      ok: false,
      code: 'bundle_package_manifest_invalid',
      message: 'Bundle package.json is not valid JSON.',
    };
  }
  if (
    !isRecord(packageJson) ||
    packageJson['name'] !== '@phyzess/pappra-pi-bootstrap' ||
    !isRecord(packageJson['pi']) ||
    !Array.isArray(packageJson['pi']['extensions']) ||
    !packageJson['pi']['extensions'].includes(
      './extensions/pappra-bootstrap/index.ts',
    )
  )
    return {
      ok: false,
      code: 'bundle_package_manifest_mismatch',
      message:
        'Bundle package manifest does not register the accepted bootstrap entry.',
    };
  return { ok: true, bundle };
}

function messageAndBindingFailure(
  request: VisibleBootstrapRequest,
  record: TaskRecord,
  message: BootstrapContext['message'],
  binding: CollabBinding,
):
  | { readonly ok: true; readonly sender: CollabBindingParticipant }
  | { readonly ok: false; readonly code: string; readonly message: string } {
  if (
    message.task_id !== record.task_id ||
    message.to.agent_id !== request.participant.agent_id ||
    message.to.harness !== request.participant.harness ||
    message.to.session_id !== request.participant.native_session_selector
  )
    return {
      ok: false,
      code: 'message_recipient_mismatch',
      message:
        'Registered first-contact message must target the exact requested participant/session.',
    };
  if (
    message.subtask_id !== request.admission.subtask_id ||
    message.attempt !== request.admission.attempt
  )
    return {
      ok: false,
      code: 'message_attempt_mismatch',
      message:
        'Registered message must target the exact admitted subtask attempt.',
    };
  const inputRevision = message.body.input_revision;
  if (
    inputRevision !== null &&
    inputRevision !== undefined &&
    inputRevision !== request.admission.input_revision
  )
    return {
      ok: false,
      code: 'message_input_revision_mismatch',
      message:
        'Registered message input revision differs from the admitted attempt.',
    };
  const senders = binding.participants.filter(
    (participant) => participant.agent_id === message.from.agent_id,
  );
  if (
    senders.length !== 1 ||
    senders[0]!.harness !== message.from.harness ||
    (senders[0]!.native_session_id !== null &&
      senders[0]!.native_session_id !== message.from.session_id)
  )
    return {
      ok: false,
      code: 'message_sender_binding_mismatch',
      message: 'Binding must identify the registered sender and exact session.',
    };
  return { ok: true, sender: senders[0]! };
}

function liveParticipant(
  bindingParticipant: CollabBindingParticipant,
  expected: Identity,
  agents: readonly HerdrAgentObservation[],
):
  | { readonly ok: true; readonly agent: HerdrAgentObservation }
  | { readonly ok: false; readonly code: string; readonly message: string } {
  const matches = agents.filter(
    (agent) => agent.name === bindingParticipant.herdr_agent,
  );
  if (matches.length !== 1)
    return {
      ok: false,
      code: 'participant_not_unique',
      message: 'Herdr must report exactly one task-bound participant.',
    };
  const agent = matches[0]!;
  if (
    agent.paneId !== bindingParticipant.pane_id ||
    agent.harness !== bindingParticipant.harness ||
    agent.cwd === null ||
    !safePathEqual(agent.cwd, bindingParticipant.cwd)
  )
    return {
      ok: false,
      code: 'participant_binding_drift',
      message: 'Live Herdr participant does not match the task-local binding.',
    };
  const observed = reportedSessionIdentity(
    agent.sessionKind,
    agent.sessionValue,
  );
  if (observed.status !== 'match' || observed.identity !== expected.session_id)
    return {
      ok: false,
      code: 'participant_session_unconfirmed',
      message: 'Live Herdr metadata does not confirm the exact native session.',
    };
  if (
    expected.agent_id !== bindingParticipant.agent_id ||
    expected.harness !== bindingParticipant.harness
  )
    return {
      ok: false,
      code: 'participant_identity_mismatch',
      message:
        'Task-local participant identity does not match the registered message.',
    };
  return { ok: true, agent };
}

function participantCardIssue(
  card: CapabilityCard,
  assignment: Assignment,
  participant: VisibleBootstrapRequest['participant'],
  cwd: string,
  now: number,
): string | null {
  if (
    card.agent_id !== participant.agent_id ||
    card.harness !== participant.harness ||
    card.session_id !== participant.native_session_selector ||
    card.evidence_level !== 'runtime' ||
    !safePathEqual(card.cwd, cwd)
  )
    return 'reuse_card_identity_mismatch';
  const age = now - Date.parse(card.observed_at);
  if (!Number.isFinite(age) || age > 30 * 60_000 || age < -60_000)
    return 'reuse_card_stale';
  for (const required of assignment.required.tools) {
    const capability = card.tools.find((item) => item.id === required);
    if (
      capability === undefined ||
      !['callable', 'verified'].includes(capability.state) ||
      typeof capability.evidence_ref !== 'string'
    )
      return `reuse_tool_unconfirmed:${required}`;
  }
  for (const required of assignment.required.skills) {
    const capability = card.skills.find((item) => item.id === required.id);
    if (
      capability === undefined ||
      capability.bundle_digest !== required.bundle_digest ||
      !['callable', 'verified'].includes(capability.state) ||
      typeof capability.evidence_ref !== 'string'
    )
      return `reuse_skill_unconfirmed:${required.id}`;
  }
  return null;
}

function callerIdentityMatches(
  caller: HerdrCallerObservation,
  binding: CollabBindingParticipant,
  assignment: Assignment,
  messageFrom: Identity,
): boolean {
  const session = reportedSessionIdentity(
    caller.sessionKind,
    caller.sessionValue,
  );
  return (
    caller.paneId === binding.pane_id &&
    caller.harness === assignment.assignee.harness &&
    caller.cwd !== null &&
    safePathEqual(caller.cwd, assignment.assignee.cwd) &&
    session.status === 'match' &&
    session.identity === assignment.assignee.session_id &&
    messageFrom.agent_id === assignment.assignee.agent_id &&
    messageFrom.session_id === assignment.assignee.session_id &&
    messageFrom.harness === assignment.assignee.harness
  );
}

function acceptedPiArgv(
  argv: readonly string[],
  sessionId: string,
  agentName: string,
  extensionEntry: string,
  openrouterModel?: string,
): boolean {
  const executable = argv[0]?.split(/[\\/]/).at(-1)?.toLowerCase();
  const hasPair = (flag: string, value: string) =>
    argv.some(
      (argument, index) => argument === flag && argv[index + 1] === value,
    );
  const forbidden = new Set([
    '-m',
    '--settings',
    '--config',
    '-c',
    '--approve',
    '--yes',
    '--resume',
    '--dangerously-skip-permissions',
    '--dangerously-bypass-approvals-and-sandbox',
  ]);
  const overrideFlags = argv.filter(
    (arg) =>
      arg === '--provider' ||
      arg === '--model' ||
      arg.startsWith('--provider=') ||
      arg.startsWith('--model='),
  );
  const modelMatches =
    openrouterModel === undefined
      ? overrideFlags.length === 0
      : overrideFlags.length === 2 &&
        hasPair('--provider', 'openrouter') &&
        hasPair('--model', openrouterModel);
  return (
    (executable === 'pi' || executable === 'pi.exe') &&
    hasPair('--session-id', sessionId) &&
    hasPair('--name', agentName) &&
    hasPair('--extension', extensionEntry) &&
    modelMatches &&
    !argv.some((argument) => forbidden.has(argument))
  );
}

function managedSdkLaunchMatches(
  observed: BootstrapStartedManagedSdk,
  context: BootstrapContext,
  pane: BootstrapPaneSnapshot,
  paths: ManagedRuntimePaths,
): boolean {
  const request = context.request;
  const model = request.selected_model.openrouter_model;
  const liveStatuses = new Set(['idle', 'working', 'running']);
  const launch = observed.launch;
  return (
    model !== undefined &&
    observed.agentName === context.herdrAgent &&
    observed.harness === 'pi' &&
    observed.paneId === pane.paneId &&
    observed.cwd !== null &&
    safePathEqual(observed.cwd, request.target.cwd) &&
    liveStatuses.has(observed.status.toLowerCase()) &&
    observed.sessionId === request.participant.native_session_selector &&
    observed.identityProvenance === 'owned-pi-sdk-control' &&
    observed.controlSchema === 'harness-collab/pi-managed-sdk-session/1' &&
    Number.isSafeInteger(observed.processPid) &&
    observed.processPid > 0 &&
    observed.socketPeerPid === observed.processPid &&
    observed.foregroundProcessPid === observed.processPid &&
    observed.pane.paneId === pane.paneId &&
    observed.pane.workspaceId === pane.workspaceId &&
    observed.pane.terminalId === pane.terminalId &&
    observed.pane.cwd !== null &&
    safePathEqual(observed.pane.cwd, request.target.cwd) &&
    launch.runtime === 'sdk' &&
    launch.sdkModulePath === paths.sdkModulePath &&
    launch.bootstrapExtensionPath === request.bootstrap.extension_entry &&
    launch.herdrAgentName === context.herdrAgent &&
    launch.journalPath === paths.journalPath &&
    launch.sessionId === request.participant.native_session_selector &&
    safePathEqual(launch.cwd, request.target.cwd) &&
    launch.model.provider === 'openrouter' &&
    launch.model.id === model &&
    launch.ready === true
  );
}

function callerSummary(context: BootstrapContext): Record<string, unknown> {
  return {
    pane_id: context.caller.paneId,
    workspace_id: context.caller.workspaceId,
    tab_id: context.caller.tabId,
    harness: context.caller.harness,
    cwd: context.caller.cwd,
    native_session_status: 'match',
    process_affiliation: 'not-established',
  };
}
function participantSummary(
  context: BootstrapContext,
): Record<string, unknown> {
  return {
    agent_id: context.request.participant.agent_id,
    harness: context.request.participant.harness,
    native_session_selector:
      context.request.participant.native_session_selector,
    herdr_agent: context.herdrAgent,
    runtime_capabilities:
      context.request.target.choice === 'reuse'
        ? 'validated_existing_runtime_card'
        : 'not_synthesized',
  };
}

function splitReportArgv(input: {
  readonly anchorPaneId: string;
  readonly cwd: string;
  readonly direction: 'right' | 'down';
  readonly ratio: number | undefined;
}): readonly string[] {
  const argv: string[] = [
    'herdr',
    'pane',
    'split',
    '--pane',
    input.anchorPaneId,
    '--cwd',
    input.cwd,
    '--no-focus',
    '--direction',
    input.direction,
  ];
  if (input.ratio !== undefined) argv.push('--ratio', String(input.ratio));
  return argv;
}

function siblingPaneIdsForPlacement(
  context: BootstrapContext,
): readonly string[] {
  const reservations = context.task.record.launch_reservations ?? [];
  const siblings: string[] = [];
  const seen = new Set<string>();
  for (const entry of reservations) {
    const bootstrap = isRecord(entry['bootstrap']) ? entry['bootstrap'] : null;
    const created =
      bootstrap === null ? null : (bootstrap['created_pane_id'] ?? null);
    if (
      typeof created === 'string' &&
      created !== context.caller.paneId &&
      !seen.has(created)
    ) {
      seen.add(created);
      siblings.push(created);
    }
  }
  return siblings;
}

async function resolvePanePlacement(
  context: BootstrapContext,
): Promise<
  | { readonly ok: true; readonly placement: PanePlacement }
  | { readonly ok: false; readonly code: string; readonly message: string }
> {
  const request = context.request;
  if (request.target.direction !== undefined) {
    return {
      ok: true,
      placement: {
        ok: true,
        anchorPaneId: context.caller.paneId,
        direction: request.target.direction,
      },
    };
  }
  const layoutResult = await context.ops.paneLayout(context.caller.paneId);
  if (!layoutResult.ok) {
    return {
      ok: true,
      placement: {
        ok: true,
        anchorPaneId: context.caller.paneId,
        direction: 'right',
        ratio: 0.6,
      },
    };
  }
  const layout = layoutResult.value;
  const parsed = parsePaneLayout(layout);
  if (parsed === null) {
    return {
      ok: true,
      placement: {
        ok: true,
        anchorPaneId: context.caller.paneId,
        direction: 'right',
        ratio: 0.6,
      },
    };
  }
  const siblings = siblingPaneIdsForPlacement(context);
  return {
    ok: true,
    placement: selectPanePlacement({
      callerPaneId: context.caller.paneId,
      layout: parsed,
      siblingPaneIds: siblings,
    }),
  };
}

function planReport(
  context: BootstrapContext,
  action: BootstrapAction,
): VisibleBootstrapReport {
  const request = context.request;
  const paneId =
    context.request.target.choice === 'reuse'
      ? (bindingParticipant(context.binding, request.participant.agent_id)
          ?.pane_id ?? null)
      : '<created-pane-id>';
  const managedPathResult =
    request.managed_runtime === undefined
      ? null
      : managedRuntimePathsFor(request);
  const startArgv =
    request.target.choice === 'sibling'
      ? request.managed_runtime === undefined
        ? [
            'herdr',
            'agent',
            'start',
            context.herdrAgent,
            '--kind',
            'pi',
            '--pane',
            paneId!,
            '--timeout',
            String(context.request.target.start_timeout_ms ?? START_TIMEOUT_MS),
            '--',
            '--session-id',
            request.participant.native_session_selector,
            '--name',
            context.herdrAgent,
            '--extension',
            request.bootstrap.extension_entry,
            ...(request.selected_model.openrouter_model
              ? [
                  '--provider',
                  'openrouter',
                  '--model',
                  request.selected_model.openrouter_model,
                ]
              : []),
          ]
        : managedPathResult?.ok
          ? [
              'herdr',
              ...managedSdkStartArgs({
                paneId: paneId!,
                configPath: managedPathResult.paths.configPath,
              }),
            ]
          : null
      : null;
  return successReport(action, request, context.requestDigest, 'planned', {
    task_id: context.task.record.task_id,
    state_revision: context.task.record.state_revision,
    caller: callerSummary(context),
    participant: participantSummary(context),
    target: (() => {
      if (request.target.choice !== 'sibling') {
        return {
          choice: request.target.choice,
          cwd: request.target.cwd,
          preserve_focus: true,
          pane_id: paneId,
          split_argv: null,
          launch_argv: startArgv,
        };
      }
      if (request.target.direction === undefined) {
        return {
          choice: request.target.choice,
          cwd: request.target.cwd,
          preserve_focus: true,
          pane_id: paneId,
          direction: null,
          placement: 'adaptive',
          split_argv: null,
          launch_argv: startArgv,
        };
      }
      return {
        choice: request.target.choice,
        cwd: request.target.cwd,
        preserve_focus: true,
        pane_id: paneId,
        direction: request.target.direction,
        split_argv: splitReportArgv({
          anchorPaneId: context.caller.paneId,
          cwd: request.target.cwd,
          direction: request.target.direction,
          ratio: undefined,
        }),
        launch_argv: startArgv,
      };
    })(),
    bootstrap: {
      config_digest: context.configDigest,
      bundle_manifest_digest: context.bundle.digest,
      bundle_files: context.bundle.entries.length,
      extension_entry: request.bootstrap.extension_entry,
      runtime: 'accepted_artifact_digest_match',
      gate_registration: 'not_proven_by_export_or_report',
      authority: 'default-deny-until-recorded-transfer-completes',
      model: request.selected_model.openrouter_model
        ? {
            provider: 'openrouter',
            id: request.selected_model.openrouter_model,
            observation:
              'explicit_launch_selection; runtime_observation_unverified',
          }
        : 'daily_default_launch; selected_runtime_inheritance_unverified',
    },
    effects: [
      {
        step: 'request_reservation',
        status: 'planned_only',
        detail: 'apply persists request_id/digest before any effect',
      },
      {
        step:
          request.target.choice === 'sibling'
            ? 'visible_split'
            : 'participant_reuse',
        status: 'planned',
        detail: null,
      },
      ...(request.target.choice === 'sibling'
        ? [
            {
              step: 'bounded_shell_readiness',
              status: 'planned',
              detail: 'max 10s, 100ms intervals, 100 samples',
            },
            {
              step:
                request.managed_runtime === undefined
                  ? 'agent_start'
                  : 'managed_sdk_start',
              status: 'planned',
              detail:
                request.managed_runtime === undefined
                  ? request.selected_model.openrouter_model
                    ? 'Pi extension + exact fresh session UUID + explicit OpenRouter model; daily resources preserved'
                    : 'Pi extension + exact session UUID; no model override'
                  : 'Fixed current-package SDK start via herdr pane run; exact session/model/extension/config pinned, runtime control evidence pending',
            },
          ]
        : []),
      {
        step: 'persist_task_binding',
        status: 'planned',
        detail:
          request.target.choice === 'sibling'
            ? context.derivedBindingFile
            : context.bindingFile,
      },
      {
        step: 'notify_registered_message',
        status: 'planned',
        detail: request.message_pointer.message_id,
      },
    ],
  });
}

async function prepare(
  input: LoadedVisibleBootstrapRequest | VisibleBootstrapRequest,
  action: BootstrapAction,
  dependencies: VisibleBootstrapDependencies,
): Promise<Prepared> {
  const request = requestOf(input);
  const requestDigest = requestDigestOf(input);
  const fail = (
    status: BootstrapStatus,
    code: string,
    message: string,
    next: string | null = null,
    extra: Partial<VisibleBootstrapReport> = {},
  ): Prepared => ({
    ok: false,
    report: failureReport(
      action,
      request,
      requestDigest,
      status,
      code,
      message,
      next,
      extra,
    ),
  });
  if (request.managed_runtime !== undefined) {
    const shape = validateVisibleBootstrapRequest(request);
    if (!shape.ok) return fail('invalid', shape.code, shape.message);
    const runtimePaths = managedRuntimePathsFor(request);
    if (!runtimePaths.ok)
      return fail('invalid', runtimePaths.code, runtimePaths.message);
  }
  if (!request.binding_ref)
    return fail(
      'needs_input',
      'binding_ref_required',
      'A task-local pappra/collab-binding/1 file is required for explicit caller/recipient routing.',
      'Add binding_ref to the request; no focused-pane or workspace-default fallback is used.',
    );
  const opened = await openMessageTask(request.task_root);
  if (!opened.ok)
    return fail('needs_input', opened.code, opened.message, opened.nextAction);
  const task = opened.value;
  if (!safePathEqual(task.taskRoot, request.task_root))
    return fail(
      'invalid',
      'task_root_mismatch',
      'Request task_root is not the canonical task root.',
    );
  const attempt = findAttempt(
    task.record,
    request.admission.subtask_id,
    request.admission.attempt,
  );
  if (
    attempt === null ||
    attempt.assignment_ref === null ||
    attempt.assignment_digest === null
  )
    return fail(
      'needs_input',
      'attempt_or_assignment_missing',
      'The exact task attempt must have a pinned assignment reference/digest.',
    );
  if (attempt.awaiting === 'approval')
    return fail(
      'needs_input',
      'awaiting_approval',
      'The admitted attempt is awaiting human approval; bootstrap cannot resume it.',
    );
  if (!['assigned', 'accepted', 'running'].includes(attempt.state))
    return fail(
      'needs_input',
      'attempt_not_startable',
      `Attempt state ${attempt.state} is not eligible for bootstrap.`,
    );
  if (
    attempt.cancel_requested_at != null ||
    hasPendingCancellation(
      task.record,
      request.admission.subtask_id,
      request.admission.attempt,
    )
  )
    return fail(
      'needs_input',
      'cancel_unconfirmed',
      'A cancellation is pending or unconfirmed; bootstrap is blocked until native state is reconciled.',
    );
  if (attempt.input_revision !== request.admission.input_revision)
    return fail(
      'needs_input',
      'input_revision_mismatch',
      'Request input revision differs from the current task attempt.',
    );
  const assignmentRead = readAssignment(
    attempt.assignment_ref,
    attempt,
    task.record,
  );
  if (!assignmentRead.ok)
    return fail('needs_input', assignmentRead.code, assignmentRead.message);
  const assignment = assignmentRead.assignment;
  if (
    assignment.assignment_id !== request.admission.assignment_id ||
    assignment.task_id !== task.record.task_id ||
    assignment.attempt !== attempt.attempt
  )
    return fail(
      'needs_input',
      'assignment_identity_mismatch',
      'Request admission does not match the current recorded assignment/task attempt.',
    );
  if (
    task.record.coordinator === null ||
    task.record.dispatch_frozen === true ||
    task.record.coordinator.owner_epoch !==
      assignment.coordinator.owner_epoch ||
    attempt.owner_epoch !== assignment.coordinator.owner_epoch
  )
    return fail(
      'needs_input',
      'coordinator_or_dispatch_state_invalid',
      'Current coordinator epoch must match the assignment/attempt and dispatch must not be frozen.',
    );
  const cardRead = readCapabilityCard(
    request.admission.capability_card_ref,
    request.admission.capability_card_digest,
  );
  if (!cardRead.ok) return fail('needs_input', cardRead.code, cardRead.message);
  const preflight = runCollaborationPreflight({
    assignmentFile: assignmentRead.file,
    capabilitiesFile: request.admission.capability_card_ref,
    maxAgeMinutes: 30,
    now: (dependencies.clock ?? Date.now)(),
  });
  if (!preflight.ok)
    return fail(
      'needs_input',
      'admission_not_ready',
      `Current collaboration preflight is ${preflight.status}.`,
      'Refresh actual current capability evidence and rerun preflight.',
      {
        effects: preflight.blockers.slice(0, 16).map((blocker) => ({
          step: 'admission',
          status: 'blocked',
          detail: `${blocker.code}${blocker.capability ? `:${blocker.capability}` : ''}`,
        })),
      },
    );
  if (
    request.target.cwd !== assignment.assignee.cwd ||
    !safePathEqual(request.target.cwd, assignment.assignee.cwd)
  )
    return fail(
      'invalid',
      'target_cwd_mismatch',
      'Target cwd must be the exact admitted assignment cwd.',
    );

  const bindingResult = readBinding(
    request.binding_ref,
    task.taskRoot,
    task.record.task_id,
  );
  if (!bindingResult.ok)
    return fail('needs_input', bindingResult.code, bindingResult.message);
  const pointer = await readRegisteredMessageSafe(
    task,
    request.message_pointer.message_id,
  );
  if (!pointer.ok)
    return fail(
      'needs_input',
      pointer.code,
      pointer.message,
      pointer.nextAction,
    );
  if (
    pointer.value.file !== request.message_pointer.content_ref ||
    pointer.value.digest !== request.message_pointer.content_digest
  )
    return fail(
      'needs_input',
      'message_pointer_mismatch',
      'Message pointer path/digest does not match the registered message bytes.',
    );
  const message = pointer.value.message;
  const routing = messageAndBindingFailure(
    request,
    task.record,
    message,
    bindingResult.binding,
  );
  if (!routing.ok) return fail('needs_input', routing.code, routing.message);
  const callerBinding = routing.sender;
  const ops =
    dependencies.ops ??
    createHerdrBootstrapOps({
      taskRoot: task.taskRoot,
      ...(dependencies.transport === undefined
        ? {}
        : { transport: dependencies.transport }),
    });
  if (
    dependencies.ops !== undefined &&
    dependencies.transport !== undefined &&
    dependencies.ops.transport !== dependencies.transport
  )
    return fail(
      'invalid',
      'transport_composition_mismatch',
      'The notification and bootstrap operations must share the same Herdr transport instance.',
    );
  const transport = ops.transport;
  if (
    request.managed_runtime !== undefined &&
    ops.startManagedSdk === undefined
  )
    return fail(
      'needs_input',
      'managed_start_unavailable',
      'This host cannot launch a managed SDK successor; no legacy Pi fallback is permitted.',
    );
  const callerIdentity = await ops.verifyCaller(request.caller.pane_id);
  if (!callerIdentity.ok)
    return fail(
      'needs_input',
      callerIdentity.code,
      callerIdentity.detail,
      'Run from the task-bound Herdr caller pane.',
    );
  if (
    !callerIdentityMatches(
      callerIdentity.caller,
      callerBinding,
      assignment,
      message.from,
    )
  )
    return fail(
      'needs_input',
      'caller_identity_mismatch',
      'Current caller, task binding, assignment and registered sender identities do not match.',
    );
  const listed = await ops.listAgents();
  if (!listed.ok)
    return fail('unknown', 'herdr_agent_list_unavailable', listed.detail);
  if (
    request.managed_runtime !== undefined &&
    listed.agents.some((agent) => {
      const reported = reportedSessionIdentity(
        agent.sessionKind,
        agent.sessionValue,
      );
      return (
        reported.status === 'match' &&
        reported.identity === request.participant.native_session_selector
      );
    })
  )
    return fail(
      'needs_input',
      'managed_session_selector_in_use',
      'The requested SDK native session selector is already reported by a live Herdr agent.',
    );
  const liveCaller = liveParticipant(
    callerBinding,
    assignment.assignee,
    listed.agents,
  );
  if (!liveCaller.ok)
    return fail('needs_input', liveCaller.code, liveCaller.message);

  const configResult = readPiBootstrapConfig(request.bootstrap.config_ref);
  if (!configResult.ok)
    return fail(
      'needs_input',
      configResult.code,
      configResult.message,
      'Use the exact accepted exported bootstrap config.',
    );
  if (
    configResult.digest !== request.bootstrap.config_digest ||
    !safePathEqual(configResult.taskRoot, task.taskRoot)
  )
    return fail(
      'needs_input',
      'config_pin_or_task_mismatch',
      'Bootstrap config digest/task root differs from the request/current task.',
    );
  const association = matchConfigToTask(
    request,
    task.record,
    attempt,
    assignment,
    configResult.config,
  );
  if (!association.ok)
    return fail('needs_input', association.code, association.message);
  const bundle = verifyBootstrapBundle(
    request,
    configResult.digest,
    dependencies,
  );
  if (!bundle.ok) return fail('needs_input', bundle.code, bundle.message);

  let herdrAgent = herdrNameForRequest(request);
  if (request.target.choice === 'sibling') {
    if (
      bindingResult.binding.participants.some(
        (participant) =>
          participant.agent_id === request.participant.agent_id ||
          participant.herdr_agent === herdrAgent,
      )
    )
      return fail(
        'needs_input',
        'sibling_identity_already_bound',
        'A task-bound participant already uses the requested identity/name; there is no silent reuse fallback.',
      );
    if (listed.agents.some((agent) => agent.name === herdrAgent))
      return fail(
        'needs_input',
        'herdr_agent_name_in_use',
        'Deterministic Herdr agent name is already live; use a fresh request_id.',
      );
  } else {
    const existing = bindingParticipant(
      bindingResult.binding,
      request.participant.agent_id,
    );
    if (
      existing === null ||
      existing.harness !== request.participant.harness ||
      existing.native_session_id !==
        request.participant.native_session_selector ||
      !safePathEqual(existing.cwd, request.target.cwd)
    )
      return fail(
        'needs_input',
        'unsupported_reuse',
        'Reuse requires an exact task-local participant/session/cwd binding.',
      );
    if (
      request.participant.herdr_agent !== undefined &&
      request.participant.herdr_agent !== existing.herdr_agent
    )
      return fail(
        'needs_input',
        'unsupported_reuse',
        'Requested Herdr name differs from the task-local participant binding.',
      );
    herdrAgent = existing.herdr_agent;
    const participantLive = liveParticipant(
      existing,
      {
        agent_id: request.participant.agent_id,
        session_id: request.participant.native_session_selector,
        harness: request.participant.harness,
      },
      listed.agents,
    );
    if (!participantLive.ok)
      return fail('needs_input', 'unsupported_reuse', participantLive.message);
    let participantCard = cardRead.card;
    if (
      request.participant.capability_card_ref !== undefined &&
      request.participant.capability_card_digest !== undefined
    ) {
      const supplied = readCapabilityCard(
        request.participant.capability_card_ref,
        request.participant.capability_card_digest,
      );
      if (!supplied.ok)
        return fail('needs_input', 'unsupported_reuse', supplied.message);
      participantCard = supplied.card;
    }
    const cardIssue = participantCardIssue(
      participantCard,
      assignment,
      request.participant,
      request.target.cwd,
      (dependencies.clock ?? Date.now)(),
    );
    if (cardIssue !== null)
      return fail(
        'needs_input',
        'unsupported_reuse',
        `Existing participant capability evidence is not ready (${cardIssue}).`,
        'Refresh the exact participant card; reuse never starts or replaces an agent.',
      );
  }
  const derivedBindingFile =
    request.target.choice === 'sibling'
      ? path.join(
          task.taskRoot,
          'notifications',
          'visible-bootstrap-bindings',
          `${request.request_id}.json`,
        )
      : bindingResult.file;
  const context: BootstrapContext = {
    request,
    requestDigest: requestDigestOf(input),
    requestFile: requestFileOf(input),
    task,
    assignment,
    assignmentDigest: assignmentRead.digest,
    assignmentFile: assignmentRead.file,
    admissionAssignmentDigest: assignmentRead.admissionDigest,
    attempt,
    callerCard: cardRead.card,
    caller: callerIdentity.caller,
    transport,
    ops,
    binding: bindingResult.binding,
    bindingFile: bindingResult.file,
    bindingDigest: bindingResult.digest,
    message,
    config: configResult.config,
    configDigest: configResult.digest,
    acceptedArtifactPath: dependencies.acceptedArtifactPath ?? null,
    bundle: bundle.bundle,
    herdrAgent,
    derivedBindingFile,
  };
  return { ok: true, context };
}

function reservationFor(
  record: TaskRecord,
  requestId: string,
): LaunchReservation | null | 'ambiguous' {
  const matches = (record.launch_reservations ?? []).filter((entry) => {
    const bootstrap = entry['bootstrap'];
    return isRecord(bootstrap) && bootstrap['request_id'] === requestId;
  });
  return matches.length > 1 ? 'ambiguous' : (matches[0] ?? null);
}
function bootstrapData(entry: LaunchReservation): Record<string, unknown> {
  const value = entry['bootstrap'];
  return isRecord(value) ? value : {};
}
function deadNoEffectBootstrap(entry: LaunchReservation): boolean {
  const data = bootstrapData(entry);
  return (
    entry.released_at === null &&
    entry.outcome === null &&
    entry.phase === 'reserved' &&
    data['phase'] === 'reserved' &&
    data['created_pane_id'] === null &&
    Array.isArray(data['receipts']) &&
    data['receipts'].length === 0 &&
    observeProcessIdentity(data['process_identity']) === 'dead'
  );
}
function reservationSummary(entry: LaunchReservation): Record<string, unknown> {
  const data = bootstrapData(entry);
  return {
    reservation_id: entry.reservation_id,
    phase:
      typeof data['phase'] === 'string'
        ? data['phase']
        : (entry.phase ?? 'unknown'),
    outcome: entry.outcome,
    released: entry.released_at !== null,
    request_id: data['request_id'] ?? null,
  };
}

function reserveRequest(
  context: BootstrapContext,
  now: number,
):
  | {
      readonly ok: true;
      readonly reservationId: string;
      readonly revision: number;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly existing?: LaunchReservation;
    } {
  const request = context.request;
  const reservationId = `bootstrap-${crypto.createHash('sha256').update(request.request_id).digest('hex').slice(0, 32)}`;
  const outcome = transact<{ readonly reservation_id: string }>(
    context.task.taskRoot,
    {
      actor: context.assignment.assignee.agent_id,
      purpose: 'visible-bootstrap-reserve',
      clock: now,
      apply: (record) => {
        if (
          record.task_id !== context.task.record.task_id ||
          record.task_root !== context.task.taskRoot
        )
          return { ok: false as const, reason: 'task_identity_changed' };
        const prior = reservationFor(record, request.request_id);
        if (prior === 'ambiguous')
          return {
            ok: false as const,
            reason: 'request_reservation_ambiguous',
          };
        if (prior !== null) {
          if (bootstrapData(prior)['request_digest'] !== context.requestDigest)
            return {
              ok: false as const,
              reason: 'request_id_content_conflict',
              existing: prior,
            };
          if (deadNoEffectBootstrap(prior)) {
            record.launch_reservations = (
              record.launch_reservations ?? []
            ).filter((entry) => entry !== prior);
          } else
            return {
              ok: false as const,
              reason:
                prior.released_at === null
                  ? 'request_reconcile_required'
                  : 'request_already_recorded',
              existing: prior,
            };
        }
        const attempt = findAttempt(
          record,
          request.admission.subtask_id,
          request.admission.attempt,
        );
        if (
          attempt === null ||
          attempt.assignment_digest !== context.attempt.assignment_digest ||
          attempt.input_revision !== request.admission.input_revision ||
          attempt.owner_epoch !== context.attempt.owner_epoch
        )
          return { ok: false as const, reason: 'attempt_changed' };
        const active = (record.launch_reservations ?? []).find(
          (entry) =>
            entry.released_at === null &&
            entry.subtask_id === request.admission.subtask_id &&
            entry.attempt === request.admission.attempt,
        );
        if (active !== undefined)
          return {
            ok: false as const,
            reason: 'attempt_launch_already_reserved',
            existing: active,
          };
        const reservation: LaunchReservation = {
          reservation_id: reservationId,
          subtask_id: request.admission.subtask_id,
          attempt: request.admission.attempt,
          kind: 'pi',
          mode: 'visible-bootstrap',
          holder: context.assignment.assignee,
          requested_session_id: request.participant.native_session_selector,
          transport: 'herdr',
          reserved_at: new Date(now).toISOString(),
          released_at: null,
          outcome: null,
          phase: 'reserved',
          bootstrap: {
            process_identity: captureProcessIdentity(),
            request_id: request.request_id,
            request_digest: context.requestDigest,
            request_file: context.requestFile,
            target_choice: request.target.choice,
            participant_agent_id: request.participant.agent_id,
            participant_session_id: request.participant.native_session_selector,
            bundle_manifest_digest: context.bundle.digest,
            config_digest: context.configDigest,
            extension_entry: request.bootstrap.extension_entry,
            created_pane_id: null,
            created_workspace_id: null,
            created_terminal_id: null,
            herdr_agent: context.herdrAgent,
            binding_file: context.derivedBindingFile,
            message_id: request.message_pointer.message_id,
            message_digest: request.message_pointer.content_digest,
            phase: 'reserved',
            receipts: [],
          },
        };
        record.launch_reservations = [
          ...(record.launch_reservations ?? []),
          reservation,
        ];
        return {
          record,
          op: 'visible-bootstrap-reserve',
          summary: {
            request_id: request.request_id,
            subtask_id: request.admission.subtask_id,
            attempt: request.admission.attempt,
          },
          result: { reservation_id: reservationId },
        };
      },
    },
  );
  if (!outcome.ok) {
    const existing = isRecord(outcome['existing'])
      ? (outcome['existing'] as unknown as LaunchReservation)
      : undefined;
    return {
      ok: false,
      code: outcome.reason,
      message: outcome.reason,
      ...(existing === undefined ? {} : { existing }),
    };
  }
  return { ok: true, reservationId, revision: outcome.state_revision };
}

function updateReservation(
  context: BootstrapContext,
  reservationId: string,
  input: {
    readonly phase: string;
    readonly outcome?: string | null;
    readonly release?: boolean;
    readonly detail?: string | null;
    readonly extra?: Record<string, unknown>;
    readonly receipt?: BootstrapCommandReceipt;
  },
  now: number,
):
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly code: string; readonly message: string } {
  const outcome = transact<{ readonly phase: string }>(context.task.taskRoot, {
    actor: context.assignment.assignee.agent_id,
    purpose: `visible-bootstrap-${input.phase}`,
    clock: now,
    apply: (record) => {
      const matches = (record.launch_reservations ?? []).filter(
        (entry) => entry.reservation_id === reservationId,
      );
      if (matches.length !== 1)
        return {
          ok: false as const,
          reason: 'reservation_missing_or_ambiguous',
        };
      const entry = matches[0]! as LaunchReservation & {
        bootstrap?: Record<string, unknown>;
      };
      if (entry.bootstrap?.['request_digest'] !== context.requestDigest)
        return { ok: false as const, reason: 'reservation_digest_mismatch' };
      if (entry.released_at !== null)
        return { ok: false as const, reason: 'reservation_already_released' };
      const priorReceipts = Array.isArray(entry.bootstrap['receipts'])
        ? entry.bootstrap['receipts'].filter(isRecord)
        : [];
      const receipt =
        input.receipt === undefined ? null : sanitizedReceipt(input.receipt);
      entry.phase = input.phase;
      if (input.detail !== undefined) entry.detail = input.detail;
      if (input.outcome !== undefined) entry.outcome = input.outcome;
      if (input.release === true)
        entry.released_at = new Date(now).toISOString();
      entry.bootstrap = {
        ...entry.bootstrap,
        ...(input.extra ?? {}),
        request_id: context.request.request_id,
        request_digest: context.requestDigest,
        phase: input.phase,
        updated_at: new Date(now).toISOString(),
        ...(receipt === null
          ? {}
          : { receipts: [...priorReceipts, receipt].slice(-MAX_RECEIPTS) }),
      };
      return {
        record,
        op: 'visible-bootstrap-phase',
        summary: { request_id: context.request.request_id, phase: input.phase },
        result: { phase: input.phase },
      };
    },
  });
  return outcome.ok
    ? { ok: true, revision: outcome.state_revision }
    : { ok: false, code: outcome.reason, message: outcome.reason };
}

function commitEffectIntent(
  context: BootstrapContext,
  reservationId: string,
  expectedRevision: number,
  expectedRecordFile: OpenedMessageTask['identity']['recordFile'],
  phase: string,
  clock: number,
  signal?: AbortSignal,
):
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly code: string; readonly message: string } {
  const outcome = transact<{ readonly phase: string }>(context.task.taskRoot, {
    actor: context.assignment.assignee.agent_id,
    purpose: `visible-bootstrap-intent-${phase}`,
    expectRevision: expectedRevision,
    clock,
    apply: (record) => {
      if (signal?.aborted)
        return { ok: false as const, reason: 'abort_requested' };
      if (
        !sameDirectoryIdentity(
          context.task.identity.taskRoot,
          context.task.taskRoot,
        ) ||
        !sameDirectoryIdentity(
          context.task.identity.messagesDirectory,
          context.task.messagesDirectory,
        ) ||
        !sameFileIdentity(expectedRecordFile)
      )
        return { ok: false as const, reason: 'task_namespace_changed' };
      if (
        record.task_id !== context.task.record.task_id ||
        record.task_root !== context.task.taskRoot ||
        record.domain_id !== context.task.record.domain_id ||
        record.domain_root !== context.task.record.domain_root ||
        record.created_at !== context.task.record.created_at
      )
        return { ok: false as const, reason: 'task_namespace_changed' };
      const request = context.request;
      const attempt = findAttempt(
        record,
        request.admission.subtask_id,
        request.admission.attempt,
      );
      if (
        attempt === null ||
        attempt.assignment_ref !== context.attempt.assignment_ref ||
        attempt.assignment_digest !== context.assignmentDigest ||
        attempt.input_revision !== request.admission.input_revision ||
        attempt.owner_epoch !== context.attempt.owner_epoch ||
        record.coordinator?.owner_epoch !==
          context.assignment.coordinator.owner_epoch ||
        record.dispatch_frozen === true
      )
        return { ok: false as const, reason: 'attempt_or_coordinator_changed' };
      if (attempt.awaiting === 'approval')
        return { ok: false as const, reason: 'awaiting_approval' };
      if (!['assigned', 'accepted', 'running'].includes(attempt.state))
        return { ok: false as const, reason: 'attempt_not_startable' };
      if (
        attempt.cancel_requested_at != null ||
        hasPendingCancellation(
          record,
          request.admission.subtask_id,
          request.admission.attempt,
        )
      )
        return { ok: false as const, reason: 'cancel_unconfirmed' };
      const assignment = readAssignment(
        attempt.assignment_ref!,
        attempt,
        record,
      );
      if (
        !assignment.ok ||
        assignment.digest !== context.assignmentDigest ||
        assignment.file !== context.assignmentFile ||
        assignment.admissionDigest !== context.admissionAssignmentDigest
      )
        return { ok: false as const, reason: 'assignment_changed' };
      const card = readCapabilityCard(
        request.admission.capability_card_ref,
        request.admission.capability_card_digest,
      );
      if (!card.ok) return { ok: false as const, reason: card.code };
      const preflight = runCollaborationPreflight({
        assignmentFile: assignment.file,
        capabilitiesFile: request.admission.capability_card_ref,
        maxAgeMinutes: 30,
        now: clock,
      });
      if (!preflight.ok)
        return { ok: false as const, reason: 'admission_not_ready' };
      const config = readPiBootstrapConfig(request.bootstrap.config_ref);
      if (
        !config.ok ||
        config.digest !== context.configDigest ||
        !safePathEqual(config.taskRoot, context.task.taskRoot)
      )
        return { ok: false as const, reason: 'config_changed' };
      const association = matchConfigToTask(
        request,
        record,
        attempt,
        context.assignment,
        config.config,
      );
      if (!association.ok)
        return { ok: false as const, reason: association.code };
      const bundle = verifyBootstrapBundle(
        request,
        context.configDigest,
        context.acceptedArtifactPath === null
          ? {}
          : { acceptedArtifactPath: context.acceptedArtifactPath },
      );
      if (!bundle.ok || bundle.bundle.digest !== context.bundle.digest)
        return {
          ok: false as const,
          reason: bundle.ok ? 'bundle_changed' : bundle.code,
        };
      const binding = readBinding(
        context.bindingFile,
        context.task.taskRoot,
        record.task_id,
      );
      if (!binding.ok || binding.digest !== context.bindingDigest)
        return { ok: false as const, reason: 'binding_changed' };
      const route = messageAndBindingFailure(
        request,
        record,
        context.message,
        binding.binding,
      );
      if (!route.ok) return { ok: false as const, reason: route.code };
      const messageRecord = (record.messages ?? []).find(
        (entry) =>
          entry.message_id === request.message_pointer.message_id &&
          entry.content_digest === context.message.content_digest &&
          ['applied', 'recorded'].includes(entry.state),
      );
      if (messageRecord === undefined)
        return { ok: false as const, reason: 'message_registration_changed' };
      const matches = (record.launch_reservations ?? []).filter(
        (entry) => entry.reservation_id === reservationId,
      );
      if (matches.length !== 1)
        return {
          ok: false as const,
          reason: 'reservation_missing_or_ambiguous',
        };
      const entry = matches[0]! as LaunchReservation & {
        bootstrap?: Record<string, unknown>;
      };
      if (
        entry.released_at !== null ||
        entry.bootstrap?.['request_digest'] !== context.requestDigest
      )
        return { ok: false as const, reason: 'reservation_changed' };
      const at = new Date(clock).toISOString();
      entry.phase = phase;
      entry.bootstrap = {
        ...entry.bootstrap,
        phase,
        effect_intent_at: at,
        effect_intent_request_digest: context.requestDigest,
      };
      return {
        record,
        op: 'visible-bootstrap-effect-intent',
        summary: { request_id: request.request_id, phase },
        result: { phase },
      };
    },
  });
  return outcome.ok
    ? { ok: true, revision: outcome.state_revision }
    : { ok: false, code: outcome.reason, message: outcome.reason };
}

function guardedBootstrapTransport(
  context: BootstrapContext,
  reservationId: string,
  now: () => number,
  signal?: AbortSignal,
): HerdrTransport {
  const underlying = context.transport;
  return {
    id: `${underlying.id}-visible-bootstrap-guard`,
    verifyCaller: (options) => underlying.verifyCaller(options),
    list: () => underlying.list(),
    prompt: async (agent, text, registered) => {
      if (agent !== context.herdrAgent)
        return {
          status: 'refused',
          detail: 'Bootstrap guard refused an unexpected Herdr recipient.',
        };
      const opened = await openMessageTask(context.task.taskRoot);
      if (!opened.ok)
        return {
          status: 'blocked',
          detail: `Bootstrap guard could not reopen the task (${opened.code}).`,
        };
      const namespace = await assertMessageTaskCurrent(opened.value);
      if (namespace !== null)
        return {
          status: 'blocked',
          detail: `Bootstrap guard found a changed task namespace (${namespace.code}).`,
        };
      const intent = commitEffectIntent(
        context,
        reservationId,
        opened.value.record.state_revision,
        opened.value.identity.recordFile,
        'notify_prompt_pending',
        now(),
        signal,
      );
      if (!intent.ok)
        return {
          status: 'blocked',
          detail: `Bootstrap guard blocked prompt (${intent.code}).`,
        };
      return underlying.prompt(agent, text, registered);
    },
  };
}

function sanitizedReceipt(
  receipt: BootstrapCommandReceipt,
): Record<string, unknown> {
  return {
    operation: receipt.operation,
    argv: receipt.argv.slice(0, 24).map((item) => item.slice(0, 4096)),
    code: receipt.code,
    signal: receipt.signal,
    spawned: receipt.spawned,
    timed_out: receipt.timed_out,
    spawn_error: receipt.spawn_error?.slice(0, 512) ?? null,
    stdout_bytes: Buffer.byteLength(receipt.stdout),
    stdout_digest: digestText(receipt.stdout),
    stderr_bytes: Buffer.byteLength(receipt.stderr),
    stderr_digest: digestText(receipt.stderr),
  };
}
function persistReceipt(
  context: BootstrapContext,
  reservationId: string,
  now: () => number,
) {
  return (receipt: BootstrapCommandReceipt): void => {
    const saved = updateReservation(
      context,
      reservationId,
      {
        phase: `${receipt.operation}_receipt_recorded`,
        receipt,
      },
      now(),
    );
    if (!saved.ok)
      throw new Error(
        `Cannot persist bounded ${receipt.operation} result (${saved.code}).`,
      );
  };
}

async function revalidateCurrent(
  context: BootstrapContext,
  now: number,
): Promise<
  | { readonly ok: true; readonly task: OpenedMessageTask }
  | { readonly ok: false; readonly code: string; readonly message: string }
> {
  const opened = await openMessageTask(context.task.taskRoot);
  if (!opened.ok)
    return { ok: false, code: opened.code, message: opened.message };
  const record = opened.value.record;
  if (
    !safePathEqual(opened.value.taskRoot, context.task.taskRoot) ||
    !sameDirectoryIdentity(
      context.task.identity.taskRoot,
      opened.value.taskRoot,
    ) ||
    !sameDirectoryIdentity(
      context.task.identity.messagesDirectory,
      opened.value.messagesDirectory,
    ) ||
    record.task_id !== context.task.record.task_id ||
    record.domain_id !== context.task.record.domain_id ||
    record.domain_root !== context.task.record.domain_root ||
    record.created_at !== context.task.record.created_at
  )
    return {
      ok: false,
      code: 'task_identity_changed',
      message: 'Current task root/identity changed.',
    };
  const attempt = findAttempt(
    record,
    context.request.admission.subtask_id,
    context.request.admission.attempt,
  );
  if (
    attempt === null ||
    attempt.assignment_ref !== context.attempt.assignment_ref ||
    attempt.assignment_digest !== context.attempt.assignment_digest ||
    attempt.input_revision !== context.request.admission.input_revision ||
    attempt.owner_epoch !== context.attempt.owner_epoch ||
    record.coordinator?.owner_epoch !==
      context.assignment.coordinator.owner_epoch ||
    record.dispatch_frozen === true
  )
    return {
      ok: false,
      code: 'attempt_changed',
      message:
        'Current attempt assignment/input/epoch or dispatch state changed after planning.',
    };
  if (attempt.awaiting === 'approval')
    return {
      ok: false,
      code: 'awaiting_approval',
      message: 'The admitted attempt is awaiting human approval.',
    };
  if (!['assigned', 'accepted', 'running'].includes(attempt.state))
    return {
      ok: false,
      code: 'attempt_not_startable',
      message: `Attempt state ${attempt.state} is not eligible for bootstrap.`,
    };
  if (
    attempt.cancel_requested_at != null ||
    hasPendingCancellation(
      record,
      context.request.admission.subtask_id,
      context.request.admission.attempt,
    )
  )
    return {
      ok: false,
      code: 'cancel_unconfirmed',
      message: 'A cancellation is pending or unconfirmed.',
    };
  const currentAssignment = readAssignment(
    attempt.assignment_ref!,
    attempt,
    opened.value.record,
  );
  if (
    !currentAssignment.ok ||
    currentAssignment.digest !== context.assignmentDigest ||
    currentAssignment.file !== context.assignmentFile ||
    currentAssignment.admissionDigest !== context.admissionAssignmentDigest
  )
    return {
      ok: false,
      code: 'assignment_changed',
      message: 'Pinned assignment changed after planning.',
    };
  const card = readCapabilityCard(
    context.request.admission.capability_card_ref,
    context.request.admission.capability_card_digest,
  );
  if (!card.ok) return { ok: false, code: card.code, message: card.message };
  const preflight = runCollaborationPreflight({
    assignmentFile: currentAssignment.file,
    capabilitiesFile: context.request.admission.capability_card_ref,
    maxAgeMinutes: 30,
    now,
  });
  if (!preflight.ok)
    return {
      ok: false,
      code: 'admission_not_ready',
      message: `Current preflight is ${preflight.status}.`,
    };
  const currentConfig = readPiBootstrapConfig(
    context.request.bootstrap.config_ref,
  );
  if (
    !currentConfig.ok ||
    currentConfig.digest !== context.configDigest ||
    !safePathEqual(currentConfig.taskRoot, opened.value.taskRoot)
  )
    return {
      ok: false,
      code: 'config_changed',
      message: 'Pinned bootstrap config or task root changed after planning.',
    };
  const association = matchConfigToTask(
    context.request,
    record,
    attempt,
    context.assignment,
    currentConfig.config,
  );
  if (!association.ok)
    return { ok: false, code: association.code, message: association.message };
  const bundle = verifyBootstrapBundle(
    context.request,
    context.configDigest,
    context.acceptedArtifactPath === null
      ? {}
      : { acceptedArtifactPath: context.acceptedArtifactPath },
  );
  if (!bundle.ok || bundle.bundle.digest !== context.bundle.digest)
    return {
      ok: false,
      code: bundle.ok ? 'bundle_changed' : bundle.code,
      message: bundle.ok
        ? 'Pinned bundle changed after planning.'
        : bundle.message,
    };
  const pointer = await readRegisteredMessageSafe(
    opened.value,
    context.request.message_pointer.message_id,
  );
  if (
    !pointer.ok ||
    pointer.value.digest !== context.request.message_pointer.content_digest ||
    pointer.value.file !== context.request.message_pointer.content_ref
  )
    return {
      ok: false,
      code: 'message_changed',
      message: 'Registered first-contact message changed after planning.',
    };
  const currentBinding = readBinding(
    context.bindingFile,
    opened.value.taskRoot,
    record.task_id,
  );
  if (!currentBinding.ok || currentBinding.digest !== context.bindingDigest)
    return {
      ok: false,
      code: 'binding_changed',
      message: 'Task-local routing binding changed after planning.',
    };
  return { ok: true, task: opened.value };
}

function notificationSummary(
  result: MessageServiceResult<NotifyResult>,
): Record<string, unknown> {
  if (!result.ok)
    return {
      ok: false,
      status: 'failed',
      code: result.code,
      detail: result.message,
    };
  const value = result.value;
  return {
    ok: value.status === 'submitted' || value.status === 'already_recorded',
    status: value.status,
    message_id: value.messageId,
    message_digest: value.messageDigest,
    delivery_path: value.deliveryPath,
    attempts: value.attempts,
    consumed: false,
    task_accepted: false,
    detail: value.detail,
  };
}

function liveCallerAgain(
  context: BootstrapContext,
): Promise<
  | { readonly ok: true; readonly caller: HerdrCallerObservation }
  | { readonly ok: false; readonly code: string; readonly message: string }
> {
  return (async () => {
    const result = await context.ops.verifyCaller(
      context.request.caller.pane_id,
    );
    if (!result.ok)
      return { ok: false, code: result.code, message: result.detail };
    const sender = bindingParticipant(
      context.binding,
      context.message.from.agent_id,
    );
    if (
      sender === null ||
      !callerIdentityMatches(
        result.caller,
        sender,
        context.assignment,
        context.message.from,
      )
    )
      return {
        ok: false,
        code: 'caller_identity_changed',
        message: 'Caller pane/session/cwd changed before the next effect.',
      };
    const list = await context.ops.listAgents();
    if (!list.ok)
      return {
        ok: false,
        code: 'herdr_agent_list_unavailable',
        message: list.detail,
      };
    const live = liveParticipant(
      sender,
      context.assignment.assignee,
      list.agents,
    );
    return live.ok
      ? { ok: true, caller: result.caller }
      : { ok: false, code: live.code, message: live.message };
  })();
}

function paneSnapshotMatches(
  pane: BootstrapPaneSnapshot,
  expected: BootstrapPaneSnapshot,
): boolean {
  return (
    pane.paneId === expected.paneId &&
    pane.workspaceId === expected.workspaceId &&
    pane.terminalId === expected.terminalId &&
    pane.cwd !== null &&
    expected.cwd !== null &&
    safePathEqual(pane.cwd, expected.cwd) &&
    pane.agent === null
  );
}

async function closeOwnedEmptyPane(
  context: BootstrapContext,
  reservationId: string,
  pane: BootstrapPaneSnapshot,
  now: () => number,
): Promise<{ readonly state: string; readonly code: string | null }> {
  const current = await context.ops.paneGet(pane.paneId, READ_TIMEOUT_MS);
  if (!current.ok || !paneSnapshotMatches(current.value, pane))
    return {
      state: 'unknown_not_closed',
      code: current.ok ? 'owned_pane_identity_drift' : current.code,
    };
  const process = await context.ops.paneProcessInfo(
    pane.paneId,
    READ_TIMEOUT_MS,
  );
  if (!process.ok) return { state: 'unknown_not_closed', code: process.code };
  const facts = process.value;
  const shellName =
    facts.foregroundProcesses.length === 1
      ? facts.foregroundProcesses[0]!.name.split(/[\\/]/)
          .at(-1)!
          .replace(/^[-]+/, '')
          .replace(/\.exe$/i, '')
          .toLowerCase()
      : null;
  if (
    facts.shellPid === null ||
    facts.shellPid <= 0 ||
    facts.foregroundProcessGroupId !== facts.shellPid ||
    facts.foregroundProcesses.length !== 1 ||
    facts.foregroundProcesses[0]!.pid !== facts.shellPid ||
    shellName === null ||
    !SHELL_NAMES.has(shellName)
  )
    return {
      state: 'unknown_not_closed',
      code: 'owned_pane_not_available_shell',
    };
  const intent = updateReservation(
    context,
    reservationId,
    {
      phase: 'cleanup_close_pending',
      extra: {
        cleanup_pane_id: pane.paneId,
        cleanup_workspace_id: pane.workspaceId,
        cleanup_terminal_id: pane.terminalId,
      },
    },
    now(),
  );
  if (!intent.ok) return { state: 'unknown_not_closed', code: intent.code };
  const finalPane = await context.ops.paneGet(pane.paneId, READ_TIMEOUT_MS);
  if (!finalPane.ok || !paneSnapshotMatches(finalPane.value, pane))
    return {
      state: 'unknown_not_closed',
      code: finalPane.ok ? 'owned_pane_changed_before_close' : finalPane.code,
    };
  const closed = await context.ops.closePane({
    paneId: pane.paneId,
    onReceipt: persistReceipt(context, reservationId, now),
  });
  return closed.ok
    ? { state: 'closed_owned_pane', code: null }
    : {
        state:
          closed.status === 'unknown' ? 'unknown_not_closed' : 'close_failed',
        code: closed.code,
      };
}

function terminalReport(
  context: BootstrapContext,
  status: BootstrapStatus,
  code: string,
  message: string,
  next: string | null,
  extra: Partial<VisibleBootstrapReport> = {},
): VisibleBootstrapReport {
  return failureReport(
    'apply',
    context.request,
    context.requestDigest,
    status,
    code,
    message,
    next,
    {
      task_id: context.task.record.task_id,
      caller: callerSummary(context),
      participant: participantSummary(context),
      bootstrap: {
        config_digest: context.configDigest,
        bundle_manifest_digest: context.bundle.digest,
        extension_entry: context.request.bootstrap.extension_entry,
        authority: 'default-deny-until-recorded-transfer-completes',
        model: 'daily_default_launch; selected_runtime_inheritance_unverified',
      },
      ...extra,
    },
  );
}

async function applySibling(
  context: BootstrapContext,
  reservationId: string,
  reservationRevision: number,
  dependencies: VisibleBootstrapDependencies,
  now: () => number,
): Promise<VisibleBootstrapReport> {
  const request = context.request;
  const steps: BootstrapStep[] = [];
  let revision = reservationRevision;
  const phase = (
    input: Parameters<typeof updateReservation>[2],
    clock = now(),
  ) => {
    const updated = updateReservation(context, reservationId, input, clock);
    if (updated.ok) revision = updated.revision;
    return updated;
  };
  const callerNow = await liveCallerAgain(context);
  if (!callerNow.ok) {
    const released = phase({
      phase: 'caller_changed_before_split',
      outcome: 'not_started',
      release: true,
      detail: callerNow.code,
    });
    return terminalReport(
      context,
      'needs_input',
      callerNow.code,
      callerNow.message,
      'Run from the exact task-bound caller pane.',
      {
        state_revision: released.ok ? released.revision : revision,
        reservation: {
          reservation_id: reservationId,
          phase: 'not_started',
          outcome: 'not_started',
        },
        effects: [
          { step: 'split', status: 'not_started', detail: callerNow.code },
        ],
      },
    );
  }

  const current = await revalidateCurrent(context, now());
  if (!current.ok) {
    const released = phase({
      phase: 'not_started_revalidated',
      outcome: 'not_started',
      release: true,
      detail: current.code,
    });
    return terminalReport(
      context,
      'needs_input',
      current.code,
      current.message,
      'Re-plan after reconciling the task/config/message state.',
      {
        state_revision: released.ok ? released.revision : revision,
        reservation: {
          reservation_id: reservationId,
          phase: 'not_started',
          outcome: 'not_started',
        },
        effects: [
          { step: 'split', status: 'not_started', detail: current.code },
        ],
      },
    );
  }
  const pending = commitEffectIntent(
    context,
    reservationId,
    current.task.record.state_revision,
    current.task.identity.recordFile,
    'split_pending',
    now(),
    dependencies.signal,
  );
  if (!pending.ok) {
    const released = phase({
      phase: 'split_intent_refused',
      outcome: 'not_started',
      release: true,
      detail: pending.code,
    });
    return terminalReport(
      context,
      'needs_input',
      pending.code,
      pending.message,
      'Reconcile current authority/cancellation state before a new request.',
      {
        state_revision: released.ok ? released.revision : revision,
        reservation: {
          reservation_id: reservationId,
          phase: 'not_started',
          outcome: 'not_started',
        },
        effects: [
          { step: 'split', status: 'not_started', detail: pending.code },
        ],
      },
    );
  }
  revision = pending.revision;
  const placementResult = await resolvePanePlacement(context);
  if (!placementResult.ok) {
    const released = phase({
      phase: 'split_intent_refused',
      outcome: 'not_started',
      release: true,
      detail: placementResult.code,
    });
    return terminalReport(
      context,
      'failed',
      placementResult.code,
      placementResult.message,
      'Close or reclaim finished panes, or reuse an existing participant before retrying.',
      {
        state_revision: released.ok ? released.revision : revision,
        reservation: {
          reservation_id: reservationId,
          phase: 'not_started',
          outcome: 'not_started',
        },
        effects: [
          {
            step: 'split',
            status: 'not_started',
            detail: placementResult.code,
          },
        ],
      },
    );
  }
  const placement = placementResult.placement;
  if (!placement.ok) {
    const released = phase({
      phase: 'pane_layout_exhausted',
      outcome: 'not_started',
      release: true,
      detail: placement.code,
    });
    return terminalReport(
      context,
      'failed',
      placement.code,
      placement.message,
      'Close or reclaim finished panes, or reuse an existing participant before retrying.',
      {
        state_revision: released.ok ? released.revision : revision,
        reservation: {
          reservation_id: reservationId,
          phase: 'not_started',
          outcome: 'not_started',
        },
        effects: [
          { step: 'split', status: 'not_started', detail: placement.code },
        ],
      },
    );
  }
  const split = await context.ops.splitPane({
    paneId: placement.anchorPaneId,
    cwd: request.target.cwd,
    direction: placement.direction,
    ...(placement.ratio === undefined ? {} : { ratio: placement.ratio }),
    onReceipt: persistReceipt(context, reservationId, now),
  });
  if (!split.ok) {
    const unknown = split.status === 'unknown';
    const saved = phase({
      phase: unknown ? 'split_unknown' : 'split_failed',
      outcome: unknown ? 'unknown' : 'not_started',
      release: !unknown,
      detail: split.code,
    });
    return terminalReport(
      context,
      unknown ? 'unknown' : 'failed',
      split.code,
      split.detail,
      'Inspect the durable request and Herdr pane list; never retry a split with the same request id.',
      {
        state_revision: saved.ok ? saved.revision : revision,
        reservation: {
          reservation_id: reservationId,
          phase: unknown ? 'split_unknown' : 'split_failed',
        },
        effects: [{ step: 'split', status: split.status, detail: split.code }],
      },
    );
  }
  const pane = split.value;
  if (
    !PANE_ID.test(pane.paneId) ||
    pane.paneId === context.caller.paneId ||
    pane.paneId === placement.anchorPaneId ||
    pane.workspaceId !== context.caller.workspaceId ||
    pane.agent !== null ||
    pane.cwd === null ||
    !safePathEqual(pane.cwd, request.target.cwd)
  ) {
    const saved = phase({
      phase: 'split_identity_unknown',
      outcome: 'unknown',
      detail: 'split result identity mismatch',
      extra: { split_response_received: true },
    });
    return terminalReport(
      context,
      'unknown',
      'split_identity_unverified',
      'Herdr returned a pane whose exact owned identity/cwd could not be confirmed; no guessed cleanup was attempted.',
      null,
      {
        state_revision: saved.ok ? saved.revision : revision,
        effects: [
          { step: 'split', status: 'unknown', detail: 'identity/cwd mismatch' },
        ],
      },
    );
  }
  const created = phase({
    phase: 'pane_created',
    extra: {
      created_pane_id: pane.paneId,
      created_workspace_id: pane.workspaceId,
      created_terminal_id: pane.terminalId,
      created_tab_id: pane.tabId,
      created_cwd: pane.cwd,
      anchor_pane_id: placement.anchorPaneId,
      split_direction: placement.direction,
      split_ratio: placement.ratio ?? null,
    },
  });
  if (!created.ok)
    return terminalReport(
      context,
      'unknown',
      created.code,
      created.message,
      null,
      {
        state_revision: revision,
        target: { ...request.target, pane_id: pane.paneId },
      },
    );
  steps.push({
    step: 'split',
    status: 'completed',
    detail: `owned pane ${pane.paneId} from anchor ${placement.anchorPaneId} (${placement.direction}${placement.ratio === undefined ? '' : ` ratio ${String(placement.ratio)}`})`,
  });

  const readiness = await verifyAvailableShell(
    context.ops,
    {
      paneId: pane.paneId,
      workspaceId: pane.workspaceId,
      terminalId: pane.terminalId,
      cwd: request.target.cwd,
    },
    {
      budgetMs: request.readiness?.budget_ms ?? 10_000,
      intervalMs: request.readiness?.interval_ms ?? 100,
      maxSamples: request.readiness?.max_samples ?? 100,
      clock: now,
      ...(dependencies.sleeper === undefined
        ? {}
        : { sleeper: dependencies.sleeper }),
      shouldAbort: () => dependencies.signal?.aborted === true,
    },
  );
  const readyPhase = phase({
    phase:
      readiness.status === 'ready'
        ? 'shell_ready'
        : `readiness_${readiness.status}`,
    detail: readiness.code,
    extra: { readiness: readiness.evidence },
  });
  if (readiness.status !== 'ready') {
    steps.push({
      step: 'shell-readiness',
      status: readiness.status,
      detail: readiness.code,
    });
    const cleanup = await closeOwnedEmptyPane(
      context,
      reservationId,
      pane,
      now,
    );
    const cleanupConfirmed = cleanup.state === 'closed_owned_pane';
    const saved = phase({
      phase: `readiness_${readiness.status}_complete`,
      outcome: cleanupConfirmed ? 'not_started' : 'unknown',
      release: cleanupConfirmed,
      detail: readiness.code,
      extra: { cleanup: { state: cleanup.state, code: cleanup.code } },
    });
    const status: BootstrapStatus =
      readiness.status === 'unknown' || !cleanupConfirmed
        ? 'unknown'
        : 'failed';
    return terminalReport(
      context,
      status,
      `shell_readiness_${readiness.status}`,
      `No agent was started because the owned pane did not reach verified available-shell state (${readiness.code}).`,
      cleanupConfirmed
        ? 'Inspect readiness samples and create a new request only after the pane is reconciled.'
        : 'Reconcile the owned pane; no automatic close/retry is permitted.',
      {
        state_revision: saved.ok
          ? saved.revision
          : readyPhase.ok
            ? readyPhase.revision
            : revision,
        target: { ...request.target, pane_id: pane.paneId },
        readiness: readiness.evidence,
        reservation: {
          reservation_id: reservationId,
          phase: `readiness_${readiness.status}`,
          cleanup: cleanup.state,
        },
        effects: [
          ...steps,
          { step: 'cleanup', status: cleanup.state, detail: cleanup.code },
        ],
      },
    );
  }
  steps.push({
    step: 'shell-readiness',
    status: 'ready',
    detail: `${readiness.evidence.attempts} samples in ${readiness.evidence.elapsed_ms}ms`,
  });

  const callerBeforeStart = await liveCallerAgain(context);
  const paneBeforeStart = await context.ops.paneGet(
    pane.paneId,
    READ_TIMEOUT_MS,
  );
  const beforeStart = await revalidateCurrent(context, now());
  if (
    !callerBeforeStart.ok ||
    !paneBeforeStart.ok ||
    !paneSnapshotMatches(paneBeforeStart.value, pane) ||
    !beforeStart.ok
  ) {
    const reason = !callerBeforeStart.ok
      ? callerBeforeStart.code
      : !paneBeforeStart.ok
        ? paneBeforeStart.code
        : !paneSnapshotMatches(paneBeforeStart.value, pane)
          ? 'owned_pane_identity_drift'
          : !beforeStart.ok
            ? beforeStart.code
            : 'revalidation_not_required';
    const cleanup = await closeOwnedEmptyPane(
      context,
      reservationId,
      pane,
      now,
    );
    const saved = phase({
      phase: 'pre_start_revalidation_failed',
      outcome:
        cleanup.state === 'closed_owned_pane' ? 'not_started' : 'unknown',
      release: cleanup.state === 'closed_owned_pane',
      detail: reason,
      extra: { cleanup: { state: cleanup.state, code: cleanup.code } },
    });
    return terminalReport(
      context,
      cleanup.state === 'closed_owned_pane' ? 'needs_input' : 'unknown',
      reason,
      'Caller/task/pane identity changed after readiness; agent start was not attempted.',
      'Reconcile the task and owned pane before creating a new request.',
      {
        state_revision: saved.ok ? saved.revision : revision,
        target: { ...request.target, pane_id: pane.paneId },
        readiness: readiness.evidence,
        effects: [
          ...steps,
          { step: 'cleanup', status: cleanup.state, detail: cleanup.code },
        ],
      },
    );
  }
  const refuseManagedStart = async (
    code: string,
    detail: string,
  ): Promise<VisibleBootstrapReport> => {
    const cleanup = await closeOwnedEmptyPane(
      context,
      reservationId,
      pane,
      now,
    );
    const cleanupConfirmed = cleanup.state === 'closed_owned_pane';
    const saved = phase({
      phase: 'managed_sdk_setup_failed',
      outcome: cleanupConfirmed ? 'not_started' : 'unknown',
      release: cleanupConfirmed,
      detail: code,
      extra: { cleanup: { state: cleanup.state, code: cleanup.code } },
    });
    return terminalReport(
      context,
      cleanupConfirmed ? 'needs_input' : 'unknown',
      code,
      detail,
      cleanupConfirmed
        ? 'Correct the managed SDK paths/config and submit a fresh request id.'
        : 'Reconcile the owned pane; no automatic cleanup or retry is permitted.',
      {
        state_revision: saved.ok ? saved.revision : revision,
        target: { ...request.target, pane_id: pane.paneId },
        readiness: readiness.evidence,
        reservation: {
          reservation_id: reservationId,
          phase: 'managed_sdk_setup_failed',
          cleanup: cleanup.state,
        },
        effects: [
          ...steps,
          { step: 'managed-sdk-config', status: 'failed', detail: code },
          { step: 'cleanup', status: cleanup.state, detail: cleanup.code },
        ],
      },
    );
  };
  const unknownManagedStart = (
    code: string,
    detail: string,
  ): VisibleBootstrapReport => {
    const saved = phase({
      phase: 'managed_sdk_start_unknown',
      outcome: 'unknown',
      detail: code,
    });
    return terminalReport(
      context,
      'unknown',
      code,
      detail,
      'Inspect the managed SDK control response and owned pane; never re-submit this request id.',
      {
        state_revision: saved.ok ? saved.revision : revision,
        target: { ...request.target, pane_id: pane.paneId },
        readiness: readiness.evidence,
        reservation: {
          reservation_id: reservationId,
          phase: 'managed_sdk_start_unknown',
        },
        effects: [
          ...steps,
          { step: 'managed-sdk-start', status: 'unknown', detail: code },
        ],
      },
    );
  };
  const startPending = commitEffectIntent(
    context,
    reservationId,
    beforeStart.task.record.state_revision,
    beforeStart.task.identity.recordFile,
    request.managed_runtime === undefined
      ? 'agent_start_pending'
      : 'managed_sdk_start_pending',
    now(),
    dependencies.signal,
  );
  if (!startPending.ok) {
    const cleanup = await closeOwnedEmptyPane(
      context,
      reservationId,
      pane,
      now,
    );
    const saved = phase({
      phase: 'start_intent_refused',
      outcome:
        cleanup.state === 'closed_owned_pane' ? 'not_started' : 'unknown',
      release: cleanup.state === 'closed_owned_pane',
      detail: startPending.code,
      extra: { cleanup: { state: cleanup.state, code: cleanup.code } },
    });
    return terminalReport(
      context,
      cleanup.state === 'closed_owned_pane' ? 'needs_input' : 'unknown',
      startPending.code,
      startPending.message,
      'Reconcile current task authority and the owned pane before any new request.',
      {
        state_revision: saved.ok ? saved.revision : revision,
        target: { ...request.target, pane_id: pane.paneId },
        readiness: readiness.evidence,
        effects: [
          ...steps,
          { step: 'cleanup', status: cleanup.state, detail: cleanup.code },
        ],
      },
    );
  }
  revision = startPending.revision;
  let nativeSessionId: string;
  let managedLaunch: BootstrapStartedManagedSdk | null = null;
  let managedConfigPath: string | null = null;
  let managedConfigDigest: string | null = null;
  if (request.managed_runtime !== undefined) {
    const runtimePaths = managedRuntimePathsFor(request);
    if (!runtimePaths.ok)
      return refuseManagedStart(runtimePaths.code, runtimePaths.message);
    const config = writeManagedSdkConfig(
      request,
      context,
      pane.paneId,
      runtimePaths.paths,
    );
    if (!config.ok)
      return refuseManagedStart(
        config.code,
        'The private immutable SDK configuration could not be created and verified.',
      );
    managedConfigPath = runtimePaths.paths.configPath;
    managedConfigDigest = config.digest;
    const configRecorded = phase({
      phase: 'managed_sdk_start_pending',
      extra: {
        managed_sdk_config: {
          path: runtimePaths.paths.configPath,
          digest: config.digest,
          journal_path: runtimePaths.paths.journalPath,
          control_socket_path: runtimePaths.paths.controlSocketPath,
          session_id: request.participant.native_session_selector,
          model: {
            provider: 'openrouter',
            id: request.selected_model.openrouter_model!,
          },
          bootstrap_extension_path: request.bootstrap.extension_entry,
          herdr_agent_name: context.herdrAgent,
          herdr_pane_id: pane.paneId,
          ...(runtimePaths.paths.handoffContextFile === undefined
            ? {}
            : { handoff_context_file: runtimePaths.paths.handoffContextFile }),
        },
      },
    });
    if (!configRecorded.ok)
      return refuseManagedStart(
        configRecorded.code,
        'Managed SDK config was created but could not be bound to the durable reservation.',
      );
    const startManagedSdk = context.ops.startManagedSdk;
    const model = request.selected_model.openrouter_model;
    if (startManagedSdk === undefined || model === undefined)
      return refuseManagedStart(
        'managed_start_unavailable',
        'No managed SDK start port or explicit OpenRouter model is available; legacy Pi fallback is forbidden.',
      );
    const managedInput: BootstrapManagedSdkStartInput = {
      name: context.herdrAgent,
      paneId: pane.paneId,
      workspaceId: pane.workspaceId,
      terminalId: pane.terminalId,
      cwd: request.target.cwd,
      sessionId: request.participant.native_session_selector,
      openrouterModel: model,
      sdkModulePath: runtimePaths.paths.sdkModulePath,
      journalPath: runtimePaths.paths.journalPath,
      controlSocketPath: runtimePaths.paths.controlSocketPath,
      bootstrapExtensionPath: request.bootstrap.extension_entry,
      configPath: runtimePaths.paths.configPath,
      configDigest: config.digest,
      timeoutMs: context.request.target.start_timeout_ms ?? START_TIMEOUT_MS,
      ...(runtimePaths.paths.automaticHandoffFile === undefined
        ? {}
        : { automaticHandoffFile: runtimePaths.paths.automaticHandoffFile }),
      ...(runtimePaths.paths.handoffContextFile === undefined
        ? {}
        : { handoffContextFile: runtimePaths.paths.handoffContextFile }),
      onReceipt: persistReceipt(context, reservationId, now),
    };
    let startedManaged: Awaited<ReturnType<typeof startManagedSdk>>;
    try {
      startedManaged = await startManagedSdk(managedInput);
    } catch {
      return unknownManagedStart(
        'managed_sdk_start_exception',
        'Managed SDK start threw after submission may have begun; no retry or cleanup was attempted.',
      );
    }
    if (!startedManaged.ok) {
      return startedManaged.status === 'unknown'
        ? unknownManagedStart(startedManaged.code, startedManaged.detail)
        : refuseManagedStart(startedManaged.code, startedManaged.detail);
    }
    if (
      !acceptedManagedSdkStartReceipt(startedManaged.receipt, {
        paneId: pane.paneId,
        configPath: runtimePaths.paths.configPath,
      })
    )
      return unknownManagedStart(
        'managed_sdk_start_receipt_unverified',
        'The fixed managed CLI submission receipt did not match the exact pane/config command.',
      );
    if (
      !managedSdkLaunchMatches(
        startedManaged.value,
        context,
        pane,
        runtimePaths.paths,
      )
    )
      return unknownManagedStart(
        'managed_sdk_control_unverified',
        'Herdr name/state, SDK control metadata, socket peer owner and pane foreground PID did not agree.',
      );
    managedLaunch = startedManaged.value;
    nativeSessionId = startedManaged.value.sessionId;
  } else {
    const started = await context.ops.startAgent({
      name: context.herdrAgent,
      paneId: pane.paneId,
      sessionId: request.participant.native_session_selector,
      extensionEntry: request.bootstrap.extension_entry,
      timeoutMs: request.target.start_timeout_ms ?? START_TIMEOUT_MS,
      ...(request.selected_model.openrouter_model
        ? { openrouterModel: request.selected_model.openrouter_model }
        : {}),
      onReceipt: persistReceipt(context, reservationId, now),
    });
    if (!started.ok) {
      const cleanup =
        started.status === 'unknown'
          ? null
          : await closeOwnedEmptyPane(context, reservationId, pane, now);
      const noEffect = cleanup?.state === 'closed_owned_pane';
      const saved = phase({
        phase:
          started.status === 'unknown'
            ? 'agent_start_unknown'
            : 'agent_start_failed',
        outcome: noEffect ? 'not_started' : 'unknown',
        release: noEffect,
        detail: started.code,
        ...(cleanup
          ? { extra: { cleanup: { state: cleanup.state, code: cleanup.code } } }
          : {}),
      });
      return terminalReport(
        context,
        started.status === 'unknown' ? 'unknown' : 'failed',
        started.code,
        started.detail,
        'Inspect the exact Herdr start result; do not retry or close a pane that may now contain an agent.',
        {
          state_revision: saved.ok ? saved.revision : revision,
          target: { ...request.target, pane_id: pane.paneId },
          readiness: readiness.evidence,
          effects: [
            ...steps,
            {
              step: 'agent-start',
              status: started.status,
              detail: started.code,
            },
          ],
        },
      );
    }
    const native = reportedSessionIdentity(
      started.value.sessionKind,
      started.value.sessionValue,
    );
    if (
      started.value.name !== context.herdrAgent ||
      started.value.paneId !== pane.paneId ||
      started.value.workspaceId !== pane.workspaceId ||
      started.value.terminalId !== pane.terminalId ||
      native.status !== 'match' ||
      native.identity !== request.participant.native_session_selector ||
      started.value.harness !== 'pi' ||
      started.value.cwd === null ||
      !safePathEqual(started.value.cwd, request.target.cwd) ||
      started.value.launchPending ||
      !acceptedPiArgv(
        started.value.argv,
        request.participant.native_session_selector,
        context.herdrAgent,
        request.bootstrap.extension_entry,
        request.selected_model.openrouter_model,
      ) ||
      !started.value.interactiveReady
    ) {
      const saved = phase({
        phase: 'agent_identity_unknown',
        outcome: 'unknown',
        detail: 'exact successor identity not proven',
        extra: {
          created_pane_id: pane.paneId,
          observed_agent_name: started.value.name,
          observed_session_kind: started.value.sessionKind,
          observed_session_id:
            native.status === 'match' ? native.identity : null,
        },
      });
      return terminalReport(
        context,
        'unknown',
        'agent_identity_unverified',
        'Agent start returned but the exact live successor identity/interactive state is unconfirmed; no binding or prompt was written.',
        null,
        {
          state_revision: saved.ok ? saved.revision : revision,
          target: { ...request.target, pane_id: pane.paneId },
          readiness: readiness.evidence,
          effects: [
            ...steps,
            {
              step: 'agent-start',
              status: 'unknown',
              detail: 'identity mismatch',
            },
          ],
        },
      );
    }
    nativeSessionId = native.identity;
  }
  const callerAfterStart = await liveCallerAgain(context);
  const authorityAfterStart = await revalidateCurrent(context, now());
  if (!callerAfterStart.ok || !authorityAfterStart.ok) {
    const reason = !callerAfterStart.ok
      ? callerAfterStart.code
      : authorityAfterStart.ok
        ? 'post_start_revalidation_unexpected'
        : authorityAfterStart.code;
    const detail = !callerAfterStart.ok
      ? callerAfterStart.message
      : authorityAfterStart.ok
        ? 'Post-start authority unexpectedly passed the failure branch.'
        : authorityAfterStart.message;
    const saved = phase({
      phase: 'post_start_revalidation_failed',
      outcome: 'unknown',
      detail: reason,
    });
    return terminalReport(
      context,
      'needs_input',
      reason,
      `${detail} The successor may be running but remains unbound and unprompted.`,
      'Reconcile current task authority and the owned pane before creating a new request.',
      {
        state_revision: saved.ok ? saved.revision : revision,
        target: { ...request.target, pane_id: pane.paneId },
        readiness: readiness.evidence,
        effects: [
          ...steps,
          {
            step: managedLaunch === null ? 'agent-start' : 'managed-sdk-start',
            status: 'blocked',
            detail: reason,
          },
        ],
      },
    );
  }
  const startedPhase = phase({
    phase: managedLaunch === null ? 'agent_started' : 'managed_sdk_started',
    extra: {
      created_pane_id: pane.paneId,
      created_workspace_id: pane.workspaceId,
      created_terminal_id: pane.terminalId,
      created_cwd: pane.cwd,
      observed_session_id: nativeSessionId,
      ...(managedLaunch === null
        ? {}
        : {
            managed_sdk_control: {
              runtime: 'sdk',
              identity_provenance: managedLaunch.identityProvenance,
              control_schema: managedLaunch.controlSchema,
              process_pid: managedLaunch.processPid,
              socket_peer_pid: managedLaunch.socketPeerPid,
              foreground_process_pid: managedLaunch.foregroundProcessPid,
              model: managedLaunch.launch.model,
              journal_path: managedLaunch.launch.journalPath,
              config_path: managedConfigPath,
              config_digest: managedConfigDigest,
            },
          }),
    },
  });
  if (!startedPhase.ok)
    return terminalReport(
      context,
      'unknown',
      startedPhase.code,
      startedPhase.message,
      null,
      { readiness: readiness.evidence, state_revision: revision },
    );
  steps.push({
    step: managedLaunch === null ? 'agent-start' : 'managed-sdk-start',
    status: 'completed',
    detail:
      managedLaunch === null
        ? 'Pi agent start matched exact native session id, extension argv, model selection and interactive readiness.'
        : 'Managed SDK launch matched authenticated control, actual model/session/config metadata, socket peer owner and pane foreground PID; Herdr session-report ID was not used.',
  });
  const bindingPhase = phase({ phase: 'binding_pending' });
  if (!bindingPhase.ok)
    return terminalReport(
      context,
      'unknown',
      bindingPhase.code,
      bindingPhase.message,
      null,
      { readiness: readiness.evidence, state_revision: revision },
    );
  const participant: CollabBindingParticipant = {
    agent_id: request.participant.agent_id,
    harness: request.participant.harness,
    cwd: request.target.cwd,
    herdr_agent: context.herdrAgent,
    pane_id: pane.paneId,
    native_session_id: nativeSessionId,
  };
  let binding: CollabBinding;
  try {
    if (
      context.binding.participants.some(
        (item) =>
          item.agent_id === participant.agent_id ||
          item.herdr_agent === participant.herdr_agent,
      )
    )
      throw new Error('binding_participant_conflict');
    binding = {
      ...context.binding,
      participants: [...context.binding.participants, participant],
    };
  } catch {
    const saved = phase({
      phase: 'binding_conflict',
      outcome: 'unknown',
      detail: 'task-local participant conflict',
    });
    return terminalReport(
      context,
      'needs_input',
      'binding_participant_conflict',
      'Agent started but binding conflicts; it is left running and no notification was sent.',
      null,
      {
        state_revision: saved.ok ? saved.revision : revision,
        target: { ...request.target, pane_id: pane.paneId },
        readiness: readiness.evidence,
        effects: [
          ...steps,
          { step: 'task-binding', status: 'conflict', detail: null },
        ],
      },
    );
  }
  const savedBinding = writeBindingExclusive(
    context.task.taskRoot,
    context.derivedBindingFile,
    binding,
  );
  if (!savedBinding.ok) {
    const saved = phase({
      phase: 'binding_write_failed',
      outcome: 'unknown',
      detail: savedBinding.code,
    });
    return terminalReport(
      context,
      'unknown',
      savedBinding.code,
      'Agent started but its task-local routing binding could not be persisted; no notification was sent.',
      'Reconcile the running agent and binding before any new request.',
      {
        state_revision: saved.ok ? saved.revision : revision,
        target: { ...request.target, pane_id: pane.paneId },
        readiness: readiness.evidence,
        effects: [
          ...steps,
          { step: 'task-binding', status: 'failed', detail: savedBinding.code },
        ],
      },
    );
  }
  const bindingStored = phase({
    phase: 'binding_written',
    extra: { derived_binding_digest: savedBinding.digest },
  });
  if (!bindingStored.ok)
    return terminalReport(
      context,
      'unknown',
      bindingStored.code,
      bindingStored.message,
      null,
      {
        target: { ...request.target, pane_id: pane.paneId },
        readiness: readiness.evidence,
        effects: [
          ...steps,
          {
            step: 'task-binding',
            status: 'written_unrecorded',
            detail: context.derivedBindingFile,
          },
        ],
      },
    );
  steps.push({
    step: 'task-binding',
    status: 'persisted',
    detail:
      'Task-local routing metadata written after exact live identity; it grants no authority.',
  });

  const callerBeforeNotify = await liveCallerAgain(context);
  const recipientAgents = await context.ops.listAgents();
  const recipientLive = recipientAgents.ok
    ? liveParticipant(
        participant,
        {
          agent_id: request.participant.agent_id,
          session_id: request.participant.native_session_selector,
          harness: request.participant.harness,
        },
        recipientAgents.agents,
      )
    : {
        ok: false as const,
        code: 'herdr_agent_list_unavailable',
        message: recipientAgents.detail,
      };
  const revalidated = await revalidateCurrent(context, now());
  if (
    !callerBeforeNotify.ok ||
    !recipientAgents.ok ||
    !recipientLive.ok ||
    !revalidated.ok
  ) {
    const reason = !callerBeforeNotify.ok
      ? callerBeforeNotify.code
      : !recipientAgents.ok
        ? 'herdr_agent_list_unavailable'
        : !recipientLive.ok
          ? recipientLive.code
          : revalidated.ok
            ? 'revalidation_unexpected'
            : revalidated.code;
    const detail = !callerBeforeNotify.ok
      ? callerBeforeNotify.message
      : !recipientAgents.ok
        ? recipientAgents.detail
        : !recipientLive.ok
          ? recipientLive.message
          : revalidated.ok
            ? 'Task revalidation unexpectedly passed.'
            : revalidated.message;
    const saved = phase({
      phase: 'notify_revalidation_failed',
      outcome: 'unknown',
      detail: reason,
    });
    return terminalReport(
      context,
      'needs_input',
      reason,
      detail,
      'Reconcile the caller, successor and current task before issuing a new request.',
      {
        state_revision: saved.ok ? saved.revision : revision,
        target: { ...request.target, pane_id: pane.paneId },
        readiness: readiness.evidence,
        effects: [
          ...steps,
          { step: 'notify', status: 'not_started', detail: reason },
        ],
      },
    );
  }
  const notificationPending = commitEffectIntent(
    context,
    reservationId,
    revalidated.task.record.state_revision,
    revalidated.task.identity.recordFile,
    'notify_pending',
    now(),
    dependencies.signal,
  );
  if (!notificationPending.ok) {
    const saved = phase({
      phase: 'notify_intent_refused',
      outcome: 'unknown',
      detail: notificationPending.code,
    });
    return terminalReport(
      context,
      'needs_input',
      notificationPending.code,
      notificationPending.message,
      'Reconcile current task authority before sending the registered message.',
      {
        state_revision: saved.ok ? saved.revision : revision,
        target: { ...request.target, pane_id: pane.paneId },
        readiness: readiness.evidence,
        effects: [
          ...steps,
          {
            step: 'notify',
            status: 'not_started',
            detail: notificationPending.code,
          },
        ],
      },
    );
  }
  revision = notificationPending.revision;
  const notify = dependencies.notify ?? notifyRegisteredMessage;
  const notification = await notify({
    taskRoot: context.task.taskRoot,
    messageId: request.message_pointer.message_id,
    bindingFile: context.derivedBindingFile,
    apply: true,
    retry: false,
    callerPane: context.caller.paneId,
    transport: guardedBootstrapTransport(
      context,
      reservationId,
      now,
      dependencies.signal,
    ),
    clock: now(),
  });
  const summary = notificationSummary(notification);
  const submitted =
    notification.ok && notification.value.status === 'submitted';
  const recorded =
    notification.ok && notification.value.status === 'already_recorded';
  const final = phase({
    phase: submitted || recorded ? 'completed' : 'notification_unknown',
    outcome: submitted
      ? 'submitted'
      : recorded
        ? 'already_recorded'
        : 'unknown',
    release: submitted || recorded,
    detail: notification.ok ? notification.value.detail : notification.message,
    extra: {
      notification: summary,
      message_consumed: false,
      task_accepted: false,
    },
  });
  steps.push({
    step: 'notify-registered-message',
    status: submitted ? 'submitted' : recorded ? 'already_recorded' : 'unknown',
    detail: typeof summary['detail'] === 'string' ? summary['detail'] : null,
  });
  if (!submitted && !recorded)
    return terminalReport(
      context,
      'unknown',
      'notification_not_confirmed',
      'Registered-message submission was not confirmed; no second prompt or automatic retry was attempted.',
      'Inspect the persisted delivery/reservation state before any new request.',
      {
        state_revision: final.ok ? final.revision : revision,
        target: { ...request.target, pane_id: pane.paneId },
        readiness: readiness.evidence,
        reservation: {
          reservation_id: reservationId,
          phase: 'notification_unknown',
        },
        notification: summary,
        effects: steps,
      },
    );
  const status = submitted ? 'applied' : 'already_recorded';
  return successReport('apply', request, context.requestDigest, status, {
    task_id: context.task.record.task_id,
    state_revision: final.ok ? final.revision : revision,
    caller: callerSummary(context),
    participant: participantSummary(context),
    target: {
      ...request.target,
      pane_id: pane.paneId,
      anchor_pane_id: placement.anchorPaneId,
      direction: placement.direction,
      split_ratio: placement.ratio ?? null,
      placement:
        request.target.direction === undefined ? 'adaptive' : 'explicit',
      split_argv: splitReportArgv({
        anchorPaneId: placement.anchorPaneId,
        cwd: request.target.cwd,
        direction: placement.direction,
        ratio: placement.ratio,
      }),
    },
    bootstrap: {
      config_digest: context.configDigest,
      bundle_manifest_digest: context.bundle.digest,
      extension_entry: request.bootstrap.extension_entry,
      runtime:
        managedLaunch === null
          ? 'accepted_artifact_digest_match'
          : 'managed_sdk_control_observed',
      authority: 'default-deny-until-recorded-transfer-completes',
      gate_registration: 'not_independently_observed',
      bootstrap_extension_load:
        managedLaunch === null
          ? 'not_independently_observed'
          : 'control_metadata_observed',
      model:
        managedLaunch === null
          ? 'daily_default_launch; selected_runtime_inheritance_unverified'
          : {
              ...managedLaunch.launch.model,
              observation: 'owned-pi-sdk-control',
            },
      ...(managedLaunch === null
        ? {}
        : {
            managed_sdk_control: {
              identity_provenance: managedLaunch.identityProvenance,
              control_schema: managedLaunch.controlSchema,
              session_id: managedLaunch.sessionId,
              process_pid: managedLaunch.processPid,
              socket_peer_pid: managedLaunch.socketPeerPid,
              foreground_process_pid: managedLaunch.foregroundProcessPid,
              herdr_agent_name: managedLaunch.launch.herdrAgentName,
              herdr_pane_id: managedLaunch.paneId,
              sdk_module_path: managedLaunch.launch.sdkModulePath,
              bootstrap_extension_path:
                managedLaunch.launch.bootstrapExtensionPath,
              journal_path: managedLaunch.launch.journalPath,
              managed_config_path: managedConfigPath,
              managed_config_digest: managedConfigDigest,
              handoff_context_file:
                request.managed_runtime?.handoff_context_file ?? null,
              ready: managedLaunch.launch.ready,
            },
          }),
    },
    reservation: {
      reservation_id: reservationId,
      phase: 'completed',
      outcome: submitted ? 'submitted' : 'already_recorded',
    },
    readiness: readiness.evidence,
    effects: steps,
    notification: summary,
    limits: [
      managedLaunch === null
        ? 'agent_start_and_extension_argument_do_not_prove_gate_registration'
        : 'managed_sdk_extension_path_observed_but_gate_registration_not_independently_proven',
      'new_successor_capabilities_are_not_synthesized',
      'message_submitted_not_consumed_or_accepted',
      'no_old_writer_quiescence_or_native_archive_proof',
      ...(managedLaunch === null
        ? ['selected_runtime_model_inheritance_unverified']
        : []),
    ],
  });
}

async function applyReuse(
  context: BootstrapContext,
  reservationId: string,
  reservationRevision: number,
  dependencies: VisibleBootstrapDependencies,
  now: () => number,
): Promise<VisibleBootstrapReport> {
  const request = context.request;
  const existing = bindingParticipant(
    context.binding,
    request.participant.agent_id,
  );
  if (existing === null)
    return terminalReport(
      context,
      'needs_input',
      'unsupported_reuse',
      'Exact task-bound participant is absent.',
      null,
    );
  let revision = reservationRevision;
  const caller = await liveCallerAgain(context);
  if (!caller.ok)
    return terminalReport(
      context,
      'needs_input',
      caller.code,
      caller.message,
      'Run from the exact bound caller pane.',
      { reservation: { reservation_id: reservationId, phase: 'reserved' } },
    );
  const listed = await context.ops.listAgents();
  if (!listed.ok)
    return terminalReport(
      context,
      'unknown',
      'herdr_agent_list_unavailable',
      listed.detail,
      null,
      { reservation: { reservation_id: reservationId, phase: 'reserved' } },
    );
  const recipient = liveParticipant(
    existing,
    {
      agent_id: request.participant.agent_id,
      session_id: request.participant.native_session_selector,
      harness: request.participant.harness,
    },
    listed.agents,
  );
  if (!recipient.ok)
    return terminalReport(
      context,
      'needs_input',
      'unsupported_reuse',
      recipient.message,
      'Existing-participant reuse never falls back to a split or starts another agent.',
      { target: { ...request.target, pane_id: existing.pane_id } },
    );
  const current = await revalidateCurrent(context, now());
  if (!current.ok)
    return terminalReport(
      context,
      'needs_input',
      current.code,
      current.message,
      'Re-plan against current task and cancellation state.',
      { target: { ...request.target, pane_id: existing.pane_id } },
    );
  const intent = commitEffectIntent(
    context,
    reservationId,
    current.task.record.state_revision,
    current.task.identity.recordFile,
    'notify_pending',
    now(),
    dependencies.signal,
  );
  if (!intent.ok)
    return terminalReport(
      context,
      'needs_input',
      intent.code,
      intent.message,
      'Reconcile current task authority/cancellation state before sending the message.',
      {
        reservation: {
          reservation_id: reservationId,
          phase: 'notify_intent_refused',
        },
      },
    );
  revision = intent.revision;
  const notify = dependencies.notify ?? notifyRegisteredMessage;
  const result = await notify({
    taskRoot: context.task.taskRoot,
    messageId: request.message_pointer.message_id,
    bindingFile: context.bindingFile,
    apply: true,
    retry: false,
    callerPane: context.caller.paneId,
    transport: guardedBootstrapTransport(
      context,
      reservationId,
      now,
      dependencies.signal,
    ),
    clock: now(),
  });
  const summary = notificationSummary(result);
  const submitted = result.ok && result.value.status === 'submitted';
  const recorded = result.ok && result.value.status === 'already_recorded';
  const final = updateReservation(
    context,
    reservationId,
    {
      phase: submitted || recorded ? 'completed' : 'notification_unknown',
      outcome: submitted
        ? 'submitted'
        : recorded
          ? 'already_recorded'
          : 'unknown',
      release: submitted || recorded,
      detail: result.ok ? result.value.detail : result.message,
      extra: { notification: summary },
    },
    now(),
  );
  const step = {
    step: 'reuse-and-notify',
    status: submitted ? 'submitted' : recorded ? 'already_recorded' : 'unknown',
    detail: typeof summary['detail'] === 'string' ? summary['detail'] : null,
  };
  if (!submitted && !recorded)
    return terminalReport(
      context,
      'unknown',
      'reuse_notification_unconfirmed',
      'Existing participant notification was not confirmed; no retry or new agent was started.',
      'Inspect the original delivery/reservation before any new request.',
      {
        state_revision: final.ok ? final.revision : revision,
        target: { ...request.target, pane_id: existing.pane_id },
        reservation: {
          reservation_id: reservationId,
          phase: 'notification_unknown',
        },
        effects: [step],
        notification: summary,
      },
    );
  return successReport(
    'apply',
    request,
    context.requestDigest,
    submitted ? 'applied' : 'already_recorded',
    {
      task_id: context.task.record.task_id,
      state_revision: final.ok ? final.revision : revision,
      caller: callerSummary(context),
      participant: {
        agent_id: request.participant.agent_id,
        harness: request.participant.harness,
        pane_id: existing.pane_id,
        session_id: request.participant.native_session_selector,
        capabilities: 'runtime_card_checked',
      },
      target: { ...request.target, pane_id: existing.pane_id },
      bootstrap: {
        config_digest: context.configDigest,
        bundle_manifest_digest: context.bundle.digest,
        gate_registration: 'existing_session_not_independently_observed',
      },
      reservation: {
        reservation_id: reservationId,
        phase: 'completed',
        outcome: submitted ? 'submitted' : 'already_recorded',
      },
      effects: [step],
      notification: summary,
      limits: [
        'reuse_did_not_query_process_info_or_wait_for_shell',
        'reuse_did_not_start_or_close_an_agent',
        'message_submitted_not_consumed_or_accepted',
      ],
    },
  );
}

export async function planVisibleBootstrap(
  input: LoadedVisibleBootstrapRequest | VisibleBootstrapRequest,
  dependencies: VisibleBootstrapDependencies = {},
): Promise<VisibleBootstrapReport> {
  const request = requestOf(input);
  const prepared = await prepare(input, 'plan', dependencies);
  if (!prepared.ok) return prepared.report;
  const prior = reservationFor(
    prepared.context.task.record,
    request.request_id,
  );
  if (prior === 'ambiguous')
    return failureReport(
      'plan',
      request,
      requestDigestOf(input),
      'unknown',
      'request_reservation_ambiguous',
      'Multiple durable reservations already use this request id.',
    );
  if (prior !== null && !deadNoEffectBootstrap(prior)) {
    const digest = bootstrapData(prior)['request_digest'];
    if (digest !== requestDigestOf(input))
      return failureReport(
        'plan',
        request,
        requestDigestOf(input),
        'invalid',
        'request_id_content_conflict',
        'request_id is already pinned to different request bytes.',
      );
    if (prior.released_at === null)
      return failureReport(
        'plan',
        request,
        requestDigestOf(input),
        'reconcile_required',
        'request_in_progress_or_ambiguous',
        'A prior apply reserved this request but did not reach a recorded terminal result.',
        'Inspect the durable pane, agent and delivery state; plan never repairs an ambiguous effect.',
        {
          state_revision: prepared.context.task.record.state_revision,
          reservation: reservationSummary(prior),
          effects: [
            {
              step: 'existing-request',
              status: 'no-effects',
              detail: 'Plan never repeats or repairs an effect.',
            },
          ],
        },
      );
    return successReport(
      'plan',
      request,
      requestDigestOf(input),
      'already_recorded',
      {
        state_revision: prepared.context.task.record.state_revision,
        reservation: reservationSummary(prior),
        effects: [
          {
            step: 'existing-request',
            status: 'already_recorded',
            detail: 'Plan never repeats or repairs an effect.',
          },
        ],
      },
    );
  }
  return planReport(prepared.context, 'plan');
}

export async function applyVisibleBootstrap(
  input: LoadedVisibleBootstrapRequest | VisibleBootstrapRequest,
  dependencies: VisibleBootstrapDependencies = {},
): Promise<VisibleBootstrapReport> {
  const request = requestOf(input);
  const requestDigest = requestDigestOf(input);
  const now = dependencies.clock ?? Date.now;
  const opened = await openMessageTask(request.task_root);
  if (!opened.ok)
    return failureReport(
      'apply',
      request,
      requestDigest,
      'needs_input',
      opened.code,
      opened.message,
      opened.nextAction,
    );
  const prior = reservationFor(opened.value.record, request.request_id);
  if (prior === 'ambiguous')
    return failureReport(
      'apply',
      request,
      requestDigest,
      'unknown',
      'request_reservation_ambiguous',
      'Multiple reservations already use this request id.',
    );
  if (prior !== null && !deadNoEffectBootstrap(prior)) {
    if (bootstrapData(prior)['request_digest'] !== requestDigest)
      return failureReport(
        'apply',
        request,
        requestDigest,
        'invalid',
        'request_id_content_conflict',
        'request_id was already used with different request bytes.',
      );
    const phase =
      typeof bootstrapData(prior)['phase'] === 'string'
        ? bootstrapData(prior)['phase']
        : (prior.phase ?? 'unknown');
    if (
      phase === 'completed' ||
      prior.outcome === 'submitted' ||
      prior.outcome === 'already_recorded'
    )
      return successReport(
        'apply',
        request,
        requestDigest,
        'already_recorded',
        {
          task_id: opened.value.record.task_id,
          state_revision: opened.value.record.state_revision,
          reservation: reservationSummary(prior),
          effects: [
            {
              step: 'duplicate',
              status: 'already_recorded',
              detail: 'No split/start/prompt operation was repeated.',
            },
          ],
        },
      );
    return failureReport(
      'apply',
      request,
      requestDigest,
      'reconcile_required',
      'request_in_progress_or_ambiguous',
      `Existing bootstrap request is in phase ${String(phase)}; no effect was repeated.`,
      'Inspect the persisted pane, agent, binding and delivery state before creating a new request.',
      {
        state_revision: opened.value.record.state_revision,
        reservation: reservationSummary(prior),
      },
    );
  }
  const prepared = await prepare(input, 'apply', dependencies);
  if (!prepared.ok) return prepared.report;
  const context = prepared.context;
  const namespace = await assertMessageTaskCurrent(context.task);
  if (namespace !== null)
    return failureReport(
      'apply',
      request,
      requestDigest,
      'needs_input',
      namespace.code,
      namespace.message,
      namespace.nextAction,
    );
  const reservation = reserveRequest(context, now());
  if (!reservation.ok) {
    const existing = reservation.existing;
    return failureReport(
      'apply',
      request,
      requestDigest,
      reservation.code === 'request_id_content_conflict'
        ? 'invalid'
        : existing === undefined
          ? 'needs_input'
          : 'reconcile_required',
      reservation.code,
      reservation.message,
      'Inspect the serialized request reservation; no duplicate effect is permitted.',
      {
        state_revision: opened.value.record.state_revision,
        ...(existing === undefined
          ? {}
          : { reservation: reservationSummary(existing) }),
      },
    );
  }
  return request.target.choice === 'sibling'
    ? applySibling(
        context,
        reservation.reservationId,
        reservation.revision,
        dependencies,
        now,
      )
    : applyReuse(
        context,
        reservation.reservationId,
        reservation.revision,
        dependencies,
        now,
      );
}

function writeBindingExclusive(
  taskRoot: string,
  target: string,
  binding: CollabBinding,
):
  | { readonly ok: true; readonly digest: string }
  | { readonly ok: false; readonly code: string } {
  const directory = path.dirname(target);
  if (!isPathInside(taskRoot, directory) || !isPathInside(taskRoot, target))
    return { ok: false, code: 'binding_path_escape' };
  try {
    const relative = path.relative(taskRoot, directory);
    let current = taskRoot;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        const stat = fs.lstatSync(current);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          fs.realpathSync(current) !== current
        )
          return { ok: false, code: 'binding_directory_unsafe' };
      } catch (error) {
        if (!isRecord(error) || error['code'] !== 'ENOENT')
          return { ok: false, code: 'binding_directory_unavailable' };
        fs.mkdirSync(current, { mode: 0o700 });
      }
    }
    const validated = collabBindingSchema.safeParse(binding);
    if (!validated.success) return { ok: false, code: 'binding_invalid' };
    const bytes = Buffer.from(
      `${JSON.stringify(validated.data, null, 2)}\n`,
      'utf8',
    );
    const fd = fs.openSync(target, 'wx', 0o600);
    try {
      fs.writeSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return { ok: true, digest: digestText(bytes) };
  } catch (error) {
    const code = isRecord(error) ? error['code'] : null;
    return {
      ok: false,
      code: code === 'EEXIST' ? 'binding_file_exists' : 'binding_write_failed',
    };
  }
}
