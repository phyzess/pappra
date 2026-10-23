# C1 routing implementation review

Decision: accept the scoped explicit task-bound routing implementation and real bidirectional product round trip. This is not acceptance of full collaboration parity.

## Evidence and verification

- REPORT `msg-c1-routing-implementation-report`, notification SHA-256 `80280f1d25647c61032f37156722fa22e5ecdf4f0ed345b8ec36491f9c26b7a8`: task/native identities, parent assignment, subtask/attempt/epoch, assignment/input and all output digests verified.
- All 18 current files match manifest SHA-256 `91a6548a29e862b45c7d0df4d726489e67e58d02a004e22ccc791cfdd55cde6c`.
- Independent type checking and 34 focused tests passed. Runtime rebuilt independently. Build cleans compiled test artifacts; test sources were recompiled before the broader regression run.
- The independent broader collaboration/CLI/MCP/skill-mirror/task-pin regression run passed: 95 tests, 0 failures.
- The earlier excluded reliability patch passes the reverse-apply check and remains unaccepted.
- Fresh receiving-runtime preflight reports ready at `2026-10-21T01:59:14.976Z`, with cooperative resource-ownership enforcement explicitly excluded.
- Review covers current-context requirements, explicit selector parsing/CLI scope, both-participant binding/live checks, exact reported session comparisons, honest unknown/native process evidence, optional backwards-compatible delivery caller data, namespace checks and transport/retry behavior.

## Real product route probe

The coordinator persisted `msg-c1-explicit-route-probe` using the product CLI, then notified with `--caller-pane w3:p1`. Notify returned `submitted`, one attempt, recipient native-session match, explicit Codex routing with unknown native session and `processAffiliation: not-established`. No environment variable was changed, no native bootstrap fallback was used, and no blocking wait/retry/polling was issued.

The participant returned correlated STATUS `msg-c1-explicit-route-probe-status`, SHA-256 `1797cb560e0a031edcb2efe399e5a7edc57c2964c477c9c93046e9642bc94eed`. Its digest, native sender/recipient, task/subtask/attempt/epoch, parent request and input revision were verified independently. Both product delivery records show one submitted attempt: explicit coordinator route forward, current Pi route back. Probe receipt is established by the correlated response, rather than inferred from submitted transport. Driver: `/tmp/pappra-c1-probe-review.mjs`.

Probe message SHA-256: `d1ea151c4945546a82b060f883a2e78ae312f8a57f0984332a217a0b13fb97e0`; task-local delivery evidence remains authoritative for the transport outcomes. No native bootstrap fallback was used in either direction.

## Scope limits

This route verifies task-bound live routing observations, not sender authentication, process affiliation or execution ownership. Full collaboration parity, standalone capability derivation/preflight and remaining authority/lifecycle/recovery surfaces remain open. No downstream init/reliability implementation is resumed by this review alone.
