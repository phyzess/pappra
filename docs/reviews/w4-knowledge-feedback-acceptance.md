# W4 acceptance: knowledge scan coverage and visibility feedback

Accepted within the pinned W4 scope, including repair R1. Original and repair delivery/correlation/input/output digests were verified, along with the current combined 81-file manifest. Repair changes only scan deduplication and its service regression test; the other 79 files match its baseline.

Scan now retains discovery/catalog/registration diagnostics and explicit truncated-coverage feedback. Incomplete scans return failure in plan/apply/CLI/MCP while reporting independently successful registrations accurately. Invalid catalog/config does not become an empty successful deduplication set or replace catalog data. Human output includes diagnostics and next actions; private registration/list guidance retains default privacy and machine-output contracts.

Independent original missing-source/truncation/invalid-catalog probes and 58 focused CLI/knowledge/MCP tests passed before repair. After repair, independent test compilation, 43 knowledge service/CLI tests and type checking passed. The original archived-location reproducer now returns zero candidates/registrations for unchanged and changed archived files, succeeds without registration conflicts and preserves the record. The regression covers private/shareable archived records and non-default metadata. User-facing list filtering remains unchanged.

Fresh receiver observation at `2026-10-21T16:13:49Z`, coordinator repair preflight at `16:15:29.016Z`, and receiver preflight at `16:16:01.114Z` are separately pinned evidence, not acceptance substitutes. Full-suite/package checks were not repeated for the two-file repair. This accepts batch 3; init configuration/interaction work remains pending.
