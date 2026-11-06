# Attempt usage recordings

The Codex fixture contains the start, cumulative token snapshot and completion
from two completed turns in a native rollout. The Pi fixture contains a
completed native turn with assistant and tool-result records. Both retain
their native counter values. Session and entry identifiers and timestamps
were replaced, and message content and environment fields were removed.

The Claude fixture retains the init and terminal result shape emitted by
Claude Code 2.1.311 in `stream-json` mode against a scripted loopback HTTP
server. The CLI had a temporary home and its network access was restricted
to that server. Its identifier was replaced and all other payload fields were
removed. The test supplies the execution envelope separately.
