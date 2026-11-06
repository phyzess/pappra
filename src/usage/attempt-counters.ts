/** Counters from completed native work, with cache reads included exactly once. */
export interface AttemptTokenCounters {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly cache_write_input_tokens: number | null;
  readonly total_tokens: number;
}

function fields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function counters(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number | null,
): AttemptTokenCounters | null {
  const total = input + output;
  if (count(total) === null || cacheRead > input || (cacheWrite ?? 0) > input)
    return null;
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_write_input_tokens: cacheWrite,
    total_tokens: total,
  };
}

/** Codex reports cached reads as a subset of its input counter. */
export function codexAttemptCounters(
  end: unknown,
  before: unknown,
): AttemptTokenCounters | null {
  const endFields = fields(end);
  const beforeFields = fields(before);
  const delta = (key: string): number | null => {
    const last = count(endFields[key]);
    const first = count(beforeFields[key]);
    return last === null || first === null ? null : count(last - first);
  };
  const input = delta('input_tokens');
  const output = delta('output_tokens');
  const read = delta('cached_input_tokens');
  const write = delta('cache_write_input_tokens');
  if (input === null || output === null || read === null) return null;
  if (
    endFields['cache_write_input_tokens'] !== undefined &&
    beforeFields['cache_write_input_tokens'] !== undefined &&
    write === null
  )
    return null;
  return counters(input, output, read, write);
}

/** The Claude terminal result reports cache creation and cache reads separately. */
export function claudeAttemptCounters(
  usage: unknown,
): AttemptTokenCounters | null {
  const native = fields(usage);
  const input = count(native['input_tokens']);
  const output = count(native['output_tokens']);
  const read = count(native['cache_read_input_tokens']);
  const write = count(native['cache_creation_input_tokens']);
  if (input === null || output === null || read === null || write === null)
    return null;
  return counters(input + read + write, output, read, write);
}

/** Sum the attributed Pi usage rows without using a session-lifetime summary. */
export function piAttemptCounters(
  rows: readonly unknown[],
): AttemptTokenCounters | null {
  if (rows.length === 0) return null;
  let input = 0;
  let output = 0;
  let read = 0;
  let write = 0;
  for (const value of rows) {
    const row = fields(value);
    const uncached = count(row['input']);
    const emitted = count(row['output']);
    const cached = count(row['cacheRead']);
    const created = count(row['cacheWrite']);
    if (
      uncached === null ||
      emitted === null ||
      cached === null ||
      created === null
    )
      return null;
    const rowTotal = uncached + emitted + cached + created;
    if (row['totalTokens'] !== undefined && row['totalTokens'] !== rowTotal)
      return null;
    input += uncached + cached + created;
    output += emitted;
    read += cached;
    write += created;
  }
  return counters(input, output, read, write);
}
