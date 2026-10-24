# Native OpenRouter provider-stream interruption acceptance probe

## Scope and proof boundary

`tests/collab/provider-outage.test.ts` is an opt-in integration probe of Pappra's recovery journal using a fresh native Pi 1.4.0 managed SDK session. The worker calls Pappra's `startManagedPiSdkSession` with the exact pinned SDK module, preserving normal daily services, extensions and OpenRouter configuration. It does not extract or print credentials. The wrapper awaits the potentially asynchronous `AgentSession.agent.streamFunction` result, then observes its original `AsyncIterable` until a non-empty `text_delta`. It combines the owned abort signal with the existing signal. The default leaves native transport unchanged; `PAPPRA_PROVIDER_OUTAGE_FETCH_HOOK=1` optionally enables a per-request fetch hook.

The task is fixed and harmless: “Reply exactly OK. Do not call tools or write files.” The test disables active tools, pins `openrouter/openai/gpt-6-luna`, and sets `maxTokens: 1024` and `maxRetries: 0`. The optional fetch hook permits only `https://openrouter.ai/api/v1/chat/completions`, uses unmodified `globalThis.fetch`, and refuses a second hooked request. A second native stream call is always refused. No machine networking, proxy, global dispatcher or SDK/user configuration is changed.

The worker aborts only its one owned native stream after either an intercepted HTTP 200 plus first response bytes, or the first non-empty native `text_delta` if the adapter bypasses the fetch hook. It records the witness type explicitly and exits only its owned provider worker with status 86. The parent verifies that the recovery reservation contains one unresolved intent, starts a distinct restart process, and proves that Pappra reports `unknown`, makes zero controller calls, and does not redeliver. It asserts HTTP 200 only for a fetch-hook witness that actually observed status 200; a `text_delta` witness proves native response content only, not HTTP status or response-body transport bytes. Both are client-induced abort/process-exit cases, never evidence of a server-caused outage.

The durable evidence file contains only native session identity/model/pane metadata, one stream-admission count, witness event type and byte count, streaming state, optional HTTP status/host/path when the hook actually observes them, and the restart disposition/call counts. A text-delta-only witness is not reported as HTTP 200. Evidence contains no prompt, response body, delta text, headers, authorization value, or API key. It is created exclusively with mode 0600 under `/private/tmp`; the test fixture containing the recovery journal is otherwise removed. A real provider request may incur charges, bounded by one native stream and the configured token cap.

## Visibility and safe execution

Run the probe only from a newly created, visibly rendered, owned Herdr test pane. Do not reuse the caller (`w3:pR`) or root (`w3:pB`) pane. Set `PAPPRA_PROVIDER_OUTAGE_PANE_ID` to that owned pane's actual ID. The provider worker inherits the pane's stdio so the native Pi TUI remains visible. It creates a fresh native session and disposes/terminates only its own worker process; it never targets other sessions. While that native TUI is alive, the parent runs only `herdr pane get <PANE_ID>` and `herdr pane process-info --pane <PANE_ID>` for this supplied pane. Evidence retains an allowlisted/sanitized field projection plus hashes, not raw process arguments or environment; the process label is never modified. The worker validates the pane-ID shape and rejects the caller/root IDs, but it cannot independently ask Herdr whether a supplied pane ID is visible: visibility and ownership remain operator preconditions.

The probe requires all of the following:

- `PAPPRA_PROVIDER_OUTAGE=1`;
- `PAPPRA_PROVIDER_OUTAGE_SDK_MODULE` set to the absolute pinned entrypoint `/private/tmp/pappra-sdk-1.4.7IQTDg/node_modules/@earendil-works/pi-coding-agent/dist/index.js`;
- `PAPPRA_PROVIDER_OUTAGE_PANE_ID` set to a newly owned visible test-pane ID, not `w3:pR` or `w3:pB`;
- `PAPPRA_PROVIDER_OUTAGE_EVIDENCE_FILE` set to a **new, not-yet-existing** path under `/private/tmp`.

The test refuses to start if HTTP(S)/ALL proxy environment variables are set. Use no API-key environment variable: credentials remain inside the daily managed SDK services/extensions. Compile only the owned probe and its imports to a fresh temporary directory, then run only the compiled test from the owned pane. Do not use a shared build directory, `pnpm exec`, or the full suite.

```nu
let temp = (mktemp -d -p /private/tmp pappra-provider-outage.XXXXXX)
try {
  ^node_modules/.bin/tsc --target ES2023 --lib ES2023,DOM --module NodeNext --moduleResolution NodeNext --types node --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noImplicitOverride --noFallthroughCasesInSwitch --noUnusedLocals --noUnusedParameters --verbatimModuleSyntax --isolatedModules --forceConsistentCasingInFileNames --skipLibCheck --noEmitOnError --sourceMap --declaration --rootDir . --outDir $"($temp)/out" tests/collab/provider-outage.test.ts tests/collab/provider-outage-worker.ts
  '{"type":"module"}' | save --raw $"($temp)/out/package.json"
  with-env {
    PAPPRA_PROVIDER_OUTAGE: '1'
    PAPPRA_PROVIDER_OUTAGE_SDK_MODULE: '/private/tmp/pappra-sdk-1.4.7IQTDg/node_modules/@earendil-works/pi-coding-agent/dist/index.js'
    PAPPRA_PROVIDER_OUTAGE_PANE_ID: $env.PAPPRA_PROVIDER_OUTAGE_PANE_ID
    PAPPRA_PROVIDER_OUTAGE_EVIDENCE_FILE: $env.PAPPRA_PROVIDER_OUTAGE_EVIDENCE_FILE
  } {
    ^node --test $"($temp)/out/tests/collab/provider-outage.test.js"
  }
} finally {
  rm -rf $temp
}
```

Choose an evidence filename that does not already exist, for example `/private/tmp/pappra-provider-outage-native-<unique-id>.jsonl`. On success the test prints `NATIVE_PROVIDER_OUTAGE_EVIDENCE` followed by the exact retained path. Do not place credentials in command text or terminal output.

## Existing no-effect retry coverage

`tests/collab/recovery-network-restart.test.ts` separately proves the known-no-effect continuation path using loopback only: `ECONNREFUSED` before connect, `bytesSent: false`, then one bounded retry when the controlled service becomes available. This is valid executor/retry evidence, but it does not establish provider authentication, TLS, OpenRouter stream behavior, or provider recovery. The ambiguous native-provider case above must remain unknown and must not redeliver.

## Evidence available before this probe

The previous native prompt smoke test at `/private/tmp/pappra-sdk-prompt.1Ylzib/result.json` records a fresh managed SDK session (`01a16958-9e66-75f2-9c05-fdf5b4d9e93b`) completing one prompt through OpenRouter with `stopReason: stop` and `stop: runtime_disposed`. This disproves the earlier inference that an empty standalone `ModelRuntime.getAuth(model)` result means the managed SDK cannot authenticate. It proves a normal native request only, not an interrupted stream or restart behavior.

## Current verification status and limitations

The final native-stream probe passed in 7.3 seconds. Evidence is retained at
`/private/tmp/pappra-v3-native-stream-outage-v2-evidence.jsonl`. Fresh native
session `01a16bc2-df55-732a-b199-d933a119ef5e` observed OpenRouter Luna and one
admitted stream, then a two-byte `text_delta` while both native streaming
indicators were true. The owned worker aborted that stream and exited with code
86. A distinct restart process reported `unknown`, zero controller calls and
zero redeliveries. This is a native text-content witness; it does not assert HTTP
status or an exact count of underlying provider HTTP attempts.

Earlier failures below were retained rather than promoted into acceptance. The
probe itself incorrectly treated an asynchronous stream factory as a synchronous
iterator. Awaiting the factory result fixed that integration bug. A separate
fresh normal-prompt control completed successfully in about eight seconds:
`/private/tmp/pappra-v3-fresh-prompt.dV9c0k/result.json`. This does not establish
the cause of the original long worker sessions' connection errors.

The integrator ran the actual opt-in probe in a newly created visible owned pane `w3:pS`. One attempt timed out at the initial 25-second response-witness window. A second attempt used a 90-second response-witness window and also failed acceptance. Its sanitized observations are retained in `/private/tmp/pappra-v3-native-outage-evidence.jsonl`, ending with `acceptance_passed: false`.

That earlier attempt created native session `01a16baf-be06-736b-ac4b-97b12bd0ef28`, observed OpenRouter Luna and one hooked request. HTTP 200 and 25 bytes arrived after streaming ended. That late response did not establish active-stream interruption, and the parent failed before restart. The current probe rejects late witnesses, forwards cancellation to an optional fetch hook, disposes unsuccessful owned runtimes and retains failure observations. Final native-path acceptance uses the successful text-delta run above.

Read-only Herdr observations were made while the SDK runtime was alive. The pane had a Pi terminal title but did not expose a recognized Pi agent/session identity through `pane get`; a title alone is not identity proof. The earlier evidence allowlist omitted several useful status/process fields; the updated projection retains those safe fields while still excluding argv and environment. Recursive SDK successor launch and host identity publication remain unverified.

The abrupt test-worker exit also left delayed terminal color-query replies at the shell prompt. The operator cleared only that owned pane's input before a subsequent command. This is a test-terminal cleanup issue, not evidence that unrelated Pi sessions crashed. No machine network settings, proxy configuration, guardrails or credentials were changed.
