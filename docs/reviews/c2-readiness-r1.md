# C2 standalone readiness review — round 1

Decision: changes requested for bounded input handling. Existing readiness semantics and public CLI behavior otherwise match the scoped direction reviewed so far.

## Independent evidence

- REPORT `msg-c2-readiness-report` SHA-256 `444620cb4234c58958339dcfb6c596d307bf1b116d945ac6847f50588e2ef036`, task/native identities, correlation/attempt/epoch, assignment/input and output digests verified.
- All 22 current manifest entries match `sha256:1cfc80df090cd7a8588f2426434194d1e8d7657484eda5118c792187c9d7659d`.
- Independent type checking and 41 focused tests passed, including the built CLI from an unrelated working directory. The excluded reliability patch still passes its reverse-apply check.
- Review driver `/tmp/pappra-c2-review.mjs`; reproduction evidence `/private/tmp/pappra-c2-review-tw0ocy/result.json`. The probe starts only the local CLI under a two-second timeout; it sends no model or Herdr prompt.

## P2 — FIFO input blocks before the regular-file check

`readBoundedJson` opens the supplied path with `O_RDONLY | O_NOFOLLOW`, then calls `fstat` to reject nonregular files. Opening a FIFO for reading blocks until a writer connects, so the type check never runs. An absolute assignment FIFO with no writer made the CLI hang until the independent driver killed it at two seconds (`ETIMEDOUT`, `SIGKILL`, no output). The same shared loader handles capabilities.

This violates the approved contract to refuse special files before invoking preflight and undermines a bounded read-only readiness operation.

## Scoped correction

- Refuse observed special files before blocking open, and preserve that refusal if a regular file is replaced between inspection and open. On supported POSIX hosts use nonblocking, no-follow open plus descriptor type validation, or an equivalent bounded strategy; a pathname precheck alone leaves the replacement case open.
- Keep actual descriptor reads within the documented 1 MiB bound, rather than an unbounded read-to-EOF after the size check. Preserve simple implementation and generic content-free diagnostics.
- Add timeout-protected child-process regressions for FIFO assignment and capabilities. They must return `invalid`, exit 2 promptly without any writer, task mutation or leaked body. Exercise the bounded loader without risking a hung test runner.
- Keep all previous readiness, message/routing, CLI and packaging contracts unchanged. No primitive semantic change, host adapter, new dependency or unrelated cleanup.
- Same Pi session and epoch claims; fresh receiving-runtime receipt/card and ready preflight before source writes. Return current manifest/input revision through product REPORT and notify once, without polling or native fallback.
