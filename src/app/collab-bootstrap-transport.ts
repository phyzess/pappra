import path from 'node:path';
import { createHerdrTransport, runHerdrCommand } from './collab-notify.js';
import type {
  CommandResult,
  CommandRunner,
  HerdrCallerResult,
  HerdrListResult,
  HerdrTransport,
} from './collab-notify.js';

const READ_TIMEOUT_MS = 10_000;
const SPLIT_TIMEOUT_MS = 20_000;
const START_TIMEOUT_MS = 45_000;
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
  splitPane(input: {
    readonly paneId: string;
    readonly cwd: string;
    readonly direction?: 'right' | 'down';
    readonly timeoutMs?: number;
    readonly onReceipt?: BootstrapReceiptWriter;
  }): Promise<BootstrapOperationResult<BootstrapPaneSnapshot>>;
  startAgent(input: {
    readonly name: string;
    readonly paneId: string;
    readonly sessionId: string;
    readonly extensionEntry: string;
    readonly timeoutMs?: number;
    readonly onReceipt?: BootstrapReceiptWriter;
  }): Promise<BootstrapOperationResult<BootstrapStartedAgent>>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

export function createHerdrBootstrapOps(
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly run?: CommandRunner;
    readonly transport?: HerdrTransport;
  } = {},
): HerdrBootstrapOps {
  const env = options.env ?? process.env;
  const run = options.run ?? runHerdrCommand;
  const transport = options.transport ?? createHerdrTransport({ env, run });
  const bin =
    typeof env['HERDR_BIN_PATH'] === 'string' &&
    env['HERDR_BIN_PATH'].trim() !== ''
      ? env['HERDR_BIN_PATH']
      : 'herdr';
  return {
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
    splitPane: ({
      paneId,
      cwd,
      direction,
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
