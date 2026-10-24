# Host plugin validation

Pappra exports host-native plugin bundles with `pappra host bundle --marketplace`
(Claude Code and Codex) or a plain package directory (Pi). This page records what was
actually observed on this machine, because a passing export is not evidence that a host
loads or trusts a hook.

Pinned versions on the recording machine: Claude Code `2.1.292`, Codex `0.163.0`, Pi `1.3.0`.

## Method

1. Scratch workspace: `git init`, then `pappra init --yes --apply` with an isolated
   `PAPPRA_DATA_HOME`.
2. `pappra host bundle --host <name> --host-version <pinned> --out <dir> [--marketplace]`.
3. Register the bundle through the host's own mechanism, in an isolated home where possible.
4. Run one non-interactive session in the workspace and check for
   `.pappra/local/host-events/<host>/*.json`.

Evidence is the event record itself: `pappra/host-event/1` with the host, the normalized
event, the native event name and a fresh `observedAt`.

## Pi 1.3.0 — verified (startup)

```sh
pappra host bundle --host pi --host-version 1.3.0 --out .plugin/pi --json
pi install .plugin/pi -l -a          # project-local package, trusted for this run
pi -p -a --no-tools "reply with ok"  # non-interactive session
```

Observed `.pappra/local/host-events/pi/<digest>.json`:

```json
{
  "schema": "pappra/host-event/1",
  "host": "pi",
  "event": "startup",
  "nativeEvent": "session_start",
  "sessionId": "01a157e3-...",
  "source": "pi-extension",
  "observedAt": "2026-10-20T06:01:34.180Z"
}
```

`pi -e <dir> -p` (one-shot extension load, no settings change) produced the same record, so
the package layout and the generated extension both work. Compact and checkpoint-request
events were not exercised; they remain unverified for this host.

### Installed Pi extension layout regression check

The project-settings installer now places both `index.ts` and its imported
`runtime.mjs` in `.pi/extensions/pappra/`. Keeping the runtime under
`templates/pi/` only satisfied a file-presence check; the native loader could
not resolve the entry's relative import.

An isolated smoke on 2026-10-24 installed the current extension into a scratch
workspace, then ran the available Pi `1.4.0` executable with a fresh
`PI_CODING_AGENT_DIR`, offline mode, no tools/MCP, and RPC mode. It used automatic
project extension discovery and project trust for that run. `get_commands`
returned `pappra-checkpoint`, and the actual `session_start` handler wrote one
`pappra/host-event/1` record. No model prompt was sent and no user host settings
were changed. This validates the installed entry/runtime layout; it does not
expand the pinned `1.3.0` capability matrix or establish compact support.

## Codex 0.163.0 — plugin hooks unsupported, user-scope hooks verified

Codex is the one host whose hooks do not live in the workspace. Two separate findings:

**Plugin bundle: unsupported.** The marketplace bundle installs and is enabled:

```sh
codex plugin marketplace add .market --json        # marketplaceName pappra-local
codex plugin add pappra@pappra-local --json        # installedPath .../plugins/cache/...
```

A control hook written to the isolated `CODEX_HOME/hooks.json` fired during
`codex exec --dangerously-bypass-hook-trust`, but the bundled plugin hook never ran, with or
without a `.codex-plugin/plugin.json` copy and with absolute or relative commands.

**Project `.codex/hooks.json`: also not loaded.** Installing with
`pappra host install --host codex --host-root .codex --apply` wrote the file, and a real
`codex exec` session produced no `SessionStart` hook line and no host event.

**User scope: verified.** Codex loads lifecycle hooks from its user configuration directory:

```sh
CODEX_HOME=~/.codex pappra host install --host codex --scope user --host-version 0.163.0 --apply
```

That merges `$CODEX_HOME/hooks.json` (pappra-managed entries only; existing user hooks are
preserved), copies the bundled hook to `$CODEX_HOME/hooks/pappra-hook.mjs`, and writes a
manifest that `pappra host verify --host codex --scope user` checks. A real
`codex exec` session then wrote:

```json
{
  "schema": "pappra/host-event/1",
  "host": "codex",
  "event": "startup",
  "nativeEvent": "SessionStart",
  "source": "startup",
  "observedAt": "2026-10-20T06:31:36.789Z"
}
```

Codex only supports `SessionStart` (startup/resume); compact and checkpoint-request remain
unsupported by the pinned version. Hooks also require trust: approve them once in Codex, or
use `--dangerously-bypass-hook-trust` for isolated automation only.

## Claude Code 2.1.292 — verified (startup)

The exported marketplace validates with the host's own validator, installs at project
scope, and a real session wrote a host event:

```sh
pappra host bundle --host claude --host-version 2.1.292 --out .market --marketplace --json
claude plugin validate .market                 # ✔ Validation passed

claude plugin marketplace add .market --scope project --json
claude plugin install pappra@pappra-local --scope project -y --json
claude -p "reply with the single word ok"      # real session
```

Observed `.pappra/local/host-events/claude/<digest>.json`:

```json
{
  "schema": "pappra/host-event/1",
  "host": "claude",
  "event": "startup",
  "nativeEvent": "SessionStart",
  "sessionId": "89b1957e-...",
  "source": "startup",
  "observedAt": "2026-10-20T06:17:34.896Z"
}
```

The hook command uses `"${CLAUDE_PLUGIN_ROOT}/hooks/pappra-hook.mjs"` (double-quoted; the
validator rejects the unquoted form). `PostCompact` was not exercised from a non-interactive
session, so only startup is verified for this host.

### Hook runner and shared-settings ownership

Generated command hooks resolve `node` from the host's `PATH`; they do not pin
the installer's Node executable. Reinstall recognizes older single-quoted
absolute Node runners only when the script path, host, lifecycle argument and
`pappra-managed` marker match the selected installation. It replaces and
deduplicates those entries while preserving unrelated hooks and settings.
The default outer hook timeout is five seconds, covering the bounded stdin and
lifecycle work plus process startup. Larger integer timeouts are retained during
reinstall and accepted by verification. An edited managed matcher, an invalid
or too-short timeout, or an extra handler field remains a conflict; the old
absolute-runner default of one second is upgraded during migration.
Verification checks the managed entries and packaged files, rather than the
digest of the entire shared native settings file.

Synthetic stdin checks of the current standalone hook bundle cover both
Claude and Codex `SessionStart` envelopes with `source: clear` and
`source: compact`: all four exit successfully with no stderr. `clear` refreshes
startup context; `compact` refreshes resume context, retaining the original
source in the local event. This does not claim a new native Codex compact hook:
Codex `PostCompact` remains unsupported.

## Pi bootstrap bundle (opt-in, unverified load)

```sh
pappra host bundle --host pi --host-version 1.3.0 --out .plugin/pi-bootstrap \
  --bootstrap-config /abs/private/pi-bootstrap.json --json
```

This variant exports a new private directory (`0700`; `extensions/pappra-bootstrap/bootstrap.json`
is `0600`) whose Pi entry registers the accepted default-deny successor gate from an explicit,
trusted local task binding. The destination must not already exist; the flag is Pi-only and
bundle-only, and ordinary Pi bundles are unchanged without it.

The config is data, not a published asset and not model input:

```json
{
  "schema": "pappra/pi-bootstrap-config/1",
  "domainRoot": "/abs/canonical/domain",
  "taskId": "example",
  "guard": {
    "taskId": "example",
    "intentId": "intent-1",
    "handoffId": "handoff-1",
    "generation": 1,
    "subtaskId": "work",
    "attempt": 1,
    "inputRevision": "sha256:...",
    "coordinatorEpoch": 1,
    "successor": { "agentId": "agent", "sessionId": "session", "harness": "pi" },
    "claims": [{ "claimId": "claim-1", "originalResourceEpoch": 1 }]
  }
}
```

Validation is a bounded 64 KiB no-follow read with exact keys, canonical existing domain/task
directories, the short task-id pattern, guard limits and a unique claim set; it creates nothing
and exports a pre-transfer record as valid (exporting a guard is not writing). On load, the entry
installs a default-deny `tool_call` handler before config/reader/lifecycle initialization; any
failure keeps denial active and exposes a read-only `bootstrap-status` command instead of
throwing into loader fallthrough. `bootstrap-status` reports **registration**, never permission
(`write_permitted: not-asserted`); the accepted guard still decides per call, and a total host
loader/trust failure is not enforced gating. The export does not install, trust, launch,
transfer or archive anything, and this page has **not** verified a native load of the bootstrap
artifact.

### Portable export boundary

The bootstrap export keeps a directory bundle and uses only portable Node primitives. Its
supported guarantee is a **trusted local parent without concurrent namespace mutation**:

- an exclusive claim rejects any existing destination (empty, populated, file or symlink) and
  leaves it untouched;
- the payload is assembled in a private sibling staging directory and written there, with the
  private binding written last;
- device/inode and realpath identity checks reject observed staging or claim drift, and a failure
  **before publication** removes only the empty claim and the staging directory that this call
  created;
- export never installs, registers, trusts or grants write authority.

Publication is a rename followed by a final inode check, so it is **not a transaction**. A failure
during or after publication can return an error after the output directory has become visible.
Treat a failed CLI exit as *not* proof that no files exist: inspect the reported destination and
its identity, never blindly delete or recursively clean a path, and do not install or trust the
output merely because the export reported a failure.

This is **not** an OS filesystem fence. Portable Node on this platform exposes no `openat`,
`renameat2`/`RENAME_NOREPLACE` or `/dev/fd` directory anchoring, so a same-user process that
changes the output root or a nested path between a check and its use can still redirect a write or
affect publication and cleanup. Writing the private binding last reduces exposure but cannot
prevent a substitution injected exactly at that write. A stronger hostile-filesystem guarantee is
deferred, not claimed; use the export in a parent directory nothing else mutates concurrently.

## Current gating

Plugin hooks are verified for Pi 1.3.0 and Claude Code 2.1.292 (startup), and proven
unsupported for Codex 0.163.0. Plugin delivery stays an explicit export because the hosts
require their own registration step:

- Claude Code: `host bundle --marketplace` → `claude plugin marketplace add <dir>` →
  `claude plugin install pappra@pappra-local`
- Pi: `host bundle` → `pi install <dir> -l -a`
- Codex: user scope only — `host install --host codex --scope user` merges
  `$CODEX_HOME/hooks.json` (plugin bundles and project `.codex/hooks.json` are not loaded at
  0.163.0); approve the hook once in Codex

`pappra host install --mode plugin` therefore stays fail-closed and reports the per-host
state and the exact commands, while `--mode project-settings` remains the automatic
workspace wiring. `HOST_PLUGIN_HOOKS` in `src/hosts/integration/support.ts` records the
evidence that gates this message.
