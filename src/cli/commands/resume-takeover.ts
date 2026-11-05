import { join, relative } from 'node:path';
import { continuityTaskPaths } from '../../continuity/paths.js';
import type { ResumePacket } from '../../schemas/continuity.js';

// Keep stored strings on one line, including terminal and bidi controls.
export function escapeTakeoverLine(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) =>
    char
      .split('')
      .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .join(''),
  );
}

function quote(value: string | null): string {
  return value === null
    ? 'unavailable'
    : escapeTakeoverLine(JSON.stringify(value));
}

export function formatResumeTakeover(packet: ResumePacket): string {
  const { checkpoint, boundedContext: context } = packet;
  const lines = [
    `Takeover context for task ${quote(packet.taskId)} (read-only)`,
    `Checkpoint ref: ${quote(checkpoint.ref)}`,
    `Checkpoint revision: ${checkpoint.revision}`,
    `Checkpoint digest: ${checkpoint.digest}`,
    `Verification: ${packet.verificationStatus}`,
    `Execution allowed: ${packet.executionAllowed ? 'yes' : 'no'}`,
    ...packet.blockingReasons.map(
      ({ code, message }) => `Blocked: ${quote(code)} ${quote(message)}`,
    ),
    `Context: ${packet.contextCompleteness}${context.truncated ? ' (truncated; inspect the pinned checkpoint)' : ''}`,
    `Code drift: ${packet.codeDrift.status}`,
    `Objective (stored): ${quote(context.objective)}`,
    ...context.acceptance.map((value) => `Acceptance: ${quote(value)}`),
    ...context.constraints.map((value) => `Constraint: ${quote(value)}`),
  ];

  const paths = continuityTaskPaths('.', packet.taskId);
  // Resume keeps one check per checkpoint row, in order. Bounded context keeps
  // the same prefix of rows, including repeated repository IDs or artifact paths.
  for (const [index, repository] of context.repositories.entries()) {
    const drift = packet.codeDrift.repositories[index];
    lines.push(
      `Repository: ${quote(repository.repoId)} stored root=${quote(repository.root)} drift=${drift?.status ?? 'unavailable'}`,
      `  Checkpoint candidate: HEAD=${quote(repository.head)} dirty=${repository.dirty ?? 'unavailable'} capture=${repository.captureStatus}`,
      `  Observed candidate: HEAD=${quote(drift?.currentHead ?? null)} dirty=${drift?.currentDirty ?? 'unavailable'} capture=${drift?.currentCaptureStatus ?? 'unavailable'}`,
    );
    if (repository.patchDigest !== null) {
      const patchPath = join(
        paths.patchesDir,
        `${repository.patchDigest.slice('sha256:'.length)}.patch`,
      );
      lines.push(
        `  Captured patch: ${repository.patchDigest} task-relative ref=${quote(relative(paths.taskDir, patchPath))} status=${drift?.patchStatus ?? 'unavailable'}`,
      );
    } else if (repository.dirty === true) {
      lines.push('  Captured patch: unavailable');
    }
  }
  if (context.repositories.length === 0) lines.push('Repository: unavailable');

  for (const [index, artifact] of context.artifacts.entries()) {
    lines.push(
      `Artifact: ${quote(artifact.path)} stored digest=${artifact.digest} status=${packet.artifactChecks[index]?.status ?? 'unavailable'}`,
    );
  }
  if (context.artifacts.length === 0) lines.push('Artifact: unavailable');
  lines.push(
    'Validation results: unavailable in this view. Inspect cited artifacts or the pinned checkpoint for recorded results.',
    ...context.attempted.map((value) => `Attempted (stored): ${quote(value)}`),
    ...context.limitations.map((value) => `Limitation: ${quote(value)}`),
    ...context.nextActions.map((value) => `Next (stored): ${quote(value)}`),
  );
  for (const observation of packet.executionObservations) {
    lines.push(
      `Native observation (stored snapshot): harness=${observation.harness} session=${quote(observation.sessionId)} turn=${quote(observation.turnId)} run=${quote(observation.runId)} live=${observation.liveStatus}`,
    );
  }
  const collaboration = packet.collaborationObservation;
  if (collaboration.ref !== null) {
    lines.push(
      `Collaboration observation (persisted history): ref=${quote(collaboration.ref)} status=${collaboration.status} live=${collaboration.liveStatus}`,
    );
  }
  lines.push(
    'Task-start base: unavailable in this view. Consult the original assignment or ask the coordinator for the recorded starting revision.',
    'Predecessor message and failure cause: unavailable in this view. Consult the native session or run evidence and the original assignment.',
  );
  return `${lines.join('\n')}\n`;
}
