# Runtime archival and interrupted archival recovery

`runtime archive` is the explicit retirement path for a corrupt, incompatible,
legacy or abandoned runtime. It preserves evidence rather than trying to repair
or migrate it. `runtime remove` and `runtime gc` retain their existing
integrity requirements; neither silently falls back to archival.

## Running it

Use a working current CLI outside the runtime being retired. The command
refuses to archive the package it is currently executing from, even with force
policies. Always select an exact version; this command never infers one from
the current workspace binding.

```sh
# read-only preview
node /path/to/other/pappra/dist/cli/main.js runtime archive \
  --runtime-version 0.1.0-beta.19 --json

# explicit apply with an audit reason
node /path/to/other/pappra/dist/cli/main.js runtime archive \
  --runtime-version 0.1.0-beta.19 --apply --force \
  --reason "Retire abandoned beta runtime after checking affected workspaces" --json
```

Without `--apply`, both text and JSON output describe the source paths,
selected journals and staging, unselected unreadable journals and policy
blockers. JSON also contains the current lock observation and detailed
registered references. Preview creates no directory, lock, receipt or registry
entry. JSON preview returns exit 0 with `status: planned` even when `blockers`
is nonempty; it is an inspection result, not authorization or proof of
eligibility. An unsafe path or unreadable archive receipt is a failure.

Apply returns exit 0 for `archived` or `missing`, and exit 1 for blocked or
failed operations. Invalid CLI arguments return exit 2; invalid target
identities are also rejected before any evidence move. Errors can leave a
prepared transaction for the next explicit recovery attempt; normal runtime
mutators keep respecting that fence.

## What blocks archival

No home-directory discovery occurs. The registry covers only explicitly
registered workspaces, so unregistered coverage remains unknown even if every
registry entry is readable and no binding is found. `--force` records
acceptance of that uncertainty. Missing, replaced, unreadable and incompatible
registry entries remain visible as unknown; they are never classified as idle.

Verified bindings in the registry and the current workspace always block
archival, including bindings reached through a data-directory alias when
corruption has removed the executable or its parent directories. Rebind
affected workspaces first. A verified live lock owner also always blocks;
neither `--force` nor `--all-writers-stopped` overrides positive evidence of
use. The archive checks references again under its reservation and before each
move.

A PID-only lock whose process exists, malformed lock, imported process
identity or unavailable process observation is unknown, rather than proof of
death. To archive such a runtime lock, stop every affected writer and also
pass `--all-writers-stopped`. This is a recorded operator assertion; the
command does not stop a process, approve a request, infer cancellation or
adopt a session. A positively dead original runtime lock needs no
stopped-writers assertion. Its raw bytes are retained in either case.

## Scope and raw evidence

The destination is under the same selected Pappra data directory:

```text
runtime-archives/<version>/
  archive.lock                 # exclusive archive reservation, only while running
  pending.json                 # durable transaction fence / last completion
  <archive-id>/
    runtime/                   # original version path, renamed intact
    journals/<install-id>.json # selected original journal bytes
    staging/<install-id>/      # corresponding original staging, when present
    original.lock              # original runtime lock, when present
    receipt.json               # permanent completion audit
```

Valid installation journals are selected only when their operation, exact
version, target path and filename UUID match this runtime. Associated staging
paths are derived locally from that UUID; paths inside the journal are never
executed or followed as instructions. This includes completed matching
journals so their original evidence stays with the runtime.

An unreadable or legacy journal cannot safely identify its version. Preview
lists it under `unselectedJournals`; unrelated evidence stays in place. The
operator may add repeated `--install-id <uuid>` options to explicitly select
such journal filenames and the staging directories with those same UUIDs. A
valid journal positively belonging to another runtime or operation is rejected
even when explicitly selected. Non-UUID filenames are retained. Remaining
unrelated bad journals can still block installation under the existing
fail-closed journal scan; archival does not claim that the entire data
directory is repaired.

The archive uses same-filesystem renames, retaining the original inodes,
binary bytes and internal symlinks without following those symlinks. It does
not load an installed executable, rewrite a manifest, clear a machine binding
or change the reference registry. No automatic purge or automatic restoration
is provided. Archive directories and receipts are created privately; original
evidence keeps its existing permissions.

The receipt records the original reason and timestamp, exact selected paths,
device/inode identities, file sizes and modification times, content digests
for control files up to 1 MiB, observed references and lock ownership, and
explicit uncertainty/stopped-writer policies. Large files and directory
contents are moved intact without a recursive content-hash assertion. The
receipt is a local audit record, not a signature or proof against a same-user
administrator modifying it.

## Doctor visibility

`pappra doctor` inspects the archive transaction for the workspace's current
runtime version without archiving, reclaiming a lock or stopping a process.
Its `runtime.archive` check distinguishes no transaction (`ok`), a completed
archive (`ok`, with a retention note), a verified live coordinator
(`partial`, wait for it), a prepared or unfenced transaction whose coordinator
is dead or absent (`warning`, with the exact resume command), unknown
coordinator ownership (`warning`; unverified ownership is preserved and blocks
another archive), and inconsistent evidence, a conflicting receipt or an
unsafe move (`warning` or `error`; resume refuses ambiguous identity and
doctor preserves it).

The resume action is
`pappra runtime archive --runtime-version <v> --apply --force --reason <text>`,
adding `--all-writers-stopped` only when runtime lock ownership is unknown.
Doctor reports the receipt item counts and never moves, deletes or rewrites
evidence. It verifies item presence, the pending fence, the permanent receipt
and lock ownership; it does not recompute evidence content digests or prove
that the archived runtime was callable.

## Recovery and boundaries

The prepared receipt is written and fsynced before the first evidence move.
Renames and receipt publication sync their containing directories. An existing
runtime lock is retained as the normal mutation fence until it is moved last;
when no original lock exists, the archive publishes its own install-lock
fence. Installation, removal/GC, reference publication and repair also reject
a pending, unreadable or actively reserved archive for the same version.

After interruption, preview and rerun the same command with `--apply --force`
and a reason, adding `--all-writers-stopped` if ownership remains unknown.
Recovery uses the original transaction ID, selection, reason and
identity-pinned moves; it does not create a second archive for that pending
operation. A positively dead archive coordinator lock and an interrupted
generated install-lock fence can be reclaimed. Live or unverified archive
coordinator ownership is preserved and blocks another coordinator. Nothing is
reclaimed by age.

Each move must have exactly one original inode at the expected source or
archive destination. Missing evidence, a new source owner, conflicting
destination, redirected namespace or corrupt/conflicting receipt stops
recovery with a nonzero exit and preserves the observed paths. The permanent
receipt is published without clobbering an existing file; a crash between it
and completion of `pending.json` reuses that exact receipt. Failed or partial
operations are never reported archived. An unchanged completed operation
repeats idempotently. A later runtime installation of the same version, or
explicitly selected new orphan journals, starts a new archive ID and retains
previous bundles.

Inventory is bounded to 4096 journal entries and 256 explicitly supplied IDs;
the durable receipt must fit the 1 MiB recovery read limit. Archive control
and source parents must be real directories. Same-filesystem rename is
required; there is no copy-and-delete fallback across mounted filesystems.
Path and inode checks defend against observed replacements; they are not an
OS isolation boundary against a hostile process with the same filesystem
permissions.

Process-crash recovery is exercised with real `SIGKILL` at preparation,
runtime, journal, staging and original-lock moves, permanent-receipt
publication and final completion, followed by recovery through the actual
built CLI. Power-loss and filesystem durability beyond the platform's
`fsync`/rename guarantees are not claimed. Tests use fresh temporary
directories with an isolated `PAPPRA_DATA_HOME`; no user runtime, global host
configuration or real coding session is part of those fixtures.
