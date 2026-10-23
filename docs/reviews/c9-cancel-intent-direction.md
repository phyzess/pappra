# C9: one cancellation intent across the owned Pi stack

Scope: repair the existing JSONL driver → PiRpcController → owned Pi RPC cancellation path. Do not add native controllers, CLI commands, durable owners, MCP preparation changes or global settings. Preserve the visible peer/message collaboration loop.

## Problem and chosen ownership

`driveRun` records an applied CANCEL before invoking the controller. `PiRpcController` then calls the owned Pi handle, whose standalone `cancel` records another CANCEL with a fresh message ID. Confirm the composed path with a deterministic fake-Pi regression before changing it. Record the actual message/uncertainty behavior; do not assume uncertainty duplication if the primitive deduplicates it.

Keep the driver responsible for recording the intent before a controller/native call. Preserve refusal when that submission fails. The lower Pi handle must reuse a verifiably registered correlated intent when invoked through the driver, while standalone owned-handle `cancel()` continues to register its own intent before any queue clearing or abort.

Use a narrow optional cancellation context/reference through ControllerSession and PiRpcController to the Pi handle. A bare `alreadyRecorded: true` or skip-registration boolean is insufficient. The Pi layer must verify the supplied registered envelope/digest and applied record registration against its current task, coordinator, recipient, subtask, attempt and owner epoch. Rejected, missing, foreign, tampered or stale intent must cause no native queue/abort calls and no replacement CANCEL. Reuse existing safe message-reader/store primitives and namespace guards; do not invent another message authority store. Exact context representation is an implementation detail; document its constraints in the report.

Current native handle, namespace and live identity/authority checks still apply even after intent validation. Passing a valid intent does not grant native ownership. Do not replay/reapply CANCEL merely to validate it. Keep source/library compatibility for standalone cancellation and fixture/custom controllers where possible; if a real incompatible API constraint arises, report it before broadening scope.

## Observable behavior and validation

- One accepted driver cancellation request records exactly one CANCEL, and its ID is the one used by native cancellation evidence. The composed fake-Pi path issues exactly one abort and preserves existing clear-queue behavior.
- Standalone owned Pi cancellation still records exactly one intent. Denied registration never calls the native controller; supplied invalid/stale/foreign context never reaches queue clearing/abort. Exercise a rejected or missing registered intent, identity/epoch mismatch and tampering through meaningful deterministic fixtures.
- Native failure after a recorded intent retains cancel-pending claims and cancellation uncertainty, with honest observable failure/uncertainty. Do not invent terminal success, send CANCELLED, release claims or retry automatically. Preserve existing cancellation result classifications unless a directly reproduced reporting defect requires a narrow correction.
- Ordinary query/finish/disposal, Pi daily MCP/tool/hook/model preservation and standalone APIs retain their behavior. Run relevant host and collaboration tests, type checking/build, source/package/mirror/changed-format checks. Do not widen to unrelated cleanup or the preserved reliability patch.
- Tests run only on fresh fixture domains and fake executables. No real native launch/query/abort/stop, live task cancellation, pane operation, focus change, user workspace binding mutation, dependency/global/config change or model invocation.

Same Pi session and current source claims. Preflight this new pinned assignment using actual fresh same-session evidence before source writes. Preserve coordinator plans/reviews. Return the before/after reproduction, chosen context contract, current manifest, pinned input, readiness evidence and validations in a professional-English report through one proactive product REPORT/notification. No polling, completion timer, blocking `--wait`, native fallback or automatic retry.
