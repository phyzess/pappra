# Knowledge records and daily maintenance

Shared documents are stored independently under
`.pappra/knowledge/records/<documentId>.json`. Each file contains the workspace
identity and one document record. There is no shared index or catalog-wide
`updatedAt` field, so registering different documents on two branches creates
different files and does not introduce a common JSON merge conflict. Private
records remain in `.pappra/local/knowledge/catalog.json` and are ignored by Git.
The former shared `catalog.json` format is rejected and preserved; this beta
does not migrate old workspace state automatically.

Document identity is its stable UUID. A bounded scan retains that UUID when a
single missing-path record matches a discovered file's digest, or a case-only
rename still resolves to the same canonical file. Ambiguous matches require an
explicit document id. Changed content is not silently accepted as a rename.

```sh
pappra docs relocate <documentId> docs/new-name.md          # read-only plan
pappra docs relocate <documentId> docs/new-name.md --apply  # update metadata
pappra docs forget <documentId> --apply                   # remove metadata only
pappra docs forget <documentId> --scope private --apply   # resolve a partial share
```

Neither command moves or deletes document content. Relocation requires the
target's bytes to match the recorded digest and refuses another active
document's canonical location. Forget refuses registered references and
task-linked records whose ownership has not been reviewed. It can remove an
obsolete registration to resolve a private/shared location conflict. An explicit
scope is required to resolve an id present in both valid catalogs; the other
scope's record and its references remain intact. Removing a private duplicate
can retain its shared identity; retaining a private copy never authorizes
removing a referenced shared source. Default views report a redacted conflict;
`--include-private` exposes details explicitly. Archiving preserves history but
releases the location for an explicit new registration. Scanning does not
automatically recreate an archived registration.

`docs scan --apply` acquires one lock per batch and revalidates with a fresh
context/catalog snapshot under that lock. Up to 300 **new** documents are
registered at a time; existing records do not consume that budget. Rerun after a
partial batch to reach later candidates. Configured directories are traversed to
a bounded depth of 64; directory, entry, depth and candidate limits report
incomplete coverage instead of silent success. Batch journals record
preparation, completion or failure. An interrupted shared batch can leave
individually committed records; rerunning scan reconciles those records without
replacing document content or creating duplicate identities.

`resume` is an advisory context reader. A valid packet whose verification is
current exits successfully even when execution ownership is unverified;
`executionAllowed` remains false and the packet retains its blocking reasons.
Stale or unknown verification still exits nonzero. An undeclared embedded Git
checkout is represented as an opaque digest of its Git HEAD/status, not copied
recursively into the outer patch or treated as a broken ordinary file. Declare
that checkout as a repository when its own full continuity coverage is needed.
