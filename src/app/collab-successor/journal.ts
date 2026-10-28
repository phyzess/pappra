import { lstatSync } from 'node:fs';
import type { z } from 'zod';
import { readBoundedJson } from '../collab-workflow/context.js';
import {
  successorAckSchema,
  successorFile,
  successorIntentSchema,
  successorOutcomeSchema,
  successorRequestSchema,
  type SuccessorAck,
  type SuccessorIntent,
  type SuccessorOutcome,
  type SuccessorRequest,
} from './types.js';

export type JournalRead<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: 'absent' | 'unreadable' | 'invalid';
      readonly detail: string;
    };

function readDocument<T>(
  file: string,
  label: string,
  schema: z.ZodType<T>,
): JournalRead<T> {
  // Only a genuinely absent file is "absent"; anything else unreadable must not look like a
  // journal that has not been written yet.
  try {
    lstatSync(file);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { ok: false, code: 'absent', detail: `${label} is not recorded` }
      : {
          ok: false,
          code: 'unreadable',
          detail: `${label} cannot be inspected`,
        };
  }
  const read = readBoundedJson(file, label);
  if (!read.ok) return { ok: false, code: 'unreadable', detail: read.message };
  const parsed = schema.safeParse(read.value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : {
        ok: false,
        code: 'invalid',
        detail: parsed.error.issues[0]?.message ?? 'invalid',
      };
}

export const readSuccessorRequest = (
  taskRoot: string,
  id: string,
): JournalRead<SuccessorRequest> =>
  readDocument(
    successorFile.request(taskRoot, id),
    'successor request',
    successorRequestSchema,
  );

export const readSuccessorIntent = (
  taskRoot: string,
  id: string,
): JournalRead<SuccessorIntent> =>
  readDocument(
    successorFile.intent(taskRoot, id),
    'successor intent',
    successorIntentSchema,
  );

export const readSuccessorOutcome = (
  taskRoot: string,
  id: string,
): JournalRead<SuccessorOutcome> =>
  readDocument(
    successorFile.outcome(taskRoot, id),
    'successor outcome',
    successorOutcomeSchema,
  );

export const readSuccessorAck = (
  taskRoot: string,
  id: string,
): JournalRead<SuccessorAck> =>
  readDocument(
    successorFile.ack(taskRoot, id),
    'successor ack',
    successorAckSchema,
  );
