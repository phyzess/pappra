import { createConnection } from 'node:net';

import { startManagedPiSdkSession } from '../../src/hosts/pi/managed-sdk-session.js';

const PROVIDER = 'openrouter';
const MODEL = 'openai/gpt-6-luna';
const PROMPT = 'Reply exactly OK. Do not call tools or write files.';
const MAX_TOKENS = 1024;
const ALLOWED_HOST = 'openrouter.ai';
const ALLOWED_PATH = '/api/v1/chat/completions';

interface WorkerConfig {
  readonly sdkModulePath: string;
  readonly paneId: string;
  readonly routePort: number;
  readonly journalPath: string;
}

interface WorkerMessage {
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

function notify(message: WorkerMessage, callback?: () => void): void {
  if (child.send === undefined) {
    callback?.();
    return;
  }
  child.send(message, () => callback?.());
}

function waitForParentMessage(type: string): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      process.off('message', listener);
      reject(new Error('parent message timeout'));
    }, 120_000);
    const listener = (message: unknown): void => {
      if (
        typeof message !== 'object' ||
        message === null ||
        (message as Record<string, unknown>).type !== type
      )
        return;
      clearTimeout(timer);
      process.off('message', listener);
      resolve(message as WorkerMessage);
    };
    process.on('message', listener);
  });
}

function requestUrl(input: RequestInfo | URL): URL {
  const raw =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== ALLOWED_HOST ||
    url.port !== '' ||
    url.pathname !== ALLOWED_PATH ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  )
    throw new Error('provider request endpoint refused');
  return url;
}

function checkRestoredRoute(port: number): Promise<{
  readonly code: string;
  readonly bytesSent: number;
}> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (code: string): void => {
      if (settled) return;
      settled = true;
      const bytesSent = socket.bytesWritten;
      socket.destroy();
      resolve({ code, bytesSent });
    };
    socket.once('connect', () => finish('CONNECTED'));
    socket.once('error', (error: NodeJS.ErrnoException) =>
      finish(error.code ?? 'UNKNOWN'),
    );
    socket.setTimeout(3_000, () => finish('ETIMEDOUT'));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function allowedStopReason(value: unknown): string | null {
  return typeof value === 'string' &&
    ['stop', 'length', 'error', 'aborted', 'toolUse'].includes(value)
    ? value
    : null;
}

function safeErrorStatus(error: unknown): string {
  if (isRecord(error) && typeof error['code'] === 'string') {
    const code = error['code'];
    if (/^[A-Z0-9_]{1,40}$/.test(code)) return code;
  }
  return 'provider_request_rejected';
}

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (raw === undefined) throw new Error('worker configuration missing');
  const config = JSON.parse(raw) as WorkerConfig;
  const controller = await startManagedPiSdkSession({
    cwd: process.cwd(),
    model: MODEL,
    thinkingLevel: 'off',
    journalPath: config.journalPath,
    sdkModulePath: config.sdkModulePath,
    nativeIdentity: {
      agentId: null,
      paneId: config.paneId,
      surface: 'herdr-owned-test-pane',
      configurationId: null,
    },
    quiesceTimeoutMs: 5_000,
  });
  const originalGlobalFetch = globalThis.fetch;

  let sessionId: string | null = null;
  let streamCalls = 0;
  let streamInvocations = 0;
  let rejectedStreamInvocations = 0;
  let fetchCalls = 0;
  let rejectedFetchCalls = 0;
  let upstreamFetchCalls = 0;
  let routeCode: string | null = null;
  let routeBytesSent: number | null = null;
  let endpointHost: string | null = null;
  let endpointPath: string | null = null;
  let responseStatus: number | null = null;
  let terminalStatus = 'native_session_setup_failed';
  let stopReason: string | null = null;
  let exactReply = false;
  let promptOutcome: 'returned' | 'rejected' = 'rejected';
  let runtimeStopStatus = 'not_confirmed';
  let unsubscribe: (() => void) | undefined;
  let globalFetchUnchanged = true;

  try {
    const session = (
      controller as unknown as {
        session: {
          readonly agent: {
            state: { readonly isStreaming?: boolean };
            streamFunction: NativeStreamFunction;
          };
          readonly model: NativeModel;
          setActiveToolsByName(names: string[]): void;
          getActiveToolNames(): string[];
          prompt(text: string): Promise<void>;
          subscribe(listener: (event: unknown) => void): () => void;
        };
      }
    ).session;
    session.setActiveToolsByName([]);
    if (session.getActiveToolNames().length !== 0)
      throw new Error('native test tools were not disabled');

    const observed = controller.observe();
    if (
      observed.native.modelObservation.provider !== PROVIDER ||
      observed.native.modelObservation.model !== MODEL ||
      observed.native.paneId !== config.paneId ||
      observed.native.agentId !== null
    )
      throw new Error(
        'native session observation did not match the owned probe',
      );
    sessionId = observed.native.sessionId;
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        sessionId,
      )
    )
      throw new Error('native SDK session id was not observed');

    notify({
      type: 'native-session-started',
      sessionId,
      provider: PROVIDER,
      model: MODEL,
      paneId: config.paneId,
      agentId: null,
      activeTools: session.getActiveToolNames().length,
      processPid: process.pid,
    });

    unsubscribe = session.subscribe((event) => {
      if (!isRecord(event)) return;
      const message = isRecord(event['message']) ? event['message'] : null;
      if (
        message?.['role'] === 'assistant' &&
        Array.isArray(message['content'])
      )
        exactReply = message['content'].some(
          (part: unknown) =>
            isRecord(part) &&
            part['type'] === 'text' &&
            typeof part['text'] === 'string' &&
            part['text'].trim() === 'OK',
        );
      const reason =
        allowedStopReason(message?.['stopReason']) ??
        allowedStopReason(event['stopReason']) ??
        allowedStopReason(message?.['stop_reason']) ??
        allowedStopReason(event['stop_reason']);
      if (reason !== null) stopReason = reason;
    });

    await waitForParentMessage('run-one-native-request');
    const agent = session.agent;
    const originalStreamFunction = agent.streamFunction;
    const providerFetch: ProbeFetch = async (input, init) => {
      const url = requestUrl(input);
      if (fetchCalls !== 0) {
        rejectedFetchCalls += 1;
        throw new Error('native provider fetch retry refused');
      }
      fetchCalls = 1;
      endpointHost = url.hostname;
      endpointPath = url.pathname;

      const route = await checkRestoredRoute(config.routePort);
      routeCode = route.code;
      routeBytesSent = route.bytesSent;
      if (routeCode !== 'CONNECTED') {
        terminalStatus = routeCode;
        throw new Error('owned loopback route was not restored');
      }

      upstreamFetchCalls = 1;
      try {
        const response = await originalGlobalFetch(input, init);
        responseStatus = response.status;
        terminalStatus = `http_${response.status}`;
        return response;
      } catch (error) {
        terminalStatus = safeErrorStatus(error);
        throw error;
      }
    };
    agent.streamFunction = async (model, context, options = {}) => {
      streamInvocations += 1;
      if (model.provider !== PROVIDER || model.id !== MODEL)
        throw new Error('native stream model did not match the pinned probe');
      if (streamCalls !== 0) {
        rejectedStreamInvocations += 1;
        throw new Error('native stream retry refused by the one-request probe');
      }
      streamCalls = 1;
      const stream = await Reflect.apply(originalStreamFunction, agent, [
        model,
        context,
        {
          ...options,
          maxTokens: MAX_TOKENS,
          maxRetries: 0,
          tools: [],
          fetch: providerFetch,
        },
      ]);
      return stream;
    };

    try {
      await session.prompt(PROMPT);
      promptOutcome = 'returned';
      if (responseStatus === null) terminalStatus = 'provider_response_missing';
    } catch (error) {
      promptOutcome = 'rejected';
      if (terminalStatus === 'native_session_setup_failed')
        terminalStatus = safeErrorStatus(error);
    }
  } catch {
    if (terminalStatus === 'native_session_setup_failed')
      terminalStatus = 'native_session_failed';
  } finally {
    globalFetchUnchanged = globalThis.fetch === originalGlobalFetch;
    try {
      await controller.stopOwnedRuntime();
      runtimeStopStatus = 'runtime_disposed';
    } catch {
      runtimeStopStatus = 'dispose_not_confirmed';
    }
    try {
      unsubscribe?.();
    } catch {
      // Observer cleanup must not mask the terminal provider result.
    }
  }

  notify(
    {
      type: 'native-attempt-result',
      sessionId,
      provider: PROVIDER,
      model: MODEL,
      paneId: config.paneId,
      processPid: process.pid,
      streamCalls,
      streamInvocations,
      rejectedStreamInvocations,
      fetchCalls,
      rejectedFetchCalls,
      upstreamFetchCalls,
      routeCode,
      routeBytesSent,
      endpointHost,
      endpointPath,
      responseStatus,
      terminalStatus,
      promptOutcome,
      stopReason,
      exactReply,
      runtimeStopStatus,
      tokenCap: MAX_TOKENS,
      retries: 0,
      globalFetchUnchanged,
    },
    () => {
      child.disconnect?.();
      process.exitCode = terminalStatus === 'http_200' ? 0 : 86;
    },
  );
}

void main().catch(() => {
  notify({ type: 'fatal', code: 'native_provider_probe_failed' }, () => {
    process.exitCode = 1;
    child.disconnect?.();
  });
});
