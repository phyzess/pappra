import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../collab/envelope.js';
import { readBoundedFile } from './bounded-file.js';
import type { SessionTransitionRequest } from './collab-session-transition.js';

/** Publish captured context only at the destination explicitly approved by the launch request. */
export function prepareManagedHandoffContextReference(
  request: SessionTransitionRequest,
): void {
  const bootstrap = readBoundedFile(request.bootstrap_request.ref, 64 * 1024);
  // The transition reports invalid or missing legacy bootstrap inputs itself.
  // This hook only adds a context reference for an explicitly pinned managed launch.
  if (!bootstrap.ok || bootstrap.digest !== request.bootstrap_request.digest)
    return;
  const value: unknown = JSON.parse(bootstrap.text);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('managed_runtime' in value)
  )
    return;
  const runtime = value.managed_runtime as Record<string, unknown> | null;
  const file = runtime?.handoff_context_file;
  if (file === undefined) return;
  if (typeof file !== 'string' || !path.isAbsolute(file))
    throw new Error('handoff_context_path_invalid');
  const parent = fs.lstatSync(path.dirname(file));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.mode & 0o077 ||
    fs.realpathSync(path.dirname(file)) !== path.dirname(file) ||
    (typeof process.getuid === 'function' && parent.uid !== process.getuid())
  )
    throw new Error('handoff_context_parent_not_private');
  const bytes = `${canonicalJson({
    schema: 'pappra/managed-handoff-context/1',
    task_root: request.task_root,
    transition_id: request.transition_id,
    intent_id: request.intent.intent_id,
    handoff_id: request.intent.handoff_id,
    generation: request.intent.generation,
    bundle: request.bundle,
  })}\n`;
  if (fs.lstatSync(file, { throwIfNoEntry: false })) {
    const previous = readBoundedFile(file, 64 * 1024);
    if (!previous.ok || previous.text !== bytes)
      throw new Error('handoff_context_reference_conflict');
    return;
  }
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
