import { execFile } from 'node:child_process';

/**
 * The few Herdr operations a successor launch needs. Every call is one `herdr` process with an
 * argv (never a shell), a deadline and a bounded output, and every result is a typed value so
 * the launcher can tell "failed" from "unknown". Herdr rewrites single quotes and rejects
 * newlines in `agent start` arguments, so text is only ever delivered with `agent prompt`.
 */
export type HerdrResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: string;
      readonly detail: string;
      /** True when the effect may nevertheless have happened (timeout, killed, bad output). */
      readonly unknown: boolean;
    };

export interface HerdrPane {
  readonly paneId: string;
  readonly cwd: string | null;
  readonly agentName: string | null;
  readonly sessionValue: string | null;
}

export interface HerdrAgent {
  readonly name: string;
  readonly paneId: string;
  readonly status: string;
  readonly cwd: string | null;
  readonly sessionValue: string | null;
  /** Herdr's own "the TUI accepts input" signal; false or null means do not type yet. */
  readonly interactiveReady: boolean | null;
  /** Changes whenever the agent's state changes; used to see that a prompt took effect. */
  readonly stateChangeSeq: number | null;
}

export interface SuccessorHerdrOps {
  paneGet(paneId: string): Promise<HerdrResult<HerdrPane>>;
  /** `false` when no live agent has that name; names are unique among live agents. */
  agentExists(name: string): Promise<HerdrResult<boolean>>;
  splitPane(input: {
    readonly paneId: string;
    readonly cwd: string;
    readonly direction: 'right' | 'down';
  }): Promise<HerdrResult<{ readonly paneId: string }>>;
  startAgent(input: {
    readonly name: string;
    readonly kind: 'claude' | 'codex';
    readonly paneId: string;
    readonly args: readonly string[];
  }): Promise<HerdrResult<HerdrAgent>>;
  getAgent(name: string): Promise<HerdrResult<HerdrAgent>>;
  promptAgent(
    name: string,
    text: string,
  ): Promise<HerdrResult<{ readonly status: string }>>;
}

export type HerdrRunner = (
  argv: readonly string[],
  timeoutMs: number,
) => Promise<{
  readonly code: number | null;
  readonly stdout: string;
  /** Herdr reports a refused request as JSON on stderr with a non-zero exit. */
  readonly stderr: string;
  readonly timedOut: boolean;
}>;

const MAX_OUTPUT_BYTES = 1024 * 1024;

export function defaultRunner(herdrBin = 'herdr'): HerdrRunner {
  return (argv, timeoutMs) =>
    new Promise((resolve) => {
      execFile(
        herdrBin,
        [...argv],
        { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
        (error, stdout, stderr) => {
          const failure = error as
            (NodeJS.ErrnoException & { killed?: boolean }) | null;
          resolve({
            code:
              failure === null
                ? 0
                : typeof failure.code === 'number'
                  ? failure.code
                  : null,
            stdout: typeof stdout === 'string' ? stdout : '',
            stderr: typeof stderr === 'string' ? stderr : '',
            timedOut: failure?.killed === true,
          });
        },
      );
    });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

function parseAgent(value: unknown): HerdrAgent | null {
  if (!isRecord(value)) return null;
  const name = str(value['name']);
  const paneId = str(value['pane_id']);
  if (name === null || paneId === null) return null;
  const session = value['agent_session'];
  return {
    name,
    paneId,
    status: str(value['agent_status']) ?? 'unknown',
    cwd: str(value['cwd']),
    sessionValue: isRecord(session) ? str(session['value']) : null,
    interactiveReady:
      typeof value['interactive_ready'] === 'boolean'
        ? value['interactive_ready']
        : null,
    stateChangeSeq:
      typeof value['state_change_seq'] === 'number'
        ? value['state_change_seq']
        : null,
  };
}

export function createHerdrOps(
  options: { readonly run?: HerdrRunner; readonly timeoutMs?: number } = {},
): SuccessorHerdrOps {
  const run = options.run ?? defaultRunner();
  const timeoutMs = options.timeoutMs ?? 20_000;

  /** One call: JSON envelope in, typed result out. A timeout or garbage is `unknown`. */
  async function call(
    argv: readonly string[],
    deadline = timeoutMs,
  ): Promise<HerdrResult<Record<string, unknown>>> {
    const result = await run(argv, deadline);
    let envelope: unknown;
    try {
      // A success is on stdout; a refusal is on stderr with an empty stdout.
      envelope = JSON.parse(
        result.stdout.trim().length > 0 ? result.stdout : result.stderr,
      );
    } catch {
      return {
        ok: false,
        code: result.timedOut ? 'herdr_timeout' : 'herdr_output_invalid',
        detail: `herdr ${argv[0] ?? ''} ${argv[1] ?? ''} gave no JSON result`,
        unknown: true,
      };
    }
    if (isRecord(envelope) && isRecord(envelope['error'])) {
      const error = envelope['error'];
      return {
        ok: false,
        code: str(error['code']) ?? 'herdr_error',
        detail: (str(error['message']) ?? 'herdr refused the request').slice(
          0,
          300,
        ),
        unknown: false,
      };
    }
    if (isRecord(envelope) && isRecord(envelope['result']))
      return { ok: true, value: envelope['result'] };
    return {
      ok: false,
      code: 'herdr_output_invalid',
      detail: 'herdr returned an unexpected envelope',
      unknown: true,
    };
  }

  const agentOf = (
    result: HerdrResult<Record<string, unknown>>,
    field = 'agent',
  ): HerdrResult<HerdrAgent> => {
    if (!result.ok) return result;
    const agent = parseAgent(result.value[field]);
    return agent === null
      ? {
          ok: false,
          code: 'herdr_output_invalid',
          detail: 'herdr returned no agent',
          unknown: true,
        }
      : { ok: true, value: agent };
  };

  return {
    async paneGet(paneId) {
      const result = await call(['pane', 'get', paneId]);
      if (!result.ok) return result;
      const pane = result.value['pane'];
      if (!isRecord(pane) || str(pane['pane_id']) === null)
        return {
          ok: false,
          code: 'herdr_output_invalid',
          detail: 'herdr returned no pane',
          unknown: false,
        };
      const session = pane['agent_session'];
      return {
        ok: true,
        value: {
          paneId: pane['pane_id'] as string,
          cwd: str(pane['cwd']),
          agentName: str(pane['name']),
          sessionValue: isRecord(session) ? str(session['value']) : null,
        },
      };
    },
    async agentExists(name) {
      const result = await call(['agent', 'get', name]);
      if (result.ok) return { ok: true, value: true };
      return result.code === 'agent_not_found'
        ? { ok: true, value: false }
        : result;
    },
    async splitPane({ paneId, cwd, direction }) {
      const result = await call([
        'pane',
        'split',
        paneId,
        '--direction',
        direction,
        '--cwd',
        cwd,
        '--no-focus',
      ]);
      if (!result.ok) return result;
      const pane = result.value['pane'];
      const id = isRecord(pane) ? str(pane['pane_id']) : null;
      return id === null
        ? {
            ok: false,
            code: 'herdr_output_invalid',
            detail: 'split returned no pane id',
            unknown: true,
          }
        : { ok: true, value: { paneId: id } };
    },
    async startAgent({ name, kind, paneId, args }) {
      return agentOf(
        await call(
          [
            'agent',
            'start',
            name,
            '--kind',
            kind,
            '--pane',
            paneId,
            '--timeout',
            '120000',
            ...(args.length === 0 ? [] : ['--', ...args]),
          ],
          130_000,
        ),
      );
    },
    async getAgent(name) {
      return agentOf(await call(['agent', 'get', name]));
    },
    async promptAgent(name, text) {
      const result = await call(['agent', 'prompt', name, text]);
      if (!result.ok) return result;
      const agent = parseAgent(result.value['agent']);
      return { ok: true, value: { status: agent?.status ?? 'unknown' } };
    },
  };
}
