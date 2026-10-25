import { failure, hasContinuityOptions } from '../options.js';
import {
  collaborationBootstrapUsage,
  runCollaborationBootstrapCommand,
} from '../commands/collaboration-bootstrap.js';
import {
  collaborationCapabilitiesUsage,
  runCollaborationCapabilitiesCommand,
} from '../commands/collaboration-capabilities.js';
import {
  collaborationPreflightUsage,
  runCollaborationPreflightCommand,
} from '../commands/collaboration-preflight.js';
import {
  collaborationRecoveryUsage,
  runCollaborationRecoveryCommand,
} from '../commands/collaboration-recovery.js';
import type { RoutingContext } from './context.js';

export async function handleCapabilitiesDerive(
  context: RoutingContext,
): Promise<number | null> {
  const { values, args, output, json, action: collaborationAction } = context;
  if (collaborationAction === 'capabilities:derive') {
    const duplicate = [
      '--live',
      '--harness',
      '--assignment',
      '--template',
      '--execution',
      '--session',
      '--events',
    ].filter(
      (flag) =>
        args.filter((arg) => arg === flag || arg.startsWith(`${flag}=`))
          .length > 1,
    );
    if (duplicate.length) {
      failure(
        output,
        json,
        'invalid_arguments',
        `collab capabilities derive rejects duplicate option(s): ${duplicate.join(', ')}.\n${collaborationCapabilitiesUsage}`,
      );
      return 2;
    }
    const allowed = new Set([
      'live',
      'assignment',
      'harness',
      'template',
      'execution',
      'session',
      'events',
      'json',
    ]);
    const extra = Object.entries(values)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key)
      .filter((key) => !allowed.has(key));
    if (extra.length) {
      failure(
        output,
        json,
        'invalid_arguments',
        `collab capabilities derive accepts only its own options: ${extra.join(', ')}.\n${collaborationCapabilitiesUsage}`,
      );
      return 2;
    }
    return runCollaborationCapabilitiesCommand(
      {
        harness: values.harness ?? null,
        assignmentFile: values.assignment ?? null,
        templateFile: values.template ?? null,
        executionFile: values.execution ?? null,
        sessionFile: values.session ?? null,
        eventsFile: values.events ?? null,
        live: values.live ?? false,
        json,
      },
      output,
    );
  }
  return null;
}

export async function handleRecovery(
  context: RoutingContext,
): Promise<number | null> {
  const { values, args, output, json, action: collaborationAction } = context;
  if (collaborationAction?.startsWith('recovery:')) {
    const selected = collaborationAction.slice('recovery:'.length);
    const recoveryAction =
      selected === 'inspect' ||
      selected === 'reconcile' ||
      selected === 'lock-break'
        ? selected
        : null;
    const duplicateFlags =
      recoveryAction === 'inspect'
        ? ['--task-root']
        : ['--task-root', '--request'];
    const duplicate = duplicateFlags.filter(
      (flag) =>
        args.filter((arg) => arg === flag || arg.startsWith(`${flag}=`))
          .length > 1,
    );
    const allowed = new Set([
      'task-root',
      'json',
      ...(recoveryAction === 'inspect' ? [] : ['request', 'apply']),
    ]);
    const extra = Object.entries(values)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key)
      .filter((key) => !allowed.has(key));
    if (recoveryAction === null || duplicate.length || extra.length) {
      failure(
        output,
        json,
        'invalid_arguments',
        `collab recovery accepts only inspect/reconcile/lock-break and their own options.${
          duplicate.length ? ` Duplicate: ${duplicate.join(', ')}.` : ''
        }${extra.length ? ` Unexpected: ${extra.join(', ')}.` : ''}\n${collaborationRecoveryUsage}`,
      );
      return 2;
    }
    return runCollaborationRecoveryCommand(
      {
        action: recoveryAction,
        taskRoot: values['task-root'] ?? null,
        requestFile: values.request ?? null,
        apply: values.apply === true,
        json,
      },
      output,
    );
  }
  return null;
}

export async function handleBootstrap(
  context: RoutingContext,
): Promise<number | null> {
  const { values, args, output, json, action: collaborationAction } = context;
  if (
    collaborationAction === 'bootstrap' ||
    collaborationAction?.startsWith('bootstrap:') === true
  ) {
    const selected =
      collaborationAction === 'bootstrap'
        ? null
        : collaborationAction.slice('bootstrap:'.length);
    const action =
      selected === 'plan' || selected === 'apply' ? selected : null;
    const duplicate = ['--task-root', '--request'].filter(
      (flag) =>
        args.filter((arg) => arg === flag || arg.startsWith(`${flag}=`))
          .length > 1,
    );
    const allowed = new Set(['task-root', 'request', 'json']);
    const extra = Object.entries(values)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key)
      .filter((key) => !allowed.has(key));
    if (action === null || duplicate.length || extra.length) {
      failure(
        output,
        json,
        'invalid_arguments',
        `collab bootstrap requires plan|apply and only --task-root, --request and --json.${
          duplicate.length ? ` Duplicate: ${duplicate.join(', ')}.` : ''
        }${extra.length ? ` Unexpected: ${extra.join(', ')}.` : ''}\n${collaborationBootstrapUsage}`,
      );
      return 2;
    }
    return runCollaborationBootstrapCommand(
      {
        action,
        taskRoot: values['task-root'] ?? null,
        requestFile: values.request ?? null,
        json,
      },
      output,
    );
  }
  return null;
}

export async function handlePreflight(
  context: RoutingContext,
): Promise<number | null> {
  const { values, output, json, action: collaborationAction } = context;
  if (collaborationAction === 'preflight') {
    if (
      values.version ||
      values.config !== undefined ||
      values['install-runtime'] === true ||
      values['runtime-tarball'] !== undefined ||
      values['runtime-version'] !== undefined ||
      values.root !== undefined ||
      values.goal !== undefined ||
      values.prepared !== undefined ||
      values.controller !== undefined ||
      values['domain-root'] !== undefined ||
      values['task-root'] !== undefined ||
      values.message !== undefined ||
      values['message-id'] !== undefined ||
      values.binding !== undefined ||
      values.retry === true ||
      values['caller-pane'] !== undefined ||
      values.session !== undefined ||
      values.harness !== undefined ||
      values.template !== undefined ||
      values.execution !== undefined ||
      values.events !== undefined ||
      values.request !== undefined ||
      values['owner-epoch'] !== undefined ||
      values['subtask-id'] !== undefined ||
      values.attempt !== undefined ||
      values['task-id'] !== undefined ||
      values.record !== undefined ||
      values.roots !== undefined ||
      values.apply === true ||
      values['include-private'] === true ||
      values['include-archived'] === true ||
      hasContinuityOptions(values)
    ) {
      failure(
        output,
        json,
        'invalid_arguments',
        `collab preflight accepts only its own options.\n${collaborationPreflightUsage}`,
      );
      return 2;
    }
    return runCollaborationPreflightCommand(
      {
        cwd: process.cwd(),
        assignmentFile: values.assignment ?? null,
        capabilitiesFile: values.capabilities ?? null,
        maxAgeMinutes: values['max-age-minutes'] ?? null,
        json,
      },
      output,
    );
  }
  return null;
}
