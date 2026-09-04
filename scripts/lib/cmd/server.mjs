/**
 * Server subcommands.
 *
 * These exist mostly for diagnosis and for the sweep that every other command
 * runs. Day to day nobody starts a server by hand: delegation acquires one.
 * The password is never printed, only its presence.
 */

import { listWorkspaces, requireWorkspaceFor } from "../registry.mjs";
import { acquireServer, IDLE_TTL_MS, serverStatus, stopServer, sweep } from "../servers.mjs";
import { hasActiveJobs } from "../jobs.mjs";
import { bullet, heading, keyValue } from "../render.mjs";

function describeIdle(ms) {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export async function serverStart(rawPath) {
  const { workspace } = requireWorkspaceFor(rawPath ?? process.cwd());
  const server = await acquireServer(workspace);

  return [
    `Server ready for ${workspace.root}`,
    keyValue([
      ["url", server.url],
      ["pid", String(server.pid)],
      ["auth", "HTTP Basic, password held in the workspace lock file"],
      ["started", server.startedAt]
    ])
  ].join("\n");
}

export async function serverStop(rawPath) {
  const { workspace } = requireWorkspaceFor(rawPath ?? process.cwd());
  const result = await stopServer(workspace);

  return result.stopped
    ? `Stopped the server for ${workspace.root} (pid ${result.pid}).`
    : `No server stopped for ${workspace.root}: ${result.reason}.`;
}

export function servers() {
  const entries = listWorkspaces();

  if (entries.length === 0) {
    return "No workspaces registered, so there are no servers.";
  }

  const lines = [heading("OpenCode servers")];

  for (const workspace of entries) {
    const status = serverStatus(workspace);
    lines.push("");
    lines.push(workspace.root);

    switch (status.state) {
      case "running":
        lines.push(bullet(`running, pid ${status.pid}, ${status.url}`));
        lines.push(
          bullet(
            `idle ${describeIdle(status.idleMs)} of ${describeIdle(IDLE_TTL_MS)} before it is swept`
          )
        );
        break;
      case "starting":
        lines.push(bullet(`starting since ${status.since} (claimed by pid ${status.owner})`));
        break;
      case "orphaned-record":
        lines.push(bullet(`stale record for pid ${status.pid}; the next sweep will clear it`));
        break;
      default:
        lines.push(bullet("stopped"));
    }
  }

  return lines.join("\n");
}

export async function sweepServers() {
  // The guard is not optional. Without it this killed the server out from
  // under a live background delegation: every other caller passes
  // hasActiveJobs, this one did not, and running the test suite (which
  // executes `sweep`) destroyed 40 minutes of work.
  const actions = await sweep(listWorkspaces(), { hasRunningJobs: hasActiveJobs });

  if (actions.length === 0) {
    return "Sweep found nothing to clean up.";
  }

  return [
    heading("Sweep"),
    ...actions.map((action) => bullet(`${action.workspace}: ${action.action}`))
  ].join("\n");
}
