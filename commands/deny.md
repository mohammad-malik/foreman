---
description: Withdraw approval for a repository's source being sent to an external model
argument-hint: '<path>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/foreman.mjs" deny "$ARGUMENTS"`

Delegation from this repository is refused again until it is approved. Local work is unaffected, and nothing already delivered is undone.
