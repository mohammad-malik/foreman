/**
 * Job inspection and control: status, result, permit, cancel, revert.
 *
 * Everything here works from a job id alone. Nobody wants to type a repository
 * path to ask how their delegation is going, so jobs are looked up across every
 * registered workspace.
 */

import { OpencodeApi } from "../opencode-api.mjs";
import { currentServer } from "../servers.mjs";
import { diffAgainstBaseline, diffStat, revertPaths } from "../git-baseline.mjs";
import {
  ACTIVE_STATUSES,
  markResumed,
  describeElapsed,
  latestJob,
  listJobs,
  loadJob,
  updateJob
} from "../jobs.mjs";
import { listWorkspaces } from "../registry.mjs";
import { reconcileAll } from "../reconcile.mjs";
import { bullet, heading, keyValue } from "../render.mjs";
import { collectResult, renderResult } from "./result.mjs";

function findJobAnywhere(jobID) {
  const workspaces = listWorkspaces();

  if (!jobID) {
    const job = latestJob(workspaces);
    if (!job) {
      throw new Error("No jobs yet. Start one with /external-agents:delegate.");
    }
    return { job, workspace: workspaces.find((entry) => entry.slug === job.slug) };
  }

  for (const workspace of workspaces) {
    const job = loadJob(workspace.slug, jobID);
    if (job) {
      return { job, workspace };
    }
  }

  throw new Error(`No job ${jobID} in any registered workspace.`);
}

export function status(jobID) {
  const workspaces = listWorkspaces();

  // Never report a job as running when it cannot be.
  reconcileAll(workspaces);

  if (jobID) {
    const { job } = findJobAnywhere(jobID);
    return [
      heading(`Job ${job.id}`),
      keyValue([
        ["status", job.status],
        ["model", job.qualified ?? job.alias],
        ["agent", `${job.agent} (${job.access})`],
        ["workspace", job.workspaceRoot],
        ["elapsed", describeElapsed(job)]
      ])
    ].join("\n");
  }

  const jobs = workspaces.flatMap((workspace) => listJobs(workspace.slug)).slice(0, 15);

  if (jobs.length === 0) {
    return "No jobs yet.";
  }

  const active = jobs.filter((job) => ACTIVE_STATUSES.has(job.status));
  const lines = [heading("Jobs")];

  for (const job of jobs) {
    lines.push(
      bullet(
        `${job.id}  ${job.status.padEnd(19)} ${(job.qualified ?? job.alias).padEnd(46)} ${describeElapsed(job)}`
      )
    );
  }

  if (active.length > 0) {
    lines.push("");
    lines.push(`${active.length} still running.`);
  }

  return lines.join("\n");
}

export async function result(jobID) {
  const { job } = findJobAnywhere(jobID);
  const updated = await collectResult(job.slug, job.id);
  return renderResult(updated);
}

/**
 * Answer one permission request.
 *
 * Only "once" and "reject" are ever sent. OpenCode also accepts "always",
 * which writes a saved rule outliving the job, and no single prompt should be
 * able to widen what every future delegation may do.
 */
export async function permit(...args) {
  const tokens = args.filter((value) => value !== undefined && value !== null && value !== "");
  const decision = tokens.length > 0 ? normalizeDecision(tokens[tokens.length - 1]) : null;

  if (!decision) {
    throw new Error(
      [
        "Usage: permit [job-id] [request-id] allow|reject",
        "",
        "The ids are optional when only one request is pending, which is the",
        "usual case: `permit allow` is enough."
      ].join("\n")
    );
  }

  // Everything before the decision narrows which request is meant. With
  // nothing before it, the unique pending request is used. Copying two
  // twenty-character ids to approve a test run is friction that gets a job
  // left blocked, and a job left blocked is the failure this whole flow exists
  // to avoid.
  const hints = tokens.slice(0, -1);
  const { job, workspace, request } = await findPendingRequest(hints);

  const server = currentServer(workspace);
  if (!server) {
    throw new Error(
      `The OpenCode server for ${job.workspaceRoot} is not running, so this request can no longer be answered. The job is dead; start a new one.`
    );
  }

  await new OpencodeApi(server).replyPermission(job.sessionID, request.id, decision);

  // Fold the wait into blockedMs so the time spent waiting on a person is not
  // charged against the job's budget.
  markResumed(job);

  return [
    `Replied ${decision} to ${request.action}${request.resources?.length ? `: ${request.resources[0]}` : ""}`,
    `Job ${job.id} continues.`
  ].join("\n");
}

function normalizeDecision(value) {
  return (
    { allow: "once", once: "once", yes: "once", y: "once", reject: "reject", deny: "reject", no: "reject", n: "reject" }[
      String(value).toLowerCase()
    ] ?? null
  );
}

/**
 * Resolve which pending request a decision refers to.
 *
 * Hints may be a job id, a request id, or both, in any order. With none, the
 * single pending request across all workspaces is used, and an ambiguity is
 * reported rather than guessed at.
 */
async function findPendingRequest(hints) {
  const workspaces = listWorkspaces();
  const pending = [];

  for (const workspace of workspaces) {
    const server = currentServer(workspace);
    if (!server) {
      continue;
    }
    const api = new OpencodeApi(server, { timeout: 8000 });

    for (const job of listJobs(workspace.slug)) {
      if (!ACTIVE_STATUSES.has(job.status) || !job.sessionID) {
        continue;
      }
      let requests = [];
      try {
        requests = await api.pendingPermissions(job.sessionID);
      } catch {
        continue;
      }
      for (const request of Array.isArray(requests) ? requests : []) {
        pending.push({ job, workspace, request });
      }
    }
  }

  const matching = pending.filter(
    ({ job, request }) => hints.length === 0 || hints.every((hint) => hint === job.id || hint === request.id)
  );

  if (matching.length === 1) {
    return matching[0];
  }

  if (matching.length === 0) {
    throw new Error(
      pending.length === 0
        ? "Nothing is waiting for permission."
        : `No pending request matches ${hints.join(" ")}. Pending: ${pending.map(({ job, request }) => `${job.id} ${request.id}`).join(", ")}`
    );
  }

  throw new Error(
    [
      `${matching.length} requests are pending, so it is not clear which you mean. Name one:`,
      ...matching.map(
        ({ job, request }) =>
          `  permit ${job.id} ${request.id} allow    (${request.action}: ${(request.resources ?? [])[0] ?? ""})`
      )
    ].join("\n")
  );
}

export async function cancel(jobID) {
  const { job, workspace } = findJobAnywhere(jobID);

  if (!ACTIVE_STATUSES.has(job.status)) {
    return `Job ${job.id} is already ${job.status}. Nothing to cancel.`;
  }

  const server = currentServer(workspace);
  const lines = [];

  if (server) {
    try {
      await new OpencodeApi(server).interrupt(job.sessionID);
      lines.push(`Interrupted session ${job.sessionID}.`);
    } catch (error) {
      lines.push(`Could not interrupt the session cleanly: ${error.message}`);
    }
  } else {
    lines.push("The server was already gone.");
  }

  // Recompute the diff now rather than keeping whatever was last collected.
  // Cancelling makes the job terminal, which freezes its change set, and a
  // snapshot taken mid-run would permanently omit everything the agent wrote
  // between then and the interrupt, hiding those files from both the report
  // and revert.
  let changes = job.changes ?? null;
  if (job.baseline) {
    try {
      const diff = diffAgainstBaseline(job.baseline);
      changes = { ...diff, stat: diffStat(job.workspaceRoot, diff.changed.map((e) => e.path)) };
    } catch {
      // Keep what we had; the report says it could not be determined.
    }
  }

  updateJob(job, { status: "cancelled", finishedAt: new Date().toISOString(), changes });

  lines.push(`Job ${job.id} marked cancelled.`);
  if (changes?.changed?.length) {
    lines.push(`It changed ${changes.changed.length} file(s) before stopping.`);
  }

  if (job.baseline) {
    // Cancelling stops the work. It does not undo edits already written, and
    // saying so plainly is better than letting that be discovered later.
    lines.push("");
    lines.push("Any edits already written are still on disk. To undo just those files:");
    lines.push(bullet(`/external-agents:revert ${job.id}`));
  }

  return lines.join("\n");
}

export function revert(jobID) {
  const { job } = findJobAnywhere(jobID);

  if (!job.baseline) {
    return `Job ${job.id} was read-only. There is nothing to revert.`;
  }

  const diff = diffAgainstBaseline(job.baseline);

  if (diff.changed.length === 0) {
    return `Job ${job.id} changed nothing. There is nothing to revert.`;
  }

  if (diff.headMoved) {
    throw new Error(
      [
        `HEAD has moved since job ${job.id} ran (${job.baseline.head} -> ${diff.headAfter}).`,
        "Reverting now could undo work that came afterwards, so this is refused.",
        "Inspect the diff and revert by hand."
      ].join("\n")
    );
  }

  const outcome = revertPaths(job.workspaceRoot, job.baseline, diff.changed);
  const lines = [heading(`Reverted job ${job.id}`)];

  for (const file of outcome.restored) {
    lines.push(bullet(`restored ${file}`));
  }
  for (const file of outcome.removed) {
    lines.push(bullet(`deleted ${file} (created by the agent)`));
  }
  for (const entry of outcome.skipped) {
    lines.push(bullet(`skipped ${entry.path}: ${entry.reason}`));
  }

  return lines.join("\n");
}
