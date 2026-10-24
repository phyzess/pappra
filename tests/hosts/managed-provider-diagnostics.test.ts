import assert from 'node:assert/strict';
import test from 'node:test';
import {
  managedProviderErrorCauses,
  managedProviderResponseId,
  withManagedProviderDiagnostics,
} from '../../src/hosts/pi/managed-provider-diagnostics.js';

const model = { provider: 'openrouter', id: 'openai/gpt-6-luna' };
test('provider diagnostics retain headers timing and request ID without changing fetch, body or signal', async () => {
  const events: { kind: string; fields: Readonly<Record<string, unknown>> }[] =
    [];
  const controller = new AbortController();
  const init = {
    signal: controller.signal,
    headers: { authorization: 'Bearer private-fixture-secret' },
    body: 'private-request-body',
    method: 'POST',
  };
  const response = new Response('native stream bytes', {
    status: 200,
    headers: {
      'x-request-id': 'req-native-123',
      'x-irrelevant': 'private-fixture-secret',
    },
  });
  let calls = 0;
  const input =
    'https://user:private-fixture-secret@example.invalid/v1?api_key=private-fixture-secret';
  const options = withManagedProviderDiagnostics(
    {
      maxRetries: 0,
      fetch: async (actualInput: unknown, actualInit: unknown) => {
        calls++;
        assert.equal(actualInput, input);
        assert.equal(actualInit, init);
        return response;
      },
    },
    model,
    'call-1',
    (kind, fields) => events.push({ kind, fields }),
  );
  const fetcher = options.fetch as typeof fetch;
  assert.equal(await fetcher(input, init), response);
  assert.equal(await response.text(), 'native stream bytes');
  assert.equal(calls, 1);
  assert.equal(options.maxRetries, 0);
  assert.equal(events[1]!.fields.request_id, 'req-native-123');
  assert.equal(events[1]!.fields.status, 200);
  assert.ok(Number(events[1]!.fields.headers_elapsed_ms) >= 0);
  assert.equal(
    JSON.stringify(events).includes('private-fixture-secret'),
    false,
  );
  assert.equal(JSON.stringify(events).includes('private-request-body'), false);
});
test('fetch rejection keeps the exact error while retaining a bounded redacted errno chain', async () => {
  const nested = Object.assign(new Error('private-secret-in-url'), {
    code: 'ENOTFOUND',
    errno: -3008,
    syscall: 'getaddrinfo',
    hostname: 'private-secret',
  });
  const original = new TypeError('private-secret', { cause: nested });
  const events: Readonly<Record<string, unknown>>[] = [];
  const before = globalThis.fetch;
  const options = withManagedProviderDiagnostics(
    {
      fetch: async () => {
        throw original;
      },
    },
    model,
    'call-2',
    (_kind, fields) => events.push(fields),
  );
  await assert.rejects(
    (options.fetch as typeof fetch)('https://example.invalid'),
    (error) => error === original,
  );
  assert.equal(globalThis.fetch, before);
  const failed = events.at(-1)!;
  const exoticInit = Object.defineProperty({}, 'signal', {
    get() {
      throw new Error('unreadable signal');
    },
  });
  await assert.rejects(
    (options.fetch as typeof fetch)('https://example.invalid', exoticInit),
    (error) => error === original,
  );
  assert.deepEqual(failed.causes, [
    { name: 'TypeError', code: null, errno: null, syscall: null },
    { name: 'Error', code: 'ENOTFOUND', errno: -3008, syscall: 'getaddrinfo' },
  ]);
  assert.ok(Number(failed.elapsed_ms) >= 0);
  assert.equal(JSON.stringify(events).includes('private-secret'), false);
  const circular = Object.assign(new Error('private-secret'), {
    cause: null as unknown,
  });
  circular.cause = circular;
  assert.equal(managedProviderErrorCauses(circular).length, 1);
  const unrecognized = Object.assign(new Error('private-secret'), {
    code: 'EPRIVATE_SECRET',
    syscall: 'private-secret',
  });
  assert.equal(
    JSON.stringify(managedProviderErrorCauses(unrecognized)).includes(
      'PRIVATE_SECRET',
    ),
    false,
  );
});
test('diagnostic sink failures and secret-shaped request IDs do not alter successful effects', async () => {
  const response = new Response('OK', {
    headers: { 'x-request-id': 'sk-private-secret' },
  });
  const events: Readonly<Record<string, unknown>>[] = [];
  const options = withManagedProviderDiagnostics(
    { fetch: async () => response },
    model,
    'call-3',
    (_kind, fields) => {
      events.push(fields);
      throw new Error('sink failed');
    },
  );
  assert.equal(
    await (options.fetch as typeof fetch)('https://example.invalid'),
    response,
  );
  assert.equal(events[1]!.request_id, null);
  assert.equal(JSON.stringify(events).includes('sk-private-secret'), false);
  assert.equal(
    managedProviderResponseId('gen-safe-provider-id'),
    'gen-safe-provider-id',
  );
  assert.equal(
    managedProviderResponseId('https://private-secret@example.invalid'),
    null,
  );
  assert.equal(managedProviderResponseId('Bearer private-secret'), null);
});
