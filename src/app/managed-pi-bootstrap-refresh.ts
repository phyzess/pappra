import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../collab/envelope.js';
import type { ManagedPiSdkSessionController } from '../hosts/pi/managed-sdk-session.js';
import { loadVisibleBootstrapRequest } from './collab-bootstrap.js';
import {
  publishManagedPiReadiness,
  type ManagedPiReadinessConfig,
} from './managed-pi-readiness.js';
import { readBoundedFile } from './bounded-file.js';

/** Refresh native evidence and resolve an unspecified caller from this owned source. */
export async function refreshManagedBootstrapAdmission(
  runtime: ManagedPiSdkSessionController,
  readiness: ManagedPiReadinessConfig,
  original: { readonly ref: string; readonly digest: string },
): Promise<{ readonly ref: string; readonly digest: string }> {
  const loaded = loadVisibleBootstrapRequest(original.ref);
  if (!loaded.ok || loaded.value.digest !== original.digest)
    throw new Error('bootstrap_refresh_template_changed');
  const request = loaded.value.request;
  if (
    !request.managed_runtime ||
    request.admission.capability_card_ref !== readiness.cardFile
  )
    throw new Error('bootstrap_refresh_card_not_authorized');
  const observation = runtime.observe();
  if (
    observation.cwd !== request.target.cwd ||
    observation.native.modelObservation.provider !== 'openrouter' ||
    typeof observation.native.modelObservation.model !== 'string'
  )
    throw new Error('bootstrap_refresh_native_identity_mismatch');
  runtime.publishResourcesReady(true);
  if (!runtime.metadataFile)
    throw new Error('bootstrap_refresh_source_metadata_missing');
  const status = publishManagedPiReadiness(readiness, {
    sessionId: observation.native.sessionId,
    cwd: observation.cwd,
    metadataFile: runtime.metadataFile,
    expectedProvider: 'openrouter',
    expectedModel: observation.native.modelObservation.model,
  });
  if (status.preflight !== 'ready')
    throw new Error('bootstrap_refresh_not_ready');
  const card = readBoundedFile(readiness.cardFile, 1024 * 1024);
  if (!card.ok) throw new Error('bootstrap_refresh_card_unreadable');
  const updated = {
    ...request,
    ...(request.caller.pane_id == null && observation.native.paneId
      ? {
          caller: { ...request.caller, pane_id: observation.native.paneId },
        }
      : {}),
    admission: { ...request.admission, capability_card_digest: card.digest },
  };
  const bytes = `${canonicalJson(updated)}\n`;
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const file = `${original.ref}.admitted-${digest.slice(7, 23)}.json`;
  const parent = fs.lstatSync(path.dirname(file));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.mode & 0o077 ||
    fs.realpathSync(path.dirname(file)) !== path.dirname(file)
  )
    throw new Error('bootstrap_refresh_parent_not_private');
  if (fs.lstatSync(file, { throwIfNoEntry: false })) {
    const existing = readBoundedFile(file, 64 * 1024);
    if (!existing.ok || existing.digest !== digest)
      throw new Error('bootstrap_refresh_pin_conflict');
  } else {
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const directory = fs.openSync(path.dirname(file), 'r');
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  }
  return { ref: file, digest };
}
