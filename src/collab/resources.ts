import type {
  TaskRecord,
  Identity,
  Resource,
  ResourceInput,
  Claim,
  UnreadableRecord,
} from './types.js';
import { errorCode, parseJson, object } from './validation.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { claimsOverlap, describeResource } from './canonical.js';
import {
  createNonce,
  nowIso,
  readRecord,
  transact,
  STATE_SCHEMA,
} from './store.js';

// Resource claims are checked in one explicit resource domain: every task record under
// the same domain root is scanned, so two task-roots cannot each believe they own the
// same real path. Tasks outside that domain root are not covered and are not claimed
// to be protected.

export const DOMAIN_LOCK = '.domain.lock';

export class DomainLockHeldError extends Error {
  constructor(
    message: string,
    public readonly holder: unknown,
  ) {
    super(message);
    this.name = 'DomainLockHeldError';
    this.holder = holder;
  }
}

export function acquireDomainLock(
  domainRoot: string,
  {
    waitMs = 5000,
    pollMs = 20,
    holder = {},
  }: {
    waitMs?: number;
    pollMs?: number;
    holder?: Record<string, unknown>;
  } = {},
) {
  const lockDir = path.join(domainRoot, DOMAIN_LOCK);
  return acquireLockWithDirectory(domainRoot, lockDir, {
    waitMs,
    pollMs,
    holder,
  });
}

export function releaseDomainLock(
  domainRoot: string,
  holder: { nonce: string },
) {
  releaseLockDirectory(path.join(domainRoot, DOMAIN_LOCK), holder);
}

function acquireLockWithDirectory(
  domainRoot: string,
  lockDir: string,
  options: {
    waitMs?: number;
    pollMs?: number;
    nonce?: string;
    holder?: Record<string, unknown>;
  },
) {
  const nonce = options?.nonce ?? createNonce();
  const deadline = Date.now() + (options?.waitMs ?? 5000);
  const poll = options?.pollMs ?? 20;
  for (;;) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      const holder = {
        schema: 'harness-collab/lock/1',
        scope: 'resource-domain',
        domain_root: domainRoot,
        nonce,
        pid: process.pid,
        at: nowIso(),
        ...(options?.holder ?? {}),
      };
      fs.writeFileSync(
        path.join(lockDir, 'holder.json'),
        `${JSON.stringify(holder, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      return holder;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      if (Date.now() >= deadline)
        throw new DomainLockHeldError(
          'Resource-domain lock is already held; the lock is never taken over by time',
          null,
        );
      const until = Date.now() + poll;
      while (Date.now() < until) {
        // Bounded wait; the domain lock has no TTL.
      }
    }
  }
}

function releaseLockDirectory(lockDir: string, holder: { nonce: string }) {
  try {
    const current = parseJson(
      fs.readFileSync(path.join(lockDir, 'holder.json'), 'utf8'),
    );
    if (!object(current)) throw new Error('Invalid domain lock holder');
    if (holder?.nonce && current.nonce !== holder.nonce)
      throw new Error(
        'Refusing to release a domain lock held by another owner',
      );
    fs.rmSync(path.join(lockDir, 'holder.json'), { force: true });
    fs.rmdirSync(lockDir);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

/**
 * Resolve the git index/HEAD resources implied by a path inside a work tree.
 * Only per-worktree index/HEAD are derived automatically; a shared common-dir
 * operation must be claimed explicitly so ordinary edits in two worktrees stay parallel.
 */
export function gitResourcesFor(targetPath: string): ResourceInput[] {
  let probe = targetPath;
  for (;;) {
    const dotGit = path.join(probe, '.git');
    let stat = null;
    try {
      stat = fs.lstatSync(dotGit);
    } catch {
      stat = null;
    }
    if (stat?.isDirectory())
      return gitResourcesFromDir(fs.realpathSync(dotGit), probe);
    if (stat?.isFile()) {
      const content = fs.readFileSync(dotGit, 'utf8').trim();
      const match = /^gitdir:\s*(.+)$/.exec(content);
      if (!match) return [];
      const resolved = path.resolve(probe, match[1]!.trim());
      if (!fs.existsSync(resolved)) return [];
      return gitResourcesFromDir(resolved, probe);
    }
    const parent = path.dirname(probe);
    if (parent === probe) return [];
    probe = parent;
  }
}

function gitResourcesFromDir(
  gitDir: string,
  workTree: string,
): ResourceInput[] {
  const resources: ResourceInput[] = [
    {
      kind: 'git-index',
      path: path.join(gitDir, 'index'),
      label: `git index of ${workTree}`,
    },
    {
      kind: 'git-head',
      path: path.join(gitDir, 'HEAD'),
      label: `git HEAD of ${workTree}`,
    },
  ];
  try {
    const common = fs
      .readFileSync(path.join(gitDir, 'commondir'), 'utf8')
      .trim();
    const commonDir = fs.realpathSync(path.resolve(gitDir, common));
    resources.push({
      kind: 'git-common-dir',
      path: commonDir,
      scope: 'tree',
      derived: true,
      shared: true,
      label: `shared git dir of ${workTree}`,
    });
  } catch {
    // Not a linked work tree: the git dir is already the common dir.
  }
  return resources;
}

export function expandResources(
  requested: ResourceInput[],
  { includeGit = true, includeSharedGit = false } = {},
) {
  // One claim per canonical key. A path reached through several requests, a repeated path, a
  // symlink alias, or an explicit/derived pair must not become two claims on one real
  // resource, because the second claim would then be unreachable through its shared id.
  // Requested metadata wins over derived metadata for the same key; the first occurrence
  // fixes the reported order.
  const sources = [];
  for (const item of requested)
    sources.push({ item, descriptor: describeResource(item) });
  const positionByKey = new Map<string, number>();
  const expanded: Resource[] = [];
  const add = (entry: Resource) => {
    const position = positionByKey.get(entry.key);
    if (position === undefined) {
      positionByKey.set(entry.key, expanded.length);
      expanded.push(entry);
      return;
    }
    if (
      expanded[position]?.origin === 'derived' &&
      entry.origin === 'requested'
    )
      expanded[position] = entry;
  };
  for (const { item, descriptor } of sources)
    add({ ...descriptor, origin: item.origin ?? 'requested' });
  if (includeGit) {
    for (const { descriptor } of sources) {
      if (descriptor.kind !== 'path' || descriptor.scope !== 'tree') continue;
      if (typeof descriptor.path !== 'string')
        throw new Error('Path resource has no path');
      for (const derived of gitResourcesFor(descriptor.path)) {
        if (derived.kind === 'git-common-dir' && !includeSharedGit) continue;
        const described = describeResource(derived);
        add({ ...described, origin: 'derived', derived_from: descriptor.key });
      }
    }
  }
  return expanded;
}

export function listDomainRecords(
  domainRoot: string,
): (TaskRecord | UnreadableRecord)[] {
  const tasksDirectory = path.join(domainRoot, 'tasks');
  const records: (TaskRecord | UnreadableRecord)[] = [];
  let names = [];
  try {
    names = fs.readdirSync(tasksDirectory).sort();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return records;
    throw error;
  }
  for (const name of names) {
    try {
      const record = readRecord(path.join(tasksDirectory, name));
      if (record && record.schema !== STATE_SCHEMA)
        throw new Error('Unsupported task record schema');
      if (record) records.push(record);
    } catch {
      // A record that cannot be read is reported by doctor, not silently treated as empty.
      records.push({ task_id: name, __unreadable: true, claims: [] });
    }
  }
  return records;
}

export function activeClaims(record: TaskRecord | UnreadableRecord) {
  return (record.claims ?? []).filter((claim) => !claim.released_at);
}

export function scanConflicts(
  records: (TaskRecord | UnreadableRecord)[],
  candidates: Resource[],
  { access, holder }: { access: string; holder: Identity },
) {
  const conflicts = [];
  for (const record of records) {
    if (record.__unreadable) {
      // Unknown ownership is never treated as free ownership.
      for (const candidate of candidates) {
        conflicts.push({
          resource_key: candidate.key,
          kind: candidate.kind,
          held_by: null,
          held_task: record.task_id,
          held_claim: null,
          held_access: 'unknown',
          relation: 'unknown_state',
        });
      }
      continue;
    }
    for (const claim of activeClaims(record)) {
      for (const candidate of candidates) {
        if (!claimsOverlap(claim, candidate)) continue;
        const sameHolder =
          claim.holder?.agent_id === holder?.agent_id &&
          claim.holder?.session_id === holder?.session_id;
        if (sameHolder) continue;
        if (claim.access === 'read' && access === 'read') continue;
        conflicts.push({
          resource_key: candidate.key,
          kind: candidate.kind,
          held_by: claim.holder,
          held_task: record.task_id,
          held_claim: claim.claim_id,
          held_access: claim.access,
          relation:
            claim.path && candidate.path
              ? claim.path === candidate.path
                ? 'same'
                : 'overlapping'
              : 'same_key',
        });
      }
    }
  }
  return conflicts;
}

function nextResourceEpoch(
  records: (TaskRecord | UnreadableRecord)[],
  keys: string[],
) {
  let epoch = 0;
  for (const record of records) {
    for (const claim of record.claims ?? []) {
      if (keys.includes(claim.key))
        epoch = Math.max(epoch, claim.resource_epoch ?? 0);
    }
  }
  return epoch + 1;
}

/**
 * Claim resources for one task. The domain lock serialises the decision so two tasks
 * cannot both observe an empty domain and then claim the same path.
 */
export function claimResources(
  taskRoot: string,
  {
    resources,
    access = 'write',
    holder,
    waitMs = 5000,
    clock = Date.now(),
    includeSharedGit = false,
    note = null,
    subtaskId = null,
    attempt = null,
  }: {
    resources: ResourceInput[];
    access?: string;
    holder: Identity;
    waitMs?: number;
    clock?: number;
    includeSharedGit?: boolean;
    note?: string | null;
    subtaskId?: string | null;
    attempt?: number | null;
  },
) {
  const record = readRecord(taskRoot);
  if (!record) return { ok: false as const, reason: 'not_initialised' };
  if (!['read', 'write'].includes(access))
    return { ok: false as const, reason: 'invalid_access' };
  if (!holder?.agent_id || !holder?.session_id)
    return { ok: false as const, reason: 'holder_required' };
  const domainRoot = record.domain_root;
  const domainLock = acquireDomainLock(domainRoot, {
    waitMs,
    holder: { actor: holder.agent_id },
  });
  try {
    const records = listDomainRecords(domainRoot);
    const unreadable = records
      .filter((item) => item.__unreadable)
      .map((item) => item.task_id);
    if (unreadable.length) {
      // An unreadable record may hold exactly the resource being requested, so the domain
      // state is unknown: refuse and require reconciliation instead of assuming it is free.
      return {
        ok: false as const,
        reason: 'domain_state_unknown',
        unreadable_tasks: unreadable,
        detail:
          'at least one task record in this domain cannot be parsed; reconcile it before claiming',
      };
    }
    // Only a write claim implies the work-tree index/HEAD resources; a read claim does not.
    const candidates = expandResources(resources, {
      includeGit: access === 'write',
      includeSharedGit: access === 'write' && includeSharedGit,
    });
    const conflicts = scanConflicts(records, candidates, { access, holder });
    if (conflicts.length)
      return { ok: false as const, reason: 'resource_conflict', conflicts };
    const keys = candidates.map((item) => item.key);
    const resourceEpoch = nextResourceEpoch(records, keys);
    const at = nowIso(clock);
    const created: Claim[] = candidates.map((item) => ({
      claim_id: `claim-${item.kind}-${claimIdDigest([holder.agent_id, holder.session_id, item.key, resourceEpoch])}-${resourceEpoch}`,
      key: item.key,
      kind: item.kind,
      scope: item.scope,
      path: item.path ?? null,
      port: item.port ?? null,
      label: item.label,
      origin: item.origin ?? 'requested',
      derived_from: item.derived_from ?? null,
      access,
      holder: {
        agent_id: holder.agent_id,
        session_id: holder.session_id,
        harness: holder.harness ?? null,
      },
      resource_epoch: resourceEpoch,
      claimed_at: at,
      released_at: null,
      subtask_id: subtaskId ?? null,
      attempt: Number.isSafeInteger(attempt) ? attempt : null,
      note,
    }));
    const outcome = transact(taskRoot, {
      actor: holder.agent_id,
      purpose: 'claim',
      waitMs,
      clock,
      apply: (current) => {
        const fresh = scanConflicts(
          [
            current,
            ...records.filter((item) => item.task_id !== current.task_id),
          ],
          candidates,
          { access, holder },
        );
        if (fresh.length)
          return {
            ok: false as const,
            reason: 'resource_conflict',
            conflicts: fresh,
          };
        current.claims = current.claims ?? [];
        current.claims.push(...created);
        return {
          record: current,
          op: 'claim',
          summary: { keys, resource_epoch: resourceEpoch },
          result: { claims: created },
        };
      },
    });
    if (!outcome.ok) return outcome;
    return {
      ok: true as const,
      claims: created,
      resource_epoch: resourceEpoch,
      conflicts: [],
    };
  } finally {
    releaseDomainLock(domainRoot, domainLock);
  }
}
function claimIdDigest(identity: unknown) {
  // The identity tuple is JSON-encoded, not delimiter-joined: a session id or key that
  // contains the delimiter could otherwise impersonate another tuple. The 128-bit digest
  // replaces the previous 32-bit string hash, which collided for distinct keys (Aa/BB).
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex')
    .slice(0, 32);
}

export function releaseClaim(
  taskRoot: string,
  {
    claimId,
    holder,
    reason,
    clock = Date.now(),
  }: { claimId: string; holder?: Identity; reason?: string; clock?: number },
) {
  const record = readRecord(taskRoot);
  if (!record) return { ok: false as const, reason: 'not_initialised' };
  const outcome = transact(taskRoot, {
    actor: holder?.agent_id ?? 'unattributed',
    purpose: 'release',
    clock,
    apply: (current) => {
      const matches = (current.claims ?? []).filter(
        (item) => item.claim_id === claimId,
      );
      if (!matches.length)
        return { ok: false as const, reason: 'unknown_claim' };
      if (matches.length > 1) {
        // Historical records can hold several claims under one 32-bit-hash id. Releasing
        // "the" claim is then ambiguous: a released alias could coexist with an active
        // claim, or the wrong holder could be selected. Refuse before any mutation.
        return {
          ok: false as const,
          reason: 'ambiguous_claim_id',
          claim_id: claimId,
          matches: matches.length,
          active_matches: matches.filter((item) => !item.released_at).length,
          detail:
            'this record stores more than one claim under the same id; repair the record explicitly instead of releasing through an ambiguous id',
        };
      }
      const claim = matches[0]!;
      if (claim.released_at)
        return { ok: false as const, reason: 'already_released' };
      if (
        holder &&
        (claim.holder?.agent_id !== holder.agent_id ||
          claim.holder?.session_id !== holder.session_id)
      ) {
        return {
          ok: false as const,
          reason: 'holder_mismatch',
          held_by: claim.holder,
        };
      }
      if (claim.cancel_pending)
        return {
          ok: false as const,
          reason: 'cancel_unconfirmed',
          detail: 'a cancel request does not prove the holder stopped',
        };
      claim.released_at = nowIso(clock);
      claim.released_by = holder?.agent_id ?? 'unattributed';
      claim.release_reason = reason ?? null;
      return {
        record: current,
        op: 'release',
        summary: { claim_id: claimId },
        result: { claim_id: claimId },
      };
    },
  });
  return outcome.ok ? { ok: true as const, claim_id: claimId } : outcome;
}

export function domainClaims(record: TaskRecord) {
  return listDomainRecords(record.domain_root)
    .map((item) => ({
      task_id: item.task_id,
      claims: activeClaims(item).map((claim) => ({
        ...claim,
        task_id: item.task_id,
      })),
    }))
    .filter((item) => item.claims.length);
}
