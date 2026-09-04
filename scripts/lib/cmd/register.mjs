/**
 * Workspace registration commands.
 *
 * Registering is deliberately a separate, human-run step from delegating. It
 * is the moment you decide a directory is fair game, and `--allow-external` is
 * the moment you decide its contents may leave the machine.
 */

import fs from "node:fs";

import {
  listWorkspaces,
  registerWorkspace,
  unregisterWorkspace
} from "../registry.mjs";
import { canonicalize, findGitRoot } from "../workspace.mjs";
import { bullet, heading, keyValue } from "../render.mjs";

export function register(rawPath, { allowExternal = false, force = false } = {}) {
  if (!rawPath) {
    throw new Error("Usage: register <path> [--allow-external]");
  }

  const target = canonicalize(rawPath);

  if (!fs.existsSync(target)) {
    throw new Error(`${target} does not exist.`);
  }
  if (!fs.statSync(target).isDirectory()) {
    throw new Error(`${target} is not a directory.`);
  }

  const gitRoot = findGitRoot(target);
  const lines = [];

  if (!gitRoot) {
    if (!force) {
      throw new Error(
        [
          `${target} is not inside a git repository.`,
          "Change attribution and revert both depend on git, so a non-repo workspace can be registered but write delegation will be refused there.",
          "Register it anyway with --force if that is what you want."
        ].join("\n")
      );
    }
    lines.push(bullet("no git repository found; write delegation will be refused here"));
  } else if (gitRoot !== target) {
    lines.push(bullet(`git repository root is ${gitRoot}`));
  }

  const entry = registerWorkspace(target, { allowExternal });

  lines.unshift(`Registered ${entry.root}`);
  lines.push(
    bullet(
      entry.allowExternal
        ? "external delegation ALLOWED: handoffs and repository content may be sent to OpenCode Zen, Moonshot and Fireworks"
        : "local only: delegation is refused here until you re-register with --allow-external"
    )
  );

  return lines.join("\n");
}

export function unregister(rawPath) {
  if (!rawPath) {
    throw new Error("Usage: unregister <path>");
  }
  const removed = unregisterWorkspace(rawPath);
  return removed
    ? `Removed ${removed.root} from the workspace allowlist.`
    : `${canonicalize(rawPath)} was not registered. Nothing changed.`;
}

export function workspaces() {
  const entries = listWorkspaces();

  if (entries.length === 0) {
    return "No workspaces registered.\nRegister one with: /external-agents:register <path> [--allow-external]";
  }

  return [
    heading("Registered workspaces"),
    keyValue(
      entries.map((entry) => [
        entry.root,
        entry.allowExternal ? "delegation allowed" : "local only"
      ])
    )
  ].join("\n");
}
