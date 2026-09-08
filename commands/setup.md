---
description: Check that external agents are ready to use, and show what needs fixing
argument-hint: ''
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/foreman.mjs" doctor`

Read the report and tell the user what to do next, shortest path first. Common cases:

- Nothing approved yet: that is fine, and no setup is needed. Any git repository works; the first delegation from one will ask.
- Asked about a repository they want to delegate from: explain that delegating sends repository content to OpenCode Zen, Moonshot and Fireworks, and give them the `/foreman:allow <path>` line. Let them decide.
- A route unavailable: the report names the closest live model IDs. Do not silently pick a different model.

Never print or ask for API keys.
