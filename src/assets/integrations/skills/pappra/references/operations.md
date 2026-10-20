# Operations reference

- `pappra init` plans or applies workspace configuration.
- `pappra doctor` is passive: it does not install hooks, start hosts, or fix
  state.
- `pappra checkpoint` writes a task checkpoint; `pappra resume` reads a
  stored snapshot and reports whether execution is allowed.
- `pappra docs` manages knowledge documents.
- `pappra code` operates on an explicitly selected repository and keeps
  index mutations behind an explicit `--apply`.

Preserve user bytes. If an operation reports a conflict or residual path,
inspect that path and resolve ownership before retrying. Never delete an
unknown file to make a retry succeed.
