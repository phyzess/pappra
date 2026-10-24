// Lower-layer recovery configuration contract.
//
// The opt-in Pi recovery bundle is validated here rather than in the
// orchestration layer: `bundle-export` runs inside `src/hosts` and must read,
// validate and pin the exact configuration bytes without importing `src/app`,
// and the adapter that composes the Pi extension reuses this same reader, so
// the format has exactly one definition.
//
// Role and mode are declared structurally. The orchestration layer keeps its own
// enums (`RecoveryRole`, `RecoveryExecutionMode`) and accepts these shapes as-is,
// which is why this module must stay free of application imports.
import path from 'node:path';

import { readBoundedFile } from '../../infra/bounded-file.js';
import type { Identity } from '../../collab/types.js';

export const PI_RECOVERY_CONFIG_SCHEMA = 'pappra/pi-recovery-config/1' as const;

/** Bound for the sibling `recovery.json`; bundle export pins the same limit. */
export const PI_RECOVERY_MAX_CONFIG_BYTES = 64 * 1024;

export type PiRecoveryRole = 'writer' | 'coordinator' | 'reviewer';

export type PiRecoveryMode = 'plan' | 'apply';

export interface PiRecoveryPolicy {
  readonly role: PiRecoveryRole;
  /** When present, only these subtask ids are projected; everything else is ignored. */
  readonly authorizedSubtasks?: readonly string[];
}

export interface PiRecoveryExpected {
  readonly session_id: string;
  readonly cwd: string;
  readonly binding_ref: string;
  readonly binding_digest: string;
  readonly pane_id: string;
  readonly harness: string;
}

export interface PiRecoveryConfig {
  readonly schema: typeof PI_RECOVERY_CONFIG_SCHEMA;
  readonly taskRoot: string;
  readonly planFile: string;
  readonly self: Identity;
  readonly policy: PiRecoveryPolicy;
  readonly expected: PiRecoveryExpected;
  readonly mode: PiRecoveryMode;
  readonly target: { readonly agent: string };
  readonly requestId: string;
}

export type PiRecoveryConfigLoad =
  | {
      readonly ok: true;
      readonly config: PiRecoveryConfig;
      readonly digest: string;
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

function isIdentity(value: unknown): value is Identity {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Identity).agent_id === 'string' &&
    typeof (value as Identity).session_id === 'string' &&
    (typeof (value as Identity).harness === 'string' ||
      (value as Identity).harness === null)
  );
}

/**
 * Strict shape check for one recovery configuration document. Unknown fields are
 * rejected by construction: every accepted field is read explicitly below.
 */
export function validatePiRecoveryConfig(
  parsed: unknown,
): PiRecoveryConfig | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const raw = parsed as Record<string, unknown>;
  if (raw.schema !== PI_RECOVERY_CONFIG_SCHEMA) return null;
  if (typeof raw.taskRoot !== 'string' || typeof raw.planFile !== 'string')
    return null;
  if (!isIdentity(raw.self)) return null;
  const policy = raw.policy as Record<string, unknown> | undefined;
  if (
    typeof policy !== 'object' ||
    policy === null ||
    (policy.role !== 'writer' &&
      policy.role !== 'coordinator' &&
      policy.role !== 'reviewer')
  )
    return null;
  const expected = raw.expected as Record<string, unknown> | undefined;
  if (
    typeof expected !== 'object' ||
    expected === null ||
    Object.keys(expected).sort().join('|') !==
      'binding_digest|binding_ref|cwd|harness|pane_id|session_id' ||
    typeof expected.session_id !== 'string' ||
    expected.session_id.length === 0 ||
    typeof expected.cwd !== 'string' ||
    !path.isAbsolute(expected.cwd) ||
    typeof expected.binding_ref !== 'string' ||
    !path.isAbsolute(expected.binding_ref) ||
    typeof expected.binding_digest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(expected.binding_digest) ||
    typeof expected.pane_id !== 'string' ||
    !/^[A-Za-z0-9]+:p[A-Za-z0-9]+$/.test(expected.pane_id) ||
    typeof expected.harness !== 'string' ||
    expected.harness.length === 0
  )
    return null;
  if (raw.mode !== 'plan' && raw.mode !== 'apply') return null;
  const target = raw.target as Record<string, unknown> | undefined;
  if (
    typeof target !== 'object' ||
    target === null ||
    typeof target.agent !== 'string'
  )
    return null;
  if (typeof raw.requestId !== 'string' || raw.requestId.length === 0)
    return null;
  return {
    schema: PI_RECOVERY_CONFIG_SCHEMA,
    taskRoot: raw.taskRoot,
    planFile: raw.planFile,
    self: {
      agent_id: raw.self.agent_id,
      session_id: raw.self.session_id,
      harness: raw.self.harness,
    },
    policy: {
      role: policy.role,
      ...(Array.isArray(policy.authorizedSubtasks)
        ? { authorizedSubtasks: [...policy.authorizedSubtasks] }
        : {}),
    },
    expected: {
      session_id: expected.session_id,
      cwd: expected.cwd,
      binding_ref: expected.binding_ref,
      binding_digest: expected.binding_digest,
      pane_id: expected.pane_id,
      harness: expected.harness,
    },
    mode: raw.mode,
    target: { agent: target.agent },
    requestId: raw.requestId,
  };
}

/** Read and validate the sibling recovery configuration through the bounded no-follow reader. */
export function readPiRecoveryConfig(file: string): PiRecoveryConfigLoad {
  const read = readBoundedFile(file, PI_RECOVERY_MAX_CONFIG_BYTES);
  if (!read.ok)
    return { ok: false, code: `config_${read.code}`, message: file };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { ok: false, code: 'config_unparseable', message: file };
  }
  const config = validatePiRecoveryConfig(parsed);
  if (config === null)
    return { ok: false, code: 'config_invalid', message: file };
  return { ok: true, config, digest: read.digest };
}
