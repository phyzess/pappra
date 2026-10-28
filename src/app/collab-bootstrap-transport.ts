import { object as isRecord } from '../infra/validation.js';
import fs from 'node:fs';
import { managedPiSocketPeerPid } from './managed-pi-repair-stop.js';
import { readBoundedFile } from './bounded-file.js';
import { getPackageRoot } from '../package-info.js';
import path from 'node:path';
import { createHerdrTransport, runHerdrCommand } from './collab-notify.js';
import type {
  CommandResult,
  CommandRunner,
  HerdrCallerResult,
  HerdrListResult,
  HerdrTransport,
} from './collab-notify.js';

import {
  parsePaneLayout,
  type PaneLayoutGeometry,
} from './collab-pane-layout.js';
const READ_TIMEOUT_MS = 10_000;
const SPLIT_TIMEOUT_MS = 20_000;
const START_TIMEOUT_MS = 180_000;
const MAX_START_TIMEOUT_MS = 600_000;
const CLOSE_TIMEOUT_MS = 10_000;
const MAX_CAPTURE_CHARS = 32 * 1024;
const PANE_ID = /^[A-Za-z0-9]+:p[A-Za-z0-9]+$/;
const HERDR_AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface BootstrapCommandReceipt {
  readonly operation: string;
  readonly argv: readonly string[];
  readonly code: number | null;
  readonly signal: string | null;
  readonly spawned: boolean;
  readonly timed_out: boolean;
  readonly spawn_error: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type BootstrapReceiptWriter = (
  receipt: BootstrapCommandReceipt,
) => void | Promise<void>;

export interface BootstrapPaneSnapshot {
  readonly paneId: string;
  readonly terminalId: string;
  readonly workspaceId: string;
  readonly tabId: string;
  readonly cwd: string | null;
  readonly foregroundCwd: string | null;
  readonly agent: string | null;
  readonly agentStatus: string;
  readonly focused: boolean;
  readonly revision: number;
}

export interface BootstrapProcessSnapshot {
  readonly paneId: string;
  readonly shellPid: number | null;
  readonly foregroundProcessGroupId: number | null;
  readonly tty: string | null;
  readonly foregroundProcesses: readonly {
    readonly pid: number;
    readonly name: string;
  }[];
}

export interface BootstrapStartedAgent {
  readonly name: string | null;
  readonly harness: string | null;
  readonly paneId: string;
  readonly workspaceId: string;
  readonly terminalId: string;
  readonly cwd: string | null;
  readonly agentStatus: string;
  readonly interactiveReady: boolean;
  readonly launchPending: boolean;
  readonly sessionKind: string | null;
  readonly sessionValue: string | null;
  /** Herdr's typed executable argv, excluding raw shell/process output. */
  readonly argv: readonly string[];
}

export interface BootstrapManagedSdkLaunchEvidence {
  readonly runtime: 'sdk';
  readonly sdkModulePath: string;
  readonly bootstrapExtensionPath: string;
  readonly herdrAgentName: string;
  readonly journalPath: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: { readonly provider: 'openrouter'; readonly id: string };
  readonly ready: true;
}

/** SDK-native identity is sourced from authenticated managed control, not Herdr's session report. */
export interface BootstrapStartedManagedSdk {
  readonly agentName: string;
  readonly harness: string;
  readonly paneId: string;
  readonly cwd: string;
  readonly status: string;
  readonly sessionId: string;
  readonly identityProvenance: 'owned-pi-sdk-control';
  readonly controlSchema: 'harness-collab/pi-managed-sdk-session/1';
  readonly processPid: number;
  readonly socketPeerPid: number;
  readonly foregroundProcessPid: number;
  readonly pane: BootstrapPaneSnapshot;
  readonly launch: BootstrapManagedSdkLaunchEvidence;
}

export interface BootstrapManagedSdkStartInput {
  readonly name: string;
  readonly paneId: string;
  readonly workspaceId: string;
  readonly terminalId: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly openrouterModel: string;
  readonly sdkModulePath: string;
  readonly journalPath: string;
  readonly controlSocketPath: string;
  readonly bootstrapExtensionPath: string;
  readonly configPath: string;
  readonly configDigest: string;
  readonly automaticHandoffFile?: string;
  readonly handoffContextFile?: string;
  readonly timeoutMs?: number;
  readonly onReceipt?: BootstrapReceiptWriter;
}

export type ManagedSdkStartArgs = readonly ['pane', 'run', string, string];

/** Fixed current-package SDK start command; only path arguments are data. */
export function managedSdkStartArgs(input: {
  readonly paneId: string;
  readonly configPath: string;
}): ManagedSdkStartArgs {
  if (
    !path.isAbsolute(input.configPath) ||
    path.resolve(input.configPath) !== input.configPath
  )
    throw new Error('managed_sdk_command_argument_invalid');
  const quote = (value: string): string => {
    if (
      [...value].some((character) => {
        const code = character.charCodeAt(0);
        return code === 0 || code === 10 || code === 13;
      })
    )
      throw new Error('managed_sdk_command_argument_invalid');
    return `'${value.replaceAll("'", "''")}'`;
  };
  const command = `^${quote(process.execPath)} ${quote(path.join(getPackageRoot(), 'dist', 'cli', 'main.js'))} session start --config ${quote(input.configPath)}`;
  return ['pane', 'run', input.paneId, command];
}

export function acceptedManagedSdkStartReceipt(
  receipt: BootstrapCommandReceipt,
  input: { readonly paneId: string; readonly configPath: string },
): boolean {
  const expected = managedSdkStartArgs(input);
  return (
    receipt.operation === 'managed-sdk.start' &&
    receipt.spawned &&
    receipt.code === 0 &&
    receipt.signal === null &&
    !receipt.timed_out &&
    receipt.spawn_error === null &&
    receipt.argv.length === expected.length + 1 &&
    receipt.argv[0] === 'herdr' &&
    expected.every((argument, index) => receipt.argv[index + 1] === argument)
  );
}

export type BootstrapOperationResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly correlationId: string | null;
      readonly receipt: BootstrapCommandReceipt;
    }
  | {
      readonly ok: false;
      readonly status: 'failed' | 'unavailable' | 'unknown';
      readonly code: string;
      readonly detail: string;
      readonly correlationId: string | null;
      readonly receipt: BootstrapCommandReceipt;
    };

export interface HerdrBootstrapOps {
  readonly id: string;
  readonly transport: HerdrTransport;
  verifyCaller(paneId?: string | null): Promise<HerdrCallerResult>;
  listAgents(): Promise<HerdrListResult>;
  paneGet(
    paneId: string,
    timeoutMs?: number,
  ): Promise<BootstrapOperationResult<BootstrapPaneSnapshot>>;
  paneProcessInfo(
    paneId: string,
    timeoutMs?: number,
  ): Promise<BootstrapOperationResult<BootstrapProcessSnapshot>>;
  paneLayout(
    paneId: string,
    timeoutMs?: number,
  ): Promise<BootstrapOperationResult<PaneLayoutGeometry>>;
  splitPane(input: {
    readonly paneId: string;
    readonly cwd: string;
    readonly direction?: 'right' | 'down';
    readonly ratio?: number;
    readonly timeoutMs?: number;
    readonly onReceipt?: BootstrapReceiptWriter;
  }): Promise<BootstrapOperationResult<BootstrapPaneSnapshot>>;
  startAgent(input: {
    readonly name: string;
    readonly paneId: string;
    readonly sessionId: string;
    readonly extensionEntry: string;
    readonly openrouterModel?: string;
    readonly timeoutMs?: number;
    readonly onReceipt?: BootstrapReceiptWriter;
  }): Promise<BootstrapOperationResult<BootstrapStartedAgent>>;
  /** Queue a fixed managed-SDK CLI command and await authenticated runtime evidence. */
  startManagedSdk?(
    input: BootstrapManagedSdkStartInput,
  ): Promise<BootstrapOperationResult<BootstrapStartedManagedSdk>>;
  closePane(input: {
    readonly paneId: string;
    readonly timeoutMs?: number;
    readonly onReceipt?: BootstrapReceiptWriter;
  }): Promise<
    BootstrapOperationResult<{ readonly paneId: string; readonly closed: true }>
  >;
}

interface ParsedEnvelope {
  readonly correlationId: string | null;
  readonly resultType: string | null;
  readonly result: Record<string, unknown> | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly parseError: string | null;
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseEnvelope(result: CommandResult): ParsedEnvelope {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const source = stdout.length > 0 ? stdout : stderr;
  if (source.length === 0) {
    return {
      correlationId: null,
      resultType: null,
      result: null,
      errorCode: null,
      errorMessage: null,
      parseError: 'empty_response',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return {
      correlationId: null,
      resultType: null,
      result: null,
      errorCode: null,
      errorMessage: null,
      parseError: 'invalid_json',
    };
  }
  if (!isRecord(parsed)) {
    return {
      correlationId: null,
      resultType: null,
      result: null,
      errorCode: null,
      errorMessage: null,
      parseError: 'envelope_not_object',
    };
  }
  const correlationId = nullableText(parsed['id']);
  const error = parsed['error'];
  const resultValue = parsed['result'];
  if (isRecord(error)) {
    return {
      correlationId,
      resultType: null,
      result: null,
      errorCode: nullableText(error['code']),
      errorMessage: nullableText(error['message']),
      parseError: null,
    };
  }
  if (!isRecord(resultValue)) {
    return {
      correlationId,
      resultType: null,
      result: null,
      errorCode: null,
      errorMessage: null,
      parseError: 'result_missing',
    };
  }
  return {
    correlationId,
    resultType: nullableText(resultValue['type']),
    result: resultValue,
    errorCode: null,
    errorMessage: null,
    parseError: null,
  };
}

function capture(
  operation: string,
  argv: readonly string[],
  result: CommandResult,
): BootstrapCommandReceipt {
  return {
    operation,
    argv: [...argv],
    code: result.code,
    signal: result.signal,
    spawned: result.spawned,
    timed_out: result.timedOut,
    spawn_error: result.spawnError,
    stdout: result.stdout.slice(0, MAX_CAPTURE_CHARS),
    stderr: result.stderr.slice(0, MAX_CAPTURE_CHARS),
  };
}

function fail<T>(
  status: 'failed' | 'unavailable' | 'unknown',
  code: string,
  detail: string,
  correlationId: string | null,
  receipt: BootstrapCommandReceipt,
): BootstrapOperationResult<T> {
  return { ok: false, status, code, detail, correlationId, receipt };
}

function parsePane(value: unknown): BootstrapPaneSnapshot | null {
  if (!isRecord(value)) return null;
  const paneId = nullableText(value['pane_id']);
  const terminalId = nullableText(value['terminal_id']);
  const workspaceId = nullableText(value['workspace_id']);
  const tabId = nullableText(value['tab_id']);
  const agentStatus = nullableText(value['agent_status']);
  const revision = value['revision'];
  if (
    paneId === null ||
    !PANE_ID.test(paneId) ||
    terminalId === null ||
    workspaceId === null ||
    tabId === null ||
    agentStatus === null ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  )
    return null;
  return {
    paneId,
    terminalId,
    workspaceId,
    tabId,
    cwd: nullableText(value['cwd']),
    foregroundCwd: nullableText(value['foreground_cwd']),
    agent: nullableText(value['agent']),
    agentStatus,
    focused: value['focused'] === true,
    revision,
  };
}

async function invoke<T>(input: {
  readonly run: CommandRunner;
  readonly bin: string;
  readonly operation: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly expectedType: string;
  readonly select: (result: Record<string, unknown>) => T | null;
  readonly onReceipt?: BootstrapReceiptWriter;
}): Promise<BootstrapOperationResult<T>> {
  const argv = ['herdr', ...input.args];
  let result: CommandResult;
  try {
    result = await input.run(input.bin, input.args, input.timeoutMs);
  } catch (error) {
    const receipt: BootstrapCommandReceipt = {
      operation: input.operation,
      argv,
      code: null,
      signal: null,
      spawned: false,
      timed_out: false,
      spawn_error: error instanceof Error ? error.message : String(error),
      stdout: '',
      stderr: '',
    };
    try {
      await input.onReceipt?.(receipt);
    } catch {
      // The launch caller will report the durable receipt failure as unknown.
    }
    return fail(
      'unavailable',
      'command_runner_failed',
      receipt.spawn_error ?? 'Command runner failed',
      null,
      receipt,
    );
  }
  const receipt = capture(input.operation, argv, result);
  try {
    // For effectful calls, persist the bounded raw response before parsing it.
    await input.onReceipt?.(receipt);
  } catch (error) {
    return fail(
      'unknown',
      'receipt_persist_failed',
      error instanceof Error ? error.message : 'Receipt persistence failed',
      null,
      receipt,
    );
  }
  const parsed = parseEnvelope(result);
  if (!result.spawned) {
    return fail(
      'unavailable',
      'herdr_not_callable',
      result.spawnError ?? 'Herdr command did not spawn',
      parsed.correlationId,
      receipt,
    );
  }
  if (result.timedOut || result.signal !== null) {
    return fail(
      'unknown',
      'herdr_command_timeout',
      'Herdr command outcome is uncertain after timeout/signal',
      parsed.correlationId,
      receipt,
    );
  }
  if (result.code !== 0) {
    const startupMayHaveBegun =
      input.operation === 'agent.start' &&
      ['agent_not_ready', 'agent_launch_pending', 'agent_name_lost'].includes(
        parsed.errorCode ?? '',
      );
    return fail(
      startupMayHaveBegun || parsed.errorCode === null ? 'unknown' : 'failed',
      parsed.errorCode ?? 'herdr_command_failed',
      parsed.errorMessage ??
        parsed.parseError ??
        `Herdr exited ${String(result.code)}`,
      parsed.correlationId,
      receipt,
    );
  }
  if (
    parsed.parseError !== null ||
    parsed.result === null ||
    parsed.resultType === null
  ) {
    return fail(
      'failed',
      'herdr_response_invalid',
      parsed.parseError ?? 'Herdr response result is invalid',
      parsed.correlationId,
      receipt,
    );
  }
  if (parsed.resultType !== input.expectedType) {
    return fail(
      'failed',
      'herdr_result_type_mismatch',
      `Expected ${input.expectedType}; received ${parsed.resultType}`,
      parsed.correlationId,
      receipt,
    );
  }
  const selected = input.select(parsed.result);
  if (selected === null) {
    return fail(
      'failed',
      'herdr_payload_invalid',
      `Herdr ${input.operation} returned an invalid ${input.expectedType} payload`,
      parsed.correlationId,
      receipt,
    );
  }
  return {
    ok: true,
    value: selected,
    correlationId: parsed.correlationId,
    receipt,
  };
}

interface ManagedSdkControlObservation {
  readonly processPid: number;
  readonly controlSchema: 'harness-collab/pi-managed-sdk-session/1';
  readonly launch: BootstrapManagedSdkLaunchEvidence;
}

function parseManagedSdkControlStatus(
  result: CommandResult,
): ManagedSdkControlObservation | null {
  if (
    !result.spawned ||
    result.timedOut ||
    result.signal !== null ||
    result.code !== 0
  )
    return null;
  let value: unknown;
  try {
    value = JSON.parse(result.stdout.trim()) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value) || value['ok'] !== true) return null;
  const snapshot = value['snapshot'];
  const automation = value['automation'];
  if (!isRecord(snapshot) || !isRecord(automation)) return null;
  const process = snapshot['process'];
  const session = snapshot['session'];
  const ingress = snapshot['ingress'];
  const launchValue = automation['launch'];
  if (
    !isRecord(process) ||
    !isRecord(session) ||
    !isRecord(ingress) ||
    !isRecord(launchValue) ||
    snapshot['schema'] !== 'harness-collab/pi-managed-sdk-session/1' ||
    process['exit'] !== 'not_owned' ||
    typeof process['pid'] !== 'number' ||
    !Number.isSafeInteger(process['pid']) ||
    process['pid'] <= 0 ||
    launchValue['runtime'] !== 'sdk' ||
    launchValue['ready'] !== true ||
    typeof launchValue['sdk_module_path'] !== 'string' ||
    typeof launchValue['bootstrap_extension_path'] !== 'string' ||
    typeof launchValue['herdr_agent_name'] !== 'string' ||
    typeof launchValue['journal_path'] !== 'string' ||
    typeof launchValue['session_id'] !== 'string' ||
    typeof launchValue['cwd'] !== 'string' ||
    !isRecord(launchValue['model']) ||
    launchValue['model']['provider'] !== 'openrouter' ||
    typeof launchValue['model']['id'] !== 'string' ||
    session['sessionId'] !== launchValue['session_id'] ||
    ingress['journalPath'] !== launchValue['journal_path']
  )
    return null;
  return {
    processPid: process['pid'],
    controlSchema: 'harness-collab/pi-managed-sdk-session/1',
    launch: {
      runtime: 'sdk',
      sdkModulePath: launchValue['sdk_module_path'],
      bootstrapExtensionPath: launchValue['bootstrap_extension_path'],
      herdrAgentName: launchValue['herdr_agent_name'],
      journalPath: launchValue['journal_path'],
      sessionId: launchValue['session_id'],
      cwd: launchValue['cwd'],
      model: {
        provider: 'openrouter',
        id: launchValue['model']['id'],
      },
      ready: true,
    },
  };
}

function sameRealPath(left: string, right: string): boolean {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return false;
  }
}

function privateManagedConfigMatches(
  input: BootstrapManagedSdkStartInput,
): boolean {
  const loaded = readBoundedFile(input.configPath, 64 * 1024);
  if (
    !loaded.ok ||
    loaded.digest !== input.configDigest ||
    !/^sha256:[0-9a-f]{64}$/.test(input.configDigest)
  )
    return false;
  let value: unknown;
  try {
    value = JSON.parse(loaded.text) as unknown;
  } catch {
    return false;
  }
  if (!isRecord(value)) return false;
  const model = value['model'];
  if (
    value['schema'] !== 'pappra/managed-pi-session-request/1' ||
    value['runtime'] !== 'sdk' ||
    value['cwd'] !== input.cwd ||
    value['sessionId'] !== input.sessionId ||
    value['sdkModulePath'] !== input.sdkModulePath ||
    value['journalPath'] !== input.journalPath ||
    value['controlSocketPath'] !== input.controlSocketPath ||
    value['bootstrapExtensionPath'] !== input.bootstrapExtensionPath ||
    value['herdrAgentName'] !== input.name ||
    value['herdrPaneId'] !== input.paneId ||
    model !== input.openrouterModel ||
    Object.hasOwn(value, 'executionScope') ||
    (input.automaticHandoffFile === undefined
      ? Object.hasOwn(value, 'automaticHandoffFile')
      : value['automaticHandoffFile'] !== input.automaticHandoffFile) ||
    (input.handoffContextFile === undefined
      ? Object.hasOwn(value, 'handoffContextFile')
      : value['handoffContextFile'] !== input.handoffContextFile)
  )
    return false;
  try {
    const directory = path.dirname(input.configPath);
    const directoryStat = fs.lstatSync(directory);
    const configStat = fs.lstatSync(input.configPath);
    return (
      directoryStat.isDirectory() &&
      !directoryStat.isSymbolicLink() &&
      fs.realpathSync(directory) === directory &&
      (directoryStat.mode & 0o077) === 0 &&
      (typeof process.getuid !== 'function' ||
        directoryStat.uid === process.getuid()) &&
      configStat.isFile() &&
      !configStat.isSymbolicLink() &&
      (configStat.mode & 0o777) === 0o400 &&
      (typeof process.getuid !== 'function' ||
        configStat.uid === process.getuid())
    );
  } catch {
    return false;
  }
}
export function createHerdrBootstrapOps(
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly run?: CommandRunner;
    readonly transport?: HerdrTransport;
    readonly taskRoot?: string;
    readonly peerPid?: (socketPath: string) => number | null;
  } = {},
): HerdrBootstrapOps {
  const env = options.env ?? process.env;
  const run = options.run ?? runHerdrCommand;
  const transport =
    options.transport ??
    createHerdrTransport({
      env,
      run,
      ...(options.taskRoot === undefined ? {} : { taskRoot: options.taskRoot }),
    });
  const socketPeerPid = options.peerPid ?? managedPiSocketPeerPid;
  const bin =
    typeof env['HERDR_BIN_PATH'] === 'string' &&
    env['HERDR_BIN_PATH'].trim() !== ''
      ? env['HERDR_BIN_PATH']
      : 'herdr';
  const ops: HerdrBootstrapOps = {
    id: 'herdr-bootstrap',
    transport,
    verifyCaller: (paneId) =>
      transport.verifyCaller(
        paneId === undefined || paneId === null ? {} : { paneId },
      ),
    listAgents: () => transport.list(),
    paneGet: (paneId, timeoutMs = READ_TIMEOUT_MS) =>
      invoke({
        run,
        bin,
        operation: 'pane.get',
        args: ['pane', 'get', paneId],
        timeoutMs,
        expectedType: 'pane_info',
        select: (result) => parsePane(result['pane']),
      }),
    paneProcessInfo: (paneId, timeoutMs = READ_TIMEOUT_MS) =>
      invoke({
        run,
        bin,
        operation: 'pane.process-info',
        args: ['pane', 'process-info', '--pane', paneId],
        timeoutMs,
        expectedType: 'pane_process_info',
        select: (result) => {
          const value = result['process_info'];
          if (!isRecord(value) || value['pane_id'] !== paneId) return null;
          const shellPid = value['shell_pid'];
          const foregroundProcessGroupId = value['foreground_process_group_id'];
          if (
            shellPid !== undefined &&
            shellPid !== null &&
            (typeof shellPid !== 'number' ||
              !Number.isSafeInteger(shellPid) ||
              shellPid <= 0)
          )
            return null;
          if (
            foregroundProcessGroupId !== undefined &&
            foregroundProcessGroupId !== null &&
            (typeof foregroundProcessGroupId !== 'number' ||
              !Number.isSafeInteger(foregroundProcessGroupId) ||
              foregroundProcessGroupId <= 0)
          )
            return null;
          const rawProcesses = value['foreground_processes'];
          if (rawProcesses !== undefined && !Array.isArray(rawProcesses))
            return null;
          const foregroundProcesses: { pid: number; name: string }[] = [];
          for (const item of rawProcesses ?? []) {
            if (
              !isRecord(item) ||
              !Number.isSafeInteger(item['pid']) ||
              (item['pid'] as number) <= 0 ||
              typeof item['name'] !== 'string'
            )
              return null;
            foregroundProcesses.push({
              pid: item['pid'] as number,
              name: item['name'],
            });
          }
          return {
            paneId,
            shellPid: typeof shellPid === 'number' ? shellPid : null,
            foregroundProcessGroupId:
              typeof foregroundProcessGroupId === 'number'
                ? foregroundProcessGroupId
                : null,
            tty: nullableText(value['tty']),
            foregroundProcesses,
          };
        },
      }),
    paneLayout: (paneId, timeoutMs = READ_TIMEOUT_MS) =>
      invoke({
        run,
        bin,
        operation: 'pane.layout',
        args: ['pane', 'layout', '--pane', paneId],
        timeoutMs,
        expectedType: 'pane_layout',
        select: (result) => parsePaneLayout(result['layout']),
      }),
    splitPane: ({
      paneId,
      cwd,
      direction,
      ratio,
      timeoutMs = SPLIT_TIMEOUT_MS,
      onReceipt,
    }) => {
      if (!PANE_ID.test(paneId))
        return Promise.resolve(
          fail(
            'failed',
            'pane_id_invalid',
            'Caller pane id is invalid',
            null,
            emptyReceipt('pane.split'),
          ),
        );
      if (!path.isAbsolute(cwd))
        return Promise.resolve(
          fail(
            'failed',
            'cwd_invalid',
            'Split cwd must be absolute',
            null,
            emptyReceipt('pane.split'),
          ),
        );
      if (
        ratio !== undefined &&
        (!Number.isFinite(ratio) || ratio < 0.1 || ratio > 0.9)
      )
        return Promise.resolve(
          fail(
            'failed',
            'ratio_invalid',
            'Split ratio must be a finite number between 0.1 and 0.9',
            null,
            emptyReceipt('pane.split'),
          ),
        );
      const args = [
        'pane',
        'split',
        '--pane',
        paneId,
        '--cwd',
        cwd,
        '--no-focus',
      ];
      if (direction !== undefined) args.push('--direction', direction);
      if (ratio !== undefined) args.push('--ratio', String(ratio));
      return invoke({
        run,
        bin,
        operation: 'pane.split',
        args,
        timeoutMs,
        expectedType: 'pane_info',
        select: (result) => parsePane(result['pane']),
        ...(onReceipt === undefined ? {} : { onReceipt }),
      });
    },
    startAgent: ({
      name,
      paneId,
      sessionId,
      extensionEntry,
      openrouterModel,
      timeoutMs = START_TIMEOUT_MS,
      onReceipt,
    }) => {
      if (!HERDR_AGENT_NAME.test(name))
        return Promise.resolve(
          fail(
            'failed',
            'agent_name_invalid',
            'Herdr agent name is invalid',
            null,
            emptyReceipt('agent.start'),
          ),
        );
      if (!PANE_ID.test(paneId))
        return Promise.resolve(
          fail(
            'failed',
            'pane_id_invalid',
            'Target pane id is invalid',
            null,
            emptyReceipt('agent.start'),
          ),
        );
      if (!UUID.test(sessionId))
        return Promise.resolve(
          fail(
            'failed',
            'session_id_invalid',
            'Successor session selector must be a UUID',
            null,
            emptyReceipt('agent.start'),
          ),
        );
      if (!path.isAbsolute(extensionEntry))
        return Promise.resolve(
          fail(
            'failed',
            'extension_invalid',
            'Pi extension path must be absolute',
            null,
            emptyReceipt('agent.start'),
          ),
        );
      if (
        openrouterModel !== undefined &&
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(openrouterModel)
      )
        return Promise.resolve(
          fail(
            'failed',
            'model_invalid',
            'OpenRouter model identifier is invalid',
            null,
            emptyReceipt('agent.start'),
          ),
        );
      const args = [
        'agent',
        'start',
        name,
        '--kind',
        'pi',
        '--pane',
        paneId,
        '--timeout',
        String(timeoutMs),
        '--',
        '--session-id',
        sessionId,
        '--name',
        name,
        '--extension',
        extensionEntry,
        ...(openrouterModel
          ? ['--provider', 'openrouter', '--model', openrouterModel]
          : []),
      ];
      return invoke({
        run,
        bin,
        operation: 'agent.start',
        args,
        timeoutMs: timeoutMs + 5_000,
        expectedType: 'agent_started',
        select: (result) => {
          const agent = result['agent'];
          const argv = result['argv'];
          if (
            !isRecord(agent) ||
            !Array.isArray(argv) ||
            argv.some((item) => typeof item !== 'string')
          )
            return null;
          const paneInfo = parsePane(agent);
          if (paneInfo === null || paneInfo.paneId !== paneId) return null;
          const session = agent['agent_session'];
          const sessionKind = isRecord(session)
            ? nullableText(session['kind'])
            : null;
          const sessionValue = isRecord(session)
            ? nullableText(session['value'])
            : null;
          return {
            name: nullableText(agent['name']),
            harness: nullableText(agent['agent']),
            paneId: paneInfo.paneId,
            workspaceId: paneInfo.workspaceId,
            terminalId: paneInfo.terminalId,
            cwd: paneInfo.cwd,
            agentStatus: paneInfo.agentStatus,
            interactiveReady: agent['interactive_ready'] === true,
            launchPending: agent['launch_pending'] === true,
            sessionKind,
            sessionValue,
            argv: argv as string[],
          };
        },
        ...(onReceipt === undefined ? {} : { onReceipt }),
      });
    },
    startManagedSdk: async (input) => {
      const timeoutMs = input.timeoutMs ?? START_TIMEOUT_MS;
      const empty = emptyReceipt('managed-sdk.start');
      const failManaged = (
        status: 'failed' | 'unavailable' | 'unknown',
        code: string,
        detail: string,
        receipt: BootstrapCommandReceipt = empty,
        correlationId: string | null = null,
      ) =>
        fail<BootstrapStartedManagedSdk>(
          status,
          code,
          detail,
          correlationId,
          receipt,
        );
      if (
        !HERDR_AGENT_NAME.test(input.name) ||
        !PANE_ID.test(input.paneId) ||
        !UUID.test(input.sessionId) ||
        !path.isAbsolute(input.cwd) ||
        !path.isAbsolute(input.sdkModulePath) ||
        !path.isAbsolute(input.journalPath) ||
        !path.isAbsolute(input.controlSocketPath) ||
        !path.isAbsolute(input.bootstrapExtensionPath) ||
        !path.isAbsolute(input.configPath) ||
        (input.handoffContextFile !== undefined &&
          (!path.isAbsolute(input.handoffContextFile) ||
            path.resolve(input.handoffContextFile) !==
              input.handoffContextFile ||
            [...input.handoffContextFile].some((character) => {
              const code = character.charCodeAt(0);
              return code === 0 || code === 10 || code === 13;
            }))) ||
        Buffer.byteLength(input.controlSocketPath) > 100 ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(input.openrouterModel) ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > MAX_START_TIMEOUT_MS
      )
        return failManaged(
          'failed',
          'managed_start_input_invalid',
          'Managed SDK start input failed bounded path, identity or model validation.',
        );
      if (!privateManagedConfigMatches(input))
        return failManaged(
          'failed',
          'managed_config_invalid',
          'Managed SDK config is not the exact private immutable request reserved by bootstrap.',
        );
      let args: ManagedSdkStartArgs;
      try {
        args = managedSdkStartArgs(input);
      } catch {
        return failManaged(
          'failed',
          'managed_start_command_invalid',
          'Managed SDK command could not be safely encoded as fixed Nushell arguments.',
        );
      }
      const commandArgv = ['herdr', ...args];
      let submitted: CommandResult;
      try {
        submitted = await run(bin, args, timeoutMs + 5_000);
      } catch {
        const receipt: BootstrapCommandReceipt = {
          ...empty,
          argv: commandArgv,
          spawn_error: 'command_runner_failed',
        };
        try {
          await input.onReceipt?.(receipt);
        } catch {
          return failManaged(
            'unknown',
            'managed_start_receipt_persist_failed',
            'Managed SDK submission outcome is unknown because its receipt was not persisted.',
            receipt,
          );
        }
        return failManaged(
          'unavailable',
          'managed_start_runner_failed',
          'Herdr pane run was unavailable before a command could be queued.',
          receipt,
        );
      }
      const receipt = capture('managed-sdk.start', commandArgv, submitted);
      try {
        await input.onReceipt?.(receipt);
      } catch {
        return failManaged(
          'unknown',
          'managed_start_receipt_persist_failed',
          'Managed SDK submission outcome is unknown because its receipt was not persisted.',
          receipt,
        );
      }
      if (!submitted.spawned)
        return failManaged(
          'unavailable',
          'herdr_not_callable',
          'Herdr did not spawn the managed pane-run command.',
          receipt,
        );
      if (
        submitted.timedOut ||
        submitted.signal !== null ||
        submitted.code !== 0
      )
        return failManaged(
          'unknown',
          'managed_start_submission_unknown',
          'Herdr pane-run may have queued the managed CLI; startup must be reconciled without resubmission.',
          receipt,
        );
      const queued = parseEnvelope(submitted);
      // Herdr 0.9.5 acknowledges pane-run with exit 0 and empty stdout. This
      // proves queue submission only; authenticated startup evidence is still required.
      const emptyQueueReceipt = submitted.stdout.trim().length === 0;
      if (
        !emptyQueueReceipt &&
        (queued.parseError !== null ||
          queued.result === null ||
          queued.resultType === null)
      )
        return failManaged(
          'unknown',
          'managed_start_submission_unconfirmed',
          'Herdr pane-run response did not confirm a typed submission; no retry is permitted.',
          receipt,
          queued.correlationId,
        );
      const responsePane = queued.result?.['pane_id'];
      if (responsePane !== undefined && responsePane !== input.paneId)
        return failManaged(
          'unknown',
          'managed_start_pane_mismatch',
          'Herdr pane-run response identified a different pane.',
          receipt,
          queued.correlationId,
        );

      const cliPath = path.join(getPackageRoot(), 'dist', 'cli', 'main.js');
      const deadline = Date.now() + timeoutMs;
      let lastDetail =
        'Waiting for owned SDK control and Herdr identity evidence.';
      while (Date.now() <= deadline) {
        const listed = await transport.list();
        if (!listed.ok) {
          lastDetail = 'Herdr agent list is temporarily unavailable.';
        } else {
          const named = listed.agents.filter(
            (agent) => agent.name === input.name,
          );
          if (named.length > 1)
            return failManaged(
              'unknown',
              'managed_herdr_name_ambiguous',
              'More than one Herdr observation claims the managed agent name.',
              receipt,
              queued.correlationId,
            );
          const agent = named[0];
          if (agent !== undefined) {
            if (
              (agent.paneId !== null && agent.paneId !== input.paneId) ||
              (agent.cwd !== null && !sameRealPath(agent.cwd, input.cwd)) ||
              (agent.harness !== null && agent.harness !== 'pi')
            )
              return failManaged(
                'unknown',
                'managed_herdr_identity_mismatch',
                'The named Herdr observation belongs to a different pane, cwd or harness.',
                receipt,
                queued.correlationId,
              );
            const status = agent.status.trim().toLowerCase();
            if (
              agent.paneId === input.paneId &&
              agent.harness === 'pi' &&
              agent.cwd !== null &&
              sameRealPath(agent.cwd, input.cwd) &&
              ['idle', 'done', 'working', 'running'].includes(status)
            ) {
              const pane = await ops.paneGet(input.paneId, READ_TIMEOUT_MS);
              if (!pane.ok) {
                lastDetail = 'Owned pane identity is not yet observable.';
              } else if (
                pane.value.paneId !== input.paneId ||
                pane.value.workspaceId !== input.workspaceId ||
                pane.value.terminalId !== input.terminalId ||
                pane.value.cwd === null ||
                !sameRealPath(pane.value.cwd, input.cwd)
              ) {
                return failManaged(
                  'unknown',
                  'managed_pane_identity_mismatch',
                  'Herdr pane identity or cwd changed during managed SDK startup.',
                  receipt,
                  queued.correlationId,
                );
              } else {
                let statusResult: CommandResult | null = null;
                try {
                  statusResult = await run(
                    process.execPath,
                    [
                      cliPath,
                      'session',
                      'status',
                      '--config',
                      input.configPath,
                      '--json',
                    ],
                    READ_TIMEOUT_MS,
                  );
                } catch {
                  lastDetail =
                    'Authenticated managed SDK control is not yet reachable.';
                }
                const control =
                  statusResult === null
                    ? null
                    : parseManagedSdkControlStatus(statusResult);
                if (control !== null) {
                  const launch = control.launch;
                  if (
                    launch.sdkModulePath !== input.sdkModulePath ||
                    launch.bootstrapExtensionPath !==
                      input.bootstrapExtensionPath ||
                    launch.herdrAgentName !== input.name ||
                    launch.journalPath !== input.journalPath ||
                    launch.sessionId !== input.sessionId ||
                    !sameRealPath(launch.cwd, input.cwd) ||
                    launch.model.provider !== 'openrouter' ||
                    launch.model.id !== input.openrouterModel ||
                    launch.ready !== true
                  )
                    return failManaged(
                      'unknown',
                      'managed_sdk_control_mismatch',
                      'Authenticated SDK control metadata did not match the reserved managed launch.',
                      receipt,
                      queued.correlationId,
                    );
                  const process = await ops.paneProcessInfo(
                    input.paneId,
                    READ_TIMEOUT_MS,
                  );
                  if (!process.ok) {
                    lastDetail =
                      'Owned pane foreground process is not yet observable.';
                  } else if (process.value.paneId !== input.paneId) {
                    return failManaged(
                      'unknown',
                      'managed_process_info_pane_mismatch',
                      'Herdr process-info returned a different pane.',
                      receipt,
                      queued.correlationId,
                    );
                  } else {
                    const socketPid = socketPeerPid(input.controlSocketPath);
                    const foreground = process.value.foregroundProcesses.find(
                      (item) => item.pid === control.processPid,
                    );
                    if (socketPid !== null && socketPid !== control.processPid)
                      return failManaged(
                        'unknown',
                        'managed_control_socket_owner_mismatch',
                        'The managed control socket is owned by a different OS process.',
                        receipt,
                        queued.correlationId,
                      );
                    if (
                      socketPid === control.processPid &&
                      foreground !== undefined
                    ) {
                      return {
                        ok: true,
                        value: {
                          agentName: agent.name!,
                          harness: agent.harness,
                          paneId: input.paneId,
                          cwd: agent.cwd,
                          status: agent.status,
                          sessionId: control.launch.sessionId,
                          identityProvenance: 'owned-pi-sdk-control',
                          controlSchema: control.controlSchema,
                          processPid: control.processPid,
                          socketPeerPid: socketPid,
                          foregroundProcessPid: foreground.pid,
                          pane: pane.value,
                          launch: control.launch,
                        },
                        correlationId: queued.correlationId,
                        receipt,
                      };
                    }
                    lastDetail =
                      'SDK control, socket owner and pane foreground PID do not yet agree.';
                  }
                }
              }
            }
          }
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(100, remaining)),
        );
      }
      return failManaged(
        'unknown',
        'managed_sdk_start_observation_timeout',
        `${lastDetail} No resubmission or cleanup is permitted for this request id.`,
        receipt,
        queued.correlationId,
      );
    },
    closePane: ({ paneId, timeoutMs = CLOSE_TIMEOUT_MS, onReceipt }) => {
      if (!PANE_ID.test(paneId))
        return Promise.resolve(
          fail(
            'failed',
            'pane_id_invalid',
            'Owned pane id is invalid',
            null,
            emptyReceipt('pane.close'),
          ),
        );
      return invoke({
        run,
        bin,
        operation: 'pane.close',
        args: ['pane', 'close', paneId],
        timeoutMs,
        expectedType: 'ok',
        select: (result) =>
          result['type'] === 'ok' ? { paneId, closed: true as const } : null,
        ...(onReceipt === undefined ? {} : { onReceipt }),
      });
    },
  };
  return ops;
}

function emptyReceipt(operation: string): BootstrapCommandReceipt {
  return {
    operation,
    argv: [],
    code: null,
    signal: null,
    spawned: false,
    timed_out: false,
    spawn_error: null,
    stdout: '',
    stderr: '',
  };
}
