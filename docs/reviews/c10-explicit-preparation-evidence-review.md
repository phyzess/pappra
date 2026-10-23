# C10 R1 source verification and evidence correction

Source reproduction is corrected: the independent app probe now refuses `constructor`, `toString` and `__proto__` as `assignee_harness_unsupported`, without creating a domain. All 62 current-manifest files verify. The shared own-entry/string runner lookup is reused by preparation and admission. No additional source correction is requested.

One output digest in REPORT `msg-c10-explicit-preparation-repair-r1-report` does not match its file. The pinned baseline manifest at `/private/tmp/pappra-pi-batch-1-1792543809003/c10-explicit-preparation-repair-r1/baseline.manifest.txt` actually hashes to `sha256:3abbc54deaa9a1730ee9898f221293390b5cb8edd6ef5490eb63b444683e4b86`. The REPORT and its prose instead give `sha256:3abbc54deaa9a1730ee9898f221293390b5cb8edd6ef5490eb63c77683e4b86`. All other announced output digests, assignment/review/input and native correlation verify.

Request a new immutable correction artifact and correlated REPORT carrying the actual digest. Preserve the original report/envelope and pinned files. No source changes, repeat native work, new claims or additional implementation are requested. Keep the same assignment/input revision and participant identities; explicitly supersede only the mistaken baseline digest. Final C10 delivery acceptance remains pending that evidence correction.
