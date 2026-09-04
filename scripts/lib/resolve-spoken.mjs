/**
 * Turn a spoken model name into an alias and a route.
 *
 * "have fast kimi do X" and "get GLM 5.3 to do Y" both have to end up as an
 * exact provider and model id. The mapping lives entirely in
 * config/routes.default.json: this file knows nothing about Kimi, GLM or GPT-6,
 * only how to match a phrase against the `spoken` lists and how to spot a
 * speed word. Adding a model, or a new way of saying one, is a data edit.
 *
 * It never guesses. An unrecognised phrase, or one that matches two aliases,
 * comes back as a refusal listing what is available, because dispatching a
 * paid job to a model the user did not ask for is worse than asking.
 */

import { listAliases, loadRetired, resolveRoute } from "./routes.mjs";

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
 * "glm 5.2" has to lose to nothing and win over "glm", because letting it fall
 * through to the `glm` alias would dispatch GLM 5.3 Flash to someone who asked
 * for 5.2.
 */
function spokenIndex(inventory = null) {
  const entries = [];

  for (const alias of listAliases(inventory)) {
    const names = new Set([alias.alias, ...(alias.spoken ?? [])].map(normalise));
    for (const name of names) {
      if (name !== "") {
        entries.push({ alias: alias.alias, name, reserved: alias.reserved, routes: alias.routes });
      }
    }
  }

  for (const [name, reason] of Object.entries(loadRetired())) {
    const normalised = normalise(name);
    if (normalised !== "") {
      entries.push({ alias: null, name: normalised, retired: reason, routes: [] });
    }
  }

  // Longest name first: "glm 5.3 flash" must beat "glm", or a request resolves
  // to a coarser entry than the one the user actually named.
  return entries.sort((a, b) => b.name.length - a.name.length);
}

/**
 * Resolve a phrase like "fast kimi" or "glm 5.3" to an alias and route.
 *
 * `inventory` is the live model list. Pass it and the result is checked against
 * what OpenCode actually offers right now; omit it to resolve names only.
 */
export function resolveSpoken(phrase, inventory = null) {
  const text = normalise(phrase);

  if (text === "") {
    throw new SpokenNameError("No model was named.", { candidates: describeAvailable() });
  }

  // Speed first, so the word can be stripped before matching the model name.
  let route = null;
  const words = text.split(" ");
  const kept = [];

  for (const word of words) {
    const speed = SPEED_WORDS[word];
    // "flash" is a speed word in general English but a model name here, so a
    // word that appears in a spoken list is never treated as speed.
    if (speed && !isModelWord(word)) {
      route ??= speed;
      continue;
    }
    kept.push(word);
  }

  const remainder = kept.join(" ");
  const index = spokenIndex(inventory);
  const matches = index.filter((entry) => mentions(remainder, entry.name));

  // Longest-first ordering means matches[0] is the most specific. Anything else
  // matching a DIFFERENT alias at the same length is a genuine ambiguity.
  const best = matches[0];

  if (!best) {
    throw new SpokenNameError(
      `No configured model matches "${phrase}".`,
      { candidates: describeAvailable(inventory) }
    );
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
    (entry) => entry.alias !== null && entry.alias !== best.alias && entry.name.length === best.name.length
  );
  if (rival) {
    throw new SpokenNameError(
      `"${phrase}" could mean ${best.alias} or ${rival.alias}. Name one of them.`,
      { code: "spoken_ambiguous", candidates: describeAvailable(inventory) }
    );
  }

  if (best.reserved && best.routes.length === 0) {
    throw new SpokenNameError(
      `${best.alias} is reserved but has no live provider id yet, so nothing can be dispatched to it. Run doctor to see whether one has appeared.`,
      { code: "route_reserved", candidates: describeAvailable(inventory) }
    );
  }

  // A model may not offer the route asked for: glm-flash is fast-only. Fall
  // back to its single route rather than refusing, but never across models.
  const available = best.routes.map((entry) => entry.route);
  const chosen =
    route && available.includes(route)
      ? route
      : available.includes("standard")
        ? "standard"
        : available[0];

  const substituted = route !== null && chosen !== route;
  const resolved = resolveRoute(best.alias, chosen, inventory);

  return {
    ...resolved,
    matchedOn: best.name,
    requestedRoute: route,
    substitutedRoute: substituted
  };
}

/**
 * "flash" is a speed word in general English and a model name here, so the
 * speed pass consults this before stripping a word. Retired names count too:
 * stripping "5.2" out of "glm 5.2" would turn a refusal into a wrong model.
 */
function isModelWord(word) {
  return spokenIndex().some((entry) => entry.name === word || entry.name.split(" ").includes(word));
}

/** Whole-phrase containment, so "glm" does not match inside "glmx". */
function mentions(text, name) {
  if (text === name) {
    return true;
  }
  return new RegExp(`(^|\\s)${name.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}($|\\s)`).test(text);
}

export function describeAvailable(inventory = null) {
  return listAliases(inventory).map((alias) => ({
    alias: alias.alias,
    say: (alias.spoken ?? [alias.alias])[0],
    routes: alias.routes.map((route) => route.route),
    reserved: Boolean(alias.reserved),
    description: alias.description
  }));
}
