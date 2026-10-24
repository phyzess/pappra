# Managed provider network diagnostics

The pinned managed SDK runtime observes its per-request fetch boundary before Pi
AI reduces transport errors to a generic transcript message. It preserves the
configured provider/model, native retry policy, caller-supplied fetch, request
arguments, cancellation signal, original response/body and original error. It
does not replace global fetch, add a probe request or retry a failed effect.

The existing private hash-chained session journal records:

- `sdk_provider_run_admitted`: a local `provider_call_id` correlates one SDK
  provider invocation with its fetch observations.
- `sdk_provider_fetch_started`: a distinct local `fetch_id` for each HTTP attempt.
- `sdk_provider_fetch_response`: HTTP status, latency to response headers in
  `headers_elapsed_ms`, and a bounded remote `request_id` when supplied in
  `x-request-id`, `request-id` or `x-openrouter-request-id`. Missing IDs stay null.
- `sdk_provider_fetch_failed`: elapsed milliseconds, the observed abort-signal
  state, and up to four redacted error/cause entries containing recognized error
  names, errno/code and syscall. Cycles and unusual getters are bounded.
- `sdk_provider_message_observed`: the native assistant message's safe terminal
  reason, total SDK provider-call duration and provider `response_id` when the SDK
  supplies one. An OpenRouter generation ID is a response ID; it is not relabeled
  as an HTTP request-ID header.

Diagnostic records exclude request/response bodies, prompts, full URLs, hostnames,
authorization headers, proxy configuration and raw exception messages. Only the
named request-ID response headers are inspected; secret-shaped or malformed IDs
are omitted. The helper returns the original response without reading or wrapping
its stream, and rethrows the original error. A diagnostic sink failure must not
convert a successful admitted response into a new failed/retriable request; the
managed controller fences future work if its journal becomes unavailable.

Header latency is not total stream duration; message observations separately time
the provider call through its terminal message. Native agent/tool lifecycle
events establish later work boundaries. A stream failure after response headers
may already be flattened by the SDK; preserving the original response stream
means this fetch observer cannot promise an errno for that later failure.
An aborted signal does not by
itself identify whether the user, coordinator, timeout or provider caused an
interruption. Likewise, a diagnostic errno is not an authoritative no-effect
receipt and cannot authorize replay. Recovery still uses its explicit ownership,
checkpoint, task-authority and unresolved-effect gates.

These observations help diagnose a future recurrence of the historical generic
connection errors. They cannot recover details that the original transcripts did
not preserve. See [the historical investigation](reviews/README.md).
