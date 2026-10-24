import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  withManagedProviderDiagnostics,
  managedProviderResponseId,
} from './managed-provider-diagnostics.js';
import { managedPiHostIdentity } from './managed-host-identity.js';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson } from '../../collab/envelope.js';
import type { ManagedPiExecutionScope } from '../../app/collab-session-transition.js';
import {
  assertManagedPiSdkResumeAuthorization,
  type ManagedPiSdkResumeAuthorization,
} from '../../app/managed-pi-resume-admission.js';
import {
  createManagedPiJournalArtifacts,
  ManagedPiSessionError,
  type ManagedPiJournal,
} from './managed-session.js';

const SDK_VERSION = '1.4.0';
const SDK_PRIVATE_SOURCE_HASHES = {
  'dist/core/compaction/compaction.js':
    'f51e78ef1da66b5803fc91e185f07b968f8f989ab9326b7744958416aad3f6f6',
  'dist/core/agent-session.js':
    '436e8be3bbab2db475ce30bb5d0bb30f0046b19a3476f8cd57b8133e68891162',
  'dist/modes/interactive/interactive-mode.js':
    '633000038a8a9c60111fc9b32481c4015285fe530685277068bc5ed74f77dafa',
} as const;
export const MANAGED_PI_SDK_PRIVATE_SOURCE_HASHES = SDK_PRIVATE_SOURCE_HASHES;
const SESSION_SCHEMA = 'harness-collab/pi-managed-session/1';
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SDK_SESSION_SCHEMA = 'harness-collab/pi-managed-sdk-session/1';

export interface ManagedPiSdkInputEvent {
  readonly text: string;
  readonly images?: readonly unknown[];
  readonly source?: string;
  readonly streamingBehavior?: string;
}

interface ManagedPiSdkExtensionContext {
  readonly cwd: string;
  readonly sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | null | undefined;
  };
}

interface ManagedPiSdkExtensionApi {
  on(
    event: 'input',
    handler: (
      event: ManagedPiSdkInputEvent,
    ) => { action: 'continue' | 'handled' } | void,
  ): unknown;
  on(
    event: 'tool_call',
    handler: (
      _event: unknown,
    ) => { block: true; reason: string; terminate: true } | void,
  ): unknown;
  on(
    event: 'session_start' | 'agent_settled',
    handler: (_event: unknown, context: ManagedPiSdkExtensionContext) => void,
  ): unknown;
}

export interface ManagedPiSdkFence {
  readonly fenced: boolean;
  fence(reason: string): void;
  invalidateResumeCheckpoint(reason: string): void;
}

/** Shared fence used by the SDK extension and the lifecycle controller. */
export class ManagedPiSdkIngressFence implements ManagedPiSdkFence {
  private isFenced = false;

  constructor(private readonly journal: ManagedPiJournal) {}

  private checkpointRevisionValue = 0;

  get checkpointRevision() {
    return this.checkpointRevisionValue;
  }

  invalidateResumeCheckpoint(reason: string) {
    this.checkpointRevisionValue += 1;
    try {
      this.journal.append('sdk_resume_checkpoint_invalidated', { reason });
    } catch (error) {
      this.fence('resume_checkpoint_invalidation_failed');
      throw error;
    }
  }

  get fenced() {
    return this.isFenced;
  }

  fence(reason: string) {
    if (this.isFenced) return;
    this.isFenced = true;
    try {
      this.journal.append('sdk_ingress_fenced', { reason });
    } catch {
      // The in-memory gate remains closed when durable evidence fails.
    }
  }
}

function appendPiMetadata(
  metadataPath: string,
  record: Record<string, unknown>,
): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(metadataPath, 'a', 0o600);
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    let offset = 0;
    while (offset < bytes.length)
      offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
    fs.fsyncSync(fd);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function metadataRecord(
  type: 'session_start' | 'agent_settled',
  context: ManagedPiSdkExtensionContext,
) {
  return {
    schema: SESSION_SCHEMA,
    type,
    session_id: context.sessionManager.getSessionId(),
    cwd: context.cwd,
    session_file: context.sessionManager.getSessionFile() ?? null,
    at: new Date().toISOString(),
  };
}

/** Inline Pi extension factory: journals semantic ingress and blocks new tools after fencing. */
export function createManagedPiSdkLifecycleExtension(
  fence: ManagedPiSdkFence,
  journal: ManagedPiJournal,
  metadataPath: string,
  canExecute: () => boolean = () => true,
): (pi: unknown) => void {
  return (pi) => {
    const api = pi as ManagedPiSdkExtensionApi;
    api.on('session_start', (_event, context) => {
      if (
        !appendPiMetadata(
          metadataPath,
          metadataRecord('session_start', context),
        )
      )
        fence.fence('session_start_metadata_write_failed');
    });
    api.on('agent_settled', (_event, context) => {
      if (
        !appendPiMetadata(
          metadataPath,
          metadataRecord('agent_settled', context),
        )
      )
        fence.fence('agent_settled_metadata_write_failed');
    });
    api.on('input', (event) => {
      if (fence.fenced || !canExecute()) return { action: 'handled' };
      try {
        journal.append('sdk_input_hook_observed', {
          source: event.source ?? 'unknown',
          streaming_behavior: event.streamingBehavior ?? null,
        });
        return { action: 'continue' };
      } catch {
        fence.fence('semantic_input_journal_failed');
        return { action: 'handled' };
      }
    });
    api.on('tool_call', () => {
      if (fence.fenced || !canExecute())
        return {
          block: true,
          reason: 'managed Pi runtime is fenced',
          terminate: true,
        };
      try {
        fence.invalidateResumeCheckpoint('native_tool_call');
      } catch {
        return {
          block: true,
          reason: 'managed Pi resume checkpoint journal failed',
          terminate: true,
        };
      }
      return undefined;
    });
  };
}

export interface ManagedPiSdkContextUsage {
  readonly tokens: number | null;
  readonly contextWindow: number;
  readonly percent: number | null;
}

export interface ManagedPiSdkAgentState {
  readonly pendingToolCalls?: ReadonlySet<string>;
  readonly isStreaming?: boolean;
}

export interface ManagedPiSdkAgent {
  state: ManagedPiSdkAgentState;
  streamFunction: (...args: never[]) => unknown;
}

/** Structural view of public Pi 1.4 AgentSession APIs used by the lifecycle controller. */
export interface ManagedPiSdkSessionPort {
  readonly agent: ManagedPiSdkAgent;
  readonly sessionId: string;
  readonly model:
    { readonly id: string; readonly provider: string } | undefined;
  readonly thinkingLevel?: string;
  readonly sessionFile: string | undefined;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly isIdle: boolean;
  readonly isBashRunning?: boolean;
  readonly hasPendingBashMessages?: boolean;
  readonly pendingMessageCount: number;
  readonly state: ManagedPiSdkAgentState;
  getSteeringMessages(): readonly string[];
  getFollowUpMessages(): readonly string[];
  getContextUsage(): ManagedPiSdkContextUsage | undefined;
  compact(customInstructions?: string): Promise<unknown>;
  subscribe(listener: (event: unknown) => void): () => void;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
}

export interface ManagedPiSdkInteractiveModePort {
  init(): Promise<void>;
  run(): Promise<void>;
  stop(): void;
}

export interface ManagedPiSdkRuntimePort {
  readonly session: ManagedPiSdkSessionPort;
  readonly cwd: string;
  setRebindSession(
    callback?: (session: ManagedPiSdkSessionPort) => Promise<void>,
  ): void;
  dispose(): Promise<void>;
}

export interface ManagedPiSdkPendingDialog {
  readonly id: string;
  readonly kind: 'confirm' | 'select' | 'input' | 'unclassified';
  readonly startedAt: string;
}

export interface ManagedPiSdkSessionSnapshot {
  readonly schema: typeof SDK_SESSION_SCHEMA;
  readonly process: {
    readonly pid: number;
    readonly exit: 'not_owned';
  };
  readonly session: {
    readonly sessionId: string;
    readonly sessionFile: string | null;
  };
  readonly contextUsage: ManagedPiSdkContextUsage | null;
  readonly ingress: {
    readonly state: 'open' | 'fenced';
    readonly journalPath: string;
    readonly sequence: number;
    readonly headDigest: string;
    readonly healthy: boolean;
  };
  readonly ownedRuntime: {
    readonly scope: 'pi_agent_session';
    readonly queues: {
      readonly observedScope: 'pinned_pi_1_4_owned_runtime';
      readonly completeness: 'complete' | 'unknown';
      readonly steering: readonly string[];
      readonly followUp: readonly string[];
      readonly pendingMessageCount: number;
      readonly internal: {
        readonly pendingNextTurn: readonly unknown[] | null;
        readonly pendingCustom: readonly unknown[] | null;
        readonly pendingBash: readonly unknown[] | null;
        readonly deferredSettledActionCount: number | null;
        readonly pendingUserInputs: readonly string[] | null;
        readonly compactionMessages: readonly unknown[] | null;
        readonly extensionDialogCount: number | null;
        readonly activeSelector: boolean | null;
      };
    };
    readonly work: {
      readonly observation: 'complete' | 'unknown';
      readonly isIdle: boolean;
      readonly isStreaming: boolean;
      readonly isCompacting: boolean;
      readonly isBashRunning: boolean | null;
      readonly hasPendingBashMessages: boolean | null;
      readonly pendingToolCalls: number | null;
    };
    readonly extensionDialogs: {
      readonly observedScope: 'InteractiveMode_extension_confirm_select_input';
      readonly completeness: 'complete' | 'unknown';
      readonly pending: readonly ManagedPiSdkPendingDialog[];
    };
    readonly builtInUiApprovals: {
      readonly observation: 'complete' | 'unknown';
      readonly uncoveredPaths: readonly string[];
    };
  };
  readonly externalWriters: 'outside_runtime_scope';
  readonly descendants: 'not_owned_by_sdk_runtime';
  readonly scopedQuiescent: boolean;
  readonly blockers: readonly string[];
}

export interface ManagedPiSdkStopReceipt {
  readonly status: 'runtime_disposed';
  readonly process: {
    readonly pid: number;
    readonly exit: 'not_owned';
  };
  readonly sessionId: string;
  readonly finalSnapshot: ManagedPiSdkSessionSnapshot;
}

export interface ManagedPiSdkSummaryCapture {
  /** The unmodified native CompactionResult returned by AgentSession.compact(). */
  readonly result: unknown;
  readonly sessionId: string;
  readonly sessionFile: string | null;
  readonly contextUsage: ManagedPiSdkContextUsage | null;
}

export interface ManagedPiSdkRolloverInventory {
  readonly scope: 'pinned_pi_1_4_owned_runtime';
  readonly completeness: 'complete' | 'partial' | 'unknown';
  readonly inflight: readonly unknown[];
  readonly pending_approvals: readonly unknown[];
  readonly pending_messages?: readonly unknown[];
  readonly partial_outputs?: readonly unknown[];
  readonly outside_scope: readonly string[];
}

export interface ManagedPiSdkNativeIdentity {
  readonly agentId: string | null;
  readonly paneId: string | null;
  readonly surface: string | null;
  readonly configurationId: string | null;
}

export interface ManagedPiSdkSessionOptions {
  readonly cwd: string;
  /** Model ID within OpenRouter, for example `openai/gpt-6-luna`. */
  readonly model: string;
  readonly journalPath: string;
  /** Fresh UUID for new sessions; resume requires the root-issued authorization below. */
  readonly sessionId?: string;
  readonly quiesceTimeoutMs?: number;
  /** Exact immediate task binding, required when reopening a transcript. */
  readonly executionScope?: ManagedPiExecutionScope;
  /** Opaque, root-issued admission; never accepted from serialized launch config. */
  readonly resumeAuthorization?: ManagedPiSdkResumeAuthorization;
  /** Absolute path to the exact SDK module entrypoint; no ambient or global fallback is used. */
  readonly sdkModulePath: string;
  readonly nativeIdentity?: ManagedPiSdkNativeIdentity;
  /** Explicit default-deny successor extension; normal daily resources are retained. */
  readonly bootstrapExtensionPath?: string;
  readonly thinkingLevel?:
    'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Trusted application binding before the TUI can admit task input. Never read from JSON. */
  readonly beforeInteractiveStart?: (
    controller: ManagedPiSdkSessionController,
  ) => Promise<void>;
  /** Trusted application gate, rechecked for semantic input, provider runs and tools. */
  readonly canExecute?: () => boolean;
}

interface ManagedPiSdkServices {
  readonly modelRuntime: {
    getModel(provider: string, model: string): unknown;
  };
  readonly diagnostics: readonly unknown[];
  readonly settingsManager?: {
    isProjectTrusted(): boolean;
    getCompactionSettings?(model: unknown): unknown;
  };
  readonly resourceLoader?: {
    getSkills(): {
      readonly skills: readonly unknown[];
      readonly diagnostics: readonly unknown[];
    };
    getExtensions(): {
      readonly extensions: readonly { readonly path: string }[];
      readonly errors: readonly unknown[];
    };
  };
}

interface ManagedPiSdkModule {
  readonly VERSION: string;
  getAgentDir(): string;
  readonly SessionManager: {
    create(
      cwd: string,
      sessionDir?: string,
      options?: { id?: string },
    ): unknown;
    open(path: string, sessionDir?: string, cwdOverride?: string): unknown;
    list(cwd: string): Promise<readonly { id: string }[]>;
  };
  createAgentSessionServices(options: {
    cwd: string;
    agentDir: string;
    resourceLoaderOptions: {
      extensionFactories: readonly unknown[];
      additionalExtensionPaths?: readonly string[];
    };
  }): Promise<ManagedPiSdkServices>;
  createAgentSessionFromServices(options: {
    services: ManagedPiSdkServices;
    sessionManager: unknown;
    model: unknown;
    thinkingLevel?: string;
    sessionStartEvent?: unknown;
  }): Promise<{ session: ManagedPiSdkSessionPort }>;
  createAgentSessionRuntime(
    factory: (options: {
      cwd: string;
      agentDir: string;
      sessionManager: unknown;
      sessionStartEvent?: unknown;
    }) => Promise<Record<string, unknown>>,
    options: { cwd: string; agentDir: string; sessionManager: unknown },
  ): Promise<ManagedPiSdkRuntimePort>;
  createCodemodeExtension(): unknown;
  createToolSearchExtension(): unknown;
  createMcpExtension(): unknown;
  readonly InteractiveMode: new (
    runtime: ManagedPiSdkRuntimePort,
    options?: Record<string, unknown>,
  ) => ManagedPiSdkInteractiveModePort;
}

function loadSdkModule(sdkModulePath: string): Promise<ManagedPiSdkModule> {
  if (!path.isAbsolute(sdkModulePath))
    throw new ManagedPiSessionError('sdk_module_path_must_be_absolute');
  return import(
    pathToFileURL(sdkModulePath).href
  ) as Promise<ManagedPiSdkModule>;
}

function verifySdkPrivateSourceHashes(sdkModulePath: string) {
  const packageRoot = path.dirname(path.dirname(sdkModulePath));
  for (const [relative, expected] of Object.entries(
    SDK_PRIVATE_SOURCE_HASHES,
  )) {
    let actual: string;
    try {
      actual = createHash('sha256')
        .update(fs.readFileSync(path.join(packageRoot, relative)))
        .digest('hex');
    } catch {
      throw new ManagedPiSessionError(
        'sdk_private_source_unavailable',
        relative,
      );
    }
    if (actual !== expected)
      throw new ManagedPiSessionError(
        'sdk_private_source_hash_mismatch',
        relative,
      );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface CapturedPrivateQueues {
  readonly complete: boolean;
  readonly pendingNextTurn: readonly unknown[] | null;
  readonly pendingCustom: readonly unknown[] | null;
  readonly pendingBash: readonly unknown[] | null;
  readonly deferredSettledActionCount: number | null;
  readonly pendingUserInputs: readonly string[] | null;
  readonly compactionMessages: readonly unknown[] | null;
  readonly extensionDialogCount: number | null;
  readonly activeSelector: boolean | null;
}

function readArrayField(
  target: object,
  key: string,
): readonly unknown[] | null {
  if (!Reflect.has(target, key)) return null;
  const value: unknown = Reflect.get(target, key);
  return Array.isArray(value) ? [...value] : null;
}

function readRecordArrayField(
  target: object,
  key: string,
): readonly Record<string, unknown>[] | null {
  const value = readArrayField(target, key);
  return value?.every(isRecord)
    ? (value as readonly Record<string, unknown>[])
    : null;
}

function readFunctionCount(target: object, key: string): number | null {
  const value = readArrayField(target, key);
  return value?.every((item) => typeof item === 'function')
    ? value.length
    : null;
}

function capturePinnedPrivateQueues(
  session: ManagedPiSdkSessionPort,
  mode: ManagedPiSdkInteractiveModePort,
): CapturedPrivateQueues {
  const sessionObject = session as unknown as object;
  const modeObject = mode as unknown as object;
  const pendingNextTurn = readRecordArrayField(
    sessionObject,
    '_pendingNextTurnMessages',
  );
  const pendingCustom = readRecordArrayField(
    sessionObject,
    '_pendingCustomMessages',
  );
  const pendingBash = readRecordArrayField(
    sessionObject,
    '_pendingBashMessages',
  );
  const deferredSettledActionCount = readFunctionCount(
    sessionObject,
    '_deferredSettledActions',
  );
  const rawInputs = readArrayField(modeObject, 'pendingUserInputs');
  const pendingUserInputs = rawInputs?.every((item) => typeof item === 'string')
    ? (rawInputs as readonly string[])
    : null;
  const rawCompactionMessages = readArrayField(
    modeObject,
    'compactionQueuedMessages',
  );
  const compactionMessages = rawCompactionMessages?.every(
    (message) =>
      isRecord(message) &&
      typeof message['text'] === 'string' &&
      (message['mode'] === 'steer' || message['mode'] === 'followUp'),
  )
    ? rawCompactionMessages
    : null;
  const rawDialogs = readArrayField(modeObject, 'extensionDialogs');
  const dialogsAreValid = rawDialogs?.every(
    (dialog) =>
      isRecord(dialog) &&
      typeof dialog['blocked'] === 'boolean' &&
      typeof dialog['component'] === 'object' &&
      dialog['component'] !== null,
  );
  const hasSelectorField = Reflect.has(modeObject, 'activeSelectorToken');
  const selectorToken: unknown = hasSelectorField
    ? Reflect.get(modeObject, 'activeSelectorToken')
    : undefined;
  const activeSelector =
    hasSelectorField &&
    (selectorToken === undefined ||
      selectorToken === null ||
      typeof selectorToken === 'string')
      ? typeof selectorToken === 'string'
      : null;
  return {
    complete:
      pendingNextTurn !== null &&
      pendingCustom !== null &&
      pendingBash !== null &&
      deferredSettledActionCount !== null &&
      pendingUserInputs !== null &&
      compactionMessages !== null &&
      rawDialogs !== null &&
      dialogsAreValid === true &&
      activeSelector !== null,
    pendingNextTurn,
    pendingCustom,
    pendingBash,
    deferredSettledActionCount,
    pendingUserInputs,
    compactionMessages,
    extensionDialogCount: dialogsAreValid ? (rawDialogs?.length ?? null) : null,
    activeSelector,
  };
}

async function waitWithin(
  promise: Promise<unknown>,
  milliseconds: number,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), milliseconds);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

function isCompleteIdleSnapshot(snapshot: ManagedPiSdkSessionSnapshot) {
  const { queues, work, extensionDialogs, builtInUiApprovals } =
    snapshot.ownedRuntime;
  return (
    queues.completeness === 'complete' &&
    queues.pendingMessageCount === 0 &&
    work.observation === 'complete' &&
    work.isIdle &&
    !work.isStreaming &&
    !work.isCompacting &&
    work.isBashRunning === false &&
    work.hasPendingBashMessages === false &&
    work.pendingToolCalls === 0 &&
    extensionDialogs.completeness === 'complete' &&
    extensionDialogs.pending.length === 0 &&
    builtInUiApprovals.observation === 'complete' &&
    builtInUiApprovals.uncoveredPaths.length === 0
  );
}

function hashSessionTranscript(
  sessionFile: string,
  sessionId: string,
  cwd: string,
): { readonly sessionFile: string; readonly transcriptDigest: string } | null {
  let fd: number | undefined;
  try {
    const absolute = path.resolve(sessionFile);
    const stat = fs.lstatSync(absolute, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const canonical = fs.realpathSync(absolute);
    if (canonical !== absolute) return null;
    fd = fs.openSync(
      canonical,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(fd, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino ||
      opened.size !== stat.size
    )
      return null;
    const headerBuffer = Buffer.alloc(64 * 1024);
    const headerBytes = fs.readSync(
      fd,
      headerBuffer,
      0,
      headerBuffer.length,
      0,
    );
    const firstLine = headerBuffer
      .subarray(0, headerBytes)
      .toString('utf8')
      .split('\n', 1)[0];
    if (!firstLine) return null;
    const header: unknown = JSON.parse(firstLine);
    if (
      !isRecord(header) ||
      header['type'] !== 'session' ||
      header['id'] !== sessionId ||
      typeof header['cwd'] !== 'string' ||
      (header['cwd'] !== cwd &&
        path.resolve(header['cwd']) !== path.resolve(cwd))
    )
      return null;
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      BigInt(offset) !== after.size
    )
      return null;
    return {
      sessionFile: canonical,
      transcriptDigest: `sha256:${hash.digest('hex')}`,
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
/** Wrap the public ExtensionUIContext passed through AgentSession.bindExtensions. */
function wrapExtensionUiDialogs(
  context: unknown,
  onDialogStart: (dialog: ManagedPiSdkPendingDialog) => void,
  onDialogEnd: (id: string, result: unknown, failed: boolean) => void,
): Record<string, unknown> {
  if (!isRecord(context))
    throw new ManagedPiSessionError('sdk_extension_ui_context_invalid');
  const wrapped = { ...context };
  for (const kind of ['confirm', 'select', 'input'] as const) {
    const original = context[kind];
    if (typeof original !== 'function')
      throw new ManagedPiSessionError(
        `sdk_interactive_${kind}_handler_unavailable`,
      );
    wrapped[kind] = async function (...dialogArgs: unknown[]) {
      const dialog = {
        id: randomUUID(),
        kind,
        startedAt: new Date().toISOString(),
      } satisfies ManagedPiSdkPendingDialog;
      onDialogStart(dialog);
      let result: unknown;
      let failed = false;
      try {
        result = await Reflect.apply(original, context, dialogArgs);
        return result;
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        onDialogEnd(dialog.id, result, failed);
      }
    };
  }
  return wrapped;
}

/**
 * Lifecycle wrapper around the controller-owned SDK AgentSession and native InteractiveMode.
 * The public start function builds both from the explicitly selected SDK module.
 */
export class ManagedPiSdkSessionController {
  private disposed = false;
  private readonly summaryProviderRun = new AsyncLocalStorage<string>();
  private readonly originalStreams = new WeakMap<
    object,
    ManagedPiSdkAgent['streamFunction']
  >();
  private readonly unsubscribers = new WeakMap<object, () => void>();
  private readonly pendingDialogs = new Map<
    string,
    ManagedPiSdkPendingDialog
  >();
  private readonly lifecycleListeners = new Set<
    (event: unknown, snapshot: ManagedPiSdkSessionSnapshot) => void
  >();
  private terminalStopped = false;
  private readonly originalSessionMethods = new WeakMap<
    object,
    Map<string, (...args: unknown[]) => unknown>
  >();
  private readonly activeBashPromises = new WeakMap<
    object,
    Set<Promise<unknown>>
  >();
  private interactiveRun: Promise<void> | undefined;
  private session: ManagedPiSdkSessionPort;
  private nativeIdentity: ManagedPiSdkNativeIdentity | undefined;
  private initialized = false;
  private resourceFingerprint: string | null = null;
  private resourceUpdatePending = false;
  private readonly submittedInputs = new Map<string, string>();
  private resumeCheckpointScope: ManagedPiExecutionScope | undefined;

  private lastAgentEndCheckpointSafe = false;
  private readonly providerCalls = new WeakMap<
    ManagedPiSdkSessionPort,
    { id: string; started: number }
  >();
  constructor(
    private readonly input: {
      readonly runtime: ManagedPiSdkRuntimePort;
      readonly interactiveMode: ManagedPiSdkInteractiveModePort;
      readonly fence: ManagedPiSdkIngressFence;
      readonly journal: ManagedPiJournal;
      readonly model: string;
      readonly executionScope?: ManagedPiExecutionScope;
      readonly nativeIdentity: ManagedPiSdkNativeIdentity | undefined;
      readonly quiesceTimeoutMs: number;
      readonly metadataPath?: string;
      readonly resources?: () => ManagedPiSdkServices | undefined;
      readonly canCompact?: () => boolean;
      readonly canExecute?: () => boolean;
      readonly resumeAuthorization?: ManagedPiSdkResumeAuthorization;
    },
  ) {
    this.session = input.runtime.session;
    this.nativeIdentity = input.nativeIdentity;
    this.resumeCheckpointScope =
      input.resumeAuthorization?.scope ?? input.executionScope;
    for (const registered of input.resumeAuthorization?.registeredInputs ??
      []) {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(registered.requestId) ||
        !/^[a-f0-9]{64}$/.test(registered.inputDigest) ||
        this.submittedInputs.size >= 256 ||
        this.submittedInputs.has(registered.requestId)
      )
        throw new ManagedPiSessionError('resume_registered_input_invalid');
      this.submittedInputs.set(registered.requestId, registered.inputDigest);
    }
    this.bindSession(this.session);
  }

  private onDialogStart(dialog: ManagedPiSdkPendingDialog) {
    this.pendingDialogs.set(dialog.id, dialog);
    try {
      this.input.journal.append('sdk_extension_dialog_opened', {
        dialog_id: dialog.id,
        kind: dialog.kind,
        started_at: dialog.startedAt,
      });
    } catch {
      this.input.fence.fence('extension_dialog_journal_failed');
    }
  }

  private onDialogEnd(id: string, result: unknown, failed: boolean) {
    const dialog = this.pendingDialogs.get(id);
    if (!dialog) return;
    this.pendingDialogs.delete(id);
    const disposition = failed
      ? 'failed'
      : dialog.kind === 'confirm'
        ? result === true
          ? 'confirmed'
          : 'declined'
        : result === undefined
          ? 'dismissed'
          : 'accepted';
    try {
      this.input.journal.append('sdk_extension_dialog_closed', {
        dialog_id: id,
        kind: dialog.kind,
        disposition,
      });
    } catch {
      this.input.fence.fence('extension_dialog_journal_failed');
    }
  }

  private wrapSessionExtensionBindings(session: ManagedPiSdkSessionPort) {
    const target = session as unknown as Record<string, unknown>;
    const original = target['bindExtensions'];
    if (typeof original !== 'function')
      throw new ManagedPiSessionError(
        'sdk_session_bind_extensions_unavailable',
      );
    this.originalSessionMethods
      .get(session)
      ?.set('bindExtensions', original as (...args: unknown[]) => unknown);
    target['bindExtensions'] = (bindings: unknown) => {
      if (!isRecord(bindings))
        throw new ManagedPiSessionError('sdk_extension_bindings_invalid');
      if (!('uiContext' in bindings) || bindings['uiContext'] === undefined)
        return Reflect.apply(original, session, [bindings]);
      const uiContext = wrapExtensionUiDialogs(
        bindings['uiContext'],
        (dialog) => this.onDialogStart(dialog),
        (id, result, failed) => this.onDialogEnd(id, result, failed),
      );
      return Reflect.apply(original, session, [{ ...bindings, uiContext }]);
    };
  }

  private bindSession(session: ManagedPiSdkSessionPort) {
    this.session = session;
    this.wrapSessionOperations(session);
    this.wrapSessionExtensionBindings(session);
    const target = session as unknown as Record<string, unknown>;
    // MCP discovery and explicit tool selection can finish after TUI startup.
    // These methods belong to the source-hash-pinned Pi 1.4 session contract.
    for (const name of ['_refreshToolRegistry', 'setActiveToolsByName']) {
      const original = target[name];
      if (typeof original !== 'function') continue;
      this.originalSessionMethods
        .get(session)
        ?.set(name, original as (...args: unknown[]) => unknown);
      target[name] = (...args: unknown[]) => {
        const result = Reflect.apply(original, session, args);
        this.scheduleResourceObservation();
        return result;
      };
    }
    const agent = session.agent;
    if (!this.originalStreams.has(agent)) {
      const original = agent.streamFunction;
      this.originalStreams.set(agent, original);
      agent.streamFunction = (...args) => {
        if (
          (this.input.fence.fenced || this.input.canExecute?.() === false) &&
          !this.summaryProviderRun.getStore()
        )
          throw new Error('managed Pi provider ingress is fenced');
        const providerCallId = randomUUID();
        try {
          this.input.fence.invalidateResumeCheckpoint('provider_run');
          this.input.journal.append('sdk_provider_run_admitted', {
            session_id: session.sessionId,
            provider_call_id: providerCallId,
            purpose: this.summaryProviderRun.getStore()
              ? 'native_summary_compaction'
              : 'task_work',
          });
        } catch (error) {
          this.input.fence.fence('provider_run_journal_failed');
          throw error;
        }
        this.providerCalls.set(session, {
          id: providerCallId,
          started: performance.now(),
        });
        const observedArgs: unknown[] = [...args];
        observedArgs[2] = withManagedProviderDiagnostics(
          args[2],
          args[0],
          providerCallId,
          (kind, fields) => {
            try {
              this.input.journal.append(kind, {
                session_id: session.sessionId,
                ...fields,
              });
            } catch {
              this.input.fence.fence('provider_diagnostics_journal_failed');
            }
          },
        );
        return Reflect.apply(original, agent, observedArgs);
      };
    }
    this.unsubscribers.get(session)?.();
    this.unsubscribers.set(
      session,
      session.subscribe((event) => this.observeSessionEvent(session, event)),
    );
  }

  private scheduleResourceObservation() {
    if (this.resourceUpdatePending || this.disposed) return;
    this.resourceUpdatePending = true;
    setImmediate(() => {
      this.resourceUpdatePending = false;
      if (this.disposed) return;
      try {
        if (!this.publishResourcesReady())
          this.notifyLifecycleListeners({
            type: 'native_resources_changed',
            published: false,
          });
      } catch {
        this.input.fence.fence('native_resource_observation_failed');
      }
    }).unref();
  }

  private wrapSessionOperations(session: ManagedPiSdkSessionPort) {
    const target = session as unknown as Record<string, unknown>;
    const originals = new Map<string, (...args: unknown[]) => unknown>();
    const bashPromises = new Set<Promise<unknown>>();
    this.originalSessionMethods.set(session, originals);
    this.activeBashPromises.set(session, bashPromises);
    for (const name of [
      'prompt',
      'steer',
      'followUp',
      'sendUserMessage',
      'sendCustomMessage',
      'executeBash',
    ]) {
      const original = target[name];
      if (typeof original !== 'function')
        throw new ManagedPiSessionError(
          'sdk_session_ingress_method_unavailable',
          name,
        );
      const originalMethod = original as (...args: unknown[]) => unknown;
      originals.set(name, originalMethod);
      target[name] = (...args: unknown[]) => {
        if (this.input.fence.fenced || this.input.canExecute?.() === false)
          return Promise.reject(
            new ManagedPiSessionError('sdk_runtime_ingress_fenced'),
          );
        try {
          this.input.fence.invalidateResumeCheckpoint(`semantic_${name}`);
          this.input.journal.append(
            name === 'executeBash'
              ? 'sdk_user_bash_admitted'
              : 'sdk_semantic_input_admitted',
            { session_id: session.sessionId, channel: name, arguments: args },
          );
        } catch (error) {
          this.input.fence.fence('semantic_input_journal_failed');
          return Promise.reject(error);
        }
        const result = Reflect.apply(originalMethod, session, args);
        if (name !== 'executeBash') return result;
        const running = Promise.resolve(result);
        bashPromises.add(running);
        void running.then(
          () => bashPromises.delete(running),
          () => bashPromises.delete(running),
        );
        return running;
      };
    }
  }

  subscribe(
    listener: (event: unknown, snapshot: ManagedPiSdkSessionSnapshot) => void,
  ): () => void {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }

  private notifyLifecycleListeners(event: unknown) {
    const snapshot = this.snapshot();
    for (const listener of this.lifecycleListeners) {
      try {
        listener(event, snapshot);
      } catch {
        // Observer failures do not mutate Pi's native event dispatch.
      }
    }
  }

  private observeSessionEvent(
    session: ManagedPiSdkSessionPort,
    event: unknown,
  ) {
    if (!isRecord(event) || typeof event['type'] !== 'string') return;
    const type = event['type'];
    if (type === 'agent_start') this.lastAgentEndCheckpointSafe = false;
    if (type === 'agent_end') {
      const messages = Array.isArray(event['messages'])
        ? event['messages']
        : [];
      const lastAssistant = [...messages]
        .reverse()
        .find(
          (message) => isRecord(message) && message['role'] === 'assistant',
        );
      this.lastAgentEndCheckpointSafe =
        event['willRetry'] === false &&
        isRecord(lastAssistant) &&
        lastAssistant['stopReason'] === 'stop' &&
        typeof lastAssistant['errorMessage'] !== 'string';
    }
    const invalidatesCheckpoint =
      type === 'queue_update' ||
      type === 'tool_execution_start' ||
      type === 'tool_execution_update' ||
      type === 'tool_execution_end' ||
      type === 'agent_start' ||
      type === 'agent_end' ||
      type === 'agent_settled' ||
      type === 'message_end' ||
      type === 'entry_appended' ||
      type === 'session_info_changed' ||
      type === 'thinking_level_changed' ||
      type === 'compaction_start' ||
      type === 'compaction_end';
    try {
      if (invalidatesCheckpoint)
        this.input.fence.invalidateResumeCheckpoint(`native_${type}`);
      if (
        type === 'message_end' &&
        isRecord(event['message']) &&
        event['message']['role'] === 'assistant'
      ) {
        const message = event['message'];
        const call = this.providerCalls.get(session);
        const reason = message['stopReason'];
        this.input.journal.append('sdk_provider_message_observed', {
          session_id: session.sessionId,
          provider_call_id: call?.id ?? null,
          response_id: managedProviderResponseId(message['responseId']),
          stop_reason:
            typeof reason === 'string' &&
            ['stop', 'length', 'error', 'aborted', 'toolUse'].includes(reason)
              ? reason
              : 'unknown',
          elapsed_ms: call
            ? Math.round(Math.max(0, performance.now() - call.started) * 1000) /
              1000
            : null,
        });
      }
      if (type === 'queue_update') {
        this.input.journal.append('sdk_queue_observed', {
          session_id: session.sessionId,
          steering: event['steering'],
          follow_up: event['followUp'],
        });
      } else if (
        type === 'tool_execution_start' ||
        type === 'tool_execution_end' ||
        type === 'agent_settled' ||
        type === 'agent_start' ||
        type === 'agent_end'
      ) {
        const lifecycle: Record<string, unknown> = {
          session_id: session.sessionId,
        };
        if (type === 'agent_settled')
          lifecycle['aborted'] = event['aborted'] === true;
        if (type === 'agent_end') {
          const messages = Array.isArray(event['messages'])
            ? event['messages']
            : [];
          const lastAssistant = [...messages]
            .reverse()
            .find(
              (message) => isRecord(message) && message['role'] === 'assistant',
            );
          lifecycle['will_retry'] = event['willRetry'] === true;
          lifecycle['stop_reason'] = isRecord(lastAssistant)
            ? (lastAssistant['stopReason'] ?? null)
            : null;
          lifecycle['error_message_present'] =
            isRecord(lastAssistant) &&
            typeof lastAssistant['errorMessage'] === 'string';
        }
        this.input.journal.append(`sdk_${type}`, lifecycle);
      }
    } catch {
      this.input.fence.fence('sdk_lifecycle_journal_failed');
    }
    if (
      type === 'queue_update' ||
      type === 'tool_execution_start' ||
      type === 'tool_execution_end' ||
      type === 'agent_settled' ||
      type === 'agent_start' ||
      type === 'agent_end'
    )
      this.notifyLifecycleListeners(event);
    if (type === 'agent_settled') {
      const settledSafely =
        event['aborted'] === false && this.lastAgentEndCheckpointSafe;
      this.lastAgentEndCheckpointSafe = false;
      try {
        this.publishResourcesReady(true);
      } catch {
        this.input.fence.fence('resources_ready_refresh_failed');
      }
      if (settledSafely) {
        try {
          this.appendResumeCheckpoint();
        } catch {
          this.input.fence.fence('resume_checkpoint_write_failed');
        }
      }
    }
  }

  /** Called by AgentSessionRuntime's native replacement callback wrapper. */
  replaceSession(session: ManagedPiSdkSessionPort) {
    const previousSessionId = this.session.sessionId;
    this.input.fence.invalidateResumeCheckpoint('session_replaced');
    this.bindSession(session);
    try {
      this.input.journal.append('sdk_session_replaced', {
        previous_session_id: previousSessionId,
        session_id: session.sessionId,
        session_file: session.sessionFile ?? null,
      });
    } catch {
      this.input.fence.fence('session_replacement_journal_failed');
    }
    this.notifyLifecycleListeners({
      type: 'session_replaced',
      previousSessionId,
      sessionId: session.sessionId,
    });
  }
  fenceIngress(reason = 'managed_sdk_ingress_fenced') {
    this.input.fence.fence(reason);
  }

  snapshot(): ManagedPiSdkSessionSnapshot {
    const { fence, journal, interactiveMode } = this.input;
    const session = this.session;
    const privateQueues = capturePinnedPrivateQueues(session, interactiveMode);
    const steering = [...session.getSteeringMessages()];
    const followUp = [...session.getFollowUpMessages()];
    const pendingToolCalls = session.state.pendingToolCalls;
    const pendingToolCallCount =
      pendingToolCalls instanceof Set ? pendingToolCalls.size : null;
    const isBashRunning = session.isBashRunning ?? null;
    const hasPendingBashMessages = session.hasPendingBashMessages ?? null;
    const pendingDialogs = [...this.pendingDialogs.values()];
    const unclassifiedDialogs =
      privateQueues.extensionDialogCount === null
        ? null
        : Math.max(
            0,
            privateQueues.extensionDialogCount - pendingDialogs.length,
          );
    const internalQueueCount = [
      privateQueues.pendingNextTurn?.length,
      privateQueues.pendingCustom?.length,
      privateQueues.pendingBash?.length,
      privateQueues.deferredSettledActionCount,
      privateQueues.pendingUserInputs?.length,
      privateQueues.compactionMessages?.length,
    ].every((count) => typeof count === 'number')
      ? (privateQueues.pendingNextTurn?.length ?? 0) +
        (privateQueues.pendingCustom?.length ?? 0) +
        (privateQueues.pendingBash?.length ?? 0) +
        (privateQueues.deferredSettledActionCount ?? 0) +
        (privateQueues.pendingUserInputs?.length ?? 0) +
        (privateQueues.compactionMessages?.length ?? 0)
      : null;
    const workComplete =
      pendingToolCallCount !== null &&
      isBashRunning !== null &&
      hasPendingBashMessages !== null;
    const inventoryComplete = privateQueues.complete && workComplete;
    const workIsIdle =
      inventoryComplete &&
      session.isIdle &&
      !session.isStreaming &&
      !session.isCompacting &&
      isBashRunning === false &&
      hasPendingBashMessages === false &&
      pendingToolCallCount === 0;
    const hasDialog =
      pendingDialogs.length > 0 ||
      (privateQueues.extensionDialogCount ?? 0) > 0 ||
      privateQueues.activeSelector === true;
    const blockers = [
      ...(!privateQueues.complete
        ? ['owned_private_queue_inventory_unknown']
        : []),
      ...(!workComplete ? ['owned_work_inventory_unknown'] : []),
      ...(steering.length + followUp.length > 0 || (internalQueueCount ?? 0) > 0
        ? ['owned_runtime_messages_pending']
        : []),
      ...(!workIsIdle ? ['owned_agent_session_work_active'] : []),
      ...(hasDialog ? ['owned_interactive_dialog_pending'] : []),
    ];
    const usage = session.getContextUsage();
    const totalPendingMessages =
      internalQueueCount === null
        ? session.pendingMessageCount
        : session.pendingMessageCount + internalQueueCount;
    return {
      schema: SDK_SESSION_SCHEMA,
      process: { pid: process.pid, exit: 'not_owned' },
      session: {
        sessionId: session.sessionId,
        sessionFile: session.sessionFile ?? null,
      },
      contextUsage: usage ? { ...usage } : null,
      ingress: {
        state: fence.fenced ? 'fenced' : 'open',
        journalPath: journal.path,
        sequence: journal.currentSequence,
        headDigest: journal.currentDigest,
        healthy: journal.healthy,
      },
      ownedRuntime: {
        scope: 'pi_agent_session',
        queues: {
          observedScope: 'pinned_pi_1_4_owned_runtime',
          completeness: inventoryComplete ? 'complete' : 'unknown',
          steering,
          followUp,
          pendingMessageCount: totalPendingMessages,
          internal: {
            pendingNextTurn: privateQueues.pendingNextTurn,
            pendingCustom: privateQueues.pendingCustom,
            pendingBash: privateQueues.pendingBash,
            deferredSettledActionCount:
              privateQueues.deferredSettledActionCount,
            pendingUserInputs: privateQueues.pendingUserInputs,
            compactionMessages: privateQueues.compactionMessages,
            extensionDialogCount: privateQueues.extensionDialogCount,
            activeSelector: privateQueues.activeSelector,
          },
        },
        work: {
          observation: workComplete ? 'complete' : 'unknown',
          isIdle: session.isIdle,
          isStreaming: session.isStreaming,
          isCompacting: session.isCompacting,
          isBashRunning,
          hasPendingBashMessages,
          pendingToolCalls: pendingToolCallCount,
        },
        extensionDialogs: {
          observedScope: 'InteractiveMode_extension_confirm_select_input',
          completeness:
            privateQueues.complete && unclassifiedDialogs !== null
              ? 'complete'
              : 'unknown',
          pending:
            unclassifiedDialogs === null
              ? pendingDialogs
              : [
                  ...pendingDialogs,
                  ...Array.from(
                    { length: unclassifiedDialogs },
                    (_, index) => ({
                      id: `unclassified-native-dialog-${index + 1}`,
                      kind: 'unclassified' as const,
                      startedAt: 'unknown',
                    }),
                  ),
                ],
        },
        builtInUiApprovals: {
          observation: inventoryComplete ? 'complete' : 'unknown',
          uncoveredPaths: inventoryComplete
            ? []
            : ['Pi 1.4 pinned native queue/UI fields failed validation'],
        },
      },
      externalWriters: 'outside_runtime_scope',
      descendants: 'not_owned_by_sdk_runtime',
      scopedQuiescent:
        fence.fenced &&
        workIsIdle &&
        steering.length === 0 &&
        followUp.length === 0 &&
        internalQueueCount === 0 &&
        !hasDialog,
      blockers,
    };
  }

  getContextUsage(): ManagedPiSdkContextUsage | null {
    const usage = this.session.getContextUsage();
    return usage ? { ...usage } : null;
  }

  observe() {
    const session = this.session;
    const model = session.model;
    const identity = this.nativeIdentity;
    const usage = session.getContextUsage();
    return {
      native: {
        harness: 'pi' as const,
        sessionId: session.sessionId,
        agentId: identity?.agentId ?? null,
        paneId: identity?.paneId ?? null,
        surface: identity?.surface ?? 'pi-sdk-tui',
        configurationId: identity?.configurationId ?? null,
        modelObservation: {
          model: model?.id ?? this.input.model,
          provider: model?.provider ?? 'openrouter',
          reasoning: session.thinkingLevel ?? null,
        },
      },
      cwd: this.input.runtime.cwd,
      contextPercent: usage?.percent ?? null,
    };
  }

  async inventory(): Promise<ManagedPiSdkRolloverInventory> {
    const snapshot = this.snapshot();
    const { queues, work, extensionDialogs } = snapshot.ownedRuntime;
    const pendingMessages: unknown[] = [
      ...queues.steering.map((text) => ({ kind: 'steering', text })),
      ...queues.followUp.map((text) => ({ kind: 'follow_up', text })),
    ];
    const internal = queues.internal;
    for (const [kind, items] of [
      ['next_turn', internal.pendingNextTurn],
      ['custom', internal.pendingCustom],
      ['bash', internal.pendingBash],
      ['pending_user_input', internal.pendingUserInputs],
      ['compaction', internal.compactionMessages],
    ] as const) {
      if (items) pendingMessages.push(...items.map((item) => ({ kind, item })));
    }
    const pendingApprovals = extensionDialogs.pending.filter(
      (dialog) => dialog.kind === 'confirm' || dialog.kind === 'unclassified',
    );
    const inflight: unknown[] = [];
    if (!work.isIdle || work.isStreaming || work.isCompacting)
      inflight.push({
        kind: 'agent_session',
        isIdle: work.isIdle,
        isStreaming: work.isStreaming,
      });
    if (work.pendingToolCalls !== null && work.pendingToolCalls > 0)
      inflight.push({ kind: 'tool_calls', count: work.pendingToolCalls });
    if (work.isBashRunning)
      inflight.push({ kind: 'bash_execution', active: true });
    if (work.hasPendingBashMessages)
      inflight.push({ kind: 'pending_bash_messages', active: true });
    if (
      internal.deferredSettledActionCount !== null &&
      internal.deferredSettledActionCount > 0
    )
      inflight.push({
        kind: 'deferred_settled_actions',
        count: internal.deferredSettledActionCount,
      });
    if (internal.activeSelector)
      pendingApprovals.push({
        id: 'active-native-selector',
        kind: 'unclassified',
        startedAt: 'unknown',
      });
    return {
      scope: 'pinned_pi_1_4_owned_runtime',
      completeness:
        queues.completeness === 'complete' &&
        work.observation === 'complete' &&
        extensionDialogs.completeness === 'complete'
          ? 'complete'
          : 'unknown',
      inflight,
      pending_approvals: pendingApprovals,
      pending_messages: pendingMessages,
      outside_scope: [
        'arbitrary_external_writers',
        'unowned_processes_and_descendants',
      ],
    };
  }

  canCaptureSummary(): boolean {
    const { queues, work, extensionDialogs, builtInUiApprovals } =
      this.snapshot().ownedRuntime;
    if (
      this.disposed ||
      queues.completeness !== 'complete' ||
      queues.pendingMessageCount !== 0 ||
      work.observation !== 'complete' ||
      !work.isIdle ||
      work.isStreaming ||
      work.isCompacting ||
      work.isBashRunning ||
      work.pendingToolCalls !== 0 ||
      extensionDialogs.completeness !== 'complete' ||
      extensionDialogs.pending.length ||
      builtInUiApprovals.observation !== 'complete' ||
      builtInUiApprovals.uncoveredPaths.length
    )
      return false;
    try {
      return this.input.canCompact?.() === true;
    } catch {
      return false;
    }
  }

  async captureSummary(
    causeId: string,
  ): Promise<{ summary: string; complete: false; sessionFile: string }> {
    if (!causeId.trim())
      throw new ManagedPiSessionError('summary_cause_id_required');
    if (this.disposed)
      throw new ManagedPiSessionError('sdk_runtime_already_disposed');
    const quiescence = await this.quiesce('native_summary_capture');
    if (!quiescence.scopedQuiescent)
      throw new ManagedPiSessionError('sdk_summary_source_not_quiescent');
    return this.summaryProviderRun.run(causeId, async () => {
      const result = await this.session.compact();
      if (!isRecord(result) || typeof result['summary'] !== 'string')
        throw new ManagedPiSessionError('sdk_native_summary_missing');
      const summary = result['summary'];
      if (!this.session.sessionFile)
        throw new ManagedPiSessionError('sdk_session_file_unavailable');
      const sessionFile = this.session.sessionFile;
      this.input.journal.append('sdk_native_summary_captured', {
        cause_id: causeId,
        session_id: this.session.sessionId,
        session_file: sessionFile,
        summary_utf8_bytes: Buffer.byteLength(summary, 'utf8'),
      });
      return { summary, complete: false as const, sessionFile };
    });
  }

  private stopTerminalIngress() {
    if (this.terminalStopped) return;
    this.input.interactiveMode.stop();
    this.terminalStopped = true;
  }

  async quiesce(
    reason = 'managed_sdk_quiesce',
  ): Promise<ManagedPiSdkSessionSnapshot> {
    this.stopTerminalIngress();
    this.input.fence.fence(reason);
    const deadline = Date.now() + this.input.quiesceTimeoutMs;
    const activeSession = this.session as unknown as Record<string, unknown>;
    if (this.session.isBashRunning) {
      const abortBash = activeSession['abortBash'];
      if (typeof abortBash === 'function')
        Reflect.apply(abortBash, this.session, []);
    }
    const abortDone = await waitWithin(
      this.session.abort().catch(() => undefined),
      Math.max(0, deadline - Date.now()),
    );
    const bashPromises = [...(this.activeBashPromises.get(this.session) ?? [])];
    const bashDone = await waitWithin(
      Promise.allSettled(bashPromises),
      Math.max(0, deadline - Date.now()),
    );
    const idleDone = await waitWithin(
      this.session.waitForIdle(),
      Math.max(0, deadline - Date.now()),
    );
    const snapshot = this.snapshot();
    this.input.journal.append('sdk_quiesced', {
      session_id: snapshot.session.sessionId,
      scoped_quiescent: snapshot.scopedQuiescent,
      blockers: snapshot.blockers,
      abort_completed: abortDone,
      bash_completed: bashDone,
      idle_observed: idleDone,
      timeout_ms: this.input.quiesceTimeoutMs,
    });
    return snapshot;
  }

  async stopOwnedRuntime(): Promise<ManagedPiSdkStopReceipt> {
    if (this.disposed)
      throw new ManagedPiSessionError('sdk_runtime_already_disposed');
    const finalSnapshot = await this.quiesce('managed_sdk_stop');
    if (!finalSnapshot.scopedQuiescent)
      throw new ManagedPiSessionError('sdk_runtime_not_quiescent');
    const disposed = await waitWithin(
      this.input.runtime.dispose(),
      this.input.quiesceTimeoutMs,
    );
    if (!disposed)
      throw new ManagedPiSessionError('sdk_runtime_dispose_timeout');
    this.disposed = true;
    this.input.journal.append('sdk_runtime_disposed', {
      session_id: finalSnapshot.session.sessionId,
      process_pid: process.pid,
      process_exit: 'not_owned',
      blockers: finalSnapshot.blockers,
    });
    const receipt: ManagedPiSdkStopReceipt = {
      status: 'runtime_disposed',
      process: { pid: process.pid, exit: 'not_owned' },
      sessionId: finalSnapshot.session.sessionId,
      finalSnapshot,
    };
    this.closeObservers();
    this.input.journal.close();
    return receipt;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  async cleanupAfterStartupFailure(): Promise<boolean> {
    this.stopTerminalIngress();
    this.input.fence.fence('sdk_start_failed');
    const deadline = Date.now() + this.input.quiesceTimeoutMs;
    const activeSession = this.session as unknown as Record<string, unknown>;
    if (this.session.isBashRunning) {
      const abortBash = activeSession['abortBash'];
      if (typeof abortBash === 'function')
        Reflect.apply(abortBash, this.session, []);
    }
    await waitWithin(
      this.session.abort().catch(() => undefined),
      Math.max(0, deadline - Date.now()),
    );
    await waitWithin(
      this.session.waitForIdle(),
      Math.max(0, deadline - Date.now()),
    );
    const snapshot = this.snapshot();
    const disposed = await waitWithin(
      this.input.runtime.dispose(),
      Math.max(0, deadline - Date.now()),
    );
    this.input.journal.append('sdk_start_failure_cleanup', {
      session_id: snapshot.session.sessionId,
      runtime_disposed: disposed,
      scoped_quiescent: snapshot.scopedQuiescent,
      blockers: snapshot.blockers,
    });
    if (disposed) {
      this.disposed = true;
      this.closeObservers();
      this.input.journal.close();
    }
    return disposed;
  }

  private closeObservers() {
    this.unsubscribers.get(this.session)?.();
    // A disposed session may still be referenced by an extension. Keep the
    // ingress/provider gates latched; restoring originals would re-enable work.
    this.lifecycleListeners.clear();
  }

  bindResumeCheckpointScope(scope: ManagedPiExecutionScope) {
    if (
      scope.session_id !== this.session.sessionId ||
      path.resolve(scope.cwd) !== path.resolve(this.input.runtime.cwd)
    )
      throw new ManagedPiSessionError('sdk_resume_checkpoint_scope_mismatch');
    const authorizedScope = this.input.resumeAuthorization?.scope;
    if (
      authorizedScope &&
      canonicalJson(scope) !== canonicalJson(authorizedScope)
    )
      throw new ManagedPiSessionError('sdk_resume_authorized_scope_mismatch');
    if (
      this.resumeCheckpointScope &&
      canonicalJson(scope) !== canonicalJson(this.resumeCheckpointScope)
    )
      throw new ManagedPiSessionError('sdk_resume_checkpoint_scope_conflict');
    this.resumeCheckpointScope = scope;
  }

  recordInitialResumeCheckpoint() {
    if (!this.initialized || this.disposed) return false;
    return this.appendResumeCheckpoint();
  }

  private appendResumeCheckpoint() {
    if (
      this.disposed ||
      !this.input.journal.healthy ||
      !this.resumeCheckpointScope
    )
      return false;
    const hostIdentity = managedPiHostIdentity();
    if (!hostIdentity) return false;
    const revision = this.input.fence.checkpointRevision;
    const snapshot = this.snapshot();
    if (
      snapshot.ingress.state !== 'open' ||
      !snapshot.ingress.healthy ||
      !isCompleteIdleSnapshot(snapshot)
    )
      return false;
    const file = this.session.sessionFile;
    if (!file) return false;
    const transcript = hashSessionTranscript(
      file,
      snapshot.session.sessionId,
      this.input.runtime.cwd,
    );
    if (!transcript || revision !== this.input.fence.checkpointRevision)
      return false;
    const finalSnapshot = this.snapshot();
    if (
      revision !== this.input.fence.checkpointRevision ||
      finalSnapshot.session.sessionId !== snapshot.session.sessionId ||
      finalSnapshot.session.sessionFile !== snapshot.session.sessionFile ||
      !isCompleteIdleSnapshot(finalSnapshot) ||
      finalSnapshot.ingress.state !== 'open' ||
      !finalSnapshot.ingress.healthy
    )
      return false;
    const registeredInputs = [...this.submittedInputs]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([requestId, inputDigest]) => ({
        request_id: requestId,
        input_digest: inputDigest,
      }));
    this.input.journal.append('sdk_resume_checkpoint', {
      checkpoint_schema: 'pappra/managed-pi-resume-checkpoint/1',
      session_id: finalSnapshot.session.sessionId,
      session_file: transcript.sessionFile,
      cwd: this.input.runtime.cwd,
      model: this.observe().native.modelObservation.model,
      process_pid: process.pid,
      host_identity: hostIdentity,
      execution_scope: this.resumeCheckpointScope,
      transcript_digest: transcript.transcriptDigest,
      snapshot: finalSnapshot,
      registered_inputs: registeredInputs,
    });
    return true;
  }

  async initializeInteractiveMode() {
    await this.input.interactiveMode.init();
    this.initialized = true;
    this.publishResourcesReady();
    this.interactiveRun = this.input.interactiveMode.run().then(() => {
      this.input.journal.append('sdk_interactive_mode_exited', {
        session_id: this.session.sessionId,
      });
    });
    // A caller can await runPromise; this handler prevents an early unhandled rejection.
    void this.interactiveRun.catch(() => undefined);
  }

  get runPromise(): Promise<void> | undefined {
    return this.interactiveRun;
  }

  /** Admits one durable semantic input, without waiting for or claiming model success. */
  submitInput(requestId: string, text: string) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requestId) ||
      !text ||
      text.length > 128 * 1024
    )
      throw new ManagedPiSessionError('sdk_input_invalid');
    if (
      this.disposed ||
      this.input.fence.fenced ||
      this.input.canExecute?.() === false
    )
      throw new ManagedPiSessionError('sdk_runtime_ingress_fenced');
    const inputDigest = createHash('sha256').update(text).digest('hex');
    const prior = this.submittedInputs.get(requestId);
    if (prior && prior !== inputDigest)
      throw new ManagedPiSessionError('sdk_input_id_conflict');
    if (prior)
      return {
        status: 'submitted',
        request_id: requestId,
        duplicate: true,
        session_id: this.session.sessionId,
      };
    if (this.submittedInputs.size >= 256)
      throw new ManagedPiSessionError('sdk_input_limit');
    this.input.fence.invalidateResumeCheckpoint('sdk_control_input_reserved');
    this.input.journal.append('sdk_control_input_reserved', {
      request_id: requestId,
      input_digest: inputDigest,
      session_id: this.session.sessionId,
    });
    this.submittedInputs.set(requestId, inputDigest);
    const target = this.session as unknown as Record<string, unknown>;
    const prompt = target['prompt'];
    if (typeof prompt !== 'function')
      throw new ManagedPiSessionError('sdk_input_api_unavailable');
    void Promise.resolve(
      Reflect.apply(prompt, this.session, [
        text,
        { streamingBehavior: 'followUp' },
      ]),
    ).catch(() => {
      try {
        this.input.journal.append('sdk_control_input_outcome_unknown', {
          request_id: requestId,
        });
      } catch {
        this.input.fence.fence('input_outcome_journal_failed');
      }
    });
    return {
      status: 'submitted',
      request_id: requestId,
      duplicate: false,
      session_id: this.session.sessionId,
    };
  }

  async importHandoffContext(content: string) {
    if (
      !content ||
      content.length > 1024 * 1024 ||
      this.disposed ||
      this.input.fence.fenced
    )
      throw new ManagedPiSessionError('sdk_handoff_context_invalid');
    const target = this.session as unknown as Record<string, unknown>;
    const send = target['sendCustomMessage'];
    if (typeof send !== 'function')
      throw new ManagedPiSessionError('sdk_custom_context_unavailable');
    await Reflect.apply(send, this.session, [
      { customType: 'pappra.handoff-context.v1', content, display: true },
      { triggerTurn: false },
    ]);
  }

  /** The app binds logical assignment identity; native UUID/cwd/model remain SDK observations. */
  bindNativeIdentity(identity: ManagedPiSdkNativeIdentity) {
    if (
      this.nativeIdentity?.agentId &&
      this.nativeIdentity.agentId !== identity.agentId
    )
      throw new ManagedPiSessionError('sdk_native_identity_conflict');
    this.nativeIdentity = identity;
    this.publishResourcesReady();
  }

  /** Resource availability after real initialization, without a fabricated model turn. */
  get metadataFile(): string | null {
    return this.input.metadataPath ?? null;
  }

  publishResourcesReady(force = false): boolean {
    if (
      !this.initialized ||
      this.disposed ||
      !this.input.metadataPath ||
      !this.nativeIdentity?.agentId ||
      !this.nativeIdentity.configurationId
    )
      return false;
    const native = this.session as unknown as {
      getAllTools?: () => readonly { readonly name: string }[];
      getActiveToolNames?: () => readonly string[];
      sessionManager?: {
        getHeader(): unknown;
        appendCustomEntry(type: string, data: unknown): unknown;
      };
    };
    const services = this.input.resources?.();
    if (
      !native.getAllTools ||
      !native.getActiveToolNames ||
      !native.sessionManager ||
      !services?.resourceLoader ||
      !services.settingsManager
    )
      return false;
    const skills = services.resourceLoader.getSkills();
    const all = native.getAllTools().map((tool) => tool.name);
    const active = [...native.getActiveToolNames()];
    const skillRows = skills.skills.map((entry) => {
      if (
        !isRecord(entry) ||
        typeof entry['name'] !== 'string' ||
        typeof entry['filePath'] !== 'string'
      )
        throw new ManagedPiSessionError('sdk_skill_inventory_invalid');
      return {
        name: entry['name'],
        entry: entry['filePath'],
        availability: 'available',
        body_loaded: 'not_observed',
      };
    });
    if (
      all.length > 2048 ||
      active.length > 2048 ||
      skillRows.length > 1024 ||
      all.some(
        (name) => typeof name !== 'string' || !name || name.length > 256,
      ) ||
      new Set(all).size !== all.length ||
      new Set(active).size !== active.length ||
      active.some((name) => !all.includes(name))
    )
      throw new ManagedPiSessionError('sdk_resource_inventory_invalid');
    const snapshot = this.snapshot();
    const { queues, work, extensionDialogs, builtInUiApprovals } =
      snapshot.ownedRuntime;
    const observed = this.observe();
    const payload = {
      schema: SESSION_SCHEMA,
      type: 'resources_ready',
      at: new Date().toISOString(),
      session_id: this.session.sessionId,
      cwd: this.input.runtime.cwd,
      native_session_file: this.session.sessionFile ?? null,
      native_header: native.sessionManager.getHeader(),
      phase: 'interactive_mode_init_complete',
      sdk: { package: '@earendil-works/pi-coding-agent', version: SDK_VERSION },
      native_identity: {
        agent_id: this.nativeIdentity.agentId,
        harness: 'pi',
        surface: this.nativeIdentity.surface,
        configuration_id: this.nativeIdentity.configurationId,
      },
      model: {
        provider: observed.native.modelObservation.provider,
        id: observed.native.modelObservation.model,
        thinking_level: observed.native.modelObservation.reasoning,
      },
      configuration: {
        configuration_id: this.nativeIdentity.configurationId,
        project_trusted: services.settingsManager.isProjectTrusted(),
      },
      resource_inventory: {
        completeness: skills.diagnostics.some(
          (value) => isRecord(value) && value['type'] === 'error',
        )
          ? 'unknown'
          : 'complete',
        source: 'pi_1_4_runtime_apis',
        tools: { all_names: all, active_names: active },
        skills: skillRows,
      },
      owned_runtime: {
        scope: 'pinned_pi_1_4_owned_runtime',
        queues_completeness: queues.completeness,
        pending_message_count: queues.pendingMessageCount,
        work_observation: work.observation,
        is_idle: work.isIdle,
        is_streaming: work.isStreaming,
        is_compacting: work.isCompacting,
        is_bash_running: work.isBashRunning,
        has_pending_bash_messages: work.hasPendingBashMessages,
        pending_tool_calls: work.pendingToolCalls,
        extension_dialogs_completeness: extensionDialogs.completeness,
        pending_extension_dialogs: extensionDialogs.pending.length,
        built_in_ui_approvals_observation: builtInUiApprovals.observation,
        uncovered_approval_paths: builtInUiApprovals.uncoveredPaths,
      },
    };
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ ...payload, at: null }))
      .digest('hex');
    if (!force && fingerprint === this.resourceFingerprint) return true;
    native.sessionManager.appendCustomEntry(
      'pappra.resources_ready.v1',
      payload,
    );
    if (!appendPiMetadata(this.input.metadataPath, payload)) {
      this.input.fence.fence('resources_ready_metadata_write_failed');
      throw new ManagedPiSessionError('sdk_resources_ready_publication_failed');
    }
    this.resourceFingerprint = fingerprint;
    this.input.journal.append('sdk_resources_ready', {
      session_id: this.session.sessionId,
      fingerprint,
    });
    this.notifyLifecycleListeners({ type: 'resources_ready' });
    return true;
  }
}

/**
 * Start Pi 1.4.0's controller-owned SDK runtime and the native interactive TUI.
 * The module path is explicit; this function never falls back to a global/installed SDK.
 */
export async function startManagedPiSdkSession(
  options: ManagedPiSdkSessionOptions,
): Promise<ManagedPiSdkSessionController> {
  if (!path.isAbsolute(options.cwd))
    throw new ManagedPiSessionError('cwd_must_be_absolute');
  if (
    options.sessionId !== undefined &&
    !SESSION_ID_PATTERN.test(options.sessionId)
  )
    throw new ManagedPiSessionError('session_id_invalid');
  const resumeAuthorization = options.resumeAuthorization;
  if (resumeAuthorization) {
    if (
      !options.sessionId ||
      options.sessionId !== resumeAuthorization.sessionId ||
      path.resolve(options.cwd) !== path.resolve(resumeAuthorization.cwd) ||
      !options.executionScope ||
      canonicalJson(options.executionScope) !==
        canonicalJson(resumeAuthorization.scope) ||
      options.bootstrapExtensionPath
    )
      throw new ManagedPiSessionError('sdk_resume_authorization_mismatch');
    assertManagedPiSdkResumeAuthorization(resumeAuthorization, {
      sessionId: options.sessionId,
      cwd: options.cwd,
    });
  }
  if (!options.model.trim()) throw new ManagedPiSessionError('model_required');
  const quiesceTimeoutMs = options.quiesceTimeoutMs ?? 5_000;
  if (
    !Number.isSafeInteger(quiesceTimeoutMs) ||
    quiesceTimeoutMs <= 0 ||
    quiesceTimeoutMs > 30_000
  )
    throw new ManagedPiSessionError('quiesce_timeout_invalid');
  const sdk = await loadSdkModule(options.sdkModulePath);
  if (
    options.bootstrapExtensionPath &&
    !path.isAbsolute(options.bootstrapExtensionPath)
  )
    throw new ManagedPiSessionError(
      'bootstrap_extension_path_must_be_absolute',
    );
  if (sdk.VERSION !== SDK_VERSION)
    throw new ManagedPiSessionError(
      'unsupported_sdk_version',
      `Expected @earendil-works/pi-coding-agent ${SDK_VERSION}; received ${String(sdk.VERSION)}`,
    );
  verifySdkPrivateSourceHashes(options.sdkModulePath);
  const compaction = (await import(
    pathToFileURL(
      path.join(
        path.dirname(options.sdkModulePath),
        'core',
        'compaction',
        'compaction.js',
      ),
    ).href
  )) as {
    prepareCompaction(entries: unknown[], settings: unknown): unknown;
  };
  if (typeof compaction.prepareCompaction !== 'function')
    throw new ManagedPiSessionError('sdk_compaction_preparation_unavailable');
  if (options.sessionId && !resumeAuthorization) {
    const existingSessions = await sdk.SessionManager.list(options.cwd);
    if (existingSessions.some((session) => session.id === options.sessionId))
      throw new ManagedPiSessionError('session_id_already_exists');
  }
  for (const name of [
    'createAgentSessionServices',
    'createAgentSessionFromServices',
    'createAgentSessionRuntime',
    'createCodemodeExtension',
    'createToolSearchExtension',
    'createMcpExtension',
    'InteractiveMode',
  ]) {
    if (!(name in sdk))
      throw new ManagedPiSessionError('sdk_required_export_missing', name);
  }

  const artifacts = createManagedPiJournalArtifacts(options.journalPath);
  const { journal, metadataPath } = artifacts;
  const fence = new ManagedPiSdkIngressFence(journal);
  let controller: ManagedPiSdkSessionController | undefined;
  let runtime: ManagedPiSdkRuntimePort | undefined;
  let interactiveMode: ManagedPiSdkInteractiveModePort | undefined;
  let currentServices: ManagedPiSdkServices | undefined;
  try {
    journal.append('sdk_session_start_requested', {
      model: options.model,
      cwd: options.cwd,
      sdk_version: sdk.VERSION,
    });
    const agentDir = sdk.getAgentDir();
    let initialSessionManager: unknown;
    if (resumeAuthorization) {
      if (typeof sdk.SessionManager.open !== 'function')
        throw new ManagedPiSessionError('sdk_session_resume_api_unavailable');
      assertManagedPiSdkResumeAuthorization(resumeAuthorization, {
        sessionId: options.sessionId!,
        cwd: options.cwd,
      });
      const pinnedTranscript = hashSessionTranscript(
        resumeAuthorization.sessionFile,
        resumeAuthorization.sessionId,
        resumeAuthorization.cwd,
      );
      if (
        !pinnedTranscript ||
        pinnedTranscript.sessionFile !==
          path.resolve(resumeAuthorization.sessionFile) ||
        pinnedTranscript.transcriptDigest !==
          resumeAuthorization.transcriptDigest
      )
        throw new ManagedPiSessionError('sdk_resume_transcript_changed');
      initialSessionManager = sdk.SessionManager.open(
        resumeAuthorization.sessionFile,
      );
    } else {
      initialSessionManager = sdk.SessionManager.create(
        options.cwd,
        undefined,
        options.sessionId ? { id: options.sessionId } : undefined,
      );
    }
    const createRuntime = async (runtimeOptions: {
      cwd: string;
      agentDir: string;
      sessionManager: unknown;
      sessionStartEvent?: unknown;
    }) => {
      const services = await sdk.createAgentSessionServices({
        cwd: runtimeOptions.cwd,
        agentDir: runtimeOptions.agentDir,
        resourceLoaderOptions: {
          ...(options.bootstrapExtensionPath
            ? { additionalExtensionPaths: [options.bootstrapExtensionPath] }
            : {}),
          extensionFactories: [
            sdk.createCodemodeExtension(),
            sdk.createToolSearchExtension(),
            sdk.createMcpExtension(),
            createManagedPiSdkLifecycleExtension(
              fence,
              journal,
              metadataPath,
              options.canExecute,
            ),
          ],
        },
      });
      currentServices = services;
      if (options.bootstrapExtensionPath) {
        const loaded = services.resourceLoader?.getExtensions();
        if (
          !loaded ||
          !loaded.extensions.some(
            (entry) =>
              path.resolve(entry.path) ===
              path.resolve(options.bootstrapExtensionPath!),
          ) ||
          loaded.errors.length > 0
        )
          throw new ManagedPiSessionError('bootstrap_extension_not_loaded');
      }
      const model = services.modelRuntime.getModel('openrouter', options.model);
      if (!model)
        throw new ManagedPiSessionError(
          'openrouter_model_unavailable',
          options.model,
        );
      const created = await sdk.createAgentSessionFromServices({
        services,
        sessionManager: runtimeOptions.sessionManager,
        model,
        ...(options.thinkingLevel
          ? { thinkingLevel: options.thinkingLevel }
          : {}),
        sessionStartEvent: runtimeOptions.sessionStartEvent,
      });
      return {
        ...created,
        services,
        diagnostics: [...services.diagnostics],
      };
    };
    const createdRuntime = await sdk.createAgentSessionRuntime(createRuntime, {
      cwd: options.cwd,
      agentDir,
      sessionManager: initialSessionManager,
    });
    runtime = createdRuntime;
    if (resumeAuthorization) {
      assertManagedPiSdkResumeAuthorization(resumeAuthorization, {
        sessionId: options.sessionId!,
        cwd: options.cwd,
      });
      const reopenedSession = createdRuntime.session;
      const reopenedFile = reopenedSession.sessionFile;
      const reopenedTranscript = reopenedFile
        ? hashSessionTranscript(
            reopenedFile,
            reopenedSession.sessionId,
            createdRuntime.cwd,
          )
        : null;
      if (
        reopenedSession.sessionId !== resumeAuthorization.sessionId ||
        path.resolve(createdRuntime.cwd) !==
          path.resolve(resumeAuthorization.cwd) ||
        !reopenedFile ||
        path.resolve(reopenedFile) !==
          path.resolve(resumeAuthorization.sessionFile) ||
        !reopenedTranscript ||
        reopenedTranscript.transcriptDigest !==
          resumeAuthorization.transcriptDigest
      )
        throw new ManagedPiSessionError('sdk_resume_opened_session_mismatch');
    }
    const originalSetRebindSession =
      createdRuntime.setRebindSession.bind(createdRuntime);
    createdRuntime.setRebindSession = (callback) =>
      originalSetRebindSession(
        callback
          ? async (session) => {
              controller?.replaceSession(session);
              await callback(session);
            }
          : undefined,
      );
    interactiveMode = new sdk.InteractiveMode(createdRuntime);
    controller = new ManagedPiSdkSessionController({
      ...(options.canExecute ? { canExecute: options.canExecute } : {}),
      ...(resumeAuthorization ? { resumeAuthorization } : {}),
      runtime: createdRuntime,
      interactiveMode,
      fence,
      journal,
      model: options.model,
      nativeIdentity: options.nativeIdentity,
      quiesceTimeoutMs: quiesceTimeoutMs,
      ...(options.executionScope
        ? {
            executionScope:
              resumeAuthorization?.scope ?? options.executionScope,
          }
        : {}),
      metadataPath,
      resources: () => currentServices,
      canCompact: () => {
        const session = createdRuntime.session as unknown as {
          model: unknown;
          sessionManager?: { getBranch(): unknown[] };
        };
        const getSettings =
          currentServices?.settingsManager?.getCompactionSettings;
        if (!session.sessionManager || !getSettings) return false;
        return (
          compaction.prepareCompaction(
            session.sessionManager.getBranch(),
            getSettings.call(currentServices!.settingsManager, session.model),
          ) !== undefined
        );
      },
    });
    await options.beforeInteractiveStart?.(controller);
    await controller.initializeInteractiveMode();
    journal.append('sdk_session_ready', {
      session_id: createdRuntime.session.sessionId,
      session_file: createdRuntime.session.sessionFile ?? null,
      cwd: options.cwd,
      sdk_version: sdk.VERSION,
      terminal_ui_render: 'not_observed',
    });
    return controller;
  } catch (error) {
    fence.fence('sdk_start_failed');
    if (controller) {
      try {
        await controller.cleanupAfterStartupFailure();
      } catch {
        // The original startup error remains primary; do not claim cleanup succeeded.
      }
    } else {
      try {
        interactiveMode?.stop();
      } catch {
        // Best effort when InteractiveMode construction was partial.
      }
      let disposed = runtime === undefined;
      if (runtime)
        disposed = await waitWithin(runtime.dispose(), quiesceTimeoutMs);
      try {
        journal.append('sdk_start_failure_cleanup', {
          runtime_created: runtime !== undefined,
          runtime_disposed: disposed,
        });
        if (disposed) journal.close();
      } catch {
        // Preserve the original startup error and leave any uncertain journal open.
      }
    }
    throw error;
  }
}
