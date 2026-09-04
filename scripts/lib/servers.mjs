/**
 * One OpenCode server per registered workspace.
 *
 * Three constraints shape this file.
 *
 * Servers outlive the session. Work dispatched to an external model should not
 * die because you closed the terminal, so servers are spawned detached and
 * unref'd. Nothing holds a handle to them afterwards.
 *
 * That means no resident supervisor. There is no process left alive to run an
 * idle timer, so lifecycle is enforced opportunistically: every runtime
 * invocation sweeps, and a server that is dead, unhealthy or idle past its TTL
 * gets cleaned up by whoever notices first.
 *
 * Concurrent sessions race. Two Claude sessions in the same repo will both try
 * to start a server. The lock file is created with O_EXCL so exactly one wins
 * and the loser waits for the winner's server instead of starting a second.
 *
 * Servers are authenticated. `opencode serve` has no auth flag, so this looked
 * at first like an unavoidable hole: a loopback port any local process could
 * drive. It turns out the server reads OPENCODE_SERVER_PASSWORD and enforces
 * HTTP Basic when it is set, printing an explicit warning when it is not. A
 * fresh 32-byte password is generated per server, because leaving a
 * write-capable agent pointed at your repository open to every process on the
 * machine is not acceptable.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isAlive, processCommandLine, terminateProcessTree } from "./process.mjs";
import { credentialEnv } from "./credentials.mjs";
import { opencodeBinary, OpencodeError } from "./opencode.mjs";
import { readJsonIfPresent, stateRoot, workspaceStateDir } from "./state.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const IDLE_TTL_MS = 15 * 60 * 1000;
const START_TIMEOUT_MS = 45_000;
const STARTING_LOCK_STALE_MS = 90_000;
const HEALTH_TIMEOUT_MS = 5_000;

function lockFile(slug) {
  return path.join(workspaceStateDir(slug), "server.lock");
}

/**
 * Kept for diagnosis. Usually empty: the PATH entry for OpenCode is a shim
 * that re-execs the real binary, and its output does not reach an inherited
 * descriptor under a detached spawn. Startup detection does not depend on it.
 */
function logFile(slug) {
  return path.join(workspaceStateDir(slug), "server.log");
}

function readLock(slug) {
  return readJsonIfPresent(lockFile(slug));
}

/**
 * Write the lock with owner-only permissions. It carries the server password,
 * so it must not be world readable. On Windows the mode bits only control the
 * read-only attribute, and the real protection is that state lives under a
 * per-user directory.
 */
function writeLock(slug, value) {
  const file = lockFile(slug);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

function clearLock(slug) {
  try {
    fs.unlinkSync(lockFile(slug));
  } catch {
    // Already gone, which is the state we wanted.
  }
}

/**
 * Claim the right to start a server. Returns false when someone else holds a
 * fresh claim, in which case the caller waits for their server rather than
 * starting a competing one.
 */
function claimStart(slug, workspaceRoot) {
  const file = lockFile(slug);
  const claim = {
    status: "starting",
    owner: process.pid,
    workspaceRoot,
    startedAt: new Date().toISOString()
  };

  try {
    // "wx" fails when the file exists. This is the whole concurrency control.
    fs.writeFileSync(file, `${JSON.stringify(claim, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }

  const existing = readLock(slug);
  if (!existing) {
    // Raced with a delete. Let the caller retry from the top.
    return false;
  }

  const stale =
    existing.status === "starting" &&
    (!isAlive(existing.owner) ||
      Date.now() - Date.parse(existing.startedAt ?? 0) > STARTING_LOCK_STALE_MS);

  if (stale) {
    clearLock(slug);
    return claimStart(slug, workspaceRoot);
  }

  return false;
}

/**
 * Build a plugin-owned OpenCode config directory and return its path.
 *
 * The mechanism matters here. `OPENCODE_CONFIG_CONTENT` and `OPENCODE_CONFIG`
 * are both ignored by OpenCode 1.18.16; the one that works is
 * `OPENCODE_CONFIG_DIR`, verified by reading `/config` back off a running
 * server. But it *replaces* the user's config rather than merging with it, so
 * anything they had set would silently stop applying to our servers.
 *
 * The fix is to do the merge here: read their global config, layer our agents
 * and depth limit on top, and write the result to a directory we own. Their
 * files are never modified, and their settings keep working. Credentials are
 * unaffected either way, since auth lives outside the config directory.
 */
export function pluginConfigDir() {
  const file = path.resolve(HERE, "..", "..", "config", "opencode-agents.json");
  const ours = JSON.parse(fs.readFileSync(file, "utf8"));
  const theirs = readUserOpencodeConfig();

  const merged = {
    ...theirs,
    ...ours,
    // Their agents survive; ours win on a name collision, because a workspace
    // pointed at "external-builder" must get the permissions we defined.
    agent: { ...(theirs.agent ?? {}), ...(ours.agent ?? {}) }
  };

  const dir = path.join(stateRoot(), "opencode-config");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "opencode.json"), `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return dir;
}

/**
 * The user's own global OpenCode config, if any. Comments are stripped because
 * the file is conventionally .jsonc and JSON.parse will not tolerate them.
 */
function readUserOpencodeConfig() {
  const candidates = [
    path.join(os.homedir(), ".config", "opencode", "opencode.jsonc"),
    path.join(os.homedir(), ".config", "opencode", "opencode.json")
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      const raw = fs
        .readFileSync(candidate, "utf8")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      const parsed = JSON.parse(raw);
      // Their $schema would point our generated file at the wrong thing.
      delete parsed.$schema;
      return parsed;
    } catch {
      // A config we cannot parse is not a reason to refuse to start. Ours
      // still applies; theirs is skipped, and doctor is where that shows up.
      return {};
    }
  }

  return {};
}

/** Ask the OS for a free port by binding to 0 and immediately releasing it. */
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * OpenCode checks both halves of the Basic credential. The username is fixed
 * at "opencode" and anything else is rejected even with the right password,
 * which is worth stating because the failure looks exactly like a wrong
 * password: a bare 401 with no explanation.
 */
export const AUTH_USERNAME = "opencode";

export function authHeader(password) {
  return `Basic ${Buffer.from(`${AUTH_USERNAME}:${password}`).toString("base64")}`;
}

export async function health(server, { timeout = HEALTH_TIMEOUT_MS } = {}) {
  try {
    const response = await fetch(`${server.url}/doc`, {
      headers: { authorization: authHeader(server.password) },
      signal: AbortSignal.timeout(timeout)
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * A running lock is only trustworthy if the PID is alive AND still looks like
 * the server we started. PIDs get recycled; without the second check a sweep
 * could eventually kill an unrelated process.
 */
function looksLikeOurServer(record) {
  if (!isAlive(record.pid)) {
    return false;
  }
  const commandLine = processCommandLine(record.pid);
  if (commandLine === null) {
    // Could not read it. Fall back to liveness rather than killing on a guess.
    return true;
  }
  return /opencode/i.test(commandLine) && /serve/i.test(commandLine);
}

/**
 * Wait until the server answers on the port we assigned it.
 *
 * The obvious approach, parsing "listening on http://..." out of the server's
 * own output, does not survive this setup: the OpenCode entry on PATH is a
 * shim that re-execs the real binary, and under a detached spawn its stdout
 * never reaches the inherited file descriptor. The log file stays empty even
 * though the server is up and serving.
 *
 * Polling the port sidesteps that entirely, and it is a better check anyway:
 * it proves the server is reachable and that our password works, rather than
 * proving it printed a hopeful message. This is only possible because we
 * choose the port ourselves.
 */
async function waitForServer(url, password, { pid, deadline }) {
  let lastStatus = "no response";

  for (;;) {
    if (!isAlive(pid)) {
      throw new OpencodeError(
        `OpenCode server exited during startup. Last check: ${lastStatus}.`,
        { code: "server_start_failed" }
      );
    }

    try {
      const response = await fetch(`${url}/doc`, {
        headers: { authorization: authHeader(password) },
        signal: AbortSignal.timeout(3000)
      });

      if (response.ok) {
        return;
      }

      lastStatus = `HTTP ${response.status}`;
      if (response.status === 401) {
        // The port is answering but rejecting our credential. Retrying will
        // not fix that, and it means someone else owns this port.
        throw new OpencodeError(
          `Something is already listening on ${url} and rejecting our credentials. It is not the server we started.`,
          { code: "server_port_conflict" }
        );
      }
    } catch (error) {
      if (error instanceof OpencodeError) {
        throw error;
      }
      lastStatus = error.message;
    }

    if (Date.now() > deadline) {
      throw new OpencodeError(
        `OpenCode server did not answer on ${url} within ${START_TIMEOUT_MS / 1000}s. Last check: ${lastStatus}.`,
        { code: "server_start_timeout" }
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function startServer(workspace) {
  const { slug, root } = workspace;
  const port = await pickFreePort();
  const password = randomBytes(32).toString("base64url");
  const log = logFile(slug);

  fs.writeFileSync(log, "", "utf8");
  const out = fs.openSync(log, "a");

  const childEnv = {
    ...process.env,
    // Provider keys. Without these the server resolves only the free tier and
    // every paid model fails with ModelUnavailableError. See credentials.mjs.
    ...credentialEnv(),
    OPENCODE_SERVER_PASSWORD: password,
    // Points at a directory we generate and own. See pluginConfigDir.
    OPENCODE_CONFIG_DIR: pluginConfigDir()
  };
  // Do not let another plugin's exported value follow us in. Deleting the key
  // is not the same as setting it to undefined, which Node would pass through
  // as the literal string "undefined".
  delete childEnv.CLAUDE_PLUGIN_DATA;

  // Deliberately NOT the repository. The OpenCode server drops native module
  // temp files (.<hex>-00000000.node) into its working directory, which would
  // leave every registered repo permanently dirty and break change
  // attribution. Sessions carry their own `location.directory`, so the server
  // does not need to sit in the repo to work on it.
  const scratch = path.join(stateRoot(), "server-cwd");
  fs.mkdirSync(scratch, { recursive: true });

  const child = spawn(
    opencodeBinary(),
    ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
    {
      cwd: scratch,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", out, out],
      env: childEnv
    }
  );

  child.unref();
  fs.closeSync(out);

  const url = `http://127.0.0.1:${port}`;

  try {
    await waitForServer(url, password, { pid: child.pid, deadline: Date.now() + START_TIMEOUT_MS });
  } catch (error) {
    terminateProcessTree(child.pid, { force: true });
    clearLock(slug);
    throw error;
  }

  const record = {
    status: "running",
    pid: child.pid,
    url,
    port,
    password,
    workspaceRoot: root,
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString()
  };

  writeLock(slug, record);
  return record;
}

/** Record that a server is in use, so the idle sweep leaves it alone. */
export function touch(slug) {
  const record = readLock(slug);
  if (record?.status === "running") {
    writeLock(slug, { ...record, lastActivityAt: new Date().toISOString() });
  }
}

/**
 * Get a healthy server for this workspace, starting one if needed.
 * Safe to call concurrently from separate sessions.
 */
const ACQUIRE_RETRY_MS = 500;
// The waiting session must be patient for at least as long as the winning one
// is allowed to take. Giving up sooner turns an ordinary cold start into a
// spurious failure in whichever session happened to arrive second.
const MAX_ACQUIRE_ATTEMPTS = Math.ceil(START_TIMEOUT_MS / ACQUIRE_RETRY_MS) + 4;

export async function acquireServer(workspace, { attempt = 0 } = {}) {
  const { slug, root } = workspace;

  if (attempt > MAX_ACQUIRE_ATTEMPTS) {
    throw new OpencodeError(
      `Gave up after ${Math.round((MAX_ACQUIRE_ATTEMPTS * ACQUIRE_RETRY_MS) / 1000)}s waiting for another session's OpenCode server to finish starting.`,
      { code: "server_acquire_timeout" }
    );
  }

  const existing = readLock(slug);

  if (existing?.status === "running") {
    if (looksLikeOurServer(existing) && (await health(existing))) {
      touch(slug);
      return existing;
    }
    // Dead, replaced, or not answering. Reclaim it.
    await stopServer(workspace, { reason: "unhealthy" });
  }

  if (!claimStart(slug, root)) {
    await new Promise((resolve) => setTimeout(resolve, ACQUIRE_RETRY_MS));
    return acquireServer(workspace, { attempt: attempt + 1 });
  }

  return startServer(workspace);
}

export async function stopServer(workspace, { reason = "requested" } = {}) {
  const { slug } = workspace;
  const record = readLock(slug);

  if (!record) {
    return { stopped: false, reason: "no server recorded" };
  }

  if (record.status === "running" && record.pid) {
    if (looksLikeOurServer(record)) {
      terminateProcessTree(record.pid, { force: true });
      clearLock(slug);
      return { stopped: true, pid: record.pid, reason };
    }
    // The PID belongs to something else now. Drop the stale record and leave
    // whatever owns that number alone.
    clearLock(slug);
    return { stopped: false, reason: "stale record, pid reused" };
  }

  clearLock(slug);
  return { stopped: false, reason: "cleared a partial start record" };
}

/**
 * The running server record, or null.
 *
 * Reading a result must not resurrect a server that was swept while the job
 * was finishing, so this looks without starting anything. Callers that find
 * null report what they stored rather than pretending the session is still
 * reachable.
 */
export function currentServer(workspace) {
  const record = readLock(workspace.slug);
  return record?.status === "running" && isAlive(record.pid) ? record : null;
}

export function serverStatus(workspace) {
  const record = readLock(workspace.slug);

  if (!record) {
    return { state: "stopped" };
  }
  if (record.status === "starting") {
    return { state: "starting", since: record.startedAt, owner: record.owner };
  }
  if (!isAlive(record.pid)) {
    return { state: "orphaned-record", pid: record.pid, url: record.url };
  }

  const idleMs = Date.now() - Date.parse(record.lastActivityAt ?? record.startedAt);
  return {
    state: "running",
    pid: record.pid,
    url: record.url,
    startedAt: record.startedAt,
    lastActivityAt: record.lastActivityAt,
    idleMs
  };
}

/**
 * Clean up every workspace's server. Called on every runtime invocation, which
 * is what replaces a resident idle timer.
 *
 * `hasRunningJobs` is injected rather than imported so this module stays
 * independent of the job store.
 */
export async function sweep(
  workspaces,
  { hasRunningJobs = () => false, isOurServer = looksLikeOurServer } = {}
) {
  const actions = [];

  for (const workspace of workspaces) {
    const record = readLock(workspace.slug);
    if (!record) {
      continue;
    }

    if (record.status === "starting") {
      const stale =
        !isAlive(record.owner) ||
        Date.now() - Date.parse(record.startedAt ?? 0) > STARTING_LOCK_STALE_MS;
      if (stale) {
        clearLock(workspace.slug);
        actions.push({ workspace: workspace.root, action: "cleared stale start claim" });
      }
      continue;
    }

    if (!isOurServer(record)) {
      clearLock(workspace.slug);
      actions.push({ workspace: workspace.root, action: "cleared record for a dead server" });
      continue;
    }

    if (hasRunningJobs(workspace)) {
      continue;
    }

    const idleMs = Date.now() - Date.parse(record.lastActivityAt ?? record.startedAt ?? 0);
    if (idleMs > IDLE_TTL_MS) {
      terminateProcessTree(record.pid, { force: true });
      clearLock(workspace.slug);
      actions.push({
        workspace: workspace.root,
        action: `stopped idle server (${Math.round(idleMs / 60000)}m without work)`
      });
    }
  }

  return actions;
}
