/**
 * The two subcommands that make natural-language delegation possible.
 *
 * `resolve` turns "fast glm 5.3" into an exact alias and route, so Claude never
 * has to know which models exist or guess at a spelling. `wait` blocks until
 * jobs finish, so "when everything is done, run a codex review" is one call
 * rather than a polling loop that burns turns.
 */

import { detectVersion, loadInventory } from "../opencode.mjs";
import { codexModels } from "../codex.mjs";
import { describeAvailable, resolveSpoken, SpokenNameError } from "../resolve-spoken.mjs";
import { ACTIVE_STATUSES, describeElapsed, listJobs, loadJob } from "../jobs.mjs";
import { listWorkspaces } from "../registry.mjs";
import { reconcileAll } from "../reconcile.mjs";
import { collectResult } from "./result.mjs";
import { bullet, heading } from "../render.mjs";

/**
 * Every backend's live model list, gathered best effort.
 *
 * A backend that cannot be reached is left out rather than reported empty. Left
 * out means "unverified" and resolution proceeds on the local table; reported
 * empty would mean "offers nothing" and would refuse every model on it, which
 * is the wrong answer when the real problem is that a cache file is missing.
 */
export function liveInventories() {
  const inventories = {};

  try {
    const version = detectVersion();
    inventories.opencode = loadInventory({ version: version.version }).models;
  } catch {
    // OpenCode is not installed or not answering.
  }

  const codex = codexModels();
  if (codex) {
    inventories.codex = codex;
  }

  return inventories;
}

/**
 * Resolve a spoken model name against the live inventories.
 *
 * Emits JSON, because the caller is Claude assembling a delegate command and a
 * machine-readable answer removes a parsing step from the loop.
 */
export function resolve(phrase) {
  const inventories = liveInventories();
  const verified = Object.keys(inventories);
  const passed = verified.length > 0 ? inventories : null;

  try {
    const match = resolveSpoken(phrase, passed);

    return JSON.stringify(
      {
        ok: true,
        model: match.alias,
        backend: match.backend,
        route: match.route,
        qualified: match.qualified,
        providerID: match.providerID,
        modelID: match.modelID,
        matchedOn: match.matchedOn,
        // Flagged rather than hidden: a model with one route gets that route
        // even when another was asked for, and the caller should say so.
        substitutedRoute: match.substitutedRoute,
        requestedRoute: match.requestedRoute,
        // Which backend runs it was not stated out loud, so it came from the
        // model's own default. That decides whether the job goes through the
        // Codex CLI or an OpenCode server, so it is reported either way.
        defaultedBackend: match.defaultedBackend,
        requestedBackend: match.requestedBackend,
        verifiedAgainst: verified
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
        available: isSpoken ? error.candidates : describeAvailable(passed)
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
