import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import {
  checkpointSchema,
  isValidTaskId,
  taskIdSchema,
  type Checkpoint,
} from '../schemas/continuity.js';
import { diagnosticCodes } from '../schemas/errors.js';
import { failed, succeeded, type Outcome } from '../schemas/outcome.js';
import { readFileBounded, resolveRealpath, sha256Digest } from '../infra/fs.js';
import {
  continuityTaskPaths,
  ensurePrivateTaskBoundary,
  readArtifactPath,
  readContinuityBytes,
  writeContinuityBytes,
  type ContinuityWriteOptions,
} from './paths.js';
import { loadWorkspaceConfig } from '../workspace/config.js';

/**
 * Linked private handoff bundles.
 *
 * A bundle is a separately versioned manifest that *links* one existing durable
 * checkpoint to a collaboration task/attempt and the source native session, and
 * carries the bounded additional handoff snapshot (claims, pending work, next
 * action, recovery). It never duplicates checkpoint content, transfers
 * authority, launches a replacement, archives a session or grants execution.
 * Reading or verifying a bundle is purely advisory: it never returns execution
 * permission or native control. The later rollover orchestrator (E3-B) must
 * independently revalidate current authority, quiescence, ACK and transfer.
 *
 * Bundles are published immutably and exclusively under the existing
 * workspace-private continuity task namespace
 * (`.pappra/local/tasks/<continuityTaskId>/handoff-bundles/<bundleId>.json`),
 * reusing the guarded continuity filesystem helpers. There is no latest
 * pointer, alternate task record or mutable authority store.
 */

export const HANDOFF_BUNDLE_SCHEMA = 'pappra/handoff-bundle/1';

/** Subdirectory holding immutable handoff bundles inside a private task dir. */
export const HANDOFF_BUNDLES_DIRNAME = 'handoff-bundles';

/**
 * Upper bound for a serialized bundle. The manifest only links a checkpoint and
 * carries a bounded snapshot, so it stays well under the shared continuity
 * payload cap; an oversized file is rejected without inspecting its content.
 */
export const HANDOFF_BUNDLE_MAX_BYTES = 256 * 1024;

/**
 * Collaboration identifiers follow the message-envelope contract (up to 128),
 * which is deliberately wider than the continuity task limit (64). The two are
 * never truncated into one another; when they differ the manifest must carry an
 * explicit association string instead of an invented mapping.
 */
const COLLABORATION_ID_MAX_LENGTH = 128;
const COLLABORATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const collaborationIdSchema = z
  .string()
  .min(1)
  .max(COLLABORATION_ID_MAX_LENGTH)
  .regex(COLLABORATION_ID_PATTERN);

/** The bound reference to one existing, schema-valid checkpoint. */
export const handoffCheckpointReferenceSchema = z.strictObject({
  checkpointId: z.uuid(),
  taskId: taskIdSchema,
  workspaceId: z.uuid(),
  /** Private relative reference inside the task dir, e.g. `checkpoints/<id>.json`. */
  ref: z.string().min(1).max(2048),
  digest: digestSchema,
  authorSession: z.string().max(256).nullable(),
  contextCompleteness: z.enum(['complete', 'partial']),
});
export type HandoffCheckpointReference = z.infer<
  typeof handoffCheckpointReferenceSchema
>;

/** The collaboration task/attempt/input/owner-epoch this handoff belongs to. */
export const handoffCollaborationBindingSchema = z.strictObject({
  taskId: collaborationIdSchema,
  attempt: z.number().int().positive(),
  ownerEpoch: z.number().int().positive(),
  subtaskId: z.string().min(1).max(128).nullable(),
  inputRevision: z.string().max(256).nullable(),
  /**
   * Explicit, producer-authored association used only when the collaboration id
   * differs from the continuity task id; never a derived mapping.
   */
  association: z.string().min(1).max(2048).nullable(),
});
export type HandoffCollaborationBinding = z.infer<
  typeof handoffCollaborationBindingSchema
>;

/** The source native session. Model/provider are advisory observations only. */
export const handoffSourceNativeSessionSchema = z.strictObject({
  harness: z.enum(['pi', 'codex', 'claude', 'unknown']),
  sessionId: z.string().min(1).max(256),
  agentId: z.string().min(1).max(128).nullable(),
  paneId: z.string().max(128).nullable(),
  surface: z.string().max(64).nullable(),
  configurationId: z.string().max(128).nullable(),
  modelObservation: z.strictObject({
    model: z.string().max(256).nullable(),
    provider: z.string().max(256).nullable(),
    reasoning: z.string().max(64).nullable(),
  }),
});
export type HandoffSourceNativeSession = z.infer<
  typeof handoffSourceNativeSessionSchema
>;

const pendingCollectionSchema = z.strictObject({
  items: z.array(z.string().min(1).max(2048)).max(64),
  completeness: z.enum(['complete', 'partial', 'unknown']),
});

const scopedClaimSchema = z.strictObject({
  claimId: z.string().min(1).max(128),
  resource: z.string().min(1).max(2048),
  resourceEpoch: z.number().int().nonnegative(),
  holder: z.string().min(1).max(128).nullable(),
});

/** The bounded additional snapshot carried alongside the linked checkpoint. */
export const handoffSnapshotSchema = z.strictObject({
  claims: z.array(scopedClaimSchema).max(64),
  claimsCompleteness: z.enum(['complete', 'partial', 'unknown']),
  pendingTools: pendingCollectionSchema,
  pendingMessages: pendingCollectionSchema,
  pendingApprovals: pendingCollectionSchema,
  nextAction: z.string().min(1).max(4096),
  recovery: z.array(z.string().min(1).max(4096)).max(32),
  /** A bundle never carries execution authority; this is an observation. */
  executionAuthority: z.literal('none'),
  /** Snapshots are advisory; partial/unknown context is preserved, not healed. */
  advisory: z.literal(true),
});
export type HandoffSnapshot = z.infer<typeof handoffSnapshotSchema>;

/** The complete linked handoff bundle manifest. */
export const handoffBundleSchema = z
  .strictObject({
    schema: z.literal(HANDOFF_BUNDLE_SCHEMA),
    bundleId: z.uuid(),
    createdAt: z.iso.datetime({ offset: true }),
    continuityTaskId: taskIdSchema,
    checkpoint: handoffCheckpointReferenceSchema,
    collaboration: handoffCollaborationBindingSchema,
    sourceNativeSession: handoffSourceNativeSessionSchema,
    handoff: handoffSnapshotSchema,
    limitations: z.array(z.string().min(1).max(4096)).max(32),
    notes: z.string().min(1).max(4096).nullable(),
  })
  .superRefine((bundle, ctx) => {
    // The linked checkpoint must live in this private continuity namespace.
    if (bundle.checkpoint.taskId !== bundle.continuityTaskId) {
      ctx.addIssue({
        code: 'custom',
        path: ['checkpoint', 'taskId'],
        message:
          'checkpoint.taskId must equal continuityTaskId; the bundle does not map across task namespaces',
      });
    }
    // Differing collaboration/continuity ids require an explicit association.
    if (
      bundle.collaboration.taskId !== bundle.continuityTaskId &&
      bundle.collaboration.association === null
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['collaboration', 'association'],
        message:
          'collaboration.taskId differs from continuityTaskId; an explicit association is required (no mapping is invented)',
      });
    }
  });
export type HandoffBundle = z.infer<typeof handoffBundleSchema>;

export interface SaveHandoffBundleInput {
  readonly root: string;
  readonly continuityTaskId: string;
  readonly checkpoint: HandoffCheckpointReference;
  readonly collaboration: HandoffCollaborationBinding;
  readonly sourceNativeSession: HandoffSourceNativeSession;
  readonly handoff: HandoffSnapshot;
  readonly limitations?: readonly string[];
  readonly notes?: string | null;
  /** Optional explicit id (uuid); a fresh one is generated otherwise. */
  readonly bundleId?: string;
  /** Clock seam; defaults to the wall clock. */
  readonly now?: () => Date;
  /** Fault-injection seam forwarded to the exclusive publish. */
  readonly writeOptions?: ContinuityWriteOptions;
}

export interface SaveHandoffBundleResult {
  readonly bundleId: string;
  readonly path: string;
  readonly relativeRef: string;
  readonly digest: string;
  readonly bundle: HandoffBundle;
}

export interface ReadHandoffBundleResult {
  readonly bundle: HandoffBundle;
  readonly digest: string;
  readonly path: string;
}

export interface HandoffArtifactCheck {
  readonly path: string;
  readonly status:
    'unchanged' | 'changed' | 'missing' | 'unsafe' | 'unreadable';
}

export interface HandoffCompletenessSummary {
  readonly claims: 'complete' | 'partial' | 'unknown';
  readonly pendingTools: 'complete' | 'partial' | 'unknown';
  readonly pendingMessages: 'complete' | 'partial' | 'unknown';
  readonly pendingApprovals: 'complete' | 'partial' | 'unknown';
}

export interface VerifyHandoffBundleResult {
  readonly bundleId: string;
  readonly continuityTaskId: string;
  readonly checkpointPresent: true;
  readonly checkpointDigestMatches: true;
  readonly checkpointSchemaValid: true;
  readonly associationValid: true;
  readonly workspaceIdentityMatches: true;
  readonly checkpointContextCompleteness: 'complete' | 'partial';
  readonly artifactChecks: readonly HandoffArtifactCheck[];
  /**
   * Truthful overall context assessment: 'complete' only when the checkpoint is
   * itself complete and every referenced artifact is unchanged; 'unknown' when
   * an artifact is unsafe or unreadable; otherwise 'incomplete'. A partial
   * checkpoint or a missing/changed artifact is never reported as complete.
   */
  readonly contextIntegrity: 'complete' | 'incomplete' | 'unknown';
  /** Verification never grants execution or native control. */
  readonly executionAllowed: false;
  readonly completeness: HandoffCompletenessSummary;
}

const HANDOFF_ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;

function invalid(message: string, nextAction: string) {
  return failed(diagnosticCodes.document_record_invalid, message, {
    nextAction,
  });
}

/** Deterministic key-sorted serialization for stable bytes and digests. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortDeep(item));
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = sortDeep(source[key]);
    }
    return out;
  }
  return value;
}

export function serializeHandoffBundle(bundle: HandoffBundle): Buffer {
  return Buffer.from(`${JSON.stringify(sortDeep(bundle), null, 2)}\n`, 'utf8');
}

/**
 * A checkpoint reference is a private relative path only. Absolute paths,
 * parent redirection and NUL bytes are refused before any filesystem access;
 * the guarded continuity boundary re-validates the resolved path as well.
 */
function resolveCheckpointPath(
  root: string,
  continuityTaskId: string,
  ref: string,
): string | null {
  if (
    ref.length === 0 ||
    ref.startsWith('/') ||
    ref.includes('\0') ||
    ref.split('/').includes('..')
  ) {
    return null;
  }
  let taskDir: string;
  try {
    taskDir = continuityTaskPaths(root, continuityTaskId).taskDir;
  } catch {
    return null;
  }
  return join(taskDir, ref);
}

export function handoffBundleRelativeRef(bundleId: string): string {
  return `${HANDOFF_BUNDLES_DIRNAME}/${bundleId}.json`;
}

function handoffBundlePath(
  root: string,
  continuityTaskId: string,
  bundleId: string,
): string | null {
  return resolveCheckpointPath(
    root,
    continuityTaskId,
    handoffBundleRelativeRef(bundleId),
  );
}

/** Build and validate a bundle manifest without touching the filesystem. */
export function buildHandoffBundle(
  input: SaveHandoffBundleInput,
): Outcome<HandoffBundle> {
  const bundleId = input.bundleId ?? randomUUID();
  const createdAt = (input.now?.() ?? new Date()).toISOString();
  const candidate = {
    schema: HANDOFF_BUNDLE_SCHEMA,
    bundleId,
    createdAt,
    continuityTaskId: input.continuityTaskId,
    checkpoint: input.checkpoint,
    collaboration: input.collaboration,
    sourceNativeSession: input.sourceNativeSession,
    handoff: input.handoff,
    limitations: [...(input.limitations ?? [])],
    notes: input.notes ?? null,
  };
  const parsed = handoffBundleSchema.safeParse(candidate);
  if (!parsed.success) {
    return invalid(
      'Handoff bundle failed shape or association validation.',
      'Fix the reported field; identifiers are never truncated and no mapping is invented.',
    );
  }
  return succeeded(parsed.data);
}

/** Parse untrusted bytes into a validated bundle without leaking content. */
export function parseHandoffBundle(raw: unknown): Outcome<HandoffBundle> {
  if (raw === null || typeof raw !== 'object') {
    return invalid(
      'Handoff bundle is not an object.',
      'Provide a well-formed handoff bundle manifest.',
    );
  }
  const schema = (raw as { readonly schema?: unknown }).schema;
  if (schema !== HANDOFF_BUNDLE_SCHEMA) {
    return failed(
      diagnosticCodes.configUnsupportedSchema,
      'Handoff bundle schema is missing or unsupported.',
      {
        nextAction: `Use a ${HANDOFF_BUNDLE_SCHEMA} manifest; other versions are not interpreted.`,
      },
    );
  }
  const parsed = handoffBundleSchema.safeParse(raw);
  if (!parsed.success) {
    return invalid(
      'Handoff bundle failed shape or association validation.',
      'Repair the malformed bundle; private content is not echoed.',
    );
  }
  return succeeded(parsed.data);
}

async function loadReferencedCheckpoint(
  root: string,
  bundle: HandoffBundle,
): Promise<Outcome<Checkpoint>> {
  const reference = bundle.checkpoint;
  const path = resolveCheckpointPath(
    root,
    bundle.continuityTaskId,
    reference.ref,
  );
  if (path === null) {
    return failed(
      diagnosticCodes.document_path_unsafe,
      'Checkpoint reference is not a safe private relative path.',
      {
        nextAction:
          'Reference a checkpoint inside the private task directory; redirections are not followed.',
      },
    );
  }
  const read = await readContinuityBytes(root, bundle.continuityTaskId, path);
  if (!read.ok) {
    if (read.code === diagnosticCodes.fileNotFound) {
      return failed(
        diagnosticCodes.fileNotFound,
        'Referenced checkpoint is missing; the handoff bundle is not complete.',
        {
          nextAction:
            'Reference an existing checkpoint; a missing checkpoint is never reported as complete.',
        },
      );
    }
    return read;
  }
  if (sha256Digest(read.value) !== reference.digest) {
    return failed(
      diagnosticCodes.document_file_changed,
      'Referenced checkpoint bytes do not match the bound digest.',
      {
        nextAction:
          'Rebuild the bundle from the current checkpoint; changed bytes are never reported as complete.',
      },
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(read.value.toString('utf8'));
  } catch {
    return failed(
      diagnosticCodes.document_source_invalid,
      'Referenced checkpoint is not valid JSON.',
      { nextAction: 'Reference a valid checkpoint file.' },
    );
  }
  const parsed = checkpointSchema.safeParse(raw);
  if (!parsed.success) {
    return failed(
      diagnosticCodes.document_source_invalid,
      'Referenced checkpoint does not satisfy the current checkpoint schema.',
      { nextAction: 'Reference a checkpoint valid under the current schema.' },
    );
  }
  const checkpoint = parsed.data;
  // Enforce task/workspace/source-session association by identity, not path.
  const associationMismatch =
    checkpoint.checkpointId !== reference.checkpointId ||
    checkpoint.taskId !== reference.taskId ||
    checkpoint.workspaceId !== reference.workspaceId ||
    checkpoint.authorSession !== reference.authorSession ||
    checkpoint.contextCompleteness !== reference.contextCompleteness;
  if (associationMismatch) {
    return failed(
      diagnosticCodes.document_source_invalid,
      'Referenced checkpoint identity does not match the bound association.',
      {
        nextAction:
          'Bind the exact checkpoint id/task/workspace/author-session; no mapping is inferred.',
      },
    );
  }
  if (
    checkpoint.authorSession !== null &&
    bundle.sourceNativeSession.sessionId !== checkpoint.authorSession
  ) {
    return failed(
      diagnosticCodes.document_source_invalid,
      'Source native session does not match the checkpoint author session.',
      {
        nextAction:
          'Hand off from the session that authored the checkpoint, or record the correct source session.',
      },
    );
  }
  // Bind the checkpoint to the actual registered workspace of this root, not to
  // the producer's own two matching copies of a workspace id. Inspect the
  // current workspace configuration safely; a missing or invalid workspace
  // stays unavailable and is never silently initialized.
  const workspace = await loadWorkspaceConfig(root);
  if (!workspace.ok) {
    return failed(
      workspace.code,
      'Current workspace configuration is unavailable; the checkpoint workspace identity cannot be confirmed.',
      {
        nextAction:
          'Run from a registered workspace; a missing or invalid workspace is never assumed or initialized.',
      },
    );
  }
  if (workspace.value.workspaceId !== checkpoint.workspaceId) {
    return failed(
      diagnosticCodes.document_source_invalid,
      'Checkpoint workspace id does not match the current registered workspace.',
      {
        nextAction:
          'Use a checkpoint produced in this workspace; cross-workspace references are refused.',
      },
    );
  }
  return succeeded(checkpoint);
}

/**
 * Validate the referenced checkpoint, then publish the bundle immutably and
 * exclusively. A missing, changed or mismatched checkpoint fails before any
 * write; an existing bundle id is never replaced.
 */
export async function saveHandoffBundle(
  input: SaveHandoffBundleInput,
): Promise<Outcome<SaveHandoffBundleResult>> {
  if (!isValidTaskId(input.continuityTaskId)) {
    return invalid(
      'Invalid continuity task id for handoff bundle.',
      'Use a continuity task id of up to 64 safe characters.',
    );
  }
  const built = buildHandoffBundle(input);
  if (!built.ok) return built;
  const bundle = built.value;

  const checkpoint = await loadReferencedCheckpoint(input.root, bundle);
  if (!checkpoint.ok) return checkpoint;

  const bytes = serializeHandoffBundle(bundle);
  if (bytes.length > HANDOFF_BUNDLE_MAX_BYTES) {
    return failed(
      diagnosticCodes.fileTooLarge,
      'Serialized handoff bundle exceeds the maximum size.',
      {
        nextAction:
          'Reduce the snapshot collections; oversized bundles are refused without storing content.',
      },
    );
  }
  const path = handoffBundlePath(
    input.root,
    bundle.continuityTaskId,
    bundle.bundleId,
  );
  if (path === null) {
    return failed(
      diagnosticCodes.document_path_unsafe,
      'Computed handoff bundle path is unsafe.',
      { nextAction: 'Use a valid private continuity task namespace.' },
    );
  }
  // Re-validate the private boundary immediately before the exclusive publish so
  // a parent redirected after the initial check (TOCTOU) cannot place the file
  // outside the task namespace. The caller's own seam still runs first.
  const writeOptions: ContinuityWriteOptions = {
    beforeExclusivePublish: async () => {
      await input.writeOptions?.beforeExclusivePublish?.();
      const recheck = await ensurePrivateTaskBoundary(
        input.root,
        bundle.continuityTaskId,
        path,
      );
      if (!recheck.ok) {
        throw new Error(recheck.message);
      }
    },
  };
  const write = await writeContinuityBytes(
    input.root,
    bundle.continuityTaskId,
    path,
    bytes,
    true,
    writeOptions,
  );
  if (!write.ok) return write;
  return succeeded({
    bundleId: bundle.bundleId,
    path,
    relativeRef: handoffBundleRelativeRef(bundle.bundleId),
    digest: write.value.digest,
    bundle,
  });
}

/** Read and validate one stored bundle; private content is never leaked. */
export async function readHandoffBundle(options: {
  readonly root: string;
  readonly continuityTaskId: string;
  readonly bundleId: string;
}): Promise<Outcome<ReadHandoffBundleResult>> {
  if (!isValidTaskId(options.continuityTaskId)) {
    return invalid(
      'Invalid continuity task id for handoff bundle.',
      'Use a continuity task id of up to 64 safe characters.',
    );
  }
  const path = handoffBundlePath(
    options.root,
    options.continuityTaskId,
    options.bundleId,
  );
  if (path === null) {
    return failed(
      diagnosticCodes.document_path_unsafe,
      'Handoff bundle id does not resolve to a safe private path.',
      {
        nextAction: 'Use a valid bundle id inside the private task namespace.',
      },
    );
  }
  const read = await readContinuityBytes(
    options.root,
    options.continuityTaskId,
    path,
  );
  if (!read.ok) return read;
  if (read.value.length > HANDOFF_BUNDLE_MAX_BYTES) {
    return failed(
      diagnosticCodes.fileTooLarge,
      'Stored handoff bundle exceeds the maximum size.',
      {
        nextAction:
          'Inspect the oversized bundle explicitly; it is not parsed.',
      },
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(read.value.toString('utf8'));
  } catch {
    return invalid(
      'Stored handoff bundle is not valid JSON.',
      'Inspect the malformed bundle; private content is not echoed.',
    );
  }
  const parsed = parseHandoffBundle(raw);
  if (!parsed.ok) return parsed;
  if (parsed.value.bundleId !== options.bundleId) {
    return invalid(
      'Stored handoff bundle id does not match its filename.',
      'Inspect the bundle; its id and location must agree.',
    );
  }
  if (parsed.value.continuityTaskId !== options.continuityTaskId) {
    return failed(
      diagnosticCodes.document_source_invalid,
      'Stored handoff bundle targets a different continuity task than requested.',
      {
        nextAction:
          'Read a bundle under its own continuity task; a copied manifest is not followed across namespaces.',
      },
    );
  }
  return succeeded({
    bundle: parsed.value,
    digest: sha256Digest(read.value),
    path,
  });
}

function completenessOf(bundle: HandoffBundle): HandoffCompletenessSummary {
  return {
    claims: bundle.handoff.claimsCompleteness,
    pendingTools: bundle.handoff.pendingTools.completeness,
    pendingMessages: bundle.handoff.pendingMessages.completeness,
    pendingApprovals: bundle.handoff.pendingApprovals.completeness,
  };
}

async function checkCheckpointArtifacts(
  root: string,
  checkpoint: Checkpoint,
): Promise<readonly HandoffArtifactCheck[]> {
  const checks: HandoffArtifactCheck[] = [];
  // Resolve the canonical workspace root so an artifact missing under a
  // non-canonical root (for example a /var -> /private/var symlink) is still
  // classified as missing rather than unsafe.
  const canonicalRoot = (await resolveRealpath(root)) ?? root;
  for (const artifact of checkpoint.artifacts) {
    const resolved = await readArtifactPath(canonicalRoot, artifact.path);
    if (!resolved.ok) {
      checks.push({ path: artifact.path, status: 'unsafe' });
      continue;
    }
    const read = await readFileBounded(
      resolved.value,
      HANDOFF_ARTIFACT_MAX_BYTES,
    );
    if (!read.ok) {
      checks.push({
        path: artifact.path,
        status:
          read.code === diagnosticCodes.fileNotFound ? 'missing' : 'unreadable',
      });
      continue;
    }
    checks.push({
      path: artifact.path,
      status: read.value.digest === artifact.digest ? 'unchanged' : 'changed',
    });
  }
  return checks;
}

function contextIntegrityOf(
  checkpoint: Checkpoint,
  artifactChecks: readonly HandoffArtifactCheck[],
): 'complete' | 'incomplete' | 'unknown' {
  if (
    artifactChecks.some(
      (check) => check.status === 'unsafe' || check.status === 'unreadable',
    )
  ) {
    return 'unknown';
  }
  if (
    checkpoint.contextCompleteness !== 'complete' ||
    artifactChecks.some((check) => check.status !== 'unchanged')
  ) {
    return 'incomplete';
  }
  return 'complete';
}

/**
 * Re-validate a bundle against its referenced checkpoint. Any missing, changed,
 * mismatched or invalid checkpoint fails verification, so a defective bundle is
 * never reported as complete. Success never implies execution authority.
 */
export async function verifyHandoffBundle(
  options:
    | {
        readonly root: string;
        readonly continuityTaskId: string;
        readonly bundleId: string;
      }
    | { readonly root: string; readonly bundle: HandoffBundle },
): Promise<Outcome<VerifyHandoffBundleResult>> {
  let bundle: HandoffBundle;
  if ('bundle' in options) {
    const reparsed = parseHandoffBundle(options.bundle);
    if (!reparsed.ok) return reparsed;
    bundle = reparsed.value;
  } else {
    const read = await readHandoffBundle(options);
    if (!read.ok) return read;
    bundle = read.value.bundle;
  }
  const checkpoint = await loadReferencedCheckpoint(options.root, bundle);
  if (!checkpoint.ok) return checkpoint;
  const artifactChecks = await checkCheckpointArtifacts(
    options.root,
    checkpoint.value,
  );
  return succeeded({
    bundleId: bundle.bundleId,
    continuityTaskId: bundle.continuityTaskId,
    checkpointPresent: true,
    checkpointDigestMatches: true,
    checkpointSchemaValid: true,
    associationValid: true,
    workspaceIdentityMatches: true,
    checkpointContextCompleteness: checkpoint.value.contextCompleteness,
    artifactChecks,
    contextIntegrity: contextIntegrityOf(checkpoint.value, artifactChecks),
    executionAllowed: false,
    completeness: completenessOf(bundle),
  });
}
