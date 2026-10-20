# Workspace portability

A Pappra workspace has two kinds of state: portable configuration and machine-local
bindings. Copy the first, never the second.

## What to copy

| Share / copy | Why |
| --- | --- |
| `.pappra/workspace.json` | policy: repositories, knowledge sources, code engine, validation, excludes. Paths are workspace-relative or logical `external:<id>` references. |
| the choices file (for example `.pappra-choices.json`) | reproducible `pappra init` / `pappra onboard` input |
| repository checkouts | keep the same relative paths so workspace config stays valid |

## What never to copy

| Machine-local | Why |
| --- | --- |
| `.pappra/local/machine.json` | absolute workspace realpath, `checkoutId`, runtime binding, selected hosts |
| `.pappra/local/code/*.json` | prepared code-index registrations for this checkout identity |
| `.pappra/local/knowledge/catalog.json` | local catalog state; regenerate from `docs scan` |
| `.pappra/local/host-events/**` | local lifecycle observations |
| `.pappra/host-bundles/**` | re-exportable host packages |

## Second machine

```sh
npm install -g @phyzess/pappra@beta
cd /path/to/workspace
cp /path/from/first/machine/.pappra-choices.json .        # or recreate it
pappra onboard --dry-run --json      # review scope + host versions
pappra onboard --yes --apply-host --json
pappra doctor --json
pappra docs scan --apply --json      # rebuild the knowledge catalog
pappra code prepare --repo <repo> --apply --json
```

`onboard` creates `machine.json`, installs the durable runtime copy, and (with
`--apply-host`) writes host integrations for hosts whose installed version matches the
pinned support matrix. Host trust is never approved automatically: Codex needs one hook
approval, Pi a project-trust approval, Claude a reload/trust step if prompted.

## If the workspace root is not a Git repository

That is supported. Checkpoints and configuration do not require repository identity; only
code intelligence and host hooks use per-checkout identities.

## Handoff output

`pappra onboard --print-handoff --json` prints the copy matrix above plus the exact commands
for the new machine (`pappra/handoff/1`). It writes nothing.
