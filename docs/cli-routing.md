# Collaboration CLI routing

`pappra collab …` is one command family: a thin selector in
`src/cli/collaboration-router.ts` hands a parsed command line to one
command-family handler, and each handler owns its option contract and delegates
to the existing command implementation. This document describes how an
invocation reaches the right handler and the invariants the routing keeps.

## Where a bare `pappra` goes

The top-level entry lives in `run.ts`. When the invocation names no command,
asks for no `--help` and no `--json`, and the run is interactive (both streams
are TTYs, no `--no-interactive`, `CI` unset), `run.ts` delegates to the home
command in `src/cli/commands/home.ts`; that command shows the guided setup or
the workspace menu described in the [operations reference](operations.md).
Without a terminal, or with `--json` or `--no-interactive`, a bare `pappra`
prints the usage summary and exits `0`, so scripts see no change.

A few families carry their own flag contracts and are routed in `run.ts` before
the global option parser ever runs: `docs review` (its pinned expected digest is
not a global flag), `collab workflow` (request documents are validated against
schemas, not global flags) and `context` (`--session`, `--advise-percent`). The
`collab` actions below are the ones that reach the collaboration router through
the parsed option set.

## Layout

| Module | Responsibility |
| --- | --- |
| `collaboration-router.ts` | Selects a handler in the original precedence order. Intercepts raw `workflow` argv first (so `run.ts` cannot lose it to the global parser), builds one typed `RoutingContext`, and returns the first non-`null` handler result. |
| `collaboration-routing/context.ts` | `RoutingContext` — the values, action, raw argv, package info, rpc timeouts, output and json flag every family receives. No behaviour. |
| `collaboration-routing/help.ts` | The ordered action-prefix → usage table and the `{...info, commands: ['collab'], usage}` JSON envelope. |
| `collaboration-routing/execution.ts` | Long-running entries: `work-run`, `recovery-run`, and the `prepare`/`run`/`query` fallback that also reports an unknown action. |
| `collaboration-routing/native.ts` | Host/native families: `capabilities:derive`, `recovery:*`, `bootstrap*`, `preflight`. |
| `collaboration-routing/state.ts` | `state:show`, `state:doctor`, `state:epoch-check`. |
| `collaboration-routing/resources.ts` | `resource:list`, `resource:claim`, `resource:release`. |
| `collaboration-routing/handoff.ts` | `handoff:inventory`, `check`, `check-mid-cohort` and the handoff mutation actions. |
| `collaboration-routing/routing.ts` | `binding:*`, `transition*`, `rollover*` and `plan`. |
| `collaboration-routing/messages.ts` | `message:send`, `message:list`, `message:read`, `message:notify`. |

Import direction is one-way: `collaboration-router` → `collaboration-routing/*`
→ `commands/*`. No family module imports the router or `run.ts`, so the selector
cannot be re-entered and the graph stays acyclic.

## Invariants

1. **Selection order is behaviour.** The router tries families in one fixed
   order: `help`, `work-run`, `recovery-run`, `capabilities:derive`, `state`,
   `resource`, `handoff`, `recovery`, `binding`, `transition`, `rollover`,
   `plan`, `bootstrap`, `preflight`, `message`, then the `prepare|run|query`
   fallback. A handler returns `null` when the action is not its own, so a
   shared prefix (`state:` versus `state:show`) resolves by trying the more
   specific family first.
2. **Each family owns its option contract.** Duplicate-flag refusal, accepted
   option sets and the `failure(..., 'invalid_arguments', …)` message (including
   the family usage suffix) stay inside the family module, byte for byte.
3. **Help is one table.** `help.ts` is the only place that maps an action prefix
   to a usage string; families still own their constants in `commands/*`.
4. **The command implementations do not move.** Handlers keep calling the same
   `runCollaboration*Command` functions with the same argument expressions, so
   the pass-through boundary to the command layer is unchanged.
5. **Native families are not exercised by boundary tests.** `capabilities:derive`,
   `recovery*`, `bootstrap*` and `preflight` reach host and transport paths; the
   boundary suite asserts selection, precedence and refusal behaviour only.
6. **`tests/cli-routing.test.ts` stays the behavioural contract** (public
   `runCli`), and `tests/cli/cli-router-boundaries.test.ts` adds the structural
   contract: router thinness, one handler per family, and no reverse imports.
