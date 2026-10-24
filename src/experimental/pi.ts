// Pi adapter barrel: managed-Pi runtime and opt-in host extensions.
//
// Exposed as `@phyzess/pappra/experimental/pi` because these namespaces pin an
// observed Pi integration and are the most likely to change between beta
// releases. The native managed-Pi controllers stay under `src/hosts`; the
// recovery and transition composition lives in `src/adapters/pi`. This barrel
// claims no native capability that the pinned host version has not been
// observed to provide.
export * as piManaged from '../hosts/pi/managed-session.js';
export * as piManagedSdk from '../hosts/pi/managed-sdk-session.js';
export * as piRecovery from '../adapters/pi/recovery-extension.js';
export * as piSessionTransition from '../adapters/pi/session-transition-extension.js';
