import { createHash } from 'node:crypto';

/** Canonicalize the value JSON actually persists, including omitted object keys and array holes. */
export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined)
    throw new TypeError('Canonical JSON requires a JSON-serializable value');
  const persisted: unknown = JSON.parse(serialized);
  return encode(persisted);
}

function encode(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(encode).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${encode(record[key])}`)
    .join(',')}}`;
}

/** Raw SHA-256 hex for contracts that pin canonical JSON rather than insertion order. */
export function canonicalJsonDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
