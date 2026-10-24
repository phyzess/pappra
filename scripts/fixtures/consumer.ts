import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageName: string = '@phyzess/pappra';
const api: unknown = await import(packageName);
assert(typeof api === 'object' && api !== null);
assert('getPackageInfo' in api && typeof api.getPackageInfo === 'function');
const info: unknown = api.getPackageInfo();
assert(typeof info === 'object' && info !== null);
assert('name' in info && info.name === packageName);
assert('version' in info && info.version === process.argv[2]);

const manifestUrl = new URL(
  './assets/manifest.json',
  import.meta.resolve('@phyzess/pappra/package.json'),
);
const manifest: unknown = JSON.parse(readFileSync(manifestUrl, 'utf8'));
assert(typeof manifest === 'object' && manifest !== null);
assert('schema' in manifest && manifest.schema === 'pappra/assets/1');
for (const [subpath, required] of [
  ['collab', ['store', 'resources', 'messages', 'handoff']],
  [
    'experimental',
    [
      'collaboration',
      'collabAdmission',
      'collabRolePlan',
      'collabRecovery',
      'collabRecoveryExecutor',
      'collabRecoveryProjection',
      'collabSessionTransition',
      'collabWorkPlan',
      'collabWorkPlanInspection',
      'collabWorkExecution',
      'piManaged',
      'piManagedSdk',
      'piRecovery',
      'piSessionTransition',
    ],
  ],
  [
    'experimental/pi',
    ['piManaged', 'piManagedSdk', 'piRecovery', 'piSessionTransition'],
  ],
  [
    'hosts',
    [
      'codex',
      'claude',
      'piRpc',
      'piHistory',
      'pilot',
      'HostIntegrationService',
      'HostAdapter',
      'runHostHook',
    ],
  ],
  [
    'workspace',
    [
      'discoverWorkspace',
      'resolveWorkspaceRoot',
      'inspectWorkspaceConfig',
      'inspectMachineConfig',
    ],
  ],
  [
    'schemas',
    [
      'workspaceConfigSchema',
      'machineConfigSchema',
      'evidenceRefSchema',
      'initChoicesSchema',
      'initPlanSchema',
      'collaborationGoalSchema',
      'collaborationPreparedSchema',
      'collaborationCommandSchema',
      'collaborationEventSchema',
      'doctorReportSchema',
      'documentRecordSchema',
      'documentCatalogSchema',
      'taskContextSchema',
      'checkpointSchema',
      'resumePacketSchema',
      'codeIdentitySchema',
      'codeIndexHealthSchema',
      'codeQueryRequestSchema',
      'codeQueryResultSchema',
      'codePreparePlanSchema',
      'codePrepareResultSchema',
      'codeIndexRegistrationSchema',
      'hostCapabilitiesSchema',
      'hostIntegrationPlanSchema',
      'hostVerificationSchema',
      'hostHookInputSchema',
      'hostHookResultSchema',
      'hostBundleSchema',
      'hostInstallManifestSchema',
      'runtimeManifestSchema',
      'workspaceInstallManifestSchema',
      'installJournalSchema',
      'diagnosticCodes',
    ],
  ],
  ['doctor', ['runDoctor']],
  ['knowledge', ['KnowledgeService']],
  ['continuity', ['CheckpointService']],
  ['code', ['CodeIntelligenceService', 'CodeGraphProvider']],
  [
    'init',
    [
      'inspectInitContext',
      'planWorkspaceInit',
      'applyInitPlan',
      'resolveInitRoot',
      'listRepositoryCandidates',
    ],
  ],
  [
    'install',
    [
      'installRuntime',
      'inspectRuntimeState',
      'removeRuntime',
      'rollbackWorkspaceInstall',
      'uninstallWorkspaceManagedFiles',
      'updateMachineRuntime',
      'readWorkspaceManifest',
    ],
  ],
] as const) {
  const specifier: string = `${packageName}/${subpath}`;
  const loaded: unknown = await import(specifier);
  assert(typeof loaded === 'object' && loaded !== null);
  for (const name of required)
    assert(name in loaded, `Missing installed export ${specifier}.${name}`);
}
interface SchemaLike {
  safeParse(value: unknown): { readonly success: boolean };
}
const schemaApi: unknown = await import(`${packageName}/schemas`);
assert(typeof schemaApi === 'object' && schemaApi !== null);
assert('workspaceConfigSchema' in schemaApi);
const schema = schemaApi.workspaceConfigSchema;
assert(typeof schema === 'object' && schema !== null);
assert('safeParse' in schema && typeof schema.safeParse === 'function');
const parsed = (schema as SchemaLike).safeParse({});
assert.equal(parsed.success, false);
interface HostPlanLike {
  readonly bundleDigest: string;
  readonly files: readonly { readonly path: string }[];
}
interface HostServiceLike {
  plan(host: 'pi'): Promise<HostPlanLike>;
}
interface HostApiLike {
  readonly HostIntegrationService: new (options: {
    readonly root: string;
    readonly homeDir: string;
    readonly pathEnv: string;
    readonly hostVersion: string;
    readonly observedAt: string;
    readonly versionProbe: () => string | null;
  }) => HostServiceLike;
}
const hostApi = (await import(
  `${packageName}/hosts`
)) as unknown as HostApiLike;
const hostPlan = await new hostApi.HostIntegrationService({
  root: process.cwd(),
  homeDir: process.cwd(),
  pathEnv: '',
  hostVersion: '1.3.0',
  observedAt: '2026-10-19T00:00:00.000Z',
  // This consumer checks packaged assets and API loading, independently of
  // which native hosts happen to be installed on the packaging machine.
  versionProbe: () => '1.3.0',
}).plan('pi');
assert(hostPlan.bundleDigest.startsWith('sha256:'));
assert(hostPlan.files.some((file) => file.path === 'skills/pappra/SKILL.md'));
assert(
  hostPlan.files.some((file) => file.path === 'extensions/pappra/index.ts'),
);
console.log(
  'Installed ESM API, schema runtime dependency, and bundled assets passed.',
);
