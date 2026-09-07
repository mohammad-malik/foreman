/**
 * Workspace registration commands.
 *
 * Registering is deliberately a separate, human-run step from delegating. It
 * is the moment you decide a directory is fair game, and `--allow-external` is
 * the moment you decide its contents may leave the machine.
 */

import fs from "node:fs";

import { hasActiveJobs } from "../jobs.mjs";
import { ACTIVE_JOBS_REASON, stopServer } from "../servers.mjs";
import {
  findWorkspaceFor,
  listWorkspaces,
  registerWorkspace,
  unregisterWorkspace
} from "../registry.mjs";
import { configFile } from "../state.mjs";
import { canonicalize, containmentKey, findGitRoot } from "../workspace.mjs";
import { bullet, heading, keyValue } from "../render.mjs";

/**
 * The allowlist entry for exactly this path, re-read from disk.
 *
 * Exact rather than by containment: a parent's entry is not evidence that the
 * child was written, and treating it as such is how a failed write would be
 * reported as a success.
 */
function storedEntry(root) {
  const key = containmentKey(root);
  return listWorkspaces().find((entry) => containmentKey(entry.root) === key) ?? null;
}

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

  // Read the allowlist back off disk before claiming anything about it.
  //
  // This command has printed "external delegation ALLOWED" while the stored
  // entry stayed local-only, and the delegate that followed refused for a
  // reason that contradicted what the user had just been told. The write is
  // atomic and normally this process is the only writer, so a disagreement
  // means something real: a second runtime pointed at a different state
  // directory, a concurrent registration, or a config replaced underneath us.
  // Whichever it is, naming it beats a success message the allowlist does not
  // back up.
  const stored = storedEntry(target);

  if (!stored) {
    throw new Error(
      [
        `Registered ${entry.root}, but reading the allowlist back does not find it.`,
        `Allowlist: ${configFile()}`,
        "Nothing here is registered. Check whether another process is rewriting that file, then try again."
      ].join("\n")
    );
  }

  if (stored.allowExternal !== entry.allowExternal) {
    throw new Error(
      [
        `Registered ${entry.root}, but the stored external-delegation flag reads ${stored.allowExternal} rather than ${entry.allowExternal}.`,
        `Allowlist: ${configFile()}`,
        "Treat this workspace as NOT cleared to send content off the machine until those two agree."
      ].join("\n")
    );
  }

  lines.unshift(`Registered ${entry.root}`);
  lines.push(
    bullet(
      stored.allowExternal
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

  const requested = canonicalize(rawPath);
  const containing = findWorkspaceFor(rawPath);

  // Resolve and remove must agree. findWorkspaceFor matches by containment, so
  // `unregister /repo/packages/foo` used to resolve /repo's entry and stop
  // /repo's server, while unregisterWorkspace deleted by exact key, matched
  // nothing, and reported "was not registered. Nothing changed." A destructive
  // operation describing itself as a no-op.
  const target =
    containing && containmentKey(containing.root) === containmentKey(requested) ? containing : null;

  if (!target) {
    return `${requested} is not a registered workspace. Nothing changed.${
      containing ? `\n  Its parent ${containing.root} is registered; unregister that path instead.` : ""
    }`;
  }

  if (!force && hasActiveJobs(target)) {
    // Refuse rather than orphan or kill. A job mid-flight on this server would
    // be destroyed by unregistering, and silently.
    throw new Error(
      [
        `${target.root} still has active jobs. Unregistering would stop its server and kill them.`,
        "",
        "Wait for them, cancel them, or pass --force to unregister anyway:",
        `  /foreman:unregister ${target.root} --force`
      ].join("\n")
    );
  }

  const stopped = await stopServer(target, { reason: "workspace unregistered", force });

  // Removing the entry is what makes a server unreachable: no sweep visits an
  // unregistered workspace and `server stop` refuses the path. So a server that
  // was NOT stopped must keep its registry entry, or the refusal and the
  // kept-on-failed-kill record are both undone by the very next line.
  const cleanupOutcomes = new Set([
    "no server recorded",
    "stale record, pid reused",
    "cleared a partial start record"
  ]);

  if (!stopped.stopped && !cleanupOutcomes.has(stopped.reason)) {
    throw new Error(
      [
        `${target.root} was left registered, because its server could not be stopped: ${stopped.reason}`,
        "",
        "Unregistering now would leave that server running with nothing able to see or stop it.",
        stopped.reason === ACTIVE_JOBS_REASON
          ? "  Cancel its jobs, then try again."
          : `  Try again, or force it: /foreman:unregister ${target.root} --force`
      ].join("\n")
    );
  }

  const removed = unregisterWorkspace(target.root);
  const lines = [
    removed
      ? `Removed ${removed.root} from the workspace allowlist.`
      : `${requested} was not registered. Nothing changed.`
  ];

  if (stopped.stopped) {
    lines.push(`Stopped its OpenCode server (pid ${stopped.pid}).`);
  }

  return lines.join("\n");
}

export function workspaces() {
  const entries = listWorkspaces();

  if (entries.length === 0) {
    return "No workspaces registered.\nRegister one with: /foreman:register <path> [--allow-external]";
  }

  return [
    heading("Registered workspaces"),
    keyValue(
      entries.map((entry) => [
        entry.root,
        entry.allowExternal ? "delegation allowed" : "local only"
      ])
    ),
    "",
    // Named so that a registration which "did not stick" can be traced to two
    // runtimes reading different files rather than to a lost write.
    `Allowlist: ${configFile()}`
  ].join("\n");
}
