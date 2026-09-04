import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "ea-servers-"));
process.env.EXTERNAL_AGENTS_STATE_DIR = SCRATCH;
delete process.env.CLAUDE_PLUGIN_DATA;

const { AUTH_USERNAME, authHeader, serverStatus, sweep, IDLE_TTL_MS } = await import(
  "../scripts/lib/servers.mjs"
);
const { workspaceStateDir } = await import("../scripts/lib/state.mjs");
const { isAlive } = await import("../scripts/lib/process.mjs");

const WORKSPACE = { slug: "fixture-0000000000000000", root: path.join(SCRATCH, "repo") };

function writeLock(record) {
  fs.writeFileSync(
    path.join(workspaceStateDir(WORKSPACE.slug), "server.lock"),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8"
  );
}

function clearLock() {
  try {
    fs.unlinkSync(path.join(workspaceStateDir(WORKSPACE.slug), "server.lock"));
  } catch {
    // Fine.
  }
}

test("Basic auth uses the username OpenCode actually requires", () => {
  // Discovered the hard way: OpenCode checks both halves. The right password
  // with any other username returns a bare 401, indistinguishable from a wrong
  // password, which is an unpleasant thing to debug twice.
  assert.equal(AUTH_USERNAME, "opencode");

  const decoded = Buffer.from(authHeader("s3cret").replace("Basic ", ""), "base64").toString();
  assert.equal(decoded, "opencode:s3cret");
});

test("a workspace with no lock reports stopped", () => {
  clearLock();
  assert.deepEqual(serverStatus(WORKSPACE), { state: "stopped" });
});

test("a start claim is reported as starting", () => {
  writeLock({ status: "starting", owner: process.pid, startedAt: new Date().toISOString() });
  const status = serverStatus(WORKSPACE);

  assert.equal(status.state, "starting");
  assert.equal(status.owner, process.pid);
  clearLock();
});

test("a record whose process is gone reports as orphaned", () => {
  writeLock({
    status: "running",
    pid: 999_999_21,
    url: "http://127.0.0.1:9",
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString()
  });

  const status = serverStatus(WORKSPACE);
  assert.equal(status.state, "orphaned-record");
  clearLock();
});

test("idle time is measured from the last activity, not from start", () => {
  const startedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const lastActivityAt = new Date(Date.now() - 60 * 1000).toISOString();
  writeLock({ status: "running", pid: process.pid, url: "http://127.0.0.1:9", startedAt, lastActivityAt });

  const status = serverStatus(WORKSPACE);
  assert.equal(status.state, "running");
  assert.ok(status.idleMs >= 59_000 && status.idleMs < 120_000, `idleMs was ${status.idleMs}`);
  clearLock();
});

test("sweep clears a stale start claim whose owner died", async () => {
  writeLock({
    status: "starting",
    owner: 999_999_21,
    startedAt: new Date().toISOString()
  });

  const actions = await sweep([WORKSPACE]);

  assert.equal(actions.length, 1);
  assert.match(actions[0].action, /stale start claim/);
  assert.equal(serverStatus(WORKSPACE).state, "stopped");
});

test("sweep leaves a fresh start claim alone", async () => {
  writeLock({ status: "starting", owner: process.pid, startedAt: new Date().toISOString() });

  const actions = await sweep([WORKSPACE]);

  assert.deepEqual(actions, []);
  assert.equal(serverStatus(WORKSPACE).state, "starting");
  clearLock();
});

test("sweep clears the record of a server whose process is gone", async () => {
  writeLock({
    status: "running",
    pid: 999_999_21,
    url: "http://127.0.0.1:9",
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString()
  });

  const actions = await sweep([WORKSPACE]);

  assert.equal(actions.length, 1);
  assert.match(actions[0].action, /dead server/);
  assert.equal(serverStatus(WORKSPACE).state, "stopped");
});

test("a live PID that is not our server is cleared, not killed", async () => {
  // PID reuse protection. This process is alive, so a liveness check alone
  // would treat the record as a healthy server and eventually kill whatever
  // now owns that number. The identity check is what prevents that.
  writeLock({
    status: "running",
    pid: process.pid,
    url: "http://127.0.0.1:9",
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString()
  });

  const actions = await sweep([WORKSPACE]);

  assert.equal(actions.length, 1);
  assert.match(actions[0].action, /dead server/);
  assert.equal(isAlive(process.pid), true, "the unrelated process must survive");
});

test("sweep spares an idle server while it still has running jobs", async () => {
  // The idle TTL must never reap a server that is mid-delegation, however
  // quiet the HTTP side looks.
  const stale = new Date(Date.now() - IDLE_TTL_MS * 2).toISOString();
  writeLock({
    status: "running",
    pid: process.pid,
    url: "http://127.0.0.1:9",
    startedAt: stale,
    lastActivityAt: stale
  });

  const actions = await sweep([WORKSPACE], {
    hasRunningJobs: () => true,
    isOurServer: () => true
  });

  assert.deepEqual(actions, [], "a busy server must survive the sweep");
  assert.equal(serverStatus(WORKSPACE).state, "running");
  clearLock();
});

test("sweep stops an idle server once its jobs are done", async () => {
  const stale = new Date(Date.now() - IDLE_TTL_MS * 2).toISOString();
  writeLock({
    status: "running",
    pid: 999_999_21,
    url: "http://127.0.0.1:9",
    startedAt: stale,
    lastActivityAt: stale
  });

  const actions = await sweep([WORKSPACE], {
    hasRunningJobs: () => false,
    isOurServer: () => true
  });

  assert.equal(actions.length, 1);
  assert.match(actions[0].action, /stopped idle server/);
  assert.equal(serverStatus(WORKSPACE).state, "stopped");
});

test("sweep ignores a workspace with no server at all", async () => {
  clearLock();
  assert.deepEqual(await sweep([WORKSPACE]), []);
});
