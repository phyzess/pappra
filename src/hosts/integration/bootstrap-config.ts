import fs from 'node:fs';
import path from 'node:path';
import { readBoundedFile } from '../../app/bounded-file.js';
import type {
  BootstrapGuardClaim,
  BootstrapGuardIdentity,
} from './pi-bootstrap-guard.js';
import type { BootstrapRuntimeConfig } from './pi-bootstrap-runtime.js';

/**
 * Explicit, trusted local bootstrap binding for the opt-in Pi successor gate.
 *
 * This module only validates and pins data. It never creates directories, reads task
 * records, claims resources or grants authority: exporting a guard is not writing and a
 * valid pre-transfer record stays a valid export input. The accepted guard/runtime remain
 * the authority for gating; this parser mirrors their limits without changing them.
 */

export const PI_BOOTSTRAP_CONFIG_SCHEMA = 'pappra/pi-bootstrap-config/1';
export const MAX_PI_BOOTSTRAP_CONFIG_BYTES = 64 * 1024;

const MAX_ID = 256;
const MAX_DOMAIN_ROOT = 4096;
const MAX_CLAIMS = 1024;
const MAX_REASON = 512;
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface PiBootstrapConfigGuard {
  readonly taskId: string;
  readonly intentId: string;
  readonly handoffId: string;
  readonly generation: number;
  readonly subtaskId: string;
  readonly attempt: number;
  readonly inputRevision: string;
  readonly coordinatorEpoch: number;
  readonly successor: BootstrapGuardIdentity;
  readonly claims: readonly BootstrapGuardClaim[];
}

export interface PiBootstrapConfig {
  readonly schema: typeof PI_BOOTSTRAP_CONFIG_SCHEMA;
  readonly domainRoot: string;
  readonly taskId: string;
  readonly guard: PiBootstrapConfigGuard;
}

export interface PiBootstrapConfigFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

export type PiBootstrapConfigResult =
  | {
      readonly ok: true;
      readonly config: PiBootstrapConfig;
      /** Canonical `<domainRoot>/tasks/<taskId>` directory that must already exist. */
      readonly taskRoot: string;
      /** Digest of the exact bytes that were validated; output generation reuses them. */
      readonly digest: string;
      readonly bytes: Buffer;
    }
  | PiBootstrapConfigFailure;

const failure = (code: string, message: string): PiBootstrapConfigFailure => ({
  ok: false,
  code,
  message,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSafeText = (value: unknown, max = MAX_ID): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !value.includes('\u0000');

const isSafeEpoch = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isSafeRaisableEpoch = (value: unknown): value is number =>
  isSafeEpoch(value) && value < Number.MAX_SAFE_INTEGER;

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === allowed.length && keys.every((key) => allowed.includes(key))
  );
}

function readIdentity(value: unknown): BootstrapGuardIdentity | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['agentId', 'sessionId', 'harness'])
  )
    return null;
  const agentId = value['agentId'];
  const sessionId = value['sessionId'];
  const harness = value['harness'];
  if (
    !isSafeText(agentId, MAX_ID) ||
    !isSafeText(sessionId, MAX_ID) ||
    !isSafeText(harness, MAX_ID)
  )
    return null;
  return { agentId, sessionId, harness };
}

function readClaims(value: unknown): BootstrapGuardClaim[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CLAIMS)
    return null;
  const claims: BootstrapGuardClaim[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !exactKeys(entry, ['claimId', 'originalResourceEpoch'])
    )
      return null;
    const claimId = entry['claimId'];
    const original = entry['originalResourceEpoch'];
    if (!isSafeText(claimId, MAX_ID) || !isSafeRaisableEpoch(original))
      return null;
    if (seen.has(claimId)) return null;
    seen.add(claimId);
    claims.push({ claimId, originalResourceEpoch: original });
  }
  return claims;
}

function readGuard(
  value: unknown,
  taskId: string,
): PiBootstrapConfigGuard | PiBootstrapConfigFailure {
  const keys = [
    'taskId',
    'intentId',
    'handoffId',
    'generation',
    'subtaskId',
    'attempt',
    'inputRevision',
    'coordinatorEpoch',
    'successor',
    'claims',
  ] as const;
  if (!isRecord(value) || !exactKeys(value, keys))
    return failure(
      'config_guard_keys_invalid',
      'guard must contain exactly the pinned identity fields',
    );
  const guardTaskId = value['taskId'];
  const intentId = value['intentId'];
  const handoffId = value['handoffId'];
  const subtaskId = value['subtaskId'];
  const inputRevision = value['inputRevision'];
  const generation = value['generation'];
  const attempt = value['attempt'];
  const coordinatorEpoch = value['coordinatorEpoch'];
  if (
    guardTaskId !== taskId ||
    !isSafeText(intentId, MAX_ID) ||
    !isSafeText(handoffId, MAX_ID) ||
    !isSafeText(subtaskId, MAX_ID) ||
    !isSafeText(inputRevision, MAX_ID)
  )
    return failure(
      'config_guard_invalid',
      'guard taskId must equal the config taskId and every pinned id must be a positive-length short string',
    );
  if (
    !isSafeEpoch(generation) ||
    !isSafeEpoch(attempt) ||
    !isSafeEpoch(coordinatorEpoch)
  )
    return failure(
      'config_guard_epoch_invalid',
      'generation, attempt and coordinatorEpoch must be non-negative safe integers',
    );
  const successor = readIdentity(value['successor']);
  if (successor === null)
    return failure(
      'config_successor_invalid',
      'successor must be an exact {agentId,sessionId,harness} object with short non-empty values',
    );
  const claims = readClaims(value['claims']);
  if (claims === null)
    return failure(
      'config_claims_invalid',
      `claims must be a non-empty set up to ${MAX_CLAIMS} of unique claimId/originalResourceEpoch entries`,
    );
  return {
    taskId,
    intentId,
    handoffId,
    generation,
    subtaskId,
    attempt,
    inputRevision,
    coordinatorEpoch,
    successor,
    claims,
  };
}

function canonicalDirectory(target: string): boolean {
  try {
    if (!fs.lstatSync(target).isDirectory()) return false;
    return fs.realpathSync(target) === target;
  } catch {
    return false;
  }
}

/** Validates one parsed value. Never touches the filesystem except read-only canonical checks. */
function validateValue(parsed: unknown): PiBootstrapConfigResult {
  if (!isRecord(parsed))
    return failure('config_invalid', 'bootstrap config must be a JSON object');
  if (
    !exactKeys(parsed, ['schema', 'domainRoot', 'taskId', 'guard']) ||
    parsed['schema'] !== PI_BOOTSTRAP_CONFIG_SCHEMA
  )
    return failure(
      'config_schema_invalid',
      `bootstrap config must declare exactly schema ${PI_BOOTSTRAP_CONFIG_SCHEMA} plus domainRoot, taskId and guard`,
    );
  const domainRoot = parsed['domainRoot'];
  const taskId = parsed['taskId'];
  if (!isSafeText(domainRoot, MAX_DOMAIN_ROOT) || !path.isAbsolute(domainRoot))
    return failure(
      'config_domain_root_invalid',
      'domainRoot must be an absolute path',
    );
  if (!isSafeText(taskId, 128) || !SAFE_TASK_ID.test(taskId))
    return failure(
      'config_task_id_invalid',
      'taskId must match the short safe task-id pattern',
    );
  if (!canonicalDirectory(domainRoot))
    return failure(
      'config_domain_root_invalid',
      'domainRoot must be an existing canonical directory (no symlink or redirected prefix)',
    );
  const guard = readGuard(parsed['guard'], taskId);
  if ('ok' in guard) return guard;
  const taskRoot = path.join(domainRoot, 'tasks', taskId);
  if (!canonicalDirectory(taskRoot))
    return failure(
      'config_task_root_invalid',
      'the selected task root must already be a canonical directory inside the domain',
    );
  return {
    ok: true,
    config: {
      schema: PI_BOOTSTRAP_CONFIG_SCHEMA,
      domainRoot,
      taskId,
      guard,
    },
    taskRoot,
    digest: '',
    bytes: Buffer.alloc(0),
  };
}

/**
 * Bounded, no-follow read and strict validation of one explicit bootstrap config file.
 * The returned bytes/digest are the pinned copy that output generation must write; the
 * file is never read a second time.
 */
export function readPiBootstrapConfig(file: string): PiBootstrapConfigResult {
  if (!path.isAbsolute(file))
    return failure('config_path_invalid', 'config path must be absolute');
  const read = readBoundedFile(file, MAX_PI_BOOTSTRAP_CONFIG_BYTES);
  if (read.ok === false) {
    const code =
      read.code === 'too_large'
        ? 'config_too_large'
        : read.code === 'symlink'
          ? 'config_symlink_refused'
          : read.code === 'not_regular'
            ? 'config_not_regular'
            : read.code === 'path_not_absolute'
              ? 'config_path_invalid'
              : 'config_unreadable';
    return failure(
      code,
      `bootstrap config must be a bounded (<= ${MAX_PI_BOOTSTRAP_CONFIG_BYTES} bytes) regular file read without following links`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text) as unknown;
  } catch {
    return failure('config_invalid_json', 'bootstrap config is not valid JSON');
  }
  const validated = validateValue(parsed);
  if (validated.ok === false) return validated;
  return { ...validated, digest: read.digest, bytes: read.bytes };
}

/** Maps the validated config onto the accepted runtime registration input. */
export function runtimeConfigOf(
  config: PiBootstrapConfig,
): BootstrapRuntimeConfig {
  return {
    domainRoot: config.domainRoot,
    taskId: config.taskId,
    guard: {
      taskId: config.guard.taskId,
      intentId: config.guard.intentId,
      handoffId: config.guard.handoffId,
      generation: config.guard.generation,
      subtaskId: config.guard.subtaskId,
      attempt: config.guard.attempt,
      inputRevision: config.guard.inputRevision,
      coordinatorEpoch: config.guard.coordinatorEpoch,
      successor: { ...config.guard.successor },
      claims: config.guard.claims.map((claim) => ({ ...claim })),
    },
  };
}

const UNREADABLE_REASON = 'unreadable failure value';

function readableMessage(error: Error): string | null {
  try {
    const message = error.message;
    return typeof message === 'string' ? message : null;
  } catch {
    return null;
  }
}

/**
 * Total formatter for a status reason (never a permission signal). Unknown values, throwing
 * `Error.message` getters, throwing `toString`/`valueOf` and hostile proxies all yield a
 * bounded placeholder instead of escaping the caller.
 */
export function boundedReason(value: unknown): string {
  let text: string | null = null;
  try {
    if (typeof value === 'string') text = value;
    else if (value instanceof Error) text = readableMessage(value) ?? '[error]';
  } catch {
    text = null;
  }
  if (text === null) {
    try {
      text = String(value);
    } catch {
      text = UNREADABLE_REASON;
    }
  }
  const cleaned = text.replaceAll('\u0000', '');
  return cleaned.length > MAX_REASON
    ? `${cleaned.slice(0, MAX_REASON)}…`
    : cleaned;
}
