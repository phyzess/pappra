# Local development

`scripts/self-host.ts` is Pappra's own checkout's project-local development
entry. It reports whether this repository is ready for Pappra-powered work —
skill aliases, the selected code index, workspace knowledge — and applies only
the repairs this repository owns. It reuses the selections already recorded in
`.pappra/workspace.json`, never writes them, and never edits global host, skill
or MCP configuration.

## Commands

```sh
pnpm dev:check   # read-only convergence report
pnpm dev:setup   # admits the root, then creates missing source aliases and prepares local state
```

Both run `node scripts/self-host.ts` from the repository root, so the entry
itself needs no build step (Node >= 24 executes the TypeScript directly).
`--json` works in either mode and `--check` is the default, so the bare script
is read-only. `dev:check` exits non-zero while any check is not `ok`, which
makes it usable as a local gate. Only `--check`, `--apply` and `--json` are
accepted, and `--check` and `--apply` are mutually exclusive; anything else
exits `2`.

## Module layout

`scripts/self-host.ts` is the entry and facade; the implementation lives in
cohesive modules under `scripts/self-host/`:

| Module | Responsibility |
| --- | --- |
| `types.ts` | public types and constants, plus the narrow JSON/payload helpers every layer needs |
| `paths.ts` | `lstat`/`realpath` primitives where only `ENOENT` means "missing" |
| `admission.ts` | repository and workspace admission; the gate before any write |
| `aliases.ts` | alias inspection and creation for the three host directories |
| `cli.ts` | the repository CLI runner, its default dependency seam, and entry flag parsing |
| `documents.ts` | the `pappra/docs-check/1` contract and the docs review state |
| `checks.ts` | the ten read-only checks and the report formatter |
| `apply.ts` | the owned repairs: aliases, `code prepare`, `docs scan --apply` |

The entry imports these with explicit `.ts` specifiers so Node loads them
directly; `tsconfig.scripts.json` and `tsconfig.test.json` enable
`rewriteRelativeImportExtensions` so the same graph also emits working `.js`
imports. `tests/scripts/self-host-boundaries.test.ts` enforces the closed
module set, the acyclic layering, the nineteen runtime exports, the ten-check
order and a cold clone that runs the entry with no `dist/`, `.build/` or
`node_modules/`.

## Admission comes first

`dev:setup` writes nothing and starts no mutating child until the root is
admitted as this repository:

| Gate | Requirement |
| --- | --- |
| package identity | `package.json` is a regular file that parses and identifies `@phyzess/pappra` |
| canonical source | `skills/pappra/SKILL.md` exists under this root, and neither `skills` nor `skills/pappra` is a symlink |
| workspace | `.pappra/workspace.json` parses, selects this root repository (`path: "."`) with a repository id, and selects the `codegraph` graph |
| filesystem facts | only `ENOENT` counts as "missing"; any other `lstat` failure is reported as `blocked` rather than treated as an absent path that would authorize a write |

Any failure leaves every file untouched and runs no `code prepare` or
`docs scan --apply` at all. A non-`codegraph` workspace stops the whole apply
even when a `dist/` build exists.

## What it checks

| Check | Meaning |
| --- | --- |
| `node-version` | Node satisfies the pinned `>=24` engine |
| `repository-admission` | package identity and canonical `skills/pappra/SKILL.md` are present and not redirected |
| `workspace-selection` | the workspace selects this root repository with the `codegraph` graph |
| `dist-cli` | `dist/cli/main.js` exists; Pappra commands run this repository's build, never a global `pappra` |
| `codegraph-engine` | `codegraph --version` answers on `PATH` |
| `skill-alias:.agents` | `.agents/skills/pappra -> ../../skills/pappra` |
| `skill-alias:.pi` | the same alias for Pi |
| `skill-alias:.claude` | the same alias for Claude |
| `code-index` | `pappra code status --repo <id>` reports an explicit `health.state` of `ready` |
| `docs-registration` | `docs scan` reports no unregistered candidates and `docs check --include-private` reports a complete summary with nothing left for review, so private registered documents are included |

## Automatic engagement in Claude Code

A skill alone is only matched by description, so this repository also engages
Pappra deterministically: `CLAUDE.md` imports `AGENTS.md` (Claude Code does not
read `AGENTS.md`), `.claude/settings.json` registers a `SessionStart` hook that
runs `scripts/session-context.ts`, and `.mcp.json` serves MCP from the
repository build. The hook only injects context: it tells the agent to invoke
the `pappra` skill, to use `node dist/cli/main.js`, and which `dev:check`
items still need `pnpm dev:setup`. It writes nothing and never fails the
session.

Every Pappra CLI invocation in a check is read-only: `code status`, `docs scan`
(plan) and `docs check --include-private`. The only other child process is a
`codegraph --version` probe.

## What setup does, and what it refuses

Setup creates a missing skill alias, and otherwise converges rather than
rewriting:

- an alias counts as present only when it **resolves** to `skills/pappra`; a
  matching `../../skills/pappra` string does not count while the source is
  missing or redirected;
- a real file or directory at that path is **preserved** and reported as
  `blocked` — setup never replaces a user's own skill;
- a symlink at that path resolving anywhere else is **preserved** and reported;
- a symlinked `.agents`, `.pi`, `.claude` or `skills` directory is **refused**,
  so the entry never writes through a link into shared or global state.

When the built CLI exists, apply runs two owned repairs:

- `code prepare --repo <id>`: plan first, then `--apply` only when the plan is
  actionable;
- `docs scan --apply`: registers newly discovered documents only. Changed
  bytes of an existing registration are never accepted here; that stays an
  explicit `docs review`.

Setup never installs a runtime or a global engine, never edits host, MCP or
credential configuration, never answers trust prompts, never launches an agent
and never creates a checkpoint. The workspace file is only read, so its id,
represented selections, continuity records and runtime binding stay owned by
`node dist/cli/main.js init`.

## Reading Pappra results honestly

The entry reads the CLI's own success and error discriminants instead of
inferring from an exit code or a half-parsed payload:

- `code status` is an `action` only when it reports an explicit `health.state`
  with `reasons`; a payload without that state is `blocked`, not a guess;
- failed or malformed `docs scan` results stay `blocked`; malformed `docs check`
  reports, incomplete summaries and error diagnostics also stay `blocked`, so
  missing data can never become `ok … of undefined`;
- this workspace's registered documents are private, so the entry always asks
  `docs check --include-private`; changed or unknown registered documents become
  an explicit review route (`docs list --include-private --json`) rather than an
  automatic forget or re-approval;
- `pappra/docs-check/1` sets `ok: false` for a non-current catalog as well as
  for errors (`ok` means no error diagnostic and every entry current), so the
  entry classifies from the report contract itself — schema, summary counts and
  error-severity diagnostics — and keeps `blocked` for malformed reports,
  missing or inconsistent summaries and real error diagnostics;
- a `code prepare` plan that failed or cannot be read never triggers an
  `--apply` retry.

Distinguish the three states when reading output: `action` means the entry
knows a concrete next step, `blocked` means it could not learn enough or will
not touch something it does not own, and only `ok` means converged.

## Fresh clone

```sh
pnpm install
pnpm dev:setup
pnpm dev:check
```

Installation builds the CLI through the package's prepare script. If
installation scripts were disabled, run `pnpm build` before setup.

Checks that need Pappra report `blocked` with the exact command to run while
`dist/` is missing, so a clone without a build still explains itself instead of
failing silently. `codegraph` must be installed on `PATH` separately; the entry
reports it and never installs it.

## Limits worth stating plainly

The aliases are source-first directories on disk. They make this repository's
`skills/pappra` the version a host reads after the host is restarted and the
skill is trusted — the entry does not restart a host, does not trust anything
on your behalf, and does not claim that a running host has already loaded the
skill. No file on disk can prove native loaded state; confirm it with the
host's own skill listing after a restart. Likewise, `dev:check` succeeding
describes this checkout only, not another host or a fresh CI runner.
