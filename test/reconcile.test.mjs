import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "ea-recon-"));
process.env.EXTERNAL_AGENTS_STATE_DIR = SCRATCH;
delete process.env.CLAUDE_PLUGIN_DATA;

const { reconcileWorkspace } = await import("../scripts/lib/reconcile.mjs");
const { createJob, loadJob, updateJob } = await import("../scripts/lib/jobs.mjs");
const { workspaceStateDir } = await import("../scripts/lib/state.mjs");

const WORKSPACE = { slug: "recon-0000000000000000", root: path.join(SCRATCH, "repo") };

function makeJob(fields) {
  const job = createJob(WORKSPACE, { status: "running", ...fields });
  return updateJob(job, fields);
}

function withRunningServer(fn) {
  // reconcile treats "no server" as proof a job is dead, so a fake running
  // record isolates the budget rules from the server-gone rule.
  const lock = path.join(workspaceStateDir(WORKSPACE.slug), "server.lock");
  fs.writeFileSync(
    lock,
    JSON.stringify({
      status: "running",
      pid: process.pid,
      url: "http://127.0.0.1:9",
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString()
    })
  );
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

test("a job past its budget is failed with a reason", () => {
  withRunningServer(() => {
    const job = makeJob({
      startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      budgetMs: 60_000
    });

    reconcileWorkspace(WORKSPACE);
    const after = loadJob(WORKSPACE.slug, job.id);

    assert.equal(after.status, "failed");
    assert.match(after.error, /budget/);
    assert.ok(after.finishedAt);
  });
});

test("a job inside its budget is left running", () => {
  withRunningServer(() => {
    const job = makeJob({ startedAt: new Date().toISOString(), budgetMs: 15 * 60 * 1000 });

    reconcileWorkspace(WORKSPACE);

    assert.equal(loadJob(WORKSPACE.slug, job.id).status, "running");
  });
});

test("a job whose server is gone is failed, not left running forever", () => {
  // The deadlock this exists to prevent: a stranded job counts as live work,
  // so the idle sweep spares its server indefinitely and the job sits at
  // "running" for days.
  const job = makeJob({
    startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    budgetMs: 60 * 60 * 1000
  });

  reconcileWorkspace(WORKSPACE);
  const after = loadJob(WORKSPACE.slug, job.id);

  assert.equal(after.status, "failed");
  assert.match(after.error, /server running this job stopped/);
});

test("a just-dispatched job is given a grace period", () => {
  // A server mid-restart, or the moment between dispatch and the first health
  // check, must not fail the job.
  const job = makeJob({ startedAt: new Date().toISOString(), budgetMs: 60 * 60 * 1000 });

  reconcileWorkspace(WORKSPACE);

  assert.equal(loadJob(WORKSPACE.slug, job.id).status, "running");
});

test("jobs already in a terminal state are untouched", () => {
  const done = makeJob({
    status: "completed",
    startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    finishedAt: new Date().toISOString()
  });

  reconcileWorkspace(WORKSPACE);
  const after = loadJob(WORKSPACE.slug, done.id);

  assert.equal(after.status, "completed");
  assert.equal(after.error, null);
});

test("reconciling twice does not rewrite an already failed job", () => {
  const job = makeJob({
    startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    budgetMs: 60_000
  });

  reconcileWorkspace(WORKSPACE);
  const first = loadJob(WORKSPACE.slug, job.id);

  reconcileWorkspace(WORKSPACE);
  const second = loadJob(WORKSPACE.slug, job.id);

  assert.equal(second.finishedAt, first.finishedAt);
  assert.equal(second.error, first.error);
});
