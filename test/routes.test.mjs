import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Point state at a scratch directory before importing anything that reads it,
// so these tests never touch the real config.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "ea-routes-"));
process.env.EXTERNAL_AGENTS_STATE_DIR = SCRATCH;
delete process.env.CLAUDE_PLUGIN_DATA;

const { listAliases, nearestMatches, resolveRoute, RouteUnavailableError, findReservedCandidates } =
  await import("../scripts/lib/routes.mjs");
const { saveConfig, loadConfig } = await import("../scripts/lib/state.mjs");

const LIVE = [
  "opencode/kimi-k3",
  "opencode/glm-5.2",
  "fireworks-ai/accounts/fireworks/routers/kimi-k3-fast",
  "fireworks-ai/accounts/fireworks/routers/glm-5p2-fast",
  "fireworks-ai/accounts/fireworks/models/glm-5p3-flash",
  "opencode/gpt-5.6-sol"
];

test("resolves a known alias and route to a split provider/model pair", () => {
  const resolved = resolveRoute("kimi", "standard", LIVE);

  assert.equal(resolved.providerID, "opencode");
  assert.equal(resolved.modelID, "kimi-k3");
  assert.equal(resolved.qualified, "opencode/kimi-k3");
});

test("resolves the fast route to the Fireworks router", () => {
  const resolved = resolveRoute("kimi", "fast", LIVE);
  assert.equal(resolved.qualified, "fireworks-ai/accounts/fireworks/routers/kimi-k3-fast");
});

test("an unknown alias fails and lists what does exist", () => {
  assert.throws(
    () => resolveRoute("gpt-4", "standard", LIVE),
    (error) => {
      assert.ok(error instanceof RouteUnavailableError);
      assert.equal(error.code, "route_unavailable");
      assert.match(error.message, /Known aliases:/);
      assert.match(error.message, /kimi/);
      return true;
    }
  );
});

test("a missing route on a known alias names the routes that exist", () => {
  // sol is standard-only on purpose. Asking for a fast route must fail loudly
  // rather than quietly serving a different model.
  assert.throws(() => resolveRoute("sol", "fast", LIVE), /Available: standard/);
});

test("a reserved alias with no live ID fails with an explanation", () => {
  assert.throws(
    () => resolveRoute("astra", "standard", LIVE),
    /reserved but has no live provider ID yet/
  );
});

test("a route whose model vanished upstream fails instead of substituting", () => {
  // The rule the whole module exists to enforce: never hand back a different
  // model than the one that was asked for.
  const withoutKimi = LIVE.filter((id) => id !== "opencode/kimi-k3");

  assert.throws(
    () => resolveRoute("kimi", "standard", withoutKimi),
    (error) => {
      assert.equal(error.code, "route_unavailable");
      assert.match(error.message, /which OpenCode does not currently list/);
      return true;
    }
  );
});

test("an unavailable route suggests the closest live IDs", () => {
  const stale = ["opencode/kimi-k2.7-code", "opencode/glm-5.2"];

  try {
    resolveRoute("kimi", "standard", stale);
    assert.fail("expected the route to be unavailable");
  } catch (error) {
    assert.ok(error.candidates.includes("opencode/kimi-k2.7-code"));
  }
});

test("resolution without an inventory skips the liveness check", () => {
  const resolved = resolveRoute("kimi", "standard", null);
  assert.equal(resolved.qualified, "opencode/kimi-k3");
});

test("nearestMatches ranks by shared tokens and returns nothing on no overlap", () => {
  assert.deepEqual(nearestMatches("opencode/nothing-alike", ["fireworks-ai/zzz"]), []);
  assert.ok(nearestMatches("opencode/kimi-k3", ["opencode/kimi-k2.6"]).length > 0);
});

test("user overrides merge per alias without deleting sibling routes", () => {
  const config = loadConfig();
  config.routes = {
    aliases: {
      kimi: { routes: { standard: { providerID: "opencode", modelID: "kimi-k2.6" } } }
    }
  };
  saveConfig(config);

  try {
    // The overridden route changes...
    assert.equal(
      resolveRoute("kimi", "standard", ["opencode/kimi-k2.6"]).modelID,
      "kimi-k2.6"
    );
    // ...and the one that was not overridden survives.
    assert.equal(resolveRoute("kimi", "fast", LIVE).providerID, "fireworks-ai");
  } finally {
    const reset = loadConfig();
    reset.routes = {};
    saveConfig(reset);
  }
});

test("listAliases reports astra as reserved with no routes", () => {
  const astra = listAliases().find((entry) => entry.alias === "astra");

  assert.ok(astra, "astra should be present in the shipped table");
  assert.equal(astra.reserved, true);
  assert.deepEqual(astra.routes, []);
});

test("a live gpt-6-astra id promotes the reserved alias to dispatchable", () => {
  // The point of reserving the alias: the day GPT-6 appears upstream it works,
  // with no edit to the route table.
  const inventory = [...LIVE, "opencode/gpt-6-astra"];
  const resolved = resolveRoute("astra", "standard", inventory);

  assert.equal(resolved.qualified, "opencode/gpt-6-astra");

  const astra = listAliases(inventory).find((entry) => entry.alias === "astra");
  assert.equal(astra.reserved, false);
  assert.equal(astra.promoted, true);

  // Promoted, so it is reported as available rather than as something to watch.
  assert.deepEqual(findReservedCandidates(inventory), []);
});

test("a gpt-6 id that is not a known candidate is surfaced, not guessed at", () => {
  // Matches astra watch patterns but is not one of its pending ids, so it is
  // reported for a human to wire up and nothing is dispatched to it.
  const inventory = [...LIVE, "opencode/gpt-6-nova"];
  const found = findReservedCandidates(inventory);

  assert.equal(found.length, 1);
  assert.equal(found[0].alias, "astra");
  assert.deepEqual(found[0].matches, ["opencode/gpt-6-nova"]);
  assert.throws(() => resolveRoute("astra", "standard", inventory), /reserved/);
});

test("no reserved candidates are reported when nothing matches", () => {
  assert.deepEqual(findReservedCandidates(LIVE), []);
});
