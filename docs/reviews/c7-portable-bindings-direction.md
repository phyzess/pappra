# C7 portable task bindings: implementation direction

Restore task-ID-to-authoritative-record recovery without depending on the private atlas registry. This is a workspace-local pointer index only, not a second authority store. Never copy protocol content, launch/resume a native session, acquire execution ownership or modify a collaboration record.

## Installed CLI

- `pappra collab binding list [--root <workspace>] [--json]`
- `pappra collab binding resolve --task-id <alias> [--root <workspace>] [--roots <abs roots.json>] [--json]`
- `pappra collab binding bind --task-id <alias> --record <abs task.json> [--root <workspace>] [--apply] [--json]`
- `pappra collab binding unbind --task-id <alias> [--root <workspace>] [--apply] [--json]`

Resolve the selected registered workspace using existing workspace resolution/config semantics; default is current cwd's nearest workspace, no home scan or outer-workspace fallback through an incomplete marker. These options are action-specific and strict. Collaboration aliases/protocol task IDs use the existing safe 128-character rule, independently of continuity's 64-character task-pin rule. An alias may differ from the protocol task ID.

Default mutations plan only; `--apply` changes pointer metadata only. Success/usable resolution/clean read/plan exits 0, unusable target/conflict/ambiguity/uncertainty 1, invalid request/options/corrupt index 2. Version JSON results and document concrete plan/bind/resolve/unbind examples, including unrelated cwd with explicit workspace root.

## Local metadata and identity

Store one versioned table at `<workspace>/.pappra/local/collab-bindings.json`, schema `pappra/collaboration-bindings/1`, tied to the selected workspaceId. Keep strict bindings and explicit unbound tombstones. Missing table is a valid empty index; present-but-invalid/unreadable/unsafe table is not empty and must never be overwritten or bypassed.

Each binding pins only alias, supplied/canonical record path, canonical task/domain roots, protocol task ID, domain identity, immutable record created_at and bind time. Pin created_at to detect reinitialization at the same path/task ID. Do not pin state_revision or file inode as immutable task identity: normal transactions replace task.json and increase revision. Do not copy messages, results, claims, transcripts, prompts or runtime cards into the index.

- Bind validates a real authoritative record before persisting and checks its identity again at apply. Filename must be task.json; schema/layout/task/domain/identity must be valid. Do not import an arbitrary native session or silently repair a record.
- Repeating the same target/identity is unchanged/idempotent. An already bound alias cannot be silently rebound to another target, a recreated record or changed identity: report conflict and require explicit unbind first. Equivalent supported canonical aliases may be normalized without creating duplicate targets.
- Unbind removes the pointer and writes a tombstone, even if the target is missing or no longer valid. It does not require reading/mutating the target. Repeated unbind is explicit/idempotent. A later explicit bind can clear its tombstone.
- Preserve corrupt metadata byte-for-byte on refused operations. Handle ordinary keys such as constructor/toString using own-property access, not inherited properties.
- Use existing private-state ownership/atomic publication/locking helpers rather than a new general storage framework. Validate canonical selected-workspace parent paths and identities around async seams; no outside file/directory may be created before detecting a redirect. Refuse final index symlinks/FIFOs/special files without blocking; bound table reads (1 MiB) and entries/output with visible totals/truncation. Serialize concurrent index mutations and reread under the lock so updates are not lost. A busy/stale lock is not reclaimed by age. Do not depend on unaccepted task-pin edits.

## Resolution and explicit discovery

Revalidate targets at read time; show current persisted revision/coordinator epoch/freeze and bounded attempt identities/counts only for a usable target. Report `scope: persisted-history` and `liveStatus: unknown`. A usable pointer never proves a native execution is running/stopped or that a reported result was accepted.

Resolution precedence:

1. Present invalid index: fail, no target/fallback.
2. Explicit binding: exclusive. Missing/malformed/identity-changed target is reported with no usable snapshot and no fallback to another record.
3. Unbound tombstone: suppress discovery, return unbound.
4. Explicit discovery roots, if supplied: read a bounded regular roots.json array of absolute collaboration domain roots (maximum 32); inspect only each `<root>/tasks/<alias>/task.json`, not home/global state or arbitrary directories. Canonical-deduplicate candidates. Exactly one verified candidate resolves; multiple distinct candidates are ambiguous and select none. An unavailable/unreadable root/candidate makes discovery incomplete/unknown rather than a false unique result. Missing task under a valid root is a negative candidate. Never persist discovered targets automatically.
5. No binding/tombstone/roots/candidate: no link, not an invented record or native session.

Do not read/migrate private atlas manifests or home registries automatically. The maintained registry-recovery document and script are semantic migration references only. Existing checkpoint collaborationRecordRef and task pin remain independent; do not repurpose or rewrite them.

## Validation and delivery

Tests use new fixture workspaces/domains only. Cover bind/resolve without refresh; alias differing from protocol ID; normal transaction revisions/inode replacement staying usable; reinitialization/identity drift, missing/malformed targets exposing no usable snapshot; unbind tombstone suppression and rebind; corrupt index refusal with unchanged bytes; canonical candidate dedupe and multi-domain ambiguity; incomplete discovery; concurrent mutations preserving independent aliases; own-property IDs; redirected workspace/private/index/record paths and special/oversize files; plan/list/resolve no writes; strict installed CLI from unrelated cwd; no authority-record changes or native/model launches.

Keep source changes to app/CLI/schema glue, collaboration tests and both shipped collaboration references. Existing source claims cover these directories; preserve excluded reliability edits and coordinator plans/reviews. Same Pi session, actual fresh capability observation, preflight this new pinned assignment before source writes. Run relevant regressions/type checking/build/source policy/changed formatting/mirror/package checks. Return current manifest/pinned input/prewrite evidence via one proactive product REPORT/notification. BLOCK a concrete safety/semantic conflict before broadening scope, inventing a migration or weakening target identity checks.
