import { parseArgs } from 'node:util';
import { repairUsage, runRepairCommand } from '../commands/repair.js';
import { sessionUsage, runSessionCommand } from '../commands/session.js';
import { runCollaborationWorkflowCli } from '../commands/collaboration-workflow.js';
import { runContextCli } from '../commands/context.js';
import { runDocsReviewCli } from '../commands/docs-review.js';
import { runRuntimeArchiveCli } from '../commands/runtime-archive.js';
import { failure } from '../options.js';
import { isInteractiveTerminal } from '../interactive.js';
import type { CliOutput } from '../output.js';
import type { CliRouteResult } from './context.js';

export function routeDirect(
  args: readonly string[],
  output: CliOutput,
): CliRouteResult {
  const jsonRequested = args.includes('--json');
  if (args[0] === 'runtime' && args[1] === 'archive') {
    return runRuntimeArchiveCli(args.slice(2), output);
  }
  if (args[0] === 'repair') {
    try {
      const parsedRepair = parseArgs({
        args: [...args.slice(1)],
        options: {
          root: { type: 'string' },
          'runtime-version': { type: 'string' },
          'install-id': { type: 'string' },
          apply: { type: 'boolean' },
          'quarantine-unowned-locks': { type: 'boolean' },
          'reset-local': { type: 'boolean' },
          'all-writers-stopped': { type: 'boolean' },
          'no-interactive': { type: 'boolean' },
          json: { type: 'boolean' },
          help: { type: 'boolean', short: 'h' },
        },
        allowPositionals: false,
        strict: true,
      });
      if (
        ['--root', '--runtime-version', '--install-id'].some(
          (flag) =>
            args.filter((arg) => arg === flag || arg.startsWith(`${flag}=`))
              .length > 1,
        )
      )
        throw new Error('Repair options must not be repeated.');
      if (parsedRepair.values.help) {
        output.stdout(repairUsage);
        return 0;
      }
      return runRepairCommand(
        {
          root: parsedRepair.values.root ?? process.cwd(),
          ...(parsedRepair.values['runtime-version'] === undefined
            ? {}
            : { runtimeVersion: parsedRepair.values['runtime-version'] }),
          ...(parsedRepair.values['install-id'] === undefined
            ? {}
            : { installId: parsedRepair.values['install-id'] }),
          apply: parsedRepair.values.apply === true,
          quarantineUnownedLocks:
            parsedRepair.values['quarantine-unowned-locks'] === true,
          resetLocal: parsedRepair.values['reset-local'] === true,
          allWritersStopped:
            parsedRepair.values['all-writers-stopped'] === true,
          json: parsedRepair.values.json === true,
          interactive: isInteractiveTerminal({
            json: parsedRepair.values.json === true,
            noInteractive: parsedRepair.values['no-interactive'] === true,
          }),
        },
        output,
      );
    } catch (error) {
      failure(output, jsonRequested, 'invalid_arguments', error);
      return 2;
    }
  }
  if (args[0] === 'session') {
    try {
      const parsedSession = parseArgs({
        args: [...args.slice(1)],
        options: {
          config: { type: 'string' },
          json: { type: 'boolean' },
          help: { type: 'boolean', short: 'h' },
        },
        allowPositionals: true,
        strict: true,
      });
      if (parsedSession.values.help) {
        output.stdout(`${sessionUsage}\n`);
        return 0;
      }
      if (
        parsedSession.positionals.length !== 1 ||
        args.filter((arg) => arg === '--config' || arg.startsWith('--config='))
          .length > 1
      )
        throw new Error(sessionUsage);
      return runSessionCommand(
        {
          action: parsedSession.positionals[0]!,
          config: parsedSession.values.config ?? null,
          json: parsedSession.values.json ?? false,
        },
        output,
      );
    } catch (error) {
      failure(output, jsonRequested, 'invalid_arguments', error);
      return 2;
    }
  }
  // `docs review` carries a pinned expected digest, which is not a global flag. It is routed
  // before the global parser so the review surface does not add a 96th global option.
  if (args[0] === 'docs' && args[1] === 'review') {
    return runDocsReviewCli(args.slice(1), output);
  }
  // The workflow family parses its own request documents, so it is routed before the global
  // option parser: those flags belong to the request schema, not to 95 global options.
  if (args[0] === 'collab' && args[1] === 'workflow') {
    return runCollaborationWorkflowCli(args.slice(2), output);
  }
  // The context family has its own flags (--session, --advise-percent); it is routed here for
  // the same reason and never reaches the global parser.
  if (args[0] === 'context') {
    return runContextCli(args.slice(1), output);
  }
  return null;
}
