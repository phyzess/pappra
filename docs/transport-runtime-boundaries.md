# Transport and runtime boundaries

This page is the design record for issue #33: what Pappra actually needs from a
window multiplexer ("transport") and from a host coding agent ("runtime"), which
modules carry that coupling today, where the seams already are, and the four
minimal contracts an extraction must preserve.

It is a map and a proposal, not a refactor. No behaviour, schema, message,
claim or acceptance path changes here. Everything below was read from the tree
at `a594b37` on `m1/host-native-minimum`.

- Transport today: **Herdr** (the `herdr` CLI).
- Runtime today: **Pi** (interactive Pi and the pinned owned Pi SDK runtime).
- Related decisions: [host-native-boundaries.md](host-native-boundaries.md),
  [collaboration-workflow.md](collaboration-workflow.md).

## 1. Inventory

### 1.1 Two different couplings

Pappra couples to two things that are easy to conflate:

| Layer        | What it supplies                                                                                                  | Where it is spent                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Transport** | pane ids, split/close, agent roster, `agent prompt`, `pane process-info`, agent session reporting                | routing one registered message, placing a participant |
| **Runtime**   | an agent process, its native session id, its transcript/queue truth, its stop behaviour                           | the identity recorded on an attempt, and its evidence |

A transport observation is **routing**, never process affiliation
(`src/schemas/collaboration.ts:393-406`, `process_affiliation: 'not-established'`).
A runtime observation is **evidence**, never authority
(`src/app/collab-notify.ts:37-39`).

### 1.2 Core versus adapter

**Core** means: task, claim, message, report and acceptance authority. Core
modules may _carry_ a transport or runtime identity as a string, but they must
not call either one.

| Module                                                  | Needs from transport/runtime                                       | Layer    |
| ------------------------------------------------------- | ------------------------------------------------------------------ | -------- |
| `src/collab/envelope.ts`                                | `from`/`to` identity triple on every message (`REQUIRE_IDENTITY`)  | core     |
| `src/schemas/collaboration.ts`                          | binding, delivery, caller evidence shapes                          | core     |
| `src/schemas/collaboration-state.ts`                    | `NativeBinding`, `Attempt`, `LaunchReservation` shapes             | core     |
| `src/collab/store.ts`                                   | task record persistence, `STATE_SCHEMA`                            | core     |
| `src/collab/persisted-messages.ts`                      | registered-message reader, delivery records                        | core     |
| `src/collab/lifecycle.ts`                               | attempt state, native evidence recording                           | core     |
| `src/collab/admission.ts`, `src/collab/preflight.ts`    | capability card checks, the only age bound in the system           | core     |
| `src/collab/resources.ts`, `src/collab/work-plan.ts`    | claims and plan state                                              | core     |
| `src/app/collab-state.ts`, `collab-task-store.ts`       | guarded read/write of the record                                   | core     |
| `src/app/collab-messages.ts`                            | message service over the persisted reader                          | core     |
| `src/app/collab-workflow/*`                             | prepare/dispatch/ack/report/accept/release bookkeeping             | core     |
| `src/app/collab-notify.ts`                              | `HerdrTransport` + the one default implementation                  | adapter  |
| `src/app/collab-bootstrap-transport.ts`                 | `HerdrBootstrapOps` + the one default implementation               | adapter  |
| `src/app/collab-bootstrap.ts`                           | visible pane bootstrap, argv plans, layout placement               | adapter  |
| `src/app/collab-pane-layout.ts`, `collab-pane-reclaim.ts` | geometry maths, owned-pane reclaim                               | adapter  |
| `src/app/shell-readiness.ts`                            | pane/workspace/terminal/cwd readiness sampling                     | adapter  |
| `src/app/collab-successor/*`                            | mid-cohort succession over the roster                              | adapter  |
| `src/app/collab-session-transition*.ts`                 | session transition, successor routing, quiescence receipts         | adapter  |
| `src/app/collab-recovery-executor.ts`                   | bounded recovery controller                                        | adapter  |
| `src/app/managed-pi*.ts`                                | owned Pi SDK runtime, its observation and publication              | runtime  |
| `src/hosts/pi/*`, `src/adapters/pi/*`                   | the Pi runtime, RPC, hooks and extensions                          | runtime  |

The boundary is already visible in the type system: **two** modules import a
Herdr-named module (`src/app/collab-successor/launch.ts` →
`./herdr.js`, `src/app/managed-pi-sdk-runtime.ts` → `./managed-pi-herdr.js`),
while 35 modules mention `herdr` at all. The difference is string fields and
argv literals versus behaviour.

### 1.3 Persisted fields that carry transport or runtime identity

#### `task.json` — `harness-collab/state/1`

| Field path                                                                                       | Carries                                                         |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `attempts[].assignee.agent_id`                                                                   | protocol agent id                                               |
| `attempts[].assignee.session_id`                                                                 | protocol session id (not a native session)                      |
| `attempts[].assignee.harness`                                                                    | runtime name as declared (`pi`, `codex`, `claude`)              |
| `attempts[].native.runner`                                                                       | runtime/controller label                                        |
| `attempts[].native.session_id`                                                                   | **native** session id                                           |
| `attempts[].native.run_id`                                                                       | controller run id                                               |
| `attempts[].native.mission_id`                                                                   | mission id                                                      |
| `attempts[].native.observation`                                                                  | `confirmed` / `unknown` verdict                                 |
| `attempts[].native.observed_at`                                                                  | when that observation was taken                                 |
| `attempts[].native.evidence_ref`                                                                 | bounded evidence pointer                                        |
| `attempts[].native.manager`, `.launch_kind`, `.mode`, `.identity_status`                          | optional runtime labels                                         |
| `attempts[].cwd`                                                                                 | the workspace recorded for the attempt                          |
| `messages[].from.{agent_id,session_id,harness}`                                                   | sender identity                                                 |
| `messages[].to.{agent_id,session_id,harness}`                                                     | recipient identity                                              |
| `claims[].holder.{agent_id,session_id,harness}`                                                   | claim holder                                                    |
| `launch_reservations[].transport`                                                                 | transport label for a launch reservation                        |
| `launch_reservations[].holder.{agent_id,session_id,harness}`                                      | who reserved                                                    |
| `launch_reservations[].bootstrap.receipts[].argv`                                                 | the literal argv that ran (`argv[0] === 'herdr'`)               |
| `launch_reservations[].bootstrap.managed_sdk_config.herdr_agent_name`, `.herdr_pane_id`           | managed-SDK launch binding                                      |
| `managed_pi_initial_launches[].{session_id,agent_id,pane_id,pid,descriptor_file,controller_run_id,admission_digest}` | owned initial-launch registry |

Shapes: `NativeBinding` (`src/schemas/collaboration-state.ts:125-137`),
`Attempt` (`:139-160`), `LaunchReservation` (`:404-415`). Writers:
`launch_reservations[].bootstrap` is written by `updateReservation`
(`src/app/collab-bootstrap.ts:2925-2990`, receipts sanitised at `:3222-3238`);
`managed_pi_initial_launches` by `src/app/managed-pi-initial-launch.ts:42-73`.

#### The binding document — `pappra/collab-binding/1`

| Field path                                | Carries                                                              |
| ----------------------------------------- | -------------------------------------------------------------------- |
| `channel`                                 | **literal `'herdr'`** — the only value the schema accepts             |
| `participants[].agent_id`                 | protocol agent id                                                     |
| `participants[].harness`                  | declared runtime                                                      |
| `participants[].cwd`                      | the workspace the participant was observed in                         |
| `participants[].herdr_agent`              | the transport roster name                                             |
| `participants[].pane_id`                  | the transport pane (`w9:p26`)                                         |
| `participants[].native_session_id`        | the runtime session the binding pins (nullable)                       |

Shape: `src/schemas/collaboration.ts:353-372`. Written by workflow prepare
(`src/app/collab-workflow/prepare.ts:1150-1162`, `channel: 'herdr'` at `:1157`).

#### Delivery records — `notifications/<message_id>.json`, `pappra/collab-delivery/1`

| Field path                                                          | Carries                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------ |
| `target.herdr_agent`, `.pane_id`                                     | the routing target                                     |
| `target.native_session`                                              | `match` / `unknown`                                    |
| `target.native_session_kind`                                         | reported kind (`path`, `id`, …)                        |
| `caller.source`                                                      | `current` / `explicit`                                 |
| `caller.pane_id`, `.harness`, `.cwd`, `.observed_at`                  | what the caller looked like when observed              |
| `caller.native_session`, `.native_session_kind`                       | caller-side session comparison                         |
| `caller.process_affiliation`                                          | always `not-established`                               |
| `status`                                                             | `submitting`/`submitted`/`blocked`/`refused`/`unknown`/`failed` |
| `attempts[].{at,status,detail,reservation_id}`                        | every delivery attempt                                 |

Shape: `src/schemas/collaboration.ts:365-432`. Written by
`src/app/collab-notify.ts` and read by `readDeliveryRecord`
(`src/collab/persisted-messages.ts:763`).

#### Message envelopes — `harness-collab/message/1`

| Field path                                   | Carries                              |
| -------------------------------------------- | ------------------------------------ |
| `from.{agent_id,session_id,harness}`          | required on every message            |
| `to.{agent_id,session_id,harness}`            | required per type (see `PER_TYPE`)   |
| `content_digest`                              | digest of the registered content     |
| `task_id`, `subtask_id`, `attempt`            | protocol scoping                     |

`REQUIRE_IDENTITY = ['agent_id', 'session_id', 'harness']`
(`src/collab/envelope.ts:43`), per-type presence at `:45-71`, `from`/`to` at `:151-169`, digest at `:223-234`.

#### Capability cards — `pappra/host-capabilities/1`

| Field path                                | Carries                                                       |
| ----------------------------------------- | ------------------------------------------------------------- |
| `host`, `surface`                          | which runtime and which integration surface                   |
| `version`, `executablePath`, `configPath`  | the executable that was observed                              |
| `observedAt`                               | when the card was derived                                     |
| `capabilities[].event`, `.nativeEvent`      | lifecycle event and the host's own name for it                |
| `capabilities[].state`                      | `installed`…`verified`, plus **`unsupported`** and **`unknown`** |
| `capabilities[].reason`, `.evidence`        | why, and bounded evidence                                     |
| `limits`, `reloadRequired`, `trustRequired` | explicit ceilings instead of inference                        |

Shape: `src/schemas/host.ts:55-69`, states at `:34-42`. The collaboration
capability card adds `observed_at`, which is the only field in the system that
is aged: `src/collab/preflight.ts:246` adds `capabilities_stale` past
`maxAgeMinutes` (default 30, `src/app/collab-preflight.ts:96`).

## 2. Seams

### 2.1 Seams that already exist

Four interfaces already isolate transport behaviour. They are the extraction
starting point, not a new framework.

**1. `HerdrTransport`** — `src/app/collab-notify.ts:102-133`

- Operations: `verifyCaller({paneId?})` (`:107`), `list()` (`:113`),
  `prompt(agent, text, registered?)` (`:115`).
- Default implementation: `createHerdrTransport` (`:323`), documented as
  "the installed Herdr CLI, argv only, never `--wait`" (`:321`).
- Every CLI call inside it: `pane current --pane` (`:383`),
  `pane current --current` (`:454`), `agent list` (`:518`),
  `agent prompt` (`:647`).
- Injected: `notifyRegisteredMessage` falls back to it at `:1478`; tests pass a
  fake instead (`tests/collab/messages.test.ts` `FakeTransport`).

**2. `HerdrBootstrapOps`** — `src/app/collab-bootstrap-transport.ts:196-241`

- Operations: `verifyCaller`, `listAgents`, `paneGet`, `paneProcessInfo`,
  `paneLayout`, `splitPane`, `startAgent`, `startManagedSdk` (optional),
  `closePane`, each returning `BootstrapOperationResult` with a bounded receipt.
- Default implementation: `createHerdrBootstrapOps` (`:658`).
- CLI calls inside it: `pane get` (`:695`), `pane process-info` (`:705`),
  `pane layout` (`:763`), `pane split` (`:811`), `agent start` (`:895`),
  `pane run` (`managedSdkStartArgs`, `:139-159`), `pane close` (`:1295`).

**3. `SuccessorHerdrOps` / `HerdrRunner`** — `src/app/collab-successor/herdr.ts:38`

- Runner type `:60-71`, `defaultRunner` spawning `herdr` at `:73-99`,
  `createHerdrOps` at `:127`.
- CLI calls inside it: `pane get` (`:193`), `agent get` (`:215`, `:264`),
  `agent prompt` (`:267`).

**4. Recovery controller** — `src/app/collab-recovery-executor.ts`

- Type `herdrRecoveryController` (`:1470`), factory
  `createHerdrRecoveryController` (`:1692`). It also refuses any binding whose
  channel is not `herdr` (`:143`).

### 2.2 Where Herdr is still reached directly

These call sites bypass all four seams. They are the honest extraction cost.

| File:line                                                            | Reaches                                                            |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `src/app/managed-pi-herdr.ts:35`, `:39`                                | spawns `herdr` through `runHerdrCommand`                            |
| `src/app/managed-pi-herdr.ts:63-65`                                    | `pane process-info --pane`                                          |
| `src/app/managed-pi-herdr.ts:109-122`                                  | `pane report-agent …` (state publication)                           |
| `src/app/managed-pi-herdr.ts:124-140`                                  | `pane report-agent-session …` (session publication)                 |
| `src/app/managed-pi-herdr.ts:144`                                      | `agent rename`                                                      |
| `src/app/managed-pi-herdr.ts:147-155`, `:195-203`                      | `pane release-agent`                                                |
| `src/app/managed-pi-native-observation.ts:115-116`                     | `herdr pane process-info` for OS-level ownership                    |
| `src/app/collab-bootstrap.ts:2049-2053`                                | builds the plan text `herdr pane split …`                           |
| `src/app/collab-bootstrap.ts:2157-2180`                                | builds the plan text `herdr agent start …`                          |
| `src/app/collab-bootstrap-transport.ts:398`, `:1019`                    | prefixes raw argv with `herdr` inside the adapter                   |
| `src/app/collab-workflow/prepare.ts:1157`                              | writes the literal `channel: 'herdr'` into the binding              |
| `src/app/collab-recovery-executor.ts:143`                              | refuses any non-`herdr` channel                                     |

Environment coupling, which is transport identity read from the process rather
than from a record:

| File:line                                                | Reads                                                  |
| -------------------------------------------------------- | ------------------------------------------------------ |
| `src/app/collab-notify.ts:355-357`                         | `HERDR_BIN_PATH`                                       |
| `src/app/collab-notify.ts:362`                             | `HERDR_ENV` (must be `'1'`)                            |
| `src/app/collab-notify.ts:434`                             | `HERDR_PANE_ID`                                        |
| `src/app/collab-notify.ts:502`                             | `HERDR_WORKSPACE_ID`                                   |
| `src/app/collab-bootstrap-transport.ts:678-681`            | `HERDR_BIN_PATH`                                       |
| `src/app/managed-pi-resume-admission.ts:470`               | `HERDR_PANE_ID`                                        |
| `src/app/managed-pi-sdk-runtime.ts:135`, `:524`             | `HERDR_PANE_ID`, `HERDR_ENV`                           |
| `src/cli/commands/collaboration-handoff.ts:178`            | `HERDR_PANE_ID` as `caller_pane`                       |
| `src/adapters/pi/session-transition-extension.ts:96`       | `HERDR_PANE_ID` (extension-side)                       |

Agreed shapes are Herdr-shaped too: the pane id grammar
(`/^[A-Za-z0-9]+:p[A-Za-z0-9]+$/`) at `src/app/collab-notify.ts:44` and
`src/app/collab-bootstrap-transport.ts:25`, and the agent-name grammar at
`src/app/collab-bootstrap.ts:96` and `src/app/collab-bootstrap-transport.ts:27`.

### 2.3 Where Pi is still assumed directly

| File:line                                                                             | Assumes                                                        |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `src/hosts/pi/managed-sdk-session.ts:354`, `:1483`, `:1966`                             | `pinned_pi_1_4_owned_runtime` — a pinned Pi runtime            |
| `src/hosts/pi/managed-sdk-session.ts:483`, `:489`                                       | `sdk_private_source_unavailable`, `sdk_private_source_hash_mismatch` |
| `src/hosts/pi/rpc.ts`, `src/hosts/pi/managed-session.ts`                                | Pi RPC and managed control                                      |
| `src/adapters/pi/*`                                                                     | Pi extension entrypoints                                        |
| `src/app/collab-bootstrap-transport.ts:95`, `:564`, `:1194`                              | managed SDK model pinned to `provider: 'openrouter'`            |
| `src/app/managed-pi-native-observation.ts:110`                                           | same OpenRouter pin when validating a launch                    |
| `src/app/collab-bootstrap-transport.ts:1139`, `src/app/managed-pi-initial-admission.ts:122,132,183` | `harness === 'pi'` gates                        |
| `src/app/collab-notify.ts:347`, `:366-368`                                               | upgrades a pane with no session to a Pi SDK identity            |
| `src/hosts/version.ts:6-31`                                                              | bounded `--version` observation, no prompt                      |

Pi private-source and version fences therefore sit inside
`src/hosts/pi/managed-sdk-session.ts` and cannot be removed by an extraction:
they validate a pinned artifact, not a transport.

## 3. Minimal contracts

Only the four operations G1 actually exercised. Each entry states what the
contract guarantees, what it refuses, what evidence it may claim, and what an
unsupported implementation must say instead of guessing.

### 3.1 Context access

Reads that tell a caller what environment it is in: the caller pane, its
workspace, its cwd, the task root's current identity, and any stored documents.

- **Guarantees**: a resolution is either a value observed now, or an explicit
  failure. Identity is compared exactly, never by prefix or substring.
- **Refuses**: a missing environment marker, an invalid pane id, a pane that
  resolves to something else, a workspace that does not match, a task root that
  changed underneath, and any focus-based inference (`collab-notify.ts:362-512`).
- **May claim**: `declared` routing facts and `unknown` native affiliation.
  A pane id is not a native session id (`collabDeliveryCallerSchema`).
- **Unsupported implementation must report**: the capability as
  `unavailable` or `unknown` and name the missing observation — never fall back
  to focus, a title, a default pane or an inferred workspace.

### 3.2 Observed participant reference

Turns a declared participant into a live reference: agent name, pane, harness,
cwd and reported session, matched against the sealed binding.

- **Guarantees**: exactly one live participant matches the bound name, and every
  compared field agrees (`collab-notify.ts:1198-1277`).
- **Refuses**: zero matches, more than one match, a pane/harness/cwd mismatch, a
  reported session that differs from the message target, and an archived
  identity used as a current route.
- **May claim**: `match` / `unknown` for the native session, and
  `process_affiliation: 'not-established'` for the process. A roster entry is
  not proof that the process is alive or idle.
- **Unsupported implementation must report**: `unknown`, with the field that
  could not be observed, and leave the delivery un-attempted.

### 3.3 Submission

Delivers a pointer to an **already registered** message.

- **Guarantees**: the message was validated (id, digest, task, sender,
  recipient) before any transport call, and every outcome is persisted as a
  delivery attempt (`notifications/<message_id>.json`).
- **Refuses**: an unregistered message, an id/content mismatch, a digest that
  changed after validation, a binding that changed mid-flight, a second implicit
  send, more than the bounded retry count, and delivery with no verified caller.
- **May claim**: `submitted` only. `consumed` and `taskAccepted` are typed as
  the literal `false` (`collab-notify.ts:782`, `:1189`), so a caller cannot even
  express the stronger claim from the notify result.
- **Unsupported implementation must report**: `unavailable` when it cannot
  deliver at all, `unknown` when the effect is ambiguous, and never "delivered".

### 3.4 Result observation

Reads a persisted result, report or delivery record.

- **Guarantees**: the reader is bounded, identity-checked (path inside the task,
  regular file, real path equal to the requested path), and returns the digest
  it actually read (`src/collab/persisted-messages.ts:404-502`).
- **Refuses**: unsafe ids, symlinks, redirected paths, oversized files, invalid
  JSON, a file whose `message_id` differs from the requested id, an unknown
  classification, and a stale record presented as a current one.
- **May claim**: `applied` for a recorded decision, `submitted` for a delivery,
  `unknown` for everything the record does not state.
- **Unsupported implementation must report**: `unknown` for a missing record,
  and name the absent artifact instead of synthesising a result.

### 3.5 Lifecycle control — explicitly optional

Launch, stop and quiescence are a **stronger, optional** contract, not one of the
four. A runtime that cannot prove quiescence reports `unknown`; the rollover
path already refuses transfer without a stop proof (`old_writer_not_stopped`,
`stop_evidence_required`, `tests/collab/rollover.test.ts:509`). Nothing in the
four contracts above may depend on this one being available.

## 4. Authority

A transport or runtime type acquires **no authority** from descriptive
configuration (#21). A name, a path, a config key, a pane id, an agent name or a
`channel: 'herdr'` string never grants:

- a resource claim — claims come from the claim engine and name a holder;
- an approval — approvals are explicit message bodies, never a routing fact;
- an acceptance — acceptance is a separate coordinator decision correlated to a
  specific report (a writer can never accept its own report);
- a stop proof — only a supported proof path can produce one.

Two statements already in the code say the same thing: capability cards are
readiness, not authority (`capability_cards_are_readiness_not_authority`,
`src/app/collab-bootstrap.ts:732`), and publication of an owned runtime is not
task authority (`src/app/managed-pi-herdr.ts:10`). Adding a transport
implementation must not add a new way to claim any of the four.

## 5. Compatibility

- **Old bindings keep the Herdr interpretation.** `channel` is a literal
  `'herdr'` (`src/schemas/collaboration.ts:369`), and every reader refuses any
  other value (`src/app/collab-recovery-executor.ts:143`). An existing
  `pappra/collab-binding/1` document therefore keeps exactly the meaning it was
  written with. There is no conversion and no reinterpretation.
- **No new representation is needed for #33.** The four contracts above are
  already expressible with the persisted fields in §1.3. A new transport should
  first be expressed as another implementation of `HerdrTransport` and
  `HerdrBootstrapOps`; if a genuinely new discriminator is ever required, it
  arrives as a new `channel` value, which is a **new** representation rather
  than a re-reading of an old one.
- **Old reader behaviour** (today's code, unchanged): a document with
  `channel: 'herdr'` is accepted; anything else is refused before any claim,
  pane or delivery action.
- **New reader behaviour** (a future extraction): must still accept
  `channel: 'herdr'` and keep the same refusal codes for every Herdr-specific
  check. If a new channel is added, the reader must decide per document rather
  than per build, and an unknown channel must be refused, not guessed.
- **Fresh state entry without migration.** A new transport starts from a fresh
  task root and a fresh binding document. No existing `task.json` is rewritten,
  no `attempts[].native` field is reinterpreted, and no delivery record is
  replayed. Old tasks keep running under the old interpretation.
- **Downgrade** means: the new channel's tasks stay unreadable to an old reader
  (explicit refusal), and Herdr tasks stay readable to both. There is no silent
  coercion in either direction, and no fallback to a different harness when the
  requested channel is unavailable.
- **Pi fences stay until #5.** The pinned runtime scope
  (`pinned_pi_1_4_owned_runtime`) and the private-source hash checks
  (`sdk_private_source_unavailable`, `sdk_private_source_hash_mismatch`,
  `src/hosts/pi/managed-sdk-session.ts:483-489`) remain in force. This page does
  not open Pi, does not introduce an adapter for a new transport, and does not
  weaken the ownership fence.

## 6. Characterization coverage

`tests/collab/transport-runtime-contract.test.ts` pins only the boundaries that
no existing test already pinned. Every other row cites the test that covers it.

| # | Required case                | Status   | Covered by                                                                                                                                                                     |
| - | ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 | unavailable capability       | existing | `tests/collab/messages.test.ts` — "notification is unavailable outside a verified Herdr caller" (status `herdr_unavailable`, `consumed: false`, no delivery record)              |
| 2 | stale identity               | existing | `tests/collab/capabilities.test.ts` — "Pi replay keeps the native observation time and goes stale" (`capabilities_stale` past the 30-minute bound at `src/collab/preflight.ts:246`) |
| 3 | submitted-not-consumed       | existing | `tests/collab/messages.test.ts` — "notify validates the binding and sends one pointer-only prompt" (`submitted`, `consumed: false`, `taskAccepted: false`, duplicate recorded)   |
| 4 | unknown delivery / no replay | existing | `tests/collab/workflow-notifications.test.ts` — "an unknown delivery stays unknown and is never replayed automatically"                                                          |
| 5 | changed workspace (#13)      | existing | `tests/collab/shell-readiness.test.ts` — "readiness fails closed on pane, workspace, terminal, cwd and agent drift" (`workspace_id_mismatch`); task-root redirect in `tests/collab/messages.test.ts` — "unsafe ids, malformed records, task mismatch and redirected state fail closed" |
| 6 | lack of stop proof           | existing | `tests/collab/rollover.test.ts` — "unknown quiescence and non-complete inventory never authorize transfer" (`old_writer_not_stopped`, `stop_evidence_required`)                   |
| 7 | registered-message validation (#17) | added    | `tests/collab/transport-runtime-contract.test.ts` — "a registered message whose id does not match its registration is refused". Digest drift was already covered by `tests/collab/messages.test.ts` — "notify rejects selected binding or registered message drift during transport checks" |

### Known gaps, stated rather than faked

- **Case 2 has no transport-level age bound.** The only age bound in the system
  is the capability card's `observed_at` (`src/collab/preflight.ts:246`). A live
  pane/session observation has no expiry: it is compared exactly, and its
  `observed_at` is recorded, but nothing ages it into `unknown`. So "stale
  identity" is exercised end to end only through the capability preflight; the
  transport-level half does not exist yet and is **not** faked here. Proposed
  (not implemented): an explicit maximum age on
  `caller.observed_at` / `attempts[].native.observed_at` that downgrades to
  `unknown` instead of accepting a stale match.
- **Case 6 cannot prove quiescence for interactive Pi.** Interactive Pi exposes
  no stop proof, so the only honest outcomes are refusal and `unknown`; the
  rollover test pins that refusal rather than a positive proof.
- **`src/app/managed-pi-herdr.ts` cannot be exercised from a test without a real
  pane.** It asserts OS ownership with `pane process-info` before every
  publication, so its direct `herdr` calls stay outside characterization until
  an injectable ops type exists. That is extraction work, not a test gap to hide.
