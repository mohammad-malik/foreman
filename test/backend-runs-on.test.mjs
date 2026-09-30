/**
 * A backend that names a provider rather than a way of running.
 *
 * OpenRouter is reached through the same local OpenCode server, so "openrouter"
 * has to swap the provider and change nothing else: same server, same agent
 * config, same permission policy. Before this, an alias could hold one provider
 * per backend, and using the other meant hand-editing the user's config file
 * and losing the first one.
 *
 * The thing worth pinning down is the split between the name and the path.
 * Every branch that decides how a job runs must read `runsOn`; anything that
 * reports which route was taken should read `backend`.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// No shipped alias has an OpenRouter route since union was removed, so the
// tests define one in a scratch config. That is also how a user adds one.
process.env.FOREMAN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-runs-on-"));
delete process.env.CLAUDE_PLUGIN_DATA;

const { loadConfig, saveConfig } = await import("../scripts/lib/state.mjs");
const config = loadConfig();
config.routes = {
  aliases: {
    probe: {
      description: "A model with a copy on each provider.",
      spoken: ["probe model", "probe"],
      defaultBackend: "opencode",
      backends: {
        opencode: { standard: { providerID: "opencode", modelID: "probe" } },
        openrouter: { standard: { providerID: "openrouter", modelID: "vendor/probe" } }
      }
    }
  }
};
saveConfig(config);

const { resolveRoute, runsOn } = await import("../scripts/lib/routes.mjs");
const { resolveSpoken } = await import("../scripts/lib/resolve-spoken.mjs");

test("a backend runs on itself unless it says otherwise", () => {
  assert.equal(runsOn("codex"), "codex");
  assert.equal(runsOn("opencode"), "opencode");
  assert.equal(runsOn("openrouter"), "opencode");

  // An unknown name is its own path, so a config that adds a backend without
  // runsOn keeps working rather than resolving to undefined.
  assert.equal(runsOn("something-new"), "something-new");
});

test("saying openrouter picks the OpenRouter copy", () => {
  for (const phrase of [
    "openrouter probe",
    "probe openrouter",
    "openrouter opencode probe",
    "via openrouter probe"
  ]) {
    const match = resolveSpoken(phrase);

    assert.equal(match.backend, "openrouter", phrase);
    assert.equal(match.qualified, "openrouter/vendor/probe", phrase);

    // Still the OpenCode path: it is the provider that changed.
    assert.equal(match.runsOn, "opencode", phrase);
  }
});

test("saying nothing, or saying opencode, keeps the OpenCode copy", () => {
  for (const phrase of ["probe", "probe model", "opencode probe"]) {
    const match = resolveSpoken(phrase);

    assert.equal(match.backend, "opencode", phrase);
    assert.equal(match.qualified, "opencode/probe", phrase);
  }

  // Unstated means it came from the alias's default, which is worth reporting.
  assert.equal(resolveSpoken("probe").defaultedBackend, true);
  assert.equal(resolveSpoken("opencode probe").defaultedBackend, false);
});

test("the OpenRouter route is verified against the OpenCode inventory", () => {
  // There is no separate OpenRouter inventory: its ids are listed by the
  // OpenCode server alongside every other provider's. Resolving against
  // live["openrouter"] would have found nothing and refused a live route.
  const inventories = { opencode: ["openrouter/vendor/probe", "opencode/probe"] };

  const viaRouter = resolveRoute("probe", "standard", inventories, { backend: "openrouter" });
  assert.equal(viaRouter.qualified, "openrouter/vendor/probe");

  const direct = resolveRoute("probe", "standard", inventories, { backend: "opencode" });
  assert.equal(direct.qualified, "opencode/probe");
});

test("a route missing from the live list is still refused", () => {
  // The path lookup must not become a way of skipping verification.
  assert.throws(
    () => resolveRoute("probe", "standard", { opencode: ["opencode/probe"] }, { backend: "openrouter" }),
    /does not currently list it/u
  );
});

test("the existing backends are untouched", () => {
  const gpt6 = { codex: ["gpt-6.1-sol"], opencode: ["opencode/gpt-6.1-sol"] };
  assert.equal(resolveSpoken("codex sol", gpt6).runsOn, "codex");
  assert.equal(resolveSpoken("opencode sol", gpt6).runsOn, "opencode");
  assert.equal(resolveSpoken("kimi").runsOn, "opencode");

  // astra is a reserved alias and needs the live inventory to promote, so it
  // is exercised through the CLI rather than here.
});

test("a recorded job knows which path it ran on", async () => {
  // The OpenCode branch recorded no backend at all, so status and result could
  // not tell an OpenRouter job from an OpenCode one. Old records have neither
  // field and must still read as OpenCode, or result would go looking for a
  // Codex process that never existed.
  const { jobRunsOn } = await import("../scripts/lib/jobs.mjs");

  assert.equal(jobRunsOn({ backend: "openrouter", runsOn: "opencode" }), "opencode");
  assert.equal(jobRunsOn({ backend: "codex", runsOn: "codex" }), "codex");

  // Written before this existed.
  assert.equal(jobRunsOn({ backend: "codex" }), "codex");
  assert.equal(jobRunsOn({}), "opencode");
  assert.equal(jobRunsOn(undefined), "opencode");
});
