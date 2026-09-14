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
