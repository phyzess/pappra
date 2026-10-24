# OpenRouter Luna connection errors — v6 investigation

Date: 2026-10-24

## Finding

The strongest supported classification for the original two sessions' failures around 01:48 UTC is a **transport/connection-path error surfaced by Pi AI's OpenAI-compatible OpenRouter client**, not an observed HTTP rejection from OpenRouter and not a coordinator-issued abort. The exact underlying cause is **unverified**: the durable transcript records only `Connection error.` and omits the low-level cause, request ID, and HTTP status.

The local transcript records and installed SDK error path support that classification. They do not identify whether the failure arose from DNS, socket/TLS, proxy/dispatcher, an upstream connection failure, or another fetch-level cause.

## Sanitized transcript evidence

The original transcript records identify provider `openrouter`, model `openai/gpt-6-luna`, and API `openai-completions` for the errors. Relevant failures:

| Session | Transcript event timestamp (UTC) | Assistant message timestamp (UTC) | Duration | Recorded result |
| --- | --- | --- | ---: | --- |
| `01a16b6f-7145-7329-9830-521555604eb6` | 01:48:40.573 | 01:47:28.403 | 72,178 ms | `stopReason: error`; `errorMessage: Connection error.` |
| `01a16b6f-7158-7666-80b5-5e3a4a72f71f` | 01:48:33.433 | 01:47:32.499 | 60,935 ms | `stopReason: error`; `errorMessage: Connection error.` |
| `01a16b6f-7158-7666-80b5-5e3a4a72f71f` | 01:48:55.366 | 01:48:35.477 | 19,884 ms | `stopReason: error`; `errorMessage: Connection error.` |

Each has empty content and zero token usage. The records contain no HTTP status, response ID, request ID, raw stop reason, or nested transport errno. The other session also contains earlier same-class errors at 01:26:54 and 01:28:29 UTC; these establish recurrence, not a more specific cause.

## Why this indicates transport, not HTTP rejection

The installed `@earendil-works/pi-ai` 1.4.0 implementation (`dist/api/openai-completions.js`) calls the OpenAI-compatible endpoint, then on catch sets `stopReason` to `error` (unless its signal is aborted) and stores `formatProviderError(normalizeProviderError(error))` as `errorMessage`. Its normalizer (`dist/utils/error-body.js`) extracts an HTTP status and body only when present; with neither, it preserves the original error message.

The installed OpenAI client 7.19.0 distinguishes these paths in `src/client.ts`: a rejected fetch is converted to an `APIConnectionError` carrying the lower-level error as `cause`; an HTTP response instead follows the response-status path and becomes a status error. In `src/core/error.ts`, `APIConnectionError` has undefined status/headers and defaults to the exact text `Connection error.`. Pi AI's transcript-facing normalization does not preserve that error's `cause`, which explains why the durable records cannot show the errno. Therefore the evidence supports failure before Pi AI received a usable HTTP response. It does **not** prove the remote OpenRouter service was healthy or pinpoint which network hop failed.

## Separate coordinator action

The transcripts contain later assistant `stopReason: aborted` events at approximately 01:50:32 UTC, after the connection-error records. The v3 acceptance investigation explicitly identifies the subsequent abort/Ctrl+D actions as coordinator-issued, not observed Pi crashes; v5 repeats that distinction. These later lifecycle actions must not be recast as the cause of the earlier transport errors or as spontaneous native-process crashes. The separate controlled connection-refusal scenario in v5 is not evidence that these two historical requests had the same errno.

## Evidence boundary and next diagnostics

This historical investigation did not issue a new probe: present-day connectivity cannot recover the missing cause of a historical request. No original session prompt was replayed, and the two sessions' native histories and configuration were unchanged. The separately authorized isolated network acceptance is documented in [v6 lifecycle acceptance](managed-session-v6-acceptance.md); its errno is not evidence of this historical cause.

The user subsequently authorized [minimal provider diagnostics](../managed-provider-diagnostics.md). The managed SDK now records bounded recognized error/cause names, errno/code and syscall, response-header latency/status, supplied request IDs, and native response IDs with terminal-call duration. Raw exception messages, URLs, credentials and bodies are excluded. Missing identifiers remain null. The observer preserves the original response stream, so it does not measure first-byte latency or guarantee an errno for an error flattened after response headers. An aborted signal alone does not identify the cancellation origin. These diagnostics supply future evidence; they do not authorize retry or establish the original root cause.
