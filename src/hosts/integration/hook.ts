import { randomUUID } from 'node:crypto';
import { link, mkdir, open, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Diagnostic } from '../../schemas/diagnostics.js';
import { createDiagnostic } from '../../schemas/diagnostics.js';
import { diagnosticCodes } from '../../schemas/errors.js';
import type {
  HostHookInput,
  HostHookResult,
  HostLifecycleEvent,
  HostName,
} from '../../schemas/host.js';
import {
  HOST_HOOK_INPUT_SCHEMA,
  commandHookEventSchema,
  hostHookInputSchema,
  hostHookResultSchema,
} from '../../schemas/host.js';
import {
  observePath,
  readFileBounded,
  resolveRealpath,
  sha256Digest,
} from '../../infra/fs.js';
import { isPathInside } from '../../schemas/paths.js';
import { ensurePrivateState } from '../../infra/private-state.js';
import { resolveWorkspaceRoot } from '../../workspace/resolve.js';
import {
  inspectMachineConfig,
  loadWorkspaceConfig,
} from '../../workspace/config.js';
import { CheckpointService } from '../../continuity/service.js';
import { ensureStatePathBoundary } from '../../install/ownership.js';
import { readAutoResume, readTaskPin } from '../../app/task-pin.js';
import { nativeEventFor } from './support.js';

const DEFAULT_MAX_INPUT_BYTES = 1024 * 1024;
const DEFAULT_DEADLINE_MS = 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024;

function diagnostic(
  code: (typeof diagnosticCodes)[keyof typeof diagnosticCodes],
  message: string,
  source: string,
  hint: string,
): Diagnostic {
  return createDiagnostic({
    code,
    severity: 'error',
    message,
    source,
    hint,
  });
}

function result(input: {
  readonly ok: boolean;
  readonly status: HostHookResult['status'];
  readonly host: HostName | null;
  readonly event: HostLifecycleEvent | null;
  readonly eventKey: string | null;
  readonly duplicate: boolean;
  readonly context: string | null;
  readonly diagnostics: readonly Diagnostic[];
}): HostHookResult {
  return hostHookResultSchema.parse({
    schema: 'pappra/host-hook-result/1',
    ok: input.ok,
    status: input.status,
    host: input.host,
    event: input.event,
    eventKey: input.eventKey,
    duplicate: input.duplicate,
    context: input.context,
    diagnostics: input.diagnostics,
  });
}
export function renderHostHookOutput(
  host: HostName,
  result: HostHookResult,
): string | null {
  if (result.context === null || result.event === null) return null;
  const context =
    result.context.length > 8000
      ? `${result.context.slice(0, 7997)}...`
      : result.context;
  if (host === 'claude' || host === 'codex') {
    const native = nativeEventFor(host, result.event);
    if (native === null) return null;
    return `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: native,
        additionalContext: context,
      },
    })}\n`;
  }
  return null;
}

function cwdInside(root: string, cwd: string): boolean {
  return isPathInside(root, cwd);
}

async function canonicalEqual(left: string, right: string): Promise<boolean> {
  const [realLeft, realRight] = await Promise.all([
    resolveRealpath(left),
    resolveRealpath(right),
  ]);
  return realLeft !== null && realRight !== null && realLeft === realRight;
}
async function privateSegmentsSafe(
  root: string,
  directory: string,
): Promise<boolean> {
  const rel = relative(root, directory);
  if (rel === '') return true;
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    return false;
  }
  let current = root;
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    const observed = await observePath(current);
    if (observed.kind === 'missing') return true;
    if (observed.kind !== 'directory') return false;
  }
  return true;
}

async function boundedAdvisory(
  root: string,
  event: HostLifecycleEvent,
  taskId: string | null,
  workspaceName: string,
): Promise<string> {
  const lines = [
    `Pappra workspace "${workspaceName}" is registered for lifecycle event ${event}.`,
  ];
  if (taskId === null) {
    lines.push(
      'No explicit task was selected; run `pappra checkpoint --task <id>` or `pappra resume <id>` for manual continuity.',
    );
  } else {
    const service = new CheckpointService(root);
    const resumed = await service.resume({
      taskId,
      currentSession: null,
    });
    if (!resumed.ok || resumed.packet === null) {
      lines.push(
        `Checkpoint ${taskId} is unavailable or incomplete; manual pappra checkpoint/resume is required.`,
      );
    } else {
      lines.push(`Checkpoint ${taskId} is available for manual review.`);
      lines.push(`Objective: ${resumed.packet.boundedContext.objective}`);
      if (resumed.packet.boundedContext.nextActions.length > 0) {
        lines.push(
          `Next actions: ${resumed.packet.boundedContext.nextActions.join('; ')}`,
        );
      }
      if (!resumed.packet.executionAllowed) {
        lines.push(
          'Context does not authorize execution; inspect blockers before acting.',
        );
      }
    }
  }
  const text = lines.join('\n');
  return text.length <= 8192 ? text : `${text.slice(0, 8189)}...`;
}

interface OwnedEventTemp {
  readonly dev: number;
  readonly ino: number;
  readonly expected: Buffer;
  writeCompleted: boolean;
}

interface EventNamespace {
  readonly root: string;
  readonly directory: string;
  readonly real: string;
  readonly dev: number;
  readonly ino: number;
}

async function eventNamespaceSafe(namespace: EventNamespace): Promise<boolean> {
  if (!(await privateSegmentsSafe(namespace.root, namespace.directory))) {
    return false;
  }
  const observed = await observePath(namespace.directory);
  if (
    observed.kind !== 'directory' ||
    observed.stats === null ||
    observed.stats.dev !== namespace.dev ||
    observed.stats.ino !== namespace.ino
  ) {
    return false;
  }
  return (await resolveRealpath(namespace.directory)) === namespace.real;
}

async function eventTempStillOwned(
  path: string,
  identity: OwnedEventTemp | null,
  namespace: EventNamespace,
  requireComplete: boolean,
): Promise<boolean> {
  if (identity === null || !(await eventNamespaceSafe(namespace))) return false;
  const observed = await observePath(path);
  if (
    observed.kind !== 'file' ||
    observed.stats === null ||
    observed.stats.dev !== identity.dev ||
    observed.stats.ino !== identity.ino
  ) {
    return false;
  }
  if (!requireComplete) return true;
  const read = await readFileBounded(path, identity.expected.length + 1);
  return read.ok && identity.expected.equals(read.value.bytes);
}

async function removeOwnedEventTemp(
  path: string,
  identity: OwnedEventTemp | null,
  namespace: EventNamespace,
): Promise<string | null> {
  if (!(await eventNamespaceSafe(namespace))) return path;
  const observed = await observePath(path);
  if (observed.kind === 'missing') return null;
  if (identity === null) {
    return observed.kind === 'file' ? path : null;
  }
  if (
    observed.kind !== 'file' ||
    observed.stats === null ||
    observed.stats.dev !== identity.dev ||
    observed.stats.ino !== identity.ino
  ) {
    return path;
  }
  const read = await readFileBounded(path, identity.expected.length + 1);
  if (!read.ok) return path;
  const bytes = read.value.bytes;
  const complete = identity.expected.equals(bytes);
  const prefix =
    bytes.length < identity.expected.length &&
    identity.expected.subarray(0, bytes.length).equals(bytes);
  const prefixEligible = !identity.writeCompleted && prefix;
  if (!complete && !prefixEligible) return path;
  try {
    await rm(path);
    return null;
  } catch {
    return path;
  }
}

interface HostEventRecord {
  readonly schema: 'pappra/host-event/1';
  readonly host: HostName;
  readonly event: HostLifecycleEvent;
  readonly eventKey: string | null;
  readonly eventId: string | null;
  readonly sessionId: string | null;
  readonly cwd: string;
  readonly root: string;
  readonly source: string | null;
  readonly observedAt: string;
}

function parseCompleteEventRecord(
  bytes: Buffer,
  expected: {
    readonly key: string;
    readonly host: HostName;
    readonly event: HostLifecycleEvent;
    readonly eventId: string | null;
    readonly sessionId: string | null;
    readonly cwd: string;
    readonly root: string;
    readonly nativeEvent: string;
    readonly source: string | null;
  },
): HostEventRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    record['schema'] !== 'pappra/host-event/1' ||
    record['eventKey'] !== expected.key ||
    record['host'] !== expected.host ||
    record['event'] !== expected.event ||
    record['eventId'] !== expected.eventId ||
    record['sessionId'] !== expected.sessionId ||
    record['cwd'] !== expected.cwd ||
    record['root'] !== expected.root ||
    record['nativeEvent'] !== expected.nativeEvent ||
    record['source'] !== expected.source ||
    typeof record['observedAt'] !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record['observedAt'])
  ) {
    return null;
  }
  return record as unknown as HostEventRecord;
}

export type NativeHookMapping =
  | {
      readonly ok: true;
      readonly input: HostHookInput;
    }
  | {
      readonly ok: false;
      readonly diagnostic: Diagnostic;
      readonly host: HostName;
      readonly event: HostLifecycleEvent | null;
    };

export function mapNativeHookEvent(
  host: HostName,
  raw: unknown,
  _fallbackEvent: HostLifecycleEvent,
  _fallbackCwd: string | null,
): NativeHookMapping {
  const parsed = commandHookEventSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      host,
      event: null,
      diagnostic: diagnostic(
        diagnosticCodes.host_hook_input_invalid,
        'Native hook input does not match the observed envelope.',
        'host hook stdin',
        'Provide the documented host event JSON; no local event was recorded.',
      ),
    };
  }
  const native = parsed.data.hook_event_name;
  let event: HostLifecycleEvent | null = null;
  if (native === 'SessionStart') {
    const source = parsed.data.source;
    event =
      source === 'resume' || source === 'compact'
        ? 'resume'
        : source === undefined ||
            source === 'startup' ||
            source === 'new' ||
            source === 'clear'
          ? 'startup'
          : null;
  } else if (native === 'PostCompact') {
    event = 'compact';
  }
  if (event === null || nativeEventFor(host, event) === null) {
    return {
      ok: false,
      host,
      event,
      diagnostic: diagnostic(
        diagnosticCodes.host_hook_unsupported,
        `Host ${host} native event ${native} has no verified Pappra lifecycle mapping.`,
        'host hook stdin',
        'Keep this event unsupported; do not infer semantics from its name.',
      ),
    };
  }
  const cwd = parsed.data.cwd;
  if (!isAbsolute(cwd)) {
    return {
      ok: false,
      host,
      event,
      diagnostic: diagnostic(
        diagnosticCodes.host_hook_cwd_invalid,
        'Native hook input cwd is not absolute.',
        'host hook stdin',
        'No workspace was guessed and no event was recorded.',
      ),
    };
  }
  const candidate = hostHookInputSchema.safeParse({
    schema: HOST_HOOK_INPUT_SCHEMA,
    host,
    event,
    nativeEvent: native,
    eventId: parsed.data.event_id ?? null,
    sessionId: parsed.data.session_id ?? null,
    cwd: resolve(cwd),
    root: null,
    taskId: parsed.data.pappra_task_id ?? null,
    source: parsed.data.source ?? null,
    observedAt: new Date().toISOString(),
  });
  if (!candidate.success) {
    return {
      ok: false,
      host,
      event,
      diagnostic: diagnostic(
        diagnosticCodes.host_hook_input_invalid,
        'Normalized host event is invalid.',
        'host hook stdin',
        'Provide bounded event identifiers and an absolute cwd; no event was recorded.',
      ),
    };
  }
  return { ok: true, input: candidate.data };
}

export interface HostHookOptions {
  readonly deadlineMs?: number;
  readonly observedAt?: string;
  /** Test seam; production uses the monotonic wall clock. */
  readonly now?: () => number;
}

/**
 * Records one bounded local lifecycle observation. It never reads transcripts,
 * starts a host/model/network/index, writes a checkpoint, or continues a run.
 */
export async function runHostHook(
  input: HostHookInput,
  options: HostHookOptions = {},
): Promise<HostHookResult> {
  const parsed = hostHookInputSchema.safeParse(input);
  if (!parsed.success) {
    return result({
      ok: false,
      status: 'invalid',
      host: null,
      event: null,
      eventKey: null,
      duplicate: false,
      context: null,
      diagnostics: [
        diagnostic(
          diagnosticCodes.host_hook_input_invalid,
          'Host hook input failed schema validation.',
          'host hook input',
          'No local event was recorded.',
        ),
      ],
    });
  }
  const value = parsed.data;
  const deadline = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const clock = options.now ?? Date.now;
  const started = clock();
  if (!Number.isSafeInteger(deadline) || deadline < 1) {
    return result({
      ok: false,
      status: 'invalid',
      host: value.host,
      event: value.event,
      eventKey: null,
      duplicate: false,
      context: null,
      diagnostics: [
        diagnostic(
          diagnosticCodes.host_hook_input_invalid,
          'Hook deadline must be a positive integer.',
          'host hook input',
          'Use the default bounded deadline; no event was recorded.',
        ),
      ],
    });
  }
  if (nativeEventFor(value.host, value.event) === null) {
    return result({
      ok: true,
      status: 'unsupported',
      host: value.host,
      event: value.event,
      eventKey: null,
      duplicate: false,
      context: null,
      diagnostics: [
        diagnostic(
          diagnosticCodes.host_hook_unsupported,
          `Host ${value.host} has no verified native event for ${value.event}.`,
          value.cwd,
          'Use manual checkpoint/resume; no event was recorded.',
        ),
      ],
    });
  }
  const resolution = await resolveWorkspaceRoot({ startPath: value.cwd });
  if (resolution.root === null) {
    return result({
      ok: false,
      status: 'unsupported',
      host: value.host,
      event: value.event,
      eventKey: null,
      duplicate: false,
      context: null,
      diagnostics: [
        diagnostic(
          diagnosticCodes.host_hook_cwd_invalid,
          `Hook cwd is not inside a registered Pappra workspace: ${value.cwd}`,
          value.cwd,
          'No last workspace was reused; no event was recorded.',
        ),
      ],
    });
  }
  const root = resolution.root;
  const workspaceRead = await loadWorkspaceConfig(root, { missing: 'error' });
  if (!workspaceRead.ok) {
    return result({
      ok: false,
      status: 'invalid',
      host: value.host,
      event: value.event,
      eventKey: null,
      duplicate: false,
      context: null,
      diagnostics: [
        diagnostic(
          workspaceRead.code,
          workspaceRead.message,
          root,
          workspaceRead.nextAction ??
            'Repair the workspace configuration; no event was recorded.',
        ),
      ],
    });
  }
  const machineRead = await inspectMachineConfig(root);
  if (machineRead.exists && machineRead.value === null) {
    return result({
      ok: false,
      status: 'invalid',
      host: value.host,
      event: value.event,
      eventKey: null,
      duplicate: false,
      context: null,
      diagnostics:
        machineRead.diagnostics.length > 0
          ? machineRead.diagnostics
          : [
              diagnostic(
                diagnosticCodes.machineWorkspaceMismatch,
                'Local machine configuration is invalid for this workspace.',
                root,
                'Repair or remove machine.json explicitly; no event was recorded.',
              ),
            ],
    });
  }
  if (value.root !== null && !(await canonicalEqual(value.root, root))) {
    return result({
      ok: false,
      status: 'invalid',
      host: value.host,
      event: value.event,
      eventKey: null,
      duplicate: false,
      context: null,
      diagnostics: [
        diagnostic(
          diagnosticCodes.host_hook_cwd_invalid,
          'Hook root disagrees with the registered workspace resolved from cwd.',
          value.cwd,
          'Use the event cwd/root for the same workspace; no event was recorded.',
        ),
      ],
    });
  }
  const realCwd = await resolveRealpath(value.cwd);
  if (realCwd === null || !cwdInside(root, realCwd)) {
    return result({
      ok: false,
      status: 'invalid',
      host: value.host,
      event: value.event,
      eventKey: null,
      duplicate: false,
      context: null,
      diagnostics: [
        diagnostic(
          diagnosticCodes.host_hook_cwd_invalid,
          'Hook cwd escapes the resolved workspace.',
          value.cwd,
          'No event was recorded.',
        ),
      ],
    });
  }
  if (clock() - started > deadline) {
    return result({
      ok: false,
      status: 'timeout',
      host: value.host,
      event: value.event,
      eventKey: null,
      duplicate: false,
      context: null,
      diagnostics: [
        diagnostic(
          diagnosticCodes.host_hook_timeout,
          'Hook exceeded its bounded local deadline.',
          value.cwd,
          'No event was recorded; retry from the native host or use the manual CLI.',
        ),
      ],
    });
  }

  const eventKey =
    value.eventId === null
      ? null
      : sha256Digest(
          [value.host, value.event, value.sessionId ?? '', value.eventId].join(
            '\0',
          ),
        );
  const directory = join(root, '.pappra', 'local', 'host-events', value.host);
  if (!(await privateSegmentsSafe(root, directory))) {
    return result({
      ok: false,
      status: 'failed',
      host: value.host,
      event: value.event,
      eventKey,
      duplicate: false,
      context: null,
      diagnostics: [
        diagnostic(
          diagnosticCodes.host_hook_cwd_invalid,
          `Private host-event namespace contains a symlink or non-directory ancestor: ${directory}`,
          directory,
          'Inspect or remove the redirected path; no event was recorded.',
        ),
      ],
    });
  }
  const boundary = await ensureStatePathBoundary(root, directory);
  if (!boundary.ok) {
    return result({
      ok: false,
      status: 'failed',
      host: value.host,
      event: value.event,
      eventKey,
      duplicate: false,
      context: null,
      diagnostics: [
        diagnostic(
          boundary.code,
          boundary.message,
          directory,
          boundary.nextAction ?? 'Inspect the private host-event path.',
        ),
      ],
    });
  }
  const directoryBefore = await observePath(directory);
  if (
    directoryBefore.kind === 'symlink' ||
    directoryBefore.kind === 'file' ||
    directoryBefore.kind === 'other'
  ) {
    return result({
      ok: false,
      status: 'failed',
      host: value.host,
      event: value.event,
      eventKey,
      duplicate: false,
      context: null,
      diagnostics: [
        diagnostic(
          diagnosticCodes.host_hook_cwd_invalid,
          `Private host-event path is not a private directory: ${directory}`,
          directory,
          'Inspect or remove the redirected path; no event was recorded.',
        ),
      ],
    });
  }
  const privateState = await ensurePrivateState(root);
  if (!privateState.ok) {
    return result({
      ok: false,
      status: 'failed',
      host: value.host,
      event: value.event,
      eventKey,
      duplicate: false,
      context: null,
      diagnostics: [
        diagnostic(
          privateState.code,
          privateState.message,
          root,
          privateState.nextAction ??
            'Protect private workspace state before recording the host event.',
        ),
      ],
    });
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryAfter = await observePath(directory);
  const realDirectory = await resolveRealpath(directory);
  const privateAfter = await privateSegmentsSafe(root, directory);
  if (
    directoryAfter.kind !== 'directory' ||
    directoryAfter.stats === null ||
    realDirectory === null ||
    !privateAfter ||
    !isPathInside(root, realDirectory)
  ) {
    return result({
      ok: false,
      status: 'failed',
      host: value.host,
      event: value.event,
      eventKey,
      duplicate: false,
      context: null,
      diagnostics: [
        diagnostic(
          diagnosticCodes.host_hook_cwd_invalid,
          `Private host-event path resolves outside the workspace: ${directory}`,
          directory,
          'Inspect the redirected path; no event was recorded.',
        ),
      ],
    });
  }
  const namespace: EventNamespace = {
    root,
    directory,
    real: realDirectory,
    dev: directoryAfter.stats.dev,
    ino: directoryAfter.stats.ino,
  };
  const pinnedTask = await readTaskPin(root);
  const autoResume = pinnedTask !== null && (await readAutoResume(root));
  const context = await boundedAdvisory(
    root,
    value.event,
    value.taskId ?? (autoResume ? pinnedTask!.taskId : null),
    workspaceRead.value.name,
  );
  if (clock() - started > deadline) {
    return result({
      ok: false,
      status: 'timeout',
      host: value.host,
      event: value.event,
      eventKey,
      duplicate: false,
      context: null,
      diagnostics: [
        diagnostic(
          diagnosticCodes.host_hook_timeout,
          'Hook exceeded its bounded local deadline before publication.',
          value.cwd,
          'No event was recorded; retry from the native host or use the manual CLI.',
        ),
      ],
    });
  }
  const fileName =
    eventKey === null
      ? `${sha256Digest(`${value.observedAt}\0${randomUUID()}`).slice(7)}.json`
      : `${eventKey.slice(7)}.json`;
  const path = join(directory, fileName);
  const record = Buffer.from(
    `${JSON.stringify(
      {
        schema: 'pappra/host-event/1',
        host: value.host,
        event: value.event,
        eventKey,
        nativeEvent: value.nativeEvent,
        eventId: value.eventId,
        sessionId: value.sessionId,
        cwd: realCwd,
        root,
        source: value.source,
        observedAt: value.observedAt,
      },
      null,
      2,
    )}\n`,
  );
  if (record.length > DEFAULT_MAX_OUTPUT_BYTES) {
    return result({
      ok: false,
      status: 'invalid',
      host: value.host,
      event: value.event,
      eventKey,
      duplicate: false,
      context: null,
      diagnostics: [
        diagnostic(
          diagnosticCodes.host_hook_input_invalid,
          'Host hook event record exceeds the private output bound.',
          path,
          'Reduce event identifiers; no event was recorded.',
        ),
      ],
    });
  }
  const temporary = `${path}.tmp-${randomUUID()}`;
  let owned: OwnedEventTemp | null = null;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw new Error('event temporary is not a file');
      owned = {
        dev: stats.dev,
        ino: stats.ino,
        expected: record,
        writeCompleted: false,
      };
      await handle.writeFile(record);
      owned.writeCompleted = true;
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
    }
    if (!(await eventTempStillOwned(temporary, owned, namespace, true))) {
      const residual = await removeOwnedEventTemp(temporary, owned, namespace);
      return result({
        ok: false,
        status: 'failed',
        host: value.host,
        event: value.event,
        eventKey,
        duplicate: false,
        context: null,
        diagnostics: [
          diagnostic(
            diagnosticCodes.host_hook_failed,
            `Private host-event namespace, temporary identity, or complete content changed during write; nothing was published: ${temporary}`,
            residual ?? temporary,
            residual === null
              ? 'Inspect the workspace-private path; no shared file was adopted.'
              : `Inspect the preserved/unknown temporary at ${residual}; it was not read or deleted through a redirected namespace.`,
          ),
        ],
      });
    }
    if (clock() - started > deadline) {
      const residual = await removeOwnedEventTemp(temporary, owned, namespace);
      return result({
        ok: false,
        status: 'timeout',
        host: value.host,
        event: value.event,
        eventKey,
        duplicate: false,
        context: null,
        diagnostics: [
          diagnostic(
            diagnosticCodes.host_hook_timeout,
            'Hook exceeded its bounded local deadline during event write; the record was not published.',
            residual ?? path,
            residual === null
              ? 'Retry from the native host or use the manual CLI.'
              : `Inspect the preserved temporary: ${residual}.`,
          ),
        ],
      });
    }
    try {
      await link(temporary, path);
    } catch (error) {
      const code =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string'
          ? error.code
          : null;
      if (code === 'EEXIST' && eventKey !== null) {
        const existingObserved = await observePath(path);
        const namespaceSafe = await eventNamespaceSafe(namespace);
        const existing =
          existingObserved.kind === 'file' && namespaceSafe
            ? await readFileBounded(path, 8192)
            : null;
        const complete =
          existing !== null && existing.ok
            ? parseCompleteEventRecord(existing.value.bytes, {
                key: eventKey,
                host: value.host,
                event: value.event,
                eventId: value.eventId,
                sessionId: value.sessionId,
                cwd: realCwd,
                root,
                nativeEvent: value.nativeEvent,
                source: value.source,
              })
            : null;
        const residual = await removeOwnedEventTemp(
          temporary,
          owned,
          namespace,
        );
        if (complete !== null) {
          return result({
            ok: true,
            status: 'duplicate',
            host: value.host,
            event: value.event,
            eventKey,
            duplicate: true,
            context: null,
            diagnostics: [],
          });
        }
        return result({
          ok: false,
          status: 'failed',
          host: value.host,
          event: value.event,
          eventKey,
          duplicate: false,
          context: null,
          diagnostics: [
            diagnostic(
              diagnosticCodes.host_hook_failed,
              `Existing host-event record is incomplete, foreign or invalid; it was preserved: ${path}`,
              path,
              residual === null
                ? 'Inspect the existing record; the new temporary was removed safely.'
                : `Inspect both preserved paths: ${path} and ${residual}.`,
            ),
          ],
        });
      }
      const residual = await removeOwnedEventTemp(temporary, owned, namespace);
      return result({
        ok: false,
        status: 'failed',
        host: value.host,
        event: value.event,
        eventKey,
        duplicate: false,
        context: null,
        diagnostics: [
          diagnostic(
            diagnosticCodes.host_hook_failed,
            `Cannot publish host lifecycle event: ${error instanceof Error ? error.message : String(error)}`,
            residual ?? path,
            residual === null
              ? 'Inspect the private host-event directory; no complete event was claimed.'
              : `Inspect the preserved temporary: ${residual}.`,
          ),
        ],
      });
    }
    if (clock() - started > deadline) {
      const residual = await removeOwnedEventTemp(temporary, owned, namespace);
      return result({
        ok: true,
        status: 'processed',
        host: value.host,
        event: value.event,
        eventKey,
        duplicate: false,
        context,
        diagnostics: [
          diagnostic(
            diagnosticCodes.host_hook_timeout,
            'Hook exceeded its bounded local deadline during publication; the complete record is committed.',
            residual ?? path,
            residual === null
              ? 'The native host received the advisory after the local deadline; no temporary remains.'
              : `Inspect the preserved temporary: ${residual}.`,
          ),
        ],
      });
    }
    const residual = await removeOwnedEventTemp(temporary, owned, namespace);
    if (residual !== null) {
      return result({
        ok: true,
        status: 'processed',
        host: value.host,
        event: value.event,
        eventKey,
        duplicate: false,
        context,
        diagnostics: [
          diagnostic(
            diagnosticCodes.host_hook_failed,
            `Host-event record was published but its temporary remains: ${residual}`,
            residual,
            'Inspect the preserved temporary; the complete record is already present.',
          ),
        ],
      });
    }
    return result({
      ok: true,
      status: 'processed',
      host: value.host,
      event: value.event,
      eventKey,
      duplicate: false,
      context,
      diagnostics: [],
    });
  } catch (error) {
    const namespaceSafe = await eventNamespaceSafe(namespace);
    const observedTemporary = namespaceSafe
      ? await observePath(temporary)
      : null;
    const residual =
      namespaceSafe && observedTemporary?.kind === 'missing' ? null : temporary;
    return result({
      ok: false,
      status: 'failed',
      host: value.host,
      event: value.event,
      eventKey,
      duplicate: false,
      context: null,
      diagnostics: [
        diagnostic(
          diagnosticCodes.host_hook_failed,
          `Cannot write host lifecycle event: ${error instanceof Error ? error.message : String(error)}`,
          residual ?? path,
          residual === null
            ? 'Inspect the private host-event directory; no complete event was claimed.'
            : `Inspect the preserved temporary: ${residual}.`,
        ),
      ],
    });
  }
}

export async function readHookInput(
  stream: AsyncIterable<Uint8Array | string>,
  maxBytes = DEFAULT_MAX_INPUT_BYTES,
  deadlineMs = DEFAULT_DEADLINE_MS,
): Promise<
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly diagnostic: Diagnostic }
> {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
    return {
      ok: false,
      diagnostic: diagnostic(
        diagnosticCodes.host_hook_input_invalid,
        'Hook input deadline must be a positive integer.',
        'host hook stdin',
        'No local event was recorded.',
      ),
    };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const iterator = stream[Symbol.asyncIterator]();
  const timeout = Symbol('hook-input-timeout');
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<typeof timeout>((resolve) => {
    timer = setTimeout(() => resolve(timeout), deadlineMs);
  });
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), deadline]);
      if (next === timeout) {
        void iterator.return?.().catch(() => undefined);
        return {
          ok: false,
          diagnostic: diagnostic(
            diagnosticCodes.host_hook_timeout,
            `Host hook input did not finish within ${deadlineMs} ms.`,
            'host hook stdin',
            'No local event was recorded; the host may report its own timeout.',
          ),
        };
      }
      if (next.done) break;
      const bytes =
        typeof next.value === 'string'
          ? Buffer.from(next.value)
          : Buffer.from(next.value);
      total += bytes.length;
      if (total > maxBytes) {
        void iterator.return?.().catch(() => undefined);
        return {
          ok: false,
          diagnostic: diagnostic(
            diagnosticCodes.host_hook_input_invalid,
            `Host hook input exceeds ${maxBytes} bytes.`,
            'host hook stdin',
            'No local event was recorded.',
          ),
        };
      }
      chunks.push(bytes);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return { ok: true, bytes: Buffer.concat(chunks) };
}

export async function readBoundedHookFile(
  path: string,
): Promise<Buffer | null> {
  const read = await readFileBounded(path, DEFAULT_MAX_INPUT_BYTES);
  return read.ok ? read.value.bytes : null;
}
