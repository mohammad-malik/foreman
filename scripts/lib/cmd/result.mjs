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
 * labelled so it cannot be mistaken for part of this tool's own output. That
 * goes for the small things too: a permission request's command string, a
 * child session's title, an error a provider relayed. None of it is printed
 * bare.
 */

import { diffAgainstBaseline, diffStat } from "../git-baseline.mjs";
import { isStalled, judgeCodexJob, readCodexJob } from "../codex-job.mjs";
import { finalAssistantText, OpencodeApi, toolCalls, turnStateFrom, usageTotals } from "../opencode-api.mjs";
import { currentServer, touch } from "../servers.mjs";
import {
  describeElapsed,
  loadJob,
  markAwaiting,
  markPolled,
  TERMINAL_STATUSES,
  updateJob
} from "../jobs.mjs";
import { listWorkspaces } from "../registry.mjs";
import { bullet, heading, keyValue, oneLine, untrustedBlock, untrustedInline } from "../render.mjs";

function workspaceFor(slug) {
  return listWorkspaces().find((entry) => entry.slug === slug) ?? null;
}

/**
 * Whether the change set may be computed now.
 *
 * Once a job is finished its change set is frozen. Recomputing later would
 * report the state of the tree now, not what the job did: revert a job and it
 * would retroactively claim to have changed nothing, which is exactly backwards.
 *
 * And while a cancel is letting the interrupted tool call finish its write,
 * nobody else may compute one either, or the first collector to run freezes a
 * diff missing that write and the complete one is refused.
 */
function mayComputeChanges(job) {
  if (!job.baseline) {
    return false;
  }
  if (job.finishedAt && job.changes) {
    return false;
  }
  if (job.settlingUntil && Date.now() < Date.parse(job.settlingUntil)) {
    return false;
  }
  return true;
}

/**
 * Bring a job record up to date from the server, then persist it.
 *
 * Safe to call repeatedly, and safe to call after the server is gone: what was
 * already collected stays in the record.
 */
export async function collectResult(slug, jobID, { timeout } = {}) {
  // Reassigned below when the job is stamped as awaiting a permission, so the
  // rest of this function works from the updated record rather than a stale one.
  let job = loadJob(slug, jobID);
  if (!job) {
    throw new Error(`No job ${jobID} in this workspace.`);
  }

  if (job.backend === "codex") {
    return collectCodexResult(job);
  }

  const workspace = workspaceFor(slug);
  let server = workspace ? currentServer(workspace) : null;

  // The server that is running is not necessarily the one this job's session
  // lived on. Asking a replacement server about a dead session gets a 404 and
  // a warning, which read as "still running" forever. Reconciliation fails the
  // job; here it is simply treated as having no server.
  let replaced = false;
  if (server && job.serverUrl && server.url !== job.serverUrl) {
    replaced = true;
    server = null;
  }

  // Whether the agent's current turn is actually over, as opposed to a
  // message that merely has some text in it so far, and if so whether it
  // ended well.
  let turn = { state: "working", error: null };

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
    // Reaching the server is activity. touch() was only called from the
    // foreground polling loop, and a --background job has no poller, so idle
    // time was measured from dispatch: a 20 minute background job had its
    // server reaped in the same sweep that noticed the job had finished.
    touch(slug);

    const api = new OpencodeApi(server, { timeout });

    try {
      // One transcript fetch serves the answer, the tool list, the usage
      // totals and the turn state. It used to be fetched twice per poll.
      const messages = await api.messages(job.sessionID);
      turn = turnStateFrom(messages);
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
          agent: oneLine(entry.agent ?? "unknown", 60),
          title: oneLine(entry.title ?? "", 200),
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
      replaced
        ? "The OpenCode server this job ran on was replaced, so this is the last state that was recorded."
        : "The OpenCode server for this workspace is no longer running, so this is the last state that was recorded."
    );
    // Nothing can advance without a server, so whatever was captured before it
    // stopped is final. Reconciliation decides whether that counts as failure.
    turn = { state: collected.finalText ? "idle" : "working", error: null };
  }

  let changes = job.changes ?? null;

  if (mayComputeChanges(job)) {
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
  let error = job.error ?? null;

  if (collected.pendingPermissions.length > 0) {
    // Stamp the wait so the budget stops running. Idempotent, so repeated
    // polling does not keep resetting it.
    job = markAwaiting(job);
    status = "awaiting_permission";
  } else if (status === "running" || status === "queued" || status === "awaiting_permission") {
    // Nothing is blocked, so this is a clean poll: record it as the bound for
    // any future wait. See markAwaiting.
    if (server) {
      job = markPolled(job);
    }
    // The turn must actually be finished. An assistant message still streaming
    // already has partial text, and settling on it would freeze an incomplete
    // change set and drop the job out of active-server protection while the
    // agent is still editing. And a finished turn is only a success when it
    // finished cleanly: a provider error or a length cut-off is a failure with
    // the reason attached, not a completion with whatever text came before.
    if (turn.state !== "idle") {
      status = "running";
    } else if (turn.error) {
      status = "failed";
      error = turn.error;
    } else {
      status = "completed";
    }
  }

  // Cancelled belongs here too. Without it a cancelled job never gets a
  // finishedAt, so its elapsed time grows forever and its change set is
  // recomputed against edits that have nothing to do with it.
  const isTerminal = TERMINAL_STATUSES.has(status);
  const finishedAt = isTerminal ? (job.finishedAt ?? new Date().toISOString()) : null;

  return updateJob(job, { status, finishedAt, error, result: collected, changes });
}

/**
 * Bring a Codex job up to date.
 *
 * Everything is read off disk, so this works while the job runs, after it
 * exits, and after a reboot. There is no server to be gone and no session to
 * expire: the event log either has the run in it or it does not.
 */
function collectCodexResult(job) {
  const state = readCodexJob(job);
  const judged = judgeCodexJob(job, state);

  const collected = {
    finalText: state.finalText ?? job.result?.finalText ?? null,
    children: [],
    tools: state.parsed.tools,
    cost: null,
    tokens: state.parsed.tokens ?? job.result?.tokens ?? null,
    threadID: state.parsed.threadID ?? job.result?.threadID ?? null,
    pendingPermissions: [],
    warnings: []
  };

  if (state.stderr) {
    collected.warnings.push(`codex wrote to stderr: ${untrustedInline(state.stderr, { max: 500, label: "codex stderr" })}`);
  }

  if (state.alive && state.silent) {
    collected.warnings.push(
      isStalled(job, state)
        ? "codex has produced no output at all and is being treated as stuck, not busy."
        : "codex has produced no output yet. A working run says something within seconds, so if this persists it is stuck rather than thinking."
    );
  }

  // A job the user already cancelled, or one reconciliation already failed,
  // keeps that verdict. Only a still-active record takes the process's word.
  const status = TERMINAL_STATUSES.has(job.status) ? job.status : judged.status;
  const isTerminal = TERMINAL_STATUSES.has(status);

  let changes = job.changes ?? null;

  if (mayComputeChanges(job)) {
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

  return updateJob(job, {
    status,
    finishedAt: isTerminal ? (job.finishedAt ?? new Date().toISOString()) : null,
    error: job.error ?? judged.error,
    result: collected,
    changes
  });
}

export function renderResult(job) {
  const lines = [];

  lines.push(heading(`Job ${job.id}  [${job.status}]`));
  lines.push(
    keyValue([
      ["model", job.qualified ?? `${job.alias}.${job.route}`],
      ["agent", `${job.agent} (${job.access})`],
      ["workspace", job.workspaceRoot],
      ...(job.backend === "codex"
        ? [
            ["sandbox", job.sandbox ?? "unknown"],
            // The thread id is what `codex resume` takes, so it is the one
            // handle worth printing: the whole run can be reopened with it.
            ["thread", job.result?.threadID ?? "not started"]
          ]
        : [["session", job.sessionID ?? "none"]]),
      ["elapsed", describeElapsed(job)],
      ...(job.result?.cost != null ? [["cost", `$${Number(job.result.cost).toFixed(4)}`]] : []),
      ...(job.result?.tokens
        ? [["tokens", `${job.result.tokens.input ?? 0} in / ${job.result.tokens.output ?? 0} out`]]
        : [])
    ])
  );

  if (job.error) {
    lines.push(heading("Failure"));
    // Provider and model errors are relayed text, so they are quoted rather
    // than printed as though this tool had said them.
    lines.push(`  ${untrustedInline(job.error, { max: 600, label: "reported error" })}`);
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
      lines.push(bullet(`${child.agent}  ${child.id}  ${untrustedInline(child.title, { max: 200, label: "title" })}`));
    }
  }

  const pending = job.result?.pendingPermissions ?? [];
  if (pending.length > 0) {
    lines.push(heading("Waiting for permission"));
    for (const request of pending) {
      lines.push(bullet(`${request.id}  ${oneLine(request.action ?? request.type ?? "unknown", 60)}`));
      // The resource is the agent's own command string or path. It is what the
      // user is being asked to approve, so it must be shown, but it is model
      // output and is quoted as such.
      for (const resource of request.resources ?? []) {
        lines.push(bullet(untrustedInline(resource, { max: 400, label: "requested" }), 6));
      }
    }
    lines.push("");
    lines.push(`Approve with:  /external-agents:permit allow`);
    lines.push(`Or reject it:  /external-agents:permit reject`);
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
