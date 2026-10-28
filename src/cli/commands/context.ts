import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { observeCodexUsage } from '../../hosts/codex/usage-observer.js';
import { resolveUserDataDir } from '../../install/data-dir.js';
import { shellQuote } from '../../infra/shell-quote.js';
import { getPackageRoot } from '../../package-info.js';
import {
  DEFAULT_ADVISE_PERCENT,
  USAGE_HOSTS,
  adviseHandoff,
  readUsageObservation,
  validSessionId,
  type HandoffAdvice,
  type UsageHost,
  type UsageReadResult,
} from '../../usage/observation.js';
import {
  MAX_CHAIN_BASE64,
  encodeChain,
} from '../../usage/statusline-beacon.js';
import type { CliOutput } from '../output.js';

export { shellQuote };
export const CONTEXT_RESULT_SCHEMA = 'pappra/context-usage-result/1';
export const STATUSLINE_PLAN_SCHEMA = 'pappra/context-statusline-plan/1';

export const contextUsage =
  'pappra context usage --host <claude|codex> --session <id> [--advise-percent <1-99>]\n' +
  '                     [--max-age-seconds <n>] [--json]\n' +
  'pappra context statusline-plan [--project-dir <abs>] [--claude-home <abs>] [--json]\n\n' +
  'usage reports how full a session context window is, as an advisory only: it never starts a\n' +
  'handoff, a model or a checkpoint, and an absent or stale observation is "unavailable", never\n' +
  '"low". statusline-plan is read-only: it prints the exact Claude Code status-line setting that\n' +
  'chains your existing command through the Pappra beacon, and changes no file.';

/** Live Codex read, injected so this module stays free of the transport. */
export type CodexUsageReader = (
  threadId: string,
) => Promise<UsageReadResult | { state: 'unavailable'; reason: string }>;

/** The real reader: one bounded live read from the shared Codex app-server daemon. */
const readCodexLive: CodexUsageReader = async (threadId) => {
  const result = await observeCodexUsage({ threadId });
  return result.state === 'available'
    ? result
    : { state: 'unavailable', reason: result.reason };
};

export interface ContextCliDependencies {
  /** Beacon entry to point the plan at; defaults to this build's compiled entry. */
  readonly beaconEntry?: string;
  readonly platform?: NodeJS.Platform;
  readonly dataDir?: string;
  readonly now?: () => Date;
  readonly readCodex?: CodexUsageReader;
}

interface UsageOptions {
  host: UsageHost | null;
  session: string | null;
  advisePercent: number;
  maxAgeSeconds: number | undefined;
  json: boolean;
  errors: string[];
}

function parseUsage(argv: readonly string[]): UsageOptions {
  const options: UsageOptions = {
    host: null,
    session: null,
    advisePercent: DEFAULT_ADVISE_PERCENT,
    maxAgeSeconds: undefined,
    json: false,
    errors: [],
  };
  const take = (index: number, name: string): string | null => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      options.errors.push(`${name} requires a value.`);
      return null;
    }
    return value;
  };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (
      ![
        '--host',
        '--session',
        '--advise-percent',
        '--max-age-seconds',
      ].includes(arg)
    ) {
      options.errors.push(`unknown option: ${arg}`);
      continue;
    }
    if (seen.has(arg)) options.errors.push(`${arg} may be given only once.`);
    seen.add(arg);
    const value = take(index, arg);
    if (value === null) continue;
    index += 1;
    if (arg === '--host') {
      if (USAGE_HOSTS.includes(value as UsageHost))
        options.host = value as UsageHost;
      else
        options.errors.push(`--host must be one of ${USAGE_HOSTS.join(', ')}.`);
    } else if (arg === '--session') {
      if (validSessionId(value)) options.session = value;
      else options.errors.push('--session must be a plain session id.');
    } else {
      const parsed = Number(value);
      const ok = Number.isInteger(parsed);
      if (arg === '--advise-percent') {
        if (ok && parsed >= 1 && parsed <= 99) options.advisePercent = parsed;
        else
          options.errors.push(
            '--advise-percent must be an integer from 1 to 99.',
          );
      } else if (ok && parsed >= 1 && parsed <= 86_400)
        options.maxAgeSeconds = parsed;
      else
        options.errors.push(
          '--max-age-seconds must be an integer from 1 to 86400.',
        );
    }
  }
  if (options.host === 'codex' && options.maxAgeSeconds !== undefined)
    options.errors.push(
      '--max-age-seconds applies to Claude observations only; a Codex read is live.',
    );
  if (options.host === null) options.errors.push('--host is required.');
  if (options.session === null) options.errors.push('--session is required.');
  return options;
}

function invalid(
  output: CliOutput,
  json: boolean,
  errors: readonly string[],
): number {
  if (json)
    output.stdout(
      `${JSON.stringify({ schema: CONTEXT_RESULT_SCHEMA, ok: false, status: 'invalid', errors })}\n`,
    );
  else {
    output.stdout('Context command invalid.\n');
    for (const error of errors) output.stdout(`  - ${error}\n`);
  }
  return 2;
}

async function runUsage(
  argv: readonly string[],
  output: CliOutput,
  dependencies: ContextCliDependencies,
): Promise<number> {
  const options = parseUsage(argv);
  if (options.errors.length > 0)
    return invalid(output, options.json, options.errors);
  const host = options.host!;
  const session = options.session!;
  const now = dependencies.now?.() ?? new Date();
  let result: UsageReadResult | { state: 'unavailable'; reason: string };
  if (host === 'claude')
    result = readUsageObservation(
      dependencies.dataDir ?? resolveUserDataDir(),
      'claude',
      session,
      {
        now,
        ...(options.maxAgeSeconds === undefined
          ? {}
          : { maxAgeSeconds: options.maxAgeSeconds }),
      },
    );
  else result = await (dependencies.readCodex ?? readCodexLive)(session);
  const advice: HandoffAdvice = adviseHandoff(
    result.state === 'available'
      ? result
      : { state: 'unavailable', reason: 'missing' },
    options.advisePercent,
  );
  const body = {
    schema: CONTEXT_RESULT_SCHEMA,
    ok: result.state === 'available',
    status: result.state,
    host,
    session_id: session,
    usage: result.state === 'available' ? result.observation : null,
    reason: result.state === 'available' ? null : result.reason,
    advice:
      result.state === 'available'
        ? advice
        : { ...advice, reason: result.reason },
    limits: [
      'advisory_only',
      'no_handoff_started',
      host === 'claude' ? 'status_line_beacon_required' : 'live_daemon_read',
    ],
  };
  if (options.json) output.stdout(`${JSON.stringify(body)}\n`);
  else if (result.state === 'available') {
    output.stdout(
      `${host} session ${session}: context ${String(result.observation.used_percent)}% (observed ${result.observation.observed_at}).\n`,
    );
    output.stdout(
      advice.state === 'advised'
        ? `  advised: ${advice.next_action ?? ''}\n`
        : `  below the ${String(options.advisePercent)}% advisory threshold.\n`,
    );
  } else
    output.stdout(
      `${host} session ${session}: usage unavailable (${result.reason}). This is not a low reading.\n`,
    );
  return result.state === 'available' ? 0 : 1;
}

interface StatuslineSetting {
  scope: 'local' | 'project' | 'user';
  file: string;
  value: Record<string, unknown>;
}

function readSettings(
  file: string,
): Record<string, unknown> | 'unreadable' | null {
  if (!existsSync(file)) return null;
  try {
    if (!statSync(file).isFile() || statSync(file).size > 1024 * 1024)
      return 'unreadable';
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

function runStatuslinePlan(
  argv: readonly string[],
  output: CliOutput,
  dependencies: ContextCliDependencies,
): number {
  let projectDir = process.cwd();
  let claudeHome = join(homedir(), '.claude');
  let json = false;
  const errors: string[] = [];
  const seenPaths = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--json') json = true;
    else if (arg === '--project-dir' || arg === '--claude-home') {
      if (seenPaths.has(arg)) errors.push(`${arg} may be given only once.`);
      seenPaths.add(arg);
      const value = argv[index + 1];
      if (value === undefined || !isAbsolute(value))
        errors.push(`${arg} requires an absolute path.`);
      else {
        if (arg === '--project-dir') projectDir = value;
        else claudeHome = value;
        index += 1;
      }
    } else errors.push(`unknown option: ${arg}`);
  }
  if (errors.length > 0) return invalid(output, json, errors);
  // Claude Code resolves the status line from the most specific settings file that sets it.
  const candidates: { scope: StatuslineSetting['scope']; file: string }[] = [
    {
      scope: 'local',
      file: join(projectDir, '.claude', 'settings.local.json'),
    },
    { scope: 'project', file: join(projectDir, '.claude', 'settings.json') },
    { scope: 'user', file: join(claudeHome, 'settings.json') },
  ];
  let current: StatuslineSetting | null = null;
  const blockers: string[] = [];
  for (const candidate of candidates) {
    const settings = readSettings(candidate.file);
    if (settings === 'unreadable') {
      blockers.push(
        `${candidate.file} is unreadable or not a JSON object; nothing is planned.`,
      );
      continue;
    }
    const value = settings?.['statusLine'];
    if (value === undefined) continue;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      blockers.push(
        `${candidate.file} has a statusLine that is not an object.`,
      );
      break;
    }
    current = { ...candidate, value: value as Record<string, unknown> };
    break;
  }
  if (
    current !== null &&
    (current.value['type'] !== 'command' ||
      typeof current.value['command'] !== 'string')
  ) {
    blockers.push(
      `The current statusLine in ${current.file} is not a command; it cannot be chained.`,
    );
  }
  const entry =
    dependencies.beaconEntry ??
    join(getPackageRoot(), 'dist', 'hosts', 'claude', 'statusline-entry.js');
  const chain =
    current !== null && typeof current.value['command'] === 'string'
      ? (current.value['command'] as string)
      : null;
  // Refuse to hand out a snippet that would fail or silently change what the user sees.
  if ((dependencies.platform ?? process.platform) === 'win32')
    blockers.push(
      'The beacon command is quoted for POSIX shells only; it is not offered on Windows.',
    );
  try {
    if (!statSync(entry).isFile()) throw new Error('not a file');
  } catch {
    blockers.push(
      `The beacon entry ${entry} does not exist in this build; build the project first so the status line does not break.`,
    );
  }
  if (chain !== null && encodeChain(chain).length > MAX_CHAIN_BASE64)
    blockers.push(
      `Your current status-line command is longer than the ${String(Math.floor((MAX_CHAIN_BASE64 / 4) * 3))}-byte chain limit; it cannot be chained without being cut.`,
    );
  const proposed =
    blockers.length > 0
      ? null
      : {
          ...(current?.value ?? {}),
          type: 'command',
          command: `node ${shellQuote(entry)}${chain === null ? '' : ` --chain-base64 ${encodeChain(chain)}`}`,
        };
  const target = join(projectDir, '.claude', 'settings.local.json');
  const body = {
    schema: STATUSLINE_PLAN_SCHEMA,
    ok: blockers.length === 0,
    status: blockers.length === 0 ? 'planned' : 'blocked',
    writes: 'none',
    current:
      current === null
        ? null
        : {
            scope: current.scope,
            file: current.file,
            statusLine: current.value,
          },
    chained_command: chain,
    proposed_statusLine: proposed,
    apply_to: target,
    restore:
      'Delete the statusLine key from the file above; the previous setting then applies again. The user-scope file is never edited.',
    beacon_entry: entry,
    blockers,
    limits: [
      'plan_only_no_file_written',
      'beacon_path_is_bound_to_this_checkout_build',
      'records_numbers_only_no_transcript',
    ],
  };
  if (json) output.stdout(`${JSON.stringify(body)}\n`);
  else {
    output.stdout(
      `Status-line beacon plan: ${body.status}. No file was written.\n`,
    );
    for (const blocker of blockers) output.stdout(`  blocker: ${blocker}\n`);
    if (proposed !== null) {
      output.stdout(
        chain === null
          ? '  no existing status line to chain.\n'
          : `  chains your current command (from ${current!.scope} settings):\n    ${chain}\n`,
      );
      output.stdout(
        `  add this to ${target} (private, untracked by convention):\n`,
      );
      output.stdout(`${JSON.stringify({ statusLine: proposed }, null, 2)}\n`);
      output.stdout(`  undo: ${body.restore}\n`);
    }
  }
  return blockers.length === 0 ? 0 : 1;
}

export async function runContextCli(
  argv: readonly string[],
  output: CliOutput,
  dependencies: ContextCliDependencies = {},
): Promise<number> {
  const [action, ...rest] = argv;
  if (action === undefined || action === '--help' || action === '-h') {
    output.stdout(`${contextUsage}\n`);
    return action === undefined ? 2 : 0;
  }
  if (action === 'usage') return runUsage(rest, output, dependencies);
  if (action === 'statusline-plan')
    return runStatuslinePlan(rest, output, dependencies);
  return invalid(output, argv.includes('--json'), [
    `unknown context action: ${action} (expected usage or statusline-plan)`,
  ]);
}
