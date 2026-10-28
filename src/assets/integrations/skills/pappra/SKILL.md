---
name: pappra
description: Use Pappra workspace knowledge, checkpoint/resume, selected-repository code intelligence, and task-scoped cross-harness collaboration from any supported coding agent. Use before nontrivial repository work to reach the project's own skill and CodeGraph entry, when a task needs durable handoff context, workspace documents, or bounded code navigation, and when independent parallel implementation or independent review would reduce risk even if the user never names collaboration.
---

# Pappra

Pappra keeps workspace knowledge, continuity, and code navigation outside the
host transcript. Use the installed `pappra` CLI for durable operations; hooks
only record bounded lifecycle observations and never start a model, download,
index, or new writer.

In Pappra's own checkout, every `pappra` example below means
`node dist/cli/main.js`, including collaboration. Use the project's current
build, not an older global binary. In another workspace, use its explicitly
selected installed CLI. During implementation, run affected checks; coordinate
one full integration gate at the release boundary and avoid shared build races.

## Start here

1. Read `references/lifecycle.md` before relying on a host lifecycle event.
2. Read `references/hosts.md` when the host surface is Pi, Codex, or Claude.
3. Use `pappra checkpoint` / `pappra resume` for handoffs. A stored checkpoint
   is context, not permission to execute or to trust a previous session.
4. Use `pappra docs`, `pappra code`, `pappra runtime` and `pappra host` only for
   the workspace selected by the current root. Never infer a workspace from an
   unrelated session. `pappra docs scan --apply` registers discovered documents;
   `pappra runtime install --apply` keeps a durable copy of this package.
5. For task-scoped collaboration, read `references/environment.md` first to
   choose direct versus visible Herdr operation, bootstrap or reuse the
   receiving instance, and bind its routing identity. Then read
   `references/collaboration.md` and build the shared strict
   `pappra/collaboration-goal/1` from explicit choices. The installed CLI accepts
   `pappra collab prepare --goal <file> --domain-root <dir>`; it has no preview
   mode, so it mutates task state, claims resources and registers the initial
   ASSIGN once authorized. MCP `collab_prepare` accepts `{ domainRoot, goal }`
   and rejects the retired flat objective form. Neither prepares a capability
   card; derive and preflight actual runtime evidence separately, and notify the
   already-registered ASSIGN rather than sending a duplicate. Visible peers are
   the default collaboration channel; the owned Pi `pi-rpc` run remains a
   separate explicit option, and fixtures are explicit only. Never turn prose
   into identity, approval, or capability claims.

## Typed workflow (preferred entry)

Use `pappra collab workflow <prepare|dispatch|ack|report|accept|release|reclaim|adopt|await|inspect>`
for a task-scoped cohort. One declared request per step replaces hand-built
envelopes and manual digest bookkeeping: prepare derives the sealed assignment
documents, digests, deterministic message ids and correlated ASSIGN envelopes,
and plan mode writes nothing at all.

Reviewer ASSIGN messages and read claims stay deferred until accepted writers
release; dispatch re-derives the current capability card immediately before
notifying and never replays an unknown delivery; `ack`, `report` and `release`
are self-call only, and `accept` is a separate coordinator decision that a writer
can never make for itself. The facade is bookkeeping over the existing record,
claims, message and work-plan engines — it grants no authority of its own. See
`references/workflow.md`. The lower-level commands below remain the
escape hatch for anything the facade does not model.

## One-request collaboration

Visible collaboration uses `references/environment.md` plus the persisted
message/notify loop in `references/collaboration.md`. The owned `collab run`
flow described here is the separate Pi RPC option, not a substitute for a
visible participant.

`pappra collab prepare --goal <file> --domain-root <dir>` requires an explicit
shared domain. It validates the canonical domain/tasks/task/private namespace
before writing any task metadata and again around each write, so a task-root or
mid-write directory redirect fails closed instead of scattering artifacts. It
then writes a private task record, assignment, prompt, and resource claims; read
resources stay read claims. The captured identities also guard live query, finish, disposal and lower RPC artifact writes; after a redirect, no new query/execution/proof/current-result pathname is written. `pappra collab run` requires an explicit `--controller <fixture|pi-rpc>`,
performs the single admitted launch, and accepts bounded
`pappra/collaboration-command/1` JSONL on stdin; it emits
`pappra/collaboration-event/1` JSONL. `query` reads persisted history only and
reports live ownership as unknown. A `finish` produces one deterministic REPORT;
only a result whose stored classification was `applied` for the same fixed
identity/attempt/input may repeat successfully as a duplicate — repeated
rejections stay rejected. Cancel records and validates intent first: a denied
intent never calls the native controller. Claims are retained and stop proof is
never invented.

Use `--controller fixture` only for deterministic, no-model tests; it is a
restricted explicit fixture, never a silent default. The optional `pi-rpc` controller
uses the existing owned Pi RPC daily path and preserves required skills, tools,
MCP, hooks, and model settings; missing capabilities or stale/forged admission
fail before launch. A native run reports only the current prompt-correlated
result: terminal success requires a supported terminal reason and no pending
tool call, so text-plus-toolUse/intermediate, tool-only, empty, old, malformed or
missing answers are `unknown`; an explicit error is `failed` and an abort is
`cancelled`. The current result must be published as validated
`native-current-result/1` evidence; EIO/conflict/symlink/partial publication
makes delivery `unknown`, not success, and repeated finish reuses verified
content instead of overwriting it. A clean transport exit is not task success.
No approval is auto-answered, no cancel is inferred from an acknowledgement, and no new thread or
arbitrary PID is adopted. Do not launch a model or real user session without
the task's explicit authorization.

## Role plans and host-agent role selection

Choosing whether work needs independent implementation or an independent reviewer
is the host agent's judgment from the user's objective and the actual change
surface: complexity, dependency blast radius, disjoint write scopes, and risk.
There is no backend role inferencer, no fixed participant count, and no repeated
permission prompt once the user authorized the work.

Make the choice explicit before implementation. A cohesive writer may stay in
the primary session, but changes to authorization, resource ownership, durable
state/recovery or release execution need independent review before completion.
Use this workflow to assign that review to an observed native participant; a
single write scope is not a reason to skip it. A review-only assignment can
itself satisfy independent review and needs no recursive reviewer. Delegate
disjoint implementation scopes when that reduces the critical path. If identity,
the native channel or a required capability is unavailable, record the specific
blocker and keep review outstanding; never silently substitute self-review or
another harness. Ordinary local reversible edits remain direct work.

Use the installed commands in this order; roles never grant authority:

- `pappra collab role-plan expand --request <abs role-plan.json> --json` expands
  explicit participants, assignments and disjoint writer scopes into the existing
  work-plan format. Save the returned `plan`.
- `pappra collab plan --task-root <abs> --config <abs expanded-plan.json>` and
  `pappra collab work-run --request <abs work-execution.json> [--apply]` keep
  their existing admission, capability and dispatch requirements.
- `pappra collab role-run --request <abs role-orchestration.json> [--apply]`
  reads authoritative role/dependency state; `--apply` handles one bounded event
  tick and reserves before dispatch. Neither infers acceptance.
- `pappra collab role-plan aggregate --request <abs role-plan.json>` with
  `--task-root <abs> --config <abs expanded-plan.json>` aggregates authoritative
  results.

Roles describe responsibility and scope only: they approve nothing and never
synthesize a participant identity or capability card. Hooks record lifecycle
observations only and never select roles or launch a model. Keep the manual path:
a simple, reversible, local change needs no role plan.

## Recovery and parallel work

Use `pappra collab work-run --request <abs-request.json>` for a read-only plan and add `--apply` only when the existing assignments, current capability cards, coordinator authority, resource claims and visible participant binding are ready. Work-run notifies only registered participants; it does not create sessions, merge, accept reports, or replay ambiguous delivery.

Use `pappra collab recovery-run --request <abs-request.json>` to inspect one guarded recovery action; add `--apply` only with exact current session/cwd/harness/pane and a digest-pinned task-local binding. Recovery is a bounded single wake, not generic outage recovery: there is no reconnect trigger, hidden worker, approval automation, or replay after an unknown effect.

For an explicitly selected Pi package, `pappra host bundle --host pi --out <new-private-dir> --recovery-config <abs-private-config.json>` exports the recovery extension and its private sibling config. Add `--transition-extension` to export the separate `/collab-transition` command extension. Exports do not install, trust, enable, load, launch, or transfer anything; review and install packages explicitly. Interactive-Pi native quiescence and interactive Pi session takeover remain unsupported; the pinned managed-SDK runtime has a separate scoped quiescence-proof path. Task retirement is not native session archive.

## Boundaries

- Hooks are local and bounded. They do not read transcripts, run commands,
  call models, fetch the network, or continue a conversation.
- Missing semantic context stays missing; do not fabricate summaries.
- Treat unknown ownership, stale bundles, untrusted hooks, and changed host
  versions as visible conditions, not silent fallbacks.
- Preserve user settings and unrelated keys when integrating a host.
