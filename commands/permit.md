---
description: Answer a permission request from a running external agent
argument-hint: '<job-id> <request-id> allow|reject'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/foreman.mjs" permit "$ARGUMENTS"`

This is the user's decision, not yours. `allow` grants the action once and is never saved as a standing rule.
