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

## Codex 0.163.0 — plugin hooks unsupported

The marketplace bundle installs and is enabled:

```sh
codex plugin marketplace add .market --json        # marketplaceName pappra-local
codex plugin add pappra@pappra-local --json        # installedPath .../plugins/cache/...
```

A control hook written to the isolated `CODEX_HOME/hooks.json` fired during

```sh
codex exec --dangerously-bypass-hook-trust --skip-git-repo-check "reply with ok"
```

(`hook: SessionStart Completed` plus a marker file), but the bundled plugin hook never ran:
no `.pappra/local/host-events/codex` record was written. The same result held after adding a
`.codex-plugin/plugin.json` copy to the installed plugin and after pointing the command at an
absolute hook path. This matches the upstream Agent Plugins hook-loading issue.

Conclusion: keep `--mode project-settings` (which writes `.codex/hooks.json` in the target
workspace) for Codex at this version. Do not advertise plugin hooks for Codex.

## Claude Code 2.1.292 — unverified (no authenticated session)

The exported marketplace validates with the host's own validator:

```sh
claude plugin validate .market
# Validating marketplace manifest: .../.claude-plugin/marketplace.json
# ✔ Validation passed
```

`claude -p` could not run on the recording machine:

```
Failed to authenticate: OAuth session expired and could not be refreshed
```

So no lifecycle event was produced. The hook command uses
`"${CLAUDE_PLUGIN_ROOT}/hooks/pappra-hook.mjs"` (double-quoted, as the validator requires)
and the same bundled hook runs correctly when invoked directly, but plugin callability in a
real Claude session is still open.

To close it: authenticate once (`claude` login flow), then repeat step 2-4 above with
`claude plugin marketplace add .market` + `claude plugin install pappra@pappra-local`, run a
session (including `/compact`), and check `.pappra/local/host-events/claude/*.json`.

## Current gating

`pappra host install --mode plugin` fails closed for every host and reports the state above
in its diagnostic. `--mode project-settings` remains the install mode. Flipping a host to
plugin-by-default requires a recorded event for that host and version, added to
`HOST_PLUGIN_HOOKS` in `src/hosts/integration/support.ts`.
