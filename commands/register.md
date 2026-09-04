---
description: Allow external agents to work in a repository, and optionally allow its contents to leave the machine
argument-hint: '<path> [--allow-external] [--force]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/external-agents.mjs" register "$ARGUMENTS"`

Two separate decisions, and the second one is the user's alone:

- Registering a path lets this plugin operate there at all.
- `--allow-external` additionally permits the handoff and whatever the agent reads to be sent to OpenCode Zen, Moonshot and Fireworks.

If they ran this without `--allow-external`, say plainly that delegation is still refused there and show the line that would enable it. Do not run it for them.
