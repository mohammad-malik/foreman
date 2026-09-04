# external-agents

Hand a coding task to a non-Claude model through OpenCode, then verify what it actually did.

Claude stays the orchestrator: it writes the handoff, an external model (Kimi, GLM) does the work in one registered repository, and the result is checked against git rather than taken from the model's own summary.

## Setup

```
claude plugin marketplace add C:\Users\MohammadMalik\Documents\Codex\external-agents
claude plugin install external-agents@local -s user
```

Then, in a repository you want to use it in:

```
/external-agents:setup
/external-agents:register . --allow-external
```

`--allow-external` is a separate decision on purpose. Without it the repository is registered but delegation is refused, because delegating sends your handoff and whatever the agent reads to OpenCode Zen, Moonshot and Fireworks.

## Using it

```
/external-agents:delegate --model kimi --role builder --write add a --dry-run flag to the sync command
/external-agents:status
/external-agents:result
/external-agents:revert <job-id>
```

Long jobs take `--background` and are reported when they land.

## Models

| Alias | Say | Backend | Routes |
|---|---|---|---|
| `kimi` | kimi, kimi k3, k3, moonshot | OpenCode | standard (Zen), fast (Fireworks router) |
| `glm` | glm, glm 5.3, glm flash, flash, zhipu | OpenCode | GLM 5.3 Flash on both tiers |
| `sol` | sol, gpt 5.6 sol, gpt 5.6 | Codex | standard |
| `luna` | luna, gpt 5.6 luna, moon | Codex | standard |
| `astra` | astra, gpt-6-astra, gpt 6 | Codex | reserved for GPT-6, activates on its own |

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
- Write into a dirty tree without `--allow-dirty-tree`, because the agent's edits could not be told from yours.
- Answer the agent's permission requests for you.
- Save a standing "always allow" rule.
- Touch your OpenCode config files, or manage credentials of its own.

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
claude plugin update external-agents@local
```

For day-to-day iteration, skip installing entirely and run
`claude --plugin-dir C:\Users\MohammadMalik\Documents\Codex\external-agents`,
which loads the source directly.
