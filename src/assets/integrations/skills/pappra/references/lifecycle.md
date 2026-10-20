# Lifecycle reference

## Supported mapping

Pappra distinguishes four local lifecycle intents:

| Intent               | Pi                           | Codex                                      | Claude                                     |
| -------------------- | ---------------------------- | ------------------------------------------ | ------------------------------------------ |
| `startup`            | `session_start`              | `SessionStart` with source `startup`/`new` | `SessionStart` with source `startup`/`new` |
| `resume`             | `session_start`              | `SessionStart` with source `resume`        | `SessionStart` with source `resume`        |
| `compact`            | `session_before_compact`     | unsupported in observed 0.163.0 hook keys  | `PostCompact`                              |
| `checkpoint-request` | explicit Pappra command/hook | unsupported automatic event                | unsupported automatic event                |

The matrix is version-specific. A host version outside the observed support
range is `unsupported`/`unknown`, not a fallback to name similarity.

## What a hook does

A hook validates the host payload, resolves the current workspace from the
event cwd (never from a last-session cache), derives a bounded event identity,
suppresses a duplicate identity, and records a private local event observation.
It may print a short advisory context. It never starts a model, fetches,
indexes, runs arbitrary commands, creates a new agent, or writes a checkpoint
with invented semantics.

## Manual continuity

`pappra checkpoint --task <id> ...` and `pappra resume <id>` remain available
without hooks. A hook observation is not a checkpoint and does not grant
`executionAllowed`. A resume packet is read-only context; an unknown or
non-stopped writer fails closed.

## Reload and trust

Installing files does not prove the host loaded them or trusted their exact
definition. Report reload-needed and trust-needed separately. Do not approve a
host trust prompt on the user's behalf.
