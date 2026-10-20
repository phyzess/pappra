import type { DoctorReport } from '../../schemas/doctor.js';
import { runDoctor, type DoctorOptions } from '../../app/doctor.js';
import type { CliOutput } from '../output.js';

export interface DoctorCommandOptions {
  readonly root: string;
  readonly json: boolean;
  readonly dataDir?: string;
  readonly homeDir?: string;
  readonly pathEnv?: string;
}

function printHuman(output: CliOutput, report: DoctorReport): void {
  output.stdout(`Pappra doctor ${report.generatedAt}\n`);
  output.stdout(`Workspace: ${report.workspace.root ?? '(not registered)'}\n`);
  output.stdout(
    `Runtime target: ${report.runtime.targetVersion ?? '(none)'}; machine: ${
      report.runtime.machineRuntime?.version ?? '(none)'
    }; passive state: ${report.runtime.passiveStatus ?? '(unknown)'}\n`,
  );
  for (const check of report.checks) {
    output.stdout(
      `\n[${check.status.toUpperCase()}] ${check.id}: ${check.title}\n`,
    );
    output.stdout(`  ${check.summary}\n`);
    output.stdout(`  source: ${check.source}\n`);
    if (check.coverage !== null)
      output.stdout(`  coverage: ${check.coverage}\n`);
    for (const action of check.nextActions) {
      output.stdout(`  next: ${action}\n`);
    }
  }
  output.stdout(
    `\nSummary: ${report.summary.status} (exit ${report.summary.exitCode}); ` +
      `ok=${report.summary.counts.ok}, warning=${report.summary.counts.warning}, ` +
      `error=${report.summary.counts.error}, unknown=${report.summary.counts.unknown}, ` +
      `partial=${report.summary.counts.partial}, unsupported=${report.summary.counts.unsupported}\n`,
  );
  if (report.scope.notChecked.length > 0) {
    output.stdout(`Not checked: ${report.scope.notChecked.join(', ')}\n`);
  }
}

/**
 * Runs one read-only doctor report. JSON mode writes exactly one JSON document
 * to stdout and never opens prompts or emits progress logs.
 */
export async function runDoctorCommand(
  options: DoctorCommandOptions,
  output: CliOutput,
): Promise<number> {
  try {
    const report = await runDoctor({
      root: options.root,
      ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
      ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
      ...(options.pathEnv === undefined ? {} : { pathEnv: options.pathEnv }),
    } satisfies DoctorOptions);
    if (options.json) {
      output.stdout(`${JSON.stringify(report)}\n`);
    } else {
      printHuman(output, report);
    }
    return report.summary.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      output.stdout(
        `${JSON.stringify({ ok: false, command: 'doctor', code: 'doctor_failed', message })}\n`,
      );
    } else {
      output.stderr(`pappra doctor: ${message}\n`);
    }
    return 1;
  }
}

export const doctorUsage =
  'pappra doctor [--root <path>] [--json]\n\n' +
  'Read-only workspace, runtime, install-state, host, and tool diagnostics.\n' +
  'Doctor never installs, repairs, indexes, starts hosts/models, or removes locks/runtimes.\n';
