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

test("every agent puts the bash catch-all first", () => {
  for (const [name, agent] of agents) {
    const keys = Object.keys(agent.permission.bash);
    assert.equal(keys[0], "*", `${name}: the catch-all must be the first rule, or it overrides everything`);
  }
});

test("the catch-all asks rather than denying", () => {
  // No pattern reliably separates a shell command that writes from one that
  // reads, so an unmatched command goes to a person.
  for (const [name, agent] of agents) {
    assert.equal(agent.permission.bash["*"], "ask", `${name}`);
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
