/**
 * Project-local self-host entry. Node >= 24 executes this file directly
 * (`node scripts/self-host.ts`), so it imports the source modules with explicit
 * `.ts` specifiers; `tsconfig.scripts.json` and `tsconfig.test.json` rewrite
 * those specifiers when the same graph is emitted.
 *
 * The implementation lives in cohesive modules under `scripts/self-host/`. This
 * file keeps the public surface (19 runtime exports plus the CLI types) and the
 * direct-invocation entry, and it never writes or spawns anything itself.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDeps, parseEntryOptions } from './self-host/cli.ts';
import { collectChecks, formatChecks } from './self-host/checks.ts';
import { applyFixes } from './self-host/apply.ts';
import type { CliDeps, EntryOptions } from './self-host/types.ts';

export {
  CANONICAL_SKILL_FILE,
  HOST_SKILL_DIRS,
  HOST_SKILL_ORDER,
  PACKAGE_NAME,
  SKILL_ALIAS_TARGET,
  SKILL_SOURCE,
  parseJsonObject,
} from './self-host/types.ts';
export type {
  Admission,
  AdmissionCheckId,
  CheckState,
  CliDeps,
  CliResult,
  EntryOptions,
  HostSkillDir,
  SelfHostCheck,
  SkillAliasPaths,
  SkillAliasState,
} from './self-host/types.ts';
export { admit } from './self-host/admission.ts';
export {
  applySkillAlias,
  applySkillAliases,
  inspectSkillAlias,
  skillAliasPaths,
} from './self-host/aliases.ts';
export { defaultDeps, parseEntryOptions, runDistCli } from './self-host/cli.ts';
export { applyFixes } from './self-host/apply.ts';
export { collectChecks, formatChecks } from './self-host/checks.ts';

/**
 * Runs one entry invocation: apply when asked, then report the convergence
 * state. Apply and check share one dependency seam so a single invocation
 * cannot mix a fake and a real CLI.
 */
export function runSelfHost(
  root: string,
  options: EntryOptions,
  deps: CliDeps = defaultDeps(root),
): number {
  const actions = options.apply ? applyFixes(root, deps) : [];
  const checks = collectChecks(root, deps);
  const converged = checks.every((check) => check.state === 'ok');
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ checks, actions, converged }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(formatChecks(checks, actions));
  }
  return converged ? 0 : 1;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (invokedDirectly()) {
  const options = parseEntryOptions(process.argv.slice(2));
  if (options === null) {
    process.stderr.write(
      'self-host: use --check (default), --apply and optionally --json\n',
    );
    process.exitCode = 2;
  } else {
    process.exitCode = runSelfHost(process.cwd(), options);
  }
}
