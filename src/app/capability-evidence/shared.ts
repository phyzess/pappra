import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  Assignment,
  Capability,
  CapabilityCard,
} from '../../collab/contracts.js';
import { fingerprintSkill } from '../../collab/fingerprint.js';
import { validateContractAndCard } from '../../collab/preflight.js';
import { readBoundedFile } from '../bounded-file.js';

export const MAX_NATIVE_EVIDENCE_BYTES = 16 * 1024 * 1024;
export const MAX_ASSIGNMENT_BYTES = 1024 * 1024;
export const MAX_EVENTS = 20000;

export class EvidenceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'EvidenceError';
  }
}

export function fail(code: string): never {
  throw new EvidenceError(code);
}

export interface EvidenceFile {
  readonly bytes: Buffer;
  readonly text: string;
  readonly digest: string;
}

/**
 * Read one native evidence file. The bounded loader refuses final symlinks and
 * special entries without blocking and enforces descriptor-level type and size.
 */
export function readNativeEvidence(file: string): EvidenceFile {
  const read = readBoundedFile(file, MAX_NATIVE_EVIDENCE_BYTES);
  if (!read.ok) {
    switch (read.code) {
      case 'path_not_absolute':
        return fail('evidence_path_must_be_absolute');
      case 'unreadable':
        return fail('native_evidence_unavailable');
      default:
        return fail('unsupported_evidence_file');
    }
  }
  return { bytes: read.bytes, text: read.text, digest: read.digest };
}

export function parseExecution(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return fail('invalid_native_json');
    }
    return value as Record<string, unknown>;
  } catch {
    return fail('invalid_native_json');
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function digestOf(bytes: Buffer): string {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

export function evidenceRecords(
  evidenceFile: EvidenceFile,
  evidenceRef: string,
  executionFile: EvidenceFile,
  executionRef: string,
): { ref: string; digest: string }[] {
  return [
    { ref: evidenceRef, digest: evidenceFile.digest },
    { ref: executionRef, digest: executionFile.digest },
  ];
}

export function isTimestamp(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

const DATE_MS_LIMIT = 8.64e15;

/**
 * Interpret one recorded Pi timestamp. A message-level value is numeric Unix
 * milliseconds; a record-level value is an explicit-zone ISO string. Numeric
 * strings are not accepted as a substitute for either form.
 */
export function piTimestamp(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && Math.abs(value) <= DATE_MS_LIMIT
      ? value
      : null;
  }
  if (typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function samePath(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return false;
  }
}

export function realPath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return fail('native_evidence_unavailable');
  }
}

export function argumentStrings(
  value: unknown,
  found: string[] = [],
): string[] {
  if (typeof value === 'string') {
    if (value.includes('/') || value.toLowerCase().endsWith('.md'))
      found.push(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) argumentStrings(item, found);
    return found;
  }
  if (record(value)) {
    for (const item of Object.values(value)) argumentStrings(item, found);
  }
  return found;
}

export function payloadStrings(item: unknown): string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') found.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (record(value)) Object.values(value).forEach(visit);
  };
  visit(item);
  return found;
}

/** Assert the template still claims exactly the assignment's assignee identity. */
export function assertTemplateIdentity(
  assignment: Assignment,
  template: CapabilityCard,
  harness: string,
): void {
  if (assignment.assignee.harness !== harness) fail('unsupported_harness');
  for (const key of [
    'agent_id',
    'session_id',
    'harness',
    'surface',
    'configuration_id',
  ] as const) {
    if (template[key] !== assignment.assignee[key])
      fail('template_identity_mismatch');
  }
  if (!samePath(template.cwd, assignment.assignee.cwd))
    fail('template_cwd_mismatch');
}

export interface SkillSnapshot {
  readonly entry: string;
  readonly directory: string;
  readonly bundleDigest: string;
}

/**
 * Reproduce the maintained fingerprint check: the template's pinned digest must
 * still describe the selected skill before evidence can promote it.
 */
export function fingerprintTemplateSkill(skill: Capability): SkillSnapshot {
  if (typeof skill.path !== 'string') fail('skill_path_missing');
  const snapshot = fingerprintSkill(skill.path);
  if (snapshot.bundle_digest !== skill.bundle_digest)
    fail('skill_files_changed');
  return {
    entry: snapshot.path,
    directory: path.dirname(snapshot.path),
    bundleDigest: snapshot.bundle_digest,
  };
}

export type CapabilityDerivation =
  | {
      readonly status: 'derived';
      readonly card: CapabilityCard;
      readonly limitations?: readonly string[];
    }
  | {
      readonly status: 'needs_input';
      readonly blockers: readonly string[];
    }
  | {
      readonly status: 'invalid';
      readonly blockers: readonly string[];
    };

function errorCode(error: unknown): string {
  if (error instanceof EvidenceError) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  if (/^[a-z_]+$/.test(message)) return message;
  if (/^unsupported_row_types/.test(message)) return message;
  return 'native_evidence_unavailable';
}

/**
 * Validate the pinned contract/template and translate adapter failures into the
 * maintained outcome shapes. A derived card remains a claim derived from the
 * supplied evidence; nothing here authenticates, launches or dispatches.
 */
export function deriveOutcome(
  assignment: Assignment,
  template: CapabilityCard,
  work: () => {
    readonly card: CapabilityCard;
    readonly limitations?: readonly string[];
  },
): CapabilityDerivation {
  try {
    validateContractAndCard(assignment, template);
  } catch {
    return { status: 'invalid', blockers: ['invalid_contract_or_template'] };
  }
  try {
    return { status: 'derived', ...work() };
  } catch (error) {
    return { status: 'needs_input', blockers: [errorCode(error)] };
  }
}
