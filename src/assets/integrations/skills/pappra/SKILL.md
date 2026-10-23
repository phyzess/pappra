---
name: pappra
description: Use Pappra workspace knowledge, checkpoint/resume, selected-repository code intelligence, and task-scoped cross-harness collaboration from any supported coding agent. Use when a task needs durable handoff context, workspace documents, bounded code navigation, or a visible/direct multi-agent collaboration workflow.
---

# Pappra

Pappra keeps workspace knowledge, continuity, and code navigation outside the
host transcript. Use the installed `pappra` CLI for durable operations; hooks
only record bounded lifecycle observations and never start a model, download,
index, or new writer.

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

## Recovery and parallel work

Use `pappra collab work-run --request <abs-request.json>` for a read-only plan and add `--apply` only when the existing assignments, current capability cards, coordinator authority, resource claims and visible participant binding are ready. Work-run notifies only registered participants; it does not create sessions, merge, accept reports, or replay ambiguous delivery.

Use `pappra collab recovery-run --request <abs-request.json>` to inspect one guarded recovery action; add `--apply` only with exact current session/cwd/harness/pane and a digest-pinned task-local binding. Recovery is a bounded single wake, not generic outage recovery: there is no reconnect trigger, hidden worker, approval automation, or replay after an unknown effect.

For an explicitly selected Pi package, `pappra host bundle --host pi --out <new-private-dir> --recovery-config <abs-private-config.json>` exports the recovery extension and its private sibling config. Add `--transition-extension` to export the separate `/collab-transition` command extension. Exports do not install, trust, enable, load, launch, or transfer anything; review and install packages explicitly. Native quiescence and interactive Pi session takeover remain unsupported, and task retirement is not native session archive.

## Boundaries

- Hooks are local and bounded. They do not read transcripts, run commands,
  call models, fetch the network, or continue a conversation.
- Missing semantic context stays missing; do not fabricate summaries.
- Treat unknown ownership, stale bundles, untrusted hooks, and changed host
  versions as visible conditions, not silent fallbacks.
- Preserve user settings and unrelated keys when integrating a host.
