import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "ea-spoken-"));
process.env.EXTERNAL_AGENTS_STATE_DIR = SCRATCH;
delete process.env.CLAUDE_PLUGIN_DATA;

const { resolveSpoken, SpokenNameError, describeAvailable } = await import(
  "../scripts/lib/resolve-spoken.mjs"
);

/**
 * Spoken model names. The whole point is that nothing here is hardcoded in
 * logic: these all resolve through the `spoken` lists in
 * config/routes.default.json, so adding a model or a new way of saying one is
 * a data edit.
 */

test("a bare model name takes the standard route", () => {
  const kimi = resolveSpoken("kimi");
  assert.equal(kimi.alias, "kimi");
  assert.equal(kimi.route, "standard");
});

test("speed words select the fast route without being model names", () => {
  for (const phrase of ["fast kimi", "quick kimi", "cheap kimi", "kimi fast"]) {
    const match = resolveSpoken(phrase);
    assert.equal(match.alias, "kimi", phrase);
    assert.equal(match.route, "fast", phrase);
  }
});

test("standard words select the standard route", () => {
  for (const phrase of ["standard kimi", "full kimi", "proper kimi"]) {
    assert.equal(resolveSpoken(phrase).route, "standard", phrase);
  }
});

test("the most specific name wins, so a version is not lost", () => {
  // "glm 5.3" must not resolve to plain "glm": they are different models, and
  // silently using the wrong one is the failure this ordering prevents.
  assert.equal(resolveSpoken("glm").alias, "glm");
  assert.equal(resolveSpoken("glm 5.3").alias, "glm-flash");
  assert.equal(resolveSpoken("GLM 5.3 Flash").alias, "glm-flash");
  assert.equal(resolveSpoken("glm-5.2").alias, "glm");
});

test("flash is treated as a model word, not a speed word", () => {
  // It appears in a spoken list, so it must not be stripped as speed.
  assert.equal(resolveSpoken("flash").alias, "glm-flash");
});

test("a model with one route gets it, and says the route was substituted", () => {
  // glm-flash is fast-only. Asking for standard yields fast rather than an
  // error, but the substitution is reported rather than hidden.
  const match = resolveSpoken("standard glm 5.3");
  assert.equal(match.alias, "glm-flash");
  assert.equal(match.route, "fast");
  assert.equal(match.substitutedRoute, true);
  assert.equal(match.requestedRoute, "standard");
});

test("synonyms resolve", () => {
  assert.equal(resolveSpoken("moonshot").alias, "kimi");
  assert.equal(resolveSpoken("k3").alias, "kimi");
  assert.equal(resolveSpoken("zhipu").alias, "glm");
});

test("case and punctuation do not matter", () => {
  assert.equal(resolveSpoken("  FAST   Kimi-K3!  ").alias, "kimi");
  assert.equal(resolveSpoken("  FAST   Kimi-K3!  ").route, "fast");
});

test("a name embedded in a sentence still resolves", () => {
  // The caller passes the user's words through, so this is the normal case.
  assert.equal(resolveSpoken("have fast kimi implement the parser").alias, "kimi");
  assert.equal(resolveSpoken("have fast kimi implement the parser").route, "fast");
});

test("a reserved model refuses rather than falling back", () => {
  // GPT-6 has no live provider id yet. Dispatching to something else would be
  // the worst possible outcome.
  assert.throws(
    () => resolveSpoken("gpt-6-astra"),
    (error) => {
      assert.ok(error instanceof SpokenNameError);
      assert.equal(error.code, "route_reserved");
      assert.ok(error.candidates.length > 0, "it should list what IS available");
      return true;
    }
  );
});

test("an unknown name refuses and lists the alternatives", () => {
  assert.throws(
    () => resolveSpoken("banana"),
    (error) => {
      assert.equal(error.code, "spoken_unresolved");
      assert.ok(error.candidates.some((entry) => entry.alias === "kimi"));
      return true;
    }
  );
});

test("an empty phrase refuses", () => {
  assert.throws(() => resolveSpoken(""), /No model was named/);
  assert.throws(() => resolveSpoken(null), /No model was named/);
});

test("a partial word does not match a model", () => {
  // "glmx" must not resolve to glm.
  assert.throws(() => resolveSpoken("glmx"), SpokenNameError);
});

test("resolution is checked against the live inventory when one is given", () => {
  const missing = ["opencode/something-else"];
  assert.throws(() => resolveSpoken("kimi", missing), /does not currently list/);
});

test("describeAvailable lists every alias with a phrase to say", () => {
  const available = describeAvailable();
  assert.ok(available.length >= 4);
  for (const entry of available) {
    assert.ok(entry.alias, "each entry names its alias");
    assert.ok(entry.say, "and offers a phrase the user can say");
  }
});
