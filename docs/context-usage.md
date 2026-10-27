# Context usage signals

A long-running coordinator needs to know when its own context is filling so it can hand
the role to a fresh session at a cohort boundary (see
[cross-host coordinator continuity](cross-host-coordinator-continuity.md) and
`pappra collab handoff check`). Pappra records and reports that signal. It is an
**advisory only**: nothing here starts a handoff, a model, a checkpoint or any other work,
and an absent, stale or malformed observation is reported as `unavailable`, never as "low".

## Observation

A numbers-only record per host session, stored privately under the user data directory
(`PAPPRA_DATA_HOME`, or the platform default) at
`context-usage/<host>/<session-id>.json`, schema `pappra/context-usage-observation/1`:
host, session id, observed time, `used_percent` (0-100, at most one decimal), token counts
and the window size when known, the source and the host version. It holds no transcript
content. Writes are atomic with owner-only permissions, refuse a redirected directory, and
reads are bounded and strict. An observation older than 10 minutes, or dated in the future,
is stale, with five seconds of clock skew tolerated between the writing and reading process.

| Host | Source | What is read |
| --- | --- | --- |
| Claude Code | status-line beacon | `context_window.used_percentage` from the status-line payload. It is an integer percent and is null before the first response, which is not 0%. |
| Codex | shared app-server daemon | `last.totalTokens / modelContextWindow` from the replayed `thread/tokenUsage/updated`. `total` is cumulative spend and is never used. |

## Reading it

```sh
pappra context usage --host <claude|codex> --session <id> \
  [--advise-percent <1-99>] [--max-age-seconds <n>] [--json]
```

`--max-age-seconds` applies to Claude observations only and is refused for Codex, whose read
is live. Exit code 0 means an observation was available (whether or not it crosses the threshold, 70%
by default), 1 means unavailable, 2 means invalid arguments. When the threshold is crossed
the advice points at `pappra collab handoff check`.

`pappra collab workflow inspect` adds `detail.context_advisory` for the task's coordinator
and a `context:` warning when a Claude coordinator is past the threshold. It reads only the
local observation file: no network and no native query. For a Codex coordinator it points at
`pappra context usage --host codex --session <id>` because Codex needs a live read. A Pi
coordinator has its own [automatic handoff](automatic-handoff.md) and gets no advisory here.

## Claude Code: the status-line beacon

Claude Code exposes context usage only to the status-line command, so the beacon is a thin
wrapper around **your existing status-line command**. It records the observation, then runs
your command with the payload exactly as Claude Code sent it and prints exactly what it prints,
passing the exit code through. It makes no network request, starts no model and never fails
the status line because a write failed. A chained command that hangs is killed after four
seconds together with everything it started (its whole process group), so no orphaned child
keeps the status line waiting. If Claude Code has not closed stdin after two seconds, what
arrived so far is used; a payload over 8 MiB is cut there. Usage is recorded only from a
payload within 1 MiB. If a chain is configured but cannot be decoded, the beacon prints
`pappra: status-line chain is invalid` and exits 1 instead of silently replacing your line.

Opting in is explicit and Pappra writes no settings file:

```sh
pappra context statusline-plan [--project-dir <abs>] [--claude-home <abs>] [--json]
```

The plan finds the status line Claude Code would use (project local settings, then project,
then user), prints the exact `statusLine` value that chains it through the beacon, and tells
you which file to put it in. By default that is `.claude/settings.local.json` in the project:
it overrides the user setting for this checkout only, leaves your user-scope settings
untouched, and is undone by deleting the key. The beacon path is POSIX single-quoted and the
chained command travels base64-encoded, so no shell metacharacter in either can alter the
command. The plan refuses, with the reason, rather than print a snippet that would break the
status line: a status line that is not a command, a command longer than the chain limit
(about 12 KB), a beacon entry that does not exist in this build, or Windows (the quoting is
POSIX-only).

The beacon entry point is `dist/hosts/claude/statusline-entry.js` of the build that produced
the plan, so the plan is bound to that checkout's build and must be regenerated after moving
or rebuilding it.

## Codex: live read

`pappra context usage --host codex` connects to the shared local app-server daemon through
`codex app-server proxy`, attaches to the one thread with `thread/resume`, reads the usage the
server replays on attach, and detaches with `thread/unsubscribe`. It sends only `initialize`,
`initialized`, `thread/resume` and `thread/unsubscribe`, never a turn or a compaction. It
checks that the resumed thread is the one asked for, writes the unsubscribe and close frames,
waits (at most 300 ms) for them to flush, and then stops the proxy; closing the connection
also drops the subscription on the server side. It was verified against Codex 0.164.0 only:
the daemon accepts external requests that change a session (a compaction request ran during
the phase 0 probes), so re-verify the read after a Codex upgrade.

Observed against Codex 0.164.0, including a live interactive session that kept working
normally after being read: a thread that has not received a message has no rollout yet, and
the server answers a thread id that does not exist the same way (`no rollout found for thread
id ...`). Both are reported as `no_rollout_yet`; the two cannot be told apart. A malformed id
is rejected by the server as `invalid session id` and reported as `thread_not_found`. The
other reasons are `daemon_unreachable`, `no_usage_replayed`, `protocol_error` and `timeout`.
The thread id of a running Codex session can be listed from the daemon's `thread/loaded/list`.

## Limits

- Advisory only: no hook, command or observation starts a handoff or writes a checkpoint.
- Claude usage is only as fresh as the last status-line refresh and has 1% granularity.
- Observation files are small and are not pruned automatically.
- The beacon is opt-in per checkout; without it Claude usage is `unavailable`.
