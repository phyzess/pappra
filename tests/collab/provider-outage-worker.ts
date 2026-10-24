import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  executeRecovery,
  type RecoveryControllerResult,
  type RecoveryExecutionRequest,
} from '../../src/app/collab-recovery-executor.js';
import { startManagedPiSdkSession } from '../../src/hosts/pi/managed-sdk-session.js';

interface WorkerConfig {
  readonly mode: 'provider-call' | 'restart';
  readonly request: RecoveryExecutionRequest;
  readonly evidenceFile: string;
}

interface WorkerEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface NativeModel {
  readonly id: string;
  readonly provider: string;
}

type NativeStreamFunction = (
  model: NativeModel,
  context: unknown,
  options?: Record<string, unknown>,
) => unknown;

type ProbeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const child = process as typeof process & {
  send?: (
    message: unknown,
    callback?: (error: Error | null) => void,
  ) => boolean;
  disconnect?: () => void;
};

function notify(event: WorkerEvent, callback?: () => void): void {
  if (child.send === undefined) {
    callback?.();
    return;
  }
  child.send(event, () => callback?.());
}

function writeEvidence(file: string, event: Record<string, unknown>): void {
  appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

function isOpenRouterChatRequest(input: RequestInfo | URL): URL {
  const url = new URL(
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'openrouter.ai' ||
    url.pathname !== '/api/v1/chat/completions'
  ) {
    throw new Error('provider probe refused a non-OpenRouter chat endpoint');
  }
  return url;
}

function validateVisiblePaneId(): string {
  const paneId = process.env.PAPPRA_PROVIDER_OUTAGE_PANE_ID;
  if (paneId === undefined || !/^w3:p(?!R$|B$)[A-Za-z0-9]+$/.test(paneId)) {
    throw new Error('owned visible Herdr test pane id is required');
  }
  return paneId;
}

async function runNativeProviderCall(
  config: WorkerConfig,
): Promise<RecoveryControllerResult> {
  const sdkModulePath = process.env.PAPPRA_PROVIDER_OUTAGE_SDK_MODULE;
  if (!sdkModulePath || !sdkModulePath.startsWith('/'))
    throw new Error('explicit pinned Pi SDK module path is required');
  const paneId = validateVisiblePaneId();
  const controller = await startManagedPiSdkSession({
    cwd: process.cwd(),
    model: 'openai/gpt-6-luna',
    journalPath: join(
      dirname(config.evidenceFile),
      'native-managed-session.jsonl',
    ),
    sdkModulePath,
    nativeIdentity: {
      agentId: 'freshOpenRouterPi',
      paneId,
      surface: 'herdr-visible-native-sdk',
      configurationId: null,
    },
    quiesceTimeoutMs: 5_000,
  });
  const nativeSession = (
    controller as unknown as {
      session: {
        readonly agent: {
          state: { readonly isStreaming?: boolean };
          streamFunction: NativeStreamFunction;
        };
        readonly isStreaming: boolean;
        setActiveToolsByName(names: string[]): void;
        getActiveToolNames(): string[];
        prompt(text: string): Promise<void>;
      };
    }
  ).session;
  nativeSession.setActiveToolsByName([]);
  if (nativeSession.getActiveToolNames().length !== 0)
    throw new Error('native provider probe could not disable all tools');

  const observed = controller.observe();
  if (
    observed.native.modelObservation.provider !== 'openrouter' ||
    observed.native.modelObservation.model !== 'openai/gpt-6-luna' ||
    observed.native.paneId !== paneId
  ) {
    throw new Error(
      'native provider session identity did not match the pinned probe',
    );
  }
  writeEvidence(config.evidenceFile, {
    kind: 'native_session_started',
    session_id: observed.native.sessionId,
    provider: observed.native.modelObservation.provider,
    model: observed.native.modelObservation.model,
    pane_id: paneId,
    active_tools: nativeSession.getActiveToolNames().length,
  });
  notify({
    type: 'native-session-started',
    sessionId: observed.native.sessionId,
    provider: observed.native.modelObservation.provider,
    model: observed.native.modelObservation.model,
    paneId,
    tools: nativeSession.getActiveToolNames().length,
  });

  const agent = nativeSession.agent as unknown as {
    streamFunction: NativeStreamFunction;
  };
  const originalStreamFunction = agent.streamFunction;
  let streamCalls = 0;
  let fetchCalls = 0;
  let witnessSent = false;
  const streamAbort = new AbortController();
  let nativeSignal: AbortSignal | undefined;
  const recordNativeWitness = (
    eventType: string,
    byteCount: number,
    status?: number,
  ): void => {
    if (witnessSent || byteCount <= 0) return;
    const streamingState = {
      session: nativeSession.isStreaming,
      agent: nativeSession.agent.state.isStreaming ?? null,
    };
    if (!streamingState.session || !streamingState.agent) {
      writeEvidence(config.evidenceFile, {
        kind: 'late_provider_response_ignored',
        byte_count: byteCount,
        streaming_state: streamingState,
        ...(status === undefined ? {} : { status }),
      });
      streamAbort.abort();
      return;
    }
    witnessSent = true;
    const record = {
      kind: 'native_provider_stream_witness',
      provider: 'openrouter',
      model: 'openai/gpt-6-luna',
      admitted_stream_count: streamCalls,
      event_type: eventType,
      byte_count: byteCount,
      streaming_state: streamingState,
      ...(status === undefined ? {} : { status }),
    };
    writeEvidence(config.evidenceFile, record);
    notify(
      {
        type: 'provider-witness',
        witnessType:
          eventType === 'http_response_chunk'
            ? 'http_response_chunk'
            : 'native_text_delta',
        ...record,
      },
      () => {
        streamAbort.abort(
          new Error('owned provider stream interruption probe'),
        );
        process.exit(86);
      },
    );
  };
  const providerFetch: ProbeFetch = async (input, init) => {
    const url = isOpenRouterChatRequest(input);
    fetchCalls += 1;
    if (fetchCalls !== 1)
      throw new Error('provider probe refused a second upstream request');
    writeEvidence(config.evidenceFile, {
      kind: 'openrouter_fetch_started',
      host: url.hostname,
      endpoint: url.pathname,
      model: 'openai/gpt-6-luna',
      request_number: fetchCalls,
    });

    const response = await globalThis.fetch(input, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.any([
        streamAbort.signal,
        ...(nativeSignal ? [nativeSignal] : []),
        ...(init?.signal ? [init.signal] : []),
      ]),
    });
    if (response.status !== 200) {
      writeEvidence(config.evidenceFile, {
        kind: 'openrouter_unexpected_status',
        status: response.status,
      });
      throw new Error(`OpenRouter returned HTTP ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader)
      throw new Error('OpenRouter returned no streaming response body');
    const first = await reader.read();
    if (first.done || first.value === undefined)
      throw new Error('OpenRouter stream ended before response bytes arrived');
    writeEvidence(config.evidenceFile, {
      kind: 'openrouter_response_chunk_observed',
      status: response.status,
      bytes: first.value.byteLength,
    });
    void reader.cancel().catch(() => undefined);
    recordNativeWitness(
      'http_response_chunk',
      first.value.byteLength,
      response.status,
    );
    await new Promise<never>(() => undefined);
    throw new Error('unreachable after provider stream witness');
  };

  agent.streamFunction = async (model, context, options = {}) => {
    streamCalls += 1;
    if (streamCalls !== 1)
      throw new Error('provider probe refused a second native stream call');
    if (model.provider !== 'openrouter' || model.id !== 'openai/gpt-6-luna') {
      throw new Error(
        'native stream model did not match the pinned OpenRouter model',
      );
    }
    const priorSignal = options['signal'];
    const signal =
      priorSignal instanceof AbortSignal
        ? AbortSignal.any([priorSignal, streamAbort.signal])
        : streamAbort.signal;
    nativeSignal = signal;
    const admitted = {
      kind: 'native_provider_stream_admitted',
      provider: model.provider,
      model: model.id,
      admitted_stream_count: streamCalls,
      streaming_state: {
        session: nativeSession.isStreaming,
        agent: nativeSession.agent.state.isStreaming ?? null,
      },
    };
    writeEvidence(config.evidenceFile, admitted);
    notify({ type: 'native-stream-admitted', ...admitted });

    const stream = (await Reflect.apply(originalStreamFunction, agent, [
      model,
      context,
      {
        ...options,
        maxTokens: 1024,
        maxRetries: 0,
        signal,
        ...(process.env.PAPPRA_PROVIDER_OUTAGE_FETCH_HOOK === '1'
          ? { fetch: providerFetch }
          : {}),
      },
    ])) as AsyncIterable<{
      readonly type: string;
      readonly delta?: string;
    }> &
      object;
    const originalIterator = stream[Symbol.asyncIterator].bind(stream);
    return new Proxy(stream, {
      get(target, property) {
        if (property === Symbol.asyncIterator) {
          return () => {
            const iterator = originalIterator();
            const wrappedIterator: AsyncIterator<{
              readonly type: string;
              readonly delta?: string;
            }> = {
              next: async () => {
                const item = await iterator.next();
                if (
                  !item.done &&
                  item.value.type === 'text_delta' &&
                  typeof item.value.delta === 'string'
                ) {
                  recordNativeWitness(
                    'text_delta',
                    Buffer.byteLength(item.value.delta, 'utf8'),
                  );
                  if (witnessSent) await new Promise<never>(() => undefined);
                }
                return item;
              },
            };
            if (iterator.return)
              wrappedIterator.return = (value) => iterator.return!(value);
            if (iterator.throw)
              wrappedIterator.throw = (error) => iterator.throw!(error);
            return wrappedIterator;
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };

  // The normal managed SDK services and daily extensions are loaded; this
  // harmless task also has an empty tool loadout, so it cannot write files.
  try {
    await nativeSession.prompt(
      'Reply exactly OK. Do not call tools or write files.',
    );
  } finally {
    if (!witnessSent) {
      streamAbort.abort();
      await controller.stopOwnedRuntime();
    }
  }
  throw new Error(
    'native prompt ended without an interruptible provider event',
  );
}

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (raw === undefined) throw new Error('worker config argument is required');
  const config = JSON.parse(raw) as WorkerConfig;
  let controllerCalls = 0;
  const recoveryController = {
    id: 'native-openrouter-stream-disconnect-probe',
    perform: async (): Promise<RecoveryControllerResult> => {
      controllerCalls += 1;
      if (config.mode === 'restart') {
        return {
          disposition: 'failed',
          detail:
            'restart must not redeliver unresolved native provider intent',
          observation: 'unknown',
        };
      }
      return runNativeProviderCall(config);
    },
  };

  const result = await executeRecovery(config.request, {
    controller: recoveryController,
  });
  notify(
    {
      type: 'result',
      status: result.status,
      controllerCalls,
      reservation: result.reservation,
      notes: result.notes,
    },
    () => child.disconnect?.(),
  );
}

void main().catch(() => {
  notify(
    {
      type: 'fatal',
      message: 'native provider probe failed',
    },
    () => {
      process.exitCode = 1;
      child.disconnect?.();
    },
  );
});
