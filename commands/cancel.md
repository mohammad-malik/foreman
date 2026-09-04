---
description: Stop a running external-agent job
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/external-agents.mjs" cancel "$ARGUMENTS"`

Cancelling stops the work but leaves any edits already written on disk. If the output mentions revert, pass that on.
