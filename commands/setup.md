---
description: Check that external agents are ready to use, and show what needs fixing
argument-hint: ''
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/foreman.mjs" doctor`

Read the report and tell the user what to do next, shortest path first. Common cases:

- No workspaces registered: give them the `/foreman:register <path>` line for the repo they are in.
- A workspace registered but delegation off: explain that delegating sends repository content to OpenCode Zen, Moonshot and Fireworks, and give them the `--allow-external` line. Let them decide.
- A route unavailable: the report names the closest live model IDs. Do not silently pick a different model.

Never print or ask for API keys.
