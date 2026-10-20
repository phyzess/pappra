import { z } from 'zod';
import { createDiagnostic, pointer, type Diagnostic } from './diagnostics.js';
import { diagnosticCodes } from './errors.js';
import { hostSchema } from './machine.js';
import { workspaceCodeSchema, workspaceKnowledgeSchema } from './workspace.js';

export const INIT_CHOICES_SCHEMA = 'pappra/init-choices/1';
export const INIT_PLAN_SCHEMA = 'pappra/init-plan/1';

const identifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const initRepositoryChoiceSchema = z.strictObject({
  /** Discovered repository key: workspace-relative path or external:<id>. */
  path: z.string().min(1).max(2048),
  id: identifierSchema.optional(),
  access: z.enum(['read', 'write']),
});

/**
 * High-level, UI-independent init selections. Candidate validation IDs refer
 * to WorkspaceDiscovery.validationCandidates; repository paths refer to
 * discovered checkout keys.
 */
export const initChoicesSchema = z.strictObject({
  schema: z.literal(INIT_CHOICES_SCHEMA),
  name: z.string().min(1).max(200).optional(),
  workspaceId: z.uuid().optional(),
  repositories: z.array(initRepositoryChoiceSchema).max(128),
  knowledge: workspaceKnowledgeSchema,
  code: workspaceCodeSchema,
  validation: z.array(z.string().min(1).max(1024)).max(128),
  excludes: z.array(z.string().min(1).max(2048)).max(128),
  hosts: z.array(hostSchema).max(16),
});

export const plannedFileChangeSchema = z.strictObject({
  path: z.string().min(1).max(2048),
  operation: z.enum(['create', 'merge', 'replace-managed']),
  expectedBeforeDigest: digestSchema.nullable(),
  nextDigest: digestSchema,
  backupRequired: z.boolean(),
  owner: z.literal('pappra'),
});

export const initExternalActionSchema = z.strictObject({
  kind: z.enum(['install-runtime', 'install-provider', 'prepare-index']),
  target: z.string().min(1).max(256),
  version: z.string().min(1).max(256).nullable(),
});

export const initPlanSchema = z.strictObject({
  schema: z.literal(INIT_PLAN_SCHEMA),
  planId: z.uuid(),
  workspaceRoot: z.string().min(1).max(4096),
  discoveredAt: z.iso.datetime({ offset: true }),
  configurationDigest: digestSchema,
  files: z.array(plannedFileChangeSchema).max(256),
  externalActions: z.array(initExternalActionSchema).max(128),
});

export type InitChoices = z.infer<typeof initChoicesSchema>;
export type InitRepositoryChoice = z.infer<typeof initRepositoryChoiceSchema>;
export type InitPlan = z.infer<typeof initPlanSchema>;
export type InitExternalAction = z.infer<typeof initExternalActionSchema>;
export type PlannedFileChange = z.infer<typeof plannedFileChangeSchema>;
export type PlannedFileOperation = PlannedFileChange['operation'];

export interface InitChoicesParseResult {
  readonly value: InitChoices | null;
  readonly diagnostics: readonly Diagnostic[];
}

function issuePointer(path: readonly PropertyKey[]): string | null {
  return path.length === 0
    ? null
    : pointer(...path.map((segment) => String(segment)));
}

/** Decodes external --config input without applying defaults or partial data. */
export function parseInitChoices(
  value: unknown,
  source: string,
): InitChoicesParseResult {
  const parsed = initChoicesSchema.safeParse(value);
  if (parsed.success) return { value: parsed.data, diagnostics: [] };
  const diagnostics: Diagnostic[] = [];
  for (const issue of parsed.error.issues) {
    if (issue.code === 'unrecognized_keys') {
      const base = issuePointer(issue.path);
      for (const key of issue.keys) {
        diagnostics.push(
          createDiagnostic({
            code: diagnosticCodes.initInvalidInput,
            severity: 'error',
            message: `Unknown init selection key "${key}".`,
            source,
            pointer: `${base === null ? '' : base}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`,
            hint: 'Remove the key; init choices do not accept arbitrary extensions.',
          }),
        );
      }
      continue;
    }
    diagnostics.push(
      createDiagnostic({
        code: diagnosticCodes.initInvalidInput,
        severity: 'error',
        message: issue.message,
        source,
        pointer: issuePointer(issue.path),
        hint: 'Use pappra/init-choices/1 fields and values; Pappra does not coerce selections.',
      }),
    );
  }
  return { value: null, diagnostics };
}
