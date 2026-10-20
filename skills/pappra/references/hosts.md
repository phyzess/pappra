# Host surfaces

## Pi

The project integration installs an extension plus a copied `pappra` skill; the
generated entrypoint imports the fixed Pappra runtime by absolute file URL.
`pappra host bundle --host pi` exports a self-contained package instead: the
entry imports `./runtime.mjs` next to it, so the package survives a moved
checkout. Pi 1.3.0 was verified in a real session through the packaged extension
(`pi install <dir> -l -a` + `pi -p -a`).

## Codex

Codex 0.163.0 loads command hooks only from its user configuration directory.
Wire it with `pappra host install --host codex --scope user`, which merges only
Pappra-owned entries into `$CODEX_HOME/hooks.json` (existing hooks and unrelated
keys are preserved) and copies the bundled hook there. Project
`.codex/hooks.json` and plugin-bundle hooks are not loaded at this version.
Codex hook definitions are trusted individually; installation is not trust.
Observed 0.163.0 hook keys do not include a compact event, so compact and
automatic checkpoint requests remain unsupported.

## Claude Code

The project integration installs a command-hook entry and merges only
Pappra-owned entries into `settings.json`; the command uses
`${CLAUDE_PROJECT_DIR}`. `pappra host bundle --host claude --marketplace` exports
a plugin whose hook uses `${CLAUDE_PLUGIN_ROOT}`; the marketplace validates with
`claude plugin validate` and startup was verified in a real session. `SessionStart`
and `PostCompact` are distinct; matchers, trust, timeout, and output behavior
remain host/version-specific. Installing a command is not proof it ran.

## Common safety

All surfaces use the event's canonical cwd/root, bounded stdin, a one-second
local deadline, no transcript reads, no arbitrary configured commands, and no
network/model/index/session side effects. Paths with spaces or Unicode are
passed as argv/file URLs, never interpolated into a shell. Plugin registration is
host-specific; never claim a hook is loaded because files were written or a
validator passed.
