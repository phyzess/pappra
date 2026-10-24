import { createConnection, type Socket } from 'node:net';

import {
  executeRecovery,
  type RecoveryControllerRequest,
  type RecoveryControllerResult,
  type RecoveryExecutionRequest,
} from '../../src/app/collab-recovery-executor.js';

interface WorkerConfig {
  readonly mode: 'crash-after-disconnect' | 'execute' | 'safe-retry';
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

function waitForParentMessage(type: string): Promise<void> {
  return new Promise((resolve) => {
    const listener = (message: unknown): void => {
      if (
        typeof message !== 'object' ||
        message === null ||
        (message as Record<string, unknown>).type !== type
      )
        return;
      process.off('message', listener);
      resolve();
    };
    process.on('message', listener);
  });
}

function loopbackDispatch(
  config: WorkerConfig,
  request: RecoveryControllerRequest,
  callNumber: number,
): Promise<RecoveryControllerResult> {
  return new Promise((resolve) => {
    let connected = false;
    let sent = false;
    let settled = false;
    let response = '';
    const socket: Socket = createConnection({
      host: '127.0.0.1',
      port: config.port,
    });
    const finish = (result: RecoveryControllerResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      connected = true;
      const frame = {
        kind: request.kind,
        is_recovery_wake: request.cause.is_recovery_wake,
        task_id: request.cause.task_id,
        action_key: request.cause.action_key,
        cause: request.cause,
        attempt: callNumber,
        text: request.text,
      };
      sent = true;
      socket.write(`${JSON.stringify(frame)}\n`);
    });
    socket.on('data', (chunk: string) => {
      response += chunk;
      const newline = response.indexOf('\n');
      if (newline < 0) return;
      let acknowledgement: unknown;
      try {
        acknowledgement = JSON.parse(response.slice(0, newline)) as unknown;
      } catch {
        finish({
          disposition: 'failed',
          detail: 'loopback acknowledgement was not valid JSON',
          observation: 'unknown',
        });
        socket.destroy();
        return;
      }
      if (
        typeof acknowledgement === 'object' &&
        acknowledgement !== null &&
        (acknowledgement as Record<string, unknown>).status === 'queued'
      ) {
        finish({
          disposition: 'submitted',
          detail: 'controlled loopback service acknowledged queue admission',
          observation: 'queued',
        });
        socket.end();
      } else {
        finish({
          disposition: 'failed',
          detail: 'loopback service returned an unsupported acknowledgement',
          observation: 'unknown',
        });
        socket.destroy();
      }
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (!connected && !sent) {
        if (config.mode === 'safe-retry')
          notify({
            type: 'pre-dispatch-no-effect',
            code: error.code ?? 'UNKNOWN',
            bytesSent: false,
          });
        finish({
          disposition: 'unavailable',
          detail: `${error.code ?? 'socket error'} before connect; no request bytes were sent`,
          observation: 'none',
        });
      }
      // After connect/write, wait for close to classify the outcome as ambiguous.
    });
    socket.on('close', (hadError: boolean) => {
      if (settled || !sent) return;
      if (config.mode === 'crash-after-disconnect') {
        notify({ type: 'post-dispatch-disconnect', hadError }, () =>
          process.exit(86),
        );
        return;
      }
      finish({
        disposition: 'failed',
        detail:
          'socket disconnected after request bytes were sent without an acknowledgement',
        observation: 'unknown',
      });
    });
  });
}

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (raw === undefined) throw new Error('worker config argument is required');
  const config = JSON.parse(raw) as WorkerConfig;
  let controllerCalls = 0;
  const controller = {
    id: 'controlled-loopback-network-fault',
    perform: async (
      request: RecoveryControllerRequest,
    ): Promise<RecoveryControllerResult> => {
      controllerCalls += 1;
      return loopbackDispatch(config, request, controllerCalls);
    },
  };
  const result = await executeRecovery(config.request, {
    controller,
    sleep: async (ms) => {
      if (config.mode !== 'safe-retry') return;
      notify({ type: 'retry-waiting', ms });
      await waitForParentMessage('retry-proceed');
    },
  });
  notify(
    {
      type: 'result',
      status: result.status,
      retries: result.retries,
      controllerCalls,
      notes: result.notes,
      reservation: result.reservation,
    },
    () => child.disconnect?.(),
  );
}

void main().catch((error: unknown) => {
  notify(
    {
      type: 'fatal',
      error: error instanceof Error ? error.message : String(error),
    },
    () => {
      process.exitCode = 1;
      child.disconnect?.();
    },
  );
});
