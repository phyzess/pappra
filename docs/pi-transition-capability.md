# Pi 1.3.0 transition capability: unsupported dependency

**Result:** the installed Pi host cannot supply the complete, replay-safe native quiescence proof required by `SessionTransitionHost.observe/freeze`. This is a version-pinned dependency finding, not a closed rollover path. Do not promote an idle/settled event, a managed-tool latch, an RPC queue count, or an `abort()` completion into source-stop proof.

## Installed API evidence

The fresh visible runtime was Pi **1.3.0**. Its packaged `docs/extensions.md` documents lifecycle/message/tool callbacks, including `agent_settled` as final notification-only; it also notes automatic retries/recovery/compaction/queued work can follow `agent_end`. Extension commands receive an `ExtensionCommandContext` with wait-until-idle, reload and session-replacement operations, and extensions may request `ctx.shutdown()`. These are not a complete queue/approval inventory, an all-writer fence, or an acknowledged process-stop receipt. The extension surface exposes no documented operation for those facts.

The same package's `docs/sdk.md` describes a distinct `AgentSession` surface: it owns queued messages, offers current `session.messages`, `abort()`/`waitForIdle()`, and emits queue events. `abort()` stops the active operation and waits for idle; it is not process termination or a complete queue snapshot. The extension context does not provide this `AgentSession` handle. The local binary package declares `dist/index.js` and `dist/index.d.ts`, but the installed package directory has no `dist/` tree, so this installation supplies no SDK module or declarations to safely bind from the opt-in extension.

The documented RPC surface is also insufficient for the current interactive source:

- `get_state` reports `sessionId`, `isStreaming`, `isCompacting`, and `pendingMessageCount`, not the queued payloads, pending approvals, all active writers, or a completion receipt.
- `clear_queue` returns and removes steering/follow-up text only; it is not an atomic freeze and does not prove that other input sources cannot enqueue after the call.
- `abort` waits for idle, and the RPC docs explicitly warn that queued messages may continue if not removed. Closing stdin requests orderly shutdown; only a controller that owns the child can subsequently observe that child's exit.

Thus no documented installed API provides a correlated, fresh, complete inventory of pending messages/approvals and in-flight work, atomically fences every writer, and confirms stop for the exact source session/process. Extension callbacks cannot establish external-writer ownership or an OS-level fence. The smallest upstream contract that would close this gap is a public session-quiesce operation that atomically fences all ingress and returns the complete recoverable pending-work/approval inventory plus active-work identities under the exact session, cwd, freeze token and monotone evidence sequence, followed by an authenticated stop receipt for that same source. An independently owned controller is only an alternative for sessions it launches and exclusively owns: it must mediate all ingress, retain/capture pending work, fence further input, then await exit of its exact child. That does **not** retroactively prove quiescence of this interactive Pi session.

## Local bridge boundary

`src/hosts/integration/pi-session-transition-extension.ts` already reports `pi_native_quiescence_proof_unavailable`; its existing managed-tool freeze is not native or external-writer stop proof. `src/hosts/integration/pi-native-events.ts` tracks only supported in-process observations: queue and approvals remain `unknown`, in-flight completeness remains `unknown`, and `nativeStop` is always `false`. No adapter or test-only proof was added. The existing owned RPC controller in `src/hosts/pi/rpc.ts` can stop only the child it launched; its documented scope excludes arbitrary background/descendant writers and it is not the current extension-bound interactive source.

## Pinned sources

All installed Pi files below are from `/Users/zimm.yu/.local/share/pi-1.3.0/pi`:

- `package.json` — `@earendil-works/pi-coding-agent@1.3.0`, SDK export paths; SHA-256 `83c3bb7619f590c213cc96a24216eb29a819a3ef6dc548607cc037ed276e8dc5`.
- `docs/extensions.md` — event/extension API boundary; SHA-256 `a2b5ff0f95e7e470ed0846d7c4fbfc5781fe7e694b8e7f51ea08859f3ad7325d`.
- `docs/sdk.md` — `AgentSession`, queues, abort and lifecycle; SHA-256 `d9034ccbf2219a58712d8dd4fcdf47e687d77131e71dd5d119d8a71e9bd2a2e8`.
- `docs/rpc-commands.md` — `get_state`, `clear_queue`, and `abort`; SHA-256 `4deeee367852f4633ef594bc079f9e9fb14640a4e3ba8a69b7c89b6f54740838`.
- `docs/rpc.md` — RPC event and child shutdown boundary; SHA-256 `37a03d180115460a0a275022f4aeabef1e5345458df6a9b6e8a6de18474de720`.
- `examples/extensions/send-user-message.ts` — steer/follow-up submission only; SHA-256 `9261e433c782f354530105e1c9723a19798868f72fd1f5d68af3a4624ad7e446`.

Local implementation pins:

- `src/hosts/integration/pi-session-transition-extension.ts` — SHA-256 `19142bb7c141c17a36bf9fa293575328b3f3d4f07fe7d449e08b49940fa5d2bd`.
- `src/hosts/integration/pi-native-events.ts` — SHA-256 `c2ddeeb3ba8c93b7de3b2ead85067f4ba2e673eda5a07da61224a971771c7107`.
- `src/hosts/pi/rpc.ts` — SHA-256 `aae0f980b5a87a4757e0a77f929a79dca1efa35423a6710c0dd7b06dfb162124`.
- `docs/pi-rpc.md` — SHA-256 `a6ffb4bedf6b3c74f0ded36aa3a370571ec219b221b0bdc5d258bd200743d543`.

## Assignment evidence

- Fresh visible session: Pi 1.3.0, `openrouter` / `openai/gpt-6-luna`, medium thinking, session `886b4ca7-e25e-44ff-82a6-413ee01cdaa6`, pane `w3:p5`. The saved startup observation and launch record are pinned in `/private/tmp/pappra-pi-batch-1-1792543809003/pi-transition-capability/`; the runtime card is `card.runtime.json`, SHA-256 `2568bf6bd37ac39ca5a8c9492e12a81686f67fbfdd358531a831b8a1d1eb586a`.
- Matching read-only product preflight at `2026-10-23T06:18:19.315Z`: `ready`, no blockers/errors; warning `resource_ownership_not_enforced`. This is reported runtime readiness only, not authorization or resource locking.
- Read-only current claim listing showed all five assigned epoch-4 claims live (`released_at: null`): `claim-path-f8f493f7a6a677125de99cb0719e31d3-4`, `claim-path-e25a359920f640f581ec8f3569968990-4`, `claim-path-0478023bf70a1835fa722347d31ddfa1-4`, `claim-path-9a2705ff49cc17e92dd205b8cf6b21e1-4`, and `claim-path-9c850fb7faa84c1da4ef473b051b7839-4`.

**Disposition:** keep the accepted core guards unchanged and leave the production adapter blocked. Tests with injected complete proofs would prove ordering only, not installed Pi support; no such cosmetic adapter was added. Functional rollover acceptance remains pending the upstream quiescence/stop capability or a separately authorized, fully ingress-owning controller.
