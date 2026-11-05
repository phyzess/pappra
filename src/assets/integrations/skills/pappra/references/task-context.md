# Bounded task context from stored evidence

Use the existing checkpoint, resume packet and artifact references for a task
briefing. This is a selection recipe, not a new schema, API, service or automatic
context collector. It applies to direct work, a fresh native session and an
explicit collaboration assignment equally. See [adoption](adoption.md) when the
selected workspace or repository has not yet been established.

## Select a small, explainable evidence set

Start with the task objective, acceptance criteria, authorized write scope,
selected workspace/repository and starting revision. Read project rules first,
then select only the design decisions, current source and validation evidence
needed for the next step. Record one reason for each included source. Record
important omissions and their reasons rather than implying complete coverage.
A whole transcript or workspace dump is not a task briefing.

Choose a budget before reading: maximum source count, total bytes and per-query
limit. For example, a host may choose six source excerpts and 24,000 bytes for a
small task; these are task choices, not product defaults or new CLI options.
Report actual counts/bytes and any truncation when measured. If a count or byte
total was not measured, say so. A digest identifies bytes; it does not measure
their relevance, prove they were read, or make an excerpt complete. Keep full
source pointers for deliberately clipped material.

Use existing checkpoint fields instead of inventing fields:

| Existing carrier                             | Content to retain                                                                                          |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `objective`, `acceptance[]`, `constraints[]` | Task, completion criteria, selected scope and context budget.                                              |
| `decisions[]`                                | Selection reasons, starting revision, observed baseline and why a newer source supersedes an older one.    |
| `limitations[]`                              | Omissions, unmeasured totals, missing/stale sources, clipped reads, unrun checks and unresolved ownership. |
| `artifacts[]`                                | Paths and captured digests for the evidence files or a task-local selection note.                          |
| `nextActions[]`                              | One concrete next step, including its prerequisite if blocked.                                             |

A short selection note can hold path, relevance, excerpt boundary, observed
revision/time, digest and freshness for each source, plus counts and omitted
items. Store it privately and reference it with `--artifact`; do not put an
arbitrary note inside Pappra's internal checkpoint files. This note is ordinary
task evidence, not a second authoritative catalog. Reuse actual `docs check`
freshness and recorded artifact digests; label unknown values explicitly.

## Persist once, consume through either execution mode

From the selected workspace, after creating the named evidence note:

```sh
pappra checkpoint --task example-task --objective 'Resolve the selected task' --acceptance 'The declared behavior is verified' --constraint 'Only the declared repository and write scope' --decision 'Evidence selection and baseline are recorded in the attached note' --limitation 'Context is partial; omitted sources are listed in the note' --artifact .pappra/local/task-context/example-task.md --next-action 'Inspect the one unresolved behavior named in the note' --context-completeness partial --json
pappra resume example-task --json
```

Replace the example content, task id and artifact path with the actual task.
`--artifact` records existing files, not invented evidence. Use observed native
identity only when supplying session options. Save the returned checkpoint
revision and digest with the task reference; a moving latest pointer alone does
not identify the evidence a recipient was given. Preserve the original starting
revision separately from a later checkpoint's candidate HEAD. When dirty, retain
the patch artifact as well as its digest.

For direct work, read this stored checkpoint and the same referenced files.
For delegated work, point the assignment at that exact stored evidence, with
the task/checkpoint identity and content pins supported by the existing workflow.
Do not rewrite a second summary from memory or treat a mutable session log as
sealed assignment input. The assignment adds responsibility, acceptance and
resource scope; it does not give private evidence permission to cross a sharing
boundary. Use an explicitly reviewed shareable derivative if the recipient
cannot access the private source, retaining its provenance and omissions.

## Refresh only what is needed

The consumer runs `resume`, inspects `verificationStatus`, `codeDrift`,
`artifactChecks` and `blockingReasons`, then checks registered documents with
`docs check --json` (add `--include-private` only for intended private inspection).
A current packet may still have `executionAllowed: false`; readability and an
exit code of zero do not grant execution or establish a stopped writer.

- Missing evidence: name the path and affected conclusion. Obtain it or keep
  that conclusion unknown; never fabricate a substitute summary.
- Stale or changed evidence: compare current bytes with the captured digest and
  revision, re-read the relevant boundary, and write a new checkpoint when the
  task context changes. Keep prior evidence as history.
- Superseded evidence: identify the replacement and why it governs this task;
  do not silently merge incompatible decisions or approve changed document bytes.
- Unrelated evidence: omit it and record the reason when its absence could be
  mistaken for overlooked coverage. Do not import another task's context just
  because it is recent.
- Clipped or over-budget evidence: preserve totals, truncation and source
  pointers. Narrow the question or explicitly revise the budget before expanding.

Before handing off, check that a fresh native consumer with no transcript can
identify the selected repository, scope, baseline, relevant evidence and one
next action. If the next action depends on unavailable access or authority,
state that prerequisite and leave execution blocked. A checkpoint, assignment,
ACK or report does not accept work; the existing coordinator/user decision and
ownership rules still apply.
