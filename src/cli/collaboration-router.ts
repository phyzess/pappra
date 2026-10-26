import type { CliOutput } from './output.js';
import type { CliValues } from './options.js';
import type { getPackageInfo } from '../package-info.js';
import { runCollaborationWorkflowCli } from './commands/collaboration-workflow.js';
import type { RoutingContext } from './collaboration-routing/context.js';
import { handleHelp } from './collaboration-routing/help.js';
import {
  handleDirectRun,
  handleRecoveryRun,
  handleWorkRun,
} from './collaboration-routing/execution.js';
import {
  handleBootstrap,
  handleCapabilitiesDerive,
  handlePreflight,
  handleRecovery,
} from './collaboration-routing/native.js';
import { handleState } from './collaboration-routing/state.js';
import { handleResources } from './collaboration-routing/resources.js';
import { handleHandoff } from './collaboration-routing/handoff.js';
import {
  handleBinding,
  handlePlan,
  handleRollover,
  handleTransition,
} from './collaboration-routing/routing.js';
import { handleMessages } from './collaboration-routing/messages.js';

/** Everything the collaboration router needs from one parsed command line. */
export interface CollaborationRouteRequest {
  readonly values: CliValues;
  /** The resolved `collab` action, e.g. `message:send` or `role-run`. */
  readonly action: string | null;
  /** Raw argv, for duplicate-flag detection the parser cannot observe. */
  readonly args: readonly string[];
  readonly info: ReturnType<typeof getPackageInfo>;
  readonly rpcRequestTimeout: string | undefined;
  readonly rpcOperationTimeout: string | undefined;
  readonly output: CliOutput;
  readonly json: boolean;
}

export async function routeCollaboration(
  request: CollaborationRouteRequest,
): Promise<number> {
  const { values, args, info, output, json } = request;
  const rawWorkflow = request.action?.startsWith('workflow') === true;
  if (rawWorkflow) {
    // Normally intercepted before the global parser in run.ts; this keeps the router honest
    // if a caller reaches it with parsed flags instead of raw argv.
    const index = args.indexOf('workflow');
    return runCollaborationWorkflowCli(
      index === -1 ? [] : args.slice(index + 1),
      output,
    );
  }
  const context: RoutingContext = {
    values,
    args,
    info,
    action: request.action,
    rpcRequestTimeout: request.rpcRequestTimeout,
    rpcOperationTimeout: request.rpcOperationTimeout,
    output,
    json,
  };
  const handleHelpOutcome = await handleHelp(context);
  if (handleHelpOutcome !== null) return handleHelpOutcome;
  const handleWorkRunOutcome = await handleWorkRun(context);
  if (handleWorkRunOutcome !== null) return handleWorkRunOutcome;
  const handleRecoveryRunOutcome = await handleRecoveryRun(context);
  if (handleRecoveryRunOutcome !== null) return handleRecoveryRunOutcome;
  const handleCapabilitiesDeriveOutcome =
    await handleCapabilitiesDerive(context);
  if (handleCapabilitiesDeriveOutcome !== null)
    return handleCapabilitiesDeriveOutcome;
  const handleStateOutcome = await handleState(context);
  if (handleStateOutcome !== null) return handleStateOutcome;
  const handleResourcesOutcome = await handleResources(context);
  if (handleResourcesOutcome !== null) return handleResourcesOutcome;
  const handleHandoffOutcome = await handleHandoff(context);
  if (handleHandoffOutcome !== null) return handleHandoffOutcome;
  const handleRecoveryOutcome = await handleRecovery(context);
  if (handleRecoveryOutcome !== null) return handleRecoveryOutcome;
  const handleBindingOutcome = await handleBinding(context);
  if (handleBindingOutcome !== null) return handleBindingOutcome;
  const handleTransitionOutcome = await handleTransition(context);
  if (handleTransitionOutcome !== null) return handleTransitionOutcome;
  const handleRolloverOutcome = await handleRollover(context);
  if (handleRolloverOutcome !== null) return handleRolloverOutcome;
  const handlePlanOutcome = await handlePlan(context);
  if (handlePlanOutcome !== null) return handlePlanOutcome;
  const handleBootstrapOutcome = await handleBootstrap(context);
  if (handleBootstrapOutcome !== null) return handleBootstrapOutcome;
  const handlePreflightOutcome = await handlePreflight(context);
  if (handlePreflightOutcome !== null) return handlePreflightOutcome;
  const handleMessagesOutcome = await handleMessages(context);
  if (handleMessagesOutcome !== null) return handleMessagesOutcome;
  const handleDirectRunOutcome = await handleDirectRun(context);
  if (handleDirectRunOutcome !== null) return handleDirectRunOutcome;
  // Unreachable: handleDirectRun always returns an exit code (the command's result for
  // prepare/run/query, 2 for an unknown action), so the chain cannot fall through.
  return 2;
}
