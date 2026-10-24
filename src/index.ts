export { getPackageInfo, getPackageRoot } from './package-info.js';
export type { PackageInfo } from './package-info.js';
export {
  HostAdapter,
  HostIntegrationService,
  type HostIntegrationOptions,
  type HostTargetOptions,
} from './hosts/integration/service.js';
export {
  mapNativeHookEvent,
  runHostHook,
  type HostHookOptions,
  type NativeHookMapping,
} from './hosts/integration/hook.js';
export * from './app/collaboration.js';
export * as collabWorkPlan from './collab/work-plan.js';
export * as collabRolePlan from './app/collab-role-plan.js';
export * as collabRoleOrchestration from './app/collab-role-orchestration.js';
export * as automaticHandoff from './app/collab-auto-handoff.js';
export * as collabWorkPlanInspection from './app/collab-work-plan.js';
export * as collabWorkExecution from './app/collab-work-execution.js';
export * as collabRecovery from './app/collab-recovery.js';
export * as collabRecoveryProjection from './app/collab-recovery-projection.js';
export * as collabRecoveryExecutor from './app/collab-recovery-executor.js';
export * as collabSessionTransition from './app/collab-session-transition.js';
export * as managedPi from './hosts/pi/managed-session.js';
