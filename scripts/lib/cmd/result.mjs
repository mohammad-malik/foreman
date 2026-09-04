/**
 * Collecting and presenting a job's outcome.
 *
 * Two rules shape this file.
 *
 * The change set comes from git, not from the model. An agent's account of
 * what it edited is a claim; the diff against the pre-flight baseline is the
 * record. Where they disagree, the record wins and the disagreement is worth
 * seeing.
 *
 * Everything the model wrote is untrusted. Its final response and any file
 * content it quotes can carry text that reads like instructions, either from
 * the model itself or injected into something it read. It is fenced and
 * labelled so it cannot be mistaken for part of this tool's own output.
 */

import { diffAgainstBaseline, diffStat } from "../git-baseline.mjs";
import { finalAssistantText, OpencodeApi, toolCalls, usageTotals } from "../opencode-api.mjs";
import { currentServer } from "../servers.mjs";
import { describeElapsed, loadJob, updateJob } from "../jobs.mjs";
import { listWorkspaces } from "../registry.mjs";
import { bullet, heading, keyValue, untrustedBlock } from "../render.mjs";

function workspaceFor(slug) {
  return listWorkspaces().find((entry) => entry.slug === slug) ?? null;
}

/**
 * Bring a job record up to date from the server, then persist it.
 *
 * Safe to call repeatedly, and safe to call after the server is gone: what was
 * already collected stays in the record.
 */
export async function collectResult(slug, jobID, { timeout } = {}) {
  const job = loadJob(slug, jobID);
  if (!job) {
    throw new Error(`No job ${jobID} in this workspace.`);
  }

  const workspace = workspaceFor(slug);
  const server = workspace ? currentServer(workspace) : null;

  // Whether the agent's current turn is actually over, as opposed to a
  // message that merely has some text in it so far.
  let turnFinished = false;

  const collected = {
    finalText: job.result?.finalText ?? null,
    children: job.result?.children ?? [],
    tools: job.result?.tools ?? [],
    cost: job.result?.cost ?? null,
    tokens: job.result?.tokens ?? null,
    pendingPermissions: [],
    warnings: []
  };

  if (server) {
    const api = new OpencodeApi(server, { timeout });

    try {
      const messages = await api.messages(job.sessionID);
      turnFinished = (await api.turnState(job.sessionID)).state === "idle";
      collected.finalText = finalAssistantText(messages) ?? collected.finalText;
      collected.tools = toolCalls(messages);

      // Session cost and tokens read as zero in this version, so the totals
      // are summed from the messages instead.
      const usage = usageTotals(messages);
      collected.cost = usage.cost;
      collected.tokens = { input: usage.input, output: usage.output, reasoning: usage.reasoning };
    } catch (error) {
      collected.warnings.push(`Could not read the session transcript: ${error.message}`);
    }

    try {
      // Child sessions are discovered from the server rather than taken from
      // the worker's summary, which is the only way to know what actually ran.
      const sessions = await api.listSessions({ directory: job.workspaceRoot });
      const list = Array.isArray(sessions) ? sessions : (sessions?.sessions ?? []);
      collected.children = list
        .filter((entry) => entry?.parentID === job.sessionID)
        .map((entry) => ({
          id: entry.id,
          agent: entry.agent ?? "unknown",
          title: entry.title ?? "",
          cost: entry.cost ?? null
        }));
    } catch (error) {
      collected.warnings.push(`Could not enumerate child sessions: ${error.message}`);
    }

    try {
      const pending = await api.pendingPermissions(job.sessionID);
      collected.pendingPermissions = Array.isArray(pending) ? pending : [];
    } catch {
      // Nothing pending, or the session is gone.
    }
  } else {
    collected.warnings.push(
      "The OpenCode server for this workspace is no longer running, so this is the last state that was recorded."
    );
    // Nothing can advance without a server, so whatever was captured before it
    // stopped is final. Reconciliation decides whether that counts as failure.
    turnFinished = Boolean(collected.finalText);
  }

  let changes = job.changes ?? null;

  // Once a job is finished its change set is frozen. Recomputing later would
  // report the state of the tree now, not what the job did: revert a job and
  // it would retroactively claim to have changed nothing, which is exactly
  // backwards.
  const settled = job.finishedAt && changes;

  if (job.baseline && !settled) {
    try {
      const diff = diffAgainstBaseline(job.baseline);
      changes = {
        ...diff,
        stat: diffStat(job.workspaceRoot, diff.changed.map((entry) => entry.path))
      };
    } catch (error) {
      collected.warnings.push(`Could not compute the change set: ${error.message}`);
    }
  }

  let status = job.status;
  if (collected.pendingPermissions.length > 0) {
    status = "awaiting_permission";
  } else if (status === "running" || status === "queued" || status === "awaiting_permission") {
    // Text alone is not enough. An assistant message still streaming already
    // has partial text, and settling on it would freeze an incomplete change
    // set and drop the job out of active-server protection while the agent is
    // still editing. The turn must actually be finished.
    status = turnFinished && collected.finalText ? "completed" : "running";
  }

  // Cancelled belongs here too. Without it a cancelled job never gets a
  // finishedAt, so its elapsed time grows forever and its change set is
  // recomputed against edits that have nothing to do with it.
  const isTerminal = status === "completed" || status === "failed" || status === "cancelled";
  const finishedAt = isTerminal ? (job.finishedAt ?? new Date().toISOString()) : null;

  return updateJob(job, { status, finishedAt, result: collected, changes });
}

export function renderResult(job) {
  const lines = [];

  lines.push(heading(`Job ${job.id}  [${job.status}]`));
  lines.push(
    keyValue([
      ["model", job.qualified ?? `${job.alias}.${job.route}`],
      ["agent", `${job.agent} (${job.access})`],
      ["workspace", job.workspaceRoot],
      ["session", job.sessionID ?? "none"],
      ["elapsed", describeElapsed(job)],
      ...(job.result?.cost != null ? [["cost", `$${Number(job.result.cost).toFixed(4)}`]] : []),
      ...(job.result?.tokens
        ? [["tokens", `${job.result.tokens.input ?? 0} in / ${job.result.tokens.output ?? 0} out`]]
        : [])
    ])
  );

  if (job.error) {
    lines.push(heading("Failure"));
    lines.push(job.error);
  }

  // Changes first: this is the part that is verified rather than claimed.
  lines.push(heading("Files changed (from git, not from the agent)"));
  if (!job.baseline) {
    lines.push("  Read-only delegation. No baseline was taken and no changes are expected.");
  } else if (!job.changes) {
    lines.push("  Could not be determined.");
  } else if (job.changes.changed.length === 0) {
    lines.push("  Nothing changed.");
  } else {
    for (const entry of job.changes.changed) {
      lines.push(bullet(`${entry.code.trim().padEnd(2)} ${entry.path}  (${entry.reason})`));
    }
    if (job.changes.stat) {
      lines.push("");
      lines.push(
        job.changes.stat
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n")
      );
    }
    if (job.changes.headMoved) {
      lines.push("");
      lines.push(bullet(`HEAD moved from ${job.changes.headBefore} to ${job.changes.headAfter}`));
      for (const commit of job.changes.committedSinceBaseline) {
        lines.push(bullet(commit, 6));
      }
    }
  }

  const children = job.result?.children ?? [];
  if (children.length > 0) {
    lines.push(heading("Child agents (from the server, not from the agent)"));
    for (const child of children) {
      lines.push(bullet(`${child.agent}  ${child.id}  ${child.title}`));
    }
  }

  const pending = job.result?.pendingPermissions ?? [];
  if (pending.length > 0) {
    lines.push(heading("Waiting for permission"));
    for (const request of pending) {
      lines.push(bullet(`${request.id}  ${request.action}`));
      for (const resource of request.resources ?? []) {
        lines.push(bullet(resource, 6));
      }
    }
    lines.push("");
    lines.push(`Answer with: /external-agents:permit ${job.id} <request-id> allow|reject`);
  }

  for (const warning of job.result?.warnings ?? []) {
    lines.push(heading("Warning"));
    lines.push(`  ${warning}`);
  }

  lines.push(heading("What the agent said"));
  lines.push(
    job.result?.finalText
      ? untrustedBlock(job.qualified ?? job.alias, job.result.finalText)
      : "  No final response was produced."
  );

  return lines.join("\n");
}
