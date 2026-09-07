/**
 * Dispatch one handoff to one external model.
 *
 * The gate on this is the slash command: `/foreman:delegate` carries
 * `disable-model-invocation: true`, so Claude cannot trigger a delegation on
 * its own initiative. If the runtime is ever reached another way, the Bash
 * approval shows the literal command including the model and the write flag,
 * so the dispatch is still visible before it happens. Nothing here infers
 * write access; it is always stated.
 */

import { listWorkspaces, requireWorkspaceFor } from "../registry.mjs";
import { reconcileAll } from "../reconcile.mjs";
import { acquireServer, sweep, touch } from "../servers.mjs";
import { detectVersion, loadInventory } from "../opencode.mjs";
import { codexModels, detectCodexVersion, codexSignedIn } from "../codex.mjs";
import { judgeCodexJob, readCodexJob, startCodexJob } from "../codex-job.mjs";
import { resolveRoute } from "../routes.mjs";
import { OpencodeApi } from "../opencode-api.mjs";
import { captureBaseline, describeDirty, isGitRepository } from "../git-baseline.mjs";
import { checkNamedPaths } from "../handoff-paths.mjs";
import {
  activeJobs,
  createJob,
  hasActiveJobs,
  markAwaiting,
  markPolled,
  markReported,
  TERMINAL_STATUSES,
  updateJob
} from "../jobs.mjs";
import { bullet, keyValue } from "../render.mjs";
import { currentSessionID } from "./notify.mjs";
import { collectResult, renderResult } from "./result.mjs";

export const ROLES = {
  builder: { agent: "external-builder", needsWrite: true },
  fixer: { agent: "external-builder", needsWrite: true },
  researcher: { agent: "external-researcher", needsWrite: false }
};

/**
 * The unattended variant of a write-capable role.
 *
 * Its bash catch-all is allow rather than ask, so the agent never blocks on a
 * person. That is the whole benefit and the whole cost: `external_directory`
 * does not gate bash, so an unattended agent can read and write outside the
 * repository. It is opt-in per delegation for that reason, never a default.
 */
const UNATTENDED_AGENT = "external-autonomous";

const DEFAULT_WAIT_MS = 120_000;
const MAX_WAIT_MS = 300_000;
// Measured, not guessed. A real write task on the Zen route managed 11 tool
// calls in 15 minutes, roughly 80 seconds per round trip, and was reaped by
// the old 15 minute default having read the right files but written nothing.
// Reading a handful of source files is the cheap part of a delegation; the
// budget exists to stop a runaway, not to cut off ordinary work.
const DEFAULT_BUDGET_MS = 45 * 60 * 1000;

function chooseAgent(role, write, unattended) {
  const spec = ROLES[role];
  if (!spec) {
    throw new Error(`Unknown role "${role}". Use one of: ${Object.keys(ROLES).join(", ")}.`);
  }
  if (spec.needsWrite && !write) {
    // Rather than silently downgrading a builder to a reader, say so. A
    // "builder" that cannot write would look like it did the work and changed
    // nothing, which is the most confusing possible outcome.
    return { agent: "external-researcher", downgraded: true };
  }
  if (!spec.needsWrite && write) {
    throw new Error(
      "Role \"researcher\" is read-only. Drop --write, or use --role builder if edits are intended."
    );
  }
  if (unattended) {
    return { agent: UNATTENDED_AGENT, downgraded: false, unattended: true };
  }

  return { agent: spec.agent, downgraded: false };
}

export async function delegate({
  task,
  model = "kimi",
  route = "standard",
  backend = null,
  role = "builder",
  write = false,
  directory,
  wait = true,
  timeoutSeconds,
  allowDirtyTree = false,
  unattended = false,
  budgetSeconds
}) {
  if (!task || task.trim() === "") {
    throw new Error("A task is required. Write the handoff you would give a subagent.");
  }

  if (unattended && !write) {
    throw new Error(
      "--unattended only applies to a write-capable role. A researcher already runs without interruption: its bash is denied outright rather than asked, so there is nothing to wait for."
    );
  }

  // An explicitly blank --dir ("" or whitespace-only) is the same as
  // omitting it: "" is not nullish, so `directory ?? process.cwd()` alone
  // would hand it to canonicalize, which throws on empty strings.
  const requested = typeof directory === "string" && directory.trim() === "" ? undefined : directory;
  const { workspace } = requireWorkspaceFor(requested ?? process.cwd(), { requireExternal: true });

  // Housekeeping first: this is what replaces a resident supervisor.
  const allWorkspaces = listWorkspaces();
  await reconcileAll(allWorkspaces);
  await sweep(allWorkspaces, { hasRunningJobs: hasActiveJobs });

  // Validated up front, and not because a NaN is untidy: `--timeout abc` made
  // the wait loop's deadline NaN, which never arrives, and `--budget abc`
  // switched the budget off entirely.
  for (const [name, value] of [["--timeout", timeoutSeconds], ["--budget", budgetSeconds]]) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new Error(`${name} must be a positive number of seconds, not "${value}".`);
    }
  }

  // Both backends' model lists, so resolution can verify whichever one ends up
  // running this. A backend that cannot be reached is omitted rather than
  // reported empty: omitted means unverified, empty would mean "offers
  // nothing" and would refuse every model on it.
  const inventories = {};
  try {
    const version = detectVersion();
    inventories.opencode = loadInventory({ version: version.version }).models;
  } catch (error) {
    // Fatal only if this job needs OpenCode, which resolveRoute decides below.
    inventories.opencodeError = error;
  }
  const codexList = codexModels();
  if (codexList) {
    inventories.codex = codexList;
  }

  const resolved = resolveRoute(model, route, {
    ...(inventories.opencode ? { opencode: inventories.opencode } : {}),
    ...(inventories.codex ? { codex: inventories.codex } : {})
  }, { backend });

  if (resolved.backend === "opencode" && inventories.opencodeError) {
    throw inventories.opencodeError;
  }

  const { agent, downgraded } = chooseAgent(role, write, unattended);

  // A handoff that names a file which is not there does not fail fast: the
  // agent hunts for it, improvises, and reports work against files it picked
  // itself twenty minutes later. For a read-only role a missing path is simply
  // wrong, since it cannot create anything, so the dispatch is refused. A
  // builder may legitimately name files it is about to create, so there it is
  // said out loud and the job proceeds.
  const paths = checkNamedPaths(workspace.root, task);
  if (paths.missing.length > 0 && !write) {
    throw new Error(
      [
        `The handoff names ${paths.missing.length} path(s) that do not exist in ${workspace.root}:`,
        ...paths.missing.map((entry) => `  ${entry}`),
        "",
        "A read-only agent cannot create them, so it would spend the job looking for files that are not there. Fix the paths, or use --role builder --write if they are meant to be created."
      ].join(String.fromCharCode(10))
    );
  }

  let baseline = null;
  if (write) {
    if (!isGitRepository(workspace.root)) {
      throw new Error(
        `${workspace.root} is not a git repository. Write delegation is refused because changes could not be attributed or reverted.`
      );
    }

    // Two write jobs in one tree cannot be told apart. Job B's baseline would
    // hash job A's half-written files, and everything A wrote afterwards would
    // land in B's change set as "modified again". The tree may still look
    // clean at this moment if A has not written yet, so this is checked on the
    // job records, not on git. --allow-dirty-tree already means "I accept mixed
    // attribution", so it is the override here too.
    const otherWriters = activeJobs(workspace.slug).filter((job) => job.access === "write");
    if (otherWriters.length > 0 && !allowDirtyTree) {
      throw new Error(
        [
          `${otherWriters.length} write job(s) are already active in ${workspace.root}:`,
          ...otherWriters.map((job) => `  ${job.id}  ${job.qualified ?? job.alias}  ${job.status}`),
          "",
          "A second writer's edits could not be told from the first's. Wait for it, cancel it, use a separate worktree, or pass --allow-dirty-tree to accept mixed attribution."
        ].join("\n")
      );
    }

    baseline = captureBaseline(workspace.root);

    if (baseline.dirty && !allowDirtyTree) {
      throw new Error(
        [
          "The working tree has uncommitted changes, so the agent's edits could not be told apart from yours.",
          "",
          ...describeDirty(baseline).map((line) => `  ${line}`),
          "",
          "Commit or stash first, or pass --allow-dirty-tree to accept mixed attribution."
        ].join("\n")
      );
    }
  }

  if (resolved.backend === "codex") {
    return dispatchCodex({
      workspace,
      resolved,
      task,
      model,
      route,
      role,
      write,
      downgraded,
      unattended,
      baseline,
      missingPaths: paths.missing,
      wait,
      timeoutSeconds,
      budgetSeconds
    });
  }

  const server = await acquireServer(workspace);
  const api = new OpencodeApi(server);

  // The record exists before the session does. A queued job counts as active,
  // which is what stops another session's acquireServer from reclaiming this
  // server in the moment between creating the session and writing it down.
  let job = createJob(workspace, {
    task,
    alias: model,
    route,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    qualified: resolved.qualified,
    agent,
    role,
    access: write ? "write" : "read",
    serverUrl: server.url,
    baseline,
    budgetMs: budgetSeconds ? budgetSeconds * 1000 : DEFAULT_BUDGET_MS,
    dispatchSessionID: currentSessionID(),
    status: "queued"
  });

  let session;
  try {
    session = await api.createSession({
      agent,
      providerID: resolved.providerID,
      modelID: resolved.modelID,
      directory: workspace.root
    });
  } catch (error) {
    updateJob(job, { status: "failed", finishedAt: new Date().toISOString(), error: error.message });
    throw error;
  }

  job = updateJob(job, {
    sessionID: session.id,
    status: "running",
    startedAt: new Date().toISOString(),
    lastPolledAt: new Date().toISOString()
  });

  try {
    await api.prompt(session.id, task);
  } catch (error) {
    updateJob(job, { status: "failed", finishedAt: new Date().toISOString(), error: error.message });
    throw error;
  }

  touch(workspace.slug);

  const header = [
    `Dispatched ${job.id} to ${resolved.qualified}`,
    keyValue([
      ["workspace", workspace.root],
      ["agent", agent],
      ["access", write ? "write" : "read-only"],
      ["session", session.id]
    ])
  ];

  if (unattended) {
    header.push(
      bullet(
        "unattended: bash runs without asking, so this agent is NOT confined to the repository and may read or write outside it"
      )
    );
  }

  if (downgraded) {
    header.push(
      bullet(
        `role "${role}" implies edits but --write was not given, so this ran as external-researcher and cannot change files`
      )
    );
  }

  if (paths.missing.length > 0) {
    header.push(
      bullet(
        `the handoff names ${paths.missing.length} path(s) that do not exist yet: ${paths.missing.join(", ")}`
      )
    );
  }

  if (!wait) {
    header.push("");
    header.push(`Running in the background. It will be reported when it finishes, or run:`);
    header.push(bullet(`foreman result ${job.id}`));
    return header.join("\n");
  }

  const waitMs = Math.min(timeoutSeconds ? timeoutSeconds * 1000 : DEFAULT_WAIT_MS, MAX_WAIT_MS);
  const outcome = await waitForJob(api, job, waitMs);

  if (outcome === "timeout") {
    header.push("");
    header.push(
      `Still running after ${Math.round(waitMs / 1000)}s. It keeps going in the background; check with:`
    );
    header.push(bullet(`foreman result ${job.id}`));
    return header.join("\n");
  }

  const finished = await reportForeground(job);
  return [...header, "", renderResult(finished)].join("\n");
}

/**
 * Collect a foreground job's outcome and, if it is over, mark it reported.
 * Printing the result here IS the report; without the mark the Stop hook
 * announced the same job again one turn later.
 */
async function reportForeground(job) {
  const finished = await collectResult(job.slug, job.id);
  return TERMINAL_STATUSES.has(finished.status) && finished.reportedAt === null
    ? markReported(finished)
    : finished;
}

/**
 * Dispatch through the Codex CLI.
 *
 * Deliberately shorter than the OpenCode path, because there is less to go
 * wrong: one detached process, no server to acquire or reclaim, and no
 * permission channel. What the agent may touch is decided by the sandbox before
 * it starts rather than negotiated while it runs.
 *
 * Everything else is kept identical on purpose. The same job record, the same
 * git baseline, the same reporting, so `status`, `result`, `wait`, `revert` and
 * the Stop hook do not care which backend ran the work.
 */
async function dispatchCodex({
  workspace,
  resolved,
  task,
  model,
  route,
  role,
  write,
  downgraded,
  unattended,
  baseline,
  missingPaths = [],
  wait,
  timeoutSeconds,
  budgetSeconds
}) {
  if (unattended) {
    throw new Error(
      "--unattended does not apply to the codex backend. `codex exec` never pauses to ask, so there is nothing to run unattended; what it may touch is set by its sandbox instead."
    );
  }

  // Checked here rather than at resolution time, so a missing CLI is reported
  // as a missing CLI instead of as a job that failed for no stated reason.
  const version = detectCodexVersion();
  if (!codexSignedIn()) {
    throw new Error(
      "Codex has no stored credentials, so it cannot run. Sign in with `codex login` and try again."
    );
  }

  const job = createJob(workspace, {
    task,
    backend: "codex",
    alias: model,
    route,
    providerID: null,
    modelID: resolved.modelID,
    qualified: resolved.qualified,
    agent: "codex-exec",
    role,
    access: write ? "write" : "read",
    codexVersion: version.raw,
    baseline,
    budgetMs: budgetSeconds ? budgetSeconds * 1000 : DEFAULT_BUDGET_MS,
    dispatchSessionID: currentSessionID(),
    status: "running",
    startedAt: new Date().toISOString()
  });

  let started;
  try {
    started = startCodexJob({
      slug: workspace.slug,
      jobID: job.id,
      model: resolved.modelID,
      root: workspace.root,
      task,
      write
    });
  } catch (error) {
    updateJob(job, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: `Could not start codex: ${error.message}`
    });
    throw error;
  }

  const running = updateJob(job, {
    pid: started.pid,
    sandbox: started.sandbox,
    logFile: started.logFile,
    errFile: started.errFile,
    messageFile: started.messageFile,
    taskFile: started.taskFile
  });

  const header = [
    `Dispatched ${running.id} to ${resolved.qualified}`,
    keyValue([
      ["workspace", workspace.root],
      ["backend", `codex ${version.version ?? ""}`.trim()],
      ["sandbox", started.sandbox],
      ["access", write ? "write" : "read-only"],
      ["pid", String(started.pid)]
    ])
  ];

  if (downgraded) {
    header.push(
      bullet(
        `role "${role}" implies edits but --write was not given, so this runs in a read-only sandbox and cannot change files`
      )
    );
  }

  if (missingPaths.length > 0) {
    header.push(
      bullet(`the handoff names ${missingPaths.length} path(s) that do not exist yet: ${missingPaths.join(", ")}`)
    );
  }

  if (!wait) {
    header.push("");
    header.push("Running in the background. It will be reported when it finishes, or run:");
    header.push(bullet(`foreman result ${running.id}`));
    return header.join("\n");
  }

  const waitMs = Math.min(timeoutSeconds ? timeoutSeconds * 1000 : DEFAULT_WAIT_MS, MAX_WAIT_MS);
  const finishedInTime = await waitForCodex(running, waitMs);

  if (!finishedInTime) {
    header.push("");
    header.push(
      `Still running after ${Math.round(waitMs / 1000)}s. It keeps going in the background; check with:`
    );
    header.push(bullet(`foreman result ${running.id}`));
    return header.join("\n");
  }

  const finished = await reportForeground(running);
  return [...header, "", renderResult(finished)].join("\n");
}

/**
 * Wait for the Codex process to exit.
 *
 * Liveness is the signal, not the log: a `turn.completed` event means the model
 * finished its turn, while the process may still be flushing. Polling is slower
 * than on the OpenCode path because there is no permission request that might
 * need surfacing early.
 *
 * Judged, not merely pinged. Windows hands a freed pid to the next process
 * within seconds when other agents are spawning shells, and a bare liveness
 * check then waited the full five minutes on a stranger's process. judgeCodexJob
 * confirms the identity of a live pid once the turn is over.
 */
async function waitForCodex(job, waitMs) {
  const deadline = Date.now() + waitMs;

  for (;;) {
    const state = readCodexJob(job);
    if (!state.alive || judgeCodexJob(job, state).status !== "running") {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/**
 * Wait for the session to finish its turn, surfacing a permission request as
 * soon as one appears rather than sitting on it until the timeout expires.
 *
 * Polling rather than blocking on `/wait`, which is not implemented in 1.18.16.
 * The interval starts tight so short tasks feel immediate, then backs off so a
 * long one is not hammering the server for minutes.
 */
async function waitForJob(api, job, waitMs) {
  const deadline = Date.now() + waitMs;
  let interval = 1000;

  for (;;) {
    const pending = await api.pendingPermissions(job.sessionID).catch(() => []);
    if (Array.isArray(pending) && pending.length > 0) {
      // Stamped through markAwaiting, so the budget clock stops here and now.
      // A bare status write left awaitingSince unset, and when the wait was
      // eventually stamped by a later poll it was credited from that poll
      // rather than from this moment, which failed a blocked job as a runaway.
      markAwaiting(job);
      return "permission";
    }

    const turn = await api.turnState(job.sessionID).catch(() => ({ state: "working" }));
    if (turn.state === "idle") {
      return "finished";
    }

    if (Date.now() >= deadline) {
      return "timeout";
    }

    // A clean poll: the job was seen working now, which is the bound any later
    // permission wait is credited from.
    markPolled(job);
    touch(job.slug);
    await new Promise((resolve) => setTimeout(resolve, interval));
    interval = Math.min(interval * 1.4, 5000);
  }
}
