/**
 * Job inspection and control: status, result, permit, cancel, revert.
 *
 * Everything here works from a job id alone. Nobody wants to type a repository
 * path to ask how their delegation is going, so jobs are looked up across every
 * registered workspace.
 */

import { cancelCodexJob } from "../codex-job.mjs";
import { OpencodeApi } from "../opencode-api.mjs";
import { currentServer } from "../servers.mjs";
import { diffAgainstBaseline, diffStat, revertPaths } from "../git-baseline.mjs";
import {
  ACTIVE_STATUSES,
  describeElapsed,
  hydrateBaseline,
  latestJob,
  listJobs,
  loadJob,
  markReported,
  markResumed,
  TERMINAL_STATUSES,
  updateJob
} from "../jobs.mjs";
import { listWorkspaces } from "../registry.mjs";
import { reconcileAll } from "../reconcile.mjs";
import { bullet, heading, keyValue, oneLine, untrustedInline } from "../render.mjs";
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

/**
 * Bring active jobs up to date from the server before reporting on them.
 *
 * Without this, `status` reconciles local records but never asks the server
 * anything, so a job that has been blocked on a permission for ten minutes
 * still reads as "running". That is the difference between "it is working" and
 * "it has been waiting for you", and it is exactly how a real job was left
 * blocked until its budget expired.
 *
 * Bounded, because status should stay quick: a short per-request timeout and an
 * overall deadline, after which the remaining jobs are reported from their last
 * known state rather than making the caller wait.
 */
const STATUS_REFRESH_DEADLINE_MS = 6_000;
const STATUS_REQUEST_TIMEOUT_MS = 2_500;

async function refreshActive(workspaces) {
  const deadline = Date.now() + STATUS_REFRESH_DEADLINE_MS;

  for (const workspace of workspaces) {
    for (const job of listJobs(workspace.slug)) {
      if (!ACTIVE_STATUSES.has(job.status) || Date.now() > deadline) {
        continue;
      }
      try {
        await collectResult(workspace.slug, job.id, { timeout: STATUS_REQUEST_TIMEOUT_MS });
      } catch {
        // Unreachable server or vanished session; reconciliation handles it.
      }
    }
  }
}

export async function status(jobID) {
  const workspaces = listWorkspaces();

  // Refresh BEFORE reconciling, never the other way round.
  //
  // Reconciliation applies the budget. Running it first meant a job that had
  // raised a permission request since its last poll, and whose budget had
  // elapsed, was failed as a runaway before anything asked the server whether
  // it was actually blocked. refreshActive then skipped it for being terminal,
  // and permit ignored it for the same reason, so the request could never be
  // answered and the job was unrecoverable.
  //
  // Refreshing first means a blocked job is stamped as blocked, which stops
  // its budget, so the reconcile that follows sees the truth.
  await refreshActive(workspaces);
  await reconcileAll(workspaces);

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
  let updated = await collectResult(job.slug, job.id);

  // Showing the outcome IS reporting it. Without this the Stop hook announced
  // every job the user had just read a second time on the next turn.
  if (TERMINAL_STATUSES.has(updated.status) && updated.reportedAt === null) {
    updated = markReported(updated);
  }

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
    `Replied ${decision} to ${oneLine(request.action ?? request.type ?? "request", 60)}${
      request.resources?.length ? `: ${untrustedInline(request.resources[0], { max: 300, label: "requested" })}` : ""
    }`,
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
          `  permit ${job.id} ${request.id} allow    (${oneLine(request.action ?? "request", 40)}: ${untrustedInline((request.resources ?? [])[0] ?? "", { max: 120, label: "requested" })})`
      )
    ].join("\n")
  );
}

/**
 * How long to let an interrupted agent finish the write it was in the middle
 * of before the change set is frozen. An interrupt is asynchronous on the
 * server: the tool call in flight completes. Diffing the instant the request
 * returned missed that file, permanently, in both the report and revert.
 */
const SETTLE_AFTER_INTERRUPT_MS = 2_000;

export async function cancel(jobID) {
  const { job, workspace } = findJobAnywhere(jobID);

  if (!ACTIVE_STATUSES.has(job.status)) {
    return `Job ${job.id} is already ${job.status}. Nothing to cancel.`;
  }

  const lines = [];
  let stoppedCleanly = false;

  if (job.backend === "codex") {
    // The process tree, not just the process: codex runs its shell commands as
    // children, and signalling only the parent leaves one of them mid-write.
    const killed = cancelCodexJob(job);
    stoppedCleanly = killed.killed;
    lines.push(
      killed.killed
        ? `Stopped the codex process (pid ${job.pid}).`
        : `Could not stop pid ${job.pid}: ${killed.reason}.`
    );
  } else {
    const server = currentServer(workspace);
    if (server) {
      try {
        await new OpencodeApi(server).interrupt(job.sessionID);
        stoppedCleanly = true;
        lines.push(`Interrupted session ${job.sessionID}.`);
      } catch (error) {
        lines.push(`Could not interrupt the session cleanly: ${error.message}`);
      }
    } else {
      lines.push("The server was already gone.");
    }
  }

  // Mark it cancelled FIRST, so a poll racing this call cannot write "running"
  // back over the top: terminal status is sticky in updateJob. The change set
  // is filled in afterwards, once the interrupted work has had a moment to
  // land. `settlingUntil` tells every other collector (status, wait, the Stop
  // hook) not to compute and freeze a diff in the meantime: one that ran during
  // the pause froze a half-written set, and the complete one computed here was
  // then refused by the freeze guard.
  const settleMs = stoppedCleanly && job.baseline ? SETTLE_AFTER_INTERRUPT_MS : 0;
  updateJob(job, {
    status: "cancelled",
    finishedAt: new Date().toISOString(),
    changes: null,
    settlingUntil: new Date(Date.now() + settleMs + 1000).toISOString()
  });

  if (settleMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }

  // Recompute the diff now rather than keeping whatever was last collected.
  // Cancelling makes the job terminal, which freezes its change set, and a
  // snapshot taken mid-run would permanently omit everything the agent wrote
  // between then and the interrupt, hiding those files from both the report
  // and revert.
  let changes = null;
  if (job.baseline) {
    try {
      const diff = diffAgainstBaseline(job.baseline);
      changes = { ...diff, stat: diffStat(job.workspaceRoot, diff.changed.map((e) => e.path)) };
    } catch {
      // Left open; the next `result` computes it and the report says so until then.
    }
  }

  updateJob(job, { settlingUntil: null, ...(changes ? { changes } : {}) });

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

/**
 * Restore only the files a job changed.
 *
 * The job's FROZEN change set is what gets reverted, never a fresh diff. A
 * fresh diff attributes everything that differs from the baseline to the job,
 * including edits the user made themselves after it finished, and reverting
 * those destroyed real work. The frozen set was recorded when the job settled
 * and describes what the job did.
 *
 * An active job is refused. Reverting under a running agent restores files it
 * is still editing, and its next write lands on top of the restore.
 */
export async function revert(jobID) {
  const { job } = findJobAnywhere(jobID);

  if (!job.baseline) {
    return `Job ${job.id} was read-only. There is nothing to revert.`;
  }

  if (ACTIVE_STATUSES.has(job.status)) {
    throw new Error(
      [
        `Job ${job.id} is still ${job.status}. Reverting under a running agent would be undone by its next write.`,
        `Cancel it first:  /external-agents:cancel ${job.id}`
      ].join("\n")
    );
  }

  // Settle the record so the change set is frozen and complete. For a job that
  // was cancelled or failed without a recorded diff, this is what collects it.
  const settled = await collectResult(job.slug, job.id);
  const changed = settled.changes?.changed;

  if (!changed) {
    throw new Error(
      `The change set for job ${job.id} could not be determined, so there is nothing safe to revert. Inspect the tree by hand.`
    );
  }

  if (changed.length === 0) {
    return `Job ${job.id} changed nothing. There is nothing to revert.`;
  }

  // Compared live rather than from the frozen set, because the question is
  // whether the tree has moved on since, not what the job did.
  const now = diffAgainstBaseline(settled.baseline);

  if (now.headMoved) {
    throw new Error(
      [
        `HEAD has moved since job ${job.id} ran (${settled.baseline.head} -> ${now.headAfter}).`,
        "Reverting now could undo work that came afterwards, so this is refused.",
        "Inspect the diff and revert by hand."
      ].join("\n")
    );
  }

  const baseline = hydrateBaseline(settled);
  const outcome = revertPaths(settled.workspaceRoot, baseline, changed);
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

  // Paths that differ from the baseline now but were not part of the job are
  // the user's own later work. Named so nobody wonders why they were left.
  const frozen = new Set(changed.map((entry) => entry.path));
  const untouched = now.changed.filter((entry) => !frozen.has(entry.path));
  if (untouched.length > 0) {
    lines.push("");
    lines.push(`${untouched.length} other changed path(s) were left alone because they were not part of this job:`);
    for (const entry of untouched.slice(0, 10)) {
      lines.push(bullet(entry.path));
    }
    if (untouched.length > 10) {
      lines.push(bullet(`... and ${untouched.length - 10} more`));
    }
  }

  return lines.join("\n");
}
