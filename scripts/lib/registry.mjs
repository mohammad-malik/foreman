/**
 * The workspace allowlist.
 *
 * Nothing is delegated anywhere the user has not registered by hand, and
 * nothing leaves the machine unless that registration also carries the egress
 * flag. Two separate gates on purpose: registering a repo so you can read job
 * state is a much smaller decision than agreeing that its source code may be
 * sent to OpenCode Zen, Moonshot and Fireworks.
 */

import { loadConfig, saveConfig } from "./state.mjs";
import { canonicalize, containmentKey, isInside, workspaceSlug } from "./workspace.mjs";

export function listWorkspaces() {
  const config = loadConfig();
  return Object.values(config.workspaces).sort((a, b) => a.root.localeCompare(b.root));
}

export function registerWorkspace(rawPath, { allowExternal = false } = {}) {
  const root = canonicalize(rawPath);
  const key = containmentKey(root);
  const config = loadConfig();
  const existing = config.workspaces[key];

  config.workspaces[key] = {
    root,
    slug: workspaceSlug(root),
    allowExternal: Boolean(allowExternal),
    registeredAt: existing?.registeredAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  saveConfig(config);
  return config.workspaces[key];
}

export function unregisterWorkspace(rawPath) {
  const key = containmentKey(canonicalize(rawPath));
  const config = loadConfig();
  const existing = config.workspaces[key];

  if (!existing) {
    return null;
  }

  delete config.workspaces[key];
  saveConfig(config);
  return existing;
}

/**
 * Find the registered workspace containing `rawPath`, or null.
 *
 * When registrations nest, the deepest match wins, so registering a monorepo
 * root and one package inside it behaves the way you would expect.
 */
export function findWorkspaceFor(rawPath) {
  const target = canonicalize(rawPath);
  let best = null;

  for (const entry of listWorkspaces()) {
    if (!isInside(target, entry.root)) {
      continue;
    }
    if (!best || entry.root.length > best.root.length) {
      best = entry;
    }
  }

  return best;
}

/**
 * Resolve a path to the workspace that may act on it, or throw with the exact
 * command needed to fix the problem. `requireExternal` is set by anything that
 * would send repository content off the machine.
 */
export function requireWorkspaceFor(rawPath, { requireExternal = false } = {}) {
  const target = canonicalize(rawPath);
  const workspace = findWorkspaceFor(target);

  if (!workspace) {
    throw new Error(
      [
        `${target} is not inside any registered workspace.`,
        "Register it first:",
        `  /external-agents:register ${target}`
      ].join("\n")
    );
  }

  if (requireExternal && !workspace.allowExternal) {
    throw new Error(
      [
        `Workspace ${workspace.root} is registered but external delegation is off.`,
        "Delegating sends your handoff and whatever the agent reads to OpenCode Zen, Moonshot and Fireworks.",
        "Turn it on for this repository only if that is acceptable:",
        `  /external-agents:register ${workspace.root} --allow-external`
      ].join("\n")
    );
  }

  return { workspace, target };
}
