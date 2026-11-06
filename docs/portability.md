# Workspace portability

For the same project at a new root or on another machine, carry the shared
configuration, shared knowledge records and shared documents, then regenerate local bindings.
For a different project, derive choices from that project's rules, repositories
and documents using the [adoption recipe](../skills/pappra/references/adoption.md).

## What to copy

| Share / copy                                                   | Why                                                                                                                                             |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `.pappra/workspace.json` | Workspace policy. Paths are workspace-relative or logical `external:<id>` references. |
| `.pappra/knowledge/records/`, if present | Shared catalog records preserve document IDs, source references and review history. Copy the corresponding shared documents at the same workspace-relative paths. |
| the reviewed choices file (for example `.pappra-choices.json`) | reproducible `pappra init` / `pappra onboard` input for the same project                                                                        |
| repository checkouts recreated from shared sources             | keep the same relative paths so workspace config stays valid                                                                                    |
| explicitly shared project documents outside those checkouts    | restore the intended knowledge inputs before rebuilding the catalog                                                                             |

## What never to copy

| Machine-local                                                         | Why                                                                                                 |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| the entire `.pappra/local/` tree                                      | regenerate machine-local state at the destination                                                   |
| `.pappra/local/machine.json`                                          | absolute workspace realpath, `checkoutId`, runtime binding, selected hosts                          |
| `.pappra/local/code/*.json`                                           | prepared code-index registrations for this checkout identity                                        |
| `.pappra/local/knowledge/catalog.json`                                | local catalog state; regenerate from `docs scan`                                                    |
| `.pappra/local/host-events/**`                                        | local lifecycle observations                                                                        |
| `.pappra/local/collab-bindings.json`                                  | absolute pointers to task records; inspect the authoritative record and bind explicitly when needed |
| `.pappra/local-archive/**`                                            | retained private recovery material                                                                  |
| `.pappra/host-bundles/**`                                             | exported host packages; regenerate with `pappra onboard` or `pappra host bundle`                    |
| private knowledge and task artifacts, including collaboration records | the copy checklist covers shared inputs; private transfer requires a separate reviewed decision     |

## Same project at the destination

Run from the destination workspace root. With no `--config`, onboarding uses
discovery for its choices and preserves an existing valid `workspace.json`.
To use a reviewed choices file, add `--config .pappra-choices.json` (or the actual
file path) to both onboarding commands.

If the shared policy refers to an `external:<id>` checkout, supply a verified
[destination-local mapping](configuration-authority.md) before onboarding can
use it. A missing mapping requires operator input.

Install the exact version named by `runtimeVersion` in `workspace.json` when
present. The beta tag below is for an unpinned workspace.

```sh
npm install -g @phyzess/pappra@beta
cd /path/to/workspace
pappra onboard --dry-run --json      # review scope + host versions
pappra onboard --yes --json
pappra doctor --json
pappra docs scan --apply --json      # register newly discovered documents
pappra code prepare --repo <repo> --apply --json
```

Bring over the shared records before scanning at the destination. Use
`pappra docs check --json` to verify them against the copied documents.
`onboard` creates `machine.json` and installs the durable runtime copy. If host wiring
is wanted and authorized, add `--apply-host` to the apply command for verified hosts.
Host trust is never approved automatically: Codex needs one hook
approval, Pi a project-trust approval, Claude a reload/trust step if prompted.

## Fresh beta local state after a copy or move

There is no compatibility migration for old beta machine bindings. If private state was
copied accidentally, stop every writer that could still use it, then preview and explicitly
archive that state:

```sh
pappra repair --reset-local --json
pappra repair --reset-local --all-writers-stopped --apply
pappra init --yes --apply
```

The old `.pappra/local` is atomically moved to `.pappra/local-archive/<id>` under a private
ignore-all rule; nothing in that tree is deleted or rewritten. A journal outside the moved
tree permits recovery after interruption before fresh local publication. Shared workspace
configuration and shared knowledge remain untouched. Verified live private writers and
managed registrations refuse reset; PID-only imported metadata remains unknown and is
covered only by the explicit operator assertion. This command neither stops nor adopts a
process. Host settings installed elsewhere are separate from private local state and may
need their own install/verify operation.

## If the workspace root is not a Git repository

That is supported. Checkpoints and configuration do not require repository identity; only
code intelligence and host hooks use per-checkout identities.

## Handoff output

`pappra onboard --print-handoff --json` prints the copy checklist and baseline
onboarding commands for the destination workspace (`pappra/handoff/1`).
`workspaceRoot` identifies the source of the report. The command writes nothing.
