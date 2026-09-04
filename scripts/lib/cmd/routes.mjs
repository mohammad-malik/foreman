/**
 * `routes` lists what can actually be delegated to right now.
 *
 * Availability is checked against the live OpenCode inventory rather than the
 * local table, because a route that resolves on paper and 404s at dispatch
 * time is worse than no route at all.
 */

import { detectVersion, loadInventory } from "../opencode.mjs";
import { findReservedCandidates, listAliases, resolveRoute } from "../routes.mjs";
import { bullet, heading } from "../render.mjs";

export function routes({ refresh = false } = {}) {
  let models = null;
  let inventoryNote = "";

  try {
    const version = detectVersion();
    const inventory = loadInventory({ force: refresh, version: version.version });
    models = inventory.models;
    inventoryNote = inventory.cached
      ? `inventory cached at ${inventory.fetchedAt}`
      : `inventory refreshed at ${inventory.fetchedAt}`;
  } catch (error) {
    inventoryNote = `inventory unavailable (${error.message}); availability below is unverified`;
  }

  const lines = [heading("Model routes")];

  for (const alias of listAliases()) {
    lines.push("");
    lines.push(`${alias.alias}${alias.description ? ` - ${alias.description}` : ""}`);

    if (alias.routes.length === 0) {
      lines.push(bullet(alias.reserved ? "reserved, no live route yet" : "no routes configured"));
      continue;
    }

    for (const route of alias.routes) {
      try {
        resolveRoute(alias.alias, route.route, models);
        lines.push(bullet(`${route.route.padEnd(9)} ${route.qualified}${models ? "" : "  (unverified)"}`));
      } catch (error) {
        lines.push(bullet(`${route.route.padEnd(9)} ${route.qualified}  UNAVAILABLE`));
        lines.push(bullet(error.message, 6));
        if (error.candidates?.length) {
          lines.push(bullet(`closest live IDs: ${error.candidates.join(", ")}`, 6));
        }
      }
    }
  }

  if (models) {
    for (const entry of findReservedCandidates(models)) {
      lines.push("");
      lines.push(
        `${entry.alias}: matching IDs are now live upstream (${entry.matches.join(", ")}). Add a route to start using them.`
      );
    }
  }

  lines.push("");
  lines.push(inventoryNote);

  return lines.join("\n");
}
