# W4: truthful knowledge scan coverage and private-document feedback

Resume original batch 3 before reshaping init. Two concrete issues remain: `scanDiscoveredDocuments` drops workspace discovery diagnostics/truncation, and scan/list feedback can make newly registered private documents appear to have vanished. Improve the observable workflow without changing privacy defaults, catalog identity/lifecycle or source/destination configuration semantics.

## Scan contract

Preserve `pappra/docs-scan/1` and its existing fields. Carry discovery plus catalog/registration diagnostics into both plan and apply results. An invalid config/catalog is not an empty successful scan. Discovery errors or truncated coverage must not be reported as a complete successful scan: use existing `ok`, diagnostics and nextActions to describe incomplete results, and make CLI plan/apply exit nonzero for that outcome. Keep ordinary warnings separate from fatal errors; a concrete truncation needs an explicit coverage message even if the discovery diagnostic is only a warning.

Plan remains read-only. With explicit --apply, independently valid observed candidates may still be registered from a partial scan, but the result must state that coverage was incomplete, count actual registration successes accurately and retain actionable next steps. Do not claim a complete scan merely because those individual registrations succeeded. If the catalog/config is unusable, refuse registration rather than replacing it or using an empty deduplication set.

Human output must print plan diagnostics as well as apply diagnostics, distinguish zero candidates from incomplete discovery, and show relevant next actions. Preserve diagnostic details without printing document bodies or private evidence. MCP docs_scan uses the same result/meaning; do not add a separate behavior or silently strip failures.

Keep selection bounded by the current configured knowledge sources. Do not broaden scans, add global/home discovery or command execution, expose new scanner settings or rewrite discovery semantics. Current source file-vs-directory and symlink/exclusion boundaries remain in force. A missing source, unreadable source or limit must remain visible; no automatic path correction.

## Visibility and user feedback

Registration retains the current configured private/shareable policy exactly; private remains the default. Do not migrate existing records, unarchive, change ownership/maturity, flip visibility, move files or deduplicate by replacing records. Repeated scans must be safe/idempotent, including already registered private and archived locations.

After scan, tell users how to view the private documents they registered (`pappra docs list --include-private`); use existing nextActions for machine output and concise human feedback. Default docs list must remain private-filtered. Add a clear empty/default-view hint that private documents are hidden and show the exact command to include them, without issuing an extra private-catalog query or adding unapproved JSON fields. Keep --include-archived distinctions honest. JSON stdout remains one machine-readable result, with no human copy interleaved.

Document the distinction between configured knowledge sources (existing documents to discover/register) and newDocuments (destination for future authored documents) where it directly affects this scan/list help. Do not implement the init wizard redesign here. Correct scan's omission from existing docs help metadata and the global docs family if touched; no unrelated command/help cleanup.

## Validation and scope

Fresh fixtures: a valid source registers private docs visible with --include-private and hidden by default with a helpful hint; a valid+missing source produces actionable diagnostics/nonzero in plan and partial apply without changing visibility; a deterministic existing discovery limit produces explicit truncated coverage; invalid catalog/config preserved with no registration; plan preserves catalog/tree bytes; repeated/private/archived scans do not mutate existing records. Validate existing JSON schemas and MCP result behavior, including diagnostics on failure. Do not add tests that only mirror exact prose strings.

Changes are limited to `src/knowledge/scan.ts`, docs CLI/help output, directly related shipped reference copy and existing knowledge/CLI/MCP tests. Existing CLI/skill/MCP scopes plus exact scan and knowledge-test extensions govern writes. Keep knowledge storage/schema, workspace discovery, init, continuity and collaboration behavior unchanged unless a concrete necessary conflict is reported before broadening scope.

Use coordinator-pinned pre-dispatch readiness for this new assignment against actual fresh receiver evidence. Verify the matching input/card/ready and runtime before first write; refresh/preflight only if stale or changed. Run focused knowledge/CLI/MCP tests, typecheck/build/format/source/mirror checks proportionately; do not repeat the full 273-second suite/package checks for a small feedback slice without cause. Return current manifest/input/readiness, before/after scan/list behavior and actual tests through one proactive product REPORT/notify. Same Pi/session; no real workspace/catalog/native/model/pane/global/dependency actions, polling/timers/--wait/fallback.
