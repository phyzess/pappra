import { collaborationBindingUsage } from '../commands/collaboration-binding.js';
import { collaborationBootstrapUsage } from '../commands/collaboration-bootstrap.js';
import { collaborationCapabilitiesUsage } from '../commands/collaboration-capabilities.js';
import { collaborationHandoffUsage } from '../commands/collaboration-handoff.js';
import { collaborationMessageUsage } from '../commands/collaboration-message.js';
import { collaborationPlanUsage } from '../commands/collaboration-plan.js';
import { collaborationPreflightUsage } from '../commands/collaboration-preflight.js';
import { collaborationRecoveryRunUsage } from '../commands/collaboration-recovery-run.js';
import { collaborationRecoveryUsage } from '../commands/collaboration-recovery.js';
import { collaborationResourcesUsage } from '../commands/collaboration-resources.js';
import { collaborationRolloverUsage } from '../commands/collaboration-rollover.js';
import { collaborationStateUsage } from '../commands/collaboration-state.js';
import { collaborationTransitionUsage } from '../commands/collaboration-transition.js';
import { collaborationUsage } from '../commands/collaboration.js';
import { collaborationWorkRunUsage } from '../commands/collaboration-work-run.js';
import type { RoutingContext } from './context.js';

export async function handleHelp(
  context: RoutingContext,
): Promise<number | null> {
  const { values, output, json, info, action: collaborationAction } = context;
  if (values.help) {
    const usage =
      collaborationAction === 'recovery-run'
        ? collaborationRecoveryRunUsage
        : collaborationAction === 'work-run'
          ? collaborationWorkRunUsage
          : collaborationAction === 'transition' ||
              collaborationAction?.startsWith('transition:') === true
            ? collaborationTransitionUsage
            : collaborationAction === 'bootstrap' ||
                collaborationAction?.startsWith('bootstrap:') === true
              ? collaborationBootstrapUsage
              : collaborationAction === 'message' ||
                  collaborationAction?.startsWith('message:') === true
                ? collaborationMessageUsage
                : collaborationAction?.startsWith('capabilities:') === true
                  ? collaborationCapabilitiesUsage
                  : collaborationAction?.startsWith('state:') === true
                    ? collaborationStateUsage
                    : collaborationAction?.startsWith('resource:') === true
                      ? collaborationResourcesUsage
                      : collaborationAction?.startsWith('handoff:') === true
                        ? collaborationHandoffUsage
                        : collaborationAction?.startsWith('recovery:') === true
                          ? collaborationRecoveryUsage
                          : collaborationAction?.startsWith('binding:') === true
                            ? collaborationBindingUsage
                            : collaborationAction === 'plan'
                              ? collaborationPlanUsage
                              : collaborationAction?.startsWith('rollover:') ===
                                    true || collaborationAction === 'rollover'
                                ? collaborationRolloverUsage
                                : collaborationAction === 'preflight'
                                  ? collaborationPreflightUsage
                                  : collaborationUsage;
    if (json) {
      output.stdout(
        `${JSON.stringify({ ...info, commands: ['collab'], usage })}\n`,
      );
    } else {
      output.stdout(usage);
    }
    return 0;
  }
  return null;
}
