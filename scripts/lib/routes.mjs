/**
 * Alias to provider/model resolution.
 *
 * One rule governs everything here: a requested model is never quietly swapped
 * for a different one. If `kimi` cannot be served, the answer is an error
 * naming what is actually available, not a silent downgrade to whatever else
 * is connected. Getting back a confident answer from a model you did not
 * choose is worse than getting no answer.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./state.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS_FILE = path.resolve(HERE, "..", "..", "config", "routes.default.json");

export class RouteUnavailableError extends Error {
  constructor(message, { alias, route, candidates = [] } = {}) {
    super(message);
    this.name = "RouteUnavailableError";
    this.code = "route_unavailable";
    this.alias = alias;
    this.route = route;
    this.candidates = candidates;
  }
}

export function loadRouteTable() {
  const defaults = JSON.parse(fs.readFileSync(DEFAULTS_FILE, "utf8"));
  const overrides = loadConfig().routes ?? {};
  const aliases = { ...defaults.aliases };

  // Merge per alias rather than replacing the whole table, so overriding one
  // route does not silently delete the others.
  for (const [alias, override] of Object.entries(overrides.aliases ?? overrides)) {
    const base = aliases[alias] ?? {};
    aliases[alias] = {
      ...base,
      ...override,
      routes: { ...(base.routes ?? {}), ...(override.routes ?? {}) }
    };
  }

  return { version: defaults.version, aliases };
}

export function listAliases() {
  const table = loadRouteTable();
  return Object.entries(table.aliases).map(([alias, entry]) => ({
    alias,
    description: entry.description ?? "",
    reserved: Boolean(entry.reserved),
    // Spoken forms travel with the alias so resolve-spoken needs no second
    // read of the config, and so a merged user override is included.
    spoken: entry.spoken ?? [],
    watchPatterns: entry.watchPatterns ?? [],
    routes: Object.entries(entry.routes ?? {}).map(([route, target]) => ({
      route,
      providerID: target.providerID,
      modelID: target.modelID,
      qualified: qualify(target)
    }))
  }));
}

export function qualify(target) {
  return `${target.providerID}/${target.modelID}`;
}

/**
 * Resolve an alias and route to a concrete provider/model pair.
 *
 * `inventory` is the live list of `provider/model` strings from OpenCode. Pass
 * it and resolution fails when the ID has disappeared upstream; omit it and
 * only the local table is consulted.
 */
export function resolveRoute(alias, route, inventory = null) {
  const table = loadRouteTable();
  const entry = table.aliases[alias];

  if (!entry) {
    throw new RouteUnavailableError(
      `Unknown model alias "${alias}". Known aliases: ${Object.keys(table.aliases).sort().join(", ")}.`,
      { alias, route }
    );
  }

  if (entry.reserved && Object.keys(entry.routes ?? {}).length === 0) {
    throw new RouteUnavailableError(
      `Alias "${alias}" is reserved but has no live provider ID yet. ${entry.description ?? ""}`.trim(),
      { alias, route }
    );
  }

  const target = entry.routes?.[route];
  if (!target) {
    const available = Object.keys(entry.routes ?? {});
    throw new RouteUnavailableError(
      available.length > 0
        ? `Alias "${alias}" has no "${route}" route. Available: ${available.join(", ")}.`
        : `Alias "${alias}" has no routes configured.`,
      { alias, route }
    );
  }

  if (inventory) {
    const wanted = qualify(target);
    if (!inventory.includes(wanted)) {
      throw new RouteUnavailableError(
        `Route ${alias}.${route} resolves to ${wanted}, which OpenCode does not currently list. The provider may be disconnected or the model renamed.`,
        { alias, route, candidates: nearestMatches(wanted, inventory) }
      );
    }
  }

  return {
    alias,
    route,
    providerID: target.providerID,
    modelID: target.modelID,
    qualified: qualify(target)
  };
}

/**
 * Best-effort suggestions when an ID goes missing. Scores by shared slash-free
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
 * Scan the live inventory for anything matching a reserved alias's watch
 * patterns. This is how `astra` stops being a waiting game: doctor reports the
 * moment a matching ID appears upstream.
 */
export function findReservedCandidates(inventory) {
  const table = loadRouteTable();
  const found = [];

  for (const [alias, entry] of Object.entries(table.aliases)) {
    if (!entry.reserved) {
      continue;
    }
    const patterns = (entry.watchPatterns ?? []).map((pattern) => pattern.toLowerCase());
    if (patterns.length === 0) {
      continue;
    }
    const matches = inventory.filter((id) =>
      patterns.some((pattern) => id.toLowerCase().includes(pattern))
    );
    if (matches.length > 0) {
      found.push({ alias, matches });
    }
  }

  return found;
}
