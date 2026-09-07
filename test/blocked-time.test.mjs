import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-blocked-"));
process.env.FOREMAN_STATE_DIR = SCRATCH;
delete process.env.CLAUDE_PLUGIN_DATA;

const { createJob, updateJob, elapsedMs, blockedMs, markAwaiting, markPolled, markResumed } =
  await import("../scripts/lib/jobs.mjs");
const { reconcileWorkspace } = await import("../scripts/lib/reconcile.mjs");
const { workspaceStateDir } = await import("../scripts/lib/state.mjs");

const WORKSPACE = { slug: "blocked-0000000000000000", root: path.join(SCRATCH, "repo") };

// A live server record, so reconciliation's separate "server is gone" rule does
// not fire and mask what these tests are about: the budget.
function withServer() {
  fs.writeFileSync(
    path.join(workspaceStateDir(WORKSPACE.slug), "server.lock"),
    JSON.stringify({
      status: "running",
      pid: process.pid,
      url: "http://127.0.0.1:9",
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString()
    })
  );
}

const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();

function job(fields) {
  return updateJob(createJob(WORKSPACE, { status: "running", ...fields }), fields);
}

/**
 * Budget accounting for a job that spends time waiting on a person.
 *
 * Every case here is a real failure. Three write delegations died to this area:
 * one to a budget that was too short, one to a budget that ran while the job
 * was blocked, and one to a poll that credited 26 seconds of a 25-minute wait.
 */

test("time blocked on a person does not count against the budget", async () => {
  // The job that was reaped at minute 65 as a "runaway" while sitting on an
  // unanswered prompt since minute 13.
  const started = minutesAgo(65);
  const blocked = job({ startedAt: started, awaitingSince: minutesAgo(52), budgetMs: 45 * 60_000 });

  assert.ok(blockedMs(blocked) > 50 * 60_000, "the wait is counted as blocked");
  assert.ok(
    elapsedMs(blocked) < 20 * 60_000,
    `working time should exclude the wait, got ${Math.round(elapsedMs(blocked) / 60000)}m`
  );
});

test("waiting is credited from the last clean poll, not from discovery", async () => {
  // The 26-seconds-of-25-minutes bug. A poll at minute 15 found it working; a
  // poll at minute 40 found it blocked. The request arose somewhere between,
  // so minute 15 is the bound the evidence supports.
  const created = job({ startedAt: minutesAgo(40), lastPolledAt: minutesAgo(25) });
  const awaiting = markAwaiting(created);

  assert.equal(awaiting.awaitingSince, created.lastPolledAt, "credited from the clean poll");
  assert.ok(
    blockedMs(awaiting) > 24 * 60_000,
    `should credit about 25 minutes, got ${Math.round(blockedMs(awaiting) / 60000)}m`
  );
});

test("with no clean poll on record, waiting is credited from discovery", async () => {
  // No evidence of when it began, so the conservative reading is used rather
  // than inventing a bound.
  const awaiting = markAwaiting(job({ startedAt: minutesAgo(10) }));
  assert.ok(blockedMs(awaiting) < 60_000);
});

test("markAwaiting is idempotent, so repeated polling does not reset the wait", async () => {
  const first = markAwaiting(job({ startedAt: minutesAgo(30), lastPolledAt: minutesAgo(20) }));
  const second = markAwaiting(first);

  assert.equal(second.awaitingSince, first.awaitingSince);
});

test("resuming folds the wait into blockedMs and records a fresh poll", async () => {
  const awaiting = markAwaiting(job({ startedAt: minutesAgo(30), lastPolledAt: minutesAgo(20) }));
  const resumed = markResumed(awaiting);

  assert.equal(resumed.status, "running");
  assert.equal(resumed.awaitingSince, null);
  assert.ok(resumed.blockedMs > 19 * 60_000, "the whole wait is banked");
  assert.ok(resumed.lastPolledAt, "work resumes now, so this is a clean-poll bound too");
});

test("a blocked job past its raw age is NOT failed for budget", async () => {
  // The precise failure: reconciliation applies the budget, so a blocked job
  // whose wall-clock age exceeds it was killed and became unanswerable.
  const blocked = job({
    startedAt: minutesAgo(50),
    awaitingSince: minutesAgo(45),
    budgetMs: 20 * 60_000,
    status: "awaiting_permission"
  });

  withServer();
  await reconcileWorkspace(WORKSPACE);

  const after = JSON.parse(
    fs.readFileSync(path.join(workspaceStateDir(WORKSPACE.slug), "jobs", `${blocked.id}.json`), "utf8")
  );
  assert.equal(after.status, "awaiting_permission", "a job waiting on a person is not a runaway");
});

test("a job that really did exceed its budget while working is still failed", async () => {
  // The budget must keep working; only blocked time is excluded.
  const runaway = job({ startedAt: minutesAgo(50), budgetMs: 20 * 60_000, status: "running" });

  withServer();
  await reconcileWorkspace(WORKSPACE);

  const after = JSON.parse(
    fs.readFileSync(path.join(workspaceStateDir(WORKSPACE.slug), "jobs", `${runaway.id}.json`), "utf8")
  );
  assert.equal(after.status, "failed");
  assert.match(after.error, /budget/);
});

test("markPolled advances the clean-poll bound", async () => {
  const before = job({ startedAt: minutesAgo(10), lastPolledAt: minutesAgo(9) });
  const polled = markPolled(before);

  assert.ok(
    Date.parse(polled.lastPolledAt) > Date.parse(before.lastPolledAt),
    "a clean poll moves the bound forward"
  );
});
