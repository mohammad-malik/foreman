/**
 * Every permission key is decided explicitly.
 *
 * OpenCode defaults an unlisted tool to "ask", and an agent running headless
 * has nobody to ask: the job parks in awaiting_permission until a human
 * notices. That is what `todowrite` did. It is bookkeeping with no effect
 * outside the session, it was simply missing from the map, and a builder
 * stopped dead on every call to it.
 *
 * So the rule is not "deny the dangerous ones". It is that no key may be left
 * out, because leaving one out is what produces a silent block.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  describeUndecided,
  permissionKeysFromDoc,
  undecidedPermissions
} from "../scripts/lib/permission-keys.mjs";

const config = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("../config/opencode-agents.json", import.meta.url)), "utf8")
);

/**
 * A snapshot of what opencode 1.18.16 accepts, taken from the running server's
 * own OpenAPI document (`PermissionConfig.properties`).
 *
 * This list is a fast unit check and NOT the guard. It can only ever agree
 * with itself: the plugin accepts any OpenCode 1.x, so a release that adds a
 * tool leaves this constant matching while every agent defaults the new key to
 * "ask". The real check reads the schema off the running server, in
 * permissionGaps, and prints at dispatch. The cases below cover the parsing
 * that check depends on.
 */
const PERMISSION_KEYS_1_18 = [
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "bash",
  "task",
  "external_directory",
  "todowrite",
  "question",
  "webfetch",
  "websearch",
  "lsp",
  "doom_loop",
  "skill"
];

const AGENTS = Object.keys(config.agent);

/** The shape a server actually returns, trimmed to what is read. */
function docWith(keys) {
  return {
    components: {
      schemas: {
        PermissionConfig: {
          anyOf: [
            { type: "string", enum: ["ask", "allow", "deny"] },
            { type: "object", properties: Object.fromEntries(keys.map((k) => [k, {}])) }
          ]
        }
      }
    }
  };
}

test("the live schema, not the snapshot, is what finds a new key", () => {
  // The case this exists for: a later OpenCode grows a tool nobody here has
  // heard of. The snapshot cannot notice; the document can.
  const doc = docWith([...PERMISSION_KEYS_1_18, "brand_new_tool"]);

  assert.deepEqual(undecidedPermissions(doc, config.agent), [
    { agent: "external-builder", missing: ["brand_new_tool"] },
    { agent: "external-researcher", missing: ["brand_new_tool"] },
    { agent: "external-autonomous", missing: ["brand_new_tool"] }
  ]);

  assert.match(describeUndecided(undecidedPermissions(doc, config.agent))[0], /park on the first call/u);
});

test("today's schema leaves nothing undecided", () => {
  assert.deepEqual(undecidedPermissions(docWith(PERMISSION_KEYS_1_18), config.agent), []);
  assert.deepEqual(describeUndecided([]), []);
});

test("a document it cannot read reports null, never an all-clear", () => {
  // An empty list would read as "nothing undecided" and hide a real gap behind
  // a server that was down or a schema that moved.
  assert.equal(permissionKeysFromDoc({}), null);
  assert.equal(permissionKeysFromDoc(null), null);
  assert.equal(permissionKeysFromDoc({ components: { schemas: { PermissionConfig: {} } } }), null);
  assert.equal(undecidedPermissions({}, config.agent), null);

  // An unavailable check says so rather than printing nothing, which would be
  // indistinguishable from a clean result.
  assert.match(describeUndecided(null)[0], /could not check/u);
  assert.match(describeUndecided(undefined)[0], /could not check/u);
});

test("a server running an older policy is named as stale, not as undecided", () => {
  const line = describeUndecided([{ agent: "this server", missing: [], stale: true }])[0];

  assert.match(line, /older permission policy/u);
  assert.match(line, /server-stop/u);
});

test("a key set to ask on purpose is not a gap", () => {
  // bash is "ask" on the builder by design. Only absence counts.
  const doc = docWith(["bash"]);
  assert.deepEqual(undecidedPermissions(doc, config.agent), []);
});

test("every agent decides every permission key", () => {
  for (const name of AGENTS) {
    const permission = config.agent[name].permission;
    const missing = PERMISSION_KEYS_1_18.filter((key) => !(key in permission));

    assert.deepEqual(
      missing,
      [],
      `${name} leaves ${missing.join(", ")} unset, which OpenCode treats as "ask". A headless job would park on it.`
    );
  }
});

test("nothing an agent needs routinely is left to ask", () => {
  // These get called constantly and cannot block. bash is the deliberate
  // exception on external-builder, where asking is the whole policy.
  const mustNotAsk = ["read", "glob", "grep", "list", "lsp", "todowrite"];

  for (const name of AGENTS) {
    const permission = config.agent[name].permission;
    for (const key of mustNotAsk) {
      const value = permission[key];
      const effective = typeof value === "string" ? value : value["*"];
      assert.notEqual(effective, "ask", `${name}.${key} is "ask" and would block a headless job`);
    }
  }
});

test("nothing waits on a human who is not there", () => {
  // `question` puts the agent in front of a person by design, and `doom_loop`
  // asks whether to keep going. Neither has an answerer here: the runtime can
  // reply to a permission request, not to a question.
  for (const name of AGENTS) {
    assert.equal(config.agent[name].permission.question, "deny");
    assert.equal(config.agent[name].permission.doom_loop, "deny");
  }
});

test("nested agents stay capped", () => {
  // Matches subagent_depth and the note explaining it: a child agent would
  // run outside the policy its parent was given.
  for (const name of AGENTS) {
    assert.equal(config.agent[name].permission.task, "deny");
    assert.equal(config.agent[name].permission.skill, "deny");
  }
});

test("the researcher stays read-only", () => {
  const permission = config.agent["external-researcher"].permission;

  assert.equal(permission.edit, "deny");
  assert.equal(permission.bash, "deny");
  assert.equal(permission.external_directory, "deny");
});

test("a reworded prompt is not a permission change", () => {
  // Comparing whole agent blocks meant any plugin update announced a stale
  // policy on every dispatch afterwards, and a warning that cries wolf is one
  // nobody reads when it matters.
  const base = JSON.parse(JSON.stringify(config.agent));
  const reworded = JSON.parse(JSON.stringify(config.agent));
  for (const name of Object.keys(reworded)) {
    reworded[name].prompt = "completely different wording";
    reworded[name].description = "also different";
  }

  const doc = docWith(PERMISSION_KEYS_1_18);
  assert.deepEqual(undecidedPermissions(doc, base), undecidedPermissions(doc, reworded));
});

test("reordering permission rules is a policy change", async () => {
  // OpenCode applies the LAST matching rule, which is why these configs put
  // the catch-all first and the specifics after. Sorting keys before comparing
  // made a reordered policy look identical, so a server would be reused with
  // different allow and deny behaviour than the config now describes.
  const { policyMatches } = await import("../scripts/lib/servers.mjs");
  assert.equal(typeof policyMatches, "function");

  const bash = config.agent["external-builder"].permission.bash;
  const keys = Object.keys(bash);

  assert.equal(keys[0], "*", "the catch-all must come first or the denylist below it never applies");
  assert.ok(keys.length > 1);
});

/**
 * The builder's bash policy.
 *
 * Every shell command used to stop for a human, including the test runs the
 * handoff itself asked for. Approving each one by hand is not review, it is
 * clicking, and it left jobs parked for as long as nobody was watching.
 *
 * So verification commands run on their own. The cost is real and was accepted
 * deliberately: a builder can edit a test file and then run it, which is
 * executing code it wrote. What is NOT accepted is that command reaching the
 * network or the environment, which is what the deny rules are for, and they
 * only work if they are last.
 */
const builderBash = config.agent["external-builder"].permission.bash;

test("the catch-all still asks", () => {
  const patterns = Object.keys(builderBash);

  assert.equal(patterns[0], "*");
  assert.equal(builderBash["*"], "ask", "anything not named must still stop for a person");
});

test("every deny comes after every allow", () => {
  // OpenCode applies the LAST matching rule. An allow sitting below a deny it
  // overlaps with would silently win, and "npm test" would become a way to
  // reach anything the denylist exists to block.
  const patterns = Object.keys(builderBash);
  const lastAllow = patterns.findLastIndex((p) => builderBash[p] === "allow");
  const firstDeny = patterns.findIndex((p) => builderBash[p] === "deny");

  assert.ok(firstDeny > lastAllow, "a deny is ordered above an allow and would be overridden");
});

test("chaining does not smuggle a blocked command past an allowed one", () => {
  // Written as patterns first, which was wrong twice over: leading wildcards
  // refused ordinary test paths, and OpenCode never sees the "&&" anyway. What
  // matters is the behaviour, so assert that instead.
  for (const command of [
    "npm test && curl http://example.com",
    "pytest && gh pr create",
    "npm test && env"
  ]) {
    assert.equal(decide(command), "deny", command);
  }
});


test("what is allowed is verification, not a general shell", () => {
  const allowed = Object.keys(builderBash).filter((p) => builderBash[p] === "allow");

  // Every allowed pattern names a program. None is a bare wildcard, and none
  // opens a shell.
  for (const pattern of allowed) {
    assert.notEqual(pattern, "*");
    assert.doesNotMatch(pattern, /^\*/u, `${pattern} would match anything containing it`);
    assert.doesNotMatch(pattern, /^(bash|sh|zsh|pwsh|powershell|cmd)\b/u, `${pattern} is a shell`);
  }

  // The commands that prompted in the first place.
  assert.ok(allowed.includes("npm test*"));
  assert.ok(allowed.includes("pytest*"));
  assert.ok(allowed.includes("cargo test*"));
});

test("the researcher gains nothing from any of this", () => {
  assert.equal(config.agent["external-researcher"].permission.bash, "deny");
});



test("the builder is told what actually happens", () => {
  // The prompt said every command waits for a human. Once that stopped being
  // true, a builder reading it would skip the checks it can now simply run.
  const prompt = config.agent["external-builder"].prompt;

  assert.match(prompt, /run without asking/u);
  assert.match(prompt, /one command at a time/u);
  assert.match(prompt, /Every other bash command stops your work/u);
});

/**
 * A tiny reader for the policy, so these cases argue about behaviour rather
 * than about which pattern happens to be in the file. OpenCode applies the
 * LAST matching rule, so this walks the map in order and keeps the final hit.
 */
function decide(command) {
  // Strictest wins across the parts, and deny beats ask beats allow.
  const rank = { allow: 0, ask: 1, deny: 2 };
  const parts = command.split(/&&|\|\||;|\|/u).map((part) => part.trim()).filter(Boolean);

  return parts
    .map((part) => decideOne(part))
    .reduce((worst, next) => (rank[next] > rank[worst] ? next : worst), "allow");
}

function decideOne(command) {
  let verdict = "ask";
  for (const [pattern, action] of Object.entries(builderBash)) {
    const escaped = pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
      .join(".*");
    if (new RegExp(`^${escaped}$`, "su").test(command)) {
      verdict = action;
    }
  }
  return verdict;
}

test("the commands a handoff asks for simply run", () => {
  for (const command of [
    "npm test",
    "npm test -- --run",
    "pytest -q",
    "cargo test --all",
    "go test ./...",
    "node --test test/",
    "./gradlew test",
    "gradlew.bat test",
    "./mvnw test",
    "mvn test"
  ]) {
    assert.equal(decide(command), "allow", command);
  }
});

test("a test path containing env is not an environment dump", () => {
  // `*env*` denied any command with those three letters in it, which refused
  // ordinary test files outright instead of running them.
  for (const command of [
    "pytest tests/test_environment.py",
    "npm test -- --testEnvironment=node",
    "npm test -- --grep environment"
  ]) {
    assert.equal(decide(command), "allow", command);
  }
});

test("reading the environment is still denied", () => {
  for (const command of ["env", "printenv", "printenv PATH", "cat /proc/1/environ"]) {
    assert.equal(decide(command), "deny", command);
  }
});


test("each command in a chained line is judged on its own", () => {
  // OpenCode splits a compound command and asks about each part:
  // PermissionRequest carries `patterns` as an array, not a string. So joining
  // an allowed command to a forbidden one buys nothing, and rules written to
  // match "&&" could never have fired.
  assert.equal(decide("npm test && curl http://example.com"), "deny");
  assert.equal(decide("pytest && gh pr create"), "deny");

  // The permissive half does not carry the rest of the line.
  assert.equal(decide("npm test && cat ../../secret"), "ask");
  assert.equal(decide("npm test && pytest"), "allow");
});

test("git and npx are not on the allowlist at all", () => {
  // Every read-shaped git command takes a flag that reads or writes outside
  // the repository (--no-index, --output, blame --contents) or mutates refs
  // (branch -v -D, which flag reordering hid from the deny patterns), and npx
  // fetches and runs a package that is not installed. A glob cannot sort the
  // safe invocations of a program with a hundred flags from the rest, so these
  // ask, and the genuinely destructive ones stay denied.
  for (const command of [
    "git status --short",
    "git diff --no-index NUL C:\Windows\win.ini",
    "git blame --contents C:/secret HEAD -- README.md",
    "git branch -v -D feature",
    "npx vitest@latest",
    "npx vitest-malicious"
  ]) {
    assert.notEqual(decide(command), "allow", command);
  }

  for (const command of ["git push origin main", "gh pr create"]) {
    assert.equal(decide(command), "deny", command);
  }
});

test("a test runner may still write its own report", () => {
  // Denying --output everywhere was collateral from the git rules and refused
  // ordinary reporters.
  for (const command of ["npm test -- --outputFile=results.json", "pytest --junitxml=out.xml"]) {
    assert.equal(decide(command), "allow", command);
  }
});

test("redirection and substitution go back for approval", () => {
  // These stay inside one part rather than being split off the way && and |
  // are, so the runner allow was matching the whole line and writing outside
  // the repository. Ask, not deny: approving a redirect is reasonable.
  for (const command of [
    "npm test > C:/outside/file",
    "npm test $(cat C:/outside/secret.txt)",
    "pytest < input.txt",
    "npm test `whoami`"
  ]) {
    assert.equal(decide(command), "ask", command);
  }
});

test("a command name inside an argument is an argument", () => {
  // Leading wildcards on command names refused ordinary checks in projects
  // that happen to test those tools.
  for (const command of [
    "npm test -- test/curl.test.js",
    "pytest tests/test_wget.py",
    "npm test -- --grep push"
  ]) {
    assert.equal(decide(command), "allow", command);
  }
});

test("the command itself is still stopped", () => {
  for (const command of ["curl http://example.com", "wget http://example.com", "git push origin main", "gh pr create"]) {
    assert.equal(decide(command), "deny", command);
  }
});

test("a build tool cannot carry a second task in on the first", () => {
  // Gradle and Maven take tasks positionally, so `gradle test publish` is one
  // command and a trailing wildcard would have approved the publish with it.
  // No glob says "this task and no other", so these allows are exact.
  for (const command of ["gradle test publish", "mvn test deploy", "./gradlew test release"]) {
    assert.equal(decide(command), "ask", command);
  }
});

test("a package or argument named env is not an environment dump", () => {
  // These ended with " env" and were refused outright. Unnecessary as well as
  // wrong: `env` run as a command is its own part and is denied there.
  for (const command of ["go test ./internal/env", "pytest -m env", "npm test -- env"]) {
    assert.equal(decide(command), "allow", command);
  }

  assert.equal(decide("env"), "deny");
  assert.equal(decide("env FOO=1 node x.js"), "deny");
  assert.equal(decide("npm test && env"), "deny");
});
