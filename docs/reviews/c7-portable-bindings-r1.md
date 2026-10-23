# C7 portable bindings: review round 1

Verdict: changes requested. The correlated REPORT, assignment/input digests and current 50-file manifest were verified. Independent type checking, test compilation and all six binding CLI tests passed. The following fixture-only probes demonstrate gaps not covered by that selection.

Reproducer: `/tmp/pappra-c7-repros.mjs`; saved output: `/tmp/pappra-c7-independent-repros.jsonl`. It imports compiled fixture helpers and runs the installed CLI against newly created workspaces/domains. No live workspace index or collaboration authority record was changed.

## R1: publication can make the entire index unreadable (P1)

`src/app/collab-bindings.ts`, `writeIndex`: reads enforce 1 MiB, but publication does not enforce that bound. A valid 1,048,465-byte index of ordinary unbound tombstones resolves successfully. Adding one binding reports `bound`, `applied: true`, exit 0 and publishes 1,049,232 bytes. The immediately following resolve returns `bindings_invalid`, exit 2. All aliases and future mutations are blocked by a file the product itself published.

Validate the exact serialized bytes against the reader's limit before atomic publication for both bind and unbind. Refuse with an actionable bounded-capacity result, preserving the previous bytes and all tombstones. Do not truncate/drop pointers or tombstones, increase the limit, or add an automatic cleanup/migration. Add boundary regressions covering both mutation paths and subsequent readability.

## R2: contradictory binding and tombstone are treated as usable (P2)

`parseIndex`: a table containing the same alias in both `bindings` and `unbound` passes validation. Resolve selects its binding and reports `usable: true`, bypassing the explicitly recorded suppression. This is contradictory metadata rather than a supported precedence rule.

Reject overlapping aliases as `bindings_invalid`. List, resolve and both mutations must preserve those bytes and avoid discovery fallback, with own-property aliases handled correctly. A normal explicit rebind may still atomically remove a valid tombstone.

## R3: a new alias can silently adopt a changed task incarnation (P2)

`bindAlias`: initial inspection records `targetIdentity`, but under the index lock the fresh identity is compared only with an already existing binding. A previously unbound alias never compares its initial and fresh target identities.

The deterministic process-local probe intercepts the first dedicated binding-lock `open` after initial inspection and changes only the fixture record's immutable `created_at`. Applying a new alias still returns `bound`, `applied: true` and persists the replacement incarnation. This is a controlled async-seam test, not a claim of OS-level filesystem fencing.

Compare the original immutable target identity with the fresh inspection before any publication, including a new alias. Refuse identity drift without writing the index. Ordinary revision changes and atomic inode replacement must remain accepted. Add a deterministic regression for that distinction; no production fault-injection interface or broader transaction framework is needed.

## Repair scope and delivery

Only these consistency corrections, meaningful focused tests and necessary reference updates are requested. Preserve accepted C0-C6 behavior, dedicated pointer-store locking, source exclusions and coordinator documents. No native control, authority changes, live binding migration, automatic retry or init work.

Use the same Pi session and current source claims. Preflight the new pinned repair assignment using actual fresh evidence before source writes. Return a current manifest, pinned input revision, validation and prewrite evidence through one proactive product REPORT/notification.
