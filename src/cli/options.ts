import { parseArgs } from 'node:util';
import type { CliOutput } from './output.js';

export function parseOptions(args: readonly string[]) {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      json: { type: 'boolean' },
      live: { type: 'boolean' },
      config: { type: 'string' },
      apply: { type: 'boolean' },
      watch: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      'no-runtime': { type: 'boolean' },
      'allow-workspace-writes': { type: 'boolean' },
      reconfigure: { type: 'boolean' },
      hosts: { type: 'string' },
      'apply-host': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'print-handoff': { type: 'boolean' },
      'auto-resume': { type: 'boolean' },
      from: { type: 'string' },
      tarball: { type: 'string' },
      out: { type: 'string' },
      'bootstrap-config': { type: 'string' },
      'recovery-config': { type: 'string' },
      'transition-extension': { type: 'boolean' },
      mode: { type: 'string' },
      marketplace: { type: 'boolean' },
      scope: { type: 'string' },
      bind: { type: 'boolean' },
      force: { type: 'boolean' },
      'no-interactive': { type: 'boolean' },
      'print-choices': { type: 'boolean' },
      'install-runtime': { type: 'boolean' },
      'runtime-tarball': { type: 'string' },
      'runtime-version': { type: 'string' },
      root: { type: 'string' },
      'task-id': { type: 'string' },
      record: { type: 'string' },
      roots: { type: 'string' },
      'include-private': { type: 'boolean' },
      'include-archived': { type: 'boolean' },
      task: { type: 'string' },
      objective: { type: 'string' },
      acceptance: { type: 'string', multiple: true },
      constraint: { type: 'string', multiple: true },
      decision: { type: 'string', multiple: true },
      attempted: { type: 'string', multiple: true },
      'next-action': { type: 'string', multiple: true },
      limitation: { type: 'string', multiple: true },
      artifact: { type: 'string', multiple: true },
      'collaboration-record': { type: 'string' },
      'context-completeness': { type: 'string' },
      'author-session': { type: 'string' },
      'native-harness': { type: 'string' },
      'native-session': { type: 'string' },
      session: { type: 'string' },
      repo: { type: 'string' },
      kind: { type: 'string' },
      query: { type: 'string' },
      limit: { type: 'string' },
      'max-bytes': { type: 'string' },
      rebuild: { type: 'boolean' },
      host: { type: 'string' },
      'host-root': { type: 'string' },
      'host-version': { type: 'string' },
      goal: { type: 'string' },
      prepared: { type: 'string' },
      capabilities: { type: 'string' },
      controller: { type: 'string' },
      'rpc-request-timeout-ms': { type: 'string' },
      'rpc-operation-timeout-ms': { type: 'string' },
      'domain-root': { type: 'string' },
      'task-root': { type: 'string' },
      message: { type: 'string' },
      'message-id': { type: 'string' },
      binding: { type: 'string' },
      retry: { type: 'boolean' },
      'caller-pane': { type: 'string' },
      assignment: { type: 'string' },
      'max-age-minutes': { type: 'string' },
      harness: { type: 'string' },
      template: { type: 'string' },
      execution: { type: 'string' },
      events: { type: 'string' },
      request: { type: 'string' },
      'owner-epoch': { type: 'string' },
      'subtask-id': { type: 'string' },
      attempt: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help && values.version) {
    throw new Error('Use either --help or --version, not both.');
  }
  const command = positionals[0] ?? null;
  if (command === 'task') {
    if (positionals.length > 3) {
      throw new Error('task accepts one action and an optional task id.');
    }
    return {
      values,
      command,
      docsAction: null,
      docsArgument: null,
      codeAction: null,
      hostAction: null,
      hostSubAction: null,
      collaborationAction: null,
      resumeTaskId: null,
      runtimeAction: null,
      taskAction: positionals[1] ?? null,
      taskArgument: positionals[2] ?? null,
    };
  }
  if (command === 'docs') {
    if (positionals.length > (positionals[1] === 'relocate' ? 4 : 3)) {
      throw new Error(
        'Unknown command; docs accepts one action and one argument.',
      );
    }
    return {
      values,
      codeAction: null,
      command,
      docsAction: positionals[1] ?? null,
      docsArgument: positionals[2] ?? null,
      docsTarget: positionals[3] ?? null,
      hostAction: null,
      hostSubAction: null,
      collaborationAction: null,
      resumeTaskId: null,
      runtimeAction: null,
      taskAction: null,
      taskArgument: null,
    };
  }
  if (command === 'resume') {
    if (positionals.length > 2) {
      throw new Error('resume accepts exactly one task id.');
    }
    return {
      values,
      command,
      docsAction: null,
      docsArgument: null,
      codeAction: null,
      hostAction: null,
      hostSubAction: null,
      collaborationAction: null,
      resumeTaskId: positionals[1] ?? null,
      runtimeAction: null,
      taskAction: null,
      taskArgument: null,
    };
  }
  if (command === 'code') {
    if (positionals.length > 2) {
      throw new Error('code accepts one action: status, prepare, or query.');
    }
    return {
      values,
      command,
      docsAction: null,
      docsArgument: null,
      codeAction: positionals[1] ?? null,
      hostAction: null,
      hostSubAction: null,
      collaborationAction: null,
      resumeTaskId: null,
      runtimeAction: null,
      taskAction: null,
      taskArgument: null,
    };
  }
  if (command === 'host') {
    if (positionals.length > 3) {
      throw new Error(
        'host accepts one action and an optional mcp sub-action.',
      );
    }
    return {
      values,
      command,
      docsAction: null,
      docsArgument: null,
      codeAction: null,
      hostAction: positionals[1] ?? null,
      hostSubAction: positionals[2] ?? null,
      collaborationAction: null,
      resumeTaskId: null,
      runtimeAction: null,
      taskAction: null,
      taskArgument: null,
    };
  }
  if (command === 'runtime') {
    if (positionals.length > 2) {
      throw new Error(
        'runtime accepts one action: install, status, verify, or remove.',
      );
    }
    return {
      values,
      command,
      docsAction: null,
      docsArgument: null,
      codeAction: null,
      hostAction: null,
      hostSubAction: null,
      collaborationAction: null,
      resumeTaskId: null,
      runtimeAction: positionals[1] ?? null,
      taskAction: null,
      taskArgument: null,
    };
  }
  if (command === 'collab') {
    // `collab message <action>` is the only two-level form; the action string carries
    // both segments so callers keep one parsed field.
    if (
      positionals.length > 3 ||
      (positionals.length === 3 &&
        positionals[1] !== 'transition' &&
        positionals[1] !== 'bootstrap' &&
        positionals[1] !== 'plan' &&
        positionals[1] !== 'role-plan' &&
        positionals[1] !== 'message' &&
        !(positionals[1] === 'capabilities' && positionals[2] === 'derive') &&
        !(
          (positionals[1] === 'state' ||
            positionals[1] === 'resource' ||
            positionals[1] === 'handoff' ||
            positionals[1] === 'recovery' ||
            positionals[1] === 'binding' ||
            positionals[1] === 'rollover') &&
          positionals[2] !== undefined
        ))
    ) {
      throw new Error(
        'collab accepts prepare, run, work-run, query, preflight, plan, bootstrap, rollover <inspect|plan>, transition <plan|apply>, message <send|list|read|notify>, capabilities derive, state <show|doctor|epoch-check>, resource <list|claim|release>, handoff <inventory|begin|stopped|rebind|transfer|confirm|complete|abort|release-dispatch>, recovery <inspect|reconcile|lock-break>, recovery-run, or binding <list|resolve|bind|unbind>.',
      );
    }
    return {
      values,
      command,
      docsAction: null,
      docsArgument: null,
      codeAction: null,
      hostAction: null,
      hostSubAction: null,
      collaborationAction:
        positionals[1] === undefined ? null : positionals.slice(1).join(':'),
      resumeTaskId: null,
      runtimeAction: null,
      taskAction: null,
      taskArgument: null,
    };
  }
  if (positionals.length > 1) {
    throw new Error('Only one command may be specified.');
  }
  return {
    values,
    command,
    docsAction: null,
    docsArgument: null,
    codeAction: null,
    hostAction: null,
    collaborationAction: null,
    resumeTaskId: null,
    runtimeAction: null,
  };
}

export function failure(
  output: CliOutput,
  json: boolean,
  code: string,
  error: unknown,
): void {
  const message =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : 'Operation failed.';
  if (json) {
    output.stdout(`${JSON.stringify({ ok: false, code, message })}\n`);
  } else {
    output.stderr(`pappra: ${message}\n`);
  }
}

export function hasContinuityOptions(
  values: ReturnType<typeof parseOptions>['values'],
  includeSession = true,
): boolean {
  return (
    values.task !== undefined ||
    values.objective !== undefined ||
    values.acceptance !== undefined ||
    values.constraint !== undefined ||
    values.decision !== undefined ||
    values.attempted !== undefined ||
    values['next-action'] !== undefined ||
    values.limitation !== undefined ||
    values.artifact !== undefined ||
    values['collaboration-record'] !== undefined ||
    values['context-completeness'] !== undefined ||
    values['author-session'] !== undefined ||
    values['native-harness'] !== undefined ||
    values['native-session'] !== undefined ||
    (includeSession && values.session !== undefined)
  );
}

export type ParsedCliOptions = ReturnType<typeof parseOptions>;
export type CliValues = ParsedCliOptions['values'];
