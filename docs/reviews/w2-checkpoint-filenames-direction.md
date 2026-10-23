# W2: checkpoint untracked filenames without quoted-path loss

Resume original reliability batch 2 with a bounded filename-capture slice. Repository inventory/coverage semantics remain a separate next slice; no init/knowledge or collaboration changes.

## Problem and implementation boundary

`src/continuity/context.ts`, `snapshotRepository`, currently requests line-delimited porcelain and obtains untracked paths with split-newline / `?? ` / slice. Git quotes Unicode, quotes, tabs and newlines in that format; these serialized names are not the actual filesystem paths, so bodies are skipped/partial and later content edits can escape checkpoint identity.

Use Git's NUL-delimited porcelain path protocol rather than hand-decoding display quoting or disabling core.quotePath globally. Keep the parser local and bounded, handle rename/copy continuation records without treating a secondary pathname as a new status row, and preserve actual whitespace/newline/Unicode characters. Do not trim path strings or mutate Git/user config. Retain existing private/generated exclusions.

Capture the exact supported filename's regular-file body or symlink target text through the current bounded, non-following semantics. Keep F/L kind identity, length-framed untracked payloads, aggregate caps, interrupted capture status and no-side-effect behavior. Unsupported/malformed/truncated evidence must not be promoted to complete. Do not broaden to arbitrary raw non-UTF8 filename support unless required by the existing Node/Git interfaces; report that limit honestly.

## Compatibility and verification

Keep checkpoint/resume public JSON schemas and authority semantics unchanged. Existing private payload bytes/digests must remain readable and verifiable; do not migrate, rewrite or delete stored checkpoints/patches. If new capture representation makes an old digest compare stale, report that accurately rather than inventing old-byte equivalence. Explain the private status-section representation change in the report, preserving the existing length framing. If a real format/schema conflict requires a version decision, report it before introducing another payload format.

Fresh-fixture before/after tests must cover Chinese/non-ASCII filename, embedded quote, tab, newline, ordinary spaces and leading/trailing whitespace where supported. Assert actual body bytes are captured and modifying only the untracked body changes patch identity and resume verification while the filename/status stays unchanged. Include a tracked rename/copy status alongside untracked files to prove continuation fields do not create bogus body paths. Preserve existing symlink-target/no-follow and file-kind transition coverage, capture/aggregate limits, binary payload behavior and read-only resume.

Use a sanitized temporary Git repository, never the real checkout's untracked docs or private state. Meaningful tests belong in existing continuity service/CLI scopes. Changes are limited to continuity context capture and directly needed regressions; shared Git helpers/schema/core workspace resolution remain unchanged unless a concrete need is reported. Existing C0-C12/W1 and coordinator documents must remain preserved.

Run relevant continuity tests, type checking/build and changed formatting/source checks. Do not repeat the full 272-second suite/package checks solely for this localized parser change; a coverage/integration milestone will broaden when justified. Report before/after artifacts, exact supported limits, current combined manifest, input revision and fresh actual new-assignment preflight before first write through one proactive product REPORT/notification.

Same Pi/session/current scope plus an explicitly recorded exact-file continuity-context claim. No global/Git config/dependency/model/native/pane operations, source work before readiness, completion polling/timer, --wait, retry or notification fallback.
