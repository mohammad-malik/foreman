/**
 * Workspace registration commands.
 *
 * Registering is deliberately a separate, human-run step from delegating. It
 * is the moment you decide a directory is fair game, and `--allow-external` is
 * the moment you decide its contents may leave the machine.
 */

import fs from "node:fs";

import { hasActiveJobs } from "../jobs.mjs";
import { stopServer } from "../servers.mjs";
import {
  findWorkspaceFor,
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

/**
 * Remove a workspace from the allowlist, stopping its server first.
 *
 * The server has to be dealt with here, because after the registry entry is
 * gone nothing can reach it: every sweep iterates registered workspaces, and
 * `server stop` refuses a path that is no longer registered. Unregistering
 * used to leave a live, authenticated, write-capable OpenCode server running
 * until reboot, holding its port, with its password in a lock file no code
 * path would read again, and invisible to every diagnostic command. The
 * message said "Removed", which reads like cleanup.
 */
export async function unregister(rawPath, { force = false } = {}) {
  if (!rawPath) {
    throw new Error("Usage: unregister <path>");
  }

  const target = findWorkspaceFor(rawPath);

  if (target && !force) {
    // Refuse rather than orphan or kill. A job mid-flight on this server would
    // be destroyed by unregistering, and silently.
    if (hasActiveJobs(target)) {
      throw new Error(
        [
          `${target.root} still has active jobs. Unregistering would stop its server and kill them.`,
          "",
          "Wait for them, cancel them, or pass --force to unregister anyway:",
          `  /external-agents:unregister ${target.root} --force`
        ].join("\n")
      );
    }
  }

  const lines = [];

  if (target) {
    const stopped = await stopServer(target, { reason: "workspace unregistered", force });
    if (stopped.stopped) {
      lines.push(`Stopped its OpenCode server (pid ${stopped.pid}).`);
    } else if (stopped.reason && stopped.reason !== "no server recorded") {
      lines.push(`Its server was not stopped: ${stopped.reason}`);
    }
  }

  const removed = unregisterWorkspace(rawPath);

  lines.unshift(
    removed
      ? `Removed ${removed.root} from the workspace allowlist.`
      : `${canonicalize(rawPath)} was not registered. Nothing changed.`
  );

  return lines.join("\n");
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
