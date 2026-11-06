import { mcpUsage, runMcpCommand } from '../commands/mcp.js';
import { runtimeUsage, runRuntimeCommand } from '../commands/runtime.js';
import { codeUsage, runCodeCommand } from '../commands/code.js';
import { hostUsage, runHostCommand } from '../commands/host.js';
import { hostNameSchema } from '../../schemas/host.js';
import { failure, hasContinuityOptions } from '../options.js';
import type { CliRouteResult, CliRoutingContext } from './context.js';

export function routeServices(
  { parsed, info, json, interactive, output }: CliRoutingContext,
  args: readonly string[],
): CliRouteResult {
  const {
    values,
    command,
    runtimeAction,
    codeAction,
    hostAction,
    hostSubAction,
  } = parsed;
  if (command === 'mcp') {
    if (
      values.config !== undefined ||
      values.apply === true ||
      values.yes === true ||
      values['install-runtime'] === true ||
      values['runtime-tarball'] !== undefined ||
      values['runtime-version'] !== undefined ||
      values['include-private'] === true ||
      values['include-archived'] === true ||
      values['apply-host'] === true ||
      values['dry-run'] === true ||
      values['print-handoff'] === true ||
      values.hosts !== undefined ||
      values.repo !== undefined ||
      values.kind !== undefined ||
      values.query !== undefined ||
      values.limit !== undefined ||
      values['max-bytes'] !== undefined ||
      values.rebuild === true ||
      values.host !== undefined ||
      hasContinuityOptions(values)
    ) {
      failure(
        output,
        json,
        'invalid_arguments',
        'mcp accepts --root, --allow-workspace-writes, --help, and --json.',
      );
      return 2;
    }
    if (values.help) {
      if (json) {
        output.stdout(
          `${JSON.stringify({ ...info, commands: ['mcp'], usage: mcpUsage })}\n`,
        );
      } else {
        output.stdout(mcpUsage);
      }
      return 0;
    }
    if (values.version) {
      failure(
        output,
        json,
        'invalid_arguments',
        '--version cannot be combined with mcp.',
      );
      return 2;
    }
    return runMcpCommand(
      {
        cwd: process.cwd(),
        root: values.root ?? null,
        json,
        allowWorkspaceWrites: values['allow-workspace-writes'] === true,
      },
      output,
    );
  }

  if (command === 'runtime') {
    if (values.help) {
      if (json) {
        output.stdout(
          `${JSON.stringify({ ...info, commands: ['runtime'], usage: runtimeUsage })}\n`,
        );
      } else {
        output.stdout(runtimeUsage);
      }
      return 0;
    }
    if (
      values.version ||
      values.config !== undefined ||
      values['install-runtime'] === true ||
      values['runtime-tarball'] !== undefined ||
      values.root !== undefined ||
      values.host !== undefined ||
      values.repo !== undefined ||
      values.query !== undefined ||
      values.kind !== undefined ||
      hasContinuityOptions(values)
    ) {
      failure(
        output,
        json,
        'invalid_arguments',
        'runtime accepts only --from, --tarball, --runtime-version, --apply, --bind, --force, --help, and --json.',
      );
      return 2;
    }
    const action =
      runtimeAction === 'install' ||
      runtimeAction === 'status' ||
      runtimeAction === 'verify' ||
      runtimeAction === 'remove' ||
      runtimeAction === 'gc'
        ? runtimeAction
        : null;
    return runRuntimeCommand(
      {
        cwd: process.cwd(),
        action,
        json,
        from:
          values.from === 'self' ||
          values.from === 'tarball' ||
          values.from === 'registry'
            ? values.from
            : null,
        tarball: values.tarball ?? null,
        version: values['runtime-version'] ?? null,
        apply: values.apply === true,
        bind: values.bind === true,
        force: values.force === true,
      },
      output,
    );
  }

  if (command === 'code') {
    if (values.help) {
      if (json) {
        output.stdout(
          `${JSON.stringify({ ...info, commands: ['code'], usage: codeUsage })}\n`,
        );
      } else {
        output.stdout(codeUsage);
      }
      return 0;
    }
    const allowedActions = ['status', 'prepare', 'query'] as const;
    const action = allowedActions.find((item) => item === codeAction) ?? null;
    const kindValues = [
      'explore',
      'symbol',
      'references',
      'impact',
      'text',
    ] as const;
    const kind = kindValues.find((item) => item === values.kind) ?? null;
    const operationsInvalid =
      values.version ||
      values.config !== undefined ||
      values['install-runtime'] === true ||
      values['runtime-tarball'] !== undefined ||
      values['runtime-version'] !== undefined ||
      values.root !== undefined ||
      values['include-private'] === true ||
      values['include-archived'] === true ||
      hasContinuityOptions(values);
    if (
      action === null ||
      (values.repo === undefined && (!interactive || action === 'query')) ||
      operationsInvalid ||
      (values.apply === true && action !== 'prepare') ||
      (values.rebuild === true && action !== 'prepare') ||
      (action !== 'query' &&
        (values.kind !== undefined ||
          values.query !== undefined ||
          values.limit !== undefined ||
          values['max-bytes'] !== undefined)) ||
      (action !== 'prepare' && values.rebuild === true) ||
      (action !== 'prepare' && values.apply === true)
    ) {
      failure(
        output,
        json,
        'invalid_arguments',
        'code requires status/prepare/query, --repo, and action-compatible options.',
      );
      return 2;
    }
    if (action === 'query' && (kind === null || values.query === undefined)) {
      failure(
        output,
        json,
        'invalid_arguments',
        'code query requires --kind explore|symbol|references|impact|text and --query.',
      );
      return 2;
    }
    const numberOption = (
      raw: string | undefined,
      minimum: number,
      maximum: number,
    ): number | null | undefined => {
      if (raw === undefined) return null;
      const value = Number(raw);
      return Number.isSafeInteger(value) && value >= minimum && value <= maximum
        ? value
        : undefined;
    };
    const maxResults = numberOption(values.limit, 1, 100);
    const maxBytes = numberOption(values['max-bytes'], 1, 16 * 1024 * 1024);
    if (maxResults === undefined || maxBytes === undefined) {
      failure(
        output,
        json,
        'invalid_arguments',
        '--limit must be 1-100 and --max-bytes must be 1-16777216.',
      );
      return 2;
    }
    return runCodeCommand(
      {
        cwd: process.cwd(),
        json,
        action,
        repositoryId: values.repo ?? null,
        kind: action === 'query' ? kind : null,
        query: action === 'query' ? (values.query ?? null) : null,
        maxResults,
        maxBytes,
        apply: values.apply === true,
        rebuild: values.rebuild === true,
        interactive,
      },
      output,
    );
  }

  if (command === 'host') {
    const allowedActions = [
      'detect',
      'describe',
      'plan',
      'install',
      'uninstall',
      'verify',
      'bundle',
      'mcp',
      'probe',
    ] as const;
    const action = allowedActions.find((item) => item === hostAction) ?? null;
    const parsedHost = hostNameSchema.safeParse(values.host);
    const host = parsedHost.success ? parsedHost.data : null;
    const duplicatedBootstrapConfig =
      args.filter(
        (arg) =>
          arg === '--bootstrap-config' || arg.startsWith('--bootstrap-config='),
      ).length > 1;
    const duplicatedRecoveryConfig =
      args.filter(
        (arg) =>
          arg === '--recovery-config' || arg.startsWith('--recovery-config='),
      ).length > 1;
    const duplicatedTransitionExtension =
      args.filter(
        (arg) =>
          arg === '--transition-extension' ||
          arg.startsWith('--transition-extension='),
      ).length > 1;
    const invalid =
      values.version ||
      values.config !== undefined ||
      values['install-runtime'] === true ||
      values['runtime-tarball'] !== undefined ||
      values['runtime-version'] !== undefined ||
      values.root !== undefined ||
      values['include-private'] === true ||
      values['include-archived'] === true ||
      values.repo !== undefined ||
      values.kind !== undefined ||
      values.query !== undefined ||
      values.limit !== undefined ||
      values['max-bytes'] !== undefined ||
      values.rebuild === true ||
      hasContinuityOptions(values) ||
      (values.apply === true &&
        action !== 'install' &&
        action !== 'uninstall' &&
        action !== 'mcp') ||
      (values.mode !== undefined && action !== 'install') ||
      (values.marketplace === true && action !== 'bundle') ||
      (values['bootstrap-config'] !== undefined &&
        (action !== 'bundle' ||
          values.marketplace === true ||
          values.mode !== undefined ||
          values.apply === true ||
          values['recovery-config'] !== undefined ||
          values['transition-extension'] === true)) ||
      (values['recovery-config'] !== undefined &&
        (action !== 'bundle' ||
          host !== 'pi' ||
          values.marketplace === true ||
          values.mode !== undefined ||
          values.apply === true)) ||
      (values['transition-extension'] === true &&
        (action !== 'bundle' ||
          host !== 'pi' ||
          values.marketplace === true ||
          values.mode !== undefined ||
          values.apply === true ||
          values['bootstrap-config'] !== undefined)) ||
      (values.scope !== undefined &&
        action !== 'plan' &&
        action !== 'install' &&
        action !== 'uninstall' &&
        action !== 'verify') ||
      (values['host-root'] !== undefined && action === null) ||
      (values['host-version'] !== undefined && action === null) ||
      duplicatedBootstrapConfig ||
      duplicatedRecoveryConfig ||
      duplicatedTransitionExtension;
    if (values.help) {
      if (json) {
        output.stdout(
          `${JSON.stringify({ ...info, commands: ['host'], usage: hostUsage })}\n`,
        );
      } else {
        output.stdout(hostUsage);
      }
      return 0;
    }
    if (
      action === null ||
      (host === null &&
        (!interactive || values.host !== undefined || action === 'bundle')) ||
      invalid
    ) {
      failure(
        output,
        json,
        'invalid_arguments',
        'host requires detect/describe/probe/plan/install/verify/uninstall/bundle/mcp, --host, and action-compatible options.',
      );
      return 2;
    }
    return runHostCommand(
      {
        cwd: process.cwd(),
        json,
        action,
        host,
        hostRoot: values['host-root'] ?? null,
        hostVersion: values['host-version'] ?? null,
        apply: values.apply === true,
        force: values.force === true,
        subAction: hostSubAction ?? null,
        out: values.out ?? null,
        mode:
          values.mode === 'project-settings' || values.mode === 'plugin'
            ? values.mode
            : null,
        bootstrapConfig: values['bootstrap-config'] ?? null,
        recoveryConfig: values['recovery-config'] ?? null,
        transitionExtension: values['transition-extension'] === true,
        marketplace: values.marketplace === true,
        scope:
          values.scope === 'project' || values.scope === 'user'
            ? values.scope
            : null,
        interactive,
      },
      output,
    );
  }
  return null;
}
