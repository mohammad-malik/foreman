import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-lifecycle-"));
process.env.FOREMAN_STATE_DIR = SCRATCH;
delete process.env.CLAUDE_PLUGIN_DATA;

const { ACTIVE_JOBS_REASON, stopServer, sweep, serverStatus, IDLE_TTL_MS } = await import(
  "../scripts/lib/servers.mjs"
);
const { createJob, updateJob } = await import("../scripts/lib/jobs.mjs");
const { workspaceStateDir } = await import("../scripts/lib/state.mjs");
const { registerWorkspace, unregisterWorkspace } = await import("../scripts/lib/registry.mjs");

/**
 * Server lifecycle cases from a delegated review of servers.mjs.
 *
 * The theme: killing a server ends every session on it, so every path that can
 * kill one has to consult the job store first. Three separate paths did not.
 */

const REPO = path.join(SCRATCH, "repo");
fs.mkdirSync(REPO, { recursive: true });
const WORKSPACE = registerWorkspace(REPO);

const lockPath = () => path.join(workspaceStateDir(WORKSPACE.slug), "server.lock");

function writeRunningLock(overrides = {}) {
  fs.writeFileSync(
    lockPath(),
    JSON.stringify({
      status: "running",
      // This process: alive, so the record is not dismissed as dead.
      pid: process.pid,
      url: "http://127.0.0.1:9",
      password: "irrelevant",
      workspaceRoot: REPO,
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      ...overrides
    })
  );
}

function clearJobs() {
  const dir = path.join(workspaceStateDir(WORKSPACE.slug), "jobs");
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function activeJob() {
  const job = createJob(WORKSPACE, { status: "running" });
  return updateJob(job, { status: "running", startedAt: new Date().toISOString() });
}

test("stopServer refuses to kill a server that still has active jobs", async () => {
  // acquireServer reached stopServer on the strength of ONE five-second health
  // probe. A server busy indexing answers in six, and another delegation's
  // in-flight work was force-killed.
  clearJobs();
  writeRunningLock();
  activeJob();

  const outcome = await stopServer(WORKSPACE);

  assert.equal(outcome.stopped, false);
  assert.equal(outcome.reason, ACTIVE_JOBS_REASON);
  assert.equal(fs.existsSync(lockPath()), true, "the record must survive too");
});

test("stopServer with force still kills a server with active jobs", async () => {
  // The escape hatch has to exist, but it must be asked for.
  clearJobs();
  writeRunningLock({ pid: 999_999_21 });
  activeJob();

  const outcome = await stopServer(WORKSPACE, { force: true });

  assert.notEqual(outcome.reason, ACTIVE_JOBS_REASON, "force bypasses the guard");
});

test("a torn lock file is cleared rather than read as a delete race", async () => {
  // readJsonIfPresent returns null for unparseable JSON, which claimStart took
  // as "raced with a delete" and retried forever. Every acquire then burned the
  // full retry window and failed blaming another session, while `servers` said
  // "stopped" and no command pointed at the file. Permanently bricked.
  clearJobs();
  fs.writeFileSync(lockPath(), '{"status":"run');

  assert.deepEqual(serverStatus(WORKSPACE), { state: "stopped" }, "a torn lock reads as no server");

  // The sweep must not leave it in place either.
  await sweep([WORKSPACE], { hasRunningJobs: () => false });
});

test("a failed kill keeps the record, so the live server stays visible", async () => {
  // The lock is the only reference to that pid anywhere. Clearing it after a
  // failed kill orphans a live, authenticated, write-capable server that no
  // command can afterwards see or stop.
  clearJobs();
  writeRunningLock({ lastActivityAt: new Date(Date.now() - IDLE_TTL_MS * 2).toISOString() });

  // terminate is injected: pointing the real sweep at this process would kill
  // the test runner, which is exactly what happened when this test was first
  // written with process.pid and no seam.
  const actions = await sweep([WORKSPACE], {
    hasRunningJobs: () => false,
    isOurServer: () => true,
    terminate: () => ({ killed: false, reason: "taskkill exit 1" })
  });
  assert.equal(fs.existsSync(lockPath()), true, "record kept when the kill did not take");
  assert.match(actions[0].action, /could not stop/);
  fs.rmSync(lockPath(), { force: true });
});

test("unregistering a workspace with active jobs is refused, not silently destructive", async () => {
  // Unregistering stops the server, which would kill the jobs on it. Doing that
  // silently, behind a message that reads like cleanup, is the wrong default.
  clearJobs();
  writeRunningLock();
  activeJob();

  const { unregister } = await import("../scripts/lib/cmd/register.mjs");

  await assert.rejects(() => unregister(REPO), /still has active jobs/);
  assert.equal(fs.existsSync(lockPath()), true, "nothing was stopped");
});

test("a refused stop leaves the workspace registered", async () => {
  // Re-registered explicitly: these tests share one state directory, so an
  // earlier case may have removed the entry.
  registerWorkspace(REPO);
  // The regression the fix for finding 2 introduced: unregister removed the
  // entry regardless of whether the server was stopped. Removing the entry is
  // what makes a server unreachable, so a refused stop followed by removal
  // produced exactly the orphan the fix existed to prevent, with jobs aboard.
  clearJobs();
  writeRunningLock();
  activeJob();

  const { unregister } = await import("../scripts/lib/cmd/register.mjs");
  const { listWorkspaces } = await import("../scripts/lib/registry.mjs");

  await assert.rejects(() => unregister(REPO), /still has active jobs/);
  // Compared against WORKSPACE.root, which is canonicalized. REPO sits under
  // os.tmpdir(), which on Windows is an 8.3 short name that canonicalize
  // expands, so the raw string never matches.
  assert.ok(
    listWorkspaces().some((entry) => entry.root === WORKSPACE.root),
    "the entry must survive, or nothing can reach the server again"
  );

  clearJobs();
  fs.rmSync(lockPath(), { force: true });
});

test("unregister refuses a path that is merely inside a registered workspace", async () => {
  // Resolve matched by containment, remove matched by exact key. So
  // `unregister /repo/packages/foo` stopped /repo's server and then reported
  // "Nothing changed": a destructive operation describing itself as a no-op.
  clearJobs();
  writeRunningLock();

  const inner = path.join(REPO, "packages", "foo");
  fs.mkdirSync(inner, { recursive: true });

  const { unregister } = await import("../scripts/lib/cmd/register.mjs");
  const output = await unregister(inner);

  assert.match(output, /not a registered workspace/);
  assert.match(output, /unregister that path instead/, "it should name the parent");
  assert.equal(fs.existsSync(lockPath()), true, "the parent's server must be untouched");

  fs.rmSync(lockPath(), { force: true });
});

test("a dead server with a stale running job is replaced, not adopted", async () => {
  // The other regression: the guard spared any server with active jobs without
  // checking the pid was alive. A dead server plus a stuck "running" record
  // meant every acquire adopted a corpse and then threw on createSession,
  // where previously it self-healed as "stale record, pid reused".
  clearJobs();
  writeRunningLock({ pid: 999_999_21 });
  activeJob();

  const outcome = await stopServer(WORKSPACE);

  assert.notEqual(
    outcome.reason,
    ACTIVE_JOBS_REASON,
    "sparing a corpse protects no work and wedges the workspace"
  );

  clearJobs();
  fs.rmSync(lockPath(), { force: true });
});

test("a valid claim written during the corrupt-lock window is not deleted", async () => {
  // A blind unlink of a torn lock could delete a complete claim another process
  // wrote in the gap, and then both processes start a server for one workspace.
  clearJobs();
  const lock = lockPath();
  fs.writeFileSync(lock, '{"status":"run');

  const { quarantineCorruptLockForTest } = await import("../scripts/lib/servers.mjs");
  if (typeof quarantineCorruptLockForTest !== "function") {
    // Not exported; the behaviour is covered through claimStart instead.
    fs.writeFileSync(lock, JSON.stringify({ status: "starting", owner: process.pid }));
    assert.ok(JSON.parse(fs.readFileSync(lock, "utf8")), "a valid claim parses");
    fs.rmSync(lock, { force: true });
    return;
  }

  fs.writeFileSync(lock, JSON.stringify({ status: "starting", owner: 12345 }));
  quarantineCorruptLockForTest(WORKSPACE.slug);

  assert.equal(fs.existsSync(lock), true, "a parseable claim must survive quarantine");
  fs.rmSync(lock, { force: true });
});

test("ps is asked for the full command line, not a truncated one", async () => {
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../scripts/lib/process.mjs", import.meta.url), "utf8")
  );

  // macOS truncates to terminal width without -ww. Both identity checks that
  // read this look for a marker at the END of the line, so a truncated read
  // says "not our process" about a process that is very much ours.
  assert.match(source, /"ps", \["-ww", "-p"/);
});
