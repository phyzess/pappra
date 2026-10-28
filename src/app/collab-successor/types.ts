import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { shellQuote } from '../../infra/shell-quote.js';

/**
 * Coordinator successor launch.
 *
 * A launch starts one fresh, visible session of the same harness in a sibling pane, delivers a
 * fixed seed, and records identity evidence. It never mutates the task record by itself except
 * through the existing handoff primitives, and it never repeats a step whose outcome is unknown.
 */
export const SUCCESSOR_REQUEST_SCHEMA = 'pappra/collab-successor-request/1';
export const SUCCESSOR_INTENT_SCHEMA = 'pappra/collab-successor-intent/1';
export const SUCCESSOR_OUTCOME_SCHEMA = 'pappra/collab-successor-outcome/1';
export const SUCCESSOR_ACK_SCHEMA = 'pappra/collab-successor-ack/1';
export const SUCCESSOR_HARNESSES = ['claude', 'codex'] as const;
export type SuccessorHarness = (typeof SUCCESSOR_HARNESSES)[number];

const safeId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must be a safe identifier');
const digest = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, 'must be a sha256 digest');
const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value), 'must be an absolute path')
  .refine((value) => !value.includes('\u0000'), 'must not contain NUL');
const paneId = z
  .string()
  .regex(/^[A-Za-z0-9]+:p[A-Za-z0-9]+$/, 'must look like w3:p3K');
/** Herdr agent names: the same shape Herdr itself accepts. */
const agentName = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,31}$/, 'must be a Herdr agent name');

export const successorRequestSchema = z.strictObject({
  schema: z.literal(SUCCESSOR_REQUEST_SCHEMA),
  /** Durable idempotency key: the same id with different bytes is a conflict. */
  request_id: safeId,
  task_root: absolutePath,
  handoff_id: safeId,
  harness: z.enum(SUCCESSOR_HARNESSES),
  /** Becomes the protocol agent id of the successor, as for the Pi path. */
  agent_name: agentName,
  /** The successor's cwd: the outgoing coordinator's own. */
  cwd: absolutePath,
  /** The coordinator's Herdr pane; the sibling is split from it. Never inferred from focus. */
  caller_pane: paneId,
  direction: z.enum(['right', 'down']).default('right'),
  /** Briefing the successor receives; its digest is pinned here and re-checked on use. */
  checkpoint: z.strictObject({ file: absolutePath, digest }),
});
export type SuccessorRequest = z.infer<typeof successorRequestSchema>;

export const successorIdentitySchema = z.strictObject({
  agent_id: z.string().min(1).max(128),
  session_id: z.string().min(1).max(192),
  harness: z.enum(SUCCESSOR_HARNESSES),
  cwd: absolutePath,
});
export type SuccessorIdentity = z.infer<typeof successorIdentitySchema>;

export const successorIntentSchema = z.strictObject({
  schema: z.literal(SUCCESSOR_INTENT_SCHEMA),
  request_id: safeId,
  request_digest: digest,
  recorded_at: z.string(),
  harness: z.enum(SUCCESSOR_HARNESSES),
  agent_name: agentName,
  cwd: absolutePath,
  handoff_id: safeId,
  /** Claude only: the id the launcher pre-assigns with `--session-id`. */
  claude_session_id: z.string().nullable(),
  /** Exactly the text that will be delivered, and its digest. */
  seed: z.string().min(1).max(8192),
  seed_digest: digest,
  checkpoint: z.strictObject({ file: absolutePath, digest }),
});
export type SuccessorIntent = z.infer<typeof successorIntentSchema>;

export const successorOutcomeSchema = z.strictObject({
  schema: z.literal(SUCCESSOR_OUTCOME_SCHEMA),
  request_id: safeId,
  request_digest: digest,
  recorded_at: z.string(),
  status: z.enum(['launched', 'identity_unavailable']),
  pane_id: paneId,
  agent_name: agentName,
  identity: successorIdentitySchema.nullable(),
  evidence: z
    .strictObject({
      kind: z.enum(['herdr-agent-session', 'codex-daemon-thread']),
      detail: z.string().max(400),
    })
    .nullable(),
  detail: z.string().max(400).nullable(),
});
export type SuccessorOutcome = z.infer<typeof successorOutcomeSchema>;

export const successorAckSchema = z.strictObject({
  schema: z.literal(SUCCESSOR_ACK_SCHEMA),
  request_id: safeId,
  recorded_at: z.string(),
  message_id: z.string(),
  message_digest: digest,
  handoff_id: safeId,
});
export type SuccessorAck = z.infer<typeof successorAckSchema>;

/** All launch artifacts live beside the task record, never inside it. */
export function successorDir(taskRoot: string): string {
  return path.join(taskRoot, 'successor');
}

export const successorFile = {
  request: (taskRoot: string, id: string) =>
    path.join(successorDir(taskRoot), `${id}.request.json`),
  intent: (taskRoot: string, id: string) =>
    path.join(successorDir(taskRoot), `${id}.intent.json`),
  /** Written before each native effect; its presence without an outcome means reconcile. */
  step: (taskRoot: string, id: string, step: 'split' | 'start' | 'prompt') =>
    path.join(successorDir(taskRoot), `${id}.step-${step}.json`),
  outcome: (taskRoot: string, id: string) =>
    path.join(successorDir(taskRoot), `${id}.outcome.json`),
  ack: (taskRoot: string, id: string) =>
    path.join(successorDir(taskRoot), `${id}.ack.json`),
};

export const sha256 = (value: string | Buffer): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;

/**
 * A deterministic UUID for the Claude session the launcher pre-assigns, so a plan can show it
 * and a repeated request names the same session rather than a new random one. It is salted
 * with the task and the handoff as well as the request id: request ids are chosen by people
 * ("req1"), and two tasks must never pre-assign the same Claude session.
 */
export function claudeSessionIdFor(input: {
  readonly taskId: string;
  readonly handoffId: string;
  readonly requestId: string;
}): string {
  const bytes = createHash('sha256')
    .update(
      `pappra-successor\0${input.taskId}\0${input.handoffId}\0${input.requestId}`,
    )
    .digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The one command the successor is asked to run. */
export function ackCommand(input: {
  readonly cliPath: string;
  readonly taskRoot: string;
  readonly requestId: string;
}): string {
  return `node ${shellQuote(input.cliPath)} collab handoff ack --task-root ${shellQuote(input.taskRoot)} --request ${input.requestId} --apply`;
}

/**
 * The fixed seed. Only these values are substituted, so no caller can inject prompt text, and
 * the result is delivered with `herdr agent prompt` (never as an argv, which Herdr rewrites).
 */
export function buildSeed(input: {
  readonly taskId: string;
  readonly handoffId: string;
  readonly command: string;
}): string {
  return [
    `You are the successor coordinator for Pappra task "${input.taskId}" (handoff "${input.handoffId}"). Ownership has not been transferred to you yet.`,
    'Run exactly this one command and nothing else, then read its output. It acknowledges the handoff and prints your briefing:',
    '',
    input.command,
    '',
    'If it says the launcher has not finished recording your identity or the handoff is not ready, wait a few seconds and run the same command again.',
    `After it succeeds, reply with exactly this line and stop: HANDOFF-ACKED ${input.handoffId}`,
    'Do not dispatch, accept, release or edit anything until the previous coordinator tells you dispatch is released.',
  ].join('\n');
}
