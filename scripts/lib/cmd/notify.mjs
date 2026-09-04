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
 */

import { listWorkspaces } from "../registry.mjs";
import { activeJobs, hasActiveJobs, markReported, unreportedJobs } from "../jobs.mjs";
import { reconcileAll } from "../reconcile.mjs";
import { sweep } from "../servers.mjs";
import { collectResult } from "./result.mjs";

// Well inside the Stop hook's 30s budget, leaving room for the sweep and for
// rendering the message.
const POLL_DEADLINE_MS = 10_000;
const POLL_REQUEST_TIMEOUT_MS = 4_000;

export async function notify() {
  const workspaces = listWorkspaces();
  if (workspaces.length === 0) {
    return "";
  }

  // The hook fires often, which makes it the natural place to run the cleanup
  // that no resident process is left alive to do. Reconcile first: a stranded
  // job would otherwise look like live work and keep its server from ever
  // being swept.
  reconcileAll(workspaces);

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

  for (const workspace of workspaces) {
    for (const job of activeJobs(workspace.slug)) {
      if (Date.now() > deadline) {
        break;
      }
      try {
        await collectResult(workspace.slug, job.id, { timeout: POLL_REQUEST_TIMEOUT_MS });
      } catch {
        // Unreachable server or a vanished session. Reconciliation handles it.
      }
    }
  }

  await sweep(workspaces, { hasRunningJobs: hasActiveJobs }).catch(() => []);

  const pending = unreportedJobs(workspaces);
  if (pending.length === 0) {
    return "";
  }

  const lines = [];

  for (const job of pending) {
    let current = job;

    // Refresh before announcing, so a job that finished while nobody was
    // looking is reported with its real outcome rather than its last guess.
    try {
      current = await collectResult(job.slug, job.id);
    } catch {
      // Report what we have.
    }

    if (current.status === "awaiting_permission") {
      const requests = current.result?.pendingPermissions ?? [];
      const first = requests[0];
      lines.push(
        `external-agents: job ${current.id} (${current.qualified ?? current.alias}) is waiting for permission` +
          (first ? ` to ${first.action}` : "") +
          `. Answer with /external-agents:permit ${current.id} ${first?.id ?? "<request-id>"} allow|reject`
      );
      // Deliberately not marked reported: it is still blocked, and it should
      // keep asking until someone answers.
      continue;
    }

    const changed = current.changes?.changed?.length ?? 0;
    const summary =
      current.status === "completed"
        ? `finished, ${changed} file(s) changed`
        : `${current.status}${current.error ? `: ${current.error}` : ""}`;

    lines.push(
      `external-agents: job ${current.id} (${current.qualified ?? current.alias}) ${summary}. See it with /external-agents:result ${current.id}`
    );
    markReported(current);
  }

  return lines.join("\n");
}
