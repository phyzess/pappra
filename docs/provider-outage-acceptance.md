# Native OpenRouter provider-stream interruption acceptance probe

## Scope and proof boundary

`tests/collab/provider-outage.test.ts` is an opt-in integration probe of Pappra's recovery
journal using a fresh native Pi 1.4.0 managed SDK session. The worker calls Pappra's
`startManagedPiSdkSession` with the exact pinned SDK module, preserving normal daily services,
extensions and OpenRouter configuration. It does not extract or print credentials. The wrapper
awaits the potentially asynchronous `AgentSession.agent.streamFunction` result, then observes
its original `AsyncIterable` until a non-empty `text_delta`. It combines the owned abort signal
with the existing signal. The default leaves native transport unchanged;
`PAPPRA_PROVIDER_OUTAGE_FETCH_HOOK=1` optionally enables a per-request fetch hook.

The task is fixed and harmless: "Reply exactly OK. Do not call tools or write files." The test
disables active tools, pins `openrouter/openai/gpt-6-luna`, and sets `maxTokens: 1024` and
`maxRetries: 0`. The optional fetch hook permits only
`https://openrouter.ai/api/v1/chat/completions`, uses unmodified `globalThis.fetch`, and refuses
a second hooked request. A second native stream call is always refused. No machine networking,
proxy, global dispatcher or SDK/user configuration is changed.

The worker aborts only its one owned native stream after either an intercepted HTTP 200 plus
first response bytes, or the first non-empty native `text_delta` if the adapter bypasses the
fetch hook. It records the witness type explicitly and exits only its owned provider worker. The
parent verifies that the recovery reservation contains one unresolved intent, starts a distinct
restart process, and proves that Pappra reports `unknown`, makes zero controller calls, and does
not redeliver. It asserts HTTP 200 only for a fetch-hook witness that actually observed status
200; a `text_delta` witness proves native response content only, not HTTP status or
response-body transport bytes. Both are client-induced abort/process-exit cases, never evidence
of a server-caused outage.

The durable evidence file contains only native session identity/model/pane metadata, one
stream-admission count, witness event type and byte count, streaming state, optional HTTP
status/host/path when the hook actually observes them, and the restart disposition/call counts.
A text-delta-only witness is not reported as HTTP 200. Evidence contains no prompt, response
body, delta text, headers, authorization value, or API key. It is created with mode `0600` in a
private scratch directory; the test fixture containing the recovery journal is otherwise
removed. A real provider request may incur charges, bounded by one native stream and the
configured token cap.

## Visibility and safe execution

Run the probe only from a newly created, visibly rendered, owned Herdr test pane. Do not reuse
the caller or root pane; record their ids as forbidden inputs. Set
`PAPPRA_PROVIDER_OUTAGE_PANE_ID` to that owned pane's actual id. The provider worker inherits the
pane's stdio so the native Pi TUI remains visible. It creates a fresh native session and
disposes/terminates only its own worker process; it never targets other sessions. While that
native TUI is alive, the parent runs only `herdr pane get <PANE_ID>` and
`herdr pane process-info --pane <PANE_ID>` for this supplied pane. Evidence retains an
allowlisted/sanitized field projection plus hashes, not raw process arguments or environment;
the process label is never modified. The worker validates the pane-id shape and rejects the
caller/root ids, but it cannot independently ask Herdr whether a supplied pane id is visible:
visibility and ownership remain operator preconditions.

The probe requires all of the following:

- `PAPPRA_PROVIDER_OUTAGE=1`;
- `PAPPRA_PROVIDER_OUTAGE_SDK_MODULE` set to the absolute entrypoint of the pinned
  `@earendil-works/pi-coding-agent@1.4.0` build you intend to exercise;
- `PAPPRA_PROVIDER_OUTAGE_PANE_ID` set to a newly owned visible test-pane id;
- `PAPPRA_PROVIDER_OUTAGE_EVIDENCE_FILE` set to a **new, not-yet-existing** path in private
  scratch storage.

The test refuses to start if HTTP(S)/ALL proxy environment variables are set. Use no API-key
environment variable: credentials remain inside the daily managed SDK services/extensions.
Compile only the owned probe and its imports to a fresh temporary directory, then run only the
compiled test from the owned pane. Do not use a shared build directory, `pnpm exec`, or the full
suite.

```nu
let temp = (mktemp -d -p $env.TMPDIR pappra-provider-outage.XXXXXX)
try {
  let sdk = "<absolute pinned pi-coding-agent 1.4.0 entrypoint>"
  ^node_modules/.bin/tsc --target ES2023 --lib ES2023,DOM --module NodeNext --moduleResolution NodeNext --types node --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noImplicitOverride --noFallthroughCasesInSwitch --noUnusedLocals --noUnusedParameters --verbatimModuleSyntax --isolatedModules --forceConsistentCasingInFileNames --skipLibCheck --noEmitOnError --sourceMap --declaration --rootDir . --outDir $"($temp)/out" tests/collab/provider-outage.test.ts tests/collab/provider-outage-worker.ts
  '{"type":"module"}' | save --raw $"($temp)/out/package.json"
  with-env {
    PAPPRA_PROVIDER_OUTAGE: '1'
    PAPPRA_PROVIDER_OUTAGE_SDK_MODULE: $sdk
    PAPPRA_PROVIDER_OUTAGE_PANE_ID: $env.PAPPRA_PROVIDER_OUTAGE_PANE_ID
    PAPPRA_PROVIDER_OUTAGE_EVIDENCE_FILE: $"($temp)/evidence.jsonl"
  } {
    ^node --test $"($temp)/out/tests/collab/provider-outage.test.js"
  }
} finally {
  rm -rf $temp
}
```

On success the test prints `NATIVE_PROVIDER_OUTAGE_EVIDENCE` followed by the exact retained
path. Do not place credentials in command text or terminal output.

## Existing no-effect retry coverage

`tests/collab/recovery-network-restart.test.ts` separately proves the known-no-effect
continuation path using loopback only: `ECONNREFUSED` before connect, `bytesSent: false`, then
one bounded retry when the controlled service becomes available. This is valid executor/retry
evidence, but it does not establish provider authentication, TLS, OpenRouter stream behavior,
or provider recovery. The ambiguous native-provider case above must remain unknown and must not
redeliver.

## Bounded observations so far

- A normal native prompt control completed through OpenRouter with `stopReason: stop` and
  `stop: runtime_disposed`. This proves a normal native request only; it does not prove an
  interrupted stream or restart behavior. Session identifiers and paths stay private.
- One opt-in run passed in 7.3 seconds: a fresh native session observed OpenRouter Luna and one
  admitted stream, then a two-byte `text_delta` while both native streaming indicators were
  true. The owned worker aborted that stream and exited with code 86. A distinct restart process
  reported `unknown`, zero controller calls and zero redeliveries. This is a native
  text-content witness; it does not assert HTTP status or an exact count of underlying provider
  HTTP attempts.
- Earlier failures are retained rather than promoted into acceptance. The probe itself
  incorrectly treated an asynchronous stream factory as a synchronous iterator; awaiting the
  factory result fixed that integration bug. One earlier attempt timed out inside the
  response-witness window, and a later attempt with a longer window also failed acceptance. A
  late HTTP 200 arrived after streaming ended and did not establish active-stream interruption;
  the parent failed before restart. The current probe rejects late witnesses, forwards
  cancellation to an optional fetch hook, disposes unsuccessful owned runtimes and retains
  failure observations.

## Current verification status and limitations

Final native-path acceptance uses the successful text-delta run above. Still unverified:

- an exact provider HTTP status witness for the abort path (the successful run is a
  text-delta witness);
- recursive SDK successor launch;
- host identity publication through the pane inspection path (a terminal title is not identity
  proof);
- any claim that a provider response implies task completion.

Read-only Herdr observations while the SDK runtime was alive found a Pi terminal title but no
recognized Pi agent/session identity through `pane get`; a title alone is not identity proof.
The abrupt test-worker exit left delayed terminal color-query replies at the shell prompt. The
operator cleared only that owned pane's input before a subsequent command. That is a
test-terminal cleanup issue, not evidence that unrelated Pi sessions crashed. No machine network
settings, proxy configuration, guardrails or credentials were changed.
