# Managed Pi session integration — second acceptance campaign

This campaign uses fresh visible Pi/OpenRouter implementation sessions with
disjoint file ownership. The integrator owns app/CLI integration and consolidated
checks. Existing dirty changes are preserved. Nothing is committed, published,
globally installed or substituted for the user's Pi executable.

## Implemented integration

- Explicit SDK mode loads exactly Pi 1.4.0 and verifies the source hashes of the
  native session and TUI code before reading private queues. It starts the native
  interactive mode with daily extensions/resources and an explicit OpenRouter model.
- A private local control endpoint exposes status, input/work fencing and owned
  runtime disposal. Runtime disposal is distinct from an OS exit receipt. Short
  socket paths support long macOS workspace/temp paths.
- Native settled events publish standard readiness cards from observed native
  evidence. Automatic handoff observes the actual context threshold, reserves
  capture before the native model request, retains the full source transcript as
  a private checkpoint artifact, and drives the existing guarded transition.
  Reopening task snapshots after atomic record replacement prevents stale-inode
  failures. Its own journal cannot produce recapture loops.
- Explicit role plans optionally dispatch a planner, then independent writers,
  then a reviewer after coordinator acceptance of predecessors. Watch mode
  follows registered task/capability changes, rebinds changed watch inputs and
  performs bounded journaled dispatch without model polling.
- Self-source runtime installation copies the complete installed dependency tree
  when available, avoiding cold-cache registry dependency. Other sources retain
  their existing installation behavior. Bundles use a stable project working
  directory. The complete test matrix has a bounded 15-minute deadline; unrelated
  commands retain their previous deadline.

## Verification

The initial consolidated focused campaign passed 46 tests with zero failures.
It covers native SDK contracts, PTY control, readiness events, private SDK control,
automatic capture and ambiguity retention, planner dependencies, role event
watchers and CLI behavior. The full-suite and final package campaign are recorded
separately below.

The full standard test campaign passed **867 tests, zero failures and zero
cancellations**, with two explicit skips (optional-engine absence case and the
opt-in provider probe). It completed in approximately 659 seconds; this confirms
the former 360-second ceiling was too short for the complete matrix.

Final disposal/provider-gate corrections were independently recompiled and
verified with **17 regression tests, zero failures**. Disposed-session gates
remain latched, and asynchronous summary context permits only its own provider
call while unrelated provider ingress remains rejected.

A fresh visible managed SDK session completed one real native prompt through
OpenRouter `openai/gpt-6-luna`, recorded native `stopReason: stop`, and returned
`runtime_disposed` before the pane returned to its shell. The native session ID
is `01a16958-9e66-75f2-9c05-fdf5b4d9e93b`; sanitized evidence is retained in
`/private/tmp/pappra-sdk-prompt.1Ylzib/result.json`. This establishes normal native
model execution, not provider-interruption recovery. The standalone fault probe
could not resolve an API key through its default SDK auth check and remained
skipped; its result must not override the observed native-session success.

An intermediate package campaign passed installed API/assets, opt-in host bundle
smoke, durable self-install, cleanup and workspace lifecycle. It then refused the
changing working tree because a parallel task created a new test file. This is
not a complete package-gate pass; final acceptance requires a stable file set.

The final stable-file package campaign **passed (380 files)** after rebuilding
the final production code. It passed installed ESM/API/assets, opt-in host
bundles, durable self-install, ownership-safe cleanup, workspace lifecycle and
the selected-project walkthrough that previously timed out. Strict test/script
TypeScript checks, repository formatting, source-language policy and
`git diff --check` also passed. Logs are retained under `/private/tmp` as
`pappra-v2-full-tests.log`, `pappra-v2-final-regressions.log`,
`pappra-v2-final-package-check.log` and `pappra-v2-final-format.log`.

## Boundaries still requiring implementation or external evidence

The SDK inventory covers its pinned owned runtime. Arbitrary external writers
and unowned descendants are explicitly outside it. The existing transfer guard
is not weakened to consume that inventory as a global stop proof; the end-to-end
native successor takeover/resource transfer/retirement contract is not accepted
as complete by this campaign.

Role dispatch does not invent retry approval or stop evidence. A rejected attempt
still needs the authorized coordinator workflow to register the next attempt.
Planner output does not itself grant authority or rewrite assignment pins.

The real-provider interruption test is opt-in and must report actual upstream
HTTP/stream evidence before it is accepted. A skipped probe and the existing
loopback fault tests do not prove real-provider recovery.
