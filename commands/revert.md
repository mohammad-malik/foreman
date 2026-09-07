---
description: Undo only the files one external-agent job changed
argument-hint: '<job-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/foreman.mjs" revert "$ARGUMENTS"`

This restores only the paths recorded in the job's frozen change set, so edits you made yourself after the job finished are left alone and named in the output. It refuses a job that is still running (cancel it first) and refuses outright if HEAD has moved since. Report exactly which files were restored, deleted or left alone.
