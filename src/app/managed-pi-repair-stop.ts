import crypto from 'node:crypto';
import {
  captureProcessIdentity,
  type LocalProcessIdentity,
} from '../infra/process-identity.js';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { bindNative, findAttempt } from '../collab/lifecycle.js';
import { canonicalJson } from '../collab/envelope.js';
import { readRecord, transact } from '../collab/store.js';
import type { TaskRecord } from '../collab/types.js';
import { requestManagedPiControl } from '../hosts/pi/managed-session.js';
import { ManagedPiSdkSessionController } from '../hosts/pi/managed-sdk-session.js';
import { openTaskStore, assertTaskStoreCurrent } from './collab-task-store.js';
import { readBoundedFile } from './bounded-file.js';
import type { ManagedPiExecutionScope } from './collab-session-transition.js';
import type {
  RoleRepairDependencies,
  NativeStopReceipt,
} from './collab-role-repair.js';
import {
  consumeManagedPiResumeRegistration,
  type ManagedPiSdkResumeAuthorization,
} from './managed-pi-resume-admission.js';

const REGISTRY = 'managed_pi_runtime_registry';
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const hash = (value: unknown) =>
  crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');

function parsePrivateRecord(
  text: string,
  code: string,
): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (object(value)) return value;
  } catch {
    /* Private descriptors contain authentication tokens. */
  }
  throw new Error(code);
}

interface RegisteredRuntime {
  readonly schema: 'pappra/managed-pi-runtime/1';
  readonly agent_id: string;
  readonly session_id: string;
  readonly pid: number;
  readonly process_identity?: LocalProcessIdentity | null;
  readonly descriptor_file: string;
  readonly controller_run_id: string;
  readonly input_revision: string;
  readonly scope: ManagedPiExecutionScope;
  readonly pane_id?: string | null;
}

function entries(record: TaskRecord): RegisteredRuntime[] {
  const value = record[REGISTRY];
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    !value.every(
      (item) =>
        object(item) &&
        item.schema === 'pappra/managed-pi-runtime/1' &&
        typeof item.agent_id === 'string' &&
        typeof item.session_id === 'string' &&
        Number.isSafeInteger(item.pid) &&
        Number(item.pid) > 0 &&
        typeof item.descriptor_file === 'string' &&
        path.isAbsolute(item.descriptor_file) &&
        typeof item.controller_run_id === 'string' &&
        typeof item.input_revision === 'string' &&
        object(item.scope),
    )
  )
    throw new Error('managed_runtime_registry_invalid');
  return value as RegisteredRuntime[];
}

/** The owned SDK process registers itself before TUI input; no PID comes from configuration. */
export async function registerManagedPiRuntime(
  controller: ManagedPiSdkSessionController,
  scope: ManagedPiExecutionScope,
  descriptorFile: string,
  options: {
    readonly confirmNative?: boolean;
    readonly resumeAuthorization?: ManagedPiSdkResumeAuthorization;
  } = {},
) {
  const live = controller.observe();
  const snapshot = controller.snapshot();
  if (
    !(controller instanceof ManagedPiSdkSessionController) ||
    controller.isDisposed ||
    snapshot.process.pid !== process.pid ||
    snapshot.session.sessionId !== scope.session_id ||
    live.native.sessionId !== scope.session_id ||
    path.resolve(live.cwd) !== path.resolve(scope.cwd) ||
    descriptorFile !== `${snapshot.ingress.journalPath}.control.json`
  )
    throw new Error('managed_runtime_registration_identity_mismatch');
  const descriptor = readBoundedFile(descriptorFile, 4096);
  const stat = fs.lstatSync(descriptorFile);
  if (!descriptor.ok || (stat.mode & 0o077) !== 0)
    throw new Error('managed_runtime_descriptor_unsafe');
  const decoded = parsePrivateRecord(
    descriptor.text,
    'managed_runtime_descriptor_invalid',
  );
  if (
    !object(decoded) ||
    decoded.schema !== 'harness-collab/pi-managed-control/1' ||
    decoded.sessionId !== scope.session_id ||
    typeof decoded.runId !== 'string' ||
    !decoded.runId
  )
    throw new Error('managed_runtime_descriptor_mismatch');
  const opened = await openTaskStore(scope.task_root);
  if (!opened.ok || (await assertTaskStoreCurrent(opened.value)))
    throw new Error('managed_runtime_task_unavailable');
  const attempt = findAttempt(
    opened.value.record,
    scope.subtask_id,
    scope.attempt,
  );
  if (
    !attempt ||
    attempt.assignee.session_id !== scope.session_id ||
    !attempt.input_revision
  )
    throw new Error('managed_runtime_assignment_mismatch');
  const entry: RegisteredRuntime = {
    schema: 'pappra/managed-pi-runtime/1',
    agent_id: attempt.assignee.agent_id,
    session_id: scope.session_id,
    pid: process.pid,
    process_identity: captureProcessIdentity(),
    descriptor_file: descriptorFile,
    controller_run_id: decoded.runId,
    input_revision: attempt.input_revision,
    scope,
    pane_id: live.native.paneId,
  };
  const saved = transact(scope.task_root, {
    actor: 'managed-pi-runtime',
    purpose: 'register-owned-runtime',
    apply(record) {
      const current = findAttempt(record, scope.subtask_id, scope.attempt);
      if (
        record.task_id !== scope.task_id ||
        record.coordinator?.owner_epoch !== scope.owner_epoch ||
        !current ||
        current.assignee.agent_id !== entry.agent_id ||
        current.assignee.session_id !== entry.session_id ||
        current.input_revision !== entry.input_revision ||
        current.owner_epoch !== scope.owner_epoch ||
        !['assigned', 'accepted', 'running'].includes(current.state) ||
        !scope.claim_epochs.every((pin) =>
          record.claims.some(
            (claim) =>
              claim.claim_id === pin.claim_id &&
              claim.resource_epoch === pin.resource_epoch &&
              !claim.released_at &&
              claim.subtask_id === scope.subtask_id &&
              claim.attempt === scope.attempt &&
              claim.holder.agent_id === entry.agent_id &&
              claim.holder.session_id === entry.session_id,
          ),
        )
      )
        return { ok: false, reason: 'managed_runtime_registration_stale' };
      const rows = entries(record);
      const old = rows.find((row) => row.session_id === entry.session_id);
      if (old && canonicalJson(old) !== canonicalJson(entry)) {
        if (!options.resumeAuthorization)
          return {
            ok: false,
            reason: 'managed_runtime_identity_already_registered',
          };
        consumeManagedPiResumeRegistration(
          record,
          options.resumeAuthorization,
          old,
          entry,
        );
        rows[rows.indexOf(old)] = entry;
      } else if (options.resumeAuthorization) {
        return { ok: false, reason: 'managed_runtime_resume_source_missing' };
      }
      if (!old) {
        if (rows.length >= 64)
          return { ok: false, reason: 'managed_runtime_registry_limit' };
        rows.push(entry);
      }
      if (
        current.native.observation === 'confirmed' &&
        (current.native.session_id !== entry.session_id ||
          current.native.runner !== 'pi')
      )
        return { ok: false, reason: 'managed_runtime_native_binding_conflict' };
      if (
        options.confirmNative !== false &&
        (current.native.observation !== 'confirmed' ||
          options.resumeAuthorization !== undefined)
      ) {
        const observed = bindNative(record, {
          subtaskId: scope.subtask_id,
          attempt: scope.attempt,
          runner: 'pi',
          sessionId: live.native.sessionId,
          runId: entry.controller_run_id,
          observation: 'confirmed',
          evidenceRef: snapshot.ingress.journalPath,
          observedAt: new Date().toISOString(),
        });
        if (!observed.ok) return observed;
      }
      record[REGISTRY] = rows;
      return {
        record,
        op: 'register-managed-runtime',
        summary: { session_id: entry.session_id },
        result: null,
      };
    },
  });
  if (!saved.ok) throw new Error(saved.reason);
}

const PEER_PID_PROBE = String.raw`import socket, struct, sys
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.settimeout(2)
try:
 s.connect(sys.argv[1])
 if sys.platform == 'darwin':
  print(struct.unpack('i',s.getsockopt(0,2,4))[0])
 elif hasattr(socket,'SO_PEERCRED'):
  print(struct.unpack('3i',s.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[0])
 else:
  sys.exit(2)
finally:
 s.close()
`;

/** Read-only OS witness for the socket owner; it neither reads nor prints an authentication token. */
export function managedPiSocketPeerPid(socketPath: string): number | null {
  const result = spawnSync('python3', ['-c', PEER_PID_PROBE, socketPath], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 4096,
    shell: false,
  });
  if (result.error || result.status !== 0 || !/^\d+\s*$/.test(result.stdout))
    return null;
  const pid = Number(result.stdout.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function privateDirectory(directory: string) {
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(directory) !== directory ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid())
  )
    throw new Error('managed_stop_directory_unsafe');
  return stat;
}

export function managedPiRepairDependencies(
  request: {
    readonly execution: { readonly task_root: string };
    readonly repair_policy?: unknown;
  },
  deps: {
    readonly control?: typeof requestManagedPiControl;
    readonly peerPid?: typeof managedPiSocketPeerPid;
  } = {},
): RoleRepairDependencies | undefined {
  if (!request.repair_policy) return undefined;
  const control = deps.control ?? requestManagedPiControl;
  const peerPid = deps.peerPid ?? managedPiSocketPeerPid;
  return {
    confirm_stopped: async (source) => {
      const opened = await openTaskStore(request.execution.task_root);
      if (!opened.ok) return null;
      const task = opened.value;
      const coordinator = task.record.coordinator;
      const attempt = findAttempt(
        task.record,
        source.source.assignment_id,
        source.source.attempt,
      );
      const registered = entries(task.record).find(
        (item) =>
          item.agent_id === source.assignee.agent_id &&
          item.session_id === source.assignee.session_id,
      );
      if (
        !registered ||
        task.record.task_id !== source.task_id ||
        coordinator?.agent_id !== source.coordinator.agent_id ||
        coordinator.session_id !== source.coordinator.session_id ||
        coordinator.owner_epoch !== source.coordinator.owner_epoch ||
        !attempt ||
        attempt.assignee.agent_id !== source.assignee.agent_id ||
        attempt.assignee.session_id !== source.assignee.session_id ||
        attempt.owner_epoch !== source.coordinator.owner_epoch ||
        attempt.input_revision !== source.source.input_revision ||
        registered.input_revision !== source.source.input_revision ||
        registered.scope.task_root !== task.taskRoot ||
        registered.scope.task_id !== source.task_id ||
        registered.scope.subtask_id !== source.source.assignment_id ||
        registered.scope.attempt !== source.source.attempt ||
        registered.scope.owner_epoch !== source.coordinator.owner_epoch
      )
        return null;
      // Pin authority rather than task.json's inode: unrelated task commits are safe.
      const authority = (current: TaskRecord) =>
        hash({
          task_id: current.task_id,
          task_root: current.task_root,
          domain_id: current.domain_id,
          domain_root: current.domain_root,
          created_at: current.created_at,
          coordinator: current.coordinator,
          attempts: current.attempts
            .filter(
              (row) =>
                row.subtask_id === source.source.assignment_id &&
                row.attempt === source.source.attempt,
            )
            .map(
              ({ updated_at: _updated, transitions: _transitions, ...row }) =>
                row,
            ),
          runtimes: entries(current).filter(
            (row) =>
              row.agent_id === source.assignee.agent_id &&
              row.session_id === source.assignee.session_id,
          ),
          claims: current.claims.filter((row) =>
            registered.scope.claim_epochs.some(
              (pin) => pin.claim_id === row.claim_id,
            ),
          ),
        });
      const expectedAuthority = authority(task.record);
      const key = hash({ source, registered });
      const directory = path.join(task.taskRoot, '.managed-native-stops');
      const file = path.join(directory, `${key}.json`);
      if (fs.lstatSync(directory, { throwIfNoEntry: false }))
        privateDirectory(directory);
      if (fs.lstatSync(file, { throwIfNoEntry: false })) {
        const prior = readBoundedFile(file, 64 * 1024);
        if (!prior.ok) throw new Error('managed_stop_receipt_unsafe');
        const value = parsePrivateRecord(
          prior.text,
          'managed_stop_receipt_invalid',
        );
        if (
          !object(value) ||
          value.key !== key ||
          value.state !== 'confirmed' ||
          !object(value.receipt)
        )
          throw new Error('managed_stop_outcome_unknown');
        const receipt = value.receipt as unknown as NativeStopReceipt;
        if (
          receipt.schema !== 'pappra/collab-native-stop-receipt/1' ||
          receipt.task_id !== source.task_id ||
          receipt.subtask_id !== source.source.assignment_id ||
          receipt.attempt !== source.source.attempt ||
          receipt.owner_epoch !== source.coordinator.owner_epoch ||
          receipt.assignee?.session_id !== source.assignee.session_id ||
          receipt.assignee.agent_id !== source.assignee.agent_id ||
          receipt.observation !== 'confirmed' ||
          receipt.evidence_ref !== file
        )
          throw new Error('managed_stop_receipt_conflict');
        return receipt;
      }
      const descriptor = readBoundedFile(registered.descriptor_file, 4096);
      if (!descriptor.ok) return null;
      const decoded = parsePrivateRecord(
        descriptor.text,
        'managed_runtime_descriptor_invalid',
      );
      if (
        !object(decoded) ||
        decoded.sessionId !== registered.session_id ||
        decoded.runId !== registered.controller_run_id ||
        typeof decoded.socketPath !== 'string'
      )
        return null;
      if (peerPid(decoded.socketPath) !== registered.pid) return null;
      const status = await control(registered.descriptor_file, 'snapshot');
      const snapshot = object(status.snapshot) ? status.snapshot : null;
      const automation = object(status.automation) ? status.automation : null;
      const scope =
        automation && object(automation.execution_scope)
          ? automation.execution_scope
          : null;
      const session =
        snapshot && object(snapshot.session) ? snapshot.session : null;
      const owner =
        snapshot && object(snapshot.process) ? snapshot.process : null;
      if (
        status.ok !== true ||
        snapshot?.schema !== 'harness-collab/pi-managed-sdk-session/1' ||
        session?.sessionId !== registered.session_id ||
        owner?.pid !== registered.pid ||
        !scope ||
        canonicalJson(scope) !== canonicalJson(registered.scope)
      )
        return null;
      if (await assertTaskStoreCurrent(task)) return null;
      // The live snapshot awaited above is not authority over a later task revision.
      // No async seam follows this fresh semantic check and the stop reservation.
      const latest = readRecord(task.taskRoot);
      if (!latest || authority(latest) !== expectedAuthority) return null;
      fs.mkdirSync(directory, { mode: 0o700, recursive: true });
      const pin = privateDirectory(directory);
      const reservation = Buffer.from(
        `${JSON.stringify({ schema: 'pappra/managed-native-stop-journal/1', key, state: 'reserved' })}\n`,
      );
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, reservation);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      const response = await control(registered.descriptor_file, 'stop');
      const exit = object(response.exit) ? response.exit : null;
      const final =
        exit && object(exit.finalSnapshot) ? exit.finalSnapshot : null;
      const finalSession =
        final && object(final.session) ? final.session : null;
      const processInfo = exit && object(exit.process) ? exit.process : null;
      if (
        response.ok !== true ||
        exit?.status !== 'runtime_disposed' ||
        exit.sessionId !== registered.session_id ||
        final?.scopedQuiescent !== true ||
        finalSession?.sessionId !== registered.session_id ||
        processInfo?.exit !== 'not_owned'
      )
        throw new Error('managed_stop_outcome_unknown');
      const receipt: NativeStopReceipt & {
        scope: 'pinned_pi_1_4_owned_runtime';
      } = {
        schema: 'pappra/collab-native-stop-receipt/1',
        observation: 'confirmed',
        task_id: source.task_id,
        subtask_id: source.source.assignment_id,
        attempt: source.source.attempt,
        owner_epoch: source.coordinator.owner_epoch,
        assignee: source.assignee,
        evidence_ref: file,
        observed_at: new Date().toISOString(),
        scope: 'pinned_pi_1_4_owned_runtime',
      };
      const current = privateDirectory(directory);
      const reserved = readBoundedFile(file, 64 * 1024);
      if (
        current.ino !== pin.ino ||
        current.dev !== pin.dev ||
        !reserved.ok ||
        !reserved.bytes.equals(reservation)
      )
        throw new Error('managed_stop_receipt_changed');
      const temporary = path.join(
        directory,
        `.stop-${crypto.randomUUID()}.tmp`,
      );
      try {
        const output = fs.openSync(temporary, 'wx', 0o600);
        try {
          fs.writeFileSync(
            output,
            `${JSON.stringify({ schema: 'pappra/managed-native-stop-journal/1', key, state: 'confirmed', receipt, native: exit })}\n`,
          );
          fs.fsyncSync(output);
        } finally {
          fs.closeSync(output);
        }
        fs.renameSync(temporary, file);
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
      return receipt;
    },
  };
}
