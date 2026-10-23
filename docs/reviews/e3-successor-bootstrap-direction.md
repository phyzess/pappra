# Successor bootstrap tool gate

The corrected integration matrix is accepted as a bounded gap inventory, not as an executable rollover design. STATUS `msg-e3-explicit-rollover-map-r1-status`, delivery `sha256:c21328db2a38af1bfa118e7679cf02d58c48609034b7ceb0c4e22ab8c1843ea8`, its two outputs and nested card evidence are verified. Preserve withdrawn claims. Two residual proposals are rejected without another correction round: the no-thaw old-writer freeze cannot be used as a releasable successor gate, and a partial RPC inventory cannot drive successful transfer through a reducer that requires complete inventory.

Next implement **only an opt-in successor bootstrap managed-tool gate**. This closes one concrete integration prerequisite, while old-writer control, durable trusted reader installation and actual visible workflow remain separate. Do not implement a transfer action or infer a stop.

## Exact scope and contract

- New `src/hosts/integration/pi-bootstrap-guard.ts`.
- New `tests/hosts/pi-bootstrap-guard.test.ts`.

Reuse the installed Pi structural `tool_call` blocking contract and the vetted native-read tool set from the accepted freeze module. Keep that module, its test, native-event producer, core rollover and public inspection unchanged. No package export/default host installer/CLI/settings change in this slice.

Register the guard before any model work. It starts denied for every non-vetted-read managed tool (bash/write/edit/custom included). It does not remove tools, MCP, skills or hooks. Unknown/malformed native session identity blocks even reads. Registration configuration is private trusted host integration code, not model input or a slash-command token. No model-accessible allow/thaw/release method or boolean authorization callback.

Inputs pin task ID, intent ID, handoff ID, generation, subtask/attempt, input revision, coordinator epoch, expected successor agent/native session/harness and exact original claim IDs/resource epochs. Copy/validate bounded options; caller mutation must not change the configured identity. Every callback reads actual `ctx.sessionManager.getSessionId()` safely. Expose conservative structured status/reason, with no mutable outward aliases.

For non-read tools, obtain a **current full task record** through an explicitly trusted, read-only host-adapter callback supplied at registration. The callback returns record data, never `allowed:true`, a self-signed token or invented stop proof. Validate record/schema/bounds before traversal using existing APIs. Document this dependency boundary: caller-supplied records in tests are fixtures; this slice does not authenticate a filesystem/remote source, establish freshness against a dishonest adapter or install a durable reader. Do not label it complete native authorization. A later real adapter must bind and read the actual task domain safely.

Allow a non-read tool only when the current validated record matches all pinned identities and shows the **completed writer handoff**, exact pinned rollover intent and transfer boundary, current non-superseded writer attempt reassigned to this successor with confirmed native binding, unchanged input/coordinator epoch, every original claim still active and held by the successor at original resource_epoch+1, and no conflicting active handoff/blocked or terminal writer state. Reuse existing read-only rollover validation/inspection where it fits rather than invent another state machine. Do not require a first-work REPORT to permit the first write: that proof comes afterward. Do not confuse coordinator epoch with per-claim resource epochs.

No permanent unlock: re-read and revalidate on every non-read callback. Read failure, malformed/stale/drifting/partial evidence or native mismatch blocks conservatively; an earlier successful tool call grants nothing to a later one. Recheck native session after any asynchronous reader operation and before returning allow. Keep overlapping asynchronous callbacks isolated; never cache an allow decision from another request. There is no filesystem write fence or lock covering the tool's later execution: document check/use and background/external-process limits. No claim that record checks alone solve native stop or cross-process fencing.

Prefer a small pure decision helper plus actual registered host callback. No additional authority store, protocol/schema changes, snapshot signing, timer/watcher, spawned command, transcript access, network or model call. No code path mutates claims, epochs, handoffs, bindings, messages, bundle or archive. Do not feed caller observations into the old freeze controller.

## Verification

Use genuine deterministic protocol fixtures to reach receiver-confirmed and completed transfer states. Invoke the registered `tool_call` callback with real host-shaped contexts. Show non-read tools blocked before transfer, first write allowed only after all current record conditions match, and immediately refused after claim release/reassignment/epoch drift, new attempt, native/input/coordinator drift, active handoff or reader failure. Test malformed/accessor-throwing inputs, copied options/status, delayed-reader native switch and overlapping callbacks with different authority states. Verify no automatic release command and no dependency on first-work completion. Vetted reads remain usable only for the exact native session.

Private focused compile/tests/type/format/source-policy checks only; no full suite/package/native fixture/install/global settings/dependency/model/pane/session/commit/publication actions. Check accepted adjacent file hashes before and after. Report output/source hashes and counts proactively. This is an implementation assignment only after matching fresh coordinator preflight and exact two new path claims. No self-acceptance, hidden worker, completion polling or timer.
