// Curated experimental surface for the 0.1.0 beta.
//
// The beta publishes a compact map: the core subpaths, this barrel, and its Pi
// adapter (`pappra/experimental/pi`). Collaboration and managed-Pi
// implementations stay private to `src/app` and `src/hosts`, and the
// namespaces below are the supported way to reach them — so those files may
// move without a new published path to maintain.
//
// There is no per-surface subpath and no compatibility shim for the narrower
// beta map: import the namespace you need from here, or from the Pi adapter.
export * as collaboration from '../app/collaboration.js';
export * as collabAdmission from '../collab/admission.js';
export * as collabRolePlan from '../app/collab-role-plan.js';
export * as collabRoleOrchestration from '../app/collab-role-orchestration.js';
export * as collabAutomaticHandoff from '../app/collab-auto-handoff.js';
export * as collabWorkPlanInspection from '../app/collab-work-plan.js';
export * as collabWorkExecution from '../app/collab-work-execution.js';
export * as collabRecovery from '../app/collab-recovery.js';
export * as collabRecoveryProjection from '../app/collab-recovery-projection.js';
export * as collabRecoveryExecutor from '../app/collab-recovery-executor.js';
export * as collabSessionTransition from '../app/collab-session-transition.js';
export * as collabWorkPlan from '../collab/work-plan.js';

// Managed-Pi surfaces have their own entrypoint, and are composed here so one
// import covers the whole experimental surface.
export * from './pi.js';
