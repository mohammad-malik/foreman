/**
 * Turn a spoken model name into a backend, an alias and a route.
 *
 * "have fast kimi do X", "get GLM to do Y" and "have opencode sol review Z" all
 * have to end up as something exactly dispatchable. The mapping lives entirely
 * in config/routes.default.json: this file knows nothing about Kimi, GLM, Sol or
 * GPT-6, only how to match a phrase against the `spoken` lists and how to spot a
 * speed word or a backend word. Adding a model, a backend, or another way of
 * saying one, is a data edit.
 *
 * It never guesses. An unrecognised phrase, or one that matches two aliases,
 * comes back as a refusal listing what is available, because dispatching a paid
 * job to a model the user did not ask for is worse than asking.
 */

import { listAliases, loadBackends, loadRetired, resolveRoute } from "./routes.mjs";

/**
 * Words that pick a route rather than a model. Route names themselves are
 * included, so "standard kimi" works as well as "fast kimi".
 */
const SPEED_WORDS = {
  fast: "fast",
  quick: "fast",
  quickly: "fast",
  cheap: "fast",
  cheapest: "fast",
  standard: "standard",
  full: "standard",
  normal: "standard",
  slow: "standard",
  proper: "standard"
};

function normalise(text) {
  return String(text ?? "")
    .toLowerCase()
    // Keep dots and digits: "glm 5.3" and "kimi-k3" are meaningful.
    .replace(/[^a-z0-9.\s-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class SpokenNameError extends Error {
  constructor(message, { code = "spoken_unresolved", candidates = [] } = {}) {
    super(message);
    this.name = "SpokenNameError";
    this.code = code;
    this.candidates = candidates;
  }
}

/**
 * Every spoken form, longest first so the most specific wins.
 *
 * Retired names sit in the same list rather than in a check of their own, so
 * length decides between them and a live name the ordinary way. That matters:
 * "glm 5.2" has to win over "glm", because letting it fall through to the `glm`
 * alias would dispatch GLM 5.3 Flash to someone who asked for 5.2.
 */
function spokenIndex(inventory = null) {
  const entries = [];

  for (const alias of listAliases(inventory)) {
    const names = new Set([alias.alias, ...(alias.spoken ?? [])].map(normalise));
    for (const name of names) {
      if (name !== "") {
        entries.push({
          alias: alias.alias,
          name,
          reserved: alias.reserved,
          routes: alias.routes,
          backends: alias.backends,
          defaultBackend: alias.defaultBackend
        });
      }
    }
  }

  for (const [name, reason] of Object.entries(loadRetired())) {
    const normalised = normalise(name);
    if (normalised !== "") {
      entries.push({ alias: null, name: normalised, retired: reason, routes: [], backends: [] });
    }
  }

  return entries.sort((a, b) => b.name.length - a.name.length);
}

/** Phrases that name a backend, longest first for the same reason. */
function backendIndex() {
  const entries = [];

  for (const [backend, spec] of Object.entries(loadBackends())) {
    const names = new Set([backend, ...(spec.spoken ?? [])].map(normalise));
    for (const name of names) {
      if (name !== "") {
        entries.push({ backend, name });
      }
    }
  }

  return entries.sort((a, b) => b.name.length - a.name.length);
}

/**
 * Resolve a phrase like "fast kimi", "glm", or "opencode sol" to something
 * dispatchable.
 *
 * `inventory` is the live model list, either the OpenCode one or a map of
 * backend to list. Pass it and the result is checked against what is actually
 * offered right now; omit it to resolve names only.
 */
export function resolveSpoken(phrase, inventory = null) {
  let text = normalise(phrase);

  if (text === "") {
    throw new SpokenNameError("No model was named.", { candidates: describeAvailable(inventory) });
  }

  const index = spokenIndex(inventory);

  // Backend first, and by phrase rather than by word, because "via opencode" is
  // two words. A phrase that is also a model name is left alone: if a model is
  // ever called codex, saying it must select the model, not the backend.
  let backend = null;
  for (const entry of backendIndex()) {
    if (!mentions(text, entry.name) || isModelName(index, entry.name)) {
      continue;
    }
    backend ??= entry.backend;
    text = strip(text, entry.name);
  }

  if (text === "") {
    throw new SpokenNameError(
      `"${phrase}" names a backend but no model. Say which model to run on it.`,
      { code: "spoken_backend_only", candidates: describeAvailable(inventory) }
    );
  }

  // Then speed, so the word can be stripped before matching the model name.
  let route = null;
  const kept = [];

  for (const word of text.split(" ")) {
    const speed = SPEED_WORDS[word];
    // "flash" is a speed word in general English but a model name here, so a
    // word that appears in a spoken list is never treated as speed.
    if (speed && !isModelWord(index, word)) {
      route ??= speed;
      continue;
    }
    kept.push(word);
  }

  const remainder = kept.join(" ");
  const matches = index.filter((entry) => mentions(remainder, entry.name));

  // Longest-first ordering means matches[0] is the most specific. Anything else
  // matching a DIFFERENT alias at the same length is a genuine ambiguity.
  const best = matches[0];

  if (!best) {
    throw new SpokenNameError(`No configured model matches "${phrase}".`, {
      candidates: describeAvailable(inventory)
    });
  }

  // A name that used to work refuses with the reason, and never falls through
  // to a neighbouring alias.
  if (best.retired) {
    throw new SpokenNameError(best.retired, {
      code: "spoken_retired",
      candidates: describeAvailable(inventory)
    });
  }

  const rival = matches.find(
    (entry) =>
      entry.alias !== null && entry.alias !== best.alias && entry.name.length === best.name.length
  );
  if (rival) {
    throw new SpokenNameError(
      `"${phrase}" could mean ${best.alias} or ${rival.alias}. Name one of them.`,
      { code: "spoken_ambiguous", candidates: describeAvailable(inventory) }
    );
  }

  if (best.reserved) {
    throw new SpokenNameError(
      `${best.alias} is reserved but has no live model yet, so nothing can be dispatched to it. Run doctor to see whether one has appeared.`,
      { code: "route_reserved", candidates: describeAvailable(inventory) }
    );
  }

  if (backend && !best.backends.includes(backend)) {
    throw new SpokenNameError(
      `${best.alias} does not run on ${backend}. It runs on: ${best.backends.join(", ")}.`,
      { code: "spoken_backend_unavailable", candidates: describeAvailable(inventory) }
    );
  }

  const chosenBackend = backend ?? best.defaultBackend;

  // A model may not offer the route asked for: sol is standard-only. Fall back
  // to its single route rather than refusing, but never across models, and
  // never across backends.
  const available = best.routes
    .filter((entry) => entry.backend === chosenBackend)
    .map((entry) => entry.route);
  const chosen =
    route && available.includes(route)
      ? route
      : available.includes("standard")
        ? "standard"
        : available[0];

  const resolved = resolveRoute(best.alias, chosen, inventory, { backend: chosenBackend });

  return {
    ...resolved,
    matchedOn: best.name,
    requestedRoute: route,
    substitutedRoute: route !== null && chosen !== route,
    requestedBackend: backend,
    // True when the backend came from the alias's own default rather than from
    // the user. Worth reporting: it decides whether the job bills a ChatGPT
    // sign-in or an API key.
    defaultedBackend: backend === null
  };
}

function isModelWord(index, word) {
  return index.some((entry) => entry.name === word || entry.name.split(" ").includes(word));
}

function isModelName(index, name) {
  return index.some((entry) => entry.name === name);
}

/** Whole-phrase containment, so "glm" does not match inside "glmx". */
function mentions(text, name) {
  if (text === name) {
    return true;
  }
  return new RegExp(`(^|\\s)${escapeForMatch(name)}($|\\s)`).test(text);
}

function strip(text, name) {
  return text
    .replace(new RegExp(`(^|\\s)${escapeForMatch(name)}($|\\s)`), " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeForMatch(name) {
  return name.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

export function describeAvailable(inventory = null) {
  return listAliases(inventory).map((alias) => ({
    alias: alias.alias,
    say: (alias.spoken ?? [alias.alias])[0],
    backend: alias.defaultBackend,
    alsoOn: alias.backends.filter((backend) => backend !== alias.defaultBackend),
    routes: [...new Set(alias.routes.map((route) => route.route))],
    reserved: Boolean(alias.reserved),
    description: alias.description
  }));
}
