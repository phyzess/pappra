# Host surfaces

## Pi

The integration installs a project extension plus a copied `pappra` skill.
Pi extensions run with host permissions. Load only a trusted copy from this
workspace/target; the generated entrypoint imports the fixed Pappra runtime by
absolute file URL and registers lifecycle handlers only.

## Codex

The integration installs a command-hook entry and merges only Pappra-owned
entries into `hooks.json`. Existing hooks and unrelated keys are preserved.
Codex hook definitions are trusted individually; installation is not trust.
Observed 0.163.0 hook keys do not include a compact event, so compact and
automatic checkpoint requests remain unsupported.

## Claude Code

The integration installs a command-hook entry and merges only Pappra-owned
entries into `settings.json`. `SessionStart` and `PostCompact` are distinct;
matchers, trust, timeout, and output behavior remain host/version-specific.
Installing a command is not proof it ran.

## Common safety

All surfaces use the event's canonical cwd/root, bounded stdin, a one-second
local deadline, no transcript reads, no arbitrary configured commands, and no
network/model/index/session side effects. Paths with spaces or Unicode are
passed as argv/file URLs, never interpolated into a shell.
