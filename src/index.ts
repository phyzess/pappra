export { getPackageInfo } from './package-info.js';
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
