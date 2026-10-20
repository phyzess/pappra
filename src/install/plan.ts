import { randomUUID } from 'node:crypto';
import type { InitExternalAction, InitPlan } from '../schemas/init.js';
import { initPlanSchema, type PlannedFileOperation } from '../schemas/init.js';
import { isPortableRelativePath } from '../schemas/paths.js';
import { sha256Digest } from '../infra/fs.js';

export interface PlannedFileContent {
  readonly path: string;
  readonly operation: PlannedFileOperation;
  readonly bytes: Buffer;
  readonly digest: string;
  readonly diff: string;
}

export interface InitFileInput {
  readonly path: string;
  readonly bytes: Buffer;
  readonly beforeText?: string | null;
  readonly operation?: PlannedFileOperation;
  readonly expectedBeforeDigest?: string | null;
  readonly backupRequired?: boolean;
}

export interface BuildInitPlanInput {
  readonly workspaceRoot: string;
  readonly configurationDigest: string;
  readonly files: readonly InitFileInput[];
  readonly externalActions?: readonly InitExternalAction[];
  readonly planId?: string;
  readonly discoveredAt?: string;
}

export interface BuiltInitPlan {
  readonly plan: InitPlan;
  readonly writes: readonly PlannedFileContent[];
}

function splitLines(value: string): readonly string[] {
  if (value === '') return [];
  const lines = value.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * Produces a bounded, human-reviewable line diff. P03 plans new files; the
 * replacement path is retained for future managed-file operations.
 */
export function unifiedFileDiff(
  path: string,
  before: string | null,
  after: string,
): string {
  if (before === after) return '';
  const beforeLines = splitLines(before ?? '');
  const afterLines = splitLines(after);
  const lines: string[] = [
    before === null ? '--- /dev/null' : `--- a/${path}`,
    `+++ b/${path}`,
  ];
  if (before === null) {
    lines.push(`@@ -0,0 +1,${afterLines.length} @@`);
    for (const line of afterLines) lines.push(`+${line}`);
    return `${lines.join('\n')}\n`;
  }

  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] ===
      afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = beforeLines.slice(prefix, beforeLines.length - suffix);
  const added = afterLines.slice(prefix, afterLines.length - suffix);
  lines.push(
    `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`,
  );
  for (const line of removed) lines.push(`-${line}`);
  for (const line of added) lines.push(`+${line}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Builds the strict persisted InitPlan plus the exact bytes needed by apply.
 * Plan JSON never includes file contents; diffs stay in the runtime bundle.
 */
export function buildInitPlan(input: BuildInitPlanInput): BuiltInitPlan {
  const writes: PlannedFileContent[] = [];
  const files = input.files.map((file) => {
    if (!isPortableRelativePath(file.path)) {
      throw new Error(
        `Planned file path is not workspace-relative: ${file.path}`,
      );
    }
    const operation = file.operation ?? 'create';
    const expectedBeforeDigest = file.expectedBeforeDigest ?? null;
    const digest = sha256Digest(file.bytes);
    writes.push({
      path: file.path,
      operation,
      bytes: file.bytes,
      digest,
      diff: unifiedFileDiff(
        file.path,
        file.beforeText ?? null,
        file.bytes.toString('utf8'),
      ),
    });
    return {
      path: file.path,
      operation,
      expectedBeforeDigest,
      nextDigest: digest,
      backupRequired: file.backupRequired ?? operation !== 'create',
      owner: 'pappra' as const,
    };
  });

  const plan: InitPlan = {
    schema: 'pappra/init-plan/1',
    planId: input.planId ?? randomUUID(),
    workspaceRoot: input.workspaceRoot,
    discoveredAt: input.discoveredAt ?? new Date().toISOString(),
    configurationDigest: input.configurationDigest,
    files,
    externalActions: [...(input.externalActions ?? [])],
  };
  const parsed = initPlanSchema.safeParse(plan);
  if (!parsed.success) {
    throw new Error(
      `Internal init plan is invalid: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`,
    );
  }
  return { plan: parsed.data, writes };
}
