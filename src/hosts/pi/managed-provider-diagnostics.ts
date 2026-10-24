import { randomUUID } from 'node:crypto';

export type ManagedProviderDiagnosticSink = (
  kind: string,
  fields: Readonly<Record<string, unknown>>,
) => void;

const names = new Set([
  'Error',
  'TypeError',
  'AggregateError',
  'AbortError',
  'TimeoutError',
  'APIConnectionError',
  'APIConnectionTimeoutError',
  'APIError',
]);
const syscalls = new Set([
  'getaddrinfo',
  'connect',
  'read',
  'write',
  'recv',
  'send',
  'SSL_connect',
]);
const codes = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'EPROTO',
  'ECANCELED',
  'ECONNABORTED',
  'ENOTCONN',
  'EHOSTDOWN',
  'ENETDOWN',
  'ENETRESET',
  'EADDRINUSE',
  'EADDRNOTAVAIL',
  'ENOMEM',
  'EACCES',
  'EPERM',
  'EMFILE',
  'ENFILE',
  'EAGAIN',
  'EWOULDBLOCK',
  'ESHUTDOWN',
  'ABORT_ERR',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_ABORTED',
  'ERR_ABORTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Never serialize errors: messages, URLs, headers and arbitrary custom fields may contain secrets. */
export function managedProviderErrorCauses(
  error: unknown,
): readonly Record<string, unknown>[] {
  const causes: Record<string, unknown>[] = [];
  const seen = new Set<object>();
  const inspect = (value: unknown) => {
    if (!object(value) || seen.has(value) || causes.length >= 4) return;
    seen.add(value);
    try {
      const code =
        typeof value.code === 'string' && codes.has(value.code)
          ? value.code
          : null;
      causes.push({
        name:
          typeof value.name === 'string' && names.has(value.name)
            ? value.name
            : 'Error',
        code,
        errno:
          Number.isSafeInteger(value.errno) &&
          Math.abs(Number(value.errno)) <= 65535
            ? value.errno
            : null,
        syscall:
          typeof value.syscall === 'string' && syscalls.has(value.syscall)
            ? value.syscall
            : null,
      });
      inspect(value.cause);
      if (value instanceof AggregateError)
        for (const nested of value.errors.slice(0, 2)) inspect(nested);
    } catch {
      // An exotic error getter must not mask the original provider error.
    }
  };
  inspect(error);
  return causes;
}

export function managedProviderResponseId(value: unknown): string | null {
  return typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) &&
    !/^(?:sk-|bearer|basic|token|(?:api[_-]?)?key)/i.test(value)
    ? value
    : null;
}

function requestId(response: Response): string | null {
  for (const header of [
    'x-request-id',
    'request-id',
    'x-openrouter-request-id',
  ]) {
    const value = managedProviderResponseId(response.headers.get(header));
    if (value) return value;
  }
  return null;
}

/** Per-call observation only: preserve the caller fetch, options, signal, response and errors. */
export function withManagedProviderDiagnostics(
  options: unknown,
  model: unknown,
  providerCallId: string,
  sink: ManagedProviderDiagnosticSink,
): Readonly<Record<string, unknown>> {
  const original = object(options) ? options : {};
  if (original.fetch !== undefined && typeof original.fetch !== 'function')
    return original;
  const fetcher = (original.fetch ?? globalThis.fetch) as typeof fetch;
  const observedModel = object(model) ? model : {};
  const metadata = {
    provider_call_id: providerCallId,
    provider:
      typeof observedModel.provider === 'string' &&
      /^[a-z][a-z0-9-]{0,63}$/.test(observedModel.provider)
        ? observedModel.provider
        : 'unknown',
    model:
      typeof observedModel.id === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(observedModel.id)
        ? observedModel.id
        : 'unknown',
  };
  const emit: ManagedProviderDiagnosticSink = (kind, fields) => {
    try {
      sink(kind, { ...metadata, ...fields });
    } catch {
      /* Diagnostic failure never masks an admitted effect. */
    }
  };
  const observedFetch: typeof fetch = async (input, init) => {
    const fetchId = randomUUID();
    const started = performance.now();
    const elapsed = () =>
      Math.round(Math.max(0, performance.now() - started) * 1000) / 1000;
    emit('sdk_provider_fetch_started', { fetch_id: fetchId });
    try {
      const response = await fetcher(input, init);
      try {
        emit('sdk_provider_fetch_response', {
          fetch_id: fetchId,
          status: response.status,
          request_id: requestId(response),
          headers_elapsed_ms: elapsed(),
        });
      } catch {
        /* An unreadable diagnostic header must not change the response. */
      }
      return response;
    } catch (error) {
      try {
        emit('sdk_provider_fetch_failed', {
          fetch_id: fetchId,
          elapsed_ms: elapsed(),
          signal_aborted: init?.signal?.aborted ?? false,
          causes: managedProviderErrorCauses(error),
        });
      } catch {
        /* An exotic signal getter must not replace the original error. */
      }
      throw error;
    }
  };
  return { ...original, fetch: observedFetch };
}
