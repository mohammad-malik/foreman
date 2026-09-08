---
description: Approve a repository's source being sent to an external model. Asked once, remembered, and worktrees are covered.
argument-hint: '<path>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/foreman.mjs" allow "$ARGUMENTS"`

There is no registration step. Any git repository works as soon as you point foreman at it, and local work is never gated.

This command answers the one question that has a consequence off the machine: whether this repository's handoffs and whatever the agent reads may be sent to OpenCode Zen, Moonshot and Fireworks. It is asked once per repository, remembered, and inherited by every worktree.

`/foreman:deny <path>` withdraws it.

This decision is the user's. Never run it on their behalf: show them the line and let them answer.
