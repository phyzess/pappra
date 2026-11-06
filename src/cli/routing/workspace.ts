import { initUsage, runInitCommand } from '../commands/init.js';
import { onboardUsage, runOnboardCommand } from '../commands/onboard.js';
import { taskUsage, runTaskCommand } from '../commands/task.js';
import { doctorUsage, runDoctorCommand } from '../commands/doctor.js';
import { docsUsage, runDocsCommand } from '../commands/docs.js';
import { failure, hasContinuityOptions } from '../options.js';
import type { CliRouteResult, CliRoutingContext } from './context.js';

export function routeWorkspace({
  parsed,
  info,
  json,
  interactive,
  output,
}: CliRoutingContext): CliRouteResult {
  const {
    values,
    command,
    docsAction,
    docsArgument,
    taskAction,
    taskArgument,
  } = parsed;
  const applyRequested = values.apply === true;
  if (command === 'docs') {
    if (
      values.version ||
      values.config !== undefined ||
      values['install-runtime'] === true ||
      values['runtime-tarball'] !== undefined ||
      values['runtime-version'] !== undefined ||
      values.root !== undefined ||
      hasContinuityOptions(values)
    ) {
      failure(
        output,
        json,
        'invalid_arguments',
        'docs accepts list/check/archive/scan/relocate/forget, --include-private, --include-archived, --apply, --help, and --json.',
      );
      return 2;
    }
    if (values.help) {
      if (json) {
        output.stdout(
          `${JSON.stringify({ ...info, commands: ['docs'], usage: docsUsage })}\n`,
        );
      } else {
        output.stdout(docsUsage);
      }
      return 0;
    }
    return runDocsCommand(
      {
        cwd: process.cwd(),
        action: docsAction,
        argument: docsArgument,
        targetPath: 'docsTarget' in parsed ? parsed.docsTarget : null,
        scope: values.scope ?? null,
        json,
        includePrivate: values['include-private'] === true,
        includeArchived: values['include-archived'] === true,
        apply: applyRequested,
        interactive,
      },
      output,
    );
  }

  if (command === 'doctor') {
    if (values.help) {
      if (json) {
        output.stdout(
          `${JSON.stringify({ ...info, commands: ['init', 'doctor', 'docs'], usage: doctorUsage })}\n`,
        );
      } else {
        output.stdout(doctorUsage);
      }
      return 0;
    }
    if (
      values.version ||
      values.config !== undefined ||
      values.apply === true ||
      values['install-runtime'] === true ||
      values['runtime-tarball'] !== undefined ||
      values['runtime-version'] !== undefined ||
      values['include-private'] === true ||
      values['include-archived'] === true ||
      hasContinuityOptions(values)
    ) {
      failure(
        output,
        json,
        'invalid_arguments',
        'doctor only accepts --root, --help, and --json.',
      );
      return 2;
    }
    return runDoctorCommand(
      {
        root: values.root ?? process.cwd(),
        json,
      },
      output,
    );
  }

  if (command === 'task') {
    const action =
      taskAction === 'pin' || taskAction === 'unpin' || taskAction === 'show'
        ? taskAction
        : null;
    if (
      values.config !== undefined ||
      values.apply === true ||
      values.yes === true ||
      values['install-runtime'] === true ||
      values['runtime-tarball'] !== undefined ||
      values['runtime-version'] !== undefined ||
      values.host !== undefined ||
      values.repo !== undefined ||
      values.kind !== undefined ||
      values.query !== undefined ||
      values.root !== undefined ||
      hasContinuityOptions(values)
    ) {
      failure(
        output,
        json,
        'invalid_arguments',
        'task accepts pin|unpin|show, an optional task id, --auto-resume, --help, and --json.',
      );
      return 2;
    }
    if (values.help) {
      if (json) {
        output.stdout(
          `${JSON.stringify({ ...info, commands: ['task'], usage: taskUsage })}\n`,
        );
      } else {
        output.stdout(taskUsage);
      }
      return 0;
    }
    if (values.version) {
      failure(
        output,
        json,
        'invalid_arguments',
        '--version cannot be combined with task.',
      );
      return 2;
    }
    return runTaskCommand(
      {
        cwd: process.cwd(),
        action,
        taskId: taskArgument ?? null,
        autoResume: values['auto-resume'] === true,
        json,
      },
      output,
    );
  }

  if (command === 'onboard') {
    if (
      values.apply === true ||
      values['install-runtime'] === true ||
      values['runtime-tarball'] !== undefined ||
      values['runtime-version'] !== undefined ||
      values['host-root'] !== undefined ||
      values['host-version'] !== undefined ||
      values.mode !== undefined ||
      values.from !== undefined ||
      values.tarball !== undefined ||
      values.bind === true ||
      values.force === true ||
      values.marketplace === true ||
      values.scope !== undefined ||
      values.repo !== undefined ||
      values.kind !== undefined ||
      values.query !== undefined ||
      values.limit !== undefined ||
      values['max-bytes'] !== undefined ||
      values.rebuild === true ||
      values['include-private'] === true ||
      values['include-archived'] === true ||
      hasContinuityOptions(values)
    ) {
      failure(
        output,
        json,
        'invalid_arguments',
        'onboard accepts --root, --config, --hosts, --yes, --apply-host, --dry-run, --print-handoff, --help, and --json.',
      );
      return 2;
    }
    if (values.help) {
      if (json) {
        output.stdout(
          `${JSON.stringify({ ...info, commands: ['onboard'], usage: onboardUsage })}\n`,
        );
      } else {
        output.stdout(onboardUsage);
      }
      return 0;
    }
    if (values.version) {
      failure(
        output,
        json,
        'invalid_arguments',
        '--version cannot be combined with onboard.',
      );
      return 2;
    }
    return runOnboardCommand(
      {
        cwd: process.cwd(),
        root: values.root ?? null,
        configPath: values.config ?? null,
        hosts: values.hosts ?? null,
        apply: values.yes === true,
        applyHosts: values['apply-host'] === true,
        dryRun: values['dry-run'] === true,
        printHandoff: values['print-handoff'] === true,
        json,
        interactive,
      },
      output,
    );
  }

  if (command === 'init') {
    if (
      values.root !== undefined ||
      values['include-private'] === true ||
      values['include-archived'] === true ||
      hasContinuityOptions(values)
    ) {
      failure(
        output,
        json,
        'invalid_arguments',
        '--root, --include-private, and --include-archived are not valid for init; init uses the current directory.',
      );
      return 2;
    }
    if (values.help) {
      if (json) {
        output.stdout(
          `${JSON.stringify({ ...info, commands: ['init'], usage: initUsage })}\n`,
        );
      } else {
        output.stdout(initUsage);
      }
      return 0;
    }
    if (values.version) {
      failure(
        output,
        json,
        'invalid_arguments',
        '--version cannot be combined with init.',
      );
      return 2;
    }
    return runInitCommand(
      {
        cwd: process.cwd(),
        configPath: values.config ?? null,
        apply: values.apply === true,
        json,
        installRuntime: values['install-runtime'] === true,
        runtimeTarball: values['runtime-tarball'] ?? null,
        runtimeVersion: values['runtime-version'] ?? null,
        yes:
          values.yes === true ||
          (values.config === undefined && values['no-interactive'] === true),
        printChoices: values['print-choices'] === true,
        noRuntime: values['no-runtime'] === true,
        reconfigure: values.reconfigure === true,
      },
      output,
      { interactive },
    );
  }
  return null;
}
