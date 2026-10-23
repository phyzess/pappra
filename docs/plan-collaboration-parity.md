# Restore the complete collaboration workflow

Status: C0-C12 daily visible-peer/message baseline is accepted within its documented scope, including portable bindings, native lifecycle discovery, installed and visible workflow guidance. Bidirectional product messages work without native notification fallback; W1-W10 workspace/init implementation and independent review used that channel. Broader native/history/library and real three-host/version parity remain open; full collaboration parity is not declared complete. This is a primary scope expansion requested by the user.

The user authorized resolving those remaining gaps plus model switching, automatic session handoff/archive and role-aware parallel collaboration on 2026-10-22. Execution continues under [the collaboration evolution plan](plan-collaboration-evolution.md), with independent visible investigations and bounded implementation/review batches. These additions are not yet accepted features.

The current execution contract is [the remaining parallel implementation plan](plan-remaining-implementation.md): disjoint implementation streams, local critical checks, complete-batch grouped independent review and one consolidated final regression/package/installation/project campaign. Routine evidence/model/test updates do not require another coordinator confirmation when checks pass. Historical preparation sequencing below does not override this contract.

## Objective

Make the proven task-scoped harness-collab workflow available from an installed Pappra package in an unrelated workspace. Preserve visible native sessions, useful host capabilities, clear ownership, review/repair loops, and recovery. Keep existing safety boundaries and avoid a second scheduler or parallel source of task authority.

The benchmark is the maintained workflow and its demonstrated boundaries, not every aspiration in the original protocol. Historical reports are dated evidence, not a claim that the installed versions have been reverified now.

## Audit categories

For each capability, separately establish:

1. Maintained legacy instructions and executable support.
2. Current Pappra runtime primitives and tests.
3. Installed skill/reference coverage.
4. Public CLI, MCP, and package API reachability.
5. Current observed native behavior and unverified boundaries.

Use `preserved`, `partially exposed`, `missing`, `intentional limit`, or `unknown`. Missing guidance does not prove missing runtime code; copied runtime code does not prove an installed user can complete the workflow.

## Initial evidence matrix

| Capability | Legacy evidence | Current evidence | Initial assessment |
| --- | --- | --- | --- |
| Herdr/direct environment routing | Legacy skill plus environment reference explicitly select visible sibling panes inside a verified caller, and native channels outside Herdr | Shipped `skills/pappra/SKILL.md` and references guide one-request RPC and do not describe the Herdr route | Missing packaged workflow guidance; visible channel integration needs design/verification |
| Task messages, claims, epochs, writer/coordinator handoff | Legacy `collab.mjs` exposes init/show/send/transition/claim/release/handoff/reconcile/doctor and related operations | `src/collab/` retains these module families and exports them; public collaboration CLI exposes prepare/run/query | Substantial primitives preserved, operational entry points only partially exposed |
| Receiving-runtime capability evidence and preflight | Legacy contract, fingerprint/preflight scripts, and host-specific evidence adapters document discovery-to-work | Pappra preflight/fingerprint exist internally; prepare emits a declared card; current docs require a runtime card without an equivalent complete user-facing derivation path | Partially exposed; evidence adapters and bootstrap workflow require detailed mapping |
| Native Pi/Codex/Claude lifecycle | Legacy native adapters document per-host launch/query/cancel/resume and owned-stop limits | `src/hosts/index.ts` exports Pi RPC/history, Codex, Claude, and pilot modules; CLI controllers are fixture/Pi RPC only | Preserve/adapt existing code; compare public route coverage and daily configuration behavior |
| Long-running work and result acceptance | Legacy native sessions distinguish live execution, completed history, and accepted REPORT | This task's early finish call hit a 15-second event wait while a tool-intermediate result was pending; the child was closed and status remained failed/unknown | Reproduced operational gap; inspect wait/finish semantics and caller contracts before fixing |
| Registry-to-authority recovery link | Legacy registry docs define explicit bindings, identity checks, ambiguity handling, and unbound tombstones | Current task pin/checkpoint/resume cover a different purpose; equivalent portable binding/discovery flow has not yet been established | Unknown/likely missing operational coverage; do not equate checkpoint context with authority |
| Implementation/review/repair and escalation | Legacy protocol and workspace entry describe file-based conclusions, role-scoped assignments, independent review, and bounded escalation | Current shipped entry primarily describes one bounded request | Missing complete agent workflow; retain reusable runtime rather than invent another task engine |
| Portable installation | Legacy package preparation and local host references are explicit about paths and scopes | Pappra publishes a runtime/skill bundle, but the comprehensive legacy workflow is not documented there | Must pass installed-package tests without any legacy checkout dependency |

## Implementation direction

- Restore an instruction-first collaboration entry that selects the channel from verified caller context and user preference. Herdr is optional for the product; visible panes are mandatory for this user's current task.
- Keep coordination, native execution, pane visibility, and task discovery as separate responsibilities. A pane ID is not a native session ID; pane idle does not prove stop or accepted work.
- Reuse one authoritative task record and the existing message, resource, handoff, and reconciliation modules. Expose coherent operations instead of adding a parallel task state store.
- Make manual native-session collaboration a first-class supported path. Do not force every visible TUI participant into an RPC-only controller or claim RPC-owned stop guarantees for an unrelated TUI process.
- Provide a documented, executable receiving-runtime evidence/bootstrap path. PATH/config discovery must remain declared evidence. Preserve actual tool/skill/MCP/model settings unless a task explicitly selects omissions.
- Provide portable task-to-record bindings and recovery diagnostics independent of the private atlas registry. Migrate only explicit supported data; never silently adopt arbitrary sessions or legacy global state.
- Restore implementation/review/repair guidance, pinned input/output artifacts, role transitions, and escalation. Budget and approval rules come from the task; historical workspace-specific budget amounts are not defaults.
- A UI wait expiring must not silently finish or cancel an ongoing native task. Active query/cancel uses the owned runtime; completed-history recovery does not start another model turn.
- Curate legacy instructions for open-source use: remove private product routing and local checkout dependencies while preserving the operational capabilities they enabled.
- Preserve legacy collaboration identifier/schema compatibility: collaboration task IDs support 128 characters, while continuity/task pin IDs currently support 64. A continuity safety fix must not redefine collaboration wire identities.

## Revised delivery sequence

1. Establish a real message-driven coordinator/participant loop in the visible panes. Persist identity-bound protocol messages, deliver pointer-only native notifications, and receive proactive ACK/question/result notifications. No periodic model-turn polling, timer-based status reads, or blocking completion waits as the ordinary coordination mechanism. A missing response remains uncertain, not permission for automatic redispatch.
2. Complete the parity review and implement a supported installed-user message/notification/receipt path over existing protocol primitives, replacing temporary task-local bootstrap glue. Distinguish persisted, notified, consumed/acknowledged, reported, and independently accepted outcomes; do not collapse delivery into task success.
3. Restore packaged environment routing, references, capability-evidence bootstrap/preflight, and an end-to-end visible native-session runbook. Fill the necessary public-operation gaps while preserving native defaults and authority boundaries.
4. Add the remaining message/resource/handoff and portable task-binding/recovery operations confirmed absent by the audit. Correct native wait/finish/recovery semantics with regression tests and bounded real execution evidence.
5. Independently review and finish the preserved batch-1 safety patch, then complete the remaining reliability and init/knowledge experience batches through the working message-driven collaboration path.
6. Validate the full workflow using an installed package in an unrelated clean workspace, then update support/distribution claims from observed results.

The audit may adjust dependencies inside steps 2-4 if a prerequisite makes the documented workflow impossible. The user's priority is explicit: collaboration must work before downstream product improvements resume. Any change must be recorded with evidence, not hidden behind a fallback.

## Acceptance scenarios

- In a verified Herdr caller, an authorized coordinator starts/reuses a visible sibling Pi participant, preserves focus and daily settings, checks receiving-runtime evidence, assigns scoped work, reviews an artifact, and requests a correction on the same task/session.
- Genuinely outside Herdr, the same task protocol works through supported direct native controls without launching Herdr.
- A stale caller binding, unrelated idle pane, missing required tool, changed input, or failed admission prevents dispatch with a specific recovery action.
- An unknown/timed-out execution is queried before any retry; a long tool call does not become a false finish, accepted result, or second writer.
- Writer/coordinator handoff records stop evidence, inventory, acknowledgement, and epoch changes. Cooperative ownership is not advertised as OS fencing.
- Lost REPORT recovery reads a completed native result without another model call. Unavailable live ownership remains unknown.
- A portable task binding resolves the exact authoritative record and detects ambiguity, identity drift, corruption, and explicit unbinding.
- A clean package consumer can complete these scenarios without reading files from the original private workspace or manually fabricating capability cards.

## Evidence and review status

- Current visible assignee: `pappra-implement`, pane `w3:p3`, native session `b4c18851-d297-4f99-9850-9be1a0f9a9a7`.
- Pi audit report: `/tmp/pappra-pi-harness-parity-report.md`; independent review round 1 requested five precision corrections. The corrected report was returned with digest `sha256:bcf7d9c7c56bd0ffafe97f086cb1abf555b95720e61731d5348493c1e52eb753`. Its principal reachability/guidance findings are accepted as planning evidence with the stated read-only/native-test limits, not as proof that every native adapter is behaviorally identical.
- Contract and runtime preflight evidence: `/private/tmp/pappra-pi-batch-1-1792543809003/parity-*`.
- Current source modifications from the earlier reliability batch remain partial and unaccepted. The parity audit is read-only with a report-only write resource.
- The user explicitly rejected timer/wait/status-polling coordination and prioritized proactive messages before later implementation. The coordinator is now named `pappra-coordinator`; the participant remains `pappra-implement`. Native coordinator thread: `01a15bdf-a413-7c92-b9df-951817af8ff8`.
- Message bootstrap uses existing Pappra envelope/submitMessage/ledger primitives, with Herdr delivery as a separate explicit operation. Authoritative task record: `/private/tmp/pappra-pi-batch-1-1792543809003/message-domain/tasks/workspace-experience/task.json`. STATUS_QUERY `msg-5016155bb923c38c188abe23` received correlated STATUS `msg-82034888f1e5dc1797acb209`; Pi's native notification triggered the next coordinator turn. Sender/session/recipient/reply and file/report digests were verified. This proves the task-local round-trip, not a shipped product path.
- C0 is scoped to public persisted-message send/list/read, explicit one-shot Herdr notification and truthful delivery metadata/receipts, plus installed-agent guidance. No polling, automatic retries, daemon, implicit pane creation, or authority expansion. Existing reliability edits remain excluded. Fixed baseline, contract, runtime card, cooperative write claims, and acceptance are under `/private/tmp/pappra-pi-batch-1-1792543809003/c0-message-loop`; full assignment brief is `/tmp/pappra-c0-message-loop.md`.
- C0 REPORT `msg-c0-report-1` and all 18 manifest entries were independently verified. Focused tests passed 14/14 and type checking passed on recheck. [Review round 1](reviews/c0-message-loop-r1.md) requires repairs for namespace redirection/outside writes, exact native session matching, atomic bounded retry reservations, verified caller resolution, and ambiguous transport outcome classification. The unchanged earlier reliability patch remains excluded.
- Repair assignment `c0-message-repair-r1` / attempt 1 uses the same participant and existing epoch-1 claims; fresh receiving-runtime capability observation/preflight is required before source writes. Pinned review, input and routing evidence are in `/private/tmp/pappra-pi-batch-1-1792543809003/c0-repair-r1`. Completion must proactively notify the coordinator for independent review round 2; no status polling is scheduled.
- Repair REPORT `msg-c0-repair-r1-report` and all 18 current manifest entries were verified independently. Type checking and 23 focused tests passed. [Review round 2](reviews/c0-message-loop-r2.md) records two remaining cases: the original domain itself can be a symlink, and arbitrary unknown JSON error codes are classified as definite refusals. Continue with a narrow same-session correction, using progress/risk rather than a fixed review-round gate; no downstream product work or polling is authorized by a REPORT alone.
- Independent broader regression selection: 84 passed, 0 failed. Follow-up `msg-c0-repair-r2-assign` is persisted; evidence is under `/private/tmp/pappra-pi-batch-1-1792543809003/c0-repair-r2`. Product notify correctly refused this coordinator's stale inherited caller context before submission. After explicit current-pane and exact recipient-session verification, one native Herdr pointer notification was used as a documented bootstrap fallback, without `--wait` or environment spoofing. Supported stale-caller recovery remains an unresolved routing capability for the next collaboration slice.
- [C0 acceptance](reviews/c0-message-loop-acceptance.md): final REPORT and 18-file manifest verified; independent type checking and 26 focused tests passed; both residual reproductions now behave correctly. Pi's final broader 87-test/package results remain attributed to Pi. The prior independent 84-test result is recorded at its own revision.

## C1 direction: caller routing and recovery

The completed bounded investigation confirms that historical task bindings, matching cwd, pane names and missing native-session fields do not authenticate a caller. Existing Herdr caller-resolution semantics provide client-supplied routing context. Explicit pane selection can support task-bound notification without claiming authenticated process/native identity; the approved implementation must preserve that distinction and avoid a second routing registry.

Use the reviewed observations to implement the narrow public route and an installed-user recovery walkthrough with deterministic tests. Preserve direct-mode and visible-pane requirements, focus, original Pi session, epoch and uncertain execution states. Do not broaden into lifecycle/resource operations or present explicit task-bound routing as authenticated caller recovery.

C1 report-only assignment `msg-c1-caller-routing-assign` is persisted against the same task/session, with pinned direction and source manifest under `/private/tmp/pappra-pi-batch-1-1792543809003/c1-caller-routing`. Because the coordinator's known stale caller environment is unchanged, a single explicit native pointer notification follows fresh explicit-pane and exact Pi-session checks; it is bootstrap transport, not a product delivery receipt. The participant will return a proactive REPORT. No timer, status polling or blocking completion wait is scheduled.

C1 REPORT `msg-c1-caller-routing-report` and its evidence were verified. The coordinator's own process chain is daemon-hosted and does not include the visible pane process; Pi's contrary generalization is not accepted. [Implementation direction](reviews/c1-caller-routing-direction.md) permits an explicit task-bound route, requires sender and recipient routing checks, and labels native session/process evidence honestly. Current context and editable bindings are not sender authentication. Preserve protocol authority separately; do not introduce a mandatory ancestry gate that blocks hosted agents.

Implementation assignment `msg-c1-routing-implementation-assign` is persisted; pinned contract/direction/input are under `/private/tmp/pappra-pi-batch-1-1792543809003/c1-routing-implementation`. Same Pi session and existing epoch-1 claims; fresh runtime observation/preflight required before writes. One explicit native bootstrap pointer was submitted after fresh caller-pane and exact recipient-session observation, without focus change or `--wait`. After independent source review, use one real product notification with the explicit caller selector and a correlated proactive reply to verify the recovery path.

[C1 implementation review](reviews/c1-routing-implementation-review.md): delivery/manifest verified, independent type checking and 34 focused tests passed, runtime rebuilt. Product send and `notify --caller-pane w3:p1` submitted `msg-c1-explicit-route-probe` once to the exact Pi session. No native bootstrap fallback or spoofed environment was needed. Await one proactive correlated STATUS; do not poll, retry or equate submission with final acceptance.

Correlated STATUS `msg-c1-explicit-route-probe-status` verified the probe receipt, same input/native identities and one-attempt product delivery in both directions. C1 is accepted within scope. Independent broader regression selection passed 95/95. Continue using product messages for subsequent assignments; process affiliation and absent Codex native-session evidence remain explicitly unknown.

## C2 direction: standalone readiness

Expose `collab preflight` as a read-only wrapper over the existing readiness primitive, with ready/needs_input/invalid outcomes, strict input/options, unchanged evidence/freshness/hash semantics and honest readiness limits. [Implementation contract](reviews/c2-readiness-direction.md) defines the CLI and acceptance. Runtime evidence derivation remains a separate next slice; a declared card must not be promoted merely to make readiness pass. Do not combine this change with host/lifecycle/resource or downstream init work.

Assignment `msg-c2-readiness-assign` is persisted with pinned artifacts under `/private/tmp/pappra-pi-batch-1-1792543809003/c2-readiness`, and submitted once using product `notify --caller-pane w3:p1` to the same Pi session. No native bootstrap, timer, polling, automatic retry or completion wait is used. Await the proactive REPORT for independent review.

C2 REPORT `msg-c2-readiness-report` and 22-file manifest verified. Independent type checking and 41 focused tests passed. [Review round 1](reviews/c2-readiness-r1.md) reproduces a FIFO-input hang before the loader reaches its regular-file check. C2 is not accepted; a narrow bounded-input correction is required on the same Pi session. Existing preflight semantics and accepted message/routing behavior remain unchanged.

Repair `msg-c2-readiness-repair-r1-assign` is persisted and submitted once through product explicit-caller notification to the original Pi session. Pinned review/input/baseline are under `/private/tmp/pappra-pi-batch-1-1792543809003/c2-readiness-repair-r1`. Await the proactive REPORT; no timer, polling or completion wait is scheduled.

[C2 acceptance](reviews/c2-readiness-acceptance.md): final 22-file manifest/delivery verified; independent type checking and 42 focused tests passed; FIFO repro now promptly returns invalid/exit 2. Readiness remains separate from authority/dispatch. Reuse a still-fresh actual runtime observation when suitable, and check each new pinned assignment before writes.

## C3 direction: native capability evidence

[Implementation contract](reviews/c3-capability-evidence-direction.md) restores Pi/Codex/Claude evidence adapters behind a read-only installed CLI, keeping native observation timestamps, positive tool/skill evidence, parser limits and existing preflight semantics. Pin the maintained legacy adapter inputs and use sanitized deterministic fixtures rather than another model run. No private-checkout dependency or invented capability promotion is allowed. Remaining resource/handoff/recovery/native lifecycle gaps and downstream init work remain queued.

Assignment `msg-c3-capability-evidence-assign` is persisted and submitted once through product explicit-caller notification to the same Pi native session. Pinned direction, source baseline and all three immutable legacy migration snapshots are under `/private/tmp/pappra-pi-batch-1-1792543809003/c3-capability-evidence`. Same-session actual capability evidence can be reused while fresh; preflight must check the new pinned assignment before writes. Await the proactive REPORT without timers, polling or native notification fallback.

[C3 acceptance](reviews/c3-capability-evidence-acceptance.md): 32-file manifest and correlated delivery verified; independent type checking, runtime build and 117 relevant regression tests passed. Saved-evidence adapters do not establish current live three-host support; their limitations remain explicit.

## C4 direction: task inspection and resources

[Implementation contract](reviews/c4-task-resources-direction.md) exposes read-only state/doctor/epoch/domain resource views and explicit plan/apply claim/release over existing primitives. Preserve same-domain conflict, Git/resource compatibility, holder/cancel-pending refusal, cooperative ownership and private namespace guarantees. Keep actual handoff/reconciliation/portable-binding/native control work separate and queued; no downstream init work resumes yet.

Assignment `msg-c4-task-resources-assign` is persisted and submitted once through the product explicit-caller route to the same Pi session. Pinned direction/baseline/legacy CLI reference are under `/private/tmp/pappra-pi-batch-1-1792543809003/c4-task-resources`. Refresh receiving-runtime observation if stale and preflight the new pinned assignment before writes. Await the proactive REPORT or concrete BLOCK; no polling, timer, blocking completion wait or native notification fallback is scheduled.

C4 REPORT/40-file manifest verified; independent type checking and 12 focused tests passed. [Review round 1](reviews/c4-task-resources-r1.md) requests two narrow corrections: unresolved uncertainty is currently reported ready by doctor, and the advertised global resource-output cap is applied separately per task. The report's late preflight is recorded as a real ordering deviation, not retroactive admission. Require a new repair-assignment readiness check before source writes; C4 remains unaccepted and no later implementation resumes yet.

Repair `msg-c4-task-resources-repair-r1-assign` is persisted and submitted once through the product explicit-caller route to the original Pi session. Pinned artifacts are under `/private/tmp/pappra-pi-batch-1-1792543809003/c4-task-resources-repair-r1`. Await the proactive REPORT without polling or native fallback.

[C4 acceptance](reviews/c4-task-resources-acceptance.md): repaired 40-file manifest/contract evidence verified; both independent repros now pass; independent type checking/build and 132 relevant tests passed. Original late-check deviation remains recorded; the repair has a matching readiness artifact with reported pre-write ordering.

## C5 direction: recorded ownership handoff

[Implementation contract](reviews/c5-handoff-direction.md) exposes existing inventory and writer/coordinator handoff steps with explicit plan/apply, transactional epoch/revision checks and registered correlated receiver confirmation. Keep resource and owner epochs distinct, preserve dispatch freeze until explicitly released, and never infer native stopping from pane state. Tests use fixture domains only; the live coordinator/writer remain unchanged. Recovery/bindings/native lifecycle and downstream init work remain queued.

Assignment `msg-c5-handoff-assign` is persisted and submitted once through the product explicit-caller route to the same Pi native session. Pinned direction/baseline/legacy references are under `/private/tmp/pappra-pi-batch-1-1792543809003/c5-handoff`. Require readiness for this pinned contract before source writes, refreshing observation only when needed. Await a proactive REPORT or concrete BLOCK; no timer, polling, native fallback or completion wait is scheduled.

[C5 acceptance](reviews/c5-handoff-acceptance.md): 44-file manifest and correlated report verified; independent type checking/build and 140 relevant tests passed. No live ownership was transferred; native stopping remains supplied evidence, not a claimed product control capability.

## C6 direction: explicit task recovery

[Implementation contract](reviews/c6-recovery-direction.md) restores read-only uncertainty/lock inspection, explicit recorded reconciliation and deliberate task-lock recovery using existing primitives. Require atomic state-transition refusal, current epoch/revision checks, unchanged lock fingerprint and retained archive evidence. No age-based cleanup, automatic retry/restart, native control, claim release or fabricated stop proof. Tests use new fixture domains only; portable bindings/native lifecycle and downstream init work remain queued.

Assignment `msg-c6-recovery-assign` is persisted and submitted once through the product explicit-caller route to the same Pi native session. Pinned direction/baseline/legacy reference are under `/private/tmp/pappra-pi-batch-1-1792543809003/c6-recovery`. Require readiness for this new contract before source writes. Await a proactive REPORT or concrete BLOCK without polling, timers, blocking completion waits or native notification fallback.

C6 REPORT/47-file manifest verified; independent type checking and 33 focused C4-C6 tests passed. [Review round 1](reviews/c6-recovery-r1.md) reproduces human preview incorrectly saying reconciliation was applied, and a generic error classification after a fixture record committed but ledger append failed. Request narrow output/uncertain-effect corrections; C6 remains unaccepted and no next implementation starts yet.

Repair `msg-c6-recovery-repair-r1-assign` is persisted and submitted once through product explicit-caller notification to the same Pi session. Pinned artifacts are under `/private/tmp/pappra-pi-batch-1-1792543809003/c6-recovery-repair-r1`. Require new-contract pre-write readiness with actual fresh evidence, then await one proactive REPORT without polling, timers or native fallback.

[C6 acceptance](reviews/c6-recovery-acceptance.md): 47-file manifest and repair evidence verified; both outcome-reporting reproductions now pass; independent type checking/build and 152 relevant tests passed. Explicit recovery remains cooperative stored-state mutation, with no live task recovered in verification.

## C7 direction: portable pointer bindings

[Implementation contract](reviews/c7-portable-bindings-direction.md) restores workspace-local alias-to-record pointers, live read-time identity checks, explicit unbound tombstones and bounded explicit-root discovery with ambiguity/incomplete-state handling. Pointer state never copies protocol content or confers execution authority. Keep task pin/checkpoint references independent, refuse corrupt metadata without fallback and preserve concurrency/private-state safety. Native lifecycle and installed-workflow verification remain subsequent work; init/knowledge remains queued.

Assignment `msg-c7-portable-bindings-assign` is persisted and submitted once through the product explicit-caller route to the same Pi native session. Pinned direction/baseline/legacy references are under `/private/tmp/pappra-pi-batch-1-1792543809003/c7-portable-bindings`. Require new-contract readiness before source writes; use fixture workspaces only, with no live binding migration or target-record mutation. Await a proactive REPORT or concrete BLOCK without polling, timers, completion waits or native fallback.

C7 REPORT/50-file manifest verified; independent type checking and six focused CLI tests passed. [Review round 1](reviews/c7-portable-bindings-r1.md) reproduces index publication beyond its own read limit, acceptance of contradictory binding/tombstone metadata, and silent adoption of a changed task incarnation between inspection and index locking. C7 remains unaccepted; request narrow consistency fixes and deterministic regression coverage on the same Pi session before advancing.

Repair `msg-c7-portable-bindings-repair-r1-assign` is persisted and submitted once through product explicit-caller notification to the original Pi pane/session. Pinned artifacts are under `/private/tmp/pappra-pi-batch-1-1792543809003/c7-portable-bindings-repair-r1`. Require fresh new-assignment preflight before source writes and await the proactive REPORT; no timer, polling, completion wait or native fallback is scheduled.

[C7 acceptance](reviews/c7-portable-bindings-acceptance.md): repair delivery/50-file manifest verified; independent type checking/build and 162 relevant tests passed. All three original fixture reproductions now produce the required safe outcomes. Portable bindings remain metadata/history only.

## C8 direction: native lifecycle design discovery

[Read-only contract](reviews/c8-native-lifecycle-discovery-direction.md) requires a concrete installed-surface/ownership matrix and minimal implementation proposals against retained native adapters and legacy behavior. Resolve owned-handle lifetime, daily runtime configuration preservation, explicit prepare identities and clean-package workflow verification before adding control surfaces. No source implementation or native/model launch is included in this discovery assignment. Downstream init/knowledge improvements remain queued.

Assignment `msg-c8-native-lifecycle-discovery-assign` is persisted and submitted once through product explicit-caller notification to the same Pi pane/native session. Pinned direction/input/baseline and legacy references are under `/private/tmp/pappra-pi-batch-1-1792543809003/c8-native-lifecycle-discovery`. Require new-assignment readiness, read-only source investigation and one proactive REPORT; no timer, polling, completion wait or native fallback is scheduled.

[C8 review](reviews/c8-native-lifecycle-discovery-review.md): investigation accepted with verified 38-file evidence and unchanged 50-file baseline. This is not native-host parity acceptance. Retained owned handles, persisted history and provider-specific matching remain distinct. Do not expose the isolated pilot as a daily-runtime default. Sequence cancellation-intent correction, explicit preparation contract, bounded history/control gaps and clean installed-workflow verification before downstream init work.

## C9 direction: single owned cancellation intent

[Implementation contract](reviews/c9-cancel-intent-direction.md) preserves the driver's before-native intent gate and standalone Pi cancellation while propagating a verified registered intent through the composed stack. First reproduce with fake Pi; reuse one correlated applied CANCEL without a bypass boolean or native-owner adoption. No new controllers, prepare/MCP changes, real native control or downstream init work in this slice.

Assignment `msg-c9-cancel-intent-assign` is persisted and submitted once through product explicit-caller notification to the original Pi pane/session. Pinned artifacts are under `/private/tmp/pappra-pi-batch-1-1792543809003/c9-cancel-intent`. Three additional exact-file epoch-1 claims for the owned Pi adapter and its existing host/fake tests were explicitly acquired through the product resource API and pinned in the assignment, extending the prior source scopes without transferring ownership. Require new-assignment readiness before source writes. Await one proactive REPORT or concrete BLOCK, without timers, polling, completion waits or native fallback.

[C9 acceptance](reviews/c9-cancel-intent-acceptance.md): six-file delivery and unchanged 50-file baseline verified; independent type checking/build and 166 relevant tests passed. One applied intent crosses the composed owned Pi stack; invalid references do not authorize native cancellation. No real native stop parity is claimed.

## C10 direction: explicit preparation

[Implementation contract](reviews/c10-explicit-preparation-direction.md) unifies MCP preparation on the shared explicit goal, removes guessed runtime/card synthesis, validates independent cwd before writes, and preserves explicit roles and supported harness runner metadata. The old flat MCP input/output is deliberately retired with migration documentation. No new native controller is included. Installed-workflow and history/control gaps remain subsequent work, before downstream init/knowledge improvements.

Assignment `msg-c10-explicit-preparation-assign` is persisted and submitted once through product explicit-caller notification to the original Pi pane/session. Pinned artifacts and a combined 56-file source baseline are under `/private/tmp/pappra-pi-batch-1-1792543809003/c10-explicit-preparation`. Three exact-file epoch-1 claims for MCP server, MCP integration tests and agent-native documentation were acquired through the product resource API and pinned alongside existing scopes. Require fresh new-assignment readiness before source writes; await one proactive REPORT or concrete BLOCK without timers, polling, completion waits or native fallback.

C10 REPORT/61-file manifest and helper deletion verified. [Review round 1](reviews/c10-explicit-preparation-r1.md) reproduces inherited runner-map keys (`constructor`, `toString`, `__proto__`) being accepted and creating task/claim artifacts with malformed runner metadata. C10 remains unaccepted; request a narrow shared lookup/early-refusal correction and regression coverage before advancing.

Independent type checking/build and 173 relevant tests passed; the inherited-key reproduction remains outside that passing coverage. Repair `msg-c10-explicit-preparation-repair-r1-assign` is persisted and submitted once through product explicit-caller notification to the original Pi pane/session. Pinned review/baseline/reproducer/input are under `/private/tmp/pappra-pi-batch-1-1792543809003/c10-explicit-preparation-repair-r1`. Require new-assignment readiness before source writes, and await one proactive REPORT without timers, polling, completion waits or native fallback.

C10 R1 source verification passes: all 62 current files match, the original three inherited-key probes refuse before creating a domain, and independent type checking/build plus 175 relevant tests pass. [Evidence review](reviews/c10-explicit-preparation-evidence-review.md) records one incorrect baseline-manifest digest in the REPORT/prose; the actual pinned file is unchanged. One product message `msg-c10-explicit-preparation-evidence-correction-request` was submitted to request an immutable correction REPORT with the same assignment/input. No source revision, repeat implementation or new claims are requested. Final delivery acceptance awaits corrected evidence; no polling or completion timer is scheduled.

[C10 acceptance](reviews/c10-explicit-preparation-acceptance.md): immutable correction REPORT and all outputs verified; original artifacts remain preserved and all 62 current files are unchanged. The corrected baseline digest closes the evidence issue. Independent source validation remains 175 relevant passing tests plus type checking/build.

## C11 direction: clean installed workflow

[Verification contract](reviews/c11-installed-workflow-direction.md) requires a task-local tarball/consumer and packaged CLI/MCP walkthrough from unrelated cwd, with explicit fixtures, no checkout runtime imports and no real native/model operations. Validate representative persisted protocol/binding/message behavior and negative branches; record remaining library-only and live-host gaps honestly. Source fixes are not authorized in this verification slice; concrete failures return for coordinator direction. Full extraction parity and downstream init/knowledge work remain open.

Assignment `msg-c11-installed-workflow-assign` is persisted and submitted once through product explicit-caller notification to the original Pi pane/session. Pinned direction/input/source baseline are under `/private/tmp/pappra-pi-batch-1-1792543809003/c11-installed-workflow`. Require new-assignment readiness and read-only checkout behavior; only task-local consumer/fixture/evidence writes are authorized. Await one proactive REPORT or concrete BLOCK without timers, polling, completion waits or native fallback.

[C11 acceptance](reviews/c11-installed-workflow-acceptance.md): delivery/artifact digests and unchanged 62-file manifest verified; coordinator independently repeated the clean offline consumer install and complete packaged CLI/stdio-MCP probe successfully. Help inaccuracies and missing full visible-peer bootstrap guidance remain concrete follow-ups; native three-host/history/control parity is not claimed.

## C12 direction: visible workflow entry and help

[Implementation contract](reviews/c12-visible-workflow-direction.md) restores discoverable environment selection, authorized focus-preserving peer bootstrap/reuse, binding/readiness, product-message dispatch and proactive result review guidance. Keep native daily configuration, exact routing versus ownership limits and no-polling behavior. Correct MCP/global help omissions without adding launch/control behavior. Full extraction gaps and downstream init/knowledge work remain tracked separately.

Assignment `msg-c12-visible-workflow-assign` is persisted and submitted once through product explicit-caller notification to the original Pi pane/session. Pinned direction/input/62-file baseline and immutable legacy skill/environment/runbook snapshots are under `/private/tmp/pappra-pi-batch-1-1792543809003/c12-visible-workflow`. Existing CLI/skill/docs claims cover this scope; require fresh new-assignment readiness before writes. Await one proactive REPORT or concrete BLOCK without timers, polling, completion waits or native fallback.

C12 REPORT/67-file manifest verified. [Review round 1](reviews/c12-visible-workflow-r1.md) requests documentation-only corrections: prepare falsely described as plan-only, incomplete derive/card and already-registered ASSIGN flow, and missing actionable first discovery contact/ACK/result return. Help/discoverability improvements are sound; no CLI behavior change is requested. C12 remains unaccepted pending the corrected operational recipe and accurate desk-walkthrough limits.

Four independent focused help/mirror tests pass after test compilation; actual prepare help confirms no --apply/plan option. Repair `msg-c12-visible-workflow-repair-r1-assign` is persisted and submitted once through product explicit-caller notification to the same Pi pane/session. Pinned review/baseline/input are under `/private/tmp/pappra-pi-batch-1-1792543809003/c12-visible-workflow-repair-r1`. Require new-assignment readiness before docs writes; await one proactive REPORT without timers, polling, completion waits or native fallback.

C12 R1 workflow corrections and all delivery/67-file digests verify. [Final snippet review](reviews/c12-visible-workflow-r2.md) identifies POSIX backslashes passed literally in the fenced Nushell derivation example; the JavaScript desk test did not execute that shell boundary. Request only native Nu syntax correction and actual extracted/substituted snippet validation with fixtures, plus formatting/mirror checks. No repeated full suite or implementation is requested; acceptance awaits the runnable recipe.

Repair `msg-c12-visible-workflow-repair-r2-assign` is persisted and submitted once through product explicit-caller notification to the same Pi pane/session. Pinned review/baseline/argv-reproducer/input are under `/private/tmp/pappra-pi-batch-1-1792543809003/c12-visible-workflow-repair-r2`. Require new-assignment readiness before docs writes; await one proactive REPORT without timers, polling, completion waits or native fallback.

[C12 acceptance](reviews/c12-visible-workflow-acceptance.md): delivery/artifact digests and all 67 files verify; coordinator independently repeated offline consumer installation and actual Nu snippet checks successfully. The report's initial-before-preflight trial edits remain an ordering deviation even though restored/reapplied before final delivery. Daily visible-peer/message and installed entry/help baseline is accepted. Library-only native/history controls and current three-host/version verification remain open, not reclassified as complete. Resume the original workspace reliability work using the same product messaging route.
