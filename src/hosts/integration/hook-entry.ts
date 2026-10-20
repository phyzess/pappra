import {
  mapNativeHookEvent,
  readHookInput,
  renderHostHookOutput,
  runHostHook,
} from './hook.js';
import type { HostLifecycleEvent, HostName } from '../../schemas/host.js';
import { hostNameSchema } from '../../schemas/host.js';
import { formatDiagnostic } from '../../schemas/diagnostics.js';

const EVENTS: readonly HostLifecycleEvent[] = [
  'startup',
  'resume',
  'compact',
  'checkpoint-request',
];

function parseEvent(value: string | undefined): HostLifecycleEvent {
  return EVENTS.find((event) => event === value) ?? 'startup';
}

function parseHost(value: string | undefined): HostName | null {
  const parsed = hostNameSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function writeError(message: string): void {
  process.stderr.write(`pappra hook: ${message}\n`);
}

/**
 * Command-hook entrypoint. It reads one bounded event, records only a local
 * observation, and never writes a checkpoint or starts work.
 */
async function main(): Promise<number> {
  const host = parseHost(process.argv[2]);
  if (host === null) {
    writeError('unknown host');
    return 1;
  }
  const fallbackEvent = parseEvent(process.argv[3]);
  const input = await readHookInput(process.stdin, 1024 * 1024, 1000);
  if (!input.ok) {
    if (typeof process.stdin.destroy === 'function') process.stdin.destroy();
    writeError(formatDiagnostic(input.diagnostic));
    process.exit(1);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(input.bytes.toString('utf8'));
  } catch {
    writeError('native hook input is not JSON');
    return 1;
  }
  const mapped = mapNativeHookEvent(host, raw, fallbackEvent, process.cwd());
  if (!mapped.ok) {
    writeError(formatDiagnostic(mapped.diagnostic));
    return mapped.event === null ? 1 : 0;
  }
  const result = await runHostHook(mapped.input);
  if (!result.ok) {
    for (const entry of result.diagnostics) {
      if (typeof entry === 'object' && entry !== null && 'message' in entry) {
        const message = entry['message'];
        if (typeof message === 'string') writeError(message);
      }
    }
    return result.status === 'invalid' || result.status === 'failed' ? 1 : 0;
  }
  const advisory = renderHostHookOutput(host, result);
  if (advisory !== null) process.stdout.write(advisory);
  return 0;
}

const code = await main();
process.exitCode = code;
