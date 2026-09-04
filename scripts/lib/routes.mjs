/**
 * Alias to backend, provider and model resolution.
 *
 * One rule governs everything here: a requested model is never quietly swapped
 * for a different one. If `kimi` cannot be served, the answer is an error
 * naming what is actually available, not a silent downgrade to whatever else
 * is connected. Getting back a confident answer from a model you did not
 * choose is worse than getting no answer.
 *
 * A model can be reachable more than one way. GPT-5.6 Sol runs through the
 * Codex CLI on a ChatGPT sign-in, and also through OpenCode against a paid API
 * key. Those are not interchangeable, so each alias names the backend it uses
 * by default and the other one is reached only by asking for it. Which backend
 * ran a job is recorded and reported, never inferred later.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./state.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS_FILE = path.resolve(HERE, "..", "..", "config", "routes.default.json");

export const DEFAULT_BACKEND = "opencode";

export class RouteUnavailableError extends Error {
  constructor(message, { alias, route, backend, candidates = [] } = {}) {
    super(message);
    this.name = "RouteUnavailableError";
    this.code = "route_unavailable";
    this.alias = alias;
    this.route = route;
    this.backend = backend;
    this.candidates = candidates;
  }
}

/**
 * Accepts either a bare OpenCode model list (which is what every caller passed
 * before there was a second backend) or a map of backend to its own list.
 */
function normaliseInventories(inventories) {
  if (!inventories) {
    return {};
  }
  if (Array.isArray(inventories)) {
    return { opencode: inventories };
  }
  return inventories;
}

export function loadRouteTable(inventories = null) {
  const defaults = JSON.parse(fs.readFileSync(DEFAULTS_FILE, "utf8"));
  const overrides = loadConfig().routes ?? {};
  const live = normaliseInventories(inventories);
  const aliases = { ...defaults.aliases };

  // Merge per alias rather than replacing the whole table, so overriding one
  // route does not silently delete the others.
  for (const [alias, override] of Object.entries(overrides.aliases ?? overrides)) {
    const base = aliases[alias] ?? {};
    aliases[alias] = {
      ...base,
      ...override,
      routes: { ...(base.routes ?? {}), ...(override.routes ?? {}) },
      backends: mergeBackends(base.backends, override.backends)
    };
  }

  for (const [alias, entry] of Object.entries(aliases)) {
    aliases[alias] = normaliseAlias(entry, live);
  }

  return {
    version: defaults.version,
    aliases,
    backends: { ...(defaults.backends ?? {}), ...(overrides.backends ?? {}) },
    retired: { ...(defaults.retired ?? {}), ...(overrides.retired ?? {}) }
  };
}

function mergeBackends(base = {}, override = {}) {
  const merged = { ...base };
  for (const [backend, routes] of Object.entries(override)) {
    merged[backend] = { ...(base[backend] ?? {}), ...routes };
  }
  return merged;
}

/**
 * Put every alias into one shape: a map of backend to its routes.
 *
 * A flat `routes` block means the OpenCode backend, which is what the table
 * looked like before Codex existed and is still the least noisy way to write a
 * single-backend model.
 */
function normaliseAlias(entry, live) {
  const byBackend = {};

  for (const [backend, routes] of Object.entries(entry.backends ?? {})) {
    byBackend[backend] = { ...routes };
  }

  // Last, so it wins. A flat `routes` block is how an override is written by
  // hand, and an override that quietly lost to the default it was overriding
  // would be worse than one that errored.
  if (entry.routes && Object.keys(entry.routes).length > 0) {
    byBackend[DEFAULT_BACKEND] = { ...(byBackend[DEFAULT_BACKEND] ?? {}), ...entry.routes };
  }

  const pending = {
    ...(entry.pendingRoutes ? { [DEFAULT_BACKEND]: entry.pendingRoutes } : {}),
    ...(entry.pendingBackends ?? {})
  };

  const promoted = promotePending(byBackend, pending, live);
  const backends = promoted.backends;
  const usable = Object.keys(backends).filter(
    (backend) => Object.keys(backends[backend]).length > 0
  );

  return {
    ...entry,
    byBackend: backends,
    // The configured default is the default, full stop, even when it has no
    // live route. Falling back to whichever backend does have one looks helpful
    // and is the exact substitution this file exists to prevent: astra
    // promoting on OpenCode alone would have quietly billed an API key for a
    // job the config says runs on a ChatGPT sign-in. An error naming the
    // backend that IS available is the honest answer, and `resolveRoute`
    // produces one.
    defaultBackend: entry.defaultBackend ?? DEFAULT_BACKEND,
    reserved: Boolean(entry.reserved) && usable.length === 0,
    promoted: promoted.promoted
  };
}

/**
 * Turn a reserved alias's candidate model ids into real routes, but only for
 * ids the relevant backend actually offers.
 *
 * This is what stops a reserved model being a waiting game. `astra` carries the
 * ids GPT-6 is expected to ship under; the day one of them appears the alias
 * becomes dispatchable with no edit to the config, and until then it refuses
 * rather than guessing at a name. An explicit route always wins, so a user
 * override is never overwritten by a guess.
 */
function promotePending(byBackend, pending, live) {
  const backends = { ...byBackend };
  let promoted = false;

  for (const [backend, routes] of Object.entries(pending)) {
    const inventory = live[backend];
    if (!inventory) {
      continue;
    }

    for (const [route, candidates] of Object.entries(routes ?? {})) {
      if (backends[backend]?.[route]) {
        continue;
      }
      const found = (candidates ?? []).find((target) => offers(inventory, backend, target));
      if (found) {
        backends[backend] = { ...(backends[backend] ?? {}), [route]: found };
        promoted = true;
      }
    }
  }

  return { backends, promoted };
}

/** Whether a backend's inventory lists this target. */
function offers(inventory, backend, target) {
  return inventory.includes(backend === "codex" ? target.modelID : qualify(target, backend));
}

export function listAliases(inventories = null) {
  const table = loadRouteTable(inventories);

  return Object.entries(table.aliases).map(([alias, entry]) => ({
    alias,
    description: entry.description ?? "",
    reserved: Boolean(entry.reserved),
    // True when a reserved alias just became dispatchable because its id
    // appeared. Worth saying out loud: it changes what you can run.
    promoted: Boolean(entry.promoted),
    defaultBackend: entry.defaultBackend,
    // Spoken forms travel with the alias so resolve-spoken needs no second
    // read of the config, and so a merged user override is included.
    spoken: entry.spoken ?? [],
    watchPatterns: entry.watchPatterns ?? [],
    backends: Object.keys(entry.byBackend),
    // Flattened across backends: every renderer wants one list, and each entry
    // says which backend would run it.
    routes: Object.entries(entry.byBackend).flatMap(([backend, routes]) =>
      Object.entries(routes).map(([route, target]) => ({
        backend,
        route,
        providerID: target.providerID ?? null,
        modelID: target.modelID,
        qualified: qualify(target, backend),
        isDefaultBackend: backend === entry.defaultBackend
      }))
    )
  }));
}

/** How a target reads in a report. Codex has no provider of its own. */
export function qualify(target, backend = DEFAULT_BACKEND) {
  return backend === "codex" ? `codex/${target.modelID}` : `${target.providerID}/${target.modelID}`;
}

/** The backend definitions, including the words that select one out loud. */
export function loadBackends() {
  return loadRouteTable().backends;
}

/** Spoken names that must refuse rather than resolve. See config comments. */
export function loadRetired() {
  return loadRouteTable().retired ?? {};
}

/**
 * Resolve an alias, backend and route to something dispatchable.
 *
 * `inventory` is the live OpenCode model list, or a map of backend to list.
 * Pass it and resolution fails when the id has disappeared; omit it and only
 * the local table is consulted.
 */
export function resolveRoute(alias, route, inventory = null, { backend = null } = {}) {
  const live = normaliseInventories(inventory);
  const table = loadRouteTable(live);
  const entry = table.aliases[alias];

  if (!entry) {
    throw new RouteUnavailableError(
      `Unknown model alias "${alias}". Known aliases: ${Object.keys(table.aliases).sort().join(", ")}.`,
      { alias, route }
    );
  }

  const chosen = backend ?? entry.defaultBackend;
  const available = Object.keys(entry.byBackend).filter(
    (name) => Object.keys(entry.byBackend[name]).length > 0
  );

  if (available.length === 0) {
    throw new RouteUnavailableError(
      `Alias "${alias}" is ${entry.reserved ? "reserved and " : ""}has no live route yet. ${entry.description ?? ""}`.trim(),
      { alias, route, backend: chosen }
    );
  }

  if (!available.includes(chosen)) {
    throw new RouteUnavailableError(
      `Alias "${alias}" cannot run on the ${chosen} backend. It runs on: ${available.join(", ")}.`,
      { alias, route, backend: chosen }
    );
  }

  const routes = entry.byBackend[chosen];
  const target = routes[route];

  if (!target) {
    throw new RouteUnavailableError(
      `Alias "${alias}" has no "${route}" route on ${chosen}. Available: ${Object.keys(routes).join(", ")}.`,
      { alias, route, backend: chosen }
    );
  }

  const inventoryForBackend = live[chosen];
  if (inventoryForBackend && !offers(inventoryForBackend, chosen, target)) {
    const wanted = chosen === "codex" ? target.modelID : qualify(target, chosen);
    throw new RouteUnavailableError(
      `Route ${alias}.${route} resolves to ${wanted} on ${chosen}, which does not currently list it. The provider may be disconnected or the model renamed.`,
      { alias, route, backend: chosen, candidates: nearestMatches(wanted, inventoryForBackend) }
    );
  }

  return {
    alias,
    route,
    backend: chosen,
    providerID: target.providerID ?? null,
    modelID: target.modelID,
    qualified: qualify(target, chosen)
  };
}

/**
 * Best-effort suggestions when an id goes missing. Scores by shared slash-free
 * word fragments, which is enough to surface `kimi-k3` when `kimi-k2.7` was
 * asked for without pretending to be clever about it.
 */
export function nearestMatches(wanted, inventory, limit = 5) {
  const tokens = new Set(
    wanted
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 1)
  );

  return inventory
    .map((candidate) => {
      const candidateTokens = candidate.toLowerCase().split(/[^a-z0-9]+/);
      const score = candidateTokens.filter((token) => tokens.has(token)).length;
      return { candidate, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.localeCompare(b.candidate))
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

/**
 * Scan the inventories for anything matching a still-reserved alias's watch
 * patterns.
 *
 * Promotion happens inside loadRouteTable, so an alias that went live is no
 * longer reserved and drops out of this list: it is reported as available
 * rather than as a candidate to watch. What is left is the interesting case, a
 * model that looks like the one being waited for but is not one of the ids the
 * table knows how to use. That gets reported for a person to wire up, and
 * nothing is dispatched to it.
 */
export function findReservedCandidates(inventories) {
  const live = normaliseInventories(inventories);
  const table = loadRouteTable(live);
  const all = Object.values(live).flat();
  const found = [];

  for (const [alias, entry] of Object.entries(table.aliases)) {
    if (!entry.reserved) {
      continue;
    }
    const patterns = (entry.watchPatterns ?? []).map((pattern) => pattern.toLowerCase());
    if (patterns.length === 0) {
      continue;
    }
    const matches = all.filter((id) =>
      patterns.some((pattern) => id.toLowerCase().includes(pattern))
    );
    if (matches.length > 0) {
      found.push({ alias, matches });
    }
  }

  return found;
}
