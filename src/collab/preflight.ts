import type {
  Assignment,
  CapabilityCard,
  Requirements,
  Capability,
} from './contracts.js';
import { object, text } from './validation.js';
export interface Check {
  code: string;
  capability?: string;
}
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fingerprintSkill } from './fingerprint.js';

const record = object;

const digest = (value: unknown) =>
  typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const positive = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const states = new Set([
  'declared',
  'discovered',
  'callable',
  'verified',
  'disabled',
  'unknown',
]);
const readyStates = new Set(['callable', 'verified']);

function assert(condition: unknown, field: string): asserts condition {
  if (!condition) throw new Error(`Invalid field: ${field}`);
}

function requirements(value: Requirements, field: string) {
  assert(record(value), field);
  assert(Array.isArray(value.skills) && Array.isArray(value.tools), field);
  const keys = new Set();
  for (const skill of value.skills) {
    assert(
      record(skill) && text(skill.id) && digest(skill.bundle_digest),
      `${field}.skills`,
    );
    assert(!keys.has(`skill:${skill.id}`), `${field}.skills duplicate`);
    keys.add(`skill:${skill.id}`);
  }
  for (const tool of value.tools) {
    assert(text(tool) && !keys.has(`tool:${tool}`), `${field}.tools`);
    keys.add(`tool:${tool}`);
  }
}

export function validateContractAndCard(
  contract: Assignment,
  card: CapabilityCard,
) {
  assert(record(contract), 'contract');
  assert(contract.schema === 'harness-collab/assignment/1', 'contract.schema');
  for (const key of ['task_id', 'assignment_id', 'objective'])
    assert(text(contract[key]), `contract.${key}`);
  assert(positive(contract.attempt), 'contract.attempt');
  assert(
    Array.isArray(contract.roles) &&
      contract.roles.length > 0 &&
      contract.roles.every(text),
    'contract.roles',
  );
  assert(
    Array.isArray(contract.acceptance) &&
      contract.acceptance.length > 0 &&
      contract.acceptance.every(text),
    'contract.acceptance',
  );
  assert(
    record(contract.coordinator) &&
      text(contract.coordinator.agent_id) &&
      text(contract.coordinator.session_id) &&
      positive(contract.coordinator.owner_epoch),
    'contract.coordinator',
  );
  assert(record(contract.assignee), 'contract.assignee');
  for (const key of [
    'agent_id',
    'session_id',
    'harness',
    'surface',
    'configuration_id',
  ] as const) {
    assert(text(contract.assignee[key]), `contract.assignee.${key}`);
  }
  assert(
    text(contract.assignee.cwd) && path.isAbsolute(contract.assignee.cwd),
    'contract.assignee.cwd',
  );
  assert(
    Array.isArray(contract.inputs) && contract.inputs.length > 0,
    'contract.inputs',
  );
  for (const input of contract.inputs) {
    assert(
      record(input) &&
        text(input.ref) &&
        path.isAbsolute(input.ref) &&
        digest(input.digest),
      'contract.inputs item',
    );
  }
  assert(Array.isArray(contract.resources), 'contract.resources');
  for (const resource of contract.resources) {
    assert(
      record(resource) &&
        text(resource.path) &&
        path.isAbsolute(resource.path) &&
        ['read', 'write'].includes(resource.access),
      'contract.resources item',
    );
    if (resource.access === 'write')
      assert(
        positive(resource.resource_epoch),
        'contract.resources.resource_epoch',
      );
  }
  assert(
    record(contract.runner) &&
      text(contract.runner.name) &&
      text(contract.runner.mode) &&
      Array.isArray(contract.runner.omitted_capabilities) &&
      contract.runner.omitted_capabilities.every(text),
    'contract.runner',
  );
  requirements(contract.required, 'contract.required');
  requirements(contract.preferred, 'contract.preferred');
  assert(
    record(card) && card.schema === 'harness-collab/capabilities/1',
    'capabilities.schema',
  );
  for (const key of [
    'agent_id',
    'session_id',
    'harness',
    'surface',
    'configuration_id',
  ] as const) {
    assert(text(card[key]), `capabilities.${key}`);
  }
  assert(text(card.cwd) && path.isAbsolute(card.cwd), 'capabilities.cwd');
  assert(
    text(card.observed_at) &&
      /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(card.observed_at) &&
      Number.isFinite(Date.parse(card.observed_at)),
    'capabilities.observed_at',
  );
  assert(
    ['runtime', 'declared'].includes(card.evidence_level),
    'capabilities.evidence_level',
  );
  if (card.evidence_records !== undefined) {
    assert(
      Array.isArray(card.evidence_records) && card.evidence_records.length > 0,
      'capabilities.evidence_records',
    );
    for (const item of card.evidence_records) {
      assert(
        record(item) &&
          text(item.ref) &&
          path.isAbsolute(item.ref) &&
          digest(item.digest),
        'capabilities.evidence_records item',
      );
    }
  }
  for (const kind of ['skills', 'tools'] as const) {
    assert(Array.isArray(card[kind]), `capabilities.${kind}`);
    const ids = new Set();
    for (const item of card[kind]) {
      assert(
        record(item) && text(item.id) && states.has(item.state),
        `capabilities.${kind} item`,
      );
      assert(!ids.has(item.id), `capabilities.${kind} duplicate`);
      ids.add(item.id);
      if (kind === 'skills') {
        assert(
          text(item.path) &&
            path.isAbsolute(item.path) &&
            digest(item.bundle_digest),
          'capabilities.skills fingerprint',
        );
      }
      if (readyStates.has(item.state))
        assert(text(item.evidence_ref), `capabilities.${kind} evidence_ref`);
    }
  }
}

/** Validate reported readiness, not authorization, resource locking, or task completion. */
export function preflight(
  contract: Assignment,
  card: CapabilityCard,
  { now = Date.now(), maxAgeMinutes = 30 } = {},
) {
  try {
    assert(
      Number.isFinite(now) &&
        Number.isFinite(new Date(now).getTime()) &&
        Number.isFinite(maxAgeMinutes) &&
        maxAgeMinutes > 0,
      'clock/maximum age',
    );
    validateContractAndCard(contract, card);
  } catch (error) {
    return {
      status: 'invalid',
      errors: [error instanceof Error ? error.message : String(error)],
      blockers: [],
      warnings: [],
    };
  }
  const blockers: Check[] = [];
  const warnings: Check[] = [];
  const add = (list: Check[], code: string, capability?: string) =>
    list.push({ code, ...(capability ? { capability } : {}) });
  for (const key of [
    'agent_id',
    'session_id',
    'harness',
    'surface',
    'configuration_id',
  ] as const) {
    if (contract.assignee[key] !== card[key])
      add(blockers, `assignee_${key}_mismatch`);
  }
  try {
    if (
      !fs.statSync(card.cwd).isDirectory() ||
      fs.realpathSync(contract.assignee.cwd) !== fs.realpathSync(card.cwd)
    ) {
      add(blockers, 'assignee_cwd_mismatch');
    }
  } catch {
    add(blockers, 'assignee_cwd_unavailable');
  }
  const age = now - Date.parse(card.observed_at);
  if (age > maxAgeMinutes * 60_000) add(blockers, 'capabilities_stale');
  if (age < -60_000) add(blockers, 'capabilities_from_future');
  if (card.evidence_level !== 'runtime')
    add(blockers, 'runtime_capabilities_unconfirmed');
  const omitted = contract.runner.omitted_capabilities;
  if (
    (omitted.includes('skills') && contract.required.skills.length) ||
    (omitted.includes('tools') && contract.required.tools.length) ||
    contract.required.skills.some((skill) =>
      omitted.includes(`skill:${skill.id}`),
    ) ||
    contract.required.tools.some((tool) => omitted.includes(`tool:${tool}`)) ||
    (omitted.includes('mcp') &&
      contract.required.tools.some((tool) => /^(mcp:|mcp__)/.test(tool)))
  ) {
    add(blockers, 'required_capability_omitted_by_runner');
  }

  function evidenceAvailable(item: Capability) {
    if (item.evidence_ref === `session:${card.session_id}`) return true;
    if (!text(item.evidence_ref) || !path.isAbsolute(item.evidence_ref))
      return false;
    try {
      return fs.statSync(item.evidence_ref).isFile();
    } catch {
      return false;
    }
  }
  function check(group: Requirements, target: Check[]) {
    for (const kind of ['skills', 'tools'] as const) {
      for (const required of kind === 'skills'
        ? group.skills
        : group.tools.map((id) => ({ id, bundle_digest: null }))) {
        const id = required.id;
        const item = card[kind].find((candidate) => candidate.id === id);
        if (!item || !readyStates.has(item.state)) {
          add(target, `${kind}_unavailable`, id);
          continue;
        }
        if (!evidenceAvailable(item))
          add(target, `${kind}_evidence_unavailable`, id);
        if (kind === 'skills') {
          if (item.bundle_digest !== required.bundle_digest)
            add(target, 'skill_version_mismatch', id);
          try {
            if (
              fingerprintSkill(item.path ?? '').bundle_digest !==
              item.bundle_digest
            )
              add(target, 'skill_files_changed', id);
          } catch {
            add(target, 'skill_files_unavailable', id);
          }
        }
      }
    }
  }
  check(contract.required, blockers);
  check(contract.preferred, warnings);
  for (const evidence of card.evidence_records ?? []) {
    try {
      if (
        !fs.statSync(evidence.ref).isFile() ||
        fs.statSync(evidence.ref).size > 16 * 1024 * 1024
      )
        throw new Error('Evidence limit');
      const actual = `sha256:${createHash('sha256').update(fs.readFileSync(evidence.ref)).digest('hex')}`;
      if (actual !== evidence.digest) add(blockers, 'native_evidence_changed');
    } catch {
      add(blockers, 'native_evidence_unavailable');
    }
  }
  for (const input of contract.inputs) {
    try {
      const stat = fs.statSync(input.ref);
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
        throw new Error('Input limit');
      // Read bytes only to hash them; never include the input text in diagnostics.
      const actual = `sha256:${createHash('sha256').update(fs.readFileSync(input.ref)).digest('hex')}`;
      if (actual !== input.digest) add(blockers, 'input_changed');
    } catch {
      add(blockers, 'input_unavailable');
    }
  }
  if (contract.runner.omitted_capabilities.length)
    add(warnings, 'runner_capabilities_omitted');
  if (contract.resources.some((resource) => resource.access === 'write'))
    add(warnings, 'resource_ownership_not_enforced');
  return {
    status: blockers.length ? 'needs_input' : 'ready',
    task_id: contract.task_id,
    assignment_id: contract.assignment_id,
    attempt: contract.attempt,
    checked_at: new Date(now).toISOString(),
    errors: [],
    blockers,
    warnings,
    limits: [
      'reported_runtime_evidence_only',
      'authorization_not_checked',
      'no_resource_lock',
      'no_dispatch',
    ],
  };
}
