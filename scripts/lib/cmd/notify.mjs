/**
 * What the Stop hook prints.
 *
 * This is the answer to the awkward question in an asynchronous design: when a
 * background job finishes, who tells you? Polling in a loop burns turns and
 * makes the conversation useless while it waits. Instead the Stop hook runs at
 * each turn boundary and reports anything that has landed since the last one.
 *
 * Each job is announced exactly once. Being told three times that the same job
 * finished would be worse than not being told at all, so a reported timestamp
 * is written as soon as it is mentioned.
 *
 * Announced to the right session. State is global to the machine, and the hook
 * fires in every Claude session that has the plugin. Announcing every finished
 * job everywhere meant the first session to end a turn claimed the report, so
 * the session that dispatched a job routinely never heard about it, and every
 * other session was told about work in repositories it had never touched. A
 * job is now announced in the session that dispatched it. Only when that
 * session has evidently gone (the job has sat unclaimed for a while) is it
 * offered to a session working in the same repository.
 */

import { listWorkspaces, findWorkspaceFor } from "../registry.mjs";
import { activeJobs, hasActiveJobs, markReported, unreportedJobs } from "../jobs.mjs";
import { reconcileAll } from "../reconcile.mjs";
import { sweep } from "../servers.mjs";
import { oneLine } from "../render.mjs";
import { collectResult } from "./result.mjs";

// Well inside the Stop hook's 30s budget, leaving room for the sweep and for
// rendering the message.
const POLL_DEADLINE_MS = 10_000;
const POLL_REQUEST_TIMEOUT_MS = 4_000;

/**
 * How long a finished job waits for its own session before another session in
 * the same repository may announce it. Long enough that a session mid-thought
 * is not pre-empted; short enough that a job whose session was closed is not
 * lost until someone remembers to ask.
 */
const ORPHAN_AFTER_MS = 10 * 60 * 1000;

/** The session id Claude Code exposes to commands it runs, if any. */
export function currentSessionID(env = process.env) {
  return env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || null;
}

/**
 * Whether this hook invocation should announce this job. `context` is what
 * the hook read from Claude Code: the session id and working directory.
 */
export function shouldAnnounce(job, context, now = Date.now()) {
  const { sessionID = null, cwd = null } = context ?? {};

  // A job with no recorded session predates this rule, or was dispatched from
  // outside Claude Code. Anyone may announce it.
  if (!job.dispatchSessionID) {
    return true;
  }
  if (sessionID && job.dispatchSessionID === sessionID) {
    return true;
  }

  // Not ours. Offer it to a session in the same repository once it has gone
  // unclaimed long enough to suggest its own session is gone. A blocked job is
  // offered the same way: a permission nobody can see is a job nobody can save.
  const since = Date.parse(job.finishedAt ?? job.awaitingSince ?? job.updatedAt ?? job.createdAt ?? "");
  if (Number.isNaN(since) || now - since < ORPHAN_AFTER_MS) {
    return false;
  }
  if (!cwd) {
    return false;
  }
  try {
    const workspace = findWorkspaceFor(cwd);
    return Boolean(workspace) && workspace.slug === job.slug;
  } catch {
    return false;
  }
}

export async function notify(context = {}) {
  const workspaces = listWorkspaces();
  if (workspaces.length === 0) {
    return "";
  }

  // The hook fires often, which makes it the natural place to run the cleanup
  // that no resident process is left alive to do. Reconcile first: a stranded
  // job would otherwise look like live work and keep its server from ever
  // being swept.
  // Poll BEFORE reconciling, for the same reason status does: reconciliation
  // applies the budget, and a job blocked since its last poll would be failed
  // as a runaway before anything discovered it was waiting on a person.
  //
  // Poll everything still running BEFORE deciding what to report. Nothing else
  // advances a backgrounded job: `--background` returns immediately and leaves
  // no waiter behind, so without this the job sits at "running" until
  // reconciliation eventually fails it at its budget. That would make the
  // headline feature quietly useless.
  //
  // Bounded by a deadline well inside the hook's own 30s timeout. A server
  // process that is alive but wedged would otherwise burn a full per-request
  // timeout on each job in turn, stalling every turn of the conversation until
  // the hook is killed and taking the sweep and the notifications down with
  // it. Jobs not reached simply wait for the next turn.
  const deadline = Date.now() + POLL_DEADLINE_MS;
  const polled = new Map();

  for (const workspace of workspaces) {
    for (const job of activeJobs(workspace.slug)) {
      if (Date.now() > deadline) {
        break;
      }
      try {
        polled.set(job.id, await collectResult(workspace.slug, job.id, { timeout: POLL_REQUEST_TIMEOUT_MS }));
      } catch {
        // Unreachable server or a vanished session. Reconciliation handles it.
      }
    }
  }

  await reconcileAll(workspaces);
  await sweep(workspaces, { hasRunningJobs: hasActiveJobs }).catch(() => []);

  const pending = unreportedJobs(workspaces).filter((job) => shouldAnnounce(job, context));
  if (pending.length === 0) {
    return "";
  }

  const lines = [];

  for (const job of pending) {
    // `job` was read from disk AFTER reconciliation, so it carries a budget or
    // server-gone failure the poll above could not have seen. The poll result is
    // not reused as the record: it predates reconcile and announced a job as
    // still running that had just been failed.
    let current = job;

    // A job that finished while nobody was looking, and was not reached by the
    // poll above, is refreshed before it is announced so the report carries its
    // real outcome. The same short timeout applies: the first poll was bounded
    // and this one has to be too, or a wedged server makes the hook overrun its
    // own budget and nothing is ever announced.
    if (!polled.has(job.id) && Date.now() < deadline + POLL_DEADLINE_MS) {
      try {
        current = await collectResult(job.slug, job.id, { timeout: POLL_REQUEST_TIMEOUT_MS });
      } catch {
        // Report what we have.
      }
    }

    if (current.status === "awaiting_permission") {
      const requests = current.result?.pendingPermissions ?? [];
      const first = requests[0];
      lines.push(
        `external-agents: job ${current.id} (${current.qualified ?? current.alias}) is waiting for permission` +
          (first ? ` to ${oneLine(first.action ?? first.type ?? "act", 40)}` : "") +
          `. Approve with /external-agents:permit allow, or reject it with /external-agents:permit reject`
      );
      // Deliberately not marked reported: it is still blocked, and it should
      // keep asking until someone answers.
      continue;
    }

    if (current.reportedAt !== null) {
      // Announced by `result` or another session between our listing and now.
      continue;
    }

    const changed = current.changes?.changed?.length ?? 0;
    const summary =
      current.status === "completed"
        ? `finished, ${changed} file(s) changed`
        : `${current.status}${current.error ? `: ${oneLine(current.error, 200)}` : ""}`;

    lines.push(
      `external-agents: job ${current.id} (${current.qualified ?? current.alias}) ${summary}. See it with /external-agents:result ${current.id}`
    );
    markReported(current);
  }

  return lines.join("\n");
}
