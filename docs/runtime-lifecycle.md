# Runtime identity, references and garbage collection

A durable runtime copy is identified by its manifest, protected by an explicit
reference registry, and retired only through review. This page covers the
three pieces: what the manifest pins, how workspaces are registered as
references, and how removal and GC decide what may be deleted.

## Manifest identity and the source fingerprint

Runtime manifest `/3` records both the installed package integrity digest and
a deterministic `sourceFingerprint`. The fingerprint covers the packed payload
entries plus resolved dependency package-manifest identities and their edges;
it contains no source-root absolute paths. All installation sources record it.

An existing installation can be reused by `--from self` when those
fingerprints match. A rebuilt self payload or changed resolved dependency
identity under the same version is refused **before executing** the old
runtime. Bump the package version instead of overwriting a potentially shared
version. Older beta manifests are preserved as incompatible; no migration is
performed.

## Binding registers a reference

Binding a runtime registers the workspace under the explicit data directory's
`runtime-references/`. Each private record pins its canonical workspace root,
workspace UUID and root directory identity. Registration happens before
writing `machine.json`, while holding the same per-version lock used by
installation and removal. A process interrupted before binding cannot silently
create an untracked binding; its retained lock is an explicit repair
condition. Repeated unchanged bindings retain the same reference file.

```sh
pappra runtime remove --runtime-version <version> --json       # read-only plan
pappra runtime gc --json                                       # read-only plan
pappra runtime gc --runtime-version <version> --apply --force  # reviewed cleanup
```

## Coverage is registered-only

Reference inspection reads only registered roots and revalidates their current
workspace and machine binding. It never searches the user's home directory. A
missing, moved, replaced, unreadable or malformed registered workspace remains
unknown; a missing registry or caller-supplied `activeReferences: []` is not
proof that a runtime is unused. Coverage is always reported as
`registered-workspaces-only`, with unregistered coverage `unknown`.

Consequently, removal requires explicit `--force` to accept unknown coverage.
That policy never bypasses a verified current workspace reference: a bound
version is retained even with `--force`. Rebind the workspace first. GC
examines only bounded version directories under the selected data directory;
application rechecks references under the version lock and removes only a
complete verified runtime. Corrupt, incompatible, locked or interrupted
versions are not silently deleted. Plans do not execute runtime programs or
remove anything.

## What the registry cannot prove

The registry tracks workspace bindings, not every live process. A hand-edited
unregistered binding or a process still using an old version after rebinding
cannot be proven absent. Accepting unknown coverage is an operator decision;
it is never inferred from age, a missing row or an empty list.
