import type { DiagnosticCode } from '../schemas/errors.js';
import type { EvidenceRef } from '../schemas/evidence.js';
import type {
  DoctorCheck,
  DoctorCheckStatus,
  DoctorSeverity,
} from '../schemas/doctor.js';

/**
 * Internal check construction shared by `doctor.ts` and the focused checks it
 * composes. Every check is bounded and de-duplicated here so a focal module
 * cannot emit an out-of-schema report.
 */
export interface CheckInput {
  readonly id: string;
  readonly code: DiagnosticCode;
  readonly status: DoctorCheckStatus;
  readonly severity: DoctorSeverity;
  readonly title: string;
  readonly summary: string;
  readonly source: string;
  readonly observedAt: string;
  readonly coverage?: string | null;
  readonly evidence?: readonly EvidenceRef[];
  readonly nextActions?: readonly string[];
}

export function truncateText(value: string, limit: number): string {
  return value.length <= limit
    ? value
    : `${value.slice(0, Math.max(0, limit - 14))}…[truncated]`;
}

export function makeCheck(input: CheckInput): DoctorCheck {
  const evidence = new Map<string, EvidenceRef>();
  for (const ref of input.evidence ?? []) {
    const key = `${ref.kind}\0${ref.ref}\0${ref.digest ?? ''}\0${ref.scope}`;
    if (!evidence.has(key)) evidence.set(key, ref);
    if (evidence.size >= 32) break;
  }
  const actions = [...new Set(input.nextActions ?? [])]
    .slice(0, 16)
    .map((action) => truncateText(action, 1024));
  const summary = truncateText(input.summary, 4096);
  let coverage = truncateText(input.coverage ?? '', 256);
  if ((input.evidence?.length ?? 0) > 32) {
    coverage = truncateText(`${coverage}; evidence truncated`, 256);
  }
  if ((input.nextActions?.length ?? 0) > 16) {
    coverage = truncateText(`${coverage}; actions truncated`, 256);
  }
  if (summary.length < input.summary.length) {
    coverage = truncateText(`${coverage}; summary truncated`, 256);
  }
  return {
    id: input.id,
    code: input.code,
    status: input.status,
    severity: input.severity,
    title: input.title,
    summary,
    source: input.source,
    observedAt: input.observedAt,
    coverage: coverage === '' ? null : coverage,
    evidence: [...evidence.values()],
    nextActions: actions,
  };
}

export function fileEvidence(
  path: string,
  observedAt: string,
  digest: string | null,
  scope: EvidenceRef['scope'] = 'persisted',
): EvidenceRef {
  return { kind: 'file', ref: path, digest, observedAt, scope };
}
