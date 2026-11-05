# From task findings to reviewed knowledge

The host authors conclusions and decides whether they deserve retention.
Pappra's existing `KnowledgeService` stores bounded documents, provenance and
explicit lifecycle operations. There is no transcript ingestion, background
summarizer, promotion command, or second knowledge database.

## Retain deliberately

Propose retention after a meaningful decision, a reusable finding, or an
investigation expensive enough that a later task should avoid repeating it.
Skip routine edits, transient status and conclusions already maintained
elsewhere. Task evidence records what happened; a candidate proposes what a
future task may reuse; maintained knowledge states the reviewed conclusion and
its limits. A successful test or accepted code report does not review that
conclusion.

Before writing a candidate, record:

- The real task/revision link, question, bounded conclusion, supporting evidence,
  rejected alternatives and known limits. Label fixture evidence explicitly.
- Exact source pins: `{ kind: 'document', documentId, digest }` identifies
  registered source document bytes; `{ kind: 'code', repositoryId, path, version }`
  identifies a repository-relative file and observed revision. Register external
  task evidence through the existing service before using a document source pin.
- Intended audience and confidentiality. Start private when the evidence is
  private or sharing is not authorized. Review private sources before requesting
  explicit sharing authorization; a reviewed conclusion does not grant it.

Keep the candidate small and `maturity: 'draft'`, with its taskId and sources.
Use `proposeWrite` then `applyWrite` under the configured
`knowledge.newDocuments` destination. Read the returned record and retain its
documentId and digest. A proposal is not a write, and any failed, stale, conflict
or partial result needs inspection before proceeding.

## Review semantics and bytes separately

An independent reviewer inspects the exact candidate bytes, source pins and
current source evidence. Keep a review artifact naming the reviewer, candidate
id/digest, task/revision, conclusion, limitations and disposition. Independence
means fresh context; a `reviewed` metadata flag by itself is not proof of review.
Code acceptance and knowledge review are separate decisions.

The byte-review operation `previewReview` / `applyReview` (CLI `docs review`)
changes **only** `digest` and `lastReviewedAt`. It preserves maturity and sources.
Reviewing a draft leaves it a draft. Calling `register` again at the same
id/path/digest returns the existing record; it does not upgrade its metadata.

After semantic review accepts maintained wording, the host explicitly writes
those exact accepted bytes to a **new path** and registers a **new documentId**
with `maturity: 'reviewed'`. Link the candidate id/digest, the registered review
artifact id/digest and the reviewed code pins in `sources`; preserve the task
link in metadata and prose. This is a separate host decision, not an implicit
effect of reviewing the candidate. Pin the maintained document's reviewed bytes
with `previewReview` / `applyReview`, then call `supersede` on the candidate with
the maintained id. Keep the candidate, review evidence and old sources intact.

## Small public API example

Run this ESM file with Node in a consumer that has `@phyzess/pappra` installed
and an initialized workspace. It creates a private draft from host-authored
bytes; it does not perform semantic review. The workspace-relative candidate
path must be new and inside `knowledge.newDocuments`.

```js
// candidate.mjs
import { readFile } from 'node:fs/promises';
import { KnowledgeService } from '@phyzess/pappra/knowledge';

const [root, taskId, candidatePath, textFile, pinsFile] = process.argv.slice(2);
if (!root || !taskId || !candidatePath || !textFile || !pinsFile)
  throw new Error('Expected root taskId candidatePath textFile pinsFile');
const service = new KnowledgeService(root);
const content = await readFile(textFile);
// JSON array of observed document/code source objects described above.
const sources = JSON.parse(await readFile(pinsFile, 'utf8'));
const proposed = await service.proposeWrite({
  mode: 'create',
  location: { kind: 'workspace', path: candidatePath },
  kind: 'research',
  maturity: 'draft',
  owner: 'agent',
  taskId,
  visibility: 'private',
  sources,
  content,
  expectedDigest: null,
});
if (!proposed.ok || !proposed.proposal)
  throw new Error(JSON.stringify(proposed));
const written = await service.applyWrite({
  proposal: proposed.proposal,
  content,
});
if (!written.ok || !written.record) throw new Error(JSON.stringify(written));
console.log(JSON.stringify(written.record, null, 2));
```

After the independent semantic review, the host separately registers the new
maintained file with `service.register({ location, kind, maturity: 'reviewed',
owner, taskId, visibility: 'private', sources })`. Supply real metadata and
source pins as described above; require `status === 'registered'` and retain the
returned new id. Do not reuse the draft's path or id.

The following second ESM file records a byte review of that registered id.
`inspectedDigest` comes from the independent review evidence, not merely from
the plan being accepted. It also works for draft byte reviews without changing
their maturity.

```js
// review-bytes.mjs
import { KnowledgeService } from '@phyzess/pappra/knowledge';

const [root, documentId, inspectedDigest] = process.argv.slice(2);
if (!root || !documentId || !inspectedDigest)
  throw new Error('Expected root documentId inspectedDigest');
const service = new KnowledgeService(root);
const preview = await service.previewReview({ documentId });
if (!preview.ok || !preview.plan) throw new Error(JSON.stringify(preview));
if (preview.plan.expectedFileDigest !== inspectedDigest)
  throw new Error('Reviewed bytes differ; obtain a fresh semantic review');
const reviewed = await service.applyReview({
  plan: preview.plan,
  expectedFileDigest: inspectedDigest,
});
if (!reviewed.ok) throw new Error(JSON.stringify(reviewed));
console.log(JSON.stringify(reviewed, null, 2));
```

After successful maintained-byte review, use
`service.supersede({ documentId: candidateId, supersededBy: maintainedId })`
and inspect the result. `archive` can retire unused material while preserving
provenance. The CLI exposes `docs list`, `read` is a service method, and
`docs check`, `docs review` and `docs archive` are available commands; register,
write, source metadata, supersede and share use the existing library API.
Do not invent corresponding CLI commands.

## Demonstrate later reuse and handle drift

On a later related task, use `list` (include private records only when allowed),
`read` and `check` before relying on maintained knowledge. Follow supersession
links, inspect review evidence and scope, and record the consumed id/digest,
later task/revision, decision supported or investigation avoided. A catalog
lookup without actual use is not reuse. Do not silently treat draft, archived,
conflicting or `needs-review` content as current maintained advice.

`check` compares document source file digests; changed or missing source bytes
produce a visible review need. Code source checks verify file existence and
repository HEAD against `version`, **not code file content or dirty changes**.
The host must additionally inspect and digest any dirty source bytes it relies
on, pin that evidence in a registered document, and report the coverage limit.
Matching HEAD alone cannot establish those bytes are unchanged.

Review does not refresh sources or infer updated conclusions. If sources change,
show the reason, investigate again, and obtain a new semantic review. Preserve
the old record and source pins; register a new maintained record with the new
evidence and supersede the old one only after explicit resolution. Contradictory
findings remain visible with their provenance until the host resolves the
conflict; never overwrite the old conclusion to manufacture agreement.

Sharing requires explicit authorization for the conclusion **and its sources**.
Private sources cannot become shareable through a shareable conclusion. Keep
the chain private, or prepare separately authorized, reviewed shareable source
material before using `share`; do not copy confidential content into shared
prose, catalogs or reuse reports.
