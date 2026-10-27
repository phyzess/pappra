import fs from 'node:fs';
import path from 'node:path';
import { readBoundedFile } from '../infra/bounded-file.js';

/**
 * Context-usage observations: how full a host session's context window is.
 *
 * An observation is a bounded, private, numbers-only record keyed by host and session id.
 * It carries no transcript content. It is evidence for an advisory, never an instruction:
 * an absent, stale or malformed observation is `unavailable`, never "low".
 */
export const USAGE_OBSERVATION_SCHEMA = 'pappra/context-usage-observation/1';
export const USAGE_HOSTS = ['claude', 'codex'] as const;
export type UsageHost = (typeof USAGE_HOSTS)[number];
export const USAGE_SOURCES = ['claude-statusline', 'codex-app-server'] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

const MAX_OBSERVATION_BYTES = 16 * 1024;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_MAX_AGE_SECONDS = 600;
const FUTURE_TOLERANCE_MS = 5000;

export interface UsageObservation {
  readonly schema: typeof USAGE_OBSERVATION_SCHEMA;
  readonly host: UsageHost;
  readonly session_id: string;
  readonly observed_at: string;
  /** Share of the context window in use, 0-100, at most one decimal. */
  readonly used_percent: number;
  readonly used_tokens: number | null;
  readonly window_tokens: number | null;
  readonly source: UsageSource;
  readonly host_version: string | null;
}

export type UsageReadResult =
  | { readonly state: 'available'; readonly observation: UsageObservation }
  | {
      readonly state: 'unavailable';
      readonly reason:
        'missing' | 'stale' | 'invalid' | 'unreadable' | 'session_id_invalid';
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const roundTenth = (value: number) => Math.round(value * 10) / 10;

export function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}

function versionOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 64
    ? value
    : null;
}

/**
 * Claude Code status-line payload. `used_percentage` is null until the first response, in
 * which case nothing is observable yet and the result is null rather than 0.
 */
export function parseClaudeStatusline(
  input: unknown,
  now: Date,
): UsageObservation | null {
  if (!isRecord(input) || !validSessionId(input['session_id'])) return null;
  const window = input['context_window'];
  if (!isRecord(window)) return null;
  const percent = window['used_percentage'];
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null;
  if (percent < 0 || percent > 100) return null;
  const size = window['context_window_size'];
  const used = window['total_input_tokens'];
  return {
    schema: USAGE_OBSERVATION_SCHEMA,
    host: 'claude',
    session_id: input['session_id'],
    observed_at: now.toISOString(),
    used_percent: roundTenth(percent),
    used_tokens: isCount(used) ? used : null,
    window_tokens: isCount(size) && size > 0 ? size : null,
    source: 'claude-statusline',
    host_version: versionOrNull(input['version']),
  };
}

/**
 * Codex `thread/tokenUsage/updated` payload. Occupancy is `last.totalTokens` over the model
 * context window; `total` is cumulative spend across calls and must not be used.
 */
export function parseCodexTokenUsage(
  threadId: unknown,
  tokenUsage: unknown,
  now: Date,
  hostVersion: string | null = null,
): UsageObservation | null {
  if (!validSessionId(threadId) || !isRecord(tokenUsage)) return null;
  const last = tokenUsage['last'];
  const window = tokenUsage['modelContextWindow'];
  if (!isRecord(last) || !isCount(last['totalTokens'])) return null;
  if (!isCount(window) || window <= 0) return null;
  const percent = Math.min(100, (last['totalTokens'] / window) * 100);
  return {
    schema: USAGE_OBSERVATION_SCHEMA,
    host: 'codex',
    session_id: threadId,
    observed_at: now.toISOString(),
    used_percent: roundTenth(percent),
    used_tokens: last['totalTokens'],
    window_tokens: window,
    source: 'codex-app-server',
    host_version: versionOrNull(hostVersion),
  };
}

export function usageObservationPath(
  dataDir: string,
  host: UsageHost,
  sessionId: string,
): string {
  return path.join(dataDir, 'context-usage', host, `${sessionId}.json`);
}

function parseObservation(value: unknown): UsageObservation | null {
  if (!isRecord(value)) return null;
  const allowed = [
    'schema',
    'host',
    'session_id',
    'observed_at',
    'used_percent',
    'used_tokens',
    'window_tokens',
    'source',
    'host_version',
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return null;
  if (value['schema'] !== USAGE_OBSERVATION_SCHEMA) return null;
  const host = value['host'];
  const source = value['source'];
  if (!USAGE_HOSTS.includes(host as UsageHost)) return null;
  if (!USAGE_SOURCES.includes(source as UsageSource)) return null;
  if (!validSessionId(value['session_id'])) return null;
  const at = value['observed_at'];
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return null;
  const percent = value['used_percent'];
  if (typeof percent !== 'number' || !(percent >= 0 && percent <= 100))
    return null;
  // Producers round to one decimal; anything finer was not written by Pappra.
  if (Math.abs(percent * 10 - Math.round(percent * 10)) > 1e-6) return null;
  const nullableCount = (item: unknown) => item === null || isCount(item);
  if (!nullableCount(value['used_tokens'])) return null;
  if (!nullableCount(value['window_tokens'])) return null;
  const version = value['host_version'];
  if (version !== null && versionOrNull(version) === null) return null;
  return value as unknown as UsageObservation;
}

/**
 * Atomic private write: a temp file in the same directory, then rename. Refuses a symlinked
 * `context-usage` or host directory so an observation can never be redirected. Throws on
 * failure; callers that must not disturb a host (the status-line beacon) catch it.
 */
export function writeUsageObservation(
  dataDir: string,
  observation: UsageObservation,
): string {
  const file = usageObservationPath(
    dataDir,
    observation.host,
    observation.session_id,
  );
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const part of [path.dirname(directory), directory]) {
    const stat = fs.lstatSync(part);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('usage observation directory is not a real directory');
  }
  const temp = path.join(
    directory,
    `.${observation.session_id}.${process.pid}.${Date.now()}.tmp`,
  );
  const body = `${JSON.stringify(observation)}\n`;
  const handle = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeSync(handle, body);
  } finally {
    fs.closeSync(handle);
  }
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  return file;
}

export function readUsageObservation(
  dataDir: string,
  host: UsageHost,
  sessionId: string,
  options: { readonly now?: Date; readonly maxAgeSeconds?: number } = {},
): UsageReadResult {
  if (!validSessionId(sessionId))
    return { state: 'unavailable', reason: 'session_id_invalid' };
  const file = usageObservationPath(dataDir, host, sessionId);
  // Only a file that is genuinely absent is "missing"; a permission error is "unreadable".
  try {
    fs.lstatSync(file);
  } catch (error) {
    return {
      state: 'unavailable',
      reason:
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'missing'
          : 'unreadable',
    };
  }
  const read = readBoundedFile(file, MAX_OBSERVATION_BYTES);
  if (!read.ok) return { state: 'unavailable', reason: 'unreadable' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { state: 'unavailable', reason: 'invalid' };
  }
  const observation = parseObservation(parsed);
  if (
    observation === null ||
    observation.host !== host ||
    observation.session_id !== sessionId
  )
    return { state: 'unavailable', reason: 'invalid' };
  const now = options.now ?? new Date();
  const maxAge = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  const ageMs = now.getTime() - Date.parse(observation.observed_at);
  // A future-dated observation is as untrustworthy as an old one; a few seconds of skew
  // between the writing and reading process are tolerated.
  if (ageMs < -FUTURE_TOLERANCE_MS || ageMs > maxAge * 1000)
    return { state: 'unavailable', reason: 'stale' };
  return { state: 'available', observation };
}

export interface HandoffAdvice {
  readonly state: 'advised' | 'below_threshold' | 'unavailable';
  readonly threshold_percent: number;
  readonly used_percent: number | null;
  readonly observed_at: string | null;
  readonly reason: string | null;
  readonly next_action: string | null;
}

export const DEFAULT_ADVISE_PERCENT = 70;

/** An advisory only: it never starts a handoff, a model or a checkpoint. */
export function adviseHandoff(
  result: UsageReadResult,
  thresholdPercent: number = DEFAULT_ADVISE_PERCENT,
): HandoffAdvice {
  if (result.state === 'unavailable')
    return {
      state: 'unavailable',
      threshold_percent: thresholdPercent,
      used_percent: null,
      observed_at: null,
      reason: result.reason,
      next_action: null,
    };
  const { observation } = result;
  const advised = observation.used_percent >= thresholdPercent;
  return {
    state: advised ? 'advised' : 'below_threshold',
    threshold_percent: thresholdPercent,
    used_percent: observation.used_percent,
    observed_at: observation.observed_at,
    reason: null,
    next_action: advised
      ? 'Context is filling: finish or accept in-flight work, run `pappra collab handoff check`, and hand the coordinator role to a fresh session at a cohort boundary.'
      : null,
  };
}
