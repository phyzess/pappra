# Host-native boundaries

This page records which capabilities belong to the host coding agent and which
belong to Pappra. It is the architecture decision behind the task-driven
execution policy in [AGENTS.md](../AGENTS.md) and
[collaboration-workflow.md](collaboration-workflow.md).

## Context

Pappra runs inside host agents. A host already owns its own tools: file edits,
shell commands, subprocess launches, MCP clients, panes and its model choice.
Pappra adds durable task state on top of that: tasks, sealed assignments,
resource claims, messages, reports, acceptance decisions and bounded evidence.

Earlier policy blurred the two layers. It required a separate writer for every
source edit, presented a visible pane layout and a managed Pi runtime as general
prerequisites, and prescribed one model family per role. Those described a single
deployment, not a property of the product. The practical result was a host that
could edit a file being told not to, and a host without Herdr, Pi or a managed
runtime appearing unable to collaborate at all.

## Decision

1. **Direct work is first-class.** A host agent may assess, plan, implement and
   verify a change itself with its own native tools, including repository source.
   A trivial or tightly coupled change needs no separate writer.
2. **Delegation is a task-driven choice.** Independent work that can run in
   parallel, genuinely disjoint write scopes, or a decision that needs fresh
   context justify it. The host records the choice and its reason before
   implementing.
3. **Independent review needs an independent context, not a different model or
   provider.** A reviewer that starts from the change and its evidence, without
   the author's conversation, qualifies. A review-only assignment can itself be
   that review.
4. **The host orchestrates with its own native tools.** Pappra records
   task/evidence state and does not invent managed ownership, capability or stop
   proof.
5. **Tools visible to a host agent are not assumed available to a standalone
   CLI.** A CLI run inherits its own surface only; a missing desktop tool is a
   condition to report, not something to simulate.
6. **No automatic fallback to a different harness.** When the requested channel,
   identity or capability is unavailable, the work stays outstanding with the
   blocker recorded.
7. **Unknown stays unknown.** Missing delivery, identity, stop proof or cost
   evidence is reported as unavailable or unknown and is never fabricated.

## Consequences

- Ordinary implementation no longer needs a second participant. The critical
  path shortens, and a small host-native change can finish without a cohort.
- Risk still governs review. Authorization, resource ownership, persisted
  state/recovery and release execution require an independent review before
  completion, whatever the size of the diff.
- Capability claims get narrower and more accurate. Pappra reports what it
  recorded, not what the host did, and says so.
- Multi-agent work is one option among several. Its coordination cost is real;
  nothing here claims it is inherently cheaper.
- Existing task records keep the semantics they were created with. This decision
  does not reinterpret or rewrite old bindings.

## Capability ownership

Host-owned execution is everything that actually touches the world. Pappra-owned
state is the record of what was asked, claimed, reported and accepted.

| Capability                        | Host-owned execution                                                        | Pappra-owned task/evidence state                                               | Evidence level Pappra may claim                                  |
| --------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Editing files, running commands   | The host decides and performs every write and command with its own tools.   | Declared write/read resources and their claims, plus the paths a report names. | `declared` — a claim is intent, never proof of a write.          |
| Choosing roles and participants   | The host reads the objective and change surface and picks the split.        | Roles, subtasks, assignments and their sealed digests once requested.          | `declared` — the backend validates a request; it infers nothing. |
| Choosing a model or configuration | The host selects it and states the selection explicitly.                    | The selection as written into the request and the assignment.                  | `declared` — an observed selection is recorded, not verified.    |
| Launching a session               | The host launches its own process, pane or runtime.                         | A reservation for a requested launch, and the outcome the host reports.        | `unknown` unless a host-produced artifact proves that session.   |
| Delivering a message              | The host or its native channel carries the payload to the peer.             | Registered messages, digests, delivery state and notification attempts.        | `submitted`/`unknown` — routing is not process authentication.   |
| Accepting a result                | A coordinator or the user decides, explicitly and separately.               | Acceptance records with their reason, correlated to a specific report.         | `applied` — the decision is recorded; it approves nothing else.  |
| Proving what a participant did    | Only the participant and its harness can produce that evidence.             | Whatever bounded artifact the host published, and the gap when none exists.    | `unknown` by default; `observed` only for a validated artifact.  |
| Stop proof and native quiescence  | Depends on the harness; several hosts cannot report it at all.              | The absence of proof, recorded as unknown rather than assumed.                 | `unknown` unless a supported proof path produced it.             |
| Desktop and pane tools            | Visible only to the host agent that has them; never inherited by a CLI run. | `caller_pane` and pane placement as routing metadata.                          | `declared` — a pane id is not a native session id.               |
| Cost and token accounting         | Owned by the harness and its provider.                                      | Nothing beyond what the host publishes; no derived estimate.                   | `unknown` when unpublished.                                      |

What Pappra does not own, in every row above: the execution itself, the host's
tool surface, model behaviour, process lifetime, native session identity, and any
claim that a peer is alive, finished or idle. What it does own: the sealed
request, the claim, the message, the report, the acceptance decision, and an
honest evidence level for each.

## Completion semantics

Three distinct semantics share the same vocabulary and must not be conflated:

- **Direct work** completes when the implementing host verifies the change and a
  coordinator or the user accepts it. No participant record is required, and the
  agent never declares its own acceptance, approval, merge or release.
- **Independent review** completes when a reviewer with its own context reports,
  and the coordinator decides. The report is evidence; the decision is separate.
- **Managed collaboration** completes when the declared assignments, reports and
  the explicit acceptance decision agree. A registered `ASSIGN`, an `ACK`, a
  `REPORT` or a submitted notification is still not acceptance.

## Scenarios

| Scenario                      | Who executes                                 | What Pappra records                                                        | Completion semantics               | Not required                               |
| ----------------------------- | -------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------ |
| Simple direct edit            | One host agent, its own tools.               | Nothing, or an optional checkpoint for continuity.                         | Direct work.                       | A second writer, a cohort, a role plan.    |
| Tightly coupled investigation | One host agent across several files.         | Optional bounded handoff context if the work spans sessions.               | Direct work.                       | Disjoint write scopes, parallel writers.   |
| Disjoint delegation           | Several writers, one per disjoint scope.     | Assignments, resource claims, reports, per-attempt acceptance.             | Managed collaboration.             | A different model per writer.              |
| Fresh-context review          | A reviewer that starts from the change only. | The review assignment, its report and the acceptance decision.             | Independent review.                | A different provider, a new runtime.       |
| High-risk review              | An independent reviewer, then a coordinator. | Same as above, scoped to authorization, ownership, state or release paths. | Independent review.                | A second implementer, Herdr, Pi.           |
| Unsupported host control      | Nobody; the capability does not exist.       | The exact blocker and the outstanding requirement.                         | Unknown, work remains outstanding. | A simulated substitute, a silent fallback. |

## Boundaries that do not change

- Roles describe responsibility and scope. They grant no authority and approve
  nothing; acceptance stays an explicit coordinator or user decision.
- Agent ids, native sessions and capability cards come from observed evidence.
  They are never invented from prose, and a different harness is never silently
  substituted for a named participant.
- Authorization the user already gave for a task persists for that task.
- No approval is auto-answered, no cancellation is inferred from an
  acknowledgement, and no destructive or irreversible action is taken without
  explicit user intent.
- Hooks record bounded lifecycle observations only. They never select roles or
  launch a model.
- The earlier no-beta-migration decision stands. This page is not a migration
  plan, and it changes no schema, message or acceptance behaviour.
