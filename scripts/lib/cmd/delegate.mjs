/**
 * Dispatch one handoff to one external model.
 *
 * The gate on this is the slash command: `/external-agents:delegate` carries
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
import { resolveRoute } from "../routes.mjs";
import { OpencodeApi } from "../opencode-api.mjs";
import { captureBaseline, describeDirty, isGitRepository } from "../git-baseline.mjs";
import { createJob, hasActiveJobs, updateJob } from "../jobs.mjs";
import { bullet, heading, keyValue } from "../render.mjs";
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
const DEFAULT_BUDGET_MS = 15 * 60 * 1000;

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

  const { workspace } = requireWorkspaceFor(directory ?? process.cwd(), { requireExternal: true });

  // Housekeeping first: this is what replaces a resident supervisor.
  const allWorkspaces = listWorkspaces();
  reconcileAll(allWorkspaces);
  await sweep(allWorkspaces, { hasRunningJobs: hasActiveJobs });

  const version = detectVersion();
  const inventory = loadInventory({ version: version.version });
  const resolved = resolveRoute(model, route, inventory.models);
  const { agent, downgraded } = chooseAgent(role, write, unattended);

  let baseline = null;
  if (write) {
    if (!isGitRepository(workspace.root)) {
      throw new Error(
        `${workspace.root} is not a git repository. Write delegation is refused because changes could not be attributed or reverted.`
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

  const server = await acquireServer(workspace);
  const api = new OpencodeApi(server);

  const session = await api.createSession({
    agent,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    directory: workspace.root
  });

  const job = createJob(workspace, {
    task,
    alias: model,
    route,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    qualified: resolved.qualified,
    agent,
    role,
    access: write ? "write" : "read",
    sessionID: session.id,
    serverUrl: server.url,
    baseline,
    budgetMs: budgetSeconds ? budgetSeconds * 1000 : DEFAULT_BUDGET_MS,
    status: "running",
    startedAt: new Date().toISOString()
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

  if (!wait) {
    header.push("");
    header.push(`Running in the background. It will be reported when it finishes, or run:`);
    header.push(bullet(`external-agents result ${job.id}`));
    return header.join("\n");
  }

  const waitMs = Math.min(timeoutSeconds ? timeoutSeconds * 1000 : DEFAULT_WAIT_MS, MAX_WAIT_MS);
  const outcome = await waitForJob(api, job, waitMs);

  if (outcome === "timeout") {
    header.push("");
    header.push(
      `Still running after ${Math.round(waitMs / 1000)}s. It keeps going in the background; check with:`
    );
    header.push(bullet(`external-agents result ${job.id}`));
    return header.join("\n");
  }

  const finished = await collectResult(job.slug, job.id);
  return [...header, "", renderResult(finished)].join("\n");
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
      updateJob(job, { status: "awaiting_permission" });
      return "permission";
    }

    const turn = await api.turnState(job.sessionID).catch(() => ({ state: "working" }));
    if (turn.state === "idle") {
      return "finished";
    }

    if (Date.now() >= deadline) {
      return "timeout";
    }

    touch(job.slug);
    await new Promise((resolve) => setTimeout(resolve, interval));
    interval = Math.min(interval * 1.4, 5000);
  }
}
