# Distribution and installation guide

Status: current. This page describes how Pappra is published, installed and kept
usable. Earlier planning notes were process records; the behaviour below matches the
current CLI and release workflow.

## Published package

| item | value |
| --- | --- |
| package | `@phyzess/pappra` |
| binary | `pappra` |
| Node floor | `>=24` |
| release tags | `beta` (moving) and exact versions such as `0.1.0-beta.22` |
| registry | public npm, via GitHub Actions trusted publishing (OIDC) |

Pre-release versions are never republished. Pin either `@beta` or an exact version.
The repository stores no npm token; the publish job exchanges a short-lived OIDC
identity for publish rights.

This checkout is beta.22. A version bump in source is not a publication: verify
the registry version and the trusted publishing workflow separately. The frozen
beta.20 public tarball used for the measurements below was checked against the
reviewed candidate, including every shipped file, after trusted publication.

## Measured beta.21 development decisions

The October 26, 2026 measurements used the frozen, installed public beta.20
package on macOS arm64, Node 24.20.0 and esbuild 0.28.2. Independent native Pappra
tasks produced the implementation and measurements; a separate participant
reviewed their exact output pins and independently reproduced the build result.
The observations below are local measurements,
not platform-wide guarantees.

| experiment | baseline | candidate | decision |
| --- | --- | --- | --- |
| Host asset script, nine interleaved samples per variant | 257.53 ms median | 224.97 ms median | Run the five independent builds concurrently with shared options. |
| Dependency copy, first three pairs | 2,183.61 ms median | 2,281.20 ms median with `COPYFILE_FICLONE` | No reproducible gain. |
| Dependency copy, five confirmation pairs | 2,286.01 ms median | 2,138.19 ms median with `COPYFILE_FICLONE` | Direction reversed; retain the existing copier. |

The host timing covers execution of the asset script, including process startup,
asset copying and CLI chmod. It excludes TypeScript compilation, tests and the
rest of `pnpm build`. The paired median saving was 30.89 ms. All nine candidate
samples emitted exactly the same five standalone bundles as the baseline and
published beta.20, byte for byte: 3,198,573 bytes in total. Shared chunks and Zod
externalization were not introduced; duplicate Zod payloads remain a limitation.

Dependency timings cover direct materialization, including manifest resolution
and payload filtering; inventory hashing and cleanup are outside the timed
region. The clone probe won four of eight pairs, with overlapping ranges and
uncontrolled filesystem cache/background load. It changed only the probe
process's copy mode, not the production copier. Successful copies do not prove
that the filesystem cloned extents or that fallback on another filesystem was
observed. Logical bytes are not physical allocation. Regression checks require
independent source/destination inodes, bidirectional mutation isolation and
preservation of an already-existing destination.

## Three ways to run it

```sh
# one-shot, version-pinned, no durable install
npx @phyzess/pappra@beta init --yes --apply --json

# daily use: global install, then plain `pappra`
npm install -g @phyzess/pappra@beta

# from a checkout (development)
pnpm install --frozen-lockfile && pnpm build
node /absolute/path/to/checkout/dist/cli/main.js doctor --json
```

A global install and an `npx` invocation are not equivalent:

- `npx` materialises the package in a disposable cache directory. Anything long-lived
  (host hooks, service shims) must not point into that cache.
- `init --apply` and `onboard --yes` install and bind a durable runtime copy under the
  Pappra data directory, which is what makes an `npx` bootstrap survive cache eviction.
- A checkout run uses the checkout's own build. It does not need a runtime copy, and it
  does not prove the published package behaves the same way.

## Durable runtime

```sh
pappra runtime install --apply [--from self|tarball|registry]
pappra runtime status --json
pappra runtime verify --json
pappra runtime remove --apply
pappra runtime archive --runtime-version <v> --json
```

- `install --from self` packs the executing package and installs it through the
  journaled, verified publish path.
- `status` is passive. `verify` reads the manifest, package contents, executable and
  smoke check.
- Content hashes use UTF-8 byte ordering, independent of the system locale, and the
  manifest records `digestScheme: sha256-utf8-byte-order-v1`. A manifest with a
  different or missing scheme is reported as incompatible rather than corrupt.
- Verification never rewrites a manifest to adopt an unexpected digest, and never
  silently reinstalls.
- Removal refuses unknown cross-workspace references. `--force` is an explicit operator
  override after checking other workspaces; `archive` is the evidence-preserving exit for
  corrupt, legacy or abandoned state.

Archive apply requires an explicit `--force --reason <text>` after preview;
unknown lock ownership also requires `--all-writers-stopped`. Neither assertion
overrides a verified binding or live lock. See [runtime archive](runtime-archive.md)
for the complete recovery command and preserved evidence.

Old beta state is not migrated. The supported exit is `init --reconfigure --apply` for
current state, or an explicit archival reset that keeps the old bytes under
`.pappra/local-archive/`.

## Host wiring

Host integration is optional and always ends with a host-side action:

```sh
pappra host detect --json
pappra host plan --host claude|codex|pi --json
pappra host install --host <name> --apply
pappra host verify --host <name> --json
pappra host bundle --host <name> --out <dir> [--marketplace] --json
```

- Hooks are copied as a dependency-free bundle into the host root. Claude Code commands
  use `${CLAUDE_PROJECT_DIR}`; Pi imports its runtime relatively. Neither depends on the
  package checkout or the npx cache.
- `pappra-host.json` records the bundle digest, hook expression and installed files.
  Verification compares packaged and installed digests, skips the shared settings file's
  whole-file digest, and checks the expected hook entries structurally.
- Codex loads lifecycle hooks only from its user configuration directory at the pinned
  version. Wire it with `--scope user` and approve the hook once in Codex; project
  `.codex/hooks.json` and plugin bundles are not loaded there.
- `host bundle --marketplace` exports a directory; it does not register, trust or enable
  anything. Per-host registration commands are printed and remain the operator's step.
- Uninstall previews by default; `--apply` removes only owned files and leaves user bytes,
  formatting and permissions untouched.

See [host plugin validation](host-plugin-validation.md) for what was actually observed per
host version, and [support and limitations](support.md) for the evidence boundary.

## Release process

`.github/workflows/publish.yml` runs on `v*` tags:

1. Assert the release commit is an ancestor of `origin/main`
   (`git merge-base --is-ancestor HEAD origin/main`).
2. Install, then run `pnpm check` in the check job.
3. Assert the tag equals the `package.json` version.
4. Pack the checked build and publish it with `id-token: write`.

`id-token: write` is confined to the publish job; the test job has read-only contents
access. Third-party actions are pinned to commit SHAs. A tag that does not match the
package version, or that is not on `main`, fails before publishing.

## Constraints worth knowing before promising an install

- The npx cache is disposable; never let a hook or service point into it.
- npm's install-script policy gates lifecycle scripts for non-registry dependencies.
  Registry tarballs are the reliable path; git installs may need explicit script approval
  and are not the documented default.
- A machine behind an internal registry mirror may resolve a different package than public
  npm. Verify a just-published version against public npm explicitly rather than assuming
  the mirror caught up.
- Reinstalling or rebuilding Pappra never updates an already-running host process. Host
  reload and trust are host-owned steps.
- No distribution step starts a model, indexes a repository, or answers an approval.

## What this guide does not claim

An installed binary, a valid manifest and a verified bundle digest together prove file
wiring. They do not prove that a native host loads the hook, that a provider request
succeeds, or that a published package behaves identically on another platform. Those
claims need their own current evidence.
