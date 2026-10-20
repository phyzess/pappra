# Agent-native usage, onboarding and version resilience

Status: proposed plan (2026-10-20). Supersedes the "remaining gaps" notes in
`docs/distribution-plan.md` §9 where they overlap.

## 1. Problems

The shipped beta works when a human or an agent runs the CLI from a prepared workspace.
Three gaps make that feel manual and fragile:

1. **No agent-native tools.** Hosts get a skill (text) and lifecycle hooks (observations).
   Nothing exposes `resume`, `checkpoint`, `docs scan`, `code query` or collaboration as
   callable tools, so an agent must reconstruct shell commands.
2. **Collaboration is not conversational.** `collab prepare` needs a structured
   `pappra/collaboration-goal/1` and a capability card; prose cannot become identity or
   approval. There is no wrapper that turns an objective into those artifacts with one
   explicit confirmation.
3. **Distribution and portability are implicit.** Daily use needs a global `pappra`; a new
   machine needs install, workspace re-binding, runtime install and per-host wiring plus
   trust. Only `.pappra/local` is machine-local, but that is not documented as a boundary.

Historical context (why these did not show up earlier): the private prototype ran from its
own checkout (`node dist/cli/main.js`), on older hosts (`pi 1.2.0`, `codex 0.162.1`,
`claude 2.1.287` per `src/collab/admission.ts`), in single-repository workspaces. The public
repository is a sanitized source, so some early scripts have no direct equivalent. Version
drift, installed-package use and multi-repository roots exposed the gaps.

## 2. Goals and non-goals

Goals:

- Any supported agent can call Pappra capabilities as tools without composing shell strings.
- A fresh machine can reach a working workspace with one documented command path, and a
  second workspace with one `pappra onboard` run.
- Host/version drift fails with an actionable diagnostic instead of a silent break.
- The safety model is preserved: no prose-to-authority, no implicit model launch, explicit
  consent for writes and for any collaboration controller.

Non-goals: daemon/scheduler, auto-checkpoint, auto-indexing, silently approving host trust,
global cross-workspace memory, replacing host-native task workflows.

## 3. Workstream A — installed `pappra` and onboarding

### A1. Make the installed command the primary path

- Docs lead with `npm install -g @phyzess/pappra@beta` → `pappra …`; `npx` stays the
  zero-install pin.
- Registry reality: public npm works for external machines; this machine's Nexus mirror
  does not serve `@phyzess` yet. Either mirror the scope in Nexus or document a per-scope
  registry override:
  `npm config set @phyzess:registry https://registry.npmjs.org/`.
- Keep `bin.pappra`; no rename.

### A2. New `pappra onboard`

```
pappra onboard [--root <dir>] [--config <choices>] [--yes]
               [--hosts claude,codex,pi] [--apply-host] [--json] [--dry-run]
```

Behaviour:

1. Resolve the workspace root (`--root` or cwd); refuse inside a nested workspace.
2. Detect installed hosts and their versions; compare with `HOST_SUPPORT`; report drift
   without starting anything.
3. Plan `init` (choices file, or derived defaults with excludes prompt), including the
   durable runtime install.
4. Print, and with `--apply-host` execute, the host wiring commands:
   Codex `--scope user`, Claude project root, Pi bundle + `pi install` (the only verified
   Pi path). Never auto-approve host trust; print the exact approval step.
5. Emit a single JSON report: workspace, runtime, hosts with `{version, pinned, state,
   nextAction}`, applied files, pending manual steps.

`--dry-run` is read-only; `--apply-host` requires either `--yes` or a TTY confirmation.
Idempotent: a second run reports `no-changes` per host.

### A3. Portable workspace handoff

Document and enforce one boundary:

| Share / copy | Machine-local (never copy) |
| --- | --- |
| `.pappra/workspace.json` (portable paths, external ids) | `.pappra/local/machine.json` (absolute path, checkoutId, runtime binding) |
| `.pappra-choices.json` | `.pappra/local/code/*.json`, `.pappra/local/knowledge/catalog.json` |
| repository checkouts | `.pappra/local/host-events/**`, `host-bundles/**` (re-exportable) |

Add `docs/portability.md` and a `pappra onboard --print-handoff` mode that emits the exact
copy list plus the re-init command for the new machine. Do not build a packing format yet.

Acceptance:

```sh
pappra onboard --dry-run --json            # no writes, hosts + drift report
pappra onboard --yes --json                # init + runtime, prints host steps
```

On a second machine: copy `workspace.json` + choices, run `pappra onboard --yes`.

## 4. Workstream B — agent-native tool surface (`pappra mcp`)

### B1. Server

New dependency: `@modelcontextprotocol/sdk`. New command:

```
pappra mcp            # stdio MCP server, cwd = workspace root
pappra mcp --help     # tool catalog for humans/agents
```

Read-only tools (safe by default):

| Tool | Input | Output |
| --- | --- | --- |
| `workspace_status` | `{}` | doctor summary, repositories, knowledge counts, runtime state |
| `resume` | `{task, session}` | advisory packet + `executionAllowed` |
| `docs_list` | `{includePrivate?, includeArchived?}` | catalog records |
| `docs_check` | `{includePrivate?}` | freshness summary |
| `code_status` | `{repo}` | health, registration, next action |
| `code_query` | `{repo, kind, query, limit?, maxBytes?}` | bounded items + provider/coverage |
| `runtime_status` | `{}` | passive runtime state |
| `collab_prepare` | `{objective, repo, acceptance[], controller, resources?, phase?}` | prepared path, task id, constraints |

Write tools, each requiring `apply: true` and returning an explicit status:

| Tool | Input |
| --- | --- |
| `checkpoint` | existing checkpoint flags + `apply: true` |
| `docs_scan` | `{apply}` |
| `code_prepare` | `{repo, apply, rebuild?}` |
| `collab_start` | `{prepared, controller, confirm: true, commands?}` |
| `runtime_install` | `{from, version?, apply: true}` |

`collab_start` must require `confirm: true` and a controller (`pi-rpc` only when the user
asked); no tool may synthesize identity or approval from prose. Server process is stateless
per call, bounded by the existing CLI limits.

### B2. Registration per host

| Host | Registration | Verification |
| --- | --- | --- |
| Claude Code | project `.mcp.json` or `claude mcp add pappra -- pappra mcp` | `claude mcp list`; tool call in a session |
| Codex | `[mcp_servers.pappra]` in `.codex/config.toml` or user config | `codex mcp list`; tool call in `codex exec` |
| Pi | MCP server config in Pi settings, or a Pi extension that registers tools | `pi` session tool list |

Add `pappra host mcp plan|install --host <name> [--scope project|user] --apply` that writes
the exact config with merge-managed semantics (same ownership discipline as hooks). Default
project scope; user scope only for Codex (matching hook behaviour). `host verify` gains an
MCP check (server command resolves, config entry present, tools can be listed).

### B3. Conversational collaboration

`collab_prepare` (tool) and `pappra collab prepare-from` (CLI) build the goal from:

- objective, phase, acceptance, repo/resources (write claims only when asked),
- a generated capability card from the controller baseline (host+version+allowed tools;
  card marked `evidence_level: declared` until a real session upgrades it),
- task id + attempt + coordinator identity supplied explicitly (`--task`, `--session`,
  `--harness`).

`collab_start` then performs admission and one launch. The confirmation is the tool's
`confirm: true` or CLI `--confirm`; nothing derives consent from chat text. If the card is
declared-but-not-runtime, the server refuses work mode and explains the discovery path.

### B4. Auto-resume without guessing

- Add `pappra task pin <id>` / `task unpin`: writes `.pappra/local/current-task` (explicit,
  machine-local).
- Hooks read that pin and include the bounded resume packet in `additionalContext`; without
  a pin they keep the current generic advisory text. Never infer a task from history.
- `pappra host install` passes `--task` only when the user pins; `doctor` shows whether a
  pin exists.

### B5. Trust and consent UX

`onboard` and `host install` print the one-time host steps (Codex hook approval, Pi project
trust, Claude plugin trust/reload). No code path approves them. `doctor` reports
`trusted: unknown` and the exact next action.

## 5. Workstream C — version-drift resilience

- Extend `HOST_SUPPORT` with adapter baselines:
  `{hookVersion, rpcBaseline, surfaces}`; today's code comments record `pi 1.2.0`,
  `codex 0.162.1`, `claude 2.1.287`.
- `pappra doctor` / `onboard` compare installed vs pinned vs adapter baseline:
  exact pin → `verified`; same minor but different patch → `unverified`; different minor →
  `unsupported` with the safe fallback (project-settings / manual continuity).
- Add `pappra host probe --host <name>`: protocol-level, no model call — starts the RPC
  child, performs `get_state`, verifies session id/file expectations, exits. Used by CI and
  by `onboard` before claiming any host surface.
- Adapter conformance fixtures: session lifecycle v1 (eager file, 1.2) and v2 (lazy file,
  1.3), prompt baseline, finish classification. Extend `tests/collab` fakes.
- Release checklist: any host-pin change requires `docs/host-plugin-validation.md` evidence
  for startup; collaboration changes require a real `COLLAB_OK`-style transcript.
- Upgrade path: after upgrading the package, `init --reconfigure --apply` updates the runtime
  target; `doctor` warns when the bound runtime version differs from the package.

## 6. Workstream D — documentation

- `docs/quickstart.md`: installed `pappra` first; `npx` fallback; onboarding; trust steps;
  multi-machine handoff; MCP setup.
- `docs/portability.md`: the copy matrix above plus the second-machine recipe.
- `docs/agent-native.md`: tool catalog, consent model, controller rules, examples.
- `docs/pi-rpc.md`: version matrix, probe, upgrade notes.
- `docs/support.md`: drift states, MCP limits, trust limits.
- Packaged skill + repo mirror: mention `pappra mcp` tools and `pappra onboard`; keep the
  "no prose-to-authority" rule.
- `docs/distribution-plan.md`: link this plan as the next phase.

## 7. Milestones

| Milestone | Content | Acceptance |
| --- | --- | --- |
| M6 | A1 + A2 `onboard --dry-run/--json` + portability docs | second-machine simulation passes; JSON report stable |
| M7 | B1 read-only MCP tools + B2 Claude/Codex registration | tool list in each host; `resume`/`code_query` work from a session |
| M8 | B1 write tools + B2 Pi registration + verify checks | checkpoint/docs_scan/code_prepare via tools with `apply` |
| M9 | B3 collab prepare-from/start + B4 task pin + hook auto-resume | conversational objective → prepared → report; pinned task appears at SessionStart |
| M10 | C drift matrix + `host probe` + release checklist | probe passes for pinned hosts; mismatch produces actionable state |

Rough effort: M6 1–2 d, M7 2–3 d, M8 2 d, M9 3–4 d, M10 2 d.

## 8. Risks

- **MCP surface security**: a write tool that trusts the model would turn prose into
  authority. Keep `apply`/`confirm` gates, bounded inputs, and typed denials.
- **Host-specific MCP support** differs by version; register per host with verification, not
  assumption. Codex hook loading already proved version sensitivity.
- **Registry split**: public npm vs internal Nexus changes one-line installs; `onboard` must
  detect and explain rather than fail obscurely.
- **Adapter drift**: a new Pi/Codex/Claude minor can change lifecycle semantics; the probe and
  conformance fixtures exist to catch this before a release claims support.
- **Sanitized upstream**: some prototype behaviours may not be reproducible; document the
  current contract and do not imply parity.

## 9. Decisions needed

1. MCP SDK dependency and stdio-only transport (no HTTP).
2. Nexus: mirror `@phyzess` scope, or document per-scope registry override.
3. `onboard --apply-host`: allowed by default with `--yes`, or always opt-in per host?
4. Tool naming: one `pappra mcp` server with all tools, or split read/write servers?
5. Auto-resume: task pin only, or also a workspace-config opt-in "last checkpoint"?
