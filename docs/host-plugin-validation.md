# Host plugin validation

Pappra exports host-native plugin bundles with `pappra host bundle --marketplace`
(Claude Code and Codex) or a plain package directory (Pi). This page records what was
actually observed, because a passing export is not evidence that a host loads or trusts a hook.

Pinned versions used by the shipped support matrix: Claude Code `2.1.292`, Codex `0.163.0`,
Pi `1.3.0`. The admitted event matrix also includes Claude `2.1.308`, Codex `0.164.0` and Pi
`1.4.0`. `pappra onboard` and `pappra host verify` use the admitted set; onboard
passes the actual observed version rather than the reference pin (see [API boundaries](api.md)).

## Support matrix

| host | plugin hooks | project settings hooks | user-scope hooks | events observed |
| --- | --- | --- | --- | --- |
| Pi 1.3.0 | verified (startup) | verified (startup) | n/a | `session_start`; compact/checkpoint unverified |
| Pi 1.4.0 | layout verified offline | layout verified offline | n/a | `session_start`; bootstrap bundle load unverified |
| Codex 0.163.0 | unsupported | unsupported | verified (startup) | `SessionStart`; `PostCompact` unsupported |
| Codex 0.164.0 | unsupported | unsupported | verified (startup) | `SessionStart` |
| Claude Code 2.1.292 | verified (startup) | verified (startup) | n/a | `SessionStart` |
| Claude Code 2.1.308 | verified (startup) | verified (startup, compact, clear) | n/a | `SessionStart` (`compact`, `clear`), `PostCompact` |

"Verified" means a real host session produced a `pappra/host-event/1` record with the host,
normalized event, native event name and a fresh `observedAt`. It does not mean the host trusts
the hook for every project, that reload happened, or that a later version behaves the same.

## Method

1. Scratch workspace: `git init`, then `pappra init --yes --apply` with an isolated
   `PAPPRA_DATA_HOME`.
2. `pappra host bundle --host <name> --host-version <admitted> --out <dir> [--marketplace]`.
3. Register the bundle through the host's own mechanism, in an isolated home where possible.
4. Run one non-interactive session in the workspace and check for
   `.pappra/local/host-events/<host>/*.json`.

## Pi — verified (startup)

```sh
pappra host bundle --host pi --host-version 1.3.0 --out .plugin/pi --json
pi install .plugin/pi -l -a          # project-local package, trusted for this run
pi -p -a --no-tools "reply with ok"  # non-interactive session
```

An observed event record has this shape (identifiers redacted):

```json
{
  "schema": "pappra/host-event/1",
  "host": "pi",
  "event": "startup",
  "nativeEvent": "session_start",
  "sessionId": "<session-id>",
  "source": "pi-extension",
  "observedAt": "2026-10-20T06:01:34.180Z"
}
```

`pi -e <dir> -p` (one-shot extension load, no settings change) produced the same record, so both
the package layout and the generated extension work. Compact and checkpoint-request events were
not exercised; they remain unverified for this host.

### Installed layout regression check

The project-settings installer now places both `index.ts` and its imported `runtime.mjs` in
`.pi/extensions/pappra/`. Keeping the runtime under `templates/pi/` only satisfied a
file-presence check; the native loader could not resolve the entry's relative import.

An isolated smoke on 2026-10-24 installed the current extension into a scratch workspace, then
ran an available Pi `1.4.0` executable with a fresh `PI_CODING_AGENT_DIR`, offline mode, no
tools/MCP, and RPC mode. It used automatic project extension discovery and project trust for that
run. `get_commands` returned `pappra-checkpoint`, and the actual `session_start` handler wrote one
`pappra/host-event/1` record. No model prompt was sent and no user host settings were changed.
This validates the installed entry/runtime layout; it does not establish additional
plugin-hook or compact support.

## Codex — plugin hooks unsupported, user-scope hooks verified

Codex is the one host whose hooks do not live in the workspace.

**Plugin bundle: unsupported.** The marketplace bundle installs and is enabled, but a control
hook written to the isolated `CODEX_HOME/hooks.json` fires while the bundled plugin hook never
runs, with or without a hook-trust bypass flag. That matches the upstream issue where plugin hook
manifests are ignored. Pappra therefore does not claim plugin hooks for Codex.

**User scope: verified.** Codex loads lifecycle hooks from its user configuration directory.
Wire it explicitly:

```sh
pappra host install --host codex --scope user --apply
```

After explicit approval of the temporary directory and review/trust of the single Pappra hook
through native `/hooks`, fresh native sessions recorded `SessionStart`. Hooks also require trust:
approve them once in Codex, or the host runs no hook. Project `.codex/hooks.json` is not a
supported surface, and `PostCompact` remains unsupported.

## Claude Code — verified (startup; compact and clear at 2.1.308)

The marketplace validated and installed at project scope, and a real non-interactive session
wrote a `SessionStart` event. That established startup for `2.1.292`.

A later run with `2.1.308` loaded only project settings, to isolate the Pappra integration, and
accepted `/compact` and `/clear`. `PostCompact` completed successfully; native records include
`PostCompact`, `SessionStart` with source `compact`, and a fresh `SessionStart` with source
`clear`. Only these events are verified for this host; other lifecycle events and other
installed-plugin combinations remain unobserved.

## Real-host acceptance pass (beta.16 build, recorded)

The beta.16 build was exercised with Pi `1.4.0`, Claude Code `2.1.308` and Codex `0.164.0`, in
disposable workspaces whose paths contain spaces and Unicode. Recorded observations:

- Installing the Claude integration with one Node minor, then verifying and reinstalling with a
  later Node minor, preserved the exact hook configuration bytes. Commands resolved `node`
  through PATH and did not duplicate managed entries.
- The real Pi loader loaded the installed `index.ts` and adjacent `runtime.mjs`, registered
  `pappra-checkpoint` and recorded `session_start`. This loader check was offline and sent no
  model prompt.
- A separate admitted `collab run --controller pi-rpc`, using normal native Pi configuration and
  capabilities derived from a real read-only handshake, completed in about 136 seconds. Its real
  Bash call waited 130 seconds. The owned process exited successfully and the completed report
  was classified `applied`.
- Real managed Pi TUI processes received SIGTERM and SIGHUP in separate PTYs. Both runs restored
  canonical input and echo, and both the owned Pi process and bridge exited. This signal check
  sent no model prompt and makes no claim about arbitrary descendants or external writers.

Temporary interactive trust was explicitly authorized. Daily host configuration files were not
edited; copied credentials used for the temporary host home were removed during cleanup. Native
transcripts and detailed receipts remain private rather than being published with this guide.

The frozen build also passed `pnpm check` in that recording: 1,108 tests, 1,103 passed, five
skipped, zero failed, followed by the installed-package smoke. Those counts are a historical
observation of that build, not a claim about the current checkout.

The beta.16 tag subsequently failed Linux CI because two CLI tests relied on globally installed
Pi/Codex executables; npm publication was skipped. Beta.17 keeps the tested runtime behaviour and
makes those CLI fixtures hermetic. An independent review ran both affected cases with only Node
and system binaries on PATH, and verified that missing or unsupported native versions still fail.

## Pi bootstrap bundle (opt-in, unverified load)

`host bundle --host pi --transition-extension`/`--bootstrap-config` exports additional opt-in
extensions and a private sibling config. Exporting does not install, trust, enable, load, launch
or transfer anything, and this page has **not** verified a native load of the bootstrap
extension. Review and install it explicitly.

## Ownership, locks and verification limits

- Installed files, the ownership manifest and the config patch stay within the host root the
  operator named. User settings, formatting, newline style and permissions are preserved on
  merge and uninstall.
- `host verify` compares the packaged bundle digest and installed-file digests, and checks the
  expected managed hook entries structurally. It deliberately does not treat the shared settings
  file's whole-file digest as an ownership claim.
- A verified live lock owner is never overridden. Dead owners can be reclaimed; unknown or
  imported owners require an explicit stop-all-writers assertion, and the evidence is quarantined
  with a receipt rather than deleted.
- Copied or moved project hooks with relative expressions can be verified and reinstalled after
  the move; a non-Pi manifest pinned to an absolute expression is rejected when the selected
  target identity differs. The CLI has no `--migrate` option.
- `doctor` reports host wiring, bundle presence and locks, and still reports native
  trust/reload/callability as unverified.
- No hook-trust bypass flag is used in any recorded acceptance, and none should be added to a
  documented procedure.
