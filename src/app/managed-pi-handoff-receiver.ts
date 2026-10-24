import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildMessage, canonicalJson } from '../collab/envelope.js';
import { submitMessage } from '../collab/messages.js';
import { readRecord } from '../collab/store.js';
import { readHandoffBundle, verifyHandoffBundle } from '../continuity/index.js';
import {
  continuityTaskPaths,
  readContinuityBytes,
} from '../continuity/paths.js';
import type { PiBootstrapConfig } from '../hosts/integration/bootstrap-config.js';
import { decideBootstrapWrite } from '../hosts/integration/pi-bootstrap-guard.js';
import type { ManagedPiSdkSessionController } from '../hosts/pi/managed-sdk-session.js';
import { readBoundedFile } from './bounded-file.js';
import { assertTaskStoreCurrent, openTaskStore } from './collab-task-store.js';
import { routeExclusionFor } from './collab-route.js';

const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Import verified continuity into the actual receiver before acknowledging receipt. */
export async function prepareManagedPiHandoffReceiver(
  runtime: ManagedPiSdkSessionController,
  config: PiBootstrapConfig,
  referenceFile: string,
  journalPath: string,
) {
  const reference = readBoundedFile(referenceFile, 64 * 1024);
  if (!reference.ok) throw new Error('receiver_context_reference_unreadable');
  const ref: unknown = JSON.parse(reference.text);
  if (
    !object(ref) ||
    ref.schema !== 'pappra/managed-handoff-context/1' ||
    !object(ref.bundle) ||
    typeof ref.bundle.root !== 'string' ||
    typeof ref.bundle.continuity_task_id !== 'string' ||
    typeof ref.bundle.bundle_id !== 'string' ||
    typeof ref.bundle.digest !== 'string' ||
    typeof ref.transition_id !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(ref.transition_id)
  )
    throw new Error('receiver_context_reference_invalid');
  const taskRoot = path.join(
    fs.realpathSync(config.domainRoot),
    'tasks',
    config.taskId,
  );
  if (
    ref.task_root !== taskRoot ||
    ref.intent_id !== config.guard.intentId ||
    ref.handoff_id !== config.guard.handoffId ||
    ref.generation !== config.guard.generation ||
    runtime.observe().native.sessionId !== config.guard.successor.sessionId
  )
    throw new Error('receiver_context_identity_mismatch');
  const opened = await openTaskStore(taskRoot);
  if (!opened.ok) throw new Error(opened.code);
  const intent = opened.value.record.rollover?.find(
    (row) => row.intent_id === config.guard.intentId,
  );
  if (
    !intent ||
    intent.bundle.digest !== ref.bundle.digest ||
    intent.bundle.ref !== `handoff-bundles/${ref.bundle.bundle_id}.json` ||
    intent.to.session_id !== runtime.observe().native.sessionId ||
    intent.to.agent_id !== config.guard.successor.agentId
  )
    throw new Error('receiver_context_intent_mismatch');
  const options = {
    root: ref.bundle.root,
    continuityTaskId: ref.bundle.continuity_task_id,
    bundleId: ref.bundle.bundle_id,
  };
  const loaded = await readHandoffBundle(options);
  const verified = await verifyHandoffBundle(options);
  if (
    !loaded.ok ||
    loaded.value.digest !== ref.bundle.digest ||
    !verified.ok ||
    verified.value.contextIntegrity === 'unknown' ||
    verified.value.artifactChecks.some((row) => row.status !== 'unchanged')
  )
    throw new Error('receiver_context_integrity_unverified');
  const bundle = loaded.value.bundle;
  if (
    bundle.collaboration.taskId !== config.taskId ||
    bundle.collaboration.subtaskId !== config.guard.subtaskId ||
    bundle.collaboration.attempt !== config.guard.attempt ||
    bundle.collaboration.inputRevision !== config.guard.inputRevision ||
    bundle.collaboration.ownerEpoch !== config.guard.coordinatorEpoch ||
    bundle.sourceNativeSession.sessionId !== intent.from.session_id
  )
    throw new Error('receiver_context_bundle_mismatch');
  const checkpoint = await readContinuityBytes(
    options.root,
    options.continuityTaskId,
    path.join(
      continuityTaskPaths(options.root, options.continuityTaskId).taskDir,
      bundle.checkpoint.ref,
    ),
  );
  if (
    !checkpoint.ok ||
    `sha256:${createHash('sha256').update(checkpoint.value).digest('hex')}` !==
      bundle.checkpoint.digest
  )
    throw new Error('receiver_checkpoint_changed');
  if (await assertTaskStoreCurrent(opened.value))
    throw new Error('receiver_task_namespace_changed');
  const receiverAuthority = (reason: string) => {
    const current = readRecord(taskRoot);
    const currentIntent = current?.rollover?.find(
      (row) => row.intent_id === intent.intent_id,
    );
    const attempt = current?.attempts.find(
      (row) =>
        row.subtask_id === config.guard.subtaskId &&
        row.attempt === config.guard.attempt,
    );
    if (
      !current ||
      !currentIntent ||
      canonicalJson(currentIntent) !== canonicalJson(intent) ||
      !attempt ||
      attempt.cancel_requested_at ||
      attempt.awaiting === 'approval' ||
      current.coordinator?.owner_epoch !== config.guard.coordinatorEpoch ||
      current.coordinator?.agent_id !==
        opened.value.record.coordinator?.agent_id ||
      current.coordinator?.session_id !==
        opened.value.record.coordinator?.session_id
    )
      throw new Error(reason);
    return { current, attempt };
  };
  receiverAuthority('receiver_authority_changed_before_import');
  const receipt = `${journalPath}.receiver-reservation.json`;
  const fd = fs.openSync(receipt, 'wx', 0o600);
  const receiptIdentity = fs.fstatSync(fd);
  try {
    fs.writeFileSync(
      fd,
      `${canonicalJson({
        schema: 'pappra/managed-receiver-reservation/1',
        session_id: runtime.observe().native.sessionId,
        context_digest: reference.digest,
        stage: 'import_reserved',
      })}\n`,
    );
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    receiverAuthority('receiver_authority_changed_before_import');
  } catch (error) {
    try {
      const current = fs.lstatSync(receipt, { throwIfNoEntry: false });
      if (
        current?.isFile() &&
        current.dev === receiptIdentity.dev &&
        current.ino === receiptIdentity.ino
      )
        fs.unlinkSync(receipt);
    } catch {
      /* Preserve the authority refusal; do not adopt a changed receipt. */
    }
    throw error;
  }
  await runtime.importHandoffContext(
    `Verified handoff context. This is advisory; task ownership is granted only by the authoritative transfer.\n${checkpoint.value.toString('utf8')}\nNext action: ${bundle.handoff.nextAction}\nBundle: ${loaded.value.path}\nIntegrity: ${verified.value.contextIntegrity}`,
  );
  const { current, attempt } = receiverAuthority(
    'receiver_authority_changed_before_ack',
  );
  const prefix = `receiver-${createHash('sha256').update(`${intent.intent_id}:${intent.to.session_id}`).digest('hex').slice(0, 32)}`;
  const ack = submitMessage(
    taskRoot,
    buildMessage({
      message_id: `${prefix}-ack`,
      type: 'ACK',
      task_id: config.taskId,
      from: intent.to,
      to: current.coordinator!,
      reply_to: attempt.assignment_message_id,
      subtask_id: config.guard.subtaskId,
      attempt: config.guard.attempt,
      owner_epoch: config.guard.coordinatorEpoch,
      body: {
        phase: 'handoff-context-imported',
        handoff_id: intent.handoff_id,
        rollover_intent_id: intent.intent_id,
        rollover_generation: intent.generation,
        input_revision: intent.input_revision,
        context_digest: reference.digest,
      },
    }),
  );
  if (!ack.ok) throw new Error('receiver_ack_not_admitted');
  let started = false;
  let observedEnd: Record<string, unknown> | null = null;
  let proof = false;
  let error: string | null = null;
  const unsubscribe = runtime.subscribe((event) => {
    if (!started || proof || !object(event)) return;
    if (event.type === 'agent_end') observedEnd = event;
    if (
      event.type !== 'agent_settled' ||
      event.aborted !== false ||
      !observedEnd ||
      !Array.isArray(observedEnd.messages)
    )
      return;
    const assistant = [...observedEnd.messages]
      .reverse()
      .find((row: unknown) => object(row) && row.role === 'assistant');
    if (
      !object(assistant) ||
      assistant.stopReason !== 'stop' ||
      !Array.isArray(assistant.content) ||
      !assistant.content.some(
        (row: unknown) =>
          object(row) &&
          row.type === 'text' &&
          typeof row.text === 'string' &&
          row.text.trim(),
      )
    )
      return;
    try {
      const record = readRecord(taskRoot);
      if (
        !record ||
        !decideBootstrapWrite(
          record,
          config.guard,
          runtime.observe().native.sessionId,
        ).allow
      )
        throw new Error('receiver_first_work_authority_changed');
      const report = submitMessage(
        taskRoot,
        buildMessage({
          message_id: `${prefix}-first-work`,
          type: 'REPORT',
          task_id: config.taskId,
          from: intent.to,
          to: record.coordinator!,
          subtask_id: intent.subtask_id,
          attempt: intent.attempt,
          owner_epoch: intent.coordinator_epoch,
          body: {
            status: 'running',
            phase: 'handoff-first-work',
            rollover_intent_id: intent.intent_id,
            input_revision: intent.input_revision,
            handoff_id: intent.handoff_id,
            rollover_generation: intent.generation,
            native_ref: {
              schema: 'pappra/native-first-work/1',
              handoff_id: intent.handoff_id,
              generation: intent.generation,
              session_id: intent.to.session_id,
              observation: 'native_agent_settled',
              evidence_ref: journalPath,
            },
          },
        }),
      );
      if (!report.ok) throw new Error('receiver_first_work_not_admitted');
      proof = true;
    } catch {
      error = 'receiver_first_work_unverified';
    }
  });
  return {
    priorSourceRetired() {
      const directory = path.join(
        continuityTaskPaths(options.root, options.continuityTaskId).taskDir,
        'retired-sessions',
      );
      const file = path.join(directory, `${ref.transition_id}.receipt.json`);
      const bytes = readBoundedFile(file, 16 * 1024);
      if (!bytes.ok) return false;
      try {
        const receipt: unknown = JSON.parse(bytes.text);
        if (
          !object(receipt) ||
          receipt.schema !== 'pappra/managed-pi-retirement/1' ||
          receipt.transition_id !== ref.transition_id ||
          receipt.source_session_id !== intent.from.session_id ||
          receipt.successor_session_id !== intent.to.session_id ||
          receipt.status !== 'runtime_disposed_and_transcript_retained' ||
          !object(receipt.stop) ||
          receipt.stop.status !== 'runtime_disposed' ||
          !object(receipt.transcript)
        )
          return false;
        const archived = readBoundedFile(
          path.join(directory, `${ref.transition_id}.jsonl`),
          64 * 1024 * 1024,
        );
        const record = readRecord(taskRoot);
        return (
          archived.ok &&
          archived.digest === receipt.transcript.digest &&
          record !== null &&
          routeExclusionFor(record, intent.from).state === 'excluded'
        );
      } catch {
        return false;
      }
    },
    startWork() {
      if (started) return;
      const record = readRecord(taskRoot);
      if (
        !record ||
        !decideBootstrapWrite(
          record,
          config.guard,
          runtime.observe().native.sessionId,
        ).allow
      )
        throw new Error('receiver_work_before_transfer');
      started = true;
      runtime.submitInput(
        `${prefix}-resume`,
        `Continue the verified handoff after the completed task ownership transfer. ${bundle.handoff.nextAction}\nKeep protocol task completion separate from this turn. Read the imported checkpoint and use only your claimed resource scope.`,
      );
    },
    status: () => ({
      context_imported: true,
      ack_registered: true,
      work_admitted: started,
      first_work_observed: proof,
      error,
    }),
    close: unsubscribe,
  };
}
