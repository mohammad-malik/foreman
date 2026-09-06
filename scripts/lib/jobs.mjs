/**
 * Job records.
 *
 * A job is the unit the user thinks in: one handoff, sent to one model, in one
 * repository. It outlives the process that created it, because delegation is
 * asynchronous and the session that started it may be gone by the time it
 * finishes. So every transition is written to disk immediately rather than
 * held in memory.
 *
 * Records are stored per workspace, which keeps one repository's history from
 * growing into a listing of every other repository you have ever delegated in.
 *
 * Several processes write the same record. A `wait` in one session, the Stop
 * hook in another, a `permit` typed by hand: all of them read a job, spend
 * seconds talking to a server, then write. Every write therefore goes through
 * `updateJob`, which reloads the record from disk at the last moment and lays
 * the patch over what is there now rather than over the copy the caller read
 * earlier. Without that, a `cancel` was overwritten back to "running" by a poll
 * that had loaded the job before the cancel, and a job announced by the Stop
 * hook lost its `reportedAt` to a poll that finished a second later and was
 * announced twice.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { readJsonIfPresent, workspaceStateDir, writeJsonAtomic } from "./state.mjs";

export const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
export const ACTIVE_STATUSES = new Set(["queued", "running", "awaiting_permission"]);

const MAX_JOBS_PER_WORKSPACE = 100;

function jobsDir(slug) {
  const dir = path.join(workspaceStateDir(slug), "jobs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function jobFile(slug, jobID) {
  return path.join(jobsDir(slug), `${jobID}.json`);
}

/**
 * Where a job's baseline file copies live. They are kept out of the record
 * itself because `listJobs` parses every record on every command, and a job
 * dispatched with --allow-dirty-tree can carry up to 16 MB of copied files.
 * Reading that a hundred times over to print a status line is not acceptable.
 */
function baselineContentsFile(slug, jobID) {
  return path.join(jobsDir(slug), `${jobID}.baseline-contents.json`);
}

/** The codex backend's per-job scratch directory. Mirrors codex-job.mjs. */
function codexDir(slug, jobID) {
  return path.join(workspaceStateDir(slug), "codex", jobID);
}

export function newJobID() {
  return `job_${randomBytes(6).toString("hex")}`;
}

export function createJob(workspace, fields) {
  const job = {
    id: newJobID(),
    status: "queued",
    workspaceRoot: workspace.root,
    slug: workspace.slug,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    // Set once the terminal state has been reported to the user, so the Stop
    // hook announces each finished job exactly once.
    reportedAt: null,
    sessionID: null,
    error: null,
    result: null,
    ...fields
  };

  job.baseline = detachBaselineContents(job.slug, job.id, job.baseline);

  saveJob(job);
  pruneJobs(workspace.slug);
  return job;
}

/**
 * Move a baseline's file copies into their side file and leave a pointer.
 * Idempotent: a baseline that has already been detached is returned as is.
 */
function detachBaselineContents(slug, jobID, baseline) {
  if (!baseline || !baseline.contents || Object.keys(baseline.contents).length === 0) {
    return baseline;
  }

  const file = baselineContentsFile(slug, jobID);
  writeJsonAtomic(file, baseline.contents);

  const { contents, ...rest } = baseline;
  return { ...rest, contentsFile: file };
}

/**
 * A job's baseline with its file copies attached, ready for revert.
 *
 * Records written before the side file existed carry `contents` inline, and
 * those still restore. A record whose side file has gone reports that: revert
 * then skips those paths with the reason rather than deleting them.
 */
export function hydrateBaseline(job) {
  const baseline = job?.baseline;
  if (!baseline) {
    return null;
  }
  if (baseline.contents) {
    return baseline;
  }
  if (!baseline.contentsFile) {
    return { ...baseline, contents: {} };
  }

  const contents = readJsonIfPresent(baseline.contentsFile);
  if (contents === null) {
    return {
      ...baseline,
      contents: {},
      skippedContents: Object.fromEntries(
        Object.keys(baseline.hashes ?? {}).map((entry) => [
          entry,
          baseline.skippedContents?.[entry] ?? "its saved copy is missing from the state directory"
        ])
      )
    };
  }
  return { ...baseline, contents };
}

export function saveJob(job) {
  writeJsonAtomic(jobFile(job.slug, job.id), { ...job, updatedAt: new Date().toISOString() });
  return job;
}

/**
 * Apply a patch to the record as it is on disk NOW, not to the caller's copy.
 *
 * `changes` may be an object, or a function of the fresh record that returns
 * one, for patches whose values depend on the current state (folding a wait
 * into blockedMs, for instance). Two facts are sticky whatever the patch says:
 *
 * - A terminal status never goes back to an active one. The only way out of
 *   "cancelled" or "failed" is a new job. A poll that was mid-flight when the
 *   cancel landed must not resurrect the work.
 * - A frozen change set stays frozen. Once a job has finished and its diff has
 *   been recorded, later recomputation would describe the tree now, not what
 *   the job did.
 */
export function updateJob(job, changes) {
  const fresh = loadJob(job.slug, job.id) ?? job;
  const patch = typeof changes === "function" ? changes(fresh) : changes;
  const merged = { ...fresh, ...patch };

  // Terminal is terminal: neither back to active, nor across to a different
  // terminal state. A poll that loaded the job before a cancel must not turn
  // "cancelled" into "completed" on the strength of the transcript it fetched.
  if (TERMINAL_STATUSES.has(fresh.status) && patch.status !== undefined && patch.status !== fresh.status) {
    merged.status = fresh.status;
    merged.finishedAt = fresh.finishedAt;
    merged.error = fresh.error;
  }

  if (fresh.finishedAt && fresh.changes && patch.changes !== undefined) {
    merged.changes = fresh.changes;
  }

  merged.baseline = detachBaselineContents(merged.slug, merged.id, merged.baseline);

  return saveJob(merged);
}

export function loadJob(slug, jobID) {
  return readJsonIfPresent(jobFile(slug, jobID));
}

export function listJobs(slug) {
  let names;
  try {
    names = fs.readdirSync(jobsDir(slug));
  } catch {
    return [];
  }

  return names
    .filter((name) => name.endsWith(".json") && !name.endsWith(".baseline-contents.json"))
    .map((name) => readJsonIfPresent(path.join(jobsDir(slug), name)))
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/**
 * Find a job by id across every workspace, or the most recent one anywhere.
 *
 * Job ids are unique enough to be used on their own, which matters because
 * nobody wants to type a repository path to ask how their job is doing.
 */
export function findJob(workspaces, jobID) {
  if (!jobID) {
    return latestJob(workspaces);
  }

  for (const workspace of workspaces) {
    const job = loadJob(workspace.slug, jobID);
    if (job) {
      return job;
    }
  }

  return null;
}

export function latestJob(workspaces) {
  const all = workspaces.flatMap((workspace) => listJobs(workspace.slug));
  return all.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null;
}

export function activeJobs(slug) {
  return listJobs(slug).filter((job) => ACTIVE_STATUSES.has(job.status));
}

export function hasActiveJobs(workspace) {
  return activeJobs(workspace.slug).length > 0;
}

/**
 * Jobs that reached a terminal state but have not been announced yet. This is
 * what the Stop hook reads to tell you a background job landed.
 */
export function unreportedJobs(workspaces) {
  return workspaces
    .flatMap((workspace) => listJobs(workspace.slug))
    .filter((job) => job.reportedAt === null)
    .filter((job) => TERMINAL_STATUSES.has(job.status) || job.status === "awaiting_permission")
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

export function markReported(job) {
  return updateJob(job, { reportedAt: new Date().toISOString() });
}

/**
 * Keep history bounded. Active jobs are never pruned, however old they look.
 * Everything a job left behind goes with it: its record, its baseline copies,
 * and the codex scratch directory holding its handoff and event log.
 */
function pruneJobs(slug) {
  const jobs = listJobs(slug);
  if (jobs.length <= MAX_JOBS_PER_WORKSPACE) {
    return;
  }

  const removable = jobs.filter((job) => TERMINAL_STATUSES.has(job.status));
  const excess = jobs.length - MAX_JOBS_PER_WORKSPACE;

  for (const job of removable.slice(-excess)) {
    removeJobFiles(slug, job.id);
  }
}

export function removeJobFiles(slug, jobID) {
  for (const file of [jobFile(slug, jobID), baselineContentsFile(slug, jobID)]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // Nothing to do; it will be pruned next time.
    }
  }
  try {
    fs.rmSync(codexDir(slug, jobID), { recursive: true, force: true });
  } catch {
    // A file still held open by a lingering process; next time.
  }
}

/**
 * Wall-clock time the job has actually been working.
 *
 * Time spent waiting for a human to answer a permission request does not
 * count. The budget exists to stop a runaway, and a job blocked on a person is
 * the opposite of a runaway: it is doing nothing at all. Counting it killed a
 * real job at 65 minutes that had been sitting on an unanswered prompt since
 * minute 13, and it would kill every delegation started before someone went to
 * bed.
 */
export function elapsedMs(job) {
  const start = Date.parse(job.startedAt ?? job.createdAt);
  const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();

  let blocked = job.blockedMs ?? 0;
  if (job.awaitingSince) {
    blocked += Math.max(0, (job.finishedAt ? Date.parse(job.finishedAt) : Date.now()) - Date.parse(job.awaitingSince));
  }

  return Math.max(0, end - start - blocked);
}

/** Total time this job has spent waiting on a person. */
export function blockedMs(job) {
  let blocked = job.blockedMs ?? 0;
  if (job.awaitingSince) {
    blocked += Math.max(0, Date.now() - Date.parse(job.awaitingSince));
  }
  return blocked;
}

/**
 * Stamp when a job started waiting for an answer. Idempotent.
 *
 * The stamp is the last moment the job was KNOWN to be working, not the moment
 * a poll happened to notice it was blocked. Those differ by however long it
 * went unpolled, and the difference is not small: a real job waited about 25
 * minutes and was credited 26 seconds, because a poll found it just before the
 * answer arrived. The request was raised somewhere between the last clean poll
 * and now, so crediting from the last clean poll is the most generous bound the
 * evidence supports. It errs toward not killing a job, which is the direction
 * to err in.
 */
export function markAwaiting(job) {
  return updateJob(job, (fresh) => {
    if (fresh.awaitingSince) {
      return {};
    }
    return {
      status: "awaiting_permission",
      awaitingSince: fresh.lastPolledAt ?? new Date().toISOString()
    };
  });
}

/**
 * Record that a poll found this job working rather than blocked.
 *
 * This is the bound markAwaiting uses. Without it there is no evidence of when
 * waiting began, only of when it was discovered.
 */
export function markPolled(job) {
  return updateJob(job, { lastPolledAt: new Date().toISOString() });
}

/** Fold the wait into blockedMs and resume. */
export function markResumed(job) {
  return updateJob(job, (fresh) => {
    const extra = fresh.awaitingSince
      ? Math.max(0, Date.now() - Date.parse(fresh.awaitingSince))
      : 0;

    return {
      status: "running",
      awaitingSince: null,
      // Work resumes now, so this is also the last moment it was known working.
      lastPolledAt: new Date().toISOString(),
      blockedMs: (fresh.blockedMs ?? 0) + extra
    };
  });
}

export function describeElapsed(job) {
  const ms = elapsedMs(job);
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
