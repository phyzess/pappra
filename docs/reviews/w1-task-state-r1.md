# W1 task-state reliability: review round 1

Verdict: changes requested. The announced REPORT, task/native/reply/attempt/epoch, assignment/input, all output/readiness/log digests and 75-file current manifest independently verify. The original controlled pin-read/removal gaps are improved, but two configuration-update seams still violate the pinned contract.

Independent type checking, test compilation and 46 task/continuity/CLI regressions passed. Those tests do not yet cover the two reproduced seams below.

Independent fresh-fixture reproducer: `/tmp/pappra-w1-review.mjs`, using the current built app and process-local fs/promises hooks. No live workspace/task or native operation is involved.

## R1: concurrent user config edit is overwritten after backup (P1)

In `setAutoResume`, the current configuration is checked under the lock, then backup mkdir/write and other awaited checks occur before `writeTaskStateFile` replaces workspace.json. The publication helper checks private directory stability and output bytes, but never checks that the expected configuration generation is still current immediately before replacement.

The reproducer completes the fixture backup write, then changes only the valid workspace `name` to `concurrent-user-edit` before returning from that await. `setAutoResume(root, true)` reports `{ok:true}`, and the final config name is `original`: the user's edit was lost. The normal workspace lock does not protect against an editor or other actor that does not participate in that lock.

Retain the expected current config identity/digest through awaited backup/temp publication work and refuse a changed generation before replacing the config. Preserve the user's actual bytes on refusal, retain safe backup/evidence and release only the held lock when safe. Include a deterministic regression after backup and during the pre-publication/temp seam. No OS-level atomic compare-and-swap guarantee is requested; document the remaining final-syscall cooperative limit.

## R2: nested backup-parent redirect writes outside before refusal (P1)

`namespaceSnapshot` pins workspace/.pappra/local identities, but not nested backup ancestors. After `mkdir(dirname(backup))`, `assertSnapshot` checks only those top-level directories. `writeFile(backup, ...)` can therefore follow a changed `backups` child before `verifyEntry` detects it.

The reproducer completes the fixture backup-directory mkdir, redirects only `.pappra/local/backups` to a separate temporary directory with the matching nested parent already present, and returns from mkdir. `setAutoResume` writes that outside `workspace.json`, then returns `Task state entry resolves outside the pinned private directory`. `outsideBackupCreated` is true. This is an observable awaited seam before write, not the acknowledged last check-to-syscall window.

Revalidate the actual nested backup parent/canonical path after awaited creation and before writing or later cleanup. Refuse the redirect before outside file creation, preserving outside bytes/files and the user's config. Use the existing local boundary/identity primitives as appropriate; do not add a general filesystem framework or harden unrelated accepted helpers. Add a deterministic no-outside-write regression at this exact seam.

## Scope and delivery

Only these two setAutoResume publication/backup corrections and meaningful task-state regressions. Preserve the accepted pin/read/unpin/ID behavior, separate collaboration ID contract, current APIs, C0-C12, coordinator documents and unrelated changes. Same Pi/session/current claims; actual fresh new-assignment preflight before the first source/trial/format edit.

Run focused task/config/CLI tests and type checking/build as needed. Do not repeat the just-reported full 272-second suite/package checks unless changes or failures justify it; a later integration milestone can broaden verification. Return before/after results for the pinned reproductions, current manifest/input/readiness and actual validations through one proactive product REPORT/notification, with no polling/timer/--wait/native fallback.
