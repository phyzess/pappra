import type { DiagnosticCode } from './errors.js';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

/**
 * A machine-readable finding. `source` is an absolute file path or an
 * operation label; `pointer` is a JSON pointer inside that source when the
 * finding refers to a specific value.
 */
export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly source: string;
  readonly pointer: string | null;
  readonly hint: string | null;
}

export interface DiagnosticInput {
  readonly code: DiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly source: string;
  readonly pointer?: string | null;
  readonly hint?: string | null;
}

export function createDiagnostic(input: DiagnosticInput): Diagnostic {
  return {
    code: input.code,
    severity: input.severity,
    message: input.message,
    source: input.source,
    pointer: input.pointer ?? null,
    hint: input.hint ?? null,
  };
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((entry) => entry.severity === 'error');
}

export function formatDiagnostic(entry: Diagnostic): string {
  const location =
    entry.pointer === null ? entry.source : `${entry.source}#${entry.pointer}`;
  const hint = entry.hint === null ? '' : ` Hint: ${entry.hint}`;
  return `${entry.severity.toUpperCase()} ${entry.code} at ${location}: ${entry.message}${hint}`;
}

function escapePointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

/** Builds a JSON pointer such as `/repositories/0/path`. */
export function pointer(...segments: readonly (string | number)[]): string {
  if (segments.length === 0) return '';
  return `/${segments.map((segment) => escapePointerSegment(String(segment))).join('/')}`;
}
