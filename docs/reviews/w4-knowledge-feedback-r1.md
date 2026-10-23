# W4 independent review: archived locations still enter scan candidates

Verdict: changes remain unaccepted pending one bounded correction. Delivery, correlation, all output digests, pinned assignment/input/direction and the current 81-file combined source manifest were independently verified. Missing-source, truncated-coverage and invalid-catalog probes reproduce the intended fixes. Private visibility remains unchanged.

## Finding

`src/knowledge/scan.ts` loads its deduplication set through `service.list({ includePrivate: true })`. The default excludes archived records. An already registered archived location is therefore presented as a new scan candidate. With unchanged content, registration returns the existing archived record successfully and scan reports `Registered 1 document(s)` although no registration occurred. With changed content, the same scan reports a registration conflict and `ok: false` for a location that should have been skipped. This violates W4's explicit archived-location idempotence and accurate-success-count requirements.

Independent temporary fixture `/tmp/pappra-w4-archived-probe.mjs`:

- Register a private `docs/a.md`, archive it, then scan plan: `ok: true`, one candidate.
- Apply again without changing the file: `ok: true`, one reported registration; catalog record remains archived and unchanged.
- Change only the archived document body and apply again: `ok: false`, one candidate, zero registrations, `document_already_registered`.

No existing record was overwritten; the defect is selection and feedback. Do not broaden this into catalog/lifecycle changes. Include all existing lifecycle states in scan's deduplication query while preserving user-facing list filtering. Add focused regression coverage for unchanged and changed archived locations, with private and shareable records and non-default metadata preserved. Assert zero candidates/registrations, successful complete scans for valid sources, and unchanged catalog bytes/records. Retain the existing partial-scan and invalid-catalog behavior.

Independent validation: test compilation, all 58 knowledge service/CLI/MCP/global CLI tests, and `pnpm typecheck` passed. The independent missing/truncated/invalid-catalog replay passed; these checks do not cover or negate the archived-location reproduction above. No full-suite/package rerun was needed.

## Readiness and next dispatch

Original W4 coordinator and receiver readiness records are verified separately from acceptance. The reused actual receiver observation was made at `2026-10-21T15:38:38Z`; it has now expired under the existing 30-minute rule. Request a fresh actual same-session receipt/card through the product message channel before coordinator preflights the repair assignment. Do not replace an observation timestamp, infer current tool availability from old evidence, or authorize source edits from the evidence-only request. Use the same visible Pi/session and proactive result notification; no polling or completion timer.
