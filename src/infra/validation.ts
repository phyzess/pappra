/** Decode external JSON as unknown; domain validators establish usable shapes. */
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function errorCode(error: unknown): string | undefined {
  return object(error) && typeof error['code'] === 'string'
    ? error['code']
    : undefined;
}

export function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}
