import {
  readManagedPiRequest,
  planManagedPiSession,
} from '../../app/managed-pi.js';
import {
  startManagedPiSession,
  requestManagedPiControl,
} from '../../hosts/pi/managed-session.js';
import type { CliOutput } from '../output.js';
import { watchManagedPiReadiness } from '../../app/managed-pi-readiness.js';
import { runManagedPiSdkRuntime } from '../../app/managed-pi-sdk-runtime.js';

export const sessionUsage =
  'pappra session <plan|start|status|fence|stop> --config <abs managed-pi.json> [--json]\n\n' +
  'plan validates a launch request without effects. start requires a visible terminal,\n' +
  'launches native Pi TUI with OpenRouter and preserves daily configuration.\n' +
  'Ingress is journaled; exact-child exit is separate from transfer-safe quiescence.\n' +
  'status/fence/stop address only the private endpoint created by that launch.\n' +
  'No existing interactive session is adopted. start does not accept --json.';

export async function runSessionCommand(
  options: {
    readonly action: string;
    readonly config: string | null;
    readonly json: boolean;
  },
  output: CliOutput,
): Promise<number> {
  try {
    if (options.config === null) throw new Error('--config is required.');
    const request = readManagedPiRequest(options.config);
    if (
      options.action === 'status' ||
      options.action === 'fence' ||
      options.action === 'stop'
    ) {
      const result = await requestManagedPiControl(
        `${request.journalPath}.control.json`,
        options.action === 'status' ? 'snapshot' : options.action,
      );
      output.stdout(
        `${JSON.stringify(result, null, options.json ? undefined : 2)}\n`,
      );
      if (options.action === 'stop') {
        const exit = result.exit;
        return result.ok === true &&
          typeof exit === 'object' &&
          exit !== null &&
          'status' in exit &&
          (exit.status === 'exited' || exit.status === 'runtime_disposed')
          ? 0
          : 1;
      }
      return result.ok === true ? 0 : 1;
    }
    if (options.action === 'plan') {
      output.stdout(
        `${JSON.stringify(planManagedPiSession(request), null, options.json ? undefined : 2)}\n`,
      );
      return 0;
    }
    if (options.action !== 'start')
      throw new Error('session accepts plan, start, status, fence or stop.');
    if (options.json)
      throw new Error('Native TUI start does not accept --json.');
    if (request.runtime === 'sdk') {
      if (!process.stdin.isTTY || !process.stdout.isTTY)
        throw new Error('SDK mode requires a visible native terminal.');
      return await runManagedPiSdkRuntime(request);
    }
    const { schema: _schema, readiness, ...launch } = request;
    const session = await startManagedPiSession(launch);
    let publisher: ReturnType<typeof watchManagedPiReadiness> | null = null;
    try {
      if (readiness)
        publisher = watchManagedPiReadiness(readiness, {
          sessionId: session.identity.sessionId,
          cwd: launch.cwd,
          metadataFile: `${launch.journalPath}.pi-events.jsonl`,
        });
    } catch {
      // Readiness failure does not terminate an otherwise owned, visible session.
      output.stderr(
        'Readiness watcher could not start; task preflight remains required.\n',
      );
    }
    const exit = await session.waitForExit().finally(() => publisher?.close());
    if (exit.status === 'exited') session.close();
    if (exit.status !== 'exited') {
      output.stderr(
        'Managed Pi child exit is unknown; inspect retained controller evidence.\n',
      );
      return 1;
    }
    return exit.exitCode === 0 ? 0 : 1;
  } catch (error) {
    const result = {
      ok: false,
      code: 'managed_pi_session_refused',
      message:
        error instanceof Error ? error.message : 'Managed Pi session failed.',
    };
    if (options.json) output.stdout(`${JSON.stringify(result)}\n`);
    else output.stderr(`${result.message}\n`);
    return 2;
  }
}
