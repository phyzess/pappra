import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isSafeMessageId } from '../collab/envelope.js';
import { notificationsDir } from '../collab/store.js';
import type { Message, TaskRecord } from '../collab/types.js';
import {
  collabBindingSchema,
  type CollabBinding,
  type CollabBindingParticipant,
  type CollabDelivery,
  type CollabDeliveryAttempt,
  type CollabDeliveryStatus,
} from '../schemas/collaboration.js';
import { isPathInside } from '../schemas/paths.js';
import { observePath, resolveRealpath } from '../infra/fs.js';
import { errorMessage } from '../schemas/outcome.js';
import { routeExclusionFor } from './collab-route.js';
import { resolveTaskManagedPi } from './managed-pi-native-observation.js';
import { requestManagedPiControl } from '../hosts/pi/managed-session.js';
import {
  assertMessageTaskCurrent,
  deliveryPathFor,
  openMessageTask,
  readDeliveryRecord,
  readRegisteredMessageSafe,
  type MessageServiceFailure,
  type MessageServiceResult,
  type OpenedMessageTask,
} from './collab-messages.js';

/**
 * Explicit one-shot notification of an already registered message.
 *
 * Notification is a separate transport operation: persistence happens first and
 * is never implied by it. A successful `herdr agent prompt` means the pointer was
 * submitted, not that the recipient consumed it or that any work was accepted.
 */

const MAX_BINDING_BYTES = 64 * 1024;
const MAX_ATTEMPTS = 3;
const CALLER_TIMEOUT_MS = 10_000;
const HERDR_PANE_ID = /^[A-Za-z0-9]+:p[A-Za-z0-9]+$/;
const LIST_TIMEOUT_MS = 15_000;
const PROMPT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

export interface HerdrAgentObservation {
  readonly nativeIdentityProvenance?: 'owned-pi-sdk-control';
  readonly name: string | null;
  readonly harness: string;
  readonly paneId: string | null;
  readonly cwd: string | null;
  /** Native session evidence as reported by Herdr; often a session file path. */
  readonly sessionValue: string | null;
  /** Reported session kind (`path`, `id`, ...); null when Herdr reports none. */
  readonly sessionKind: string | null;
  readonly status: string;
  readonly focused: boolean;
}

export interface HerdrCallerObservation {
  readonly nativeIdentityProvenance?: 'owned-pi-sdk-control';
  readonly paneId: string;
  readonly workspaceId: string | null;
  readonly tabId: string | null;
  readonly harness: string | null;
  readonly cwd: string | null;
  readonly sessionKind: string | null;
  readonly sessionValue: string | null;
  /** How the routing candidate was selected; not proof of process affiliation. */
  readonly source: 'current' | 'explicit';
}

export type HerdrCallerResult =
  | { readonly ok: true; readonly caller: HerdrCallerObservation }
  | {
      readonly ok: false;
      readonly status: 'unavailable' | 'unverified';
      readonly code: string;
      readonly detail: string;
    };

export interface HerdrPromptResult {
  readonly status:
    'submitted' | 'blocked' | 'refused' | 'unknown' | 'failed' | 'unavailable';
  readonly detail: string | null;
}

export type HerdrListResult =
  | { readonly ok: true; readonly agents: readonly HerdrAgentObservation[] }
  | {
      readonly ok: false;
      readonly status: 'unavailable' | 'failed';
      readonly detail: string;
    };

export interface HerdrTransport {
  readonly id: string;
  /**
   * Resolves the routing candidate before any other agent is inspected. Without
   * `paneId` it requires the inherited caller context; an explicit id is used as
   * supplied and never overrides focus or the environment.
   */
  verifyCaller(options?: {
    readonly paneId?: string;
  }): Promise<HerdrCallerResult>;
  list(): Promise<HerdrListResult>;
  prompt(
    agent: string,
    text: string,
    registered?: {
      readonly taskRoot: string;
      readonly messageId: string;
      readonly digest: string;
      readonly sessionId: string;
    },
  ): Promise<HerdrPromptResult>;
}

export interface CommandResult {
  readonly spawned: boolean;
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly spawnError: string | null;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<CommandResult>;

function runCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      child = spawn(command, [...args], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      finish({
        spawned: false,
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        spawnError: errorMessage(error),
      });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString('utf8');
    });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      finish({
        spawned: false,
        code: null,
        signal: null,
        stdout,
        stderr,
        timedOut,
        spawnError: error.message,
      });
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      finish({
        spawned: true,
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        spawnError: null,
      });
    });
  });
}

/** Shared bounded Herdr command runner for additive bootstrap transport operations. */
export const runHerdrCommand: CommandRunner = runCommand;

function parsedJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nested(value: unknown, key: string): unknown {
  const outer = record(value);
  return outer === null ? undefined : outer[key];
}

function textAt(value: unknown, key: string): string | null {
  const candidate = nested(value, key);
  return typeof candidate === 'string' ? candidate : null;
}

function agentErrorCode(value: unknown): string | null {
  const error =
    nested(value, 'error') ?? nested(nested(value, 'result'), 'error');
  if (typeof error === 'string') return error;
  const code = nested(error, 'code');
  return typeof code === 'string' ? code : null;
}

function agentErrorMessage(value: unknown): string | null {
  const error =
    nested(value, 'error') ?? nested(nested(value, 'result'), 'error');
  if (typeof error === 'string') return error;
  const message = nested(error, 'message');
  return typeof message === 'string' ? message : null;
}

/**
 * Recognized pre-submission refusals. Only codes the installed Herdr CLI is
 * documented/observed to return before accepting a prompt are definite; an
 * unknown code (today or in a future version) stays unknown because a parseable
 * error envelope does not prove the command stopped before submitting.
 */
const RECOGNIZED_REFUSALS = new Set(['agent_not_found']);

function refusalStatus(code: string): HerdrPromptResult {
  if (code === 'agent_blocked') {
    return {
      status: 'blocked',
      detail:
        'the target agent is blocked; a blocked native UI is never auto-answered',
    };
  }
  if (code === 'timeout' || code === 'agent_prompt_stalled') {
    return {
      status: 'unknown',
      detail: `Herdr reported ${code}; submission may have happened`,
    };
  }
  if (RECOGNIZED_REFUSALS.has(code)) {
    return { status: 'refused', detail: `Herdr refused the prompt: ${code}` };
  }
  return {
    status: 'unknown',
    detail: `Herdr returned an unrecognized error code ${code}; submission may have happened`,
  };
}

function sessionField(value: unknown): {
  kind: string | null;
  value: string | null;
} {
  return {
    kind: textAt(value, 'kind'),
    value: textAt(value, 'value'),
  };
}

function callerObservation(
  pane: unknown,
  source: 'current' | 'explicit',
): HerdrCallerObservation | null {
  const paneId = textAt(pane, 'pane_id');
  if (paneId === null) return null;
  const session = sessionField(nested(pane, 'agent_session'));
  return {
    paneId,
    workspaceId: textAt(pane, 'workspace_id'),
    tabId: textAt(pane, 'tab_id'),
    harness: textAt(pane, 'agent'),
    cwd: textAt(pane, 'cwd'),
    sessionKind: session.kind,
    sessionValue: session.value,
    source,
  };
}

/** Default transport: the installed Herdr CLI, argv only, never `--wait`. */
export function createHerdrTransport(
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly run?: CommandRunner;
    readonly taskRoot?: string;
  } = {},
): HerdrTransport {
  const env = options.env ?? process.env;
  const run = options.run ?? runCommand;
  const nativeCaller = async (
    caller: HerdrCallerObservation,
  ): Promise<HerdrCallerObservation> => {
    if (
      !options.taskRoot ||
      caller.sessionValue !== null ||
      (caller.harness !== null && caller.harness !== 'pi')
    )
      return caller;
    const observed = await resolveTaskManagedPi(options.taskRoot, caller, {
      run,
    });
    return observed
      ? {
          ...caller,
          harness: 'pi',
          sessionKind: 'id',
          sessionValue: observed.sessionId,
          nativeIdentityProvenance: observed.provenance,
        }
      : caller;
  };
  const bin =
    typeof env['HERDR_BIN_PATH'] === 'string' &&
    env['HERDR_BIN_PATH'].trim() !== ''
      ? env['HERDR_BIN_PATH']
      : 'herdr';
  return {
    id: 'herdr',
    async verifyCaller(options = {}) {
      if (env['HERDR_ENV'] !== '1') {
        return {
          ok: false,
          status: 'unavailable',
          code: 'not_in_herdr',
          detail:
            'HERDR_ENV is not 1: this process is not inside a verified Herdr caller',
        };
      }
      const explicit = options.paneId;
      if (explicit !== undefined) {
        if (!HERDR_PANE_ID.test(explicit)) {
          return {
            ok: false,
            status: 'unverified',
            code: 'caller_pane_invalid',
            detail: `Invalid caller pane id ${explicit}; expected a value such as w3:p1`,
          };
        }
        const resolved = await run(
          bin,
          ['pane', 'current', '--pane', explicit],
          CALLER_TIMEOUT_MS,
        );
        if (!resolved.spawned) {
          return {
            ok: false,
            status: 'unavailable',
            code: 'herdr_not_callable',
            detail: resolved.spawnError ?? 'Herdr is not callable',
          };
        }
        if (resolved.timedOut) {
          return {
            ok: false,
            status: 'unverified',
            code: 'caller_resolution_timeout',
            detail:
              'Herdr caller pane resolution timed out; no focused pane was used',
          };
        }
        if (resolved.code !== 0) {
          return {
            ok: false,
            status: 'unverified',
            code: 'caller_pane_unavailable',
            detail: `Herdr could not resolve the explicit caller pane ${explicit} (exit ${String(resolved.code)})`,
          };
        }
        const payload = parsedJson(resolved.stdout);
        const caller = callerObservation(
          nested(nested(payload, 'result'), 'pane'),
          'explicit',
        );
        if (caller === null) {
          return {
            ok: false,
            status: 'unverified',
            code: 'caller_unresolved',
            detail: 'Herdr did not report the explicit caller pane',
          };
        }
        if (caller.paneId !== explicit) {
          return {
            ok: false,
            status: 'unverified',
            code: 'caller_pane_mismatch',
            detail: `Herdr reported pane ${caller.paneId} instead of the requested ${explicit}`,
          };
        }
        return { ok: true, caller: await nativeCaller(caller) };
      }
      const envPane = env['HERDR_PANE_ID'];
      if (typeof envPane !== 'string' || envPane.trim() === '') {
        return {
          ok: false,
          status: 'unverified',
          code: 'caller_context_missing',
          detail:
            'Inherited HERDR_PANE_ID is missing; pass --caller-pane <id> from herdr pane list instead of relying on focus',
        };
      }
      if (!HERDR_PANE_ID.test(envPane)) {
        return {
          ok: false,
          status: 'unverified',
          code: 'caller_context_invalid',
          detail: `Inherited HERDR_PANE_ID is not a pane id: ${envPane}`,
        };
      }
      const resolved = await run(
        bin,
        ['pane', 'current', '--current'],
        CALLER_TIMEOUT_MS,
      );
      if (!resolved.spawned) {
        return {
          ok: false,
          status: 'unavailable',
          code: 'herdr_not_callable',
          detail: resolved.spawnError ?? 'Herdr is not callable',
        };
      }
      if (resolved.timedOut) {
        return {
          ok: false,
          status: 'unverified',
          code: 'caller_resolution_timeout',
          detail: 'Herdr caller resolution timed out; no focused pane was used',
        };
      }
      if (resolved.code !== 0) {
        return {
          ok: false,
          status: 'unverified',
          code: 'caller_unresolved',
          detail: `Herdr caller resolution failed (exit ${String(resolved.code)}); pass --caller-pane from herdr pane list if the inherited pane is stale`,
        };
      }
      const payload = parsedJson(resolved.stdout);
      const caller = callerObservation(
        nested(nested(payload, 'result'), 'pane'),
        'current',
      );
      if (caller === null) {
        return {
          ok: false,
          status: 'unverified',
          code: 'caller_unresolved',
          detail: 'Herdr did not report a current caller pane',
        };
      }
      if (caller.paneId !== envPane) {
        return {
          ok: false,
          status: 'unverified',
          code: 'caller_env_mismatch',
          detail: `HERDR_PANE_ID ${envPane} does not match the resolved caller pane ${caller.paneId}`,
        };
      }
      const envWorkspace = env['HERDR_WORKSPACE_ID'];
      if (
        typeof envWorkspace === 'string' &&
        caller.workspaceId !== null &&
        envWorkspace !== caller.workspaceId
      ) {
        return {
          ok: false,
          status: 'unverified',
          code: 'caller_env_mismatch',
          detail: `HERDR_WORKSPACE_ID ${envWorkspace} does not match the resolved caller workspace`,
        };
      }
      return { ok: true, caller: await nativeCaller(caller) };
    },
    async list() {
      const result = await run(bin, ['agent', 'list'], LIST_TIMEOUT_MS);
      if (!result.spawned) {
        return {
          ok: false,
          status: 'unavailable',
          detail: result.spawnError ?? 'Herdr is not callable',
        };
      }
      if (result.timedOut || result.code !== 0) {
        return {
          ok: false,
          status: 'failed',
          detail: `Herdr agent list failed (exit ${String(result.code)}${result.timedOut ? ', timed out' : ''})`,
        };
      }
      const payload = parsedJson(result.stdout);
      const agents = nested(nested(payload, 'result'), 'agents');
      if (!Array.isArray(agents)) {
        return {
          ok: false,
          status: 'failed',
          detail: 'Herdr agent list did not return an agent array',
        };
      }
      const observations: HerdrAgentObservation[] = [];
      for (const entry of agents) {
        const item = record(entry);
        const harness = item?.['agent'];
        if (item === null || typeof harness !== 'string') {
          return {
            ok: false,
            status: 'failed',
            detail: 'Herdr agent list returned a malformed agent entry',
          };
        }
        const session = sessionField(item['agent_session']);
        observations.push({
          name: typeof item['name'] === 'string' ? item['name'] : null,
          harness,
          paneId: typeof item['pane_id'] === 'string' ? item['pane_id'] : null,
          cwd: typeof item['cwd'] === 'string' ? item['cwd'] : null,
          sessionValue: session.value,
          sessionKind: session.kind,
          status:
            typeof item['agent_status'] === 'string'
              ? item['agent_status']
              : 'unknown',
          focused: item['focused'] === true,
        });
      }
      if (options.taskRoot) {
        for (let index = 0; index < observations.length; index++) {
          const entry = observations[index]!;
          if (entry.harness !== 'pi' || entry.sessionValue !== null) continue;
          const observed = await resolveTaskManagedPi(options.taskRoot, entry, {
            run,
          });
          if (observed)
            observations[index] = {
              ...entry,
              sessionKind: 'id',
              sessionValue: observed.sessionId,
              nativeIdentityProvenance: observed.provenance,
            };
        }
      }
      return { ok: true, agents: observations };
    },
    async prompt(agent, text, registered) {
      if (options.taskRoot && registered) {
        const listed = await this.list();
        if (!listed.ok)
          return {
            status: 'refused',
            detail: 'Cannot revalidate native delivery target.',
          };
        const matches = listed.agents.filter((entry) => entry.name === agent);
        if (matches.length !== 1)
          return {
            status: 'refused',
            detail: 'Native delivery target is ambiguous or absent.',
          };
        const target = matches[0]!;
        if (target.nativeIdentityProvenance === 'owned-pi-sdk-control') {
          const owned = await resolveTaskManagedPi(options.taskRoot, target, {
            run,
          });
          if (
            !owned ||
            registered.taskRoot !== options.taskRoot ||
            owned.sessionId !== registered.sessionId
          )
            return {
              status: 'refused',
              detail: 'Owned native delivery identity changed.',
            };
          try {
            const response = await requestManagedPiControl(
              owned.descriptorFile,
              'deliver',
              {
                task_root: registered.taskRoot,
                message_id: registered.messageId,
                digest: registered.digest,
                expected_session_id: registered.sessionId,
              },
            );
            return response.ok === true
              ? {
                  status: 'submitted',
                  detail:
                    'Registered pointer admitted by the owned native SDK; model completion is unobserved.',
                }
              : {
                  status: 'refused',
                  detail:
                    'Owned native controller refused registered delivery.',
                };
          } catch {
            return {
              status: 'unknown',
              detail:
                'Owned native delivery returned no terminal admission result.',
            };
          }
        }
      }
      const result = await run(
        bin,
        ['agent', 'prompt', agent, text],
        PROMPT_TIMEOUT_MS,
      );
      if (!result.spawned) {
        return {
          status: 'unavailable',
          detail: result.spawnError ?? 'Herdr is not callable',
        };
      }
      const payload = parsedJson(result.stdout);
      const type =
        nested(nested(payload, 'result'), 'type') ?? nested(payload, 'type');
      const code = agentErrorCode(payload);
      if (code !== null) {
        const mapped = refusalStatus(code);
        return {
          status: mapped.status,
          detail:
            agentErrorMessage(payload) === null
              ? mapped.detail
              : `${mapped.detail}: ${agentErrorMessage(payload)!}`,
        };
      }
      if (result.timedOut || result.signal !== null) {
        return {
          status: 'unknown',
          detail:
            'Herdr prompt did not return a terminal result; submission may have happened',
        };
      }
      if (result.code === 0 && type === 'agent_prompted') {
        return { status: 'submitted', detail: null };
      }
      // A spawned process that exits without a recognized envelope cannot prove
      // whether the prompt was submitted. Report unknown, never a definite failure.
      return {
        status: 'unknown',
        detail: `Herdr exited ${String(result.code)} without a recognized prompt result; submission may have happened`,
      };
    },
  };
}

/**
 * Derives the native identity Herdr reports. A path is not matched by substring:
 * Pi session files end with `_<session-id>.jsonl`, so only that final segment is
 * the native identity. Other shapes stay unknown unless Herdr reports an id.
 */
export function reportedSessionIdentity(
  kind: string | null,
  value: string | null,
): {
  readonly status: 'match' | 'mismatch' | 'unknown';
  readonly identity: string | null;
} {
  if (value === null || kind === null) {
    return { status: 'unknown', identity: null };
  }
  if (kind === 'path') {
    const base = path.basename(value);
    const stem = base.endsWith('.jsonl')
      ? base.slice(0, -'.jsonl'.length)
      : base;
    const match = /_([^_/\\]+)$/.exec(stem);
    return {
      status: 'match',
      identity: match === null ? stem : match[1]!,
    };
  }
  if (kind === 'id') {
    return { status: 'match', identity: value };
  }
  return { status: 'unknown', identity: null };
}

export interface NotifyOptions {
  readonly taskRoot: string;
  readonly messageId: string;
  readonly bindingFile: string;
  readonly apply: boolean;
  readonly retry: boolean;
  /** Explicit routing candidate for stale inherited context; notify-only. */
  readonly callerPane?: string | null;
  readonly transport?: HerdrTransport;
  readonly clock?: number;
}

export interface NotifyCallerEvidence {
  readonly source: 'current' | 'explicit';
  readonly paneId: string;
  readonly harness: string | null;
  readonly cwd: string | null;
  readonly observedAt: string;
  readonly nativeSession: 'match' | 'unknown';
  readonly nativeSessionKind: string | null;
  /** Pane selection is routing; no process-affiliation proof is claimed. */
  readonly processAffiliation: 'not-established';
}
export interface NotifyTarget {
  readonly herdr_agent: string;
  readonly pane_id: string;
  readonly harness: string;
  readonly cwd: string;
  readonly native_session: 'match' | 'unknown';
  readonly native_session_kind: string | null;
}

export interface NotifyResult {
  readonly status:
    | 'planned'
    | 'submitted'
    | 'blocked'
    | 'refused'
    | 'unknown'
    | 'failed'
    | 'herdr_unavailable'
    | 'herdr_caller_unverified'
    | 'already_recorded'
    | 'in_flight_unknown'
    | 'retry_limit';
  readonly messageId: string;
  readonly messagePath: string;
  readonly messageDigest: string;
  readonly taskId: string;
  readonly recipient: { readonly agent_id: string; readonly harness: string };
  readonly target: NotifyTarget | null;
  readonly caller: NotifyCallerEvidence | null;
  readonly transport: 'herdr' | 'none';
  readonly deliveryPath: string | null;
  readonly attempts: number;
  readonly priorStatus: CollabDeliveryStatus | null;
  readonly detail: string | null;
  /** Notification never proves consumption, execution or acceptance. */
  readonly consumed: false;
  readonly taskAccepted: false;
}

function nowIso(clock: number | undefined): string {
  return new Date(clock ?? Date.now()).toISOString();
}

function controlFree(value: string): boolean {
  return !/[\u0000-\u001f\u007f]/.test(value);
}

function failure(
  code: string,
  message: string,
  nextAction: string | null,
): MessageServiceFailure {
  return { ok: false, code, message, nextAction };
}

function notificationRouteFailure(
  record: TaskRecord,
  message: Message,
): MessageServiceFailure | null {
  for (const [side, identity] of [
    ['sender', message.from],
    ['recipient', message.to],
  ] as const) {
    const route = routeExclusionFor(record, identity);
    if (route.state === 'active') continue;
    if (route.state === 'excluded')
      return failure(
        `${side}_route_excluded`,
        `Message ${side} ${identity.agent_id} is an archived old native identity of succession ${route.exclusion === null ? '<unknown>' : route.exclusion.handoff_id}`,
        'Notify the current successor identity; retained history is never re-routed.',
      );
    return failure(
      'route_exclusion_unknown',
      `Message ${side} route cannot be proven for ${identity.agent_id}: ${route.conflict ?? 'contradictory succession'}`,
      'Repair the succession record; an unproven identity is never notified.',
    );
  }
  return null;
}

async function loadBinding(
  file: string,
  taskRoot: string,
  taskId: string,
): Promise<MessageServiceResult<CollabBinding>> {
  if (!path.isAbsolute(file)) {
    return failure(
      'binding_file_required',
      `--binding requires an absolute file: ${file}`,
      'Write the binding JSON explicitly and pass its absolute path.',
    );
  }
  const absolute = path.resolve(file);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    return failure(
      'binding_unreadable',
      `Cannot read binding ${absolute}: ${errorMessage(error)}`,
      'Write the binding next to the task; nothing was notified.',
    );
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return failure(
      'binding_unsafe',
      `Binding must be a regular file, not a symlink: ${absolute}`,
      'Write the binding to a regular file; links are not followed.',
    );
  }
  if (stat.size > MAX_BINDING_BYTES) {
    return failure(
      'binding_too_large',
      `Binding exceeds ${MAX_BINDING_BYTES} bytes: ${absolute}`,
      'Keep routing metadata small.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    return failure(
      'binding_invalid',
      `Binding is not valid JSON: ${errorMessage(error)}`,
      'Correct the binding; nothing was notified.',
    );
  }
  const validated = collabBindingSchema.safeParse(parsed);
  if (!validated.success) {
    return failure(
      'binding_invalid',
      `Binding failed validation: ${validated.error.issues[0]?.message ?? 'invalid'}`,
      'Use pappra/collab-binding/1; nothing was notified.',
    );
  }
  const binding = validated.data;
  if (binding.task_id !== taskId) {
    return failure(
      'binding_task_mismatch',
      `Binding task_id ${binding.task_id} does not match record ${taskId}`,
      'Bind only the exact task; routing metadata is not authority.',
    );
  }
  const realBindingRoot = await resolveRealpath(binding.task_root);
  if (realBindingRoot === null || realBindingRoot !== taskRoot) {
    return failure(
      'binding_root_mismatch',
      `Binding task_root does not resolve to ${taskRoot}`,
      'Bind the canonical task root; a moved binding must be revalidated.',
    );
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const participant of binding.participants) {
    if (ids.has(participant.agent_id) || names.has(participant.herdr_agent)) {
      return failure(
        'binding_ambiguous',
        'Binding repeats an agent id or Herdr agent name',
        'One participant per identity; ambiguous routing is refused.',
      );
    }
    ids.add(participant.agent_id);
    names.add(participant.herdr_agent);
  }
  return { ok: true, value: binding };
}

function sameCwd(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

export function buildNotificationText(input: {
  readonly taskId: string;
  readonly type: string;
  readonly messagePath: string;
  readonly digest: string;
}): string {
  return `COLLAB_MESSAGE task=${input.taskId} type=${input.type} message=${input.messagePath} digest=${input.digest}`;
}

function notificationsDirectorySyncOk(
  taskRoot: string,
  directory: string,
): boolean {
  try {
    const real = fs.realpathSync(directory);
    return real === directory && isPathInside(taskRoot, real);
  } catch {
    return false;
  }
}

/**
 * Ensures the delivery-metadata directory is a real directory inside the task.
 * The task namespace is revalidated before anything is created.
 */
async function ensureNotificationsDirectory(
  opened: OpenedMessageTask,
): Promise<MessageServiceResult<string>> {
  const directory = notificationsDir(opened.taskRoot);
  const observation = await observePath(directory).catch((error: unknown) =>
    failure(
      'delivery_state_unwritable',
      `Cannot inspect ${directory}: ${errorMessage(error)}`,
      'Inspect task permissions; nothing was notified.',
    ),
  );
  if ('ok' in observation) return observation;
  if (observation.kind !== 'missing') {
    if (
      observation.kind !== 'directory' ||
      !notificationsDirectorySyncOk(opened.taskRoot, directory)
    ) {
      return failure(
        'delivery_state_unsafe',
        `Delivery metadata path is not a real directory inside the task: ${directory}`,
        'Inspect or remove that path; Pappra does not write delivery state through it.',
      );
    }
    return { ok: true, value: directory };
  }
  const changed = await assertMessageTaskCurrent(opened);
  if (changed !== null) return changed;
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    return failure(
      'delivery_state_unwritable',
      `Cannot create ${directory}: ${errorMessage(error)}`,
      'Inspect task permissions; nothing was notified.',
    );
  }
  const created = await observePath(directory).catch((error: unknown) =>
    failure(
      'delivery_state_unwritable',
      `Cannot inspect ${directory}: ${errorMessage(error)}`,
      'Inspect task permissions; nothing was notified.',
    ),
  );
  if ('ok' in created) return created;
  if (
    created.kind !== 'directory' ||
    !notificationsDirectorySyncOk(opened.taskRoot, directory)
  ) {
    return failure(
      'delivery_state_unsafe',
      `Delivery metadata directory is redirected: ${directory}`,
      'Restore a real notifications directory inside the task root.',
    );
  }
  return { ok: true, value: directory };
}

function writeDelivery(
  taskRoot: string,
  directory: string,
  file: string,
  delivery: CollabDelivery,
): void {
  if (!notificationsDirectorySyncOk(taskRoot, directory)) {
    throw new Error(`Delivery metadata directory is unsafe: ${directory}`);
  }
  const temporary = path.join(
    directory,
    `${path.basename(file)}.tmp-${process.pid}-${Date.now()}`,
  );
  const handle = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeSync(handle, `${JSON.stringify(delivery, null, 2)}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, file);
}

function lockPathFor(deliveryFile: string): string {
  return `${deliveryFile}.lock`;
}

function acquireDeliveryLock(lockPath: string): 'acquired' | 'busy' | 'failed' {
  try {
    fs.mkdirSync(lockPath, { mode: 0o700 });
    return 'acquired';
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? error.code
        : null;
    return code === 'EEXIST' ? 'busy' : 'failed';
  }
}

function releaseDeliveryLock(lockPath: string): void {
  try {
    fs.rmdirSync(lockPath);
  } catch {
    // A residual lock stays visible evidence; it is never reclaimed by age.
  }
}

function deliveryDocument(input: {
  readonly message: { readonly message_id: string; readonly task_id: string };
  readonly messagePath: string;
  readonly messageDigest: string;
  readonly taskRoot: string;
  readonly recipient: { readonly agent_id: string; readonly harness: string };
  readonly target: NotifyTarget;
  readonly caller: NotifyCallerEvidence;
  readonly status: CollabDeliveryStatus;
  readonly attempts: readonly CollabDeliveryAttempt[];
  readonly createdAt: string;
  readonly clock: number | undefined;
}): CollabDelivery {
  return {
    schema: 'pappra/collab-delivery/1',
    message_id: input.message.message_id,
    message_path: input.messagePath,
    message_digest: input.messageDigest,
    task_id: input.message.task_id,
    task_root: input.taskRoot,
    recipient: input.recipient,
    target: {
      herdr_agent: input.target.herdr_agent,
      pane_id: input.target.pane_id,
      native_session: input.target.native_session,
      ...(input.target.native_session_kind === null
        ? {}
        : { native_session_kind: input.target.native_session_kind }),
    },
    status: input.status,
    attempts: [...input.attempts],
    caller: {
      source: input.caller.source,
      pane_id: input.caller.paneId,
      harness: input.caller.harness,
      cwd: input.caller.cwd,
      observed_at: input.caller.observedAt,
      native_session: input.caller.nativeSession,
      native_session_kind: input.caller.nativeSessionKind,
      process_affiliation: input.caller.processAffiliation,
    },
    created_at: input.createdAt,
    updated_at: nowIso(input.clock),
  };
}

function resultOf(
  base: {
    readonly message: { readonly message_id: string };
    readonly messagePath: string;
    readonly digest: string;
    readonly taskId: string;
    readonly recipient: { readonly agent_id: string; readonly harness: string };
  },
  fields: {
    readonly status: NotifyResult['status'];
    readonly target: NotifyTarget | null;
    readonly caller: NotifyCallerEvidence | null;
    readonly transport: 'herdr' | 'none';
    readonly deliveryPath: string | null;
    readonly attempts: number;
    readonly priorStatus: CollabDeliveryStatus | null;
    readonly detail: string | null;
  },
): NotifyResult {
  return {
    status: fields.status,
    messageId: base.message.message_id,
    messagePath: base.messagePath,
    messageDigest: base.digest,
    taskId: base.taskId,
    recipient: base.recipient,
    target: fields.target,
    caller: fields.caller,
    transport: fields.transport,
    deliveryPath: fields.deliveryPath,
    attempts: fields.attempts,
    priorStatus: fields.priorStatus,
    detail: fields.detail,
    consumed: false,
    taskAccepted: false,
  };
}

/**
 * Verifies one bound participant against live Herdr observations. Sender and
 * recipient use distinct codes because the two sides carry different obligations.
 */
function verifyLiveParticipant(
  role: 'sender' | 'recipient',
  participant: CollabBindingParticipant,
  expectedSessionId: string,
  agents: readonly HerdrAgentObservation[],
): MessageServiceResult<{
  readonly live: HerdrAgentObservation;
  readonly session: 'match' | 'unknown';
}> {
  const codes =
    role === 'sender'
      ? {
          notFound: 'sender_target_not_found',
          ambiguous: 'sender_target_ambiguous',
          pane: 'sender_pane_mismatch',
          harness: 'sender_harness_mismatch',
          cwd: 'sender_cwd_mismatch',
          session: 'sender_session_mismatch',
        }
      : {
          notFound: 'target_not_found',
          ambiguous: 'target_ambiguous',
          pane: 'target_pane_mismatch',
          harness: 'target_harness_mismatch',
          cwd: 'target_cwd_mismatch',
          session: 'target_session_mismatch',
        };
  const candidates = agents.filter(
    (item) => item.name === participant.herdr_agent,
  );
  if (candidates.length === 0) {
    return failure(
      `${codes.notFound}`,
      `Herdr has no agent named ${participant.herdr_agent}`,
      'Inspect herdr agent list; notification never targets a focused or default pane.',
    );
  }
  if (candidates.length > 1) {
    return failure(
      `${codes.ambiguous}`,
      `Herdr reports more than one agent named ${participant.herdr_agent}`,
      'Resolve the duplicate name explicitly; ambiguous routing is refused.',
    );
  }
  const live = candidates[0]!;
  if (live.paneId !== participant.pane_id) {
    return failure(
      `${codes.pane}`,
      `Herdr reports pane ${String(live.paneId)} for ${participant.herdr_agent}, binding says ${participant.pane_id}`,
      'Revalidate the binding; a stale pane is never used.',
    );
  }
  if (live.harness !== participant.harness) {
    return failure(
      `${codes.harness}`,
      `Herdr reports ${live.harness} for ${participant.herdr_agent}, binding says ${participant.harness}`,
      'Correct the binding; harness identity must match.',
    );
  }
  if (live.cwd === null || !sameCwd(live.cwd, participant.cwd)) {
    return failure(
      `${codes.cwd}`,
      `Herdr reports cwd ${String(live.cwd)} for ${participant.herdr_agent}, binding says ${participant.cwd}`,
      'Correct the binding; cwd identity must match before notification.',
    );
  }
  // An explicit message session is always compared when live evidence exists,
  // even if the binding leaves native_session_id null.
  const reported = reportedSessionIdentity(live.sessionKind, live.sessionValue);
  if (reported.status === 'match') {
    if (reported.identity !== expectedSessionId) {
      return failure(
        `${codes.session}`,
        `Herdr reports native session ${String(reported.identity)} for ${participant.herdr_agent}, message targets ${expectedSessionId}`,
        'Revalidate the binding and message session; mismatched evidence is never notified.',
      );
    }
    return { ok: true, value: { live, session: 'match' } };
  }
  return { ok: true, value: { live, session: 'unknown' } };
}

/**
 * Verifies the caller and recipient against live Herdr metadata and, with apply,
 * sends exactly one pointer-only prompt. Repeating a notification reports the
 * recorded outcome; an in-flight or crashed reservation is never overwritten.
 */
export async function notifyRegisteredMessage(
  options: NotifyOptions,
): Promise<MessageServiceResult<NotifyResult>> {
  const opened = await openMessageTask(options.taskRoot);
  if (!opened.ok) return opened;
  const { taskRoot, record } = opened.value;
  if (!isSafeMessageId(options.messageId)) {
    return failure(
      'message_id_invalid',
      `Unsafe message id: ${options.messageId}`,
      'Use a registered message id from collab message list.',
    );
  }
  const registered = await readRegisteredMessageSafe(
    opened.value,
    options.messageId,
  );
  if (!registered.ok) return registered;
  const message = registered.value.message;
  const messagePath = registered.value.file;
  const digest = registered.value.digest;
  if (!controlFree(messagePath) || !controlFree(digest)) {
    return failure(
      'message_pointer_unsafe',
      'Message path or digest contains control characters',
      'Rename the task root; pointers are sent as one plain line.',
    );
  }
  if (message.task_id !== record.task_id) {
    return failure(
      'message_task_mismatch',
      'Registered message does not belong to this task record',
      'Inspect the task record and message; nothing was notified.',
    );
  }
  if (
    typeof message.to.agent_id !== 'string' ||
    typeof message.to.harness !== 'string'
  ) {
    return failure(
      'message_recipient_missing',
      'Registered message has no explicit recipient',
      'Persist a message with an explicit to identity.',
    );
  }

  const binding = await loadBinding(
    options.bindingFile,
    taskRoot,
    record.task_id,
  );
  if (!binding.ok) return binding;
  const sender = binding.value.participants.find(
    (item) => item.agent_id === message.from.agent_id,
  );
  if (sender === undefined) {
    return failure(
      'binding_sender_missing',
      `Binding has no participant for sender ${message.from.agent_id}`,
      'Bind both the sender and recipient; routing metadata must describe this message.',
    );
  }
  if (sender.harness !== message.from.harness) {
    return failure(
      'binding_sender_mismatch',
      `Binding harness ${sender.harness} does not match message sender ${String(message.from.harness)}`,
      'Correct the binding; sender harness must match the message.',
    );
  }
  if (
    sender.native_session_id !== null &&
    sender.native_session_id !== message.from.session_id
  ) {
    return failure(
      'binding_sender_session_mismatch',
      'Binding native_session_id does not match the message sender session',
      'Bind the exact sender session; sessions are never inferred from names.',
    );
  }
  const participant = binding.value.participants.find(
    (item) => item.agent_id === message.to.agent_id,
  );
  if (participant === undefined) {
    return failure(
      'binding_recipient_missing',
      `Binding has no participant for ${message.to.agent_id}`,
      'Add the exact protocol recipient to the binding; nothing was notified.',
    );
  }
  if (participant.harness !== message.to.harness) {
    return failure(
      'binding_harness_mismatch',
      `Binding harness ${participant.harness} does not match message recipient ${message.to.harness}`,
      'Correct the binding; routing metadata must describe this recipient exactly.',
    );
  }
  if (
    participant.native_session_id !== null &&
    participant.native_session_id !== message.to.session_id
  ) {
    return failure(
      'binding_session_mismatch',
      'Binding native_session_id does not match the message recipient session',
      'Bind the exact protocol session; sessions are never inferred from names.',
    );
  }

  // An archived old native identity is history, never a current route. The succession
  // check is pure current-record evaluation: it happens before any caller or live Herdr
  // query and before any send, and it never rewrites the message or delivery record.
  const initialRouteFailure = notificationRouteFailure(record, message);
  if (initialRouteFailure !== null) return initialRouteFailure;

  // Record files legitimately change inode on any atomic task commit. Recheck
  // the selected message and participants, then evaluate routes from a fresh
  // record, rather than treating an unrelated commit as namespace replacement.
  const assertNotificationCurrent =
    async (): Promise<MessageServiceFailure | null> => {
      const changed = await assertMessageTaskCurrent(opened.value);
      if (changed !== null) return changed;
      const currentBinding = await loadBinding(
        options.bindingFile,
        taskRoot,
        record.task_id,
      );
      if (!currentBinding.ok) return currentBinding;
      for (const expected of [sender, participant]) {
        const current = currentBinding.value.participants.find(
          (item) => item.agent_id === expected.agent_id,
        );
        if (JSON.stringify(current) !== JSON.stringify(expected)) {
          return failure(
            'binding_participant_changed',
            `Notification binding changed for ${expected.agent_id}`,
            'Revalidate the selected sender and recipient bindings; nothing was notified.',
          );
        }
      }
      const reread = await readRegisteredMessageSafe(
        opened.value,
        message.message_id,
      );
      if (!reread.ok) return reread;
      if (reread.value.digest !== digest) {
        return failure(
          'message_registration_changed',
          'Registered message changed while preparing the notification',
          'Inspect the message file; nothing was notified.',
        );
      }
      const current = await openMessageTask(taskRoot);
      if (!current.ok) return current;
      return notificationRouteFailure(current.value.record, message);
    };

  const base = {
    message,
    messagePath,
    digest,
    taskId: record.task_id,
    recipient: {
      agent_id: message.to.agent_id,
      harness: message.to.harness,
    },
  };
  const plannedTarget: NotifyTarget = {
    herdr_agent: participant.herdr_agent,
    pane_id: participant.pane_id,
    harness: participant.harness,
    cwd: participant.cwd,
    native_session: 'unknown',
    native_session_kind: null,
  };

  if (!options.apply) {
    const existing = readDeliveryRecord(taskRoot, message.message_id);
    return {
      ok: true,
      value: resultOf(base, {
        status: 'planned',
        target: plannedTarget,
        caller: null,
        transport: 'none',
        deliveryPath: null,
        attempts: existing?.attempts.length ?? 0,
        priorStatus: existing?.status ?? null,
        detail:
          'Plan only: task, message, sender and recipient bindings validated; caller and live Herdr metadata were not queried.',
      }),
    };
  }

  const transport = options.transport ?? createHerdrTransport({ taskRoot });
  const verifiedCaller = await transport.verifyCaller(
    options.callerPane === undefined || options.callerPane === null
      ? {}
      : { paneId: options.callerPane },
  );
  if (!verifiedCaller.ok) {
    const status =
      verifiedCaller.status === 'unavailable'
        ? 'herdr_unavailable'
        : 'herdr_caller_unverified';
    return {
      ok: true,
      value: resultOf(base, {
        status,
        target: null,
        caller: null,
        transport: 'none',
        deliveryPath: null,
        attempts: 0,
        priorStatus: null,
        detail: `${verifiedCaller.code}: ${verifiedCaller.detail}`,
      }),
    };
  }
  const caller = verifiedCaller.caller;

  const agents = await transport.list();
  if (!agents.ok) {
    return {
      ok: true,
      value: resultOf(base, {
        status:
          agents.status === 'unavailable' ? 'herdr_unavailable' : 'failed',
        target: null,
        caller: null,
        transport: 'herdr',
        deliveryPath: null,
        attempts: 0,
        priorStatus: null,
        detail: agents.detail,
      }),
    };
  }

  // Async seams end here: revalidate the task namespace and the registered bytes
  // before any mutation or native submission.
  const changed = await assertNotificationCurrent();
  if (changed !== null) return changed;

  // The selected routing candidate must be the sender's bound pane. This is a
  // task-bound routing check, not process authentication.
  if (caller.paneId !== sender.pane_id) {
    return failure(
      'caller_pane_mismatch',
      `Selected caller pane ${caller.paneId} does not match the sender binding pane ${sender.pane_id}`,
      'Pass the sender pane explicitly with --caller-pane, or correct the binding; nothing was notified.',
    );
  }
  const senderCheck = verifyLiveParticipant(
    'sender',
    sender,
    message.from.session_id,
    agents.agents,
  );
  if (!senderCheck.ok) return senderCheck;
  const recipientCheck = verifyLiveParticipant(
    'recipient',
    participant,
    message.to.session_id,
    agents.agents,
  );
  if (!recipientCheck.ok) return recipientCheck;

  const callerEvidence: NotifyCallerEvidence = {
    source: caller.source,
    paneId: caller.paneId,
    harness: caller.harness,
    cwd: caller.cwd,
    observedAt: nowIso(options.clock),
    nativeSession: senderCheck.value.session,
    nativeSessionKind: senderCheck.value.live.sessionKind,
    processAffiliation: 'not-established',
  };
  const target: NotifyTarget = {
    ...plannedTarget,
    native_session: recipientCheck.value.session,
    native_session_kind: recipientCheck.value.live.sessionKind,
  };

  const directory = await ensureNotificationsDirectory(opened.value);
  if (!directory.ok) return directory;
  const deliveryFile = deliveryPathFor(taskRoot, message.message_id);
  const lockPath = lockPathFor(deliveryFile);
  const existing = readDeliveryRecord(taskRoot, message.message_id);
  if (fs.existsSync(deliveryFile) && existing === null) {
    return failure(
      'delivery_state_invalid',
      `Delivery metadata exists but is not a valid pappra/collab-delivery/1 document: ${deliveryFile}`,
      'Inspect or remove that file explicitly; Pappra does not overwrite unreadable delivery evidence.',
    );
  }
  const lock = acquireDeliveryLock(lockPath);
  if (lock === 'busy') {
    return {
      ok: true,
      value: resultOf(base, {
        status: 'in_flight_unknown',
        target,
        caller: callerEvidence,
        transport: 'herdr',
        deliveryPath: deliveryFile,
        attempts: existing?.attempts.length ?? 0,
        priorStatus: existing?.status ?? null,
        detail:
          'Another notification for this message is in progress; no new wakeup was sent.',
      }),
    };
  }
  if (lock === 'failed') {
    return failure(
      'delivery_state_unwritable',
      `Cannot reserve delivery metadata: ${lockPath}`,
      'Inspect task permissions; nothing was notified.',
    );
  }
  let reserved: CollabDelivery;
  try {
    const current = readDeliveryRecord(taskRoot, message.message_id);
    if (current !== null && current.status === 'submitting') {
      return {
        ok: true,
        value: resultOf(base, {
          status: 'in_flight_unknown',
          target,
          caller: callerEvidence,
          transport: 'herdr',
          deliveryPath: deliveryFile,
          attempts: current.attempts.length,
          priorStatus: current.status,
          detail:
            'A previous notification is still reserved or its outcome is unknown; it is never resent or reclaimed by age.',
        }),
      };
    }
    if (current !== null && !options.retry) {
      return {
        ok: true,
        value: resultOf(base, {
          status: 'already_recorded',
          target,
          caller: callerEvidence,
          transport: 'herdr',
          deliveryPath: deliveryFile,
          attempts: current.attempts.length,
          priorStatus: current.status,
          detail:
            'A notification outcome is already recorded for this message; no new wakeup was sent.',
        }),
      };
    }
    const attempts = current?.attempts ?? [];
    if (attempts.length >= MAX_ATTEMPTS) {
      return failure(
        'retry_limit',
        `Notification attempts reached the limit of ${MAX_ATTEMPTS}`,
        'Resolve the transport problem explicitly; automatic resend is never performed.',
      );
    }
    const createdAt = current?.created_at ?? nowIso(options.clock);
    const reservationId = randomUUID();
    reserved = deliveryDocument({
      message,
      messagePath,
      messageDigest: digest,
      taskRoot,
      recipient: base.recipient,
      target,
      caller: callerEvidence,
      status: 'submitting',
      attempts: [
        ...attempts,
        {
          at: nowIso(options.clock),
          status: 'submitting',
          detail: null,
          reservation_id: reservationId,
        },
      ],
      createdAt,
      clock: options.clock,
    });
    writeDelivery(taskRoot, directory.value, deliveryFile, reserved);
    reservations.set(deliveryFile, reservationId);
  } catch (error) {
    return failure(
      'delivery_state_unwritable',
      `Cannot record delivery reservation: ${errorMessage(error)}`,
      'Inspect task permissions; nothing was notified.',
    );
  } finally {
    releaseDeliveryLock(lockPath);
  }

  const afterReservation = await assertNotificationCurrent();
  if (afterReservation !== null) {
    finalizeDelivery({
      taskRoot,
      directory: directory.value,
      deliveryFile,
      status: 'failed',
      detail: `Notification changed before submission: ${afterReservation.code}`,
      clock: options.clock,
    });
    return afterReservation;
  }

  const text = buildNotificationText({
    taskId: record.task_id,
    type: message.type,
    messagePath,
    digest,
  });
  let result: HerdrPromptResult;
  try {
    result = await transport.prompt(participant.herdr_agent, text, {
      taskRoot,
      messageId: message.message_id,
      digest,
      sessionId: message.to.session_id,
    });
  } catch (error) {
    result = {
      status: 'unknown',
      detail: `Transport failed after the reservation: ${errorMessage(error)}`,
    };
  }
  // A spawn failure after the reservation means nothing was submitted; record it as
  // `failed`, never as a delivered notification. Ambiguous outcomes stay `unknown`.
  const status: CollabDeliveryStatus =
    result.status === 'unavailable' ? 'failed' : result.status;
  const finalized = finalizeDelivery({
    taskRoot,
    directory: directory.value,
    deliveryFile,
    status,
    detail:
      result.status === 'unavailable'
        ? `Herdr was not callable; nothing was submitted${result.detail === null ? '' : `: ${result.detail}`}`
        : result.detail,
    clock: options.clock,
  });
  if (finalized === null) {
    return {
      ok: true,
      value: resultOf(base, {
        status: 'unknown',
        target,
        caller: callerEvidence,
        transport: 'herdr',
        deliveryPath: deliveryFile,
        attempts: reserved.attempts.length,
        priorStatus: 'submitting',
        detail:
          'The prompt outcome could not be recorded against the reservation; inspect delivery evidence before retrying.',
      }),
    };
  }
  return {
    ok: true,
    value: resultOf(base, {
      status,
      target,
      caller: callerEvidence,
      transport: 'herdr',
      deliveryPath: deliveryFile,
      attempts: finalized.attempts.length,
      priorStatus: existing?.status ?? null,
      detail:
        result.status === 'unavailable'
          ? `Herdr was not callable; nothing was submitted${result.detail === null ? '' : `: ${result.detail}`}`
          : result.detail,
    }),
  };
}

/** Reservation ids are process-local routing for the final update. */
const reservations = new Map<string, string>();

/**
 * Updates only this invocation's reserved attempt. A changed reservation, a lost
 * attempt or an unreadable record is never overwritten; the caller reports an
 * unknown outcome instead.
 */
function finalizeDelivery(input: {
  readonly taskRoot: string;
  readonly directory: string;
  readonly deliveryFile: string;
  readonly status: CollabDeliveryStatus;
  readonly detail: string | null;
  readonly clock: number | undefined;
}): CollabDelivery | null {
  const reservationId = reservations.get(input.deliveryFile);
  if (reservationId === undefined) return null;
  const lockPath = lockPathFor(input.deliveryFile);
  const lock = acquireDeliveryLock(lockPath);
  if (lock !== 'acquired') return null;
  try {
    const current = readDeliveryRecord(
      input.taskRoot,
      path.basename(input.deliveryFile, '.json'),
    );
    if (current === null) return null;
    const index = current.attempts.findIndex(
      (attempt) => attempt.reservation_id === reservationId,
    );
    if (index < 0) return null;
    const attempts = current.attempts.map((attempt, position) =>
      position === index
        ? {
            ...attempt,
            status: input.status,
            detail: input.detail,
          }
        : attempt,
    );
    const next: CollabDelivery = {
      ...current,
      status: input.status,
      attempts,
      updated_at: nowIso(input.clock),
    };
    try {
      writeDelivery(input.taskRoot, input.directory, input.deliveryFile, next);
    } catch {
      return null;
    }
    reservations.delete(input.deliveryFile);
    return next;
  } finally {
    releaseDeliveryLock(lockPath);
  }
}
