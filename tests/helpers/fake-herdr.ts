import type { HerdrBootstrapOps } from '../../src/app/collab-bootstrap-transport.js';
import type {
  CommandResult,
  CommandRunner,
  HerdrAgentObservation,
  HerdrCallerResult,
  HerdrTransport,
} from '../../src/app/collab-notify.js';

type TransportHandlers = Omit<HerdrTransport, 'id'>;
type BootstrapHandlers = Omit<HerdrBootstrapOps, 'id' | 'transport'>;

export function createFakeHerdr(
  options: {
    readonly id?: string;
    readonly agents?: readonly HerdrAgentObservation[];
    readonly caller?: HerdrCallerResult;
    readonly transport?: Partial<TransportHandlers>;
    readonly bootstrap?: Partial<BootstrapHandlers>;
    readonly commands?: Readonly<Record<string, readonly CommandResult[]>>;
    readonly run?: CommandRunner;
  } = {},
) {
  const state = {
    agents: options.agents ?? [],
    calls: [] as { operation: string; args: readonly unknown[] }[],
    commands: new Map(
      Object.entries(options.commands ?? {}).map(([operation, steps]) => [
        operation,
        [...steps],
      ]),
    ),
  };
  function record<Args extends unknown[], Result>(
    operation: string,
    handler: (...args: Args) => Promise<Result>,
  ): (...args: Args) => Promise<Result> {
    return async (...args) => {
      state.calls.push({ operation, args });
      return handler(...args);
    };
  }
  function unexpected(operation: string): () => Promise<never> {
    return async () => {
      throw new Error(`Unscripted fake Herdr operation: ${operation}`);
    };
  }
  const transport: HerdrTransport = {
    id: options.id ?? 'fake-herdr',
    verifyCaller: record(
      'transport.verifyCaller',
      options.transport?.verifyCaller ??
        (async () =>
          options.caller ?? {
            ok: false,
            status: 'unverified',
            code: 'test',
            detail: 'test',
          }),
    ),
    list: record(
      'agent.list',
      options.transport?.list ??
        (async () => ({ ok: true, agents: state.agents })),
    ),
    prompt: record(
      'agent.prompt',
      options.transport?.prompt ?? unexpected('agent.prompt'),
    ),
  };
  const handlers = options.bootstrap;
  const ops: HerdrBootstrapOps = {
    id: options.id ?? 'fake-herdr-bootstrap',
    transport,
    verifyCaller: record(
      'bootstrap.verifyCaller',
      handlers?.verifyCaller ??
        (async (paneId) =>
          transport.verifyCaller(paneId == null ? undefined : { paneId })),
    ),
    listAgents: record(
      'bootstrap.listAgents',
      handlers?.listAgents ?? (() => transport.list()),
    ),
    paneGet: record('pane.get', handlers?.paneGet ?? unexpected('pane.get')),
    paneProcessInfo: record(
      'pane.process-info',
      handlers?.paneProcessInfo ?? unexpected('pane.process-info'),
    ),
    paneLayout: record(
      'pane.layout',
      handlers?.paneLayout ?? unexpected('pane.layout'),
    ),
    splitPane: record(
      'pane.split',
      handlers?.splitPane ?? unexpected('pane.split'),
    ),
    startAgent: record(
      'agent.start',
      handlers?.startAgent ?? unexpected('agent.start'),
    ),
    ...(handlers?.startManagedSdk === undefined
      ? {}
      : {
          startManagedSdk: record(
            'agent.start-managed-sdk',
            handlers.startManagedSdk,
          ),
        }),
    closePane: record(
      'pane.close',
      handlers?.closePane ?? unexpected('pane.close'),
    ),
  };
  const run: CommandRunner = async (command, args, ...rest) => {
    const operation = args.slice(0, 2).join('.');
    state.calls.push({ operation, args: [command, args, ...rest] });
    const steps = state.commands.get(operation);
    if (steps !== undefined) {
      const response = steps.shift();
      if (response === undefined)
        throw new Error(`Fake Herdr script exhausted: ${operation}`);
      return response;
    }
    return options.run
      ? options.run(command, args, ...rest)
      : unexpected(operation)();
  };
  return { state, transport, ops, run };
}

export function createFixtureClock(start: number) {
  let current = start;
  const waits: number[] = [];
  return {
    now: () => current,
    set: (value: number) => {
      current = value;
    },
    advance: (milliseconds: number) => {
      current += milliseconds;
    },
    sleep: async (milliseconds: number) => {
      waits.push(milliseconds);
      current += milliseconds;
    },
    waits,
  };
}
