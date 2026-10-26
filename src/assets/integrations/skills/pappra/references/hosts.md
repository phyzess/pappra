# Host surfaces

## Pi

The project integration installs an extension plus a copied `pappra` skill; the
generated entrypoint imports `./runtime.mjs` beside it.
`pappra host bundle --host pi` exports a self-contained package instead: the
entry imports `./runtime.mjs` next to it, so the package survives a moved
checkout. Pi 1.3.0 was verified in a real session through the packaged extension
(`pi install <dir> -l -a` + `pi -p -a`).

`pappra host bundle --host pi --bootstrap-config <abs-file>` is the opt-in successor
variant: the destination must be new, the private config binds one canonical task root
and guard pin, and the generated entry installs a default-deny tool gate before any
config/reader/lifecycle work. Its read-only `bootstrap-status` reports registration,
never write permission; export does not install, trust, load or transfer.

The bootstrap export relies on a trusted local parent directory with no concurrent
namespace mutation. It exclusively claims a new destination (existing empty, populated,
file or symlink targets are left untouched), assembles the payload in a private staging
directory with identity checks, and on a failure before publication removes only the empty
claim and stage it created. This is not an OS filesystem fence: portable Node has no
anchored directory writes or no-replace directory rename, so a same-user process changing
a path between a check and its use can redirect a write or affect publication/cleanup. The
private binding is written last, which reduces but does not prevent that check/use race.

Publication is a rename followed by a final inode check, not a transaction: a failure
during or after publication can return an error after the output directory is visible. A
non-zero export exit is not proof that no files exist; inspect the destination, never
blindly delete it, and do not install or trust the output from a failed export.

## Codex

Codex 0.163.0 loads command hooks only from its user configuration directory.
Wire it with `pappra host install --host codex --scope user --apply`, which merges only
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
network/model/index/session side effects. Command-hook paths with spaces or
Unicode are quoted before being embedded in the host's hook command; no unquoted
path is interpolated into a shell. Plugin registration is
host-specific; never claim a hook is loaded because files were written or a
validator passed.
