# Provider network recovery: owned-route failure and bounded restart

## Scope and acceptance

This opt-in proof has two deliberately bounded pieces. The executor uses a real task-local
reservation/journal in an explicitly synthetic test task. It records a known-no-effect loopback
refusal, terminates the first owner while one retry in the total budget remains, restores the
fixture route, and starts a different process with the exact same request/cause. The resumed
controller asks the separately owned native SDK worker to make one provider request. The fixture
task uses the observed Pi SDK session UUID in `self`, the task binding, and `expectedSession`; it
does not invent a native UUID or claim the synthetic task namespace is a production Herdr task.

The native worker starts a controller-owned Pi SDK 1.4.0 interactive session in the newly owned
visible Herdr pane, pins OpenRouter `openai/gpt-6-luna`, disables tools, and awaits one harmless
prompt. Its per-request fetch adapter validates the exact chat-completions endpoint, checks that
its loopback route gate accepts a connection, and only then invokes the original fetch function
for that single request. The adapter does not replace global fetch, alter a dispatcher, set proxy
configuration, or inspect/log headers, credentials, request bodies, prompts, or response text.
Both the stream wrapper and fetch adapter reject repeat calls; SDK retries are set to zero and
`maxTokens` is capped at 1024.

A successful acceptance requires all of: the first process journaled `unavailable` + `none` with
an outcome timestamp; that process exited; the same cause resumed in a different process within
the original total retry budget; the restarted controller called the native worker exactly once;
the SDK request passed the restored loopback gate and returned HTTP 200; and the owned runtime
was disposed. If the provider is unavailable or returns another terminal result, the evidence
retains the exact sanitized status (for example `http_401`, `ECONNREFUSED`, or
`provider_request_rejected`), records `acceptance_passed: false`, and does not claim success. A
fetch that reaches the provider but fails without a response is not classified as known
no-effect.

This is evidence for one owned loopback route and one native OpenRouter request, not a
whole-machine Wi-Fi outage or provider-wide outage. It does not prove production task namespace
integration, unattended recovery generally, or that a provider response constitutes completion
of a user's task.

## Restart and replay boundary

The application executor owns the recovery decision. On a restart it may claim the existing cause
only after the previous owner is dead and only when the unfinished journal contains exclusively
failed/unavailable attempts with observation `none` and an outcome timestamp, and the total retry
budget has remaining capacity. The test uses the same durable request and cause; it does not
alter the journal, mint a new cause, or call the model around the executor.

Unknown, queued, partial, in-flight, and final outcomes remain no-replay boundaries. The native
request itself is guarded against stream and fetch retries. The separate executor regression
tests remain responsible for negative no-replay cases; this probe's eligible known-no-effect path
is the positive resume case.

## Safety and evidence

- Use only an explicitly chosen pinned `@earendil-works/pi-coding-agent` 1.4.0 entrypoint; the
  test checks the package version. Never rely on a globally installed or cached SDK.
- The SDK uses normal daily resource/authentication discovery. The probe does not read auth
  state, extract credentials, set API-key variables, or print environment contents.
- The fixed task text is `Reply exactly OK. Do not call tools or write files.` Active tools are
  disabled, `maxTokens` is 1024, `maxRetries` is 0, and only one stream and one fetch admission
  are allowed.
- The route gate is scoped to this request. It is opened on loopback after the first process
  exits. The native fetch adapter calls the captured original fetch only after the loopback gate
  accepts; no global fetch/proxy/network settings are changed. The test refuses to run when proxy
  environment variables are set rather than changing them.
- Evidence JSONL is created exclusively with mode `0600` in a fresh private scratch directory. It
  records only observed SDK identity/provider/model/pane/process ids, endpoint identity, socket
  status/byte count, stream/fetch/retry counts, HTTP status or sanitized terminal status, stop
  reason, executor disposition, runtime disposal, and proof boundaries. It contains no
  request/response bytes, response text, prompt, headers, or credentials. Temporary
  task/session files are removed by the test.

## Run only in an owned visible test pane

Verify `HERDR_ENV=1` and read `herdr --skill` first. Use only the newly owned visible test pane;
do not target the root, caller, workers, or unrelated panes. The test requires `HERDR_PANE_ID` to
match the supplied pane id and refuses any id listed as forbidden.

Run from the repository root in that owned pane. Use a fresh private output directory, direct
Node/TypeScript commands, and no package-manager build or shared `.build` output:

```nu
let T = (^mktemp -d -p $env.TMPDIR pappra-provider-network-recovery.XXXXXX | str trim)
try {
  ^node node_modules/typescript/bin/tsc --target ES2023 --lib ES2023,DOM --module NodeNext --moduleResolution NodeNext --types node --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noImplicitOverride --noFallthroughCasesInSwitch --noUnusedLocals --noUnusedParameters --verbatimModuleSyntax --isolatedModules --forceConsistentCasingInFileNames --skipLibCheck --noEmitOnError --sourceMap --declaration --rootDir . --outDir $"($T)/out" tests/collab/provider-network-recovery.test.ts tests/collab/provider-network-recovery-worker.ts tests/collab/provider-network-recovery-executor-worker.ts src/hosts/integration/pi-sdk.d.ts
  if $env.LAST_EXIT_CODE != 0 { error make { msg: "owned test compilation failed" } }
  { type: "module" } | to json | save --raw $"($T)/out/package.json"
  with-env {
    PAPPRA_PROVIDER_NETWORK_RECOVERY: "1"
    PAPPRA_PROVIDER_NETWORK_RECOVERY_PANE_ID: "<owned-pane-id>"
    PAPPRA_PROVIDER_NETWORK_RECOVERY_FORBIDDEN_PANES: "<root-and-unrelated-pane-ids>"
    PAPPRA_PROVIDER_NETWORK_RECOVERY_EVIDENCE_FILE: $"($T)/evidence.jsonl"
  } {
    ^node --test $"($T)/out/tests/collab/provider-network-recovery.test.js"
    if $env.LAST_EXIT_CODE != 0 { error make { msg: "owned experiment failed" } }
  }
} finally {
  rm --recursive --force $T
}
```

Do not run the shared build, full test suite, or package checks from this worker; root owns those
checks. Do not reuse an evidence path. A default-skipped test is not evidence of acceptance; run
the explicit opt-in experiment and inspect the sanitized `acceptance_passed` and
`provider_terminal_status` fields.

## Current execution note

The earlier retained proof stopped before the native provider attempt reached a terminal result.
The known-no-effect restart path exists, but the retained native-provider run did not supply
terminal acceptance. No provider success should be claimed
unless the new terminal evidence contains HTTP 200 and `runtime_disposed`. This page records the
contract and the observed gap; it does not claim a passed acceptance.
