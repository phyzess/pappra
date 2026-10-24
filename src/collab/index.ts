import * as storeInternals from './store.js';
export * as canonical from './canonical.js';
export * as resources from './resources.js';
export * as envelope from './envelope.js';
export * as messages from './messages.js';
export * as lifecycle from './lifecycle.js';
export * as handoff from './handoff.js';
export * as notify from './notify.js';
export * as workPlan from './work-plan.js';
export * as rollover from './rollover.js';
export type * from './types.js';

// The public barrel curates the store surface. `breakLock` stays in
// `./store.js` because the operator-only `collab recovery lock-break` command
// owns the confirmation flow; exposing the bare primitive invites a caller to
// break a live writer's lock without that evidence.
const { breakLock: _unsafeBreakLock, ...storeSurface } = storeInternals;

export { storeSurface as store };
