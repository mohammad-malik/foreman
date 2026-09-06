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
 *
 * Failing a record is not the same as stopping the work. A job past its budget
 * used to be marked failed while its agent carried on editing files under a
 * record that no longer protected its server and could already be reverted. So
 * the budget now stops the process or interrupts the session first, and the
 * change set is left open for `result` to collect once the edits have stopped.
 */

import {
  cancelCodexJob,
  isStalled,
  judgeCodexJob,
  processMatchesJob,
  readCodexJob,
  SILENT_GRACE_MS
} from "./codex-job.mjs";
import { ACTIVE_STATUSES, elapsedMs, listJobs, updateJob } from "./jobs.mjs";
import { OpencodeApi } from "./opencode-api.mjs";
import { currentServer } from "./servers.mjs";

/**
 * Grace period before a job with no reachable server is declared dead.
 *
 * A server that is being restarted, or a job caught in the moment between
 * dispatch and the server answering, should not be failed for it.
 */
const SERVER_GONE_GRACE_MS = 60_000;
const INTERRUPT_TIMEOUT_MS = 5_000;

export async function reconcileWorkspace(workspace) {
  const changed = [];
  const server = currentServer(workspace);

  for (const job of listJobs(workspace.slug)) {
    if (!ACTIVE_STATUSES.has(job.status)) {
      continue;
    }

    const elapsed = elapsedMs(job);
    const budget = job.budgetMs ?? 15 * 60 * 1000;

    if (elapsed > budget) {
      const stopped = await stopWork(job, server);
      changed.push(
        updateJob(job, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          // Left open so `result` collects the diff after the edits have
          // stopped, then freezes it. Freezing a mid-run snapshot here hid the
          // agent's last writes from both the report and revert.
          changes: null,
          error: `Exceeded its ${Math.round(budget / 60000)} minute budget. ${stopped} Any edits it had already written are still on disk.`
        })
      );
      continue;
    }

    // A Codex job has no server to lose. Its process either exists or it does
    // not, and once it is gone the event log is the whole story, so this is
    // where a background Codex job reaches a terminal state.
    if (job.backend === "codex") {
      let state = readCodexJob(job);

      // A live-looking PID that is not this job's codex is a recycled number,
      // so the job is judged as the finished thing it is. Unfinished turns
      // get this check after the grace period; judgeCodexJob checks ended
      // turns before allowing their change sets to freeze.
      if (state.alive && !state.parsed.turnDone && elapsed > SILENT_GRACE_MS) {
        if (!processMatchesJob(job)) {
          state = { ...state, alive: false };
        }
      }

      if (state.alive && isStalled(job, state)) {
        const killed = cancelCodexJob(job);
        changed.push(
          updateJob(job, {
            status: "failed",
            finishedAt: new Date().toISOString(),
            error: [
              `codex started (pid ${job.pid}) but produced no output in ${Math.round(SILENT_GRACE_MS / 60000)} minutes, so it is stuck rather than working.`,
              killed.killed ? "The process was stopped." : `The process could not be stopped (${killed.reason}).`,
              "A working run emits its first event within seconds. This is what a `codex` on PATH that cannot be spawned detached looks like: a wrapper or shim rather than the real binary.",
              "Check `codex --version` runs, and set EXTERNAL_AGENTS_CODEX_BIN to the real executable if PATH resolves to a shim."
            ].join(" ")
          })
        );
        continue;
      }

      const judged = judgeCodexJob(job, state);
      if (judged.status !== "running") {
        changed.push(
          updateJob(job, {
            status: judged.status,
            finishedAt: new Date().toISOString(),
            // A poll before exit may have captured only some edits. Let result
            // collect the final diff before freezing it for report and revert.
            changes: null,
            error: judged.error
          })
        );
      }
      continue;
    }

    // No server means no session, and the session cannot be revived: OpenCode
    // sessions do not survive their server here.
    if (!server && elapsed > SERVER_GONE_GRACE_MS) {
      changed.push(
        updateJob(job, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          changes: null,
          error:
            "The OpenCode server running this job stopped before it finished. Any edits it had already written are still on disk."
        })
      );
      continue;
    }

    // A server is running, but not the one this job's session lived on. The
    // old one was reclaimed and replaced, and its sessions went with it. This
    // used to sit at "running" until the budget expired, because every poll
    // got a 404 and treated it as a transient warning.
    if (server && job.serverUrl && server.url !== job.serverUrl) {
      changed.push(
        updateJob(job, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          changes: null,
          error: `The OpenCode server running this job (${job.serverUrl}) was replaced by a new one (${server.url}) before it finished, and its session did not survive. Any edits it had already written are still on disk.`
        })
      );
    }
  }

  return changed;
}

/**
 * Stop a job's work before its record is failed. Returns one sentence saying
 * what happened, for the error message.
 */
async function stopWork(job, server) {
  if (job.backend === "codex") {
    const outcome = cancelCodexJob(job);
    return outcome.killed
      ? "The codex process was stopped."
      : `The codex process was not stopped (${outcome.reason}).`;
  }

  if (!server || !job.sessionID) {
    return "Its server was already gone.";
  }
  if (job.serverUrl && server.url !== job.serverUrl) {
    return "Its server had already been replaced.";
  }

  try {
    await new OpencodeApi(server, { timeout: INTERRUPT_TIMEOUT_MS }).interrupt(job.sessionID);
    return "The session was interrupted.";
  } catch (error) {
    return `The session could not be interrupted (${error.message}).`;
  }
}

export async function reconcileAll(workspaces) {
  const changed = [];
  for (const workspace of workspaces) {
    try {
      changed.push(...(await reconcileWorkspace(workspace)));
    } catch {
      // Reconciliation is housekeeping. It must never be the reason a status
      // command fails.
    }
  }
  return changed;
}
