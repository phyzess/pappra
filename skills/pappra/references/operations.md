# Operations reference

- `pappra init` plans or applies workspace configuration. `--yes` derives
  selections from discovery, `--print-choices` prints that document without
  writing, `--reconfigure` rebuilds an existing valid `workspace.json`, and
  `--no-runtime` leaves the durable runtime action pending.
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
- `pappra collab <prepare|run|query>` runs one bounded collaboration request.
  `run` requires `--controller fixture|pi-rpc`; `pi-rpc` launches a real Pi RPC
  session.

Preserve user bytes. If an operation reports a conflict or residual path,
inspect that path and resolve ownership before retrying. Never delete an
unknown file to make a retry succeed.
