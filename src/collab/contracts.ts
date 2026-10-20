import { object } from './validation.js';
import type { Identity, ResourceInput } from './types.js';

export interface SkillRequirement {
  id: string;
  bundle_digest: string;
}
export interface Requirements {
  skills: SkillRequirement[];
  tools: string[];
}
export interface Assignment {
  schema: string;
  task_id: string;
  assignment_id: string;
  objective: string;
  attempt: number;
  roles: string[];
  acceptance: string[];
  coordinator: Pick<Identity, 'agent_id' | 'session_id'> & {
    owner_epoch: number;
    harness?: string | null;
  };
  assignee: Identity & {
    harness: string;
    cwd: string;
    surface: string;
    configuration_id: string;
  };
  inputs: { ref: string; digest: string }[];
  resources: (ResourceInput & {
    path: string;
    access: string;
    resource_epoch?: number;
  })[];
  runner: {
    name: string;
    mode: string;
    profile?: string;
    omitted_capabilities: string[];
  };
  required: Requirements;
  preferred: Requirements;
  [key: string]: unknown;
}
export interface Capability {
  id: string;
  state: string;
  evidence_ref?: string;
  path?: string;
  bundle_digest?: string;
}
export interface CapabilityCard {
  schema: string;
  agent_id: string;
  session_id: string;
  harness: string;
  surface: string;
  configuration_id: string;
  cwd: string;
  observed_at: string;
  evidence_level: string;
  evidence_records?: { ref: string; digest: string }[];
  skills: Capability[];
  tools: Capability[];
  [key: string]: unknown;
}
const string = (value: unknown) => typeof value === 'string';
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(string);
const number = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value);
function requirements(value: unknown): value is Requirements {
  return (
    object(value) &&
    strings(value['tools']) &&
    Array.isArray(value['skills']) &&
    value['skills'].every(
      (item: unknown) =>
        object(item) && string(item['id']) && string(item['bundle_digest']),
    )
  );
}
const refs = (value: unknown) =>
  Array.isArray(value) &&
  value.every(
    (item: unknown) =>
      object(item) && string(item['ref']) && string(item['digest']),
  );
export function isAssignment(value: unknown): value is Assignment {
  if (
    !object(value) ||
    !['schema', 'task_id', 'assignment_id', 'objective'].every((key) =>
      string(value[key]),
    )
  )
    return false;
  const coordinator = value['coordinator'];
  const assignee = value['assignee'];
  const runner = value['runner'];
  return (
    number(value['attempt']) &&
    strings(value['roles']) &&
    strings(value['acceptance']) &&
    object(coordinator) &&
    ['agent_id', 'session_id'].every((key) => string(coordinator[key])) &&
    number(coordinator['owner_epoch']) &&
    object(assignee) &&
    [
      'agent_id',
      'session_id',
      'harness',
      'cwd',
      'surface',
      'configuration_id',
    ].every((key) => string(assignee[key])) &&
    refs(value['inputs']) &&
    Array.isArray(value['resources']) &&
    value['resources'].every(
      (item: unknown) =>
        object(item) &&
        string(item['path']) &&
        string(item['access']) &&
        (item['kind'] === undefined || string(item['kind'])) &&
        (item['port'] === undefined || number(item['port'])) &&
        (item['resource_epoch'] === undefined ||
          number(item['resource_epoch'])),
    ) &&
    object(runner) &&
    string(runner['name']) &&
    string(runner['mode']) &&
    strings(runner['omitted_capabilities']) &&
    (runner['profile'] === undefined || string(runner['profile'])) &&
    requirements(value['required']) &&
    requirements(value['preferred'])
  );
}
export function isCard(value: unknown): value is CapabilityCard {
  if (
    !object(value) ||
    ![
      'schema',
      'agent_id',
      'session_id',
      'harness',
      'surface',
      'configuration_id',
      'cwd',
      'observed_at',
      'evidence_level',
    ].every((key) => string(value[key]))
  )
    return false;
  return (
    (value['evidence_records'] === undefined ||
      refs(value['evidence_records'])) &&
    ['skills', 'tools'].every((kind) => {
      const entries = value[kind];
      return (
        Array.isArray(entries) &&
        entries.every(
          (item: unknown) =>
            object(item) &&
            string(item['id']) &&
            string(item['state']) &&
            ['evidence_ref', 'path', 'bundle_digest'].every(
              (key) => item[key] === undefined || string(item[key]),
            ),
        )
      );
    })
  );
}
