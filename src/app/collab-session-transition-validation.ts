import crypto from 'node:crypto';
import fs from 'node:fs';

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Primitive guards shared by the session-transition request parser and the
 * orchestrator. They live below both so neither has to import the other's
 * parsing module for a predicate.
 */
export function digestText(bytes: string | Buffer): string {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

export function isText(value: unknown, max = 2048): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !value.includes('\u0000')
  );
}

export function isPositiveInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function isNonNegativeInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

export function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value);
}

export function sameIdentity(
  left:
    | { readonly agent_id?: string | null; readonly session_id?: string | null }
    | null
    | undefined,
  right: { readonly agent_id: string; readonly session_id: string },
): boolean {
  return (
    left !== null &&
    left !== undefined &&
    left.agent_id === right.agent_id &&
    left.session_id === right.session_id
  );
}

export function safePathEqual(left: string, right: string): boolean {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return false;
  }
}
