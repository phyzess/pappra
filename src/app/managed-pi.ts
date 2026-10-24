import fs from 'node:fs';
import path from 'node:path';
import { readBoundedFile } from './bounded-file.js';
import type { ManagedPiReadinessConfig } from './managed-pi-readiness.js';
import type { ManagedPiExecutionScope } from './collab-session-transition.js';
import type { ManagedPiInitialAdmissionConfig } from './managed-pi-initial-admission.js';
import type { ManagedPiResumeConfig } from './managed-pi-resume-admission.js';

export const MANAGED_PI_REQUEST_SCHEMA = 'pappra/managed-pi-session-request/1';

export interface ManagedPiRequest {
  readonly schema: typeof MANAGED_PI_REQUEST_SCHEMA;
  readonly cwd: string;
  readonly model: string;
  readonly journalPath: string;
  readonly controlSocketPath?: string;
  readonly piBin?: string;
  readonly pythonBin?: string;
  readonly shutdownGraceMs?: number;
  readonly readiness?: ManagedPiReadinessConfig;
  readonly runtime?: 'pty' | 'sdk';
  readonly sdkModulePath?: string;
  readonly sessionId?: string;
  readonly automaticHandoffFile?: string;
  readonly executionScope?: ManagedPiExecutionScope;
  readonly initialAssignment?: ManagedPiInitialAdmissionConfig;
  readonly resume?: ManagedPiResumeConfig;
  readonly bootstrapExtensionPath?: string;
  readonly handoffContextFile?: string;
  readonly herdrAgentName?: string;
  readonly herdrPaneId?: string;
  readonly thinkingLevel?:
    'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/** Validate a bounded launch request without creating a process, socket or file. */
export function readManagedPiRequest(file: string): ManagedPiRequest {
  const loaded = readBoundedFile(file, 64 * 1024);
  if (!loaded.ok)
    throw new Error(`Managed Pi request refused: ${loaded.code}.`);
  let value: unknown;
  try {
    value = JSON.parse(loaded.text) as unknown;
  } catch {
    throw new Error('Managed Pi request must be JSON.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Managed Pi request must be an object.');
  const raw = value as Record<string, unknown>;
  const keys = new Set([
    'schema',
    'cwd',
    'model',
    'journalPath',
    'controlSocketPath',
    'piBin',
    'pythonBin',
    'shutdownGraceMs',
    'readiness',
    'runtime',
    'sdkModulePath',
    'sessionId',
    'automaticHandoffFile',
    'executionScope',
    'initialAssignment',
    'resume',
    'bootstrapExtensionPath',
    'handoffContextFile',
    'herdrAgentName',
    'herdrPaneId',
    'thinkingLevel',
  ]);
  if (
    Object.keys(raw).some((key) => !keys.has(key)) ||
    raw.schema !== MANAGED_PI_REQUEST_SCHEMA
  )
    throw new Error('Managed Pi request has an unsupported schema or field.');
  for (const key of ['cwd', 'model', 'journalPath']) {
    if (
      typeof raw[key] !== 'string' ||
      !raw[key] ||
      raw[key].length > 4096 ||
      raw[key].includes('\0')
    )
      throw new Error(`Managed Pi request requires ${key}.`);
  }
  for (const key of ['piBin', 'pythonBin', 'controlSocketPath']) {
    const field = raw[key];
    if (
      field !== undefined &&
      (typeof field !== 'string' ||
        !field ||
        field.length > 4096 ||
        field.includes('\0'))
    )
      throw new Error(`Managed Pi request has an invalid ${key}.`);
  }
  for (const key of ['cwd', 'journalPath', 'controlSocketPath']) {
    if (raw[key] !== undefined && !path.isAbsolute(raw[key] as string))
      throw new Error(`${key} must be absolute.`);
  }
  if (!fs.statSync(raw.cwd as string).isDirectory())
    throw new Error('cwd must be an existing directory.');
  if (
    raw.runtime !== undefined &&
    !['pty', 'sdk'].includes(raw.runtime as string)
  )
    throw new Error('runtime must be pty or sdk.');
  if (raw.runtime === 'sdk') {
    if (raw.resume !== undefined) {
      const resume = raw.resume as Record<string, unknown>;
      if (
        !resume ||
        typeof resume !== 'object' ||
        Array.isArray(resume) ||
        Object.keys(resume).length !== 3 ||
        !['sourceJournalPath', 'sourceSessionFile'].every(
          (key) =>
            typeof resume[key] === 'string' &&
            path.isAbsolute(resume[key] as string) &&
            !(resume[key] as string).includes('\0'),
        ) ||
        typeof resume.sourceRunId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(resume.sourceRunId) ||
        raw.journalPath === resume.sourceJournalPath ||
        !raw.executionScope ||
        !raw.sessionId ||
        raw.initialAssignment !== undefined ||
        raw.bootstrapExtensionPath !== undefined ||
        raw.handoffContextFile !== undefined ||
        raw.automaticHandoffFile !== undefined
      )
        throw new Error(
          'resume requires exact source pins, a new journal and one immediate SDK task scope.',
        );
    }
    if (raw.initialAssignment !== undefined) {
      const initial = raw.initialAssignment as Record<string, unknown>;
      const required = [
        'taskRoot',
        'assignmentFile',
        'subtaskId',
        'attempt',
        'ownerEpoch',
        'inputRevision',
      ];
      if (
        !initial ||
        typeof initial !== 'object' ||
        Array.isArray(initial) ||
        Object.keys(initial).length !== required.length ||
        Object.keys(initial).some((key) => !required.includes(key)) ||
        !['taskRoot', 'assignmentFile'].every(
          (key) =>
            typeof initial[key] === 'string' &&
            path.isAbsolute(initial[key] as string) &&
            !(initial[key] as string).includes('\0'),
        ) ||
        typeof initial.subtaskId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(initial.subtaskId) ||
        !Number.isSafeInteger(initial.attempt) ||
        Number(initial.attempt) < 1 ||
        !Number.isSafeInteger(initial.ownerEpoch) ||
        Number(initial.ownerEpoch) < 1 ||
        typeof initial.inputRevision !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/.test(initial.inputRevision) ||
        raw.executionScope !== undefined ||
        raw.bootstrapExtensionPath !== undefined ||
        raw.automaticHandoffFile !== undefined ||
        !raw.sessionId
      )
        throw new Error(
          'initialAssignment requires a fresh SDK session and one explicit deferred task scope.',
        );
    }
    if (
      raw.handoffContextFile !== undefined &&
      (typeof raw.handoffContextFile !== 'string' ||
        !path.isAbsolute(raw.handoffContextFile) ||
        raw.handoffContextFile.includes('\0') ||
        raw.bootstrapExtensionPath === undefined)
    )
      throw new Error(
        'handoffContextFile requires an absolute bootstrap-bound SDK context reference.',
      );
    if (
      raw.thinkingLevel !== undefined &&
      !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(
        String(raw.thinkingLevel),
      )
    )
      throw new Error('thinkingLevel is unsupported.');
    if (
      raw.bootstrapExtensionPath !== undefined &&
      (typeof raw.bootstrapExtensionPath !== 'string' ||
        !path.isAbsolute(raw.bootstrapExtensionPath) ||
        raw.bootstrapExtensionPath.includes('\0'))
    )
      throw new Error('bootstrapExtensionPath must be absolute.');
    if (
      raw.herdrAgentName !== undefined &&
      (typeof raw.herdrAgentName !== 'string' ||
        !/^[a-z][a-z0-9_-]{0,31}$/.test(raw.herdrAgentName))
    )
      throw new Error('herdrAgentName must be a valid agent name.');
    if (
      raw.herdrPaneId !== undefined &&
      (typeof raw.herdrPaneId !== 'string' ||
        !/^[A-Za-z0-9]+:p[A-Za-z0-9]+$/.test(raw.herdrPaneId))
    )
      throw new Error('herdrPaneId must be a valid pane id.');
    if (raw.executionScope !== undefined) {
      const scope = raw.executionScope;
      if (
        typeof scope !== 'object' ||
        scope === null ||
        Array.isArray(scope) ||
        !('schema' in scope) ||
        scope.schema !== 'pappra/managed-pi-execution-scope/1' ||
        !('session_id' in scope) ||
        scope.session_id !== raw.sessionId ||
        !('cwd' in scope) ||
        scope.cwd !== raw.cwd
      )
        throw new Error('executionScope must match the SDK session and cwd.');
    }
    if (
      typeof raw.sdkModulePath !== 'string' ||
      !path.isAbsolute(raw.sdkModulePath) ||
      raw.sdkModulePath.includes('\0')
    )
      throw new Error('SDK mode requires an absolute sdkModulePath.');
    if (
      raw.sessionId !== undefined &&
      (typeof raw.sessionId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          raw.sessionId,
        ))
    )
      throw new Error('SDK sessionId must be a UUID.');
    if (
      raw.automaticHandoffFile !== undefined &&
      (typeof raw.automaticHandoffFile !== 'string' ||
        !path.isAbsolute(raw.automaticHandoffFile) ||
        raw.automaticHandoffFile.includes('\0'))
    )
      throw new Error('automaticHandoffFile must be absolute.');
    if (
      raw.piBin !== undefined ||
      raw.pythonBin !== undefined ||
      raw.shutdownGraceMs !== undefined
    )
      throw new Error('SDK mode does not accept PTY process options.');
  } else if (
    raw.sdkModulePath !== undefined ||
    raw.sessionId !== undefined ||
    raw.automaticHandoffFile !== undefined ||
    raw.executionScope !== undefined ||
    raw.initialAssignment !== undefined ||
    raw.resume !== undefined ||
    raw.bootstrapExtensionPath !== undefined ||
    raw.herdrAgentName !== undefined ||
    raw.herdrPaneId !== undefined ||
    raw.thinkingLevel !== undefined ||
    raw.handoffContextFile !== undefined
  ) {
    throw new Error('SDK options require runtime sdk.');
  }
  if (
    (raw.model as string).startsWith('-') ||
    /[\r\n]/.test(raw.model as string)
  )
    throw new Error('model must be a native Pi model identifier.');
  if (
    raw.shutdownGraceMs !== undefined &&
    (!Number.isSafeInteger(raw.shutdownGraceMs) ||
      (raw.shutdownGraceMs as number) < 1 ||
      (raw.shutdownGraceMs as number) > 30_000)
  )
    throw new Error('shutdownGraceMs must be between 1 and 30000.');
  if (raw.readiness !== undefined) {
    const readiness = raw.readiness;
    if (
      typeof readiness !== 'object' ||
      readiness === null ||
      Array.isArray(readiness)
    )
      throw new Error(
        'readiness must pin assignmentFile, templateFile and cardFile.',
      );
    const fields = readiness as Record<string, unknown>;
    if (
      Object.keys(fields).sort().join('|') !==
        'assignmentFile|cardFile|templateFile' ||
      Object.values(fields).some(
        (field) =>
          typeof field !== 'string' ||
          !path.isAbsolute(field) ||
          field.includes('\0') ||
          field.length > 4096,
      )
    )
      throw new Error('readiness requires three absolute file paths.');
    if (
      new Set(Object.values(fields).map((file) => path.resolve(file as string)))
        .size !== 3
    )
      throw new Error('readiness inputs and output must be separate files.');
  }
  return value as ManagedPiRequest;
}

export function planManagedPiSession(request: ManagedPiRequest) {
  return {
    schema: 'pappra/managed-pi-session-plan/1',
    cwd: fs.realpathSync(request.cwd),
    provider: 'openrouter',
    model: request.model,
    journal_path: request.journalPath,
    control_descriptor: `${request.journalPath}.control.json`,
    native_tui: true,
    runtime: request.runtime ?? 'pty',
    launch_kind: request.resume ? 'controlled-resume' : 'fresh-session',
    resume: request.resume
      ? {
          source_journal: request.resume.sourceJournalPath,
          authority: 'requires-dead-source-checkpoint-and-task-reservation',
        }
      : null,
    daily_configuration: 'preserved',
    transfer_safe_quiescence: 'unavailable',
    owned_runtime_quiescence:
      request.runtime === 'sdk'
        ? 'pinned-version-runtime-scope'
        : 'unavailable',
    execution_scope: request.executionScope
      ? 'requires-live-task-binding'
      : null,
    effect: 'none',
    readiness: request.readiness
      ? { mode: 'native-resource-events', cardFile: request.readiness.cardFile }
      : null,
  } as const;
}
