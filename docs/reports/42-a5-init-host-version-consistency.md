# A5 delivery: `init` host admission follows the existing event-contract matrix

Scope: finding **A5** of the #42/#43 adoption assessment
(`docs/reports/42-43-adoption-assessment.md` on `codex/42-43-adoption-assessment`
at `06587c2`). This change is host-admission logic only; it does not implement any
other report item.

| Field         | Value                                                                                   |
| ------------- | --------------------------------------------------------------------------------------- |
| Base          | `origin/main` `a35180241f752d548a0e2c95b334669fdac4f7aa`                                |
| Branch        | `codex/42-init-host-version-consistency` (separate worktree, own `dist/` and `.build/`) |
| Changed files | `src/app/init.ts`, `tests/init/host-admission.test.ts`, this report                     |

## The defect

`init` derived its host selection with a single-version equality test:

```ts
if (version === null || version !== HOST_SUPPORT[host].version) { … }
```

`HOST_SUPPORT[host].version` is the **reference default** version (the base a template or
installation targets). Every other entry point decides admission with
`isSupportedVersion(host, version)`, which tests membership of the **admitted observed
versions** in `HOST_EVENT_VERSIONS`:

| Entry                                                | Admission test                  |
| ---------------------------------------------------- | ------------------------------- |
| `host probe --host <name>` (`src/app/host-probe.ts`) | `isSupportedVersion`            |
| `onboard` (`src/app/onboard.ts` `hostState`)         | `isSupportedVersion`            |
| `host install/verify` (`src/cli/commands/host.ts`)   | `isSupportedVersion`            |
| `docs/support.md` host table                         | the `HOST_EVENT_VERSIONS` lists |
| **`init` host derivation (before this change)**      | reference-default equality      |

So `init` reported an admitted version as unsupported. Reproduced read-only at the base with
Codex `0.164.0`:

```
$ pappra host probe --host codex --json
{"host":"codex","version":"0.164.0","pinnedVersion":"0.163.0","ok":true,
 "details":{"matchesPinnedVersion":false},
 "message":"Version matches an observed event contract; lifecycle callability still needs a real session."}
$ pappra init --print-choices --json
hosts rule: "observed version 0.164.0 is outside the pinned support matrix"
```

## The change

`deriveInitChoices` in `src/app/init.ts` now admits a host when
`isSupportedVersion(host, version)` is true, and reports four distinct outcomes so that
the selection and the explanation cannot disagree:

| Observation                                                 | Selected | Reason                                                                                                                      |
| ----------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| no executable on the probed `PATH`                          | no       | `host executable was not observed on PATH`                                                                                  |
| executable present, `--version` unreadable or non-zero exit | no       | `host executable was observed but reported no readable version`                                                             |
| version not in `HOST_EVENT_VERSIONS`                        | no       | `observed version <v> is outside the admitted event-contract versions`                                                      |
| version in `HOST_EVENT_VERSIONS`                            | yes      | `observed version <v> is admitted for lifecycle events; loading, trust and callability still need an explicit native check` |

Deliberately unchanged:

- **No new version list.** The change consumes `isSupportedVersion` /
  `HOST_EVENT_VERSIONS` as they are. The admitted range is not widened: `claude 2.1.311`
  and `pi 1.5.0` remain refused, and the reference default (`HOST_SUPPORT[host].version`)
  keeps its role for templates and installation.
- **No inference.** Presence on `PATH`, a newer version, or a same-minor patch is not
  admission — `0.163.1` is refused even though the reference default is `0.163.0`.
- **Managed Pi untouched.** The owned SDK adapter path (`src/adapters/pi`,
  `src/app/managed-pi-*`) keeps its separate exact version and private-source contract
  (`src/hosts/integration/support.ts` says so explicitly); no file on that path changed.
- **No host side effects.** Selection only records `machine.selectedHosts`; host wiring
  still requires `onboard --apply-host`, and no hook was installed or trusted.

## Tests

New file `tests/init/host-admission.test.ts`. Each case builds a **version-probe fixture**:
a temporary directory containing only `claude`, `codex` and `pi` stubs, passed as
`deriveInitChoices(discovery, { pathEnv: binDir })`. The host CLIs installed on the machine
running the suite cannot influence a result, and no host is executed beyond the stub
`--version` call.

| Case                     | Fixture                                       | Assertion                                                                                                                                     |
| ------------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| reference default        | `codex-cli 0.163.0`                           | selected; reason names the version and admission                                                                                              |
| another admitted version | `codex-cli 0.164.0`                           | selected (the regression)                                                                                                                     |
| unadmitted version       | `codex-cli 0.165.0`                           | not selected; reason says outside the admitted set                                                                                            |
| same-minor patch         | `codex-cli 0.163.1`                           | not selected                                                                                                                                  |
| unreadable vs missing    | stub exiting non-zero / no stub               | distinct reasons                                                                                                                              |
| boundary                 | `claude 2.1.308`, `codex 0.164.0`, `pi 1.4.0` | all selected; every reason says loading, trust and callability still need an explicit native check and never claims verified/trusted/callable |

Negative control (the fix stashed, tests recompiled): the admitted-`0.164.0` case fails with
`actual []` vs `expected ['codex']`, which is the defect itself; the other five fail on the
new explanation text. With the fix restored all six pass.

## Checks run

| Command                                                                | Result                                                   |
| ---------------------------------------------------------------------- | -------------------------------------------------------- |
| `node --test .build/test/tests/init/host-admission.test.js`            | 6 pass, 0 fail                                           |
| `node --test --test-concurrency=2 .build/test/tests/init/*.test.js`    | 83 pass, 0 fail (77 existing + 6 new)                    |
| `node --test --test-concurrency=2 .build/test/tests/onboard/*.test.js` | 23 pass, 0 fail                                          |
| `pnpm typecheck`                                                       | pass                                                     |
| `pnpm source:check`                                                    | "Source language policy passed."                         |
| `pnpm format:check`                                                    | pass (after `prettier --write` on the two changed files) |
| `prettier --check --ignore-path /dev/null` on this report              | pass                                                     |

`pnpm format:check` (`prettier --check .`) does not cover this report, because
`.prettierignore` lists `docs/`; the explicit `--ignore-path /dev/null` run above is the
only formatter check it gets. No formatter configuration was changed.

`pnpm test` (the full suite) was **not** run: the coordinator owns the integration gate, and
this worktree must not race other participants' builds.

## Observed end-to-end behaviour

Throwaway repository, one stub `PATH`:

```
$ PATH=<stub>:… pappra init --print-choices --json      # stub answers codex-cli 0.164.0
hosts: ["codex"]
  codex: observed version 0.164.0 is admitted for lifecycle events; loading, trust and callability still need an explicit native check

$ PATH=<stub>:… pappra init --print-choices --json      # stub answers codex-cli 0.165.0
hosts: []
  codex: observed version 0.165.0 is outside the admitted event-contract versions
```

Same fixture with the machine's real `PATH` (observation only, no test depends on it):
`hosts: ["codex"]`, `claude 2.1.311` and `pi 1.5.0` refused as outside the admitted set.
`pappra host probe --host codex --json` is unchanged (`ok:true`, `matchesPinnedVersion:false`),
so the reference-default field and the admission decision remain separate.

## Limits

- Admission is a version-contract statement only. It does not prove that a host loads the
  hook, trusts it, or is callable; the reason text says so and no host was started.
- Fixture assertions fix the current wording of the four reasons. A future intentional
  rewording must update this test, which is the point: selection and explanation are
  asserted together.
- `src/cli/commands/host.ts` and `src/hosts/integration/service.ts` still name the pinned
  number in some refusal messages. Their _checks_ already use the admitted set (or the
  exact installation contract); their wording was left alone as out of this scope.
- Everything else in the A5 neighbourhood — `docs scan`, `code status`, validation
  capture, `kind` classification, new context APIs — is untouched.

## Boundary

Delivered for independent review. Not pushed, no PR, no merge, no release, no issue state
change; the implementing agent does not accept its own report.
