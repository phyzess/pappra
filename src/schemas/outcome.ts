import type { DiagnosticCode } from './errors.js';

/** Expected rejection; unexpected exceptions are converted at application boundaries. */
export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: DiagnosticCode;
      readonly message: string;
      readonly retryable: boolean;
      readonly nextAction: string | null;
    };

export interface FailureOptions {
  readonly retryable?: boolean;
  readonly nextAction?: string | null;
  readonly cause?: unknown;
}

export type Failure = Extract<Outcome<never>, { readonly ok: false }>;

export function succeeded<T>(value: T): Outcome<T> {
  return { ok: true, value };
}

export function failed(
  code: DiagnosticCode,
  message: string,
  options: FailureOptions = {},
): Failure {
  const failure: Failure & { readonly cause?: unknown } = {
    ok: false,
    code,
    message,
    retryable: options.retryable ?? false,
    nextAction: options.nextAction ?? null,
    ...(options.cause === undefined ? {} : { cause: options.cause }),
  };
  return failure;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
