# Review closeout ledger (beta.20)

This page is the maintained public record of the two review rounds that produced
the beta.20 hardening work. It replaces the earlier private process logs.
Each identifier is stable: it names one original finding, not a ticket to close.

**84 identifiers: Limitation: 17 · Needs verification: 5 · Implemented: 61 · Superseded by user decision: 1.**

A status describes what the current source shows, not what a test run proved:

| status | meaning |
| --- | --- |
| Implemented | The described defect is absent from current source, or the documented contract now covers it. |
| Limitation | Current source still exhibits the described behaviour; it is documented rather than hidden. |
| Needs verification | Static reads cannot settle it; a bounded runtime observation is required. |
| Superseded by user decision | A product decision removed the described path from scope. |

Evidence pointers name current files. Line numbers move between releases; treat
them as locators, not as pins. Executed checks are named explicitly and retain their fixture or synthetic-input
boundaries. No entry infers a native host load or provider result.

## 健康度

**R1-01 — Limitation.** tools/tests watcher case raises its budget from 3s to 20s; the load-dependent flake is mitigated, not isolated.

  - Nested concerns: sub: raised timeout; sub: first-run .build failure is historical only.

**R1-02 — Limitation.** Commit granularity improved but a single commit still lands 9,259 insertions (26 files).

**R1-03 — Limitation.** The published beta.20 archive is byte-identical to the reviewed candidate: 1,676,693 compressed bytes and 7,944,653 unpacked bytes across 548 files. Five minified bundles total 3,198,573 bytes; duplicate payloads remain. Public tarball integrity and all 548 shipped file hashes were checked after [publication](https://github.com/phyzess/pappra/actions/runs/40245964918). The beta.21 build scheduling change preserves the five bundle bytes; it does not reduce their size.

## P0：建议先修

**R1-04 — Implemented.** MCP runtime_install reports CLI guidance only, accepts from:self, never installs or executes package code (src/mcp/server.ts:457-467).

  - Nested concerns: sub: agent-supplied tarball+apply removed; sub: verify-time execution unreachable from the tool; sub: prompt injection has no MCP path; sub: source is from:self only.

**R1-05 — Implemented.** The message store no longer compares task.json inodes; namespace/state identity is revalidated instead (src/app/collab-task-store.ts:243-257).

  - Nested concerns: sub: commit-rename false positive gone; sub: handoff reconcile no longer triggered by it; sub: reopenTask needs no special bypass.

**R1-06 — Implemented.** releaseManagedPiResume exists and runs on startup failure; dead owners are reclaimed by pinned process identity (src/app/managed-pi-resume-admission.ts:689, :373).

  - Nested concerns: sub: interrupted resume no longer strands the session; sub: no manual task.json edit needed.

**R1-07 — Implemented.** pappra repair is a real CLI surface with journal recovery and interrupted-rollback handling (src/cli/commands/repair.ts:4-14, src/install/repair.ts:256-291).

  - Nested concerns: sub: stranded journal has an operator exit; sub: rollback is reachable outside tests.

## 健康度

**R1-08 — Implemented.** Hashing sizes its buffer to the opened file instead of allocating a 64 MiB ceiling per file (src/infra/fs.ts:88-107).

  - Nested concerns: sub: 65s/25s timings are historical and unmeasured here; sub: dependency copying is covered by R2-49.

## P1

**R1-09 — Implemented.** Scan and emitted-JSON budgets are independent, and zero-result cases carry explicit reason codes (src/code/text.ts:18-24, :133-217).

**R1-10 — Implemented.** Package hashing sorts entry names by UTF-8 bytes; locale no longer affects the digest (src/install/runtime.ts:204-210).

**R1-11 — Implemented.** Runtime removal inspects cross-workspace references and fails closed unless unknown coverage is explicitly accepted (src/install/runtime.ts:1488-1495, :1626-1631).

**R1-12 — Needs verification.** Private state is self-ignoring, and a stale plan is an identity check between plan and apply, not a proven copy detector. Reset-local supplies an explicit archival exit; old-beta migration stays excluded by user decision.

  - Nested concerns: sub: generated private ignore rule implemented; sub: migration superseded by user decision; sub: copy behaviour still unproven.

**R1-13 — Implemented.** Replacement writes use the managed apply journal and report a locked status (src/app/init.ts:2933-2946).

**R1-14 — Implemented.** Controller streams, sockets and child process carry error listeners that fail IO instead of throwing (src/hosts/pi/managed-session.ts:923, :1220-1247, :1722).

**R1-15 — Implemented.** Source liveness uses a pinned process identity, not PID existence, so PID reuse does not fence a session (src/app/managed-pi-resume-admission.ts:739, :776).

**R1-16 — Implemented.** Publish asserts main ancestry, runs tests in the check job, scopes id-token to the publish job and requires tag=version (.github/workflows/publish.yml:22-24, :29-34, :66-71).

  - Nested concerns: sub: SHA-pinned actions; sub: id-token not granted to tests; sub: v* tag off main fails instead of publishing.

**R1-17 — Implemented.** The .mcp.json writer uses the shared atomic JSON writer (src/app/host-mcp.ts:7, :229).

## 架构与可维护性

**R1-18 — Limitation.** The style split is reduced but remains in collaborative/Pi orchestration: synchronous IO and module-specific result shapes coexist with the core asynchronous Outcome convention. No repository-wide convention migration is claimed.

  - Nested concerns: sub: core conventions still not shared; sub: sync fs/result shapes remain numerous; sub: broader convergence is deferred.

**R1-19 — Limitation.** Canonical JSON and stableDigest are centralized, but record guards and safe-write implementations still have duplicate callers (src/infra/json.ts; src/app/collab-role-repair.ts). This closes the digest defect, not the broader utility-consolidation recommendation.

  - Nested concerns: sub: named and inline record guards remain; sub: multiple modules still implement safe writes separately; sub: canonical JSON centralized; sub: broader extraction into infra remains open.

**R1-20 — Implemented.** Hosts import no app module (measured 0), and source:check enforces layer direction including core->collab (scripts/check-source-policy.ts:22-45).

**R1-21 — Limitation.** Session transition is split (1840 lines), but runCli is still ~1270 lines and applySibling ~1100 lines (src/cli/run.ts:57-1327, src/app/collab-bootstrap.ts:3510-4613).

  - Nested concerns: sub: runCli plus global flag table still large; sub: applySibling unchanged; sub: transition split into cohesive modules.

**R1-22 — Implemented.** Exports are 14 subpaths, none pointing at dist internals, and store breakLock is absent (package.json:exports).

**R1-23 — Limitation.** Managed Pi pins the SDK version and hashes Pi private sources, so Pi releases still ripple (src/hosts/pi/managed-sdk-session.ts:25-38, :474-510).

## CLI 体验

**R1-24 — Limitation.** init's mode and flag matrix is still broad and documented as multiple modes (src/cli/commands/init.ts:1902-1925).

**R1-25 — Implemented.** Configuration-only apply reports external-actions-pending with exit 0, and text/JSON failures share one exit mapping (src/cli/commands/init.ts:1135-1145, :1919-1923).

  - Nested concerns: sub: no-runtime path is documented exit 0; sub: text/JSON divergence removed by one mapping.

**R1-26 — Implemented.** The hint and the flag both use --runtime-version (src/cli/commands/runtime.ts:30, :298).

## 流程与文档

**R1-27 — Implemented.** Review process records were removed; docs/reviews holds only an index (docs/reviews/README.md).

**R1-28 — Implemented.** package.json description covers knowledge, continuity, code navigation and optional collaboration.

## P0：下一次发版前必须修

**R2-01 — Superseded by user decision.** The manifest records digestScheme sha256-utf8-byte-order-v1; old beta runtimes stay incompatible and are not migrated (src/schemas/install.ts:8, :86; README:64-68).

  - Nested concerns: sub: scheme recorded and enforced; sub: old beta.14 state not revalidated or migrated; sub: no silent reinstall.

**R2-02 — Implemented.** Hook commands use node plus a pappra-managed marker, and legacy quoted execPath entries are recognized as the same managed entry (src/hosts/integration/templates.ts:31, :36-56).

  - Nested concerns: sub: node upgrade no longer breaks commands; sub: reinstall replaces instead of duplicating; sub: verify no longer mismatches on a different node; sub: rendered template bytes excluded from digest.

**R2-03 — Implemented.** Pi bundles place entry.ts and runtime.mjs in the same extensions/pappra directory, so the relative import resolves (src/hosts/integration/bundle.ts:44-53).

  - Nested concerns: sub: installed layout corrected.

**R2-04 — Implemented.** RPC timeouts are explicit with a 30-minute default operation budget and 24-hour ceiling (src/hosts/pi/rpc.ts:134, :145-147).

  - Nested concerns: sub: no fixed 120s overall limit; sub: no 2-minute SIGTERM boundary.

**R2-05 — Implemented.** Untracked files contribute path, type and digest, not plaintext bytes, and private state writes a final * ignore rule (src/continuity/context.ts:238-247, src/infra/private-state.ts:29-33).

  - Nested concerns: sub: secrets stay out of patches; sub: .pappra/local self-ignored; sub: untracked recorded by digest.

**R2-06 — Implemented.** Init inspects install readiness before planning, and repair recovers interrupted rollback/apply journals (src/app/init.ts:403, :497; src/install/repair.ts:256-291).

  - Nested concerns: sub: repair leaves a usable state; sub: 9-of-11 crash reproduction not replayed.

## 协作协议

**R2-07 — Implemented.** Message application authorizes the sender per type; an epoch alone admits nothing (src/collab/messages.ts:76-100).

  - Nested concerns: sub: forged CANCELLED refused; sub: HANDOFF sender checked; sub: preemptive ASSIGN refused; sub: claim holder path not re-tested; sub: per-type checks are the mitigation.

**R2-08 — Implemented.** Canonicalization uses realpathSync.native and documents case behaviour; alias comparison uses dev+ino (src/collab/canonical.ts:25-50, :70-80).

**R2-09 — Implemented.** Unknown or ambiguous recovery effects stop and are never retried or recorded as success (src/app/collab-recovery-executor.ts:212-231).

  - Nested concerns: sub: no terminal noop success; sub: short retry window no longer decides give-up.

**R2-10 — Needs verification.** A pre-existing dispatch intent still maps to reconciliation-required (src/app/collab-work-execution.ts:909-914); whether a no-effect refusal releases the node needs a flow observation.

**R2-11 — Limitation.** The state table forbids assigned->unknown and every set is validated; the launcher still appends a same-state X->X transition event (src/collab/lifecycle.ts:45-53, :145; src/collab/admission.ts:903-913).

**R2-12 — Needs verification.** Retirement reads the transcript at 64 MiB and continuity retains 8 MiB bounds; the cited fixed 45s successor wait no longer exists as a constant. Freeze ordering needs a transition observation.

  - Nested concerns: sub: SDK-check/freeze ordering unproven; sub: transcript bound aligned.

## 宿主集成

**R2-13 — Implemented.** Generated hook entry accepts SessionStart clear/compact inputs for Claude and Codex; all four direct packaged-entry invocations exited 0. This uses synthetic stdin, not a real host event. Mapping is also covered by tests/hosts/integration.test.ts.

**R2-14 — Implemented.** PostCompact produces no SessionStart-shaped context; the compact event renders nothing (src/hosts/integration/hook.ts:83-84).

**R2-15 — Implemented.** Verification compares bundle and packaged-file digests but explicitly skips the shared settings file digest, checking expected hooks instead (src/hosts/integration/service.ts:2183-2210).

**R2-16 — Implemented.** doctor observes an installed bundle manifest under known host roots independently of selectedHosts (src/app/doctor.ts:1529-1545, :1594-1614; tests/doctor/doctor.test.ts:191-215).

**R2-17 — Implemented.** host uninstall exists, and merge/uninstall preserve user indentation, newline style, permissions and unrelated bytes (src/cli/commands/host.ts:25; tests/hosts/host-usability.test.ts:64-121).

  - Nested concerns: sub: uninstall exists; sub: formatting and permissions asserted by fixture.

**R2-18 — Implemented.** Relative project hooks are portable: a moved checkout verifies and reinstalls with ${CLAUDE_PROJECT_DIR} and no original path (src/hosts/integration/service.ts:609-621; tests/hosts/host-usability.test.ts:152-196).

**R2-19 — Implemented.** Raising a managed hook timeout from 5s to 30s survives verify and reinstall without duplicate hooks; a too-short timeout is rejected (tests/hosts/integration.test.ts, managed hook timeouts case). The affected suite passed in the 47-check group.

**R2-20 — Implemented.** Onboard reuses the admitted version matrix, passes the actual observed version and probes again before writes. One shared planning helper keeps unsupported/missing/unreadable versions skipped in dry-run and apply. The independent reviewer reran 19 isolated CLI and 14 integration cases successfully; a real repository dry-run also reports the installed admitted versions correctly (src/app/onboard.ts; src/cli/commands/onboard.ts; tests/onboard/cli.test.ts).

  - Nested concerns: sub: reference-pin equality gate removed; sub: unknown versions still refused; sub: plugin/SDK contracts and native trust remain separate.

## Knowledge 与 continuity

**R2-21 — Implemented.** Shared scope commits one file per record and never persists the aggregate updatedAt; in-memory update stamps are not merged (src/knowledge/catalog.ts:514-556, :558-614, :481-510; tests/knowledge/daily.test.ts:59, :127).

**R2-22 — Implemented.** Scan retains document identity across ordinary and case-only renames, and relocation validates the digest (tests/knowledge/daily.test.ts:173-225).

  - Nested concerns: sub: rename identity retained automatically; sub: case-only rename supported; sub: relocate validates digest; sub: forget provides a content-preserving exit.

**R2-23 — Implemented.** Catalog conflicts surface named diagnostics, and forget is a content-preserving exit (src/knowledge/catalog.ts:400-419; tests/knowledge/daily.test.ts:252, :330-331).

  - Nested concerns: sub: conflict visible and manual by design.

**R2-24 — Limitation.** Auto-resume preference is private, but workspace schemas remain strict; adding an optional field does not make older readers forward-compatible. Old-beta migration is deliberately excluded. Mixed-version team schema evolution remains an explicit limitation (src/schemas/workspace.ts; src/schemas/install.ts).

  - Nested concerns: sub: additive schema field; sub: personal preference stays private.

**R2-25 — Implemented.** resume exits 0 with executionAllowed false and advisory blocking reasons; only stale verification exits nonzero (tests/continuity/cli.test.ts:188-197, :225).

**R2-26 — Needs verification.** Entry and depth limits now emit explicit diagnostics (src/workspace/documents.ts:298-311, :340-349); the per-document scan cost was not re-measured.

  - Nested concerns: sub: cap accounting not re-derived; sub: depth limit reported, not silent.

**R2-27 — Implemented.** Private locks resolve owner identity, treat PID-only locks as unknown and reclaim only proven death (src/infra/private-lock.ts:55-66, :95-117, :142-150).

**R2-28 — Implemented.** An embedded non-submodule checkout is captured by its own Git identity instead of being recursed or lost (src/continuity/context.ts:248-269).

## 其他

**R2-29 — Implemented.** No PAPPRA_FAULT fault-injection string remains in src or dist.

**R2-30 — Implemented.** The real stdlib PTY regression closes controller input and verifies that an orphaned bridge reaps its TERM-ignoring child with SIGKILL and exits cleanly (tests/hosts/managed-session.test.ts). It passed in the 47-check group; CPU utilization was not separately benchmarked.

**R2-31 — Implemented.** repair resolves the workspace root rather than trusting the current directory (src/install/repair.ts:47).

**R2-32 — Implemented.** Explicit operator exits exist for unknown locks and unproven journal entries; automatic reclaim still requires proven death (src/cli/commands/repair.ts:10-14; src/install/repair.ts:103-105, :120-178, :286-291).

  - Nested concerns: sub: empty/unknown lock has a quarantine exit; sub: pre-journal files go to retireUnprovenApply.

## 安全

**R2-33 — Implemented.** The SDK input hook journals only source and streaming flags, not prompt text or image payloads (src/hosts/pi/managed-sdk-session.ts:178-190).

**R2-34 — Implemented.** MCP writes require trusted server startup policy; tool flags never grant authorization, and runtime_install is guidance only (src/mcp/server.ts:313-330, :403-420, :457-467).

## 协作与 Pi

**R2-35 — Implemented.** The receiver rechecks authority before import and before ack, and refuses work before transfer (src/app/managed-pi-handoff-receiver.ts:22, :137-175, :326).

  - Nested concerns: sub: authority rechecked before the reservation-consuming import; sub: finally-block masking not re-inspected.

**R2-36 — Implemented.** Late responses match an expired-request map and are counted instead of failing the transport (src/hosts/pi/rpc.ts:268, :394-400).

**R2-37 — Implemented.** A 20 MiB cumulative stdout fixture succeeds with bounded retained history and explicit truncated-log evidence; an oversized individual frame remains fatal (tests/hosts/pi-rpc-limits.test.ts). The affected suite passed in the 47-check group. This is a transport fixture, not a long-running real-provider task.

**R2-38 — Implemented.** Canonical JSON canonicalizes exactly what JSON persists, so nested undefined keys drop consistently instead of encoding null (src/infra/json.ts:3-10).

**R2-39 — Implemented.** Canonical encoding sorts object keys, so digests no longer depend on field insertion order (src/infra/json.ts:12-25).

## 测试

**R2-40 — Implemented.** The test environment strips GIT_CONFIG_* and PAPPRA_* variables, with a dedicated regression test (tests/infra/test-environment.test.ts:8-45; tests/workspace/fixtures.test.ts:45-58).

**R2-41 — Limitation.** Runtime-install tests explicitly reject tarball/version overrides before mutation, and the MCP suite passed in the 47-check group (tests/mcp/server.test.ts). A complete per-tool success-path coverage matrix is still missing; tool listing alone is not invocation coverage.

**R2-42 — Limitation.** CI provisions no codegraph, so engine-dependent cases stay skipped there (tests/code/service.test.ts:41-46, :134); the 178s cost is unmeasured here.

**R2-43 — Limitation.** The flaky watcher mitigation is still a timeout bump, now 20s (tests/hosts/readiness-publisher.test.ts:433, :525).

## 文档和 CLI

**R2-44 — Implemented.** Top-level help lists every current command family including onboard, repair, runtime, task and mcp (src/cli/run.ts:1309-1313, :1319).

**R2-45 — Implemented.** host --help enumerates probe, uninstall, bundle and mcp (src/cli/commands/host.ts:25-32).

**R2-46 — Implemented.** Quickstart and README now agree: --yes --reconfigure keeps represented selections, while --config applies explicit edits (docs/quickstart.md; README.md).

**R2-47 — Implemented.** api.md names @phyzess/pappra and its table matches the 14-key export map (docs/api.md:13-23).

## 其他

**R2-48 — Limitation.** All five candidate bundles contain ZodError runtime signatures; the builder externalizes Pi-provided packages, while Zod remains bundled (scripts/build-assets.ts). Signature presence confirms inclusion, not the exact number of bytes attributable to duplicate Zod code.

**R2-49 — Implemented.** Dependency materialization hoists and reuses exact resolved copies while retaining necessary version-conflict nesting (src/install/dependencies.ts). The frozen published beta.20 closure measured 101 copied placements, 66 reused slots, 3,687 files and 17,459,066 logical bytes, with a maximum of two node_modules segments. These measure existing beta.20 behavior, not beta.21 savings or total runtime size. The historical 76 MB/depth-14 tree was not reconstructed. See the [measured development decisions](distribution-plan.md#measured-beta21-development-decisions) for the rejected copy optimization and isolation checks.

**R2-50 — Needs verification.** No NFD normalization exists in src; Linux lookup behaviour needs reproduction.

**R2-51 — Implemented.** The dependency-direction rule covers core layers including continuity importing collab (scripts/check-source-policy.ts:22-40).

## 架构和流程：基本未动

**R2-52 — Limitation.** A named record guard exists in the Codex protocol module, while domain-specific inline Record guards remain elsewhere. This does not establish a shared infra convention or uniform array handling across every validator (src/hosts/codex/protocol.ts).

**R2-53 — Implemented.** Hosts import no app module (measured 0), and the policy now flags such an edge (scripts/check-source-policy.ts:35-38).

**R2-54 — Limitation.** Many synchronous filesystem calls remain in orchestration code. No systematic migration to the core asynchronous IO convention was performed in this batch.

**R2-55 — Implemented.** The export map is 14 subpaths and exposes no internal dist path (package.json:exports).

**R2-56 — Limitation.** Reconciliation state still has three spellings across modules (reconciliation-required, reconcile_required, needs-reconciliation).

  - Nested concerns: sub: broader result-type, schema and utility convergence is deferred.

## Additional cold-start findings

These came from beta.20 dogfooding and do not add identifiers to the original
84-item inventory:

- Unusable runtime state had no preserving exit. The new [runtime archive](runtime-archive.md)
  command retains raw bytes with recoverable receipts, while doctor provides passive
  diagnosis. Independent review passed 35 affected checks, including 13 process-kill
  recovery phases. Large items use filesystem identity rather than a content digest;
  passive doctor does not recompute content hashes. Same-user filesystem races are
  bounded checks, not an operating-system isolation guarantee.
- Failed checkpoints could leave an empty task directory while reporting no residuals.
  Cleanup now requires exclusive creation, unchanged identity and an empty directory;
  independent native review and 57 focused checks covered the change.
- Workflow release could free claims and then fail STATUS correlation. Pre-effect
  validation and genuine assignment correlation were independently reviewed. The
  original task was recovered and replayed once with unchanged protected data;
  notification remained unverified. See [cold-start acceptance](cold-start-acceptance.md).
- A deferred reviewer registered before a read-claim conflict could not reacquire
  coverage on dispatch retry. The real review was recovered through an explicitly
  authorized assignee self-claim. The automatic retry fix passed 53 affected
  checks; independent review reran 28, including all 15 focused regressions.
  Retry requires an unconsumed assignment with no possible native delivery;
  unknown or submitted delivery remains a no-replay boundary.

## What this ledger does not claim

- Targeted verification used a private TypeScript emit and 47 existing checks, plus four
  synthetic packaged-hook invocations; it ran no full suite or model.
- A status of Implemented means the reviewed code path changed; it does not mean every
  platform, host version or provider path was exercised.
- Needs verification entries are tracked follow-ups, not silent passes. Each one names the
  observation that would settle it.
- Older beta state is not migrated. Archival reset is the supported exit, and no
  compatibility promise covers earlier beta builds.
