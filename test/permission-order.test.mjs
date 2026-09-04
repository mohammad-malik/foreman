import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CONFIG = JSON.parse(
  fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "config", "opencode-agents.json"),
    "utf8"
  )
);

/**
 * OpenCode 1.18.16 resolves the LAST matching bash rule. Verified against a
 * live server: with the catch-all trailing, `git status --short` prompted
 * despite an explicit allow, and every deny below it was downgraded to ask,
 * which quietly turned `git push` and `curl` into user-approvable commands.
 *
 * Nothing about that failure is visible by reading the config, so it is pinned
 * here instead.
 */

const agents = Object.entries(CONFIG.agent);

test("any agent with a bash rule map puts the catch-all first", () => {
  for (const [name, agent] of agents) {
    const bash = agent.permission.bash;
    if (typeof bash === "string") {
      continue; // A blanket policy has no ordering to get wrong.
    }
    assert.equal(
      Object.keys(bash)[0],
      "*",
      `${name}: the catch-all must be the first rule, or it overrides everything`
    );
  }
});

test("the researcher denies bash outright rather than asking", () => {
  // Copied from OpenCode's own `explore` agent, which denies everything and
  // allows only read, grep and glob. Asking would have been strictly worse:
  // the agent already has confined read, list, glob, grep and lsp tools, so
  // bash buys it nothing, while `ask` costs a human interruption. Denying
  // means it neither blocks on a person nor escapes the repository.
  assert.equal(CONFIG.agent["external-researcher"].permission.bash, "deny");
});

test("the builder asks, because it needs bash for tests", () => {
  // No pattern reliably separates a shell command that writes from one that
  // reads, so an unmatched command goes to a person.
  assert.equal(CONFIG.agent["external-builder"].permission.bash["*"], "ask");
});

test("only the unattended agent allows bash without asking", () => {
  const allowing = agents.filter(
    ([, agent]) => typeof agent.permission.bash === "object" && agent.permission.bash["*"] === "allow"
  );

  assert.deepEqual(
    allowing.map(([name]) => name),
    ["external-autonomous"],
    "an allow catch-all gives up repository confinement, so exactly one opt-in agent may have it"
  );
});

test("secrets are denied to every agent", () => {
  // OpenCode's own agents ask before reading these. A delegation has no
  // business in them at all.
  for (const [name, agent] of agents) {
    const read = agent.permission.read;
    assert.equal(typeof read, "object", `${name}: read must be a rule map, not a blanket policy`);
    assert.equal(read["**/.env"], "deny", name);
    assert.equal(read["**/.env.*"], "deny", name);
    assert.equal(read["**/*.pem"], "deny", name);
    assert.equal(read["**/.env.example"], "allow", `${name}: an example file holds no secret`);
  }
});

test("dangerous commands are denied on the write-capable agent", () => {
  const bash = CONFIG.agent["external-builder"].permission.bash;
  for (const pattern of ["git push*", "git reset --hard*", "curl*", "wget*", "kill*", "shutdown*"]) {
    assert.equal(bash[pattern], "deny", `${pattern} must be deny, not ask`);
  }
});

test("the read-only agent cannot edit or reach outside the repository", () => {
  const permission = CONFIG.agent["external-researcher"].permission;
  assert.equal(permission.edit, "deny");
  assert.equal(permission.bash, "deny");
  assert.equal(permission.external_directory, "deny");
  assert.equal(permission.webfetch, "deny");
  assert.equal(permission.websearch, "deny");
});

test("no agent may read outside its repository or reach the network", () => {
  for (const [name, agent] of agents) {
    assert.equal(agent.permission.external_directory, "deny", `${name}`);
    assert.equal(agent.permission.webfetch, "deny", `${name}`);
    assert.equal(agent.permission.websearch, "deny", `${name}`);
  }
});

test("nested agents stay capped", () => {
  assert.equal(CONFIG.subagent_depth, 1);
});
