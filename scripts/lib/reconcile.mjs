/**
 * Resolving jobs that can never finish on their own.
 *
 * A job record outlives the process that created it, which is the point: you
 * can close the session and the work carries on. The cost is that nothing is
 * left watching, so a job can be stranded. Its server was stopped, or the
 * machine was rebooted, or it simply ran far longer than it was given.
 *
 * Stranded jobs are not merely untidy. `hasActiveJobs` treats them as work in
 * flight, so the idle sweep spares their server forever, and a job stuck at
 * "running" for three days is the kind of thing that quietly erodes trust in
 * everything else the tool says. This runs wherever job state is read and
 * moves those records to a terminal state with a reason.
 *
 * It is deliberately conservative: a job is only failed when it cannot
 * possibly still be running, never merely because it is slow.
 */

import { judgeCodexJob, readCodexJob } from "./codex-job.mjs";
import { ACTIVE_STATUSES, elapsedMs, listJobs, updateJob } from "./jobs.mjs";
import { currentServer } from "./servers.mjs";

/**
 * Grace period before a job with no reachable server is declared dead.
 *
 * A server that is being restarted, or a job caught in the moment between
 * dispatch and the server answering, should not be failed for it.
 */
const SERVER_GONE_GRACE_MS = 60_000;

export function reconcileWorkspace(workspace) {
  const changed = [];

  for (const job of listJobs(workspace.slug)) {
    if (!ACTIVE_STATUSES.has(job.status)) {
      continue;
    }

    const elapsed = elapsedMs(job);
    const budget = job.budgetMs ?? 15 * 60 * 1000;

    if (elapsed > budget) {
      changed.push(
        updateJob(job, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: `Exceeded its ${Math.round(budget / 60000)} minute budget. Any edits it had already written are still on disk.`
        })
      );
      continue;
    }

    // A Codex job has no server to lose. Its process either exists or it does
    // not, and once it is gone the event log is the whole story, so this is
    // where a background Codex job reaches a terminal state.
    if (job.backend === "codex") {
      const state = readCodexJob(job);
      if (!state.alive) {
        const judged = judgeCodexJob(job, state);
        changed.push(
          updateJob(job, {
            status: judged.status,
            finishedAt: new Date().toISOString(),
            error: judged.error
          })
        );
      }
      continue;
    }

    // No server means no session, and the session cannot be revived: OpenCode
    // sessions do not survive their server here.
    if (!currentServer(workspace) && elapsed > SERVER_GONE_GRACE_MS) {
      changed.push(
        updateJob(job, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          error:
            "The OpenCode server running this job stopped before it finished. Any edits it had already written are still on disk."
        })
      );
    }
  }

  return changed;
}

export function reconcileAll(workspaces) {
  return workspaces.flatMap((workspace) => {
    try {
      return reconcileWorkspace(workspace);
    } catch {
      // Reconciliation is housekeeping. It must never be the reason a status
      // command fails.
      return [];
    }
  });
}
