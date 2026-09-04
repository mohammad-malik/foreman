---
description: Undo only the files one external-agent job changed
argument-hint: '<job-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/external-agents.mjs" revert $ARGUMENTS`

This touches only the paths that job changed, and refuses outright if HEAD has moved since. Report exactly which files were restored or deleted.
