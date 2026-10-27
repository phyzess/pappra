/**
 * Claude Code SessionStart hook for this repository. It does not start work, select roles or
 * write anything: it tells the agent that Pappra's own capabilities apply here and reports
 * which setup steps are still missing. Node >= 24 runs it directly, like `self-host.ts`.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectChecks } from './self-host/checks.ts';
import { defaultDeps } from './self-host/cli.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function setupNotes(): string {
  try {
    const open = collectChecks(root, defaultDeps(root)).filter(
      (check) => check.state !== 'ok',
    );
    if (open.length === 0) return 'Setup: every self-host check is ok.';
    return [
      'Setup needs attention before relying on Pappra:',
      ...open.map(
        (check) =>
          `- ${check.id}: ${check.detail}${
            check.command === null ? '' : ` (run: ${check.command})`
          }`,
      ),
    ].join('\n');
  } catch {
    return 'Setup state is unknown; run `pnpm dev:check`.';
  }
}

const context = [
  'This repository is Pappra itself, so its own capabilities are mandatory here, not optional.',
  '1. Invoke the `pappra` skill now (skills/pappra/SKILL.md) before any repository work.',
  '2. Use `node dist/cli/main.js` for every Pappra command; never a globally installed `pappra`.',
  '3. Locate code with `node dist/cli/main.js code query --repo pappra --kind explore --query "<symbol or question>" --json` before grep or broad reads.',
  '4. For a change that is not a trivial local edit, follow AGENTS.md: assess scope, split disjoint work and arrange independent review through `collab workflow`.',
  setupNotes(),
].join('\n');

process.stdout.write(
  `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  })}\n`,
);
