# Distribution and ease-of-use plan (A/B/C)

Status: draft for review. Owner: pappra. Target: make `npx @phyzess/pappra init` work end to end,
then keep the resulting workspace usable with short commands.

## 1. Problem statement

Today the supported flow is "build the checkout, call `dist/cli/main.js` by absolute
path". That is correct but not the intended product experience. Four concrete blockers
were verified against this tree:

| # | Blocker | Evidence |
| - | ------- | -------- |
| 1 | Not installable from a registry | `package.json` has `private: true`; `.github/workflows/` contains only `ci.yml`; README §Status states the package must not be published. `npm pack --dry-run` still produces a complete 217-entry tarball, so packaging works — only the publish gate is closed. |
| 2 | Git installs produce a broken bin | Only `prepack` exists. npm runs `prepack` for git deps but installs devDependencies only when `prepare` exists, so `tsc` is missing at build time. |
| 3 | Non-interactive init has no defaults | `init --json` without `--config` returns `status:"needs_input"`, `code:"init_no_tty"`; the only alternative is a hand-written `pappra/init-choices/1` document. |
| 4 | Host hooks pin a source-checkout absolute path | `host plan` emits `runtimeEntry: <checkout>/dist/hosts/integration/hook-entry.js`; `pappra-host.json` stores it. An npx/dlx cache directory is disposable, so hooks break after eviction. |

Consequence: `init --apply` always reports `external-actions-pending` (runtime cannot be
installed without a tarball or a published version), and no "zero manual steps" path
exists.

## 2. How comparable tools do it

| Tool / ecosystem | Pattern | Lesson for pappra |
| ---------------- | ------- | ----------------- |
| npm `npx` / `npm exec` | Packages are materialised under `~/.npm/_npx`; npm ships `npm cache npx ls/rm` because the directory is disposable. npm docs only say requested packages "are installed to a folder in the npm cache" and expose `npm cache npx ls/rm` to manage that folder. | Never let a long-lived artifact (hook, service, shim) point into an npx cache. Bootstrap from npx, then relocate. |
| npm `prepare` vs `prepack` | `prepack` runs for `npm pack`, `npm publish` **and git installs**; `prepare` is what causes devDependencies to be installed for git dependencies. | Ship both: `prepack` for registry tarballs, `prepare` for git installs. |
| npm trusted publishing | OIDC-based publish from CI (`id-token: write`, npm CLI ≥ 11.5.1, Node ≥ 22.14); provenance is automatic for public repos. No long-lived token. | Publishing can be added without a secret; keep the workflow pinned to tags and `repository.url`. |
| `uv` (`uvx` vs `uv tool install`) | Explicit split between throwaway execution and a durable installed tool directory (`uv tool dir`). | pappra needs the same two modes: `npx @phyzess/pappra …` for one-shot, a durable runtime for repeated/hook use. |
| `lefthook` | Generated git hook embeds the **absolute** binary path; docs require `lefthook install` again after upgrading. | Absolute paths are legitimate **if** a documented reinstall step exists and upgrades are detected. |
| `husky` | Hooks are project-local (`.husky/`, `core.hooksPath`) and call project scripts; `prepare` re-links them. | Project-relative hook commands survive tool upgrades and cache eviction; prefer them when host supports placeholders. |
| Claude Code hooks / plugins | Hooks may live in `settings.json`, or in a plugin's `hooks/hooks.json`; `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` are substituted (exec form also gets them as env vars). Marketplaces distribute plugins via `.claude-plugin/marketplace.json`. | Best target for pappra: host-native plugin with a self-contained hook script, no absolute path and no edit of a tracked `settings.json`. |
| Codex plugins | `plugin.json` + `hooks/hooks.json` at plugin root; `codex plugin marketplace add` / `codex plugin add name@market`. Known issue: Agent Plugins 1.0 manifests can have `extensions.com.openai.hooks` ignored, so hook wiring must be verified per pinned version. | Same plugin-first approach, but version-gated verification is mandatory before claiming support. |
| Pi packages | `pi install npm:@scope/pkg@1.0.0` (pinned), declaration in `~/.pi/agent/settings.json` or project `.pi/settings.json`, project trust gate, `pi -e` for one-shot. Packages provide `extensions/`, `skills/`, `prompts/`, `themes/`. | Publish pappra as a Pi package; Pi owns install/update, so pappra stops writing into a repo `.pi/extensions`. |
| `vercel-labs/skills` (`npx skills add`, `skills-lock.json`, `npx skills install`) | Skills are distributed from a repo/package path with a lockfile for restore; project-level by default. The `oodon` repo already uses this (`skills-lock.json`). | Expose the pappra skill in that layout instead of writing `.claude/skills/pappra` blind; keeps one skill-management system per repo. |
| `create-vite` and similar | Non-interactive mode is an explicit flag (`--no-interactive`) plus explicit value flags; no implicit "just press enter" defaults. | `init --yes` must be explicit, deterministic, and print the derived choices. |

Two conclusions drive the plan:

1. **Do not make hooks depend on the installer.** Bootstrap via npx, then either bundle the
   hook into a host-native plugin (preferred) or relocate a runtime copy to a durable
   directory.
2. **Ease of use is three separate problems**: publish (A), durable hook runtime (B),
   non-interactive defaults (C). Fixing only one leaves a manual step.

## 3. Workstream A — publishable, npx-installable package

### A1. Package metadata

- Remove `"private": true` and rename the package to `@phyzess/pappra`. `bin` stays
  `pappra`, so `npx @phyzess/pappra init` and a global `pappra` both work.
- Add `"publishConfig": { "access": "public" }` — scoped packages default to restricted
  access, so this is required for a public scoped publish.
- Add `"prepare": "node scripts/project.mjs build"`-style entry so git installs build.
  Land with A2: `build` currently shells out to `pnpm`, which is not guaranteed in a
  consumer's environment. Either make `build` pnpm-free (`node` + local `tsc` binary) or
  add a `build:npm` script used by `prepare`.
- Keep `prepack`. `files` already includes `dist`, `assets`, README, notices; LICENSE is
  auto-included.
- Keep `engines.node: ">=24"` (decided). No CI matrix change; state the floor in the
  README so `npx` engine failures on older Node read as a documented limit.
- `bin` + shebang + exec bit are already correct (`dist/cli/main.js` starts with
  `#!/usr/bin/env node`), so no change is needed there.

### A2. Publish workflow

`.github/workflows/publish.yml`, triggered on `v*` tags:

- `permissions: contents: read, id-token: write`
- Node 24, `corepack enable`, `pnpm install --frozen-lockfile`, `pnpm check`
- `npm publish --access public` (trusted publishing, no token)
- Guard: tag version must equal `package.json` version; refuse `-dev.` versions.

### A3. Versioning

`0.1.0-dev.0` → `0.1.0-beta.1` … `0.1.0`. Users pin through `npx @phyzess/pappra@beta` or
`npx @phyzess/pappra@0.1.0`. Pre-release tags never move.

### A4. Name check

Resolved: publish as `@phyzess/pappra`. The scoped name sidesteps public-name
availability, which this network cannot check (registry.npmjs.org is refused and the
internal Nexus mirror has no such package).

### A5. Registry (resolved)
Resolved: public npm only.

- npm trusted-publisher record: repository `phyzess/pappra`, workflow `publish.yml`.
- Provenance is automatic for public repositories; no `NPM_TOKEN` in the workflow.
- Local caveat: this machine's default registry is the internal Nexus mirror, so
  `npx @phyzess/pappra` here depends on that mirror proxying npmjs.org. To verify a
  just-published beta, bypass the mirror:
  `npm_config_registry=https://registry.npmjs.org npx @phyzess/pappra@beta`.

### A6. Skill interop (small, high leverage)

Add a repo-root `skills/pappra/SKILL.md` (+ references) generated from
`src/assets/integrations/skills/pappra/**` so `npx skills add phyzess/pappra --skill
pappra` works and repos that already keep `skills-lock.json` (e.g. oodon) use one skill
system instead of two.

### A7. Acceptance

```sh
npx @phyzess/pappra@<beta> --version
mkdir /tmp/pappra-npx && cd /tmp/pappra-npx && git init -q .
npx @phyzess/pappra@<beta> init --yes --json      # writes .pappra/*, exit 0, no pending actions
npx @phyzess/pappra@<beta> doctor --json
```

## 4. Workstream B — durable runtime and plugin-first host integration

### B1. Split "ephemeral run" from "installed runtime"

- New command: `pappra runtime install [--from self|tarball|registry] [--version <v>]`
  and `pappra runtime status|verify|remove`.
- `--from self` copies the currently executing package root (`dist/` + `assets/` +
  `package.json`) into `~/Library/Application Support/Pappra/runtimes/<version>/` using
  the existing journal/manifest machinery in `src/install/runtime.ts`
  (`install-manifest.json`, staging, locks, verified publish). This is what makes
  `npx @phyzess/pappra init` self-sufficient before the npx cache is evicted.
- `machine.json#runtime` records the durable copy; `doctor` stops reporting
  `runtime state: unknown`.
- `init` learns the distinction: when the executing package is inside an ephemeral
  location (`_npx`, pnpm dlx temp, `/tmp`), it either performs `--from self` (default) or
  prints the exact durable command and exits 0 with `nextActions` instead of a blocking
  `external-actions-pending`.

### B2. Host-native plugin bundles (replaces absolute `runtimeEntry`)

Target layout per host, generated from the existing bundle code
(`src/hosts/integration/bundle.ts`, `templates.ts`):

| Host | Distribution | Hook entry | Why |
| --- | --- | --- | --- |
| Claude Code | plugin dir (`.claude-plugin/plugin.json` + `hooks/hooks.json`) via marketplace, or project-local plugin | `node "${CLAUDE_PLUGIN_ROOT}/hooks/pappra-hook.mjs"` | placeholder is host-managed; survives upgrades and cache eviction; no edit of tracked `settings.json` |
| Codex | plugin (`plugin.json` + `hooks/hooks.json`) via `codex plugin marketplace add/add` | relative to plugin root | same; verify against pinned 0.163.0 before claiming support (upstream issue: Agent Plugins 1.0 hook manifests can be ignored) |
| Pi | npm package with `pi.extensions` + `pi.skills` (`pi install npm:@phyzess/pappra@<v>`) | extension entry imports `./runtime/hook-entry.js` relatively | Pi owns install dir and pinning; no repo `.pi` writes |

Implementation notes:

- The hook must be dependency-free: today `hook-entry.js` imports schemas that pull
  `zod`. Add a small bundling step (esbuild as a devDependency, or a hand-rolled
  single-file graph for the hook entry only) producing `hook.mjs`. Ship that in the
  plugin. Keeping plain `tsc` output and shipping `node_modules` is the alternative;
  bundling is smaller and avoids resolution surprises.
- Keep the current `merge-managed` project-settings mode as an explicit
  `--mode project-settings` fallback (opt-in; still supported and verified), but make
  `plugin` the default whenever the host supports it.
- `pappra-host.json` gains a mode field and a `bundleDigest`; `host verify` reports
  drift (host version, bundle digest, runtime path, placeholders resolved).
- Update semantics: `pappra host install` is idempotent and detects an old
  absolute-path manifest, then offers/records migration (`host install --migrate`).

### B3. Upgrade path

`pappra runtime install --from self` after a version bump; `host install` re-runs the
bundle so placeholders and digests refresh. Document the lefthook-style rule: after any
pappra upgrade, re-run `pappra host install` (or let `doctor` say so).

### B4. Acceptance (the failure case from §2)

```sh
npx @phyzess/pappra@<beta> init --yes --apply
npx @phyzess/pappra@<beta> host install --host claude --mode plugin --apply
npm cache clean --force            # evict the npx copy
# start a Claude Code session in the workspace: hook must still fire
npx @phyzess/pappra@<beta> host verify --host claude --json   # placeholder resolves, digest matches
pappra runtime status --json                                   # durable copy present
```

## 5. Workstream C — deterministic non-interactive init

### C1. Flags

- `init --yes` / `init -y`: derive choices from discovery and apply them.
- `--no-interactive`: same behaviour, for scripts that pass some flags explicitly
  (`--yes` is the short form; both are accepted, matching create-vite's explicit-flag
  convention).
- `--print-choices`: print the derived `pappra/init-choices/1` JSON and exit 0 without
  writing (feeds `--config` in CI).
- Keep `--config`, `--apply`, `--json` semantics unchanged.

### C2. Derivation rules (deterministic, discovery-only)

| Field | Rule |
| --- | --- |
| `repositories` | Every discovered checkout; access `write` only for the workspace-root repository, `read` otherwise |
| `knowledge.sources` | Root rule files (`AGENTS.md`, `CLAUDE.md`) plus `docs/` when present; never deeper paths |
| `code.graph` | `codegraph` when both the `codegraph` executable and `<repo>/.codegraph` exist, else `none` |
| `code.symbols` | `auto` |
| `validation` | `lint`, `typecheck`, `test` script candidates when present, max 3 |
| `excludes` | Built-in defaults (`node_modules`, `dist`, `coverage`, `tmp`, `test-results`) |
| `hosts` | Detected hosts whose executable version matches the pinned support matrix, else `[]` |

Every derived value is echoed in the plan output with the rule that produced it, so an
agent or human can audit before `--apply`.

### C3. JSON contract for agents

`init --json` without `--config` becomes informative instead of a dead end:

```json
{ "ok": false, "status": "needs_input",
  "candidates": { "repositories": [...], "knowledge": [...], "validation": [...], "hosts": [...] },
  "suggestedChoices": { "schema": "pappra/init-choices/1", ... },
  "nextActions": ["Rerun with --yes to apply the suggested choices."] }
```

Exit code stays non-zero (no accidental writes), but the payload is sufficient to
proceed. `--yes` flips it into the normal plan/apply path.

### C4. Exit-code contract (documented + tested)

`0` converged (config written, nothing pending) · `1` applied with an explicit manual
next step (printed) · `2` invalid input · `3` unavailable/environment. The current
"`0` is impossible on a fresh machine" behaviour is what makes the tool feel broken.

### C5. Acceptance

```sh
npx @phyzess/pappra@<beta> init --json                  # candidates + suggestedChoices, no writes
npx @phyzess/pappra@<beta> init --json | jq -r .suggestedChoices > c.json
npx @phyzess/pappra@<beta> init --config c.json --apply --json   # round-trips
npx @phyzess/pappra@<beta> init --yes --apply --json             # one command, exit 0
```

## 6. Sequencing and effort

| Milestone | Content | Effort | Depends on |
| --- | --- | --- | --- |
| M1 | C: `--yes`, derived defaults, `--print-choices`, candidates JSON, exit-code table, tests | 1.5–2 d | — |
| M2 | A: metadata, pnpm-free build for `prepare`, publish workflow, beta version, skill layout mirror | 1 d + review | registry/name decision |
| M3 | B1: `pappra runtime install --from self`, init integration, doctor wiring | 1.5 d | M1 (init flow) |
| M4 | B2: plugin bundles for 3 hosts, `--mode`, `host verify` drift, migration from absolute-path manifest | 3–4 d | M3 |
| M5 | Docs rewrite (quickstart/README/support), oodon dogfood, `skills` interop check | 1 d | M4 |

M5 status (2026-10-20): docs updated for the beta install path, `--yes`/`--print-choices`,
the durable runtime and the hook bundle. Dogfood on the `oodon` repository: `init --yes
--apply` converged (exit 0) with the root checkout at write access, `AGENTS.md`/`CLAUDE.md`/
`docs` as knowledge sources, `lint`/`typecheck`/`test` validation, the codegraph engine and
all three pinned hosts; `runtime verify` reported `complete` with `source: self`; the Claude
host plan produced `${CLAUDE_PROJECT_DIR}/.claude/hooks/pappra-hook.mjs`.

Dogfood gaps and their follow-up (2026-10-20):
(a) resolved — `init` apply now reports advisory `nextActions`, including
`pappra code prepare --repo <id> --apply` when a code engine is selected.
(b) resolved — `pappra docs scan [--apply]` previews and registers documents discovered
under the configured knowledge sources, so `docs list` reflects the workspace.
(c) explicit, not silently missing, and now testable — `host install --mode plugin` fails
closed with a diagnostic that points at `pappra host bundle`, while
`host bundle --marketplace` exports a local marketplace layout that Claude Code's validator
accepts and Codex installs (`codex plugin add pappra@pappra-local`, checked in an isolated
CODEHOME with the real bundle). Pi still receives a plain package directory. Flipping the
default now needs one thing only: a real session per host that leaves a
`.pappra/local/host-events/<host>/*.json` record, which is the evidence `host verify` and the
support matrix will cite.
(d) resolved — init apply supports journalled `replace-managed` writes (expected
before-digest guard, backup under `.pappra/local/backups`, manifest digest update, restore on
failure) and `init --yes --reconfigure --apply` rebuilds an existing valid `workspace.json`
from discovery, which is also the runtime-upgrade path. A no-op reconfigure reports
`no-changes`; an edited-between-plan-and-apply file is refused as stale.

M4 status (2026-10-20): partially landed, with an explicit deviation. The host hook is now
a single dependency-free esbuild bundle (`dist/hosts/integration/pappra-hook.mjs`), copied
into the host root; Claude Code hook commands use `${CLAUDE_PROJECT_DIR}` and Pi imports its
runtime relatively, so neither depends on a package checkout or the npx cache. Manifests
compare the recorded hook expression and `--migrate` rewrites a manifest previously pinned
to a checkout path. `pappra host bundle` exports native plugin/package directories
(`.claude-plugin/plugin.json`, `plugin.json`, or a Pi `package.json` manifest) but does not
register them and reports `verification: "unsupported"`.

Deviation: `project-settings` remains the default install mode. No real Claude/Codex/Pi
session was available to prove that a plugin hook fires, and the plan forbids claiming host
callability without evidence, so plugin mode ships as an exported artifact plus documented
registration instead of a silent default. Flipping the default is the remaining M4 item.

M3 status (2026-10-20): landed — `pappra runtime install|status|verify|remove` exists,
`--from self` packs the executing package and installs it under the Pappra data directory
through the existing journal/manifest machinery, and `init --apply` installs and binds that
copy by default (converging to exit 0) unless `--no-runtime` keeps the action pending. The
passive runtime inspector now derives the package identity from the manifest instead of
hardcoding the old package name, which the scoped rename had exposed. The §5.C5 "one
command, exit 0" check now holds.

M1 status (2026-10-20): landed — `init --yes`/`--no-interactive` derive deterministic
selections, `--print-choices` prints the derived document (and with `--json` a wrapper that
carries the rules and candidates), `init --json` without selections returns candidates plus
a suggested document instead of a dead end, and the exit codes are 0/1/2/3. A fresh-machine
`--apply` still exits 1 until M3 installs a runtime, so the §5.C5 "one command, exit 0"
check is deferred to M3.

M2 code status (2026-10-20): landed in the tree — package renamed to `@phyzess/pappra`
with `publishConfig.access=public`, `prepare`/`prepack` are pnpm-free builds, the
repo-root `skills/pappra/` mirror has a drift test, and `publish.yml` /
`bootstrap-publish.yml`.

M2 outcome (2026-10-20): `@phyzess/pappra@0.1.0-beta.1` was published once with a
granular token to create the package; the Trusted Publisher record was then attached and
`v0.1.0-beta.2` published through OIDC with a signed provenance statement. The bootstrap
workflow and the `NPM_TOKEN` secret are retired; `publish.yml` is the only release path.
Suggested order: **M1 → M2 → M3 → M4 → M5.** M1 gives immediate relief without touching
distribution; M2 unblocks `npx`; M3+M4 remove the structural fragility.

## 7. Risks and non-goals

- **Codex plugin hook support** is version-sensitive (upstream issue about ignored
  `extensions.com.openai.hooks`). Keep the project-settings mode; only advertise plugin
  mode for versions actually verified. The current pin table (`HOST_SUPPORT`) must be
  re-checked per release.
- **Claude Code plugin trust/reload**: new plugins require reload and trust; `doctor`
  must keep reporting that as a state, not assume success.
- **Registry split** (public vs Nexus) doubles the verification matrix for `npx`.
- **Name availability** is unverified from this network.
- **npm install-script policy** (npm ≥ 11.19): `npm exec`/`npx`/`npm install -g` now gate
  lifecycle scripts through `allow-scripts`/`strict-allow-scripts`, including `prepare`
  for non-registry dependencies. Registry tarballs are the reliable path; git installs
  may need `--allow-scripts` and must not be the documented default.
- Non-goals: no daemon/scheduler, no background auto-update, no `postinstall` scripts
  (supply-chain risk; `prepare` covers git installs), no silent writes without
  `--apply`, no claiming host callability without evidence.

## 8. Decisions (resolved)
Resolved on 2026-10-20:

1. Registry: **public npm only** (A5), verified from CI via OIDC.
2. Package name: **`@phyzess/pappra`**; `bin` remains `pappra` (A1/A4).
3. `engines.node`: **stay `>=24`** (A1).
4. Host integration: **plugin mode becomes the default; `--mode project-settings`
   remains supported and verified** (B2).

Still open (implementation detail, decide during M4): whether Codex plugin mode is
advertised at all in the first beta, given the upstream Agent Plugins 1.0 hook-manifest
issue. Default position: ship the bundle but keep `host verify` reporting
`verification: unsupported` until a real 0.163.0 session proves the hook fires.
