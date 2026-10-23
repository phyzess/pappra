# C2 standalone readiness acceptance

Decision: accept the scoped standalone read-only preflight entry after the bounded-input correction.

- REPORT `msg-c2-readiness-repair-r1-report`, notification SHA-256 `6718335e18174cc1ccda30f9939b600c5fb6984a9f9acd89565129684524ba73`: identity/correlation/attempt/epoch, pinned assignment/input and all output digests independently verified.
- All 22 current files match manifest SHA-256 `933d7d5ab270d07b414ca5e5abd6d1b68b8050c8482aaf5519d1a15ba8291aa6`.
- Independent type checking and 42 focused tests passed. The test selection includes FIFO assignment/capabilities with child-process timeout and built CLI from an unrelated cwd.
- Independent reproduction now promptly returns invalid/exit 2 for a FIFO without a writer, rather than timing out. Driver: `/tmp/pappra-c2-repair-review.mjs`; evidence: `/private/tmp/pappra-c2-review-H6bvUG/result.json`.
- Source review confirms nonregular precheck, nonblocking/no-follow open on POSIX, descriptor type/size validation and a bounded descriptor read. Windows behavior is limited to the documented platform support; FIFO regressions require mkfifo.
- The excluded earlier reliability patch passes reverse-apply checking and remains separately unaccepted.
- Pi reports 103 broader tests, build/source-policy/package verification passing on the final revision. These final broader commands were not independently repeated. Full-tree formatting remains blocked by the excluded task-pin file.

The final repair report distinguishes reuse of a still-fresh same-session runtime card from its later refreshed observation/preflight; the later timestamp is not evidence of a pre-write refresh. Future assignments should reuse a fresh actual observation when appropriate and run preflight against the new pinned assignment before writes, rather than requiring a redundant observation solely for a new task label.

Accepted readiness behavior preserves the existing primitive, reports its blockers/warnings/limits and launches nothing. A ready result is not authentication, authority, ownership, dispatch or completion. Native-evidence-to-card derivation remains the next missing public workflow surface.
