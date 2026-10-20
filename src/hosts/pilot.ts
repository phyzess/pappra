import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import {
  admitLaunch,
  reserveLaunch,
  settleLaunch,
  classifyIdentity,
  TOOL_PROFILES,
  type SettleOptions,
} from '../collab/admission.js';
import { createNonce, nowIso } from '../collab/store.js';
import { sha256File as digestFile } from '../collab/envelope.js';
import { object, parseJson } from '../collab/validation.js';
import { isAssignment } from '../collab/contracts.js';
const PHASES = new Set([
  'discovery',
  'implementation',
  'review',
  'handoff',
  'fix',
]);
export interface PilotOptions {
  harness: 'pi' | 'codex' | 'claude';
  profile: 'writer' | 'reviewer';
  cwd: string;
  promptFile: string;
  evidenceDir: string;
  sessionId?: string | null;
  resume?: string | null;
  timeoutMs?: number;
  maxBudgetUsd?: number;
  outputName?: string | null;
  phase?: string;
  trustProject?: boolean;
  extraDirs?: string[];
  clock?: number;
  assignmentFile: string;
  capabilitiesFile: string;
  taskRoot: string;
  maxAgeMinutes?: number;
  launchKind?: string;
  discovery?: boolean;
}
interface ProcessResult {
  code: number | null;
  error: string | null;
  spawned: boolean;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  startedAt?: string;
}
function buildArgv({
  harness,
  profile,
  cwd,
  prompt,
  sessionId,
  resume,
  maxBudgetUsd,
  sessionDir,
  trustProject = false,
  extraDirs = [],
}: {
  harness: string;
  profile: 'writer' | 'reviewer';
  cwd: string;
  prompt: string;
  sessionId: string | null;
  resume: string | null;
  maxBudgetUsd: number;
  sessionDir: string;
  trustProject?: boolean;
  extraDirs?: string[];
}) {
  if (harness === 'pi') {
    // `--session <id>` continues an existing project session; `--session-id` creates one.
    const argv = [
      '--print',
      '--no-mcp',
      '--session-dir',
      sessionDir,
      '--tools',
      TOOL_PROFILES.pi[profile],
      ...(trustProject ? ['--approve'] : []),
      resume ? '--session' : '--session-id',
      (resume ?? sessionId)!,
      prompt,
    ];
    return { command: 'pi', argv, session_selector: resume ?? sessionId };
  }
  if (harness === 'codex') {
    const sandbox = profile === 'reviewer' ? 'read-only' : 'workspace-write';
    // `codex exec resume` accepts neither -C nor -s: it continues the recorded cwd, so the
    // launcher must still be started in that cwd, and the sandbox is re-asserted as a
    // per-run config override (a sandbox setting, never a model or effort setting).
    const base = resume
      ? [
          'exec',
          'resume',
          resume,
          '--json',
          '--skip-git-repo-check',
          '-c',
          `sandbox_mode="${sandbox}"`,
          prompt,
        ]
      : [
          'exec',
          '--json',
          '-C',
          cwd,
          '-s',
          sandbox,
          '--skip-git-repo-check',
          prompt,
        ];
    return { command: 'codex', argv: base, session_selector: resume ?? null };
  }
  if (harness === 'claude') {
    // `--permission-mode acceptEdits` is required in --print mode: without it an edit tool
    // call has nobody to prompt and is denied. The reviewer profile keeps the default mode
    // so a review cannot silently write.
    const argv = [
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      ...(profile === 'writer' ? ['--permission-mode', 'acceptEdits'] : []),
      // `user,project` keeps the user settings and also lets project-scoped skills resolve;
      // the isolated fixture ships no project settings file.
      '--setting-sources',
      'user,project',
      ...extraDirs.flatMap((directory) => ['--add-dir', directory]),
      '--add-dir',
      cwd,
      '--tools',
      TOOL_PROFILES.claude[profile],
      '--mcp-config',
      '{"mcpServers":{}}',
      '--strict-mcp-config',
      '--settings',
      '{"disableAllHooks":true}',
      '--max-budget-usd',
      String(maxBudgetUsd),
      resume ? '--resume' : '--session-id',
      (resume ?? sessionId)!,
      prompt,
    ];
    return { command: 'claude', argv, session_selector: resume ?? sessionId };
  }
  throw new Error(`Unsupported harness: ${harness}`);
}

function runProcess({
  command,
  argv,
  cwd,
  timeoutMs,
}: {
  command: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
}): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve) => {
    const child = spawn(command, argv, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        code: null,
        error: error instanceof Error ? error.message : String(error),
        spawned: false,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        timedOut,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        error: null,
        spawned: true,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        timedOut,
      });
    });
  });
}

/** Read the native session id from a saved Claude stream (system/init). */
export function readClaudeSessionId(file: string) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const row = parseJson(trimmed);
      if (
        object(row) &&
        row.type === 'system' &&
        row.subtype === 'init' &&
        typeof row.session_id === 'string'
      )
        return row.session_id;
    }
  } catch {
    return null;
  }
  return null;
}

/** Read the native session id from a saved Pi session file. */
export function readPiSessionId(file: string) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const row = parseJson(trimmed);
      if (object(row) && row.type === 'session' && typeof row.id === 'string')
        return row.id;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Record the size/mtime of every Pi session file before a run starts, so a later lookup can
 * tell which files this invocation actually created or changed.
 */
function snapshotPiSessions(sessionDir: string) {
  const snapshot = new Map<string, { size: number; mtimeMs: number }>();
  let names = [];
  try {
    names = fs
      .readdirSync(sessionDir)
      .filter((name) => name.endsWith('.jsonl'));
  } catch {
    return snapshot;
  }
  for (const name of names) {
    try {
      const stat = fs.statSync(path.join(sessionDir, name));
      snapshot.set(name, { size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // A file that disappears during the snapshot is simply absent from the baseline.
    }
  }
  return snapshot;
}

/**
 * Find the native session file this invocation produced.
 *
 * Only a file that was created or changed after the baseline may count, and its header must
 * carry the requested id. An unrelated pre-existing file (or an old file this failed
 * invocation never touched) is never attributed to the run; a wrong attribution would be
 * worse than reporting no observed identity.
 */
function findPiSession(
  sessionDir: string,
  sessionId: string,
  baseline = new Map<string, { size: number; mtimeMs: number }>(),
) {
  let names = [];
  try {
    names = fs
      .readdirSync(sessionDir)
      .filter((name) => name.endsWith('.jsonl'));
  } catch {
    return null;
  }
  const candidates = [];
  for (const name of names) {
    const file = path.join(sessionDir, name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    const before = baseline.get(name);
    if (before && before.size === stat.size && before.mtimeMs === stat.mtimeMs)
      continue;
    if (readPiSessionId(file) !== sessionId) continue;
    candidates.push({ file, mtimeMs: stat.mtimeMs });
  }
  if (!candidates.length) return null;
  candidates.sort((left, right) => left.mtimeMs - right.mtimeMs);
  return candidates.at(-1)!.file;
}

function readCodexThread(eventsFile: string) {
  try {
    for (const line of fs.readFileSync(eventsFile, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const row = parseJson(trimmed);
      if (
        object(row) &&
        row.type === 'thread.started' &&
        typeof row.thread_id === 'string'
      )
        return row.thread_id;
    }
  } catch {
    return null;
  }
  return null;
}

export async function runNativePilot({
  harness,
  profile,
  cwd,
  promptFile,
  evidenceDir,
  sessionId = null,
  resume = null,
  timeoutMs = 300000,
  maxBudgetUsd = 1,
  outputName = null,
  phase = 'discovery',
  trustProject = false,
  extraDirs = [],
  clock = Date.now(),
  assignmentFile,
  capabilitiesFile,
  taskRoot,
  maxAgeMinutes = 30,
  launchKind = 'first',
  discovery = false,
}: PilotOptions) {
  if (!['pi', 'codex', 'claude'].includes(harness))
    throw new Error('Unsupported harness');
  if (!['writer', 'reviewer'].includes(profile))
    throw new Error('Unsupported profile');
  if (!path.isAbsolute(cwd ?? '') || !fs.statSync(cwd).isDirectory())
    throw new Error('cwd must be an existing absolute directory');
  if (!path.isAbsolute(promptFile ?? '') || !fs.statSync(promptFile).isFile())
    throw new Error('prompt-file must be an absolute existing file');
  if (!path.isAbsolute(evidenceDir ?? ''))
    throw new Error('evidence-dir must be an absolute path');
  if (!PHASES.has(phase)) throw new Error('Unsupported phase');
  const id =
    sessionId ??
    resume ??
    (harness === 'claude' || harness === 'pi' ? crypto.randomUUID() : null);
  if (harness !== 'codex' && !id)
    throw new Error('pi and claude need a session id');
  if (
    !path.isAbsolute(assignmentFile ?? '') ||
    !path.isAbsolute(capabilitiesFile ?? '')
  ) {
    throw new Error(
      'The launcher requires --assignment and --capabilities: a native process is never started without a capability preflight',
    );
  }
  const assignmentForLaunch = parseJson(
    fs.readFileSync(assignmentFile, 'utf8'),
  );
  if (!isAssignment(assignmentForLaunch))
    throw new Error('Invalid assignment structure');
  const effectiveLaunchKind = resume ? 'resume' : launchKind;
  if (effectiveLaunchKind === 'resume' && !resume)
    throw new Error(
      'A resume launch needs the recorded native session via --resume',
    );
  if (effectiveLaunchKind !== 'resume' && resume)
    throw new Error('A first launch must not carry a resume selector');

  // Everything that can fail is validated BEFORE the reservation exists, so a validation error
  // never leaves a dangling reservation behind.
  const prompt = fs.readFileSync(promptFile, 'utf8');
  if (prompt.length > 20000)
    throw new Error('Prompt is too large for a bounded pilot run');
  // Frozen before the process starts: a child that deletes or rewrites these files must not be
  // able to break the post-run bookkeeping.
  const frozenPrompt = { bytes: prompt, digest: digestFile(promptFile) };
  const frozenCapabilities = {
    file: capabilitiesFile,
    digest: digestFile(capabilitiesFile),
  };
  for (const directory of extraDirs) {
    if (!path.isAbsolute(directory) || !fs.statSync(directory).isDirectory())
      throw new Error(
        `extra --add-dir path must be an existing absolute directory: ${directory}`,
      );
  }
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const name =
    outputName ?? `${harness}-${profile}-${resume ? 'resume' : 'new'}`;
  const eventsFile = path.join(evidenceDir, `${name}.events.jsonl`);
  const stdoutFile = path.join(evidenceDir, `${name}.stdout.log`);
  const stderrFile = path.join(evidenceDir, `${name}.stderr.log`);
  const executionFile = path.join(evidenceDir, `${name}.execution.json`);
  for (const file of [eventsFile, stdoutFile, stderrFile, executionFile]) {
    if (fs.existsSync(file))
      throw new Error(`Evidence file already exists: ${file}`);
  }
  // A resumed Pi session is looked up inside this directory. Changing the evidence directory
  // is not native session migration: a resume caller must preserve the original session
  // directory, otherwise Pi reports no matching session and no new evidence is attributable.
  const piSessionDir = path.join(evidenceDir, 'pi-sessions');
  fs.mkdirSync(piSessionDir, { recursive: true, mode: 0o700 });

  const built = buildArgv({
    harness,
    profile,
    cwd,
    prompt,
    sessionId: id,
    resume,
    maxBudgetUsd,
    sessionDir: piSessionDir,
    trustProject,
    extraDirs,
  });

  const admission = admitLaunch({
    assignmentFile,
    capabilitiesFile,
    taskRoot,
    cwd,
    sessionId: resume ?? id,
    harness,
    profile,
    launchKind: effectiveLaunchKind,
    resumeSelector: resume,
    discovery,
    now: clock,
    maxAgeMinutes,
  });
  if (!admission.ok)
    return { refused: true, admission, reason: admission.reason };
  const reservation = reserveLaunch(taskRoot, {
    expectRevision: admission.state_revision,
    clock,
    reservation: {
      reservation_id: `launch-${createNonce()}`,
      subtask_id: assignmentForLaunch.assignment_id,
      attempt: assignmentForLaunch.attempt,
      kind: effectiveLaunchKind,
      mode: admission.mode,
      phase,
      holder: assignmentForLaunch.assignee,
      pid: process.pid,
      hostname: os.hostname(),
      requested_session_id: resume ?? id,
      resume_selector: resume ?? null,
    },
  });
  if (!reservation.ok)
    return {
      refused: true,
      admission,
      reason: reservation.reason,
      reservation,
    };

  const settle = (
    outcome: string,
    extra: Partial<Omit<SettleOptions, 'reservationId' | 'outcome'>> = {},
  ) =>
    settleLaunch(taskRoot, {
      reservationId: reservation.reservation_id,
      outcome,
      runner: assignmentForLaunch.runner?.name ?? null,
      detail: extra.detail ?? null,
      ...extra,
    });

  // Frozen before the process starts, so only evidence this invocation created or changed can
  // later be attributed to it.
  const sessionBaseline =
    harness === 'pi' ? snapshotPiSessions(piSessionDir) : new Map();

  let result: ProcessResult;
  let startedAt;
  let wallMs;
  try {
    startedAt = nowIso(clock);
    const started = Date.now();
    result = await runProcess({
      command: built.command,
      argv: built.argv,
      cwd,
      timeoutMs,
    });
    startedAt = result.startedAt ?? startedAt;
    wallMs = Date.now() - started;
  } catch (error) {
    // The process never spawned: release the reservation and leave the attempt untouched.
    settle('not_started', {
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  const finishedAt = nowIso();
  const isStream = harness !== 'pi';
  let nativeEvidence: string | null = null;
  let nativeSessionId: string | null = null;
  try {
    fs.writeFileSync(isStream ? eventsFile : stdoutFile, result.stdout, {
      flag: 'wx',
      mode: 0o600,
    });
    fs.writeFileSync(stderrFile, result.stderr, { flag: 'wx', mode: 0o600 });
    if (harness === 'codex') {
      nativeEvidence = eventsFile;
      nativeSessionId = readCodexThread(eventsFile);
    } else if (harness === 'pi') {
      // Only a session file this invocation created or changed may be observed. A continued Pi
      // session appends to its original file, which makes that file attributable; an unrelated
      // or untouched file is never used to confirm the launch.
      nativeEvidence = findPiSession(
        piSessionDir,
        (resume ?? id)!,
        sessionBaseline,
      );
      nativeSessionId = nativeEvidence ? readPiSessionId(nativeEvidence) : null;
    } else {
      nativeEvidence = eventsFile;
      nativeSessionId = readClaudeSessionId(eventsFile);
    }
  } catch (error) {
    const settlement = settle('evidence_write_failed', {
      exitCode: result.code ?? null,
      sessionId: null,
      runId: `${name}:${startedAt}`,
      evidenceRef: null,
      expectedIdentity: admission.expected_identity,
      capabilityEvidence: admission.capability_evidence,
      detail: error instanceof Error ? error.message : String(error),
    });
    // No execution record was written, but the process did run: keep its metadata so the caller
    // can still see what actually happened.
    return {
      execution: null,
      evidenceError: error instanceof Error ? error.message : String(error),
      settlement,
      process: {
        status: result.error
          ? 'spawn_failed'
          : result.timedOut
            ? 'timed_out'
            : 'exited',
        exit_code: result.code ?? null,
        spawned: result.spawned === true,
        timed_out: result.timedOut === true,
        started_at: startedAt,
        finished_at: finishedAt,
        wall_ms: wallMs,
      },
    };
  }

  const settledOutcome = result.error
    ? 'spawn_failed'
    : result.timedOut
      ? 'timed_out'
      : result.code === 0
        ? 'exited'
        : 'exited_nonzero';
  let execution: Record<string, unknown> | null = null;
  try {
    const identity = classifyIdentity({
      ran: settledOutcome === 'exited' || settledOutcome === 'exited_nonzero',
      observed: nativeSessionId,
      expected: admission.expected_identity,
      capabilityEvidence: admission.capability_evidence,
    });
    execution = {
      schema: 'harness-collab/native-execution/1',
      harness,
      profile,
      phase,
      status: result.error
        ? 'spawn_failed'
        : result.timedOut
          ? 'timed_out'
          : 'exited',
      exit_code: result.code,
      spawn_error: result.error,
      timed_out: result.timedOut,
      started_at: startedAt,
      finished_at: finishedAt,
      wall_ms: wallMs,
      cwd,
      // The identity actually observed in native evidence; `requested_session_id` is what the
      // launcher asked for and is never treated as an observation.
      session_id: nativeSessionId,
      requested_session_id: id,
      resumed_from: resume,
      identity_status: identity.status,
      // A nonzero exit still records the run and its identity, but the observation is not
      // confirmed: only a clean exit can back a runtime capability claim.
      identity_confirmed: identity.confirmed && settledOutcome === 'exited',
      argv_summary: built.argv.map((token) =>
        token.length > 120 ? `${token.slice(0, 117)}...` : token,
      ),
      tool_allowlist:
        harness === 'pi'
          ? TOOL_PROFILES.pi[profile]
          : harness === 'claude'
            ? TOOL_PROFILES.claude[profile]
            : null,
      sandbox:
        harness === 'codex'
          ? profile === 'reviewer'
            ? 'read-only'
            : 'workspace-write'
          : null,
      limits: {
        timeout_ms: timeoutMs,
        max_budget_usd: harness === 'claude' ? maxBudgetUsd : null,
        model_override: null,
        effort_override: null,
      },
      project_trust:
        harness === 'pi'
          ? trustProject
            ? 'approved-for-this-run'
            : 'not-approved'
          : 'host-default',
      extra_dirs: extraDirs,
      native_evidence: nativeEvidence,
      events_file: isStream ? eventsFile : null,
      stdout_file: isStream ? null : stdoutFile,
      stderr_file: stderrFile,
      prompt_file: promptFile,
      prompt_digest: frozenPrompt.digest,
      admission: {
        assignment_file: assignmentFile,
        assignment_digest: admission.assignment_digest,
        capabilities_file: frozenCapabilities.file,
        capabilities_digest: frozenCapabilities.digest,
        task_root: taskRoot,
        max_age_minutes: maxAgeMinutes,
        mode: admission.mode,
        launch_kind: admission.launch_kind,
        resume_selector: admission.resume_selector,
        resources: admission.resources,
        reservation_id: reservation.reservation_id,
        checks: admission.checks,
      },
      // The authoritative outcome of the launch lives in the task record's launch_reservations;
      // this file is the evidence it points at.
      planned_outcome: settledOutcome,
    };
    // The record must exist before the settlement points at it.
    fs.writeFileSync(executionFile, `${JSON.stringify(execution, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    // Anything that fails after the process ran — reading the identity back, writing the native
    // streams, or building and writing this record — shares one settlement, so the fact that it
    // ran is on record as an uncertain execution instead of a silently stuck reservation.
    const settlement = settle('evidence_write_failed', {
      exitCode: result.code ?? null,
      sessionId: nativeSessionId,
      runId: `${name}:${startedAt}`,
      evidenceRef: null,
      expectedIdentity: admission.expected_identity,
      capabilityEvidence: admission.capability_evidence,
      detail: error instanceof Error ? error.message : String(error),
    });
    return {
      execution,
      evidenceError: error instanceof Error ? error.message : String(error),
      settlement,
    };
  }
  const settlement = settle(settledOutcome, {
    exitCode: result.code,
    sessionId: nativeSessionId,
    runId: `${name}:${startedAt}`,
    evidenceRef: executionFile,
    expectedIdentity: admission.expected_identity,
    capabilityEvidence: admission.capability_evidence,
    detail: result.error ?? null,
  });
  return {
    execution,
    executionFile,
    eventsFile,
    stdoutFile,
    stderrFile,
    nativeEvidence,
    reservation_id: reservation.reservation_id,
    settlement,
  };
}
