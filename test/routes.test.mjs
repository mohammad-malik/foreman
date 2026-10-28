import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Point state at a scratch directory before importing anything that reads it,
// so these tests never touch the real config.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-routes-"));
process.env.FOREMAN_STATE_DIR = SCRATCH;
delete process.env.CLAUDE_PLUGIN_DATA;

const { listAliases, nearestMatches, resolveRoute, RouteUnavailableError, findReservedCandidates } =
  await import("../scripts/lib/routes.mjs");
const { saveConfig, loadConfig } = await import("../scripts/lib/state.mjs");

// No shipped alias is reserved any more, so the reserved behaviour is
// exercised on one defined here, for the length of one test.
function withNova(body) {
  const config = loadConfig();
  config.routes = {
    aliases: {
      nova: {
        description: "A model that has not shipped yet.",
        spoken: ["nova", "gpt 7 nova", "gpt-7-nova"],
        reserved: true,
        defaultBackend: "codex",
        watchPatterns: ["gpt-7"],
        backends: {},
        pendingBackends: {
          codex: { standard: [{ modelID: "gpt-7-nova" }] },
          opencode: { standard: [{ providerID: "opencode", modelID: "gpt-7-nova" }] }
        }
      }
    }
  };
  saveConfig(config);
  try {
    body();
  } finally {
    const reset = loadConfig();
    reset.routes = {};
    saveConfig(reset);
  }
}

const LIVE = [
  "opencode/kimi-k3",
  "opencode/glm-5.2",
  "fireworks-ai/accounts/fireworks/routers/kimi-k3-fast",
  "fireworks-ai/accounts/fireworks/routers/glm-5p2-fast",
  "fireworks-ai/accounts/fireworks/models/glm-5p3-flash",
  "opencode/gpt-6.1-sol"
];

test("resolves a known alias and route to a split provider/model pair", () => {
  const resolved = resolveRoute("kimi-k3", "standard", LIVE);

  assert.equal(resolved.providerID, "opencode");
  assert.equal(resolved.modelID, "kimi-k3");
  assert.equal(resolved.qualified, "opencode/kimi-k3");
});

test("resolves the fast route to the Fireworks router", () => {
  const resolved = resolveRoute("kimi-k3", "fast", LIVE);
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
  assert.throws(() => resolveRoute("sol", "fast", LIVE, { backend: "opencode" }), /Available: standard/);
});

test("a reserved alias with no live ID fails with an explanation", () => {
  withNova(() => {
    assert.throws(
      () => resolveRoute("nova", "standard", LIVE, { backend: "opencode" }),
      /reserved and has no live route yet/
    );
  });
});

test("a route whose model vanished upstream fails instead of substituting", () => {
  // The rule the whole module exists to enforce: never hand back a different
  // model than the one that was asked for.
  const withoutKimi = LIVE.filter((id) => id !== "opencode/kimi-k3");

  assert.throws(
    () => resolveRoute("kimi", "standard", withoutKimi),
    (error) => {
      assert.equal(error.code, "route_unavailable");
      assert.match(error.message, /does not currently list it/);
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
  assert.equal(resolved.qualified, "opencode/kimi-k3.1-pro");
});

test("nearestMatches ranks by shared tokens and returns nothing on no overlap", () => {
  assert.deepEqual(nearestMatches("opencode/nothing-alike", ["fireworks-ai/zzz"]), []);
  assert.ok(nearestMatches("opencode/kimi-k3", ["opencode/kimi-k2.6"]).length > 0);
});

test("user overrides merge per alias without deleting sibling routes", () => {
  const config = loadConfig();
  config.routes = {
    aliases: {
      "kimi-k3": { routes: { standard: { providerID: "opencode", modelID: "kimi-k2.6" } } }
    }
  };
  saveConfig(config);

  try {
    // The overridden route changes...
    assert.equal(
      resolveRoute("kimi-k3", "standard", ["opencode/kimi-k2.6"]).modelID,
      "kimi-k2.6"
    );
    // ...and the one that was not overridden survives.
    assert.equal(resolveRoute("kimi-k3", "fast", LIVE).providerID, "fireworks-ai");
  } finally {
    const reset = loadConfig();
    reset.routes = {};
    saveConfig(reset);
  }
});

test("listAliases reports a reserved alias with no routes", () => {
  withNova(() => {
    const nova = listAliases().find((entry) => entry.alias === "nova");
    assert.equal(nova.reserved, true);
    assert.deepEqual(nova.routes, []);
  });
});

test("a live id promotes the reserved alias to dispatchable", () => {
  // The point of reserving the alias: the day the id appears upstream it
  // works, with no edit to the route table.
  withNova(() => {
    const inventory = { opencode: LIVE, codex: ["gpt-7-nova"] };

    const resolved = resolveRoute("nova", "standard", inventory);
    assert.equal(resolved.backend, "codex");
    assert.equal(resolved.qualified, "codex/gpt-7-nova");

    // A backend with no route for it still refuses rather than falling back.
    assert.throws(
      () => resolveRoute("nova", "standard", inventory, { backend: "opencode" }),
      /cannot run on the opencode backend/
    );

    const nova = listAliases(inventory).find((entry) => entry.alias === "nova");
    assert.equal(nova.reserved, false);
    assert.equal(nova.promoted, true);

    // Promoted, so it is reported as available rather than as something to watch.
    assert.deepEqual(findReservedCandidates(inventory), []);
  });
});

test("an id that is not a known candidate is surfaced, not guessed at", () => {
  // Matches the watch pattern but is not a pending id, so it is reported for
  // a human to wire up and nothing is dispatched to it.
  withNova(() => {
    const inventory = ["opencode/kimi-k3", "opencode/gpt-7-mini"];
    const found = findReservedCandidates(inventory);

    assert.equal(found.length, 1);
    assert.equal(found[0].alias, "nova");
    assert.deepEqual(found[0].matches, ["opencode/gpt-7-mini"]);
    assert.throws(() => resolveRoute("nova", "standard", inventory, { backend: "opencode" }), /reserved/);
  });
});

test("the GPT-6 models are routed, not waiting on a cache", () => {
  const expected = { astra: "gpt-6-astra", sol: "gpt-6.1-sol", "sol-6": "gpt-6-sol", luna: "gpt-6-luna" };
  for (const [alias, id] of Object.entries(expected)) {
    const entry = listAliases().find((candidate) => candidate.alias === alias);
    assert.equal(entry.reserved, false, alias);
    assert.equal(resolveRoute(alias, "standard", { opencode: LIVE }).qualified, `codex/${id}`, alias);
  }
});

test("no reserved candidates are reported when nothing matches", () => {
  assert.deepEqual(findReservedCandidates(LIVE), []);
});
