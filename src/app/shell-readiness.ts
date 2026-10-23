import type {
  BootstrapPaneSnapshot,
  BootstrapProcessSnapshot,
  HerdrBootstrapOps,
} from './collab-bootstrap-transport.js';

export const SHELL_READINESS_BUDGET_MS = 10_000;
export const SHELL_READINESS_INTERVAL_MS = 100;
export const SHELL_READINESS_MAX_SAMPLES = 100;
const MAX_CAPTURED_PROCESSES = 8;

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
const AGENT_NAMES = new Set([
  'pi',
  'codex',
  'claude',
  'gemini',
  'cursor',
  'devin',
  'agy',
  'cline',
  'omp',
  'opencode',
  'copilot',
  'kimi',
  'kiro',
  'droid',
  'amp',
  'grok',
  'hermes',
  'kilo',
  'qodercli',
  'qwen',
  'letta',
  'maki',
  'muse',
]);

export type ShellReadinessStatus =
  'ready' | 'unknown' | 'timeout' | 'aborted' | 'failed';
export type ShellSampleState = 'ready' | 'unknown' | 'not_ready' | 'failed';

export interface ShellReadinessSample {
  readonly elapsed_ms: number;
  readonly state: ShellSampleState;
  readonly code: string | null;
  readonly shell_pid: number | null;
  readonly foreground_process_group_id: number | null;
  readonly shell_name: string | null;
  readonly foreground_processes: readonly {
    readonly pid: number;
    readonly name: string;
  }[];
  readonly processes_truncated: number;
}

export interface ShellReadinessEvidence {
  readonly state: ShellReadinessStatus;
  readonly code: string | null;
  readonly attempts: number;
  readonly elapsed_ms: number;
  readonly pane_id: string;
  readonly workspace_id: string;
  readonly terminal_id: string;
  readonly cwd: string;
  readonly shell_pid: number | null;
  readonly foreground_process_group_id: number | null;
  readonly shell_name: string | null;
  readonly last_state: ShellSampleState | 'not_observed';
  readonly last_code: string | null;
  readonly limits: {
    readonly budget_ms: number;
    readonly interval_ms: number;
    readonly max_samples: number;
    readonly samples_truncated: number;
  };
  readonly samples: readonly ShellReadinessSample[];
}

export interface ShellReadinessResult {
  readonly status: ShellReadinessStatus;
  readonly code: string | null;
  readonly evidence: ShellReadinessEvidence;
}

export interface ShellReadinessOptions {
  readonly budgetMs?: number;
  readonly intervalMs?: number;
  readonly maxSamples?: number;
  readonly clock?: () => number;
  readonly sleeper?: (milliseconds: number) => Promise<void>;
  readonly shouldAbort?: () => boolean;
}

export interface ShellReadinessIdentity {
  readonly paneId: string;
  readonly workspaceId: string;
  readonly terminalId: string;
  readonly cwd: string;
}

function normalizedName(value: string): string {
  const tail = value.split(/[\\/]/).at(-1) ?? value;
  return tail
    .replace(/^-+/, '')
    .replace(/\.exe$/i, '')
    .toLowerCase();
}

function validNumber(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value > 0;
}

function identityCode(
  pane: BootstrapPaneSnapshot,
  expected: ShellReadinessIdentity,
): string | null {
  if (pane.paneId !== expected.paneId) return 'pane_id_mismatch';
  if (pane.workspaceId !== expected.workspaceId) return 'workspace_id_mismatch';
  if (pane.terminalId !== expected.terminalId) return 'terminal_id_mismatch';
  if (pane.cwd === null) return 'pane_cwd_missing';
  return pane.cwd === expected.cwd ? null : 'pane_cwd_mismatch';
}

function sampleProcessFacts(processInfo: BootstrapProcessSnapshot): {
  processes: ShellReadinessSample['foreground_processes'];
  truncated: number;
  error: string | null;
} {
  if (!Array.isArray(processInfo.foregroundProcesses))
    return {
      processes: [],
      truncated: 0,
      error: 'foreground_processes_malformed',
    };
  const processes: { pid: number; name: string }[] = [];
  for (const process of processInfo.foregroundProcesses) {
    if (
      !validNumber(process.pid) ||
      typeof process.name !== 'string' ||
      process.name.length === 0
    )
      return {
        processes: [],
        truncated: 0,
        error: 'foreground_process_fact_malformed',
      };
    processes.push({ pid: process.pid, name: normalizedName(process.name) });
  }
  return {
    processes: processes.slice(0, MAX_CAPTURED_PROCESSES),
    truncated: Math.max(0, processes.length - MAX_CAPTURED_PROCESSES),
    error: null,
  };
}

function classifyProcessInfo(processInfo: BootstrapProcessSnapshot): {
  state: ShellSampleState;
  code: string | null;
  shellPid: number | null;
  group: number | null;
  shellName: string | null;
  processes: ShellReadinessSample['foreground_processes'];
  processesTruncated: number;
} {
  const shellPid = processInfo.shellPid;
  const group = processInfo.foregroundProcessGroupId;
  const facts = sampleProcessFacts(processInfo);
  const stateBase = {
    shellPid: validNumber(shellPid) ? shellPid : null,
    group: validNumber(group) ? group : null,
    shellName: null as string | null,
    processes: facts.processes,
    processesTruncated: facts.truncated,
  };
  if (shellPid !== null && !validNumber(shellPid))
    return { ...stateBase, state: 'failed', code: 'shell_pid_malformed' };
  if (group !== null && !validNumber(group))
    return {
      ...stateBase,
      state: 'failed',
      code: 'foreground_group_malformed',
    };
  if (facts.error !== null)
    return { ...stateBase, state: 'failed', code: facts.error };
  if (shellPid === null)
    return { ...stateBase, state: 'unknown', code: 'shell_pid_missing' };
  if (group === null)
    return { ...stateBase, state: 'unknown', code: 'foreground_group_missing' };
  if (group !== shellPid)
    return {
      ...stateBase,
      state: 'not_ready',
      code: 'foreground_group_not_shell',
    };
  if (processInfo.foregroundProcesses.length === 0)
    return {
      ...stateBase,
      state: 'unknown',
      code: 'foreground_processes_empty',
    };
  if (
    processInfo.foregroundProcesses.some((process) => process.pid !== shellPid)
  ) {
    const agent = facts.processes.find((process) =>
      AGENT_NAMES.has(process.name),
    );
    return agent === undefined
      ? { ...stateBase, state: 'not_ready', code: 'extra_foreground_process' }
      : { ...stateBase, state: 'failed', code: `existing_agent:${agent.name}` };
  }
  const shellName = facts.processes[0]?.name ?? null;
  if (shellName === null || !SHELL_NAMES.has(shellName))
    return {
      ...stateBase,
      state: 'not_ready',
      code: 'unrecognized_shell',
      shellName,
    };
  return {
    ...stateBase,
    state: 'ready',
    code: null,
    shellName,
  };
}

/**
 * Verifies the installed Herdr available-shell predicate for one already owned pane.
 * Process readiness is bounded local polling in the caller's single apply operation;
 * it is not an event signal, a model wakeup, or an agent-completion wait.
 */
export async function verifyAvailableShell(
  ops: HerdrBootstrapOps,
  identity: ShellReadinessIdentity,
  options: ShellReadinessOptions = {},
): Promise<ShellReadinessResult> {
  const clock = options.clock ?? Date.now;
  const sleeper =
    options.sleeper ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const shouldAbort = options.shouldAbort ?? (() => false);
  const budgetMs = options.budgetMs ?? SHELL_READINESS_BUDGET_MS;
  const intervalMs = options.intervalMs ?? SHELL_READINESS_INTERVAL_MS;
  const maxSamples = options.maxSamples ?? SHELL_READINESS_MAX_SAMPLES;
  if (
    !Number.isSafeInteger(budgetMs) ||
    budgetMs < 1 ||
    budgetMs > SHELL_READINESS_BUDGET_MS
  )
    return immediateFailure(identity, 'budget_invalid');
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1 ||
    intervalMs > SHELL_READINESS_INTERVAL_MS
  )
    return immediateFailure(identity, 'interval_invalid');
  if (
    !Number.isSafeInteger(maxSamples) ||
    maxSamples < 1 ||
    maxSamples > SHELL_READINESS_MAX_SAMPLES
  )
    return immediateFailure(identity, 'sample_limit_invalid');

  const started = clock();
  const deadline = started + budgetMs;
  let attempts = 0;
  let pinnedShellPid: number | null = null;
  let latest: ShellReadinessSample | null = null;
  const samples: ShellReadinessSample[] = [];

  const result = (
    state: ShellReadinessStatus,
    code: string | null,
    pane: ShellReadinessIdentity,
  ): ShellReadinessResult => ({
    status: state,
    code,
    evidence: {
      state,
      code,
      attempts,
      elapsed_ms: Math.max(0, clock() - started),
      pane_id: pane.paneId,
      workspace_id: pane.workspaceId,
      terminal_id: pane.terminalId,
      cwd: pane.cwd,
      shell_pid: pinnedShellPid ?? latest?.shell_pid ?? null,
      foreground_process_group_id: latest?.foreground_process_group_id ?? null,
      shell_name: latest?.shell_name ?? null,
      last_state: latest?.state ?? 'not_observed',
      last_code: latest?.code ?? null,
      limits: {
        budget_ms: budgetMs,
        interval_ms: intervalMs,
        max_samples: maxSamples,
        samples_truncated: Math.max(0, attempts - samples.length),
      },
      samples: [...samples],
    },
  });
  const recordSample = (sample: ShellReadinessSample) => {
    latest = sample;
    if (samples.length < maxSamples) samples.push(sample);
  };
  const terminal = (
    state: ShellReadinessStatus,
    code: string,
  ): ShellReadinessResult => result(state, code, identity);
  const checkAbort = (): ShellReadinessResult | null =>
    shouldAbort() ? terminal('aborted', 'abort_requested') : null;
  const checkDeadline = (code: string): ShellReadinessResult | null =>
    clock() >= deadline ? terminal('timeout', code) : null;

  const initialAbort = checkAbort();
  if (initialAbort !== null) return initialAbort;
  const beforeDeadline = checkDeadline('deadline_before_identity');
  if (beforeDeadline !== null) return beforeDeadline;
  const initial = await ops.paneGet(
    identity.paneId,
    Math.max(1, deadline - clock()),
  );
  const afterInitialAbort = checkAbort();
  if (afterInitialAbort !== null) return afterInitialAbort;
  const afterInitialDeadline = checkDeadline('deadline_after_initial_identity');
  if (afterInitialDeadline !== null) return afterInitialDeadline;
  if (!initial.ok)
    return terminal(
      initial.status === 'unknown' ? 'unknown' : 'failed',
      `initial_identity:${initial.code}`,
    );
  const initialIdentity = identityCode(initial.value, identity);
  if (initialIdentity !== null) return terminal('failed', initialIdentity);
  if (initial.value.agent !== null) return terminal('failed', 'existing_agent');

  for (;;) {
    const beforeAbort = checkAbort();
    if (beforeAbort !== null) return beforeAbort;
    const beforeSampleDeadline = checkDeadline('deadline_before_process_info');
    if (beforeSampleDeadline !== null) return beforeSampleDeadline;
    if (attempts >= maxSamples)
      return terminal('timeout', 'sample_limit_reached');
    attempts += 1;
    const sampleStart = clock();
    const snapshot = await ops.paneProcessInfo(
      identity.paneId,
      Math.max(1, deadline - clock()),
    );
    const afterSampleAbort = checkAbort();
    if (afterSampleAbort !== null) return afterSampleAbort;
    const afterSampleDeadline = checkDeadline('deadline_after_process_info');
    if (afterSampleDeadline !== null) return afterSampleDeadline;
    if (!snapshot.ok) {
      const status: ShellReadinessStatus =
        snapshot.status === 'unknown' ? 'unknown' : 'failed';
      recordSample({
        elapsed_ms: Math.max(0, sampleStart - started),
        state: status === 'unknown' ? 'unknown' : 'failed',
        code: snapshot.code,
        shell_pid: pinnedShellPid,
        foreground_process_group_id: null,
        shell_name: null,
        foreground_processes: [],
        processes_truncated: 0,
      });
      return terminal(status, `process_info:${snapshot.code}`);
    }
    const processInfo = snapshot.value;
    if (processInfo.paneId !== identity.paneId)
      return terminal('failed', 'pane_id_mismatch');
    const classified = classifyProcessInfo(processInfo);
    if (classified.shellPid !== null) {
      if (pinnedShellPid === null) pinnedShellPid = classified.shellPid;
      else if (pinnedShellPid !== classified.shellPid) {
        recordSample({
          elapsed_ms: Math.max(0, sampleStart - started),
          state: 'failed',
          code: 'shell_incarnation_drift',
          shell_pid: classified.shellPid,
          foreground_process_group_id: classified.group,
          shell_name: classified.shellName,
          foreground_processes: classified.processes,
          processes_truncated: classified.processesTruncated,
        });
        return terminal('failed', 'shell_incarnation_drift');
      }
    }
    const sample: ShellReadinessSample = {
      elapsed_ms: Math.max(0, sampleStart - started),
      state: classified.state,
      code: classified.code,
      shell_pid: classified.shellPid,
      foreground_process_group_id: classified.group,
      shell_name: classified.shellName,
      foreground_processes: classified.processes,
      processes_truncated: classified.processesTruncated,
    };
    recordSample(sample);
    if (classified.state === 'failed')
      return terminal('failed', classified.code ?? 'process_facts_invalid');
    if (classified.state === 'ready') {
      const beforeFinalAbort = checkAbort();
      if (beforeFinalAbort !== null) return beforeFinalAbort;
      const beforeFinalDeadline = checkDeadline(
        'deadline_before_final_identity',
      );
      if (beforeFinalDeadline !== null) return beforeFinalDeadline;
      const finalIdentity = await ops.paneGet(
        identity.paneId,
        Math.max(1, deadline - clock()),
      );
      const afterFinalAbort = checkAbort();
      if (afterFinalAbort !== null) return afterFinalAbort;
      const afterFinalDeadline = checkDeadline('deadline_after_final_identity');
      if (afterFinalDeadline !== null) return afterFinalDeadline;
      if (!finalIdentity.ok)
        return terminal(
          finalIdentity.status === 'unknown' ? 'unknown' : 'failed',
          `final_identity:${finalIdentity.code}`,
        );
      const finalCode = identityCode(finalIdentity.value, identity);
      if (finalCode !== null) return terminal('failed', finalCode);
      if (finalIdentity.value.agent !== null)
        return terminal('failed', 'agent_appeared_before_start');
      return result('ready', null, identity);
    }
    if (attempts >= maxSamples)
      return terminal('timeout', 'sample_limit_reached');
    const remaining = deadline - clock();
    if (remaining <= 0)
      return terminal(
        'timeout',
        classified.state === 'unknown'
          ? 'deadline_unknown'
          : 'deadline_not_ready',
      );
    await sleeper(Math.min(intervalMs, remaining));
    const afterSleepAbort = checkAbort();
    if (afterSleepAbort !== null) return afterSleepAbort;
    const afterSleepDeadline = checkDeadline('deadline_after_wait');
    if (afterSleepDeadline !== null) return afterSleepDeadline;
  }
}

function immediateFailure(
  identity: ShellReadinessIdentity,
  code: string,
): ShellReadinessResult {
  return {
    status: 'failed',
    code,
    evidence: {
      state: 'failed',
      code,
      attempts: 0,
      elapsed_ms: 0,
      pane_id: identity.paneId,
      workspace_id: identity.workspaceId,
      terminal_id: identity.terminalId,
      cwd: identity.cwd,
      shell_pid: null,
      foreground_process_group_id: null,
      shell_name: null,
      last_state: 'not_observed',
      last_code: null,
      limits: {
        budget_ms: 0,
        interval_ms: 0,
        max_samples: 0,
        samples_truncated: 0,
      },
      samples: [],
    },
  };
}
