import { createConnection } from 'node:net';

import {
  executeRecovery,
  type RecoveryControllerRequest,
  type RecoveryControllerResult,
  type RecoveryExecutionRequest,
} from '../../src/app/collab-recovery-executor.js';

interface WorkerConfig {
  readonly mode: 'crash-after-no-effect' | 'restart' | 'unknown';
  readonly port: number;
  readonly request: RecoveryExecutionRequest;
}

interface WorkerMessage {
  readonly type: string;
  readonly [key: string]: unknown;
}

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

function observeRefusedRoute(port: number): Promise<{
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

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (raw === undefined) throw new Error('worker configuration missing');
  const config = JSON.parse(raw) as WorkerConfig;
  let controllerCalls = 0;
  const controller = {
    id: 'provider-network-recovery-owned-route-fixture',
    perform: async (
      _request: RecoveryControllerRequest,
    ): Promise<RecoveryControllerResult> => {
      controllerCalls += 1;
      if (config.mode === 'restart') {
        const sessionId = config.request.expectedSession?.session_id;
        notify({
          type: 'native-request-needed',
          sessionId: sessionId ?? null,
          controllerCalls,
        });
        const result = await waitForParentMessage('native-attempt-result');
        const status = result.terminalStatus;
        const disposed = result.runtimeStopStatus === 'runtime_disposed';
        return status === 'http_200' &&
          disposed &&
          result.stopReason === 'stop' &&
          result.exactReply === true
          ? {
              disposition: 'submitted',
              detail: 'owned native OpenRouter request returned HTTP 200',
              observation: 'applied',
            }
          : {
              disposition: 'unknown',
              detail:
                typeof status === 'string'
                  ? status
                  : 'native provider result unavailable',
              observation: 'unknown',
            };
      }

      if (config.mode === 'unknown')
        return {
          disposition: 'unknown',
          detail: 'fixture represents an ambiguous provider effect',
          observation: 'unknown',
        };

      const observation = await observeRefusedRoute(config.port);
      notify({
        type: 'socket-observation',
        code: observation.code,
        bytesSent: observation.bytesSent,
        controllerCalls,
      });
      return observation.code === 'ECONNREFUSED' && observation.bytesSent === 0
        ? {
            disposition: 'unavailable',
            detail: 'owned loopback route refused before any request bytes',
            observation: 'none',
          }
        : {
            disposition: 'unknown',
            detail: 'owned route refusal was not proven before request bytes',
            observation: 'unknown',
          };
    },
  };

  const result = await executeRecovery(config.request, {
    controller,
    sleep: async (ms) => {
      if (config.mode !== 'crash-after-no-effect') return;
      notify({ type: 'retry-waiting', ms, controllerCalls });
      await waitForParentMessage('stop-after-no-effect');
      notify({ type: 'intentional-stop', code: 86 }, () => process.exit(86));
    },
  });
  notify(
    {
      type: 'result',
      status: result.status,
      retries: result.retries,
      controllerCalls,
      reservationCreated: result.reservation?.created ?? null,
      reservationOutcome: result.reservation?.outcome ?? null,
      reservationKey: result.reservation?.key ?? null,
      performedDisposition: result.performed?.disposition ?? null,
      performedObservation: result.performed?.observation ?? null,
    },
    () => child.disconnect?.(),
  );
}

void main().catch(() => {
  notify({ type: 'fatal', code: 'executor_worker_failed' }, () => {
    process.exitCode = 1;
    child.disconnect?.();
  });
});
