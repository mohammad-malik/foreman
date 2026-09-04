/**
 * The two subcommands that make natural-language delegation possible.
 *
 * `resolve` turns "fast glm 5.3" into an exact alias and route, so Claude never
 * has to know which models exist or guess at a spelling. `wait` blocks until
 * jobs finish, so "when everything is done, run a codex review" is one call
 * rather than a polling loop that burns turns.
 */

import { detectVersion, loadInventory } from "../opencode.mjs";
import { describeAvailable, resolveSpoken, SpokenNameError } from "../resolve-spoken.mjs";
import { ACTIVE_STATUSES, describeElapsed, listJobs, loadJob } from "../jobs.mjs";
import { listWorkspaces } from "../registry.mjs";
import { reconcileAll } from "../reconcile.mjs";
import { collectResult } from "./result.mjs";
import { bullet, heading } from "../render.mjs";

/**
 * Resolve a spoken model name against the live inventory.
 *
 * Emits JSON, because the caller is Claude assembling a delegate command and a
 * machine-readable answer removes a parsing step from the loop.
 */
export function resolve(phrase) {
  let inventory = null;

  try {
    const version = detectVersion();
    inventory = loadInventory({ version: version.version }).models;
  } catch {
    // Names still resolve without the live list; availability is unverified.
  }

  try {
    const match = resolveSpoken(phrase, inventory);

    return JSON.stringify(
      {
        ok: true,
        model: match.alias,
        route: match.route,
        qualified: match.qualified,
        matchedOn: match.matchedOn,
        // Flagged rather than hidden: a model with one route gets that route
        // even when another was asked for, and the caller should say so.
        substitutedRoute: match.substitutedRoute,
        requestedRoute: match.requestedRoute,
        verifiedAgainstInventory: Boolean(inventory)
      },
      null,
      2
    );
  } catch (error) {
    const isSpoken = error instanceof SpokenNameError;
    return JSON.stringify(
      {
        ok: false,
        code: error.code ?? "resolve_failed",
        error: error.message,
        available: isSpoken ? error.candidates : describeAvailable()
      },
      null,
      2
    );
  }
}

const WAIT_POLL_MS = 15_000;
const WAIT_REQUEST_TIMEOUT_MS = 8_000;

/**
 * Block until the named jobs reach a terminal state.
 *
 * With no ids, every active job across every workspace is waited on, which is
 * what "when everything is done" means. Returns as soon as they are all
 * settled, or when the deadline expires, and reports which is which: a caller
 * that goes on to run a review needs to know whether it is reviewing finished
 * work or a timeout.
 *
 * A job blocked on a permission is NOT waited out silently. Waiting for a human
 * who has not been told to look is how a job sat unanswered for 25 minutes, so
 * this returns immediately and says who it is waiting for.
 */
export async function waitForJobs(jobIDs = [], { timeoutSeconds = 3600 } = {}) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const workspaces = listWorkspaces();

  if (workspaces.length === 0) {
    return "No workspaces registered, so there is nothing to wait for.";
  }

  for (;;) {
    reconcileAll(workspaces);

    const tracked = [];
    for (const workspace of workspaces) {
      for (const job of listJobs(workspace.slug)) {
        if (jobIDs.length > 0 ? jobIDs.includes(job.id) : ACTIVE_STATUSES.has(job.status)) {
          tracked.push({ workspace, job });
        }
      }
    }

    if (tracked.length === 0) {
      return jobIDs.length > 0
        ? `None of those job ids exist: ${jobIDs.join(", ")}`
        : "Nothing is running.";
    }

    // Refresh from the server so a finished job is noticed rather than waited
    // out, and so a permission request surfaces the moment it appears.
    const fresh = [];
    for (const { workspace, job } of tracked) {
      try {
        fresh.push(await collectResult(workspace.slug, job.id, { timeout: WAIT_REQUEST_TIMEOUT_MS }));
      } catch {
        fresh.push(loadJob(workspace.slug, job.id) ?? job);
      }
    }

    const blocked = fresh.filter((job) => job.status === "awaiting_permission");
    if (blocked.length > 0) {
      return [
        heading("Waiting for you, not for the model"),
        ...blocked.map((job) =>
          bullet(`${job.id} (${job.qualified ?? job.alias}) needs a permission answered`)
        ),
        "",
        "Approve with:  /external-agents:permit allow",
        "Or reject it:  /external-agents:permit reject",
        "",
        "Then wait again."
      ].join("\n");
    }

    const running = fresh.filter((job) => ACTIVE_STATUSES.has(job.status));

    if (running.length === 0) {
      return renderSettled(fresh);
    }

    if (Date.now() > deadline) {
      return [
        heading(`Still running after ${Math.round(timeoutSeconds / 60)} minutes`),
        ...running.map((job) =>
          bullet(`${job.id} (${job.qualified ?? job.alias}) ${job.status}, ${describeElapsed(job)}`)
        ),
        "",
        "They keep going in the background. Do not treat this as finished."
      ].join("\n");
    }

    await new Promise((done) => setTimeout(done, WAIT_POLL_MS));
  }
}

function renderSettled(jobs) {
  const lines = [heading("All jobs settled")];

  for (const job of jobs) {
    const changed = job.changes?.changed?.length ?? 0;
    const detail =
      job.status === "completed"
        ? `${changed} file(s) changed`
        : (job.error ?? job.status);

    lines.push(
      bullet(`${job.id}  ${job.status.padEnd(10)} ${job.qualified ?? job.alias}  ${detail}`)
    );
  }

  const failed = jobs.filter((job) => job.status !== "completed");
  lines.push("");
  lines.push(
    failed.length === 0
      ? `${jobs.length} of ${jobs.length} completed.`
      : `${jobs.length - failed.length} of ${jobs.length} completed; ${failed.length} did not. Read each result before treating the work as done.`
  );

  return lines.join("\n");
}
