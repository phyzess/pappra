# Operations reference

- `pappra onboard` plans or applies a whole workspace setup (config, durable runtime,
  verified host wiring). `--dry-run` writes nothing; `--apply-host` still leaves host trust
  to the person.
- `pappra init` plans or applies workspace configuration. `--yes` derives
  selections from discovery, `--print-choices` prints that document without
  writing, `--config` reads a `pappra/init-choices/1` document, and
  `--reconfigure` is the explicit opt-in that rewrites an existing valid
  `workspace.json` from the current selections while keeping its identity,
  extensions, continuity, custom validation bindings and local machine
  settings. Without `--reconfigure` an existing valid configuration is reused
  and only missing local state is requested. With that existing workspace,
  `--yes --reconfigure` keeps the current represented choices instead of
  deriving new ones and `--print-choices --reconfigure` prints them.
  A plain `--apply` verifies/reuses a runtime for the workspace target or
  installs the current package and binds it. `--no-runtime` suppresses runtime
  verification, installation and binding: when an action is still required the
  result is `status:"external-actions-pending"` with a nonzero exit, while an
  already bound matching runtime with no file changes yields apply status
  `no-changes` and exit 0 with `initComplete:false`.
  A TTY wizard opens only when selections are needed; `--config` without
  `--apply` stays preview-only, an empty plan asks nothing, and the single
  apply confirmation belongs to the interactive no-`--apply` flow that plans
  configuration writes. `--apply` itself never prompts.
  `knowledge.sources` are existing documents registered later by
  `docs scan --apply`, while `knowledge.newDocuments` is only the destination
  for future authored documents and is not created by init.
- `pappra runtime <install|status|verify|remove>` manages the durable runtime
  copy. `install --apply` defaults to `--from self`; writes require `--apply`.
- `pappra doctor` is passive: it does not install hooks, start hosts, or fix
  state. `runtime verify` is the active runtime check.
- `pappra checkpoint` writes a task checkpoint; `pappra resume` reads a stored
  snapshot and reports whether execution is allowed.
- `pappra docs <list|check|archive|scan>` manages the knowledge catalog.
  `scan --apply` registers documents found under the configured sources.
- `pappra code` operates on an explicitly selected repository and keeps index
  mutations behind an explicit `--apply`.
- `pappra host <detect|describe|plan|install|verify|bundle>` wires an optional
  host. Codex 0.163.0 loads hooks only from `$CODEX_HOME/hooks.json`, so use
  `install --host codex --scope user`; `bundle --marketplace` exports a plugin
  directory without registering it, and `install --mode plugin` fails closed.
- `pappra mcp` starts the stdio MCP server; `pappra host mcp install --host <name> --apply`
  registers it. `pappra task pin <id> --auto-resume` controls hook resume injection.
- `pappra collab prepare --goal <file> --domain-root <dir>` and MCP
  `collab_prepare` share the strict explicit goal; MCP accepts only
  `{domainRoot, goal}`, not the retired flat objective fields, and synthesizes no card.
  Preparation maps `pi`/`codex`/`claude` to `pi-cli`/`codex-exec`/`claude-cli`;
  real controllers remain `fixture|pi-rpc` with `pi-rpc` only for Pi. `collab_start`
  still requires confirmation and runtime evidence.
- `pappra collab message <send|list|read|notify> --task-root <dir>` persists
  protocol messages, reads them back, and sends one explicit pointer-only Herdr
  notification. `send` and `notify` are plan-only without `--apply`; notification
  is not consumption or acceptance. See `references/collaboration.md`.

Preserve user bytes. If an operation reports a conflict or residual path,
inspect that path and resolve ownership before retrying. Never delete an
unknown file to make a retry succeed.
