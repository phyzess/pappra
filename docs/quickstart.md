# Pappra quick start

Pappra is a workspace-local manager. It does not require a private repository,
a running host, a model provider, a code-graph service or a global `pappra`
binary.

## Published package

The package is published as `@phyzess/pappra`. Install it once if you use it every day
(`npm install -g @phyzess/pappra@beta`), then the command is plain `pappra`; with mise or another
version manager, use `npm install -g --prefix "$HOME/.local"` so the command is not bound to one
Node version's shim. The `npx` form
below stays valid and pins a version without installing. From an empty target workspace:

```sh
npx @phyzess/pappra@beta init --config ./minimal-choices.json --json
npx @phyzess/pappra@beta init --config ./minimal-choices.json --apply --json
npx @phyzess/pappra@beta doctor --json
```

`examples/minimal-choices.json` in this repository is the selection file used above.
For derived selections without a file:

```sh
npx @phyzess/pappra@beta init --print-choices        # print the derived document, write nothing
npx @phyzess/pappra@beta init --yes --apply --json   # derive and apply without prompting
```

`--yes` and `--print-choices` never prompt, so they work in CI. `init --json` without
selections still exits nonzero, but it returns the discovery candidates and the suggested
`pappra/init-choices/1` document; only a TTY without selections opens the wizard.

`init --apply` installs a durable runtime copy of the executing package and binds it in
`machine.json`, which is what makes an npx/dlx bootstrap survive cache eviction. Pass
`--no-runtime` to leave that action pending. The copy can be managed directly:

```sh
npx @phyzess/pappra@beta runtime install --apply --json   # default --from self
npx @phyzess/pappra@beta runtime status --json            # read-only passive state
npx @phyzess/pappra@beta runtime verify --json            # content and smoke verification
npx @phyzess/pappra@beta runtime remove --apply --json    # refuses a bound runtime without --force
```

An existing valid `.pappra/workspace.json` is never rewritten silently.
`init --yes --reconfigure --apply` rebuilds it from discovery (runtime version, knowledge
sources, code engine) and backs up the previous file under `.pappra/local/backups`.

A successful apply also reports advisory `nextActions`:
`pappra code prepare --repo <id> --apply` when a code engine is selected, and
`pappra docs scan --apply` to register documents that discovery already reports under the
configured knowledge sources.

Exit codes: `0` converged, `1` applied with a pending manual step (for example with
`--no-runtime`), `2` invalid input, `3` unavailable environment.

## Agent-native tools

`pappra mcp` starts a stdio MCP server for the current workspace. Read-only tools cover
workspace status, resume, documents, code queries and runtime state; write tools require
`apply`/`confirm`. `pappra host mcp install --host claude|pi --apply` registers it in
`.mcp.json` / `.pi/mcp.json`; Codex uses `codex mcp add pappra -- pappra mcp`.

`pappra task pin <id> --auto-resume` makes the lifecycle hook inject a bounded resume packet
for that task. See [agent-native usage](agent-native.md) for the full tool and consent model.

## New workspace or new machine

`pappra onboard` plans or applies the whole setup: workspace config, durable runtime, and
(with `--apply-host`) host wiring for hosts whose version matches the pinned matrix.

```sh
pappra onboard --dry-run --json            # read-only: scope, files, host versions
pappra onboard --yes --json                # init + runtime, prints host steps
pappra onboard --yes --apply-host --json   # also writes verified host integrations
```

It never approves host trust. Copying a workspace to another machine is covered in
[portability](portability.md); `.pappra/local/` is machine-local and must not be copied.

## Adopting an existing multi-repository workspace

A workspace root often contains many checkouts plus vendored dependencies and worktrees.
`init --yes` derives every discovered checkout, which is usually too broad; use an explicit
selection instead:

```sh
cd /path/to/workspace
PAPPRA="npx @phyzess/pappra@beta"

# 1. Inventory the derived shape without writing (works even before .pappra exists).
$PAPPRA init --print-choices --json

# 2. Keep that document, then narrow it:
#    - repositories: write access only for the checkouts you actively change
#    - excludes: node_modules, dist, coverage, vendored deps, worktrees, temp clones
#    - knowledge.sources: root rule files plus the notes directory you actually curate
#    - validation: a few real lint/test commands, not one per package
$PAPPRA init --config .pappra-choices.json --apply --json
$PAPPRA doctor --json
$PAPPRA docs scan --apply --json
$PAPPRA code prepare --repo <active-repo> --apply --json

# Later edits or a runtime upgrade:
$PAPPRA init --config .pappra-choices.json --reconfigure --apply --json
```

Notes:

- Excludes take effect after the first apply; a later `--print-choices` or `--reconfigure`
  only sees the configured repositories plus the root, not the whole tree.
- Code registrations live in `<workspace>/.pappra/local/code/<repo>.json`; no `.pappra`
  directory is created inside a checkout, so outer discovery keeps resolving it.
- `doctor` observes host manifests in the private default root, project directories and
  `$CODEX_HOME`, but a Pi package installed with `pi install` has no such manifest: check it
  with a real session instead.
- The workspace root does not have to be a Git repository; checkpoints work without it.

## Development checkout

The checkout and the target workspace are different directories. Build once in
the checkout, then invoke `dist/cli/main.js` by absolute path from the target
workspace.

## 1. Build the checkout

```sh
cd /absolute/path/to/pappra-public
pnpm install --frozen-lockfile
pnpm build
export CHECKOUT="$PWD"
export PAPPRA_CLI="$CHECKOUT/dist/cli/main.js"
```

Node.js 24+ and pnpm 12.3.4 are the supported development baseline.

## 2. Preview and apply a host-free workspace

Use a new empty directory, not the checkout. The complete minimal choices file
is [`examples/minimal-choices.json`](../examples/minimal-choices.json).

```sh
mkdir -p /tmp/pappra-demo
cd /tmp/pappra-demo
cp "$CHECKOUT/examples/minimal-choices.json" ./minimal-choices.json

# Read-only preview; no prompt in config/JSON mode.
node "$PAPPRA_CLI" init --config ./minimal-choices.json --json

# Apply the same config. Apply installs and binds a durable runtime copy and
# converges with exit code 0; add --no-runtime to leave that action pending.
node "$PAPPRA_CLI" init --config ./minimal-choices.json --apply --json
node "$PAPPRA_CLI" doctor --json
```

The example has no repositories, optional hosts, or code graph. `init --json`
without selections never prompts and still exits nonzero, but it returns the
discovery candidates and the suggested `pappra/init-choices/1` document. A TTY
invocation without selections opens the wizard; `--config`/`--json` never prompt.

A converged apply exits `0`. With `--no-runtime` (or an explicit
`--install-runtime` that has not run yet) the result is `ok:true` with
`status:"external-actions-pending"` and a nonzero exit; inspect
`pendingExternalActions` instead of treating that as a corrupt configuration.
`doctor` reports the resulting runtime conditions; `pappra runtime verify` runs
the active check.

## 3. Optional continuity after a successful core setup

Once the target is a Git worktree and the required workspace identity is
available, create and read an advisory checkpoint:

```sh
node "$PAPPRA_CLI" checkpoint --task demo --objective 'Try Pappra' \
  --acceptance 'Resume stays advisory' \
  --author-session demo --native-session demo \
  --context-completeness complete --json
node "$PAPPRA_CLI" resume demo --session demo --json
```

A resume packet is advisory. Check `executionAllowed`; a readable checkpoint
does not grant permission to start work.

## 4. Optional code, host and collaboration surfaces

These are not prerequisites for the workflow above, and no example files for
them are generated by init.

- Code graph status/prepare/query requires a selected external graph engine;
  without it, bounded text/structure fallback remains available.
- Host detect/plan/install requires the selected host CLI/support. The installed hook
  is a dependency-free bundle copied into the host root; Claude Code uses the
  `${CLAUDE_PROJECT_DIR}` placeholder, so a moved checkout or an evicted npx cache does not
  break it.

  Codex 0.163.0 loads lifecycle hooks only from its user configuration directory, so wire it
  with `pappra host install --host codex --scope user --host-version 0.163.0 --apply` and
  approve the hook once in Codex; project `.codex/hooks.json` and plugin bundles are not
  loaded by that version.

  `pappra host bundle --host <name> --out <dir> --marketplace` exports a local marketplace
  that both Claude Code and Codex accept (`.claude-plugin/marketplace.json` plus a `pappra/`
  plugin directory); without `--marketplace` it exports the plugin directory itself. Pi
  installs that directory directly. Pi 1.3.0 and Claude Code 2.1.292 plugin hooks are
  verified for startup in a real session; Codex does not load plugin hooks. Because each
  host still needs its own registration step, `host install --mode plugin` stays fail-closed
  and prints the exact commands. See
  [host plugin validation](host-plugin-validation.md).
- Collaboration requires an explicit controller:

  ```sh
  node "$PAPPRA_CLI" collab run --prepared prepared.json \
    --capabilities card.json --controller fixture
  ```

  `prepare` runs first; `run` needs the prepared task and a fresh capability card.
  `fixture` is deterministic and no-model. `pi-rpc` launches a real owned Pi RPC session
  and is verified end to end against Pi 1.3.0; see
  [Pi RPC collaboration](pi-rpc.md).
