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

import { spawnHiddenDetached } from "./hidden-spawn.mjs";
import {
  findPidsByCommandLine,
  isAlive,
  primeCommandLines,
  processCommandLine,
  terminateProcessTree
} from "./process.mjs";
import { credentialEnv } from "./credentials.mjs";
import { opencodeBinary, OpencodeError } from "./opencode.mjs";
import { hasActiveJobs } from "./jobs.mjs";
import { readJsonIfPresent, renameWithRetry, stateRoot, workspaceStateDir } from "./state.mjs";

/** Compared by callers, so it is named rather than repeated as a string. */
export const ACTIVE_JOBS_REASON = "it still has active jobs";

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
  renameWithRetry(tmp, file);
}

function clearLock(slug) {
  try {
    fs.unlinkSync(lockFile(slug));
  } catch {
    // Already gone, which is the state we wanted.
  }
}

/**
 * Move an unparseable lock aside, but only if it has not changed since we read
 * it.
 *
 * The check matters. A blind unlink of a torn lock can delete a complete claim
 * that another process wrote between our read and our delete, and then both
 * processes start a server for the same workspace: one wins the record and the
 * other runs forever with nothing referencing it. That is the orphaned
 * write-capable server this file works hardest to avoid.
 *
 * Renamed rather than deleted, so a corrupt lock survives for diagnosis
 * instead of vanishing.
 */
function quarantineIfUnchanged(slug) {
  const file = lockFile(slug);

  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return; // Gone already.
  }

  // Still unreadable? Then it is the corrupt file we saw, not a fresh claim.
  try {
    JSON.parse(raw);
    return; // Someone wrote a valid claim in the gap. Leave it alone.
  } catch {
    // Corrupt, as expected.
  }

  try {
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
  } catch {
    // Lost the race to whoever else is cleaning up. Fine either way.
  }
}

/**
 * Claim the right to start a server. Returns false when someone else holds a
 * fresh claim, in which case the caller waits for their server rather than
 * starting a competing one.
 */
function claimStart(slug, workspaceRoot, attempt = 0) {
  // Bounded: the corrupt-lock and stale-claim paths both recurse, and a disk
  // that keeps producing unreadable locks should surface as a failure rather
  // than a spin.
  if (attempt > 3) {
    return false;
  }
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
    // The file exists but did not parse. That is corrupt state, not a delete
    // race: a crash between the O_EXCL write and the running record leaves a
    // truncated lock, and treating it as transient bricked the workspace
    // permanently. Every acquire then burned the full retry window and failed
    // blaming "another session", while `servers` reported "stopped" and no
    // command pointed at the file.
    //
    // O_EXCL is the concurrency control, so the write cannot be atomic. Clearing
    // an unparseable lock is the only way out, and it is safe: a real running
    // server would have a readable record.
    // Remove it only if it is still the same unreadable bytes. An
    // unconditional unlink here could delete a complete claim another process
    // wrote in the gap between our read and our delete, and then both of us
    // would start a server for one workspace, leaving one of them orphaned
    // with no record anywhere. Rename-aside rather than unlink, so the
    // evidence survives for diagnosis.
    quarantineIfUnchanged(slug);
    return claimStart(slug, workspaceRoot, attempt + 1);
  }

  const stale =
    existing.status === "starting" &&
    (!isAlive(existing.owner) ||
      Date.now() - Date.parse(existing.startedAt ?? 0) > STARTING_LOCK_STALE_MS);

  if (stale) {
    clearLock(slug);
    return claimStart(slug, workspaceRoot, attempt + 1);
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
 * The fix is to do the merge here: read their global config, carry over the
 * parts that describe how to REACH models, layer our agents and depth limit on
 * top, and write the result to a directory we own. Their files are never
 * modified. Credentials are unaffected either way, since auth lives outside
 * the config directory.
 *
 * Only an allowlist of their keys comes across. The whole file used to, and
 * that loaded their MCP servers and plugins into a server driven by an
 * external model: tools that `external_directory: deny` does not gate, reaching
 * wherever the user had pointed them. `share` could have published transcripts.
 * Provider definitions, model defaults, formatters and LSP settings are what a
 * spawned server legitimately needs from the user, and nothing else is copied.
 *
 * One directory per workspace, written atomically. A single shared file was
 * rewritten in place by every server start, so two starting at once could hand
 * OpenCode a torn file, and this file is what denies bash to the researcher.
 */
const USER_CONFIG_KEYS_CARRIED = new Set([
  "provider",
  "disabled_providers",
  "enabled_providers",
  "model",
  "small_model",
  "formatter",
  "lsp",
  "compaction",
  "snapshot"
]);

export function pluginConfigDir(slug = "shared") {
  const file = path.resolve(HERE, "..", "..", "config", "opencode-agents.json");
  const ours = JSON.parse(fs.readFileSync(file, "utf8"));
  const theirs = readUserOpencodeConfig().config;

  const carried = {};
  for (const key of Object.keys(theirs)) {
    if (USER_CONFIG_KEYS_CARRIED.has(key)) {
      carried[key] = theirs[key];
    }
  }

  const merged = { ...carried, ...ours };

  const dir = path.join(stateRoot(), "opencode-config", slug);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "opencode.json");
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  renameWithRetry(tmp, target);
  return dir;
}

/**
 * Strip // and block comments from JSONC without touching string contents.
 *
 * The regex version ate `/*` inside strings, so a permission glob like
 * "src/*" or "**\/*.pem" (which every OpenCode config has) corrupted the text,
 * JSON.parse failed, and the user's config was silently dropped.
 */
export function stripJsonComments(text) {
  let out = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];

    if (ch === '"') {
      // Copy the whole string literal, honouring escapes.
      let j = i + 1;
      while (j < n && text[j] !== '"') {
        j += text[j] === "\\" ? 2 : 1;
      }
      out += text.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }

    if (ch === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") {
        i += 1;
      }
      continue;
    }

    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }

    // Trailing commas are tolerated by OpenCode's loader, so they are here
    // too. Handled inside the scanner, where a string literal has already been
    // copied whole: a regex over the finished text also rewrote ",]" inside a
    // value, which turned a valid API key into a different string.
    if (ch === "}" || ch === "]") {
      out = out.replace(/,\s*$/, "");
    }

    out += ch;
    i += 1;
  }

  return out;
}

/**
 * The user's own global OpenCode config, if any.
 *
 * Returns `{ file, config, error }` so doctor can say when the file exists but
 * could not be read, rather than the servers quietly running without it.
 */
export function readUserOpencodeConfig() {
  const candidates = [
    path.join(os.homedir(), ".config", "opencode", "opencode.jsonc"),
    path.join(os.homedir(), ".config", "opencode", "opencode.json")
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      const parsed = JSON.parse(stripJsonComments(fs.readFileSync(candidate, "utf8")));
      return { file: candidate, config: parsed && typeof parsed === "object" ? parsed : {}, error: null };
    } catch (error) {
      // A config we cannot parse is not a reason to refuse to start. Ours
      // still applies; theirs is skipped, and doctor reports it.
      return { file: candidate, config: {}, error: error.message };
    }
  }

  return { file: null, config: {}, error: null };
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
 * Two probes before a server is written off, with a longer second timeout.
 *
 * Killing a server ends every session on it. One five-second probe used to be
 * enough to do that, and a server busy indexing a large repository answers in
 * six. The active-jobs guard in stopServer catches most of the damage, but not
 * the window in another session between creating a session and recording its
 * job, so the kill decision itself has to be slower to reach.
 */
async function healthWithRetry(server) {
  if (await health(server)) {
    return true;
  }
  if (!isAlive(server.pid)) {
    return false;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return health(server, { timeout: HEALTH_TIMEOUT_MS * 2 });
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
    OPENCODE_CONFIG_DIR: pluginConfigDir(slug)
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

  const serveArgs = ["serve", "--port", String(port), "--hostname", "127.0.0.1"];
  let pid;

  if (process.platform === "win32") {
    // Launched hidden, so the server and every tool process it starts share one
    // windowless console instead of each getting a visible one. See
    // hidden-spawn.mjs. Start-Process refuses one file for both output streams,
    // hence the separate .err file, and stdin is redirected from an empty file
    // so the server inherits nothing of ours.
    fs.closeSync(out);
    const errLog = `${log}.err`;
    fs.writeFileSync(errLog, "", "utf8");
    const noInput = path.join(stateRoot(), "no-input");
    if (!fs.existsSync(noInput)) {
      fs.writeFileSync(noInput, "", "utf8");
    }

    const launched = spawnHiddenDetached({
      file: opencodeBinary(),
      args: serveArgs,
      cwd: scratch,
      env: childEnv,
      stdin: noInput,
      stdout: log,
      stderr: errLog,
      pidFile: path.join(workspaceStateDir(slug), "server.launch.pid"),
      errFile: path.join(workspaceStateDir(slug), "server.launch.err")
    });

    // The port is ours and cannot belong to an older live server, so it is a
    // safe marker for recovering a pid the launcher failed to report.
    pid = launched.pid ?? findPidsByCommandLine(`--port ${port} --hostname`)[0] ?? null;

    if (!pid) {
      clearLock(slug);
      throw new OpencodeError(`Could not start the OpenCode server: ${launched.reason}`, {
        code: "server_start_failed"
      });
    }
  } else {
    const child = spawn(opencodeBinary(), serveArgs, {
      cwd: scratch,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", out, out],
      env: childEnv
    });

    child.unref();
    fs.closeSync(out);
    pid = child.pid;
  }

  const url = `http://127.0.0.1:${port}`;

  try {
    await waitForServer(url, password, { pid, deadline: Date.now() + START_TIMEOUT_MS });
  } catch (error) {
    terminateProcessTree(pid, { force: true });
    clearLock(slug);
    throw error;
  }

  const record = {
    status: "running",
    pid,
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
    if (looksLikeOurServer(existing) && (await healthWithRetry(existing))) {
      touch(slug);
      return existing;
    }
    // Dead, replaced, or not answering. Reclaim it, except that stopServer now
    // refuses while jobs are live, so a slow server mid-delegation survives.
    const reclaimed = await stopServer(workspace, { reason: "unhealthy" });

    if (!reclaimed.stopped && reclaimed.reason === ACTIVE_JOBS_REASON) {
      // Adopt it rather than fight it: a slow-but-live server carrying work is
      // reconciliation's problem to report, not a reason to destroy the work.
      //
      // Adopt only what the healthy path would accept, though. Returning a
      // record without re-checking meant a dead server could be handed back,
      // and the caller threw on createSession instead of getting a new server.
      if (looksLikeOurServer(existing) && (await health(existing))) {
        touch(slug);
        return existing;
      }

      throw new OpencodeError(
        `The OpenCode server for ${root} is not responding, and it still has active jobs so it was not replaced. Cancel them, or run: /foreman:unregister ${root} --force`,
        { code: "server_unreachable_with_jobs" }
      );
    }
  }

  if (!claimStart(slug, root)) {
    await new Promise((resolve) => setTimeout(resolve, ACQUIRE_RETRY_MS));
    return acquireServer(workspace, { attempt: attempt + 1 });
  }

  return startServer(workspace);
}

export async function stopServer(workspace, { reason = "requested", force = false } = {}) {
  const { slug } = workspace;
  const record = readLock(slug);

  if (!record) {
    return { stopped: false, reason: "no server recorded" };
  }

  // Killing a server ends every session on it, so one with live jobs is spared
  // unless the caller explicitly forces it. acquireServer used to reach here on
  // the strength of a single five-second health probe: a server busy indexing
  // answers in six, and another delegation's in-flight work was force-killed.
  // Same defect as the sweepServers bug, in the reclaim path.
  // The pid must actually be alive. Sparing a corpse protects no work and
  // wedges the workspace: with a dead server and a job record still "running",
  // every acquire failed its health check, was refused here, adopted the dead
  // record, and then threw on createSession. Before the guard existed that
  // case self-healed as "stale record, pid reused".
  if (!force && record.status === "running" && isAlive(record.pid) && hasActiveJobs(workspace)) {
    return { stopped: false, reason: ACTIVE_JOBS_REASON };
  }

  if (record.status === "running" && record.pid) {
    if (looksLikeOurServer(record)) {
      const outcome = terminateProcessTree(record.pid, { force: true });

      // The lock is the only record of this pid anywhere. Clearing it after a
      // failed kill orphans a live, authenticated, write-capable server that
      // no command can afterwards see or stop.
      if (!outcome.killed && isAlive(record.pid)) {
        return {
          stopped: false,
          pid: record.pid,
          reason: `could not be killed (${outcome.reason ?? "unknown"}); its record was kept so it stays visible`
        };
      }

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
  // Defaults to sparing a server, not reaping it. A caller that forgets the
  // guard should fail to clean up, never destroy a running job: that mistake
  // in sweepServers killed a live delegation.
  {
    hasRunningJobs = () => true,
    isOurServer = looksLikeOurServer,
    // Injectable so a test can exercise the failed-kill branch. Using a real
    // pid for that is not an option: a test that points the sweep at its own
    // process kills the test runner, which is how this seam got added.
    terminate = terminateProcessTree
  } = {}
) {
  const actions = [];

  // One subprocess for every server's command line rather than one each. The
  // sweep runs on every turn of every session, and each identity check on
  // Windows is a PowerShell start.
  const records = workspaces.map((workspace) => [workspace, readLock(workspace.slug)]);
  primeCommandLines(
    records
      .filter(([, record]) => record?.status === "running" && record.pid)
      .map(([, record]) => record.pid)
  );

  for (const [workspace, record] of records) {
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
      const outcome = terminate(record.pid, { force: true });

      // Keep the record when the kill failed. Clearing it would leave a live
      // server with no reference anywhere, invisible to every command.
      if (!outcome.killed && isAlive(record.pid)) {
        actions.push({
          workspace: workspace.root,
          action: `could not stop idle server pid ${record.pid}; its record was kept so it stays visible`
        });
        continue;
      }

      clearLock(workspace.slug);
      actions.push({
        workspace: workspace.root,
        action: `stopped idle server (${Math.round(idleMs / 60000)}m without work)`
      });
    }
  }

  return actions;
}
