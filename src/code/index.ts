export { CodeIntelligenceService, codeIdentityDigest } from './service.js';
export type {
  CodePrepareInput,
  CodeQueryInput,
  CodeQueryOutput,
  CodeStatusInput,
  CodeStatusResult,
} from './service.js';
export {
  CodeGraphProvider,
  codeGraphConfigDigest,
  codeGraphIndexPath,
  codeGraphVersion,
} from './providers/codegraph.js';
export type { CodeProvider } from './providers/codegraph.js';
export {
  codeRegistrationPath,
  readCodeRegistration,
  registrationMatches,
  writeCodeRegistration,
} from './registration.js';
export type {
  CodeEngine,
  CodeIdentity,
  CodeIndexCoverage,
  CodeIndexHealth,
  CodeIndexRegistration,
  CodePrepareAction,
  CodePreparePlan,
  CodePrepareResult,
  CodeQueryItem,
  CodeQueryKind,
  CodeQueryLimits,
  CodeQueryRequest,
  CodeQueryResult,
  CodeWorkingTree,
} from '../schemas/code.js';
