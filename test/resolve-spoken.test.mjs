import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-spoken-"));
process.env.FOREMAN_STATE_DIR = SCRATCH;
delete process.env.CLAUDE_PLUGIN_DATA;

// No shipped alias is reserved any more, so the reserved behaviour is
// exercised on one defined here. That is also how a user would add one.
{
  const { loadConfig, saveConfig } = await import("../scripts/lib/state.mjs");
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
}

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

test("every way of saying GLM lands on the one routed GLM", () => {
  // GLM means GLM 5.3 Flash and nothing else, so all of these must agree.
  for (const phrase of ["glm", "glm 5.3", "GLM 5.3 Flash", "glm flash", "zhipu"]) {
    const match = resolveSpoken(phrase);
    assert.equal(match.alias, "glm", phrase);
    assert.equal(match.modelID, "accounts/fireworks/models/glm-5p3-flash", phrase);
  }
});

test("a retired name refuses instead of falling through to its neighbour", () => {
  // The dangerous outcome is not an error, it is "glm 5.2" matching the `glm`
  // alias by containment and quietly running GLM 5.3 Flash.
  for (const phrase of ["glm 5.2", "glm-5.2", "glm5.2"]) {
    assert.throws(
      () => resolveSpoken(phrase),
      (error) => {
        assert.equal(error.code, "spoken_retired", phrase);
        assert.match(error.message, /no longer routed/);
        return true;
      },
      phrase
    );
  }
});

test("flash is treated as a model word, not a speed word", () => {
  // It appears in a spoken list, so it must not be stripped as speed.
  assert.equal(resolveSpoken("flash").alias, "glm");
});

// What the backends offered when sol and luna moved to GPT-6: OpenCode lists
// all three GPT-6 ids, Codex on a ChatGPT sign-in only astra.
const TODAY = {
  opencode: ["opencode/gpt-6-sol", "opencode/gpt-6-luna", "opencode/gpt-6-astra"],
  codex: ["gpt-6-astra"]
};

// The day Codex catches up.
const CODEX_TOO = {
  opencode: TODAY.opencode,
  codex: ["gpt-6-sol", "gpt-6-luna", "gpt-6-astra"]
};

test("sol means gpt-6-sol, and not astra", () => {
  for (const phrase of ["sol", "gpt 6 sol", "gpt-6-sol", "gpt6 sol"]) {
    const match = resolveSpoken(phrase, CODEX_TOO);
    assert.equal(match.alias, "sol", phrase);
    // Codex, because that is sol's default backend: it runs on a ChatGPT
    // sign-in rather than a metered API key.
    assert.equal(match.backend, "codex", phrase);
    assert.equal(match.qualified, "codex/gpt-6-sol", phrase);
    assert.equal(match.defaultedBackend, true, phrase);
  }
});

test("luna means gpt-6-luna, and defaults to codex like sol", () => {
  for (const phrase of ["luna", "gpt 6 luna", "gpt-6-luna", "moon"]) {
    const match = resolveSpoken(phrase, CODEX_TOO);
    assert.equal(match.alias, "luna", phrase);
    assert.equal(match.qualified, "codex/gpt-6-luna", phrase);
  }
});

test("sol and luna go to codex even while codex refuses them", () => {
  // Codex's cache is no evidence either way, so plain "sol" goes to its
  // default and a ChatGPT account that cannot run it fails within seconds
  // with Codex's own 400. The OpenCode route is never taken on the user's
  // behalf: it bills an API key for a job the config says runs on the sign-in.
  for (const name of ["sol", "luna"]) {
    const plain = resolveSpoken(name, TODAY);
    assert.equal(plain.backend, "codex", name);
    assert.match(plain.unverified, new RegExp(`gpt-6-${name}`), name);

    const asked = resolveSpoken(`opencode ${name}`, TODAY);
    assert.equal(asked.qualified, `opencode/gpt-6-${name}`, name);
  }
});

test("the GPT-5.6 names refuse rather than run GPT-6", () => {
  // Saying "gpt 5.6 sol" and getting a different model is the substitution
  // this table exists to prevent, so the old names are retired, not redirected.
  for (const phrase of ["gpt 5.6 sol", "gpt-5.6-sol", "gpt 5.6 luna", "gpt-5.6-luna", "gpt 5.6"]) {
    assert.throws(
      () => resolveSpoken(phrase, CODEX_TOO),
      (error) => error.code === "spoken_retired",
      phrase
    );
  }
});

test("bare gpt 6 asks which one", () => {
  // It used to mean astra, back when astra was the only GPT-6 model.
  for (const phrase of ["gpt 6", "gpt-6", "gpt6"]) {
    assert.throws(
      () => resolveSpoken(phrase, CODEX_TOO),
      (error) => error.code === "spoken_retired" && /astra, sol and luna/.test(error.message),
      phrase
    );
  }
  assert.equal(resolveSpoken("gpt 6 astra", CODEX_TOO).alias, "astra");
});

test("saying a backend out loud overrides the model's default", () => {
  // The point of the override: the same model, billed a different way.
  for (const phrase of ["opencode sol", "via opencode luna", "open code sol"]) {
    const match = resolveSpoken(phrase, CODEX_TOO);
    assert.equal(match.backend, "opencode", phrase);
    assert.equal(match.requestedBackend, "opencode", phrase);
    assert.equal(match.defaultedBackend, false, phrase);
    assert.match(match.qualified, /^opencode\//, phrase);
  }

  const explicit = resolveSpoken("codex sol", CODEX_TOO);
  assert.equal(explicit.backend, "codex");
  assert.equal(explicit.defaultedBackend, false);
});

test("a backend a model does not run on refuses rather than falling back", () => {
  // Kimi is not an OpenAI model, so there is no codex path to quietly take.
  assert.throws(
    () => resolveSpoken("codex kimi"),
    (error) => {
      assert.equal(error.code, "spoken_backend_unavailable");
      assert.match(error.message, /does not run on codex/);
      return true;
    }
  );
});

test("a backend named with no model refuses instead of picking one", () => {
  assert.throws(
    () => resolveSpoken("codex"),
    (error) => {
      assert.equal(error.code, "spoken_backend_only");
      return true;
    }
  );
});

test("a model with one route gets it, and says the route was substituted", () => {
  // sol is standard-only on both backends. Asking for fast yields standard
  // rather than an error, but the substitution is reported rather than hidden.
  const match = resolveSpoken("fast sol", CODEX_TOO);
  assert.equal(match.alias, "sol");
  assert.equal(match.route, "standard");
  assert.equal(match.substitutedRoute, true);
  assert.equal(match.requestedRoute, "fast");
});

test("astra runs on codex even when the codex cache cannot be read", () => {
  // Codex rewrites models_cache.json in place. As a pending id, astra read a
  // mid-rewrite cache as "codex offers nothing", never promoted its Codex
  // route, and refused on its own default backend. Routed explicitly, an
  // unreadable cache is unverified rather than absent.
  const noCodexCache = { opencode: ["opencode/gpt-6-astra"] };
  const live = resolveSpoken("astra", noCodexCache);
  assert.equal(live.backend, "codex");
  assert.equal(live.qualified, "codex/gpt-6-astra");

  assert.equal(resolveSpoken("gpt-6-astra", TODAY).qualified, "codex/gpt-6-astra");
  assert.equal(resolveSpoken("opencode astra", TODAY).qualified, "opencode/gpt-6-astra");
});

test("a model's default never moves to another backend", () => {
  // sol's default is codex. Codex not listing it must not fall through to the
  // OpenCode route sitting right there: that would bill an API key for a job
  // the config says runs on a ChatGPT sign-in.
  const solGoneFromCodex = {
    opencode: ["opencode/gpt-6-sol"],
    codex: ["gpt-6-luna"]
  };

  assert.equal(resolveSpoken("sol", solGoneFromCodex).backend, "codex");

  // Saying the backend out loud is how you get it.
  const asked = resolveSpoken("opencode sol", solGoneFromCodex);
  assert.equal(asked.backend, "opencode");
  assert.equal(asked.qualified, "opencode/gpt-6-sol");

  // A reserved alias promoted only on OpenCode still refuses on its default.
  assert.throws(
    () => resolveSpoken("nova", { opencode: ["opencode/gpt-7-nova"], codex: [] }),
    /cannot run on the codex backend/
  );
});

test("a codex cache that omits a routed model warns instead of refusing", () => {
  // Seen live: the cache dropped gpt-6-astra while codex exec still ran it.
  // Refusing there blocked a working model; Codex itself refuses a model it
  // does not serve within seconds.
  const match = resolveSpoken("astra", { opencode: ["opencode/gpt-6-astra"], codex: ["gpt-5.5"] });
  assert.equal(match.qualified, "codex/gpt-6-astra");
  assert.match(match.unverified, /does not list gpt-6-astra/);

  // Listed means verified, and says nothing.
  assert.equal(resolveSpoken("astra", CODEX_TOO).unverified, undefined);

  // A pending id is different: the listing is its only evidence, so a
  // reserved alias still refuses until an inventory names it.
  assert.throws(() => resolveSpoken("nova", TODAY), /reserved/);
  assert.equal(resolveSpoken("nova", { codex: ["gpt-7-nova"] }).qualified, "codex/gpt-7-nova");
});

test("an OpenCode route missing from its inventory still refuses", () => {
  // OpenCode's list comes from the running server, which is authoritative.
  assert.throws(() => resolveSpoken("opencode astra", { opencode: ["opencode/kimi-k3"] }), /does not currently list it/);
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
  // With no inventory nothing is known to be live, and dispatching to
  // something else would be the worst outcome.
  assert.throws(
    () => resolveSpoken("gpt-7-nova"),
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
