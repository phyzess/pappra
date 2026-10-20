# Support and limitations

## Supported baseline

- Node.js 24+; development and package checks use Node.js 24.20.0.
- pnpm 12.3.4 with the lockfile committed in this repository.
- macOS is the primary local test environment. CI declares Ubuntu and macOS
  Node 24/26 coverage; this source snapshot does not claim that every native
  host or external engine has been exercised on every platform.
- Git is required for repository identity operations, not for importing the core
  TypeScript API.

## Optional dependencies

The following are optional and must be selected explicitly:

- Pi, Codex and Claude Code host integrations and their native CLIs. Observed plugin-hook
  behavior per host and version is recorded in `docs/host-plugin-validation.md`.
- A code-graph engine for graph preparation/query. Without it, use bounded text
  or structure queries and expect partial/fallback coverage.
- A collaboration controller. `pappra collab run` requires
  `--controller <fixture|pi-rpc>`; no controller is implicit. The `pi-rpc` path is verified
  against Pi 1.3.0 (see `docs/pi-rpc.md`).
- A local runtime source for `pappra runtime install --from tarball` (or an exact
  version); installation is local and explicit.

Pappra core does not require a private repository, external host, model provider
or global agent configuration.

## Evidence limits

Deterministic tests and fixtures do not prove:

- real-model or provider behavior;
- native host loader, trust, reload or callability on a user machine;
- complete semantic coverage from a code-graph engine;
- Windows/Linux/remote-CI behavior for every path;
- production performance, cost or availability.

A passing check, an installed binary, or a host being present on `PATH` is not
by itself proof that a live integration will work.

`doctor` observes host manifests in the private default host root, project
`.claude`/`.codex`/`.pi` directories and `$CODEX_HOME`. A Pi package installed with
`pi install` has no manifest in those locations, so only a real session proves it.

## Reporting a problem

Include the Pappra version, Node/pnpm versions, command, exit status, whether the
workspace is synthetic, and the relevant diagnostic code. Do not attach private
session transcripts, credentials, company configuration or unrelated user files.
Use a synthetic reproduction where possible.
