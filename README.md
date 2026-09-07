# foreman

Hand a coding task to a non-Claude model through OpenCode, then verify what it actually did.

Claude stays the orchestrator: it writes the handoff, an external model (Kimi, GLM) does the work in one registered repository, and the result is checked against git rather than taken from the model's own summary.

## Setup

```
claude plugin marketplace add C:\Users\MohammadMalik\Documents\Codex\foreman
claude plugin install foreman@local -s user
```

Then, in a repository you want to use it in:

```
/foreman:setup
/foreman:register . --allow-external
```

`--allow-external` is a separate decision on purpose. Without it the repository is registered but delegation is refused, because delegating sends your handoff and whatever the agent reads to OpenCode Zen, Moonshot and Fireworks.

## Using it

```
/foreman:delegate --model kimi --role builder --write add a --dry-run flag to the sync command
/foreman:status
/foreman:result
/foreman:revert <job-id>
```

Long jobs take `--background` and are reported when they land.

### Letting Claude dispatch in auto mode

`/foreman:delegate` is human-invoked, so Claude cannot run it. In auto mode Claude falls back to calling the runtime through Bash, and a handoff pasted onto that command line is thousands of characters of untrusted text sitting where the permission classifier expects a command. It gets blocked, and the dispatch lands back on you.

Pass the handoff as a file instead. The command line stays short and the same shape every time:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/foreman.mjs" delegate --dir <repo> --model kimi --role builder --write --background --task-file <path>
```

To allow that once, add a rule to `.claude/settings.json` in the repository, or to `~/.claude/settings.json` for all of them:

```json
{
  "permissions": {
    "allow": ["Bash(node *foreman*/scripts/foreman.mjs delegate*)"]
  }
}
```

That allows dispatch, not node in general, and it removes no gate: the workspace still has to be registered, `--allow-external` still has to be on, and `--write` still needs a clean tree and a git baseline.

## Models

| Alias | Say | Backend | Routes |
|---|---|---|---|
| `kimi` | kimi, kimi k3, k3, moonshot | OpenCode | standard (Zen), fast (Fireworks router) |
| `glm` | glm, glm 5.3, glm flash, flash, zhipu | OpenCode | GLM 5.3 Flash on both tiers |
| `sol` | sol, gpt 5.6 sol, gpt 5.6 | Codex | standard |
| `luna` | luna, gpt 5.6 luna, moon | Codex | standard |
| `astra` | astra, gpt-6-astra, gpt 6 | Codex | GPT-6, live |

Spoken names live in `config/routes.default.json`. Adding a model, or another
way of saying one, is an edit to that file: no code knows what "kimi" means.
Speed words are handled separately, so `fast kimi` and `cheapest glm` need no
entries.

## Two backends

A model can be reachable more than one way, and the ways are not equivalent.

- **Codex** shells out to `codex exec`, which runs OpenAI models on your ChatGPT
  sign-in. One detached process per job. No permission prompts: a sandbox decides
  what it may touch before it starts, read-only or write-inside-the-workspace.
- **OpenCode** drives a local OpenCode server against a provider API key, with
  per-command permission prompts you answer as they come.

So `sol` and `luna` default to Codex. Say a backend out loud to override it:
"have opencode sol review this" runs the same model against the API key instead.
Which backend ran is recorded on the job and printed in the report, never
inferred afterwards.

Everything else is identical across backends: the same job records, the same
git-derived change set, one `wait` that covers both, and `revert` either way.

Reviews stay with the Codex plugin's own `/codex:review`. This backend is for
delegating work, not for reviewing Claude's.

A model is never substituted. If a route is unavailable you get an error naming
the live alternatives, not a quiet downgrade to something else. Two cases go
further than an error:

- **Retired names.** GLM means GLM 5.3 Flash and nothing else. Say `glm 5.2`
  and it refuses, because that phrase contains `glm` and would otherwise match
  the alias and run 5.3 Flash for someone who asked for 5.2.
- **Reserved names that promote themselves.** `astra` carries the ids GPT-6 is
  expected to ship under. The day one appears in the live inventory the alias
  becomes dispatchable with no edit here, and until then it refuses rather than
  guessing at a name.

## No nested agents, for now

OpenCode 1.18.16 offers no subagent-delegation tool over its server API, so an
external agent cannot spawn children. This was built and removed rather than
shipped half-working. The runtime still enumerates child sessions from the
server, so if a later version enables delegation the reporting is already
honest; until then that list is empty.

## What it will not do

- Delegate anywhere you have not registered, or send content from a repository without `--allow-external`.
- Infer write access. `--write` is always explicit.
- Write into a dirty tree, or start a second write job in a repository that already has one running, without `--allow-dirty-tree`, because the agent's edits could not be told from yours or from each other's.
- Answer the agent's permission requests for you.
- Save a standing "always allow" rule.
- Touch your OpenCode config files, or manage credentials of its own.
- Copy a `.env`, key or credential file into a job record, even under `--allow-dirty-tree`. Revert skips those paths and says so.
- Revert a job that is still running, or revert anything outside the job's frozen change set. Files you edited yourself after the job finished are left alone and named.

## Running many agents at once

State is shared across every Claude session on the machine, so a few things are scoped to keep sessions from talking over each other.

- Finished jobs are announced in the session that dispatched them. A job whose session has gone quiet for ten minutes is offered to a session working in the same repository instead.
- `wait` with no ids covers the jobs this session dispatched and any active job in the current repository. `--all` waits on everything.
- A job past its budget has its work stopped (the session interrupted, or the codex process killed) before it is marked failed. Its edits stay on disk and the final diff is collected afterwards.
- A provider error mid-run (a rate limit, a timeout, a length cut-off) fails the job with the provider's reason. It is never reported as completed.

## What the agent can see

Provider API keys reach the OpenCode server through its environment, and every shell command the agent runs inherits that environment. The agent configs deny the obvious ways of printing it (`env`, `printenv`, `set`, `Get-ChildItem env:`, anything mentioning `API_KEY`), but a denylist is not a proof. Treat an unattended write agent as able to read the keys its server was started with, and rotate them if a transcript ever shows one.

Only provider, model, formatter and LSP settings from your own OpenCode config are carried into the servers this plugin starts. MCP servers, plugins, instructions and sharing are not, so an external model cannot reach tools you set up for yourself. `share` is forced off.

## Notes

Requires OpenCode `>=1.18.0 <2.0.0` and Node 20+. Servers run on loopback with a per-server password and are cleaned up 15 minutes after their last job.

`/codex:review` is untouched and remains a separate, human-invoked step.

## Updating after you change the source

`claude plugin update` compares versions, so editing the source without
bumping `version` in `.claude-plugin/plugin.json` leaves the installed copy
untouched and you keep running the old code. This is easy to miss: the source
looks correct and the installed plugin does not match it.

Bump the version, then:

```
claude plugin marketplace update local
claude plugin update foreman@local
```

For day-to-day iteration, skip installing entirely and run
`claude --plugin-dir C:\Users\MohammadMalik\Documents\Codex\foreman`,
which loads the source directly.
