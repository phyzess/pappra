import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  DIST_ENTRY,
  isRecord,
  stringOrNull,
  failureDetail,
  parseJsonObject,
  type Admission,
  type CliDeps,
  type SelfHostCheck,
} from './types.ts';

interface DocsCheckSummary {
  readonly total: number;
  readonly current: number;
  readonly needsReview: number;
  readonly unknown: number;
}

interface DocsCheckReport {
  readonly ok: boolean;
  readonly summary: DocsCheckSummary;
  readonly errors: readonly string[];
}

/**
 * `pappra/docs-check/1` sets `ok: false` for a non-current catalog as well as for
 * errors (`ok = no error diagnostic && current === total`). Classification must
 * come from the report contract, never from `ok` alone.
 */
function parseDocsCheckReport(
  payload: Record<string, unknown>,
): DocsCheckReport | null {
  if (payload['schema'] !== 'pappra/docs-check/1') return null;
  const ok = payload['ok'];
  if (typeof ok !== 'boolean') return null;
  const diagnostics = payload['diagnostics'];
  if (!Array.isArray(diagnostics)) return null;
  const errors: string[] = [];
  for (const entry of diagnostics) {
    if (!isRecord(entry)) return null;
    const severity = entry['severity'];
    if (severity !== 'error' && severity !== 'warning' && severity !== 'info') {
      return null;
    }
    if (severity !== 'error') continue;
    errors.push(
      `${stringOrNull(entry['code']) ?? 'error'}${
        stringOrNull(entry['message']) === null
          ? ''
          : `: ${stringOrNull(entry['message'])}`
      }`,
    );
  }
  const summary = payload['summary'];
  if (!isRecord(summary)) return null;
  const count = (name: string): number | null => {
    const value = summary[name];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : null;
  };
  const total = count('total');
  const current = count('current');
  const needsReview = count('needsReview');
  const unknown = count('unknown');
  if (
    total === null ||
    current === null ||
    needsReview === null ||
    unknown === null ||
    current + needsReview + unknown !== total
  ) {
    return null;
  }
  return { ok, summary: { total, current, needsReview, unknown }, errors };
}

function docsCheckContractDetail(payload: Record<string, unknown>): string {
  const code = stringOrNull(payload['code']);
  const message = stringOrNull(payload['message']);
  if (code !== null || message !== null) {
    return `pappra docs check reported ${code ?? 'an error'}${
      message === null ? '' : `: ${message}`
    }`;
  }
  if (!isRecord(payload['summary'])) {
    return 'pappra docs check summary is incomplete; registration is unknown';
  }
  if (!Array.isArray(payload['diagnostics'])) {
    return 'pappra docs check diagnostics are missing or invalid; review state is unknown';
  }
  return 'pappra docs check reported an unexpected result; registration is unknown';
}

/**
 * Document registration and review state. It never accepts changed bytes and
 * never re-approves a document: a stale or unknown registration is reported as
 * an `action` that points at the explicit review route.
 */
export function docsCheck(
  root: string,
  admission: Admission,
  deps: CliDeps,
): SelfHostCheck {
  const id = 'docs-registration';
  if (!admission.ok) {
    return {
      id,
      state: 'blocked',
      detail: 'not evaluated: repository admission must pass first',
      command: null,
    };
  }
  if (!existsSync(join(root, DIST_ENTRY))) {
    return {
      id,
      state: 'blocked',
      detail: 'needs the built repository CLI to verify workspace documents',
      command: 'pnpm build',
    };
  }
  const scan = deps.runCli(['docs', 'scan', '--json']);
  const scanPayload = parseJsonObject(scan.stdout);
  if (scanPayload === null || scanPayload['ok'] !== true) {
    return {
      id,
      state: 'blocked',
      detail: failureDetail('pappra docs scan', scanPayload, scan),
      command: `node ${DIST_ENTRY} docs scan`,
    };
  }
  const candidates = scanPayload['candidates'];
  if (!Array.isArray(candidates)) {
    return {
      id,
      state: 'blocked',
      detail:
        'pappra docs scan payload has no candidate list; registration is unknown',
      command: `node ${DIST_ENTRY} docs scan`,
    };
  }
  if (candidates.length > 0) {
    return {
      id,
      state: 'action',
      detail: `${candidates.length} workspace document(s) are unregistered`,
      command: 'pnpm dev:setup',
    };
  }
  // This workspace registers private documents, so the shared-only catalog would
  // report 'current (0 of 0)' and hide the real review state.
  const check = deps.runCli(['docs', 'check', '--include-private', '--json']);
  const checkPayload = parseJsonObject(check.stdout);
  if (checkPayload === null) {
    return {
      id,
      state: 'blocked',
      detail: failureDetail('pappra docs check', null, check),
      command: `node ${DIST_ENTRY} docs check --include-private`,
    };
  }
  const report = parseDocsCheckReport(checkPayload);
  if (report === null) {
    return {
      id,
      state: 'blocked',
      detail: docsCheckContractDetail(checkPayload),
      command: `node ${DIST_ENTRY} docs check --include-private`,
    };
  }
  if (report.errors.length > 0) {
    return {
      id,
      state: 'blocked',
      detail: `pappra docs check reported ${report.errors.join('; ')}`,
      command: `node ${DIST_ENTRY} docs check --include-private`,
    };
  }
  const { total, current, needsReview, unknown } = report.summary;
  if (needsReview > 0 || unknown > 0) {
    return {
      id,
      state: 'action',
      detail: `${needsReview + unknown} of ${total} registered or private document(s) need review (${needsReview} changed, ${unknown} unknown); review them explicitly, this entry never forgets or re-approves them`,
      command: `node ${DIST_ENTRY} docs list --include-private --json`,
    };
  }
  if (!report.ok) {
    return {
      id,
      state: 'blocked',
      detail:
        'pappra docs check reported a non-current result with a fully current summary; registration is inconsistent',
      command: `node ${DIST_ENTRY} docs check --include-private`,
    };
  }
  return {
    id,
    state: 'ok',
    detail: `registered and private documents current (${current} of ${total})`,
    command: null,
  };
}
