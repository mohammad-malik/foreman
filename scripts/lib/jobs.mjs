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

  saveJob(job);
  pruneJobs(workspace.slug);
  return job;
}

export function saveJob(job) {
  writeJsonAtomic(jobFile(job.slug, job.id), { ...job, updatedAt: new Date().toISOString() });
  return job;
}

export function updateJob(job, changes) {
  return saveJob({ ...job, ...changes });
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
    .filter((name) => name.endsWith(".json"))
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
  for (const workspace of workspaces) {
    const job = jobID ? loadJob(workspace.slug, jobID) : listJobs(workspace.slug)[0];
    if (job) {
      return job;
    }
  }

  if (!jobID) {
    return null;
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

/** Keep history bounded. Active jobs are never pruned, however old they look. */
function pruneJobs(slug) {
  const jobs = listJobs(slug);
  if (jobs.length <= MAX_JOBS_PER_WORKSPACE) {
    return;
  }

  const removable = jobs.filter((job) => TERMINAL_STATUSES.has(job.status));
  const excess = jobs.length - MAX_JOBS_PER_WORKSPACE;

  for (const job of removable.slice(-excess)) {
    try {
      fs.unlinkSync(jobFile(slug, job.id));
    } catch {
      // Nothing to do; it will be pruned next time.
    }
  }
}

export function elapsedMs(job) {
  const start = Date.parse(job.startedAt ?? job.createdAt);
  const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
  return end - start;
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
