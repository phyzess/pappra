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

| Layer         | What it supplies                                                                                  | Where it is spent                                     |
| ------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Transport** | pane ids, split/close, agent roster, `agent prompt`, `pane process-info`, agent session reporting | routing one registered message, placing a participant |
| **Runtime**   | an agent process, its native session id, its transcript/queue truth, its stop behaviour           | the identity recorded on an attempt, and its evidence |

A transport observation is **routing**, never process affiliation
(`src/schemas/collaboration.ts:393-406`, `process_affiliation: 'not-established'`).
A runtime observation is **evidence**, never authority
(`src/app/collab-notify.ts:37-39`).

### 1.2 Core versus adapter

**Core** means: task, claim, message, report and acceptance authority. Core
modules may _carry_ a transport or runtime identity as a string, but they must
not call either one.

| Module                                                    | Needs from transport/runtime                                      | Layer   |
| --------------------------------------------------------- | ----------------------------------------------------------------- | ------- |
| `src/collab/envelope.ts`                                  | `from`/`to` identity triple on every message (`REQUIRE_IDENTITY`) | core    |
| `src/schemas/collaboration.ts`                            | binding, delivery, caller evidence shapes                         | core    |
| `src/schemas/collaboration-state.ts`                      | `NativeBinding`, `Attempt`, `LaunchReservation` shapes            | core    |
| `src/collab/store.ts`                                     | task record persistence, `STATE_SCHEMA`                           | core    |
| `src/collab/persisted-messages.ts`                        | registered-message reader, delivery records                       | core    |
| `src/collab/lifecycle.ts`                                 | attempt state, native evidence recording                          | core    |
| `src/collab/admission.ts`, `src/collab/preflight.ts`      | capability card checks (`capabilities_stale`, 30 minutes)         | core    |
| `src/collab/resources.ts`, `src/collab/work-plan.ts`      | claims and plan state                                             | core    |
| `src/app/collab-state.ts`, `collab-task-store.ts`         | guarded read/write of the record                                  | core    |
| `src/app/collab-messages.ts`                              | message service over the persisted reader                         | core    |
| `src/app/collab-workflow/*`                               | prepare/dispatch/ack/report/accept/release bookkeeping            | core    |
| `src/app/collab-notify.ts`                                | `HerdrTransport` + the one default implementation                 | adapter |
| `src/app/collab-bootstrap-transport.ts`                   | `HerdrBootstrapOps` + the one default implementation              | adapter |
| `src/app/collab-bootstrap.ts`                             | visible pane bootstrap, argv plans, layout placement              | adapter |
| `src/app/collab-pane-layout.ts`, `collab-pane-reclaim.ts` | geometry maths, owned-pane reclaim                                | adapter |
| `src/app/shell-readiness.ts`                              | pane/workspace/terminal/cwd readiness sampling                    | adapter |
| `src/app/collab-successor/*`                              | mid-cohort succession over the roster                             | adapter |
| `src/app/collab-session-transition*.ts`                   | session transition, successor routing, quiescence receipts        | adapter |
| `src/app/collab-recovery-executor.ts`                     | bounded recovery controller                                       | adapter |
| `src/app/managed-pi*.ts`                                  | owned Pi SDK runtime, its observation and publication             | runtime |
| `src/hosts/pi/*`, `src/adapters/pi/*`                     | the Pi runtime, RPC, hooks and extensions                         | runtime |

The boundary is already visible in the type system: **two** modules import a
Herdr-named module (`src/app/collab-successor/launch.ts` →
`./herdr.js`, `src/app/managed-pi-sdk-runtime.ts` → `./managed-pi-herdr.js`),
while 35 modules mention `herdr` at all. The difference is string fields and
argv literals versus behaviour.

### 1.3 Persisted fields that carry transport or runtime identity

#### `task.json` — `harness-collab/state/1`

| Field path                                                                                                           | Carries                                            |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `attempts[].assignee.agent_id`                                                                                       | protocol agent id                                  |
| `attempts[].assignee.session_id`                                                                                     | protocol session id (not a native session)         |
| `attempts[].assignee.harness`                                                                                        | runtime name as declared (`pi`, `codex`, `claude`) |
| `attempts[].native.runner`                                                                                           | runtime/controller label                           |
| `attempts[].native.session_id`                                                                                       | **native** session id                              |
| `attempts[].native.run_id`                                                                                           | controller run id                                  |
| `attempts[].native.mission_id`                                                                                       | mission id                                         |
| `attempts[].native.observation`                                                                                      | `confirmed` / `unknown` verdict                    |
| `attempts[].native.observed_at`                                                                                      | when that observation was taken                    |
| `attempts[].native.evidence_ref`                                                                                     | bounded evidence pointer                           |
| `attempts[].native.manager`, `.launch_kind`, `.mode`, `.identity_status`                                             | optional runtime labels                            |
| `attempts[].cwd`                                                                                                     | the workspace recorded for the attempt             |
| `messages[].from.{agent_id,session_id,harness}`                                                                      | sender identity                                    |
| `messages[].to.{agent_id,session_id,harness}`                                                                        | recipient identity                                 |
| `claims[].holder.{agent_id,session_id,harness}`                                                                      | claim holder                                       |
| `launch_reservations[].transport`                                                                                    | transport label for a launch reservation           |
| `launch_reservations[].holder.{agent_id,session_id,harness}`                                                         | who reserved                                       |
| `launch_reservations[].bootstrap.receipts[].argv`                                                                    | the literal argv that ran (`argv[0] === 'herdr'`)  |
| `launch_reservations[].bootstrap.managed_sdk_config.herdr_agent_name`, `.herdr_pane_id`                              | managed-SDK launch binding                         |
| `managed_pi_initial_launches[].{session_id,agent_id,pane_id,pid,descriptor_file,controller_run_id,admission_digest}` | owned initial-launch registry                      |

Shapes: `NativeBinding` (`src/schemas/collaboration-state.ts:125-137`),
`Attempt` (`:139-160`), `LaunchReservation` (`:404-415`). Writers:
`launch_reservations[].bootstrap` is written by `updateReservation`
(`src/app/collab-bootstrap.ts:2925-2990`, receipts sanitised at `:3222-3238`);
`managed_pi_initial_launches` by `src/app/managed-pi-initial-launch.ts:42-73`.

#### The binding document — `pappra/collab-binding/1`

| Field path                         | Carries                                                   |
| ---------------------------------- | --------------------------------------------------------- |
| `channel`                          | **literal `'herdr'`** — the only value the schema accepts |
| `participants[].agent_id`          | protocol agent id                                         |
| `participants[].harness`           | declared runtime                                          |
| `participants[].cwd`               | the workspace the participant was observed in             |
| `participants[].herdr_agent`       | the transport roster name                                 |
| `participants[].pane_id`           | the transport pane (`w9:p26`)                             |
| `participants[].native_session_id` | the runtime session the binding pins (nullable)           |

Shape: `src/schemas/collaboration.ts:353-372`. Written by workflow prepare
(`src/app/collab-workflow/prepare.ts:1150-1162`, `channel: 'herdr'` at `:1157`).

#### Delivery records — `notifications/<message_id>.json`, `pappra/collab-delivery/1`

| Field path                                           | Carries                                                         |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| `target.herdr_agent`, `.pane_id`                     | the routing target                                              |
| `target.native_session`                              | `match` / `unknown`                                             |
| `target.native_session_kind`                         | reported kind (`path`, `id`, …)                                 |
| `caller.source`                                      | `current` / `explicit`                                          |
| `caller.pane_id`, `.harness`, `.cwd`, `.observed_at` | what the caller looked like when observed                       |
| `caller.native_session`, `.native_session_kind`      | caller-side session comparison                                  |
| `caller.process_affiliation`                         | always `not-established`                                        |
| `status`                                             | `submitting`/`submitted`/`blocked`/`refused`/`unknown`/`failed` |
| `attempts[].{at,status,detail,reservation_id}`       | every delivery attempt                                          |

Shape: `src/schemas/collaboration.ts:365-432`. Written by
`src/app/collab-notify.ts` and read by `readDeliveryRecord`
(`src/collab/persisted-messages.ts:763`).

#### Message envelopes — `harness-collab/message/1`

| Field path                           | Carries                            |
| ------------------------------------ | ---------------------------------- |
| `from.{agent_id,session_id,harness}` | required on every message          |
| `to.{agent_id,session_id,harness}`   | required per type (see `PER_TYPE`) |
| `content_digest`                     | digest of the registered content   |
| `task_id`, `subtask_id`, `attempt`   | protocol scoping                   |

`REQUIRE_IDENTITY = ['agent_id', 'session_id', 'harness']`
(`src/collab/envelope.ts:43`), per-type presence at `:45-71`, `from`/`to` at `:151-169`, digest at `:223-234`.

#### Capability cards — `pappra/host-capabilities/1`

| Field path                                  | Carries                                                          |
| ------------------------------------------- | ---------------------------------------------------------------- |
| `host`, `surface`                           | which runtime and which integration surface                      |
| `version`, `executablePath`, `configPath`   | the executable that was observed                                 |
| `observedAt`                                | when the card was derived                                        |
| `capabilities[].event`, `.nativeEvent`      | lifecycle event and the host's own name for it                   |
| `capabilities[].state`                      | `installed`…`verified`, plus **`unsupported`** and **`unknown`** |
| `capabilities[].reason`, `.evidence`        | why, and bounded evidence                                        |
| `limits`, `reloadRequired`, `trustRequired` | explicit ceilings instead of inference                           |

Shape: `src/schemas/host.ts:55-69`, states at `:34-42`. The collaboration
capability card adds `observed_at`, aged by that card's own bound:
`src/collab/preflight.ts:246` adds `capabilities_stale` past `maxAgeMinutes`
(default 30, `src/app/collab-preflight.ts:96`). That is one of two age bounds,
not the only one: a reused `attempts[].native.observed_at` is aged by
`NATIVE_OBSERVATION_MAX_AGE_MINUTES` (30) in `src/collab/native-observation.ts`,
for a different subject and purpose.

## 2. Seams

### 2.1 Seams that already exist

Four interfaces already isolate transport behaviour. They are the extraction
starting point inside **one** channel, not a channel-agnostic framework: each is
Herdr-shaped, taking pane ids and agent names and returning Herdr refusal codes.
They say nothing about what a second channel would look like (§5).

**1. `HerdrTransport`** — `src/app/collab-notify.ts:102-133`

- Operations: `verifyCaller({paneId?})` (`:107`), `list()` (`:113`),
  `prompt(agent, text, registered?)` (`:115`).
- Default implementation: `createHerdrTransport` (`:323`), documented as
  "the installed Herdr CLI, argv only, never `--wait`" (`:321`).
- Every CLI call inside it: `pane current --pane` (`:383`),
  `pane current --current` (`:454`), `agent list` (`:518`),
  `agent prompt` (`:647`).
- Injected: `notifyRegisteredMessage` falls back to it at `:1530`; tests pass a
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

| File:line                                            | Reaches                                                |
| ---------------------------------------------------- | ------------------------------------------------------ |
| `src/app/managed-pi-herdr.ts:35`, `:39`              | spawns `herdr` through `runHerdrCommand`               |
| `src/app/managed-pi-herdr.ts:63-65`                  | `pane process-info --pane`                             |
| `src/app/managed-pi-herdr.ts:109-122`                | `pane report-agent …` (state publication)              |
| `src/app/managed-pi-herdr.ts:124-140`                | `pane report-agent-session …` (session publication)    |
| `src/app/managed-pi-herdr.ts:144`                    | `agent rename`                                         |
| `src/app/managed-pi-herdr.ts:147-155`, `:195-203`    | `pane release-agent`                                   |
| `src/app/managed-pi-native-observation.ts:115-116`   | `herdr pane process-info` for OS-level ownership       |
| `src/app/collab-bootstrap.ts:2049-2053`              | builds the plan text `herdr pane split …`              |
| `src/app/collab-bootstrap.ts:2157-2180`              | builds the plan text `herdr agent start …`             |
| `src/app/collab-bootstrap-transport.ts:398`, `:1019` | prefixes raw argv with `herdr` inside the adapter      |
| `src/app/collab-workflow/prepare.ts:1157`            | writes the literal `channel: 'herdr'` into the binding |
| `src/app/collab-recovery-executor.ts:143`            | refuses any non-`herdr` channel                        |

Environment coupling, which is transport identity read from the process rather
than from a record:

| File:line                                            | Reads                            |
| ---------------------------------------------------- | -------------------------------- |
| `src/app/collab-notify.ts:355-357`                   | `HERDR_BIN_PATH`                 |
| `src/app/collab-notify.ts:362`                       | `HERDR_ENV` (must be `'1'`)      |
| `src/app/collab-notify.ts:434`                       | `HERDR_PANE_ID`                  |
| `src/app/collab-notify.ts:502`                       | `HERDR_WORKSPACE_ID`             |
| `src/app/collab-bootstrap-transport.ts:678-681`      | `HERDR_BIN_PATH`                 |
| `src/app/managed-pi-resume-admission.ts:470`         | `HERDR_PANE_ID`                  |
| `src/app/managed-pi-sdk-runtime.ts:135`, `:524`      | `HERDR_PANE_ID`, `HERDR_ENV`     |
| `src/cli/commands/collaboration-handoff.ts:178`      | `HERDR_PANE_ID` as `caller_pane` |
| `src/adapters/pi/session-transition-extension.ts:96` | `HERDR_PANE_ID` (extension-side) |

Agreed shapes are Herdr-shaped too: the pane id grammar
(`/^[A-Za-z0-9]+:p[A-Za-z0-9]+$/`) at `src/app/collab-notify.ts:44` and
`src/app/collab-bootstrap-transport.ts:25`, and the agent-name grammar at
`src/app/collab-bootstrap.ts:96` and `src/app/collab-bootstrap-transport.ts:27`.

### 2.3 Where Pi is still assumed directly

| File:line                                                                                           | Assumes                                                              |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `src/hosts/pi/managed-sdk-session.ts:354`, `:1483`, `:1966`                                         | `pinned_pi_1_4_owned_runtime` — a pinned Pi runtime                  |
| `src/hosts/pi/managed-sdk-session.ts:483`, `:489`                                                   | `sdk_private_source_unavailable`, `sdk_private_source_hash_mismatch` |
| `src/hosts/pi/rpc.ts`, `src/hosts/pi/managed-session.ts`                                            | Pi RPC and managed control                                           |
| `src/adapters/pi/*`                                                                                 | Pi extension entrypoints                                             |
| `src/app/collab-bootstrap-transport.ts:95`, `:564`, `:1194`                                         | managed SDK model pinned to `provider: 'openrouter'`                 |
| `src/app/managed-pi-native-observation.ts:110`                                                      | same OpenRouter pin when validating a launch                         |
| `src/app/collab-bootstrap-transport.ts:1139`, `src/app/managed-pi-initial-admission.ts:122,132,183` | `harness === 'pi'` gates                                             |
| `src/app/collab-notify.ts:347`, `:366-368`                                                          | upgrades a pane with no session to a Pi SDK identity                 |
| `src/hosts/version.ts:6-31`                                                                         | bounded `--version` observation, no prompt                           |

Pi private-source and version fences therefore sit inside
`src/hosts/pi/managed-sdk-session.ts` and cannot be removed by an extraction:
they validate a pinned artifact, not a transport.

## 3. Minimal contracts

The four operations G1 actually exercised. Each entry states what the contract
guarantees, what it refuses, what evidence it may claim, and what an unsupported
implementation must say instead of guessing.

### 3.1 Task context read

Reads of recorded knowledge that need **no pane, no channel and no host
identity**: the workspace record, registered documents, continuity and checkpoint
material, code query results, and the task record itself. The G1 Codex desktop
path used exactly this and none of the rest.

- **Guarantees**: a bounded read returns either the recorded bytes with their
  digest, or an explicit failure. Paths are checked inside the selected root,
  symlinks are not followed, and a namespace that changed underneath fails closed
  instead of being re-read (`openMessageTask`, `assertMessageTaskCurrent`).
- **Refuses**: an unregistered or unsafe id, a path outside the workspace, a
  redirected root, an oversized artifact, invalid JSON, a document that failed
  schema validation, and any request that would infer a workspace from an
  unrelated session.
- **May claim**: `declared` for what the record says was read, `observed` only
  for a bounded artifact the reader actually opened. A digest proves the bytes,
  never who read them or whether the reader understood them.
- **Unsupported implementation must report**: `unknown` for a missing artifact
  and name what was absent — never substitute another workspace's document, a
  cached copy of unknown age, or a fabricated summary.

### 3.2 Host/channel identity observation

An identity the **host really reports**: pane, agent name, native session and
capability card. This is the transport-specific contract, and the evidence level
is exactly what that host can prove.

- **Guarantees**: a participant resolves to exactly one live match, and every
  compared field agrees — name, pane, harness, cwd and any reported native
  session (`collab-notify.ts:1243-1322`). A capability card records what the
  executable reported, with `unsupported` and `unknown` as first-class states.
- **Refuses**: zero matches, more than one match, a pane/harness/cwd mismatch, a
  reported session that differs from the message target, an archived identity
  used as a current route, a missing or invalid environment marker, and any
  focus-based or title-based inference (`collab-notify.ts:362-512`).
- **May claim**: `match` / `unknown` for the native session,
  `process_affiliation: 'not-established'` for the process, and `declared` for a
  selection the host stated. A pane id is not a native session id, and a roster
  entry is not proof that the process is alive or idle.
- **Unsupported implementation must report**: `unavailable` or `unknown`, with
  the field it could not observe, and leave the delivery un-attempted. It must
  never fall back to a focused pane, a default agent, a window title, or a
  configuration key that merely names a channel.

### 3.3 Submission

Delivers a pointer to a message whose **file** is registered at the requested id
and whose acceptance the task record holds. Registration of the file is not the
same as acceptance by the task record, and both are required — see "File
validation versus record acceptance" below.

- **Guarantees**: the file passes `readRegisteredMessageSafe`
  (`src/collab/persisted-messages.ts:404`), `message.task_id` matches the record,
  and the freshly read record holds an `applied` or `recorded` `record.messages`
  entry for that id with the same content digest — all before any transport call
  — and every outcome is persisted as a delivery attempt
  (`notifications/<message_id>.json`).
- **Refuses**: an unsafe id, a file that is missing, a symlink, redirected,
  oversized, not JSON, or fails protocol validation, a file whose `message_id`
  differs from the requested id, a task mismatch, a digest that changed after
  validation, a binding that changed mid-flight, a second implicit send, more
  than the bounded retry count, and delivery with no verified caller.
- **Also refuses (#17)**: a valid file the task record has not accepted
  (`message_not_recorded`), an accepted id whose file content differs from the
  accepted content (`message_content_not_recorded`), and an entry in any state
  outside the closed `applied`/`recorded` allow-list
  (`message_record_state_not_notifiable`). Plan mode applies the same gate and
  still queries no transport.
- **May claim**: `submitted` only. `consumed` and `taskAccepted` are typed as
  the literal `false` (`collab-notify.ts:782`, `:1234`), so a caller cannot even
  express the stronger claim from the notify result.
- **Unsupported implementation must report**: `unavailable` when it cannot
  deliver at all, `unknown` when the effect is ambiguous, and never "delivered".

#### File validation versus record acceptance

Two different checks, in two different functions:

| Check                   | Where                                                                                           | What it proves                                                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File validation         | `readRegisteredMessageSafe` (`src/collab/persisted-messages.ts:404`)                            | the bytes at `messages/<id>.json` are a regular, unredirected, well-formed envelope whose `message_id` equals the requested id and whose `task_id` equals the record's id |
| Record acceptance state | `readMessageFromTaskRoot` (`src/collab/persisted-messages.ts:796`, record lookup at `:802-805`) | the task record itself holds an entry for that id; the result field is `entry` and it may be `null`                                                                       |

`notifyRegisteredMessage` requires both (#17). File validation runs first, then
the record-acceptance gate (`recordAcceptanceFailure`, `src/app/collab-notify.ts`)
reads `record.messages` from the freshly opened record — once before any delivery
reservation and again in the last revalidation before submission, so no async
seam remains before the prompt. The same rule already governs the owned-Pi
sibling path (`deliverManagedPiMessage`, `src/app/managed-pi-delivery.ts`). A
valid file the record has not accepted is refused, in plan and in apply. The
behaviour is pinned by the second test in
`tests/collab/transport-runtime-contract.test.ts` and by
`tests/collab/notify-record-acceptance.test.ts`.

### 3.4 Result observation

Reads a persisted result, report, delivery record, or the same message through
the record-aware reader.

- **Guarantees**: the reader is bounded, identity-checked (path inside the task,
  regular file, real path equal to the requested path), and returns the digest
  it actually read (`src/collab/persisted-messages.ts:404-502`). The
  record-aware reader returns both the file facts and the record `entry`, so the
  caller can tell "the file is valid" from "the record accepted it"
  (`:796-806`).
- **Refuses**: unsafe ids, symlinks, redirected paths, oversized files, invalid
  JSON, a file whose `message_id` differs from the requested id, an unknown
  classification, and a stale record presented as a current one.
- **May claim**: `applied` for a recorded decision, `submitted` for a delivery,
  `unknown` for everything the record does not state, and `entry: null` for an
  id the record does not hold.
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
- **Generic task identity is channel-independent.** Every channel shares one
  identity and one evidence model: `task_id` / `task_root`, `subtask_id`,
  `attempt`, the caller and assignee triple (`agent_id`, `session_id`,
  `harness`), the message id and `content_digest`, claim keys, and the task state
  machine. These are the fields in `harness-collab/state/1`,
  `harness-collab/message/1` and the claim records, and core modules read only
  these.
- **Channel-specific routing data is not identity.** A pane id, a Herdr agent
  name, the `channel: 'herdr'` literal in the binding, the bootstrap and pane
  receipts (`launch_reservations[].bootstrap.receipts[].argv`) and the delivery
  record's `target` / `caller` fields describe how to reach a participant. They
  are routing metadata, never authority (§4). They live in three places, and the
  third one is easy to miss because it is the authority store itself:
  - the **binding document** — `channel`, `participants[].herdr_agent`,
    `participants[].pane_id`;
  - **delivery records** — `target`, `caller`, `status`, `attempts`;
  - **`task.json`**, which carries transport and runtime fields alongside task
    identity: `launch_reservations[].transport`, `.pid`, `.session_id`,
    `.run_id`, `.resume_selector`, `.identity_status`, `.expected_identity`,
    `.observed_identity`,
    `.bootstrap.receipts[].argv`, `.bootstrap.managed_sdk_config.{herdr_agent_name,herdr_pane_id}`,
    `managed_pi_initial_launches[].pane_id` (with `.pid`, `.descriptor_file`,
    `.controller_run_id`) and the `attempts[].native.*` observation.

  The `task.json` carriers are the boundary this design has to keep track of: the
  record is where task identity lives, yet these fields are routing or runtime
  observations written into it. `managed_pi_initial_launch.ts:46` is the clearest
  example — an owned initial launch persists `pane_id` into the record at
  registration time. Today the readers are adapter-side only:
  `managed-pi-initial-launch.ts:61-73`, `managed-pi-native-observation.ts:174,217`,
  `managed-pi-source-admission.ts:342`, `collab-pane-reclaim.ts:245,361,403`,
  `collab-bootstrap.ts:2067,2741,2821`, plus the routing steps of `prepare`,
  `dispatch` and `notify`. Core modules (envelope, claims, work plan, reports,
  acceptance, preflight) read none of them. Those readers stay in the adapter
  layer in any future split, and a later extraction must re-point them at the
  channel representation instead of assuming routing data lives only outside the
  record.

- **A new channel is a new representation, not another `HerdrTransport`
  implementation.** `HerdrTransport` and `HerdrBootstrapOps` are Herdr-shaped —
  they take pane ids and agent names and return Herdr refusal codes — so they sit
  inside one channel and cannot carry a second one. A new channel would need its
  own binding form (its own `channel` value with its own routing fields), its own
  dispatch path for that form, and its own reader. The read boundary is the
  point: core modules (envelope, claims, work plan, reports, acceptance,
  preflight) must read only task identity and never routing data; only the
  adapter layer and the routing steps of `prepare`, `dispatch` and `notify` may
  read channel-specific fields. Existing bindings keep the Herdr interpretation;
  an unknown `channel` value is refused, not guessed. **G2 defines no new
  schema**: the design above is a statement about a future change, which needs
  its own issue and its own migration decision.
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

`tests/collab/transport-runtime-contract.test.ts` pins the boundaries that no
existing test pinned. Every other row cites the test that covers it.

| #   | Required case                       | Status                                   | Covered by                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ----------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | unavailable capability              | existing                                 | `tests/collab/messages.test.ts` — "notification is unavailable outside a verified Herdr caller" (status `herdr_unavailable`, `consumed: false`, no delivery record)                                                                                                                                                                                                                    |
| 2   | stale identity                      | existing (two separate bounds)        | `tests/collab/capabilities.test.ts` — "Pi replay keeps the native observation time and goes stale" (`capabilities_stale` past the 30-minute card bound, `src/collab/preflight.ts:246`). This covers capability preflight. Reused `attempts[].native` observations now have their own bound in `src/collab/native-observation.ts` — see Known gaps and `tests/collab/native-observation-age.test.ts`                                                                                       |
| 3   | submitted-not-consumed              | existing                                 | `tests/collab/messages.test.ts` — "notify validates the binding and sends one pointer-only prompt" (`submitted`, `consumed: false`, `taskAccepted: false`, duplicate recorded)                                                                                                                                                                                                         |
| 4   | unknown delivery / no replay        | existing                                 | `tests/collab/workflow-notifications.test.ts` — "an unknown delivery stays unknown and is never replayed automatically"                                                                                                                                                                                                                                                                |
| 5   | changed workspace (#13)             | existing                                 | `tests/collab/shell-readiness.test.ts` — "readiness fails closed on pane, workspace, terminal, cwd and agent drift" (`workspace_id_mismatch`); task-root redirect in `tests/collab/messages.test.ts` — "unsafe ids, malformed records, task mismatch and redirected state fail closed"                                                                                                 |
| 6   | lack of stop proof                  | existing                                 | `tests/collab/rollover.test.ts` — "unknown quiescence and non-complete inventory never authorize transfer" (`old_writer_not_stopped`, `stop_evidence_required`)                                                                                                                                                                                                                        |
| 7   | registered-message validation (#17) | decided — notification requires record acceptance | `tests/collab/transport-runtime-contract.test.ts` — "a registered message whose id does not match its registration is refused" (the file-level half) and "notify refuses delivery when the file is valid but the record has not accepted the message" (the record half); `tests/collab/notify-record-acceptance.test.ts` — "notify refuses a registration the protocol rejected, in plan and in apply", "notify refuses a hand-placed envelope the task record never accepted", "notify refuses a file whose content differs from what the record accepted" and "notify still forwards one pointer for a message the record accepted" |

### Known gaps, stated rather than faked

- **Reused transport observations have an age bound; the live path does not need
  one.** A persisted `attempts[].native.observed_at` is dated but nothing compared
  it with `now`, so an old observation that still matched was accepted and never
  downgraded. #35 closes that for the consumers that *reuse* a recorded
  observation, with one shared evaluation and no schema change:
  `src/collab/native-observation.ts` classifies an observation as `fresh`,
  `expired`, `missing` (`observed_at: null`), `invalid` (unparseable) or `future`
  (more than a minute ahead of `now`). `NATIVE_OBSERVATION_MAX_AGE_MINUTES = 30`
  is the one named bound; it is deliberately its own native-observation bound,
  not the 30-second session quiescence window (`MAX_QUIESCENCE_AGE_MS`,
  `src/app/collab-session-transition/journal.ts:110`), and it is only
  numerically equal to the capability card default because a settled runtime
  observation is still a useful statement about a live session for about that
  long. `unknown` is the floor: an attempt that recorded nothing
  (`observation: 'unknown'` and no ids) is `missing`/not asserted rather than
  "assume unchanged", and only `fresh` may be treated as current.

  A clock that is not a finite number dates nothing, so it fails closed: the
  verdict is `invalid` and names the clock, and a decision consumer refuses it
  like any other non-fresh case. The REPORT body is the one persisted reader, so
  it publishes a clock-independent projection — the recorded `observed_at`, the
  bound and whether a native fact is asserted, never `age_ms` or a
  classification — and a resend at another time stays a duplicate instead of a
  `content_conflict`.

  The consumers, each with the four non-fresh cases treated as non-current:

  | Consumer | fresh | expired | missing | invalid | future |
  | --- | --- | --- | --- | --- | --- |
  | Recovery `continue` (`collab-recovery-executor.ts`, `validateAuthority`) | authorizes | `refused`, note names the classification | `refused` (an asserted observation without a date) | `refused` | `refused` |
  | Rollover pre-transfer eligibility (`collab-rollover.ts`, `inspectOrPlanRollover`) | counts as `confirmed` | `native_observation_stale` drift | same drift | same drift | same drift |
  | Dispatch retry gate (`collab-workflow/dispatch.ts`, `canRetryReviewClaims`) | refuses | refuses | refuses | refuses | refuses |
  | History: REPORT body (`collab-workflow/participant.ts`) | reports `native_ref` + `native_age` | reports, never refuses | reports, never refuses | reports, never refuses | reports, never refuses |
  | History: `workflow inspect` (`collab-workflow/inspect.ts`) | reports `native_observation` + `native_age` | reports, never refuses | reports, never refuses | reports, never refuses | reports, never refuses |

  Recovery keeps its existing conservative behaviour for a session mismatch and
  adds nothing to the plan wording: a refusal returns `refused`, writes no
  reservation, issues no controller effect and changes no claim record. Rollover
  changes the transfer **eligibility judgement** only — the recorded observation
  is still reported as recorded, claim records, holders and transfer mechanics
  are untouched, and a completed transfer keeps its recorded history because its
  observation is post-transfer correlation rather than a live eligibility claim.
  The dispatch retry gate needed no code change: it refuses on any recorded
  native evidence, so an expired observation still blocks a retry and a *fresh*
  one never lifts that guard. The history consumers add `native_age` beside the
  recorded observation and never refuse, so an `observed_at: null` record still
  loads.

  The live path is untouched because notify already re-observes: every call
  re-reads `transport.list()` and stamps `caller.observed_at =
  nowIso(options.clock)` (`src/app/collab-notify.ts:1611`), so there is no stored
  observation to age there and no delivery rule was added — that change did not
  touch `src/app/collab-notify.ts`. No transport, channel representation,
  message/acceptance semantics or migration is involved: the evaluation reads an
  existing nullable field. Where the caller already owns a clock — a session
  transition (`src/app/collab-session-transition.ts`,
  `src/app/collab-session-transition/freeze.ts`) or a replay — it is threaded
  into the evaluation through `inspectOrPlanRollover`'s in-process `now` option,
  so a fixture or a replay is judged against its own time rather than the wall
  clock; the CLI keeps `Date.now()` and no request field accepts a clock.
- **Case 6 cannot prove quiescence for interactive Pi.** Interactive Pi exposes
  no stop proof, so the only honest outcomes are refusal and `unknown`; the
  rollover test pins that refusal rather than a positive proof.
- **`src/app/managed-pi-herdr.ts` cannot be exercised from a test without a real
  pane.** It asserts OS ownership with `pane process-info` before every
  publication, so its direct `herdr` calls stay outside characterization until
  an injectable ops type exists. That is extraction work, not a test gap to hide.
