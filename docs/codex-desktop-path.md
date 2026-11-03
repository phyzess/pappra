# Codex desktop path

This page records what the Codex host and its CLI actually did on this machine, with
Herdr and Pi absent from the path. Every row below comes from a command that was run, with
its output kept outside the repository in
`/Users/zimm.yu/.pappra/domains/host-native-m1/evidence/31-codex/logs/`. Nothing here is
inferred from an installed binary, an application name or a remembered tool.

The cohort instruction is that only `deepseek-flash` is used for Pappra participants. The
Codex host reports no model of its own, so its model is recorded as `unknown`, not as a
guess.

## Capability inventory

| Capability                 | Command that decides it                                            | Observed result                                                                                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version                    | `codex --version`                                                  | `codex-cli 0.164.0`                                                                                                                                                                                                                                   |
| Host identity (per run)    | `codex exec --json` → `thread.started`                             | `"thread_id":"01a19ff8-0290-7403-880d-78999991b83d"` (run A), `01a19ffb-e66c-7d63-8131-eb9d06ff415c` (run D)                                                                                                                                          |
| Host identity (browse)     | `codex agents --help`                                              | "Browse all agent sessions on the shared local app-server daemon"; needs the app-server, not a plain CLI run                                                                                                                                          |
| Model identity (exec)      | `codex exec --json` event stream                                   | `unknown` — no model field appeared in any event of runs A, B, C, D or E; the desktop `thread/start` response does report one (below)                                                                                                                 |
| Desktop host (daemon)      | `codex app-server daemon version`, `codex app-server proxy --help` | managed daemon `appServerVersion 0.166.0` with `cliVersion 0.164.0`; control socket `~/.codex/app-server-control/app-server-control.sock`; the socket is a websocket carrying JSON-RPC v2 (`initialize`, `thread/start`, `turn/start`, `thread/list`) |
| Desktop thread identity    | `initialize` → `thread/start` → `turn/start`                       | `01a1a13b-267c-7283-898e-2cd318c0b3e6` (desk A) and `01a1a13c-23e4-7bd2-8da4-f1597467ba02` (desk B); both keep rollout files under `~/.codex/sessions/2026/11/03/`                                                                                    |
| Desktop model identity     | `thread/start` response                                            | `model: "gpt-6-astra"`, reported by the daemon for both desktop threads                                                                                                                                                                               |
| Non-interactive execution  | `codex exec --sandbox read-only "<prompt>"`                        | works; run A completed in 74s with exit 0                                                                                                                                                                                                             |
| Sandbox modes              | `codex --help`                                                     | `read-only`, `workspace-write`, `danger-full-access`                                                                                                                                                                                                  |
| Result collection          | `codex exec --help`                                                | `--json` (JSONL events), `-o/--output-last-message <FILE>`, `--output-schema <FILE>`                                                                                                                                                                  |
| CLI read access            | run A item `item_1`                                                | `git status --short; git log --oneline -1` executed; the log line was returned                                                                                                                                                                        |
| CLI write access           | not attempted                                                      | `unknown` — no write was performed or required                                                                                                                                                                                                        |
| MCP servers configured     | `codex mcp list`                                                   | 9 stdio servers (codegraph, codex_app, cua_repl, figma, node_repl, pappra, serena, shadcn, spring-ui-mcp) and 3 HTTP servers (mcp-atlassian-service, mcp-gitlab, openaiDeveloperDocs); auth column `Unsupported`                                      |
| MCP write permission       | `codex mcp --help`                                                 | only `list`, `get`, `add`, `remove`, `login`, `logout` — no per-server write or permission control                                                                                                                                                    |
| MCP use in the live runs   | run A–E event streams                                              | zero `mcp` events; no MCP tool call was made                                                                                                                                                                                                          |
| Native subagent delegates  | `codex features list`, `codex exec --help`                         | `multi_agent stable true`, `multi_agent_v2 stable false`, `agent_message_board`/`subagent_*` under development; no delegation flag and no delegated child observed in five runs → `unknown`                                                           |
| Lifecycle: queue a message | `codex queue --help`                                               | `--thread <UUID> --message <TEXT>` against an existing session                                                                                                                                                                                        |
| Lifecycle: resume / fork   | `codex resume --help`, `codex fork`                                | resume by session id or `--last`; fork a previous session                                                                                                                                                                                             |
| Lifecycle: stop / cancel   | `codex --help`                                                     | unsupported — no stop, cancel, pause or interrupt subcommand exists; the closest control is appending a queued message                                                                                                                                |

`codex_app` — the desktop application's tool server — is listed as `disabled` in
`codex mcp list`. `cua_repl` and `node_repl` are listed as enabled, so browser and
computer-use tooling is configured on this machine; the five live runs neither used it
nor proved it is unavailable to a non-interactive session.

## The live run

Version, exact command and prompt:

```sh
$ codex --version
codex-cli 0.164.0

$ codex exec --sandbox read-only --json -o runA-last.txt \
    "You are a fresh non-interactive Codex session, sandbox read-only. Do exactly this:
     (1) run \`git status --short\` and \`git log --oneline -1\`;
     (2) run \`node /Users/zimm.yu/personal/YU/pappra/dist/cli/main.js resume demo-clean --json\`;
     (3) then answer in at most 4 short lines: the packet objective, the reported next
     action, the reported verification status, and whether execution was allowed.
     Do not write or modify any file." < /dev/null
```

Trimmed output. The event stream opened with the thread identity, then two real command
executions:

```json
{"type":"thread.started","thread_id":"01a19ff8-0290-7403-880d-78999991b83d"}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution",
  "command":"/bin/zsh -lc \"nu -lc 'git status --short; git log --oneline -1'\"",
  "exit_code":0,"status":"completed"}}
```

The first command returned the commit line but also, on stderr, repeated
`git: error: couldn't create cache file '/tmp/xcrun_db-...' (errno=Operation not
permitted)` — the read-only sandbox denies the temporary file git's shim wants. The second
command returned a real `pappra/resume-packet/1`, and inside it
`"currentCaptureStatus":"unknown"` with `"codeDrift":{"status":"unknown",...}`. The final
message, trimmed:

```text
包目标：为真实提交演示范围明确的交接包。
下一步：在全新上下文中审查候选版本内容。
验证状态：unknown（未知）。
允许执行：否（executionAllowed: false）。
```

What this proves: a non-interactive Codex session on this machine can read a repository,
execute the Pappra CLI, and obtain a real resume packet without Herdr or Pi. It answers in
Chinese for an English prompt, which is a host behaviour, not a defect in the packet.

What it does not prove: that the code is unchanged. The capture step degraded to `unknown`
inside the read-only sandbox, so the run cannot be used as evidence that the tree was
clean — only that the packet was readable.

## The desktop host

The five runs above are `codex exec`: one process, one prompt, no shared session
state, and no access to the desktop MCP configuration in the way the desktop host
has it. The desktop side was measured separately, through the app-server daemon the
desktop tooling manages. The client is
`evidence/31-desktop/drive_thread.py`: it opens the control socket, performs the
websocket upgrade, and speaks the app-server JSON-RPC v2 protocol directly
(`initialize`, `thread/start`, `turn/start`, then the server notification stream).

Two threads were driven, both `sandbox: "read-only"`, `approvalPolicy: "never"`,
cwd `/Users/zimm.yu/personal/YU/pappra`.

**Desk A — what the desktop host can actually do** (`01a1a13b-…`, events in
`evidence/31-desktop/logs/deskA-events.jsonl`). The session saw twelve MCP servers
(`codegraph`, `codex_apps`, `cua_repl`, `figma`, `mcp-atlassian-service`,
`mcp-gitlab`, `node_repl`, `openaiDeveloperDocs`, `pappra`, `serena`, `shadcn`,
`spring-ui-mcp`) and the `pappra` tool set (`checkpoint`, `code_prepare`,
`code_query`, `code_status`, `collab_prepare`, `collab_start`, `docs_check`,
`docs_list`, `docs_scan`, `resume`, `runtime_install`, `runtime_status`,
`workspace_status`). Then, as instructed:

- `pappra` `workspace_status` → completed; repository `pappra`, one repository found.
- `pappra` `docs_list` → completed, 0 registered documents, nothing pending review.
- `pappra` `checkpoint` with `apply: true` → refused, verbatim: "pappra checkpoint
  requires an authorized CLI invocation. A tool-supplied apply flag is not user
  approval." No file was created, modified or deleted.

**Desk B — handoff and review across hosts** (`01a1a13c-…`, events in
`evidence/31-desktop/logs/deskB-events.jsonl`). The fresh session read
`docs/handoff-template.md` and `docs/review-request-template.md`, ran
`pappra resume m1-g1-handoff --json` on a real checkpoint, built the package and
returned a bounded verdict: base `603f5c0…` taken from the task-start decision rather
than the intermediate checkpoint head, candidate `d0b6fda…`, `git status --short`
empty, digests `ca92620f…` (`codex-desktop-path.md`), `745f917b…`
(`handoff-template.md`) and `7ae57caf…` (`host-native-boundaries.md`), and verdict
`request changes` for one real evidence gap — the candidate's `pnpm check` log was not
in the package. That is the #30 material working end to end on a host with no Herdr
and no Pi in the path, and it is also a review that refused to approve on a package
it could not verify.

**One capability blocked first, and how it cleared.** Two earlier desktop turns failed
before the recorded ones: threads `01a1a12a-ffc7-7b62-8c13-9eb63f77d021` and
`01a1a13a-824c-7093-924a-5a4ac5eadf41`. Their host-written rollout files are kept as
`evidence/31-desktop/logs/deskA-failed-01a1a12a.jsonl` and
`deskA-failed-01a1a13a.jsonl`, and each carries the failure verbatim:
`codexErrorInfo: "unauthorized"`, "Your access token could not be refreshed because
you have since logged out or signed in to another account. Please sign in again."
That happened while `codex login status` said "Logged in using ChatGPT" and
`codex exec` worked, so the CLI and the daemon keep separate token state. Desktop
thread creation succeeded in both attempts; only the model turn failed. A coordinator
`codex app-server daemon restart` reloaded the daemon's credentials, and both later
threads completed. Nothing was re-authenticated, no account state was changed and no
user setting was overwritten.

**What this does not prove.** The desktop application's own in-app chat session was
never driven, so no claim is made here about UI-driven approvals, desktop-only tools
(`codex_app` is `disabled` in the MCP list) or the app's own session surface. What was
driven is the managed app-server daemon, with the same `~/.codex` configuration and
the same MCP set the desktop tooling uses. Whether the app's chat surface shares this
daemon's threads is not established by these runs.

### 1. Workspace, docs and continuity access without Herdr or Pi

Run A. `git log --oneline -1` worked, `pappra resume demo-clean --json` returned the
packet, and the session named the objective and the next action from it. Workspace and
continuity access: pass. Drift verification in that same run: degraded to `unknown`
because git could not write its temporary cache under `--sandbox read-only`.

### 2. A fresh-context reviewer receiving the #30 materials

Run C asked a new Codex session to check three criteria against the three new pages and
return a bounded verdict. It returned one blocking finding:

```text
C3: fail (docs/handoff-template.md:46 仅声明不构成 acceptance，缺少其余三项)
docs/handoff-template.md:46 - 应明确：正式协议之外的 advisory review 绝不构成 ACK、REPORT、acceptance 或 ownership 证明。
Verdict: request changes
```

That finding was correct: the template's constraint line named only `acceptance`. The line
was fixed, which produced new bytes with new digests, and a second request (run D) was sent
against them:

```text
C1: pass (docs/handoff-template.md:19 十一个必填字段全部列出)
C2: pass (docs/handoff-template.md:17 每个字段均说明填写方式及不可用时的标记或拒绝交接规则)
C3: pass (docs/handoff-and-review.md:13；docs/handoff-template.md:46；docs/review-request-template.md:12 ...)
Verdict: approve
```

A later formatting pass moved two of those files again, so a third request (run E) was sent
against them rather than carrying the earlier approval forward:

```text
C1: pass (docs/handoff-template.md:19 列齐十一项必填字段)
C2: pass (docs/handoff-template.md:17 每项均说明填写方法及缺失处理；三项缺失时禁止交接)
C3: pass (docs/handoff-and-review.md:13、docs/handoff-template.md:46、docs/review-request-template.md:12 ...)
Verdict: approve
```

All three verdicts are advisory. Run C reviewed digests `a9627316`, `27af5510`, `7eae3a44`;
run D reviewed `a9627316`, `0e98484a`, `7eae3a44`; run E reviewed `a5de7c26`, `b0163efd`,
`7eae3a44`. `docs/handoff-template.md` is now `dc20b0a9`, because its opening sentence was
corrected after run E, so the current bytes of that file are unreviewed by any Codex run — by
this page's own rule, a candidate that moved after the review is unreviewed.
`docs/handoff-and-review.md` also moved after run E, in this correction pass, so run E did
not read its current bytes either. Only `docs/review-request-template.md` still matches what
run E read (`7eae3a44`).
None of the three is an ACK, a REPORT, an acceptance or a proof of ownership, and none
decides anything for the coordinator. Threads: `01a19ffb-e66c-7d63-8131-eb9d06ff415c`
(run D) and `01a19ffd-1f1c-7e52-aa1a-80542b7b4794` (run E).

### 3. A new session resuming a checkpoint and verifying drift

Run B, in a fixture whose dirty tree had moved after its checkpoint:

```text
codeDrift.status：`changed`
仓库 `demo`：`changed`
storedPatchDigest `sha256:a652bd91...` ≠ currentPatchDigest `sha256:ba1c7486...`
verificationStatus：`stale`
```

The session read the drift and stopped there; the packet's own exit code was 1. This is
the scenario working as intended: a successor learns that the bytes moved before it
continues.

### 4. Limitations that reported themselves instead of silently improvising

- **Stale code index.** `pappra code query --repo pappra --kind explore --query
"continuity checkpoint resume packet" --json` returned `ok: false`, zero items,
  `"unsupportedReason": "The selected code index is not ready; only text or structure
fallback is available."`, `reasons: ["registration_identity_changed","index_not_ready"]`
  and exit 1. No result was fabricated; the caller must read source instead.
- **MCP writes.** No command controls MCP write permission; the live runs made no MCP call
  at all. Treat MCP write capability as uncontrolled here rather than as available.
- **Missing native delegation.** `multi_agent` is a stable feature flag, but no
  non-interactive delegation surface was observed and no child session appeared. A
  user-owned sidebar chat was never opened to impersonate one; the capability is recorded
  as `unknown` and unused.
- **An unknown control capability.** There is no stop or cancel subcommand. The bounded
  control that does exist is `codex queue --thread <UUID> --message <TEXT>`; whether that
  message reaches a running turn is not something these runs proved.

### 5. A standalone CLI not claiming desktop-only tools

The five runs were plain `codex exec` invocations. They used no desktop app tool, made no
MCP call, and required no app-server; `codex_app` is `disabled` in the MCP list. That is
evidence about what the CLI run used, not proof that desktop tools are unreachable from a
headless session — `cua_repl` and `node_repl` remain enabled in the same configuration.

## Fixtures versus live runs

- **Fixtures** are three throwaway git repositories under
  `evidence/30-handoff/` (`clean-handoff`, `dirty-handoff`, `missing-evidence`), each with
  its own `.pappra/workspace.json`. They exist to make checkpoints, dirty patches and
  missing artefacts reproducible, and nothing in them is part of the candidate.
- **Live runs** are the five `codex exec` sessions above, whose prompts, JSONL event
  streams and last messages are kept verbatim in `evidence/31-codex/logs/`. Runs C and D
  read the real repository, read-only.
- **Live desktop runs** are the two app-server threads, kept verbatim in
  `evidence/31-desktop/logs/` together with the client that drove them
  (`evidence/31-desktop/drive_thread.py`) and the generated protocol schema
  (`evidence/31-desktop/schema/`). They are not fixtures: they are the daemon's own
  threads, and their rollout files stay in `~/.codex/sessions/2026/11/03/`.
- No fixture was presented as a live run, and no live run was reduced to a fixture.

## Cost

`unknown` for money. The five `codex exec` event streams do carry token usage: run A's
`turn.completed` reports `input_tokens` 131138, `cached_input_tokens` 106752 and
`output_tokens` 427, and every other run reports the same shape of usage. The two desktop
threads report `thread/tokenUsage/updated` the same way. No dollar figure and no provider
invoice exist in any of these streams, and Pappra does not convert tokens into dollars.
Wall-clock is known: run A took 74 seconds, and runs B, C, D and E each completed within
the same order of magnitude.

## Remaining gaps

- The `codex exec` event stream reports no model for its own runs, so any claim about
  which model produced those verdicts is unattributable. The desktop `thread/start`
  response does report `gpt-6-astra`, which is why the desktop threads can be attributed
  and the exec runs cannot. Record `unknown` and treat the verdict as a bounded review,
  not as a model-level guarantee.
- Drift capture inside `--sandbox read-only` can degrade to `unknown` when git cannot
  create temporary files. A read-only reviewer must therefore not conclude "unchanged"
  from an `unknown` packet.
- Native delegation for non-interactive runs is unproven. The feature flag exists; the
  observable surface does not.
- There is no stop or cancel control, so an abandoned run is bounded by its own sandbox
  and timeout rather than by the CLI.
- MCP write permission has no control surface in this version, which is why the runs made
  no MCP call at all.

Desktop gaps: the app's own in-app chat runtime was not driven; UI-driven approval
prompts, `codex_app` and other desktop-only tool servers remain unproven; the desktop
client here speaks the app-server protocol directly, which a standalone CLI can do only
because the daemon exposes a socket, not because a CLI inherits the host's tools.

This page is the G1 material. It does not claim that G1 passed, that anything was
accepted, merged or released, or that the #31 path is complete beyond what the commands
above show.
