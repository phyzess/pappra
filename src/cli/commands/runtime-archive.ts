import { parseArgs } from 'node:util';
import { archiveRuntime } from '../../install/runtime-archive.js';
import { resolveUserDataDir } from '../../install/runtime.js';
import { resolveWorkspaceRoot } from '../../workspace/resolve.js';
import { failure } from '../options.js';
import type { CliOutput } from '../output.js';

export const runtimeArchiveUsage =
  'pappra runtime archive --runtime-version <v> [--install-id <uuid> ...]\n' +
  '  [--apply --force --reason <text>] [--all-writers-stopped] [--json]\n' +
  'Preview is read-only. Apply preserves raw runtime, selected journals/staging and lock evidence.\n' +
  '--force accepts unknown reference coverage only; verified bindings and live locks always block.\n' +
  'Unknown lock ownership additionally requires --all-writers-stopped. Repeat to resume a pending archive.\n';

export async function runRuntimeArchiveCli(
  args: readonly string[],
  output: CliOutput,
): Promise<number> {
  try {
    const { values } = parseArgs({
      args: [...args],
      allowPositionals: false,
      strict: true,
      options: {
        'runtime-version': { type: 'string' },
        'install-id': { type: 'string', multiple: true },
        apply: { type: 'boolean' },
        force: { type: 'boolean' },
        reason: { type: 'string' },
        'all-writers-stopped': { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) {
      output.stdout(runtimeArchiveUsage);
      return 0;
    }
    if (
      !values['runtime-version'] ||
      ['--runtime-version', '--reason'].some(
        (flag) =>
          args.filter((arg) => arg === flag || arg.startsWith(`${flag}=`))
            .length > 1,
      )
    )
      throw new Error(
        'Archive requires one exact --runtime-version and at most one --reason.',
      );
    const workspace = await resolveWorkspaceRoot({ startPath: process.cwd() });
    const archived = await archiveRuntime({
      version: values['runtime-version'],
      dataDir: resolveUserDataDir(),
      ...(workspace.root ? { workspaceRoot: workspace.root } : {}),
      installIds: values['install-id'] ?? [],
      apply: values.apply === true,
      forceUnknownReferences: values.force === true,
      allWritersStopped: values['all-writers-stopped'] === true,
      ...(values.reason === undefined ? {} : { reason: values.reason }),
    });
    output.stdout(
      values.json
        ? `${JSON.stringify({ command: 'runtime', action: 'archive', ...archived })}\n`
        : `Runtime archive ${archived.mode}: ${archived.status}\n` +
            `Evidence: ${archived.archive ?? `${archived.archiveDirectory ?? '(unresolved)'}/<new-archive-id>`}\n` +
            archived.items
              .map((item) => `  ${item.source} -> ${item.destination}\n`)
              .join('') +
            archived.unselectedJournals
              .map((file) => `  Unselected journal (retained): ${file}\n`)
              .join('') +
            [...archived.blockers, ...archived.errors]
              .map((message) => `${message}\n`)
              .join(''),
    );
    return archived.ok ? 0 : 1;
  } catch (error) {
    failure(output, args.includes('--json'), 'invalid_arguments', error);
    return 2;
  }
}
