@AGENTS.md

# Claude Code entry

Claude Code reads this file, not `AGENTS.md`, so the policy is imported above. In this
repository Pappra's own capabilities are required: invoke the `pappra` skill before any
repository work, and use `node dist/cli/main.js` for every Pappra command. The project
`SessionStart` hook (`.claude/settings.json`) repeats this and reports setup state.
