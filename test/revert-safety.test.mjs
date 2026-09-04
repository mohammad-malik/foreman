import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { captureBaseline, diffAgainstBaseline, revertPaths } from "../scripts/lib/git-baseline.mjs";

/**
 * Revert is the one operation here that deletes things, so these tests are
 * about the user never losing work they did themselves. They exist because a
 * review caught revert deleting a pre-existing untracked file outright, on the
 * grounds that it was not in HEAD, which is true and entirely beside the point.
 */

function makeRepo() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ea-revert-")));
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });

  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(root, "tracked.txt"), "committed\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");

  return { root, git };
}

test("an untracked file that existed before the job is restored, never deleted", () => {
  // The reported bug. Under --allow-dirty-tree the user has an untracked
  // scratch file, the agent edits it, and revert used to delete the whole file
  // because it was absent from HEAD.
  const { root } = makeRepo();
  const scratch = path.join(root, "notes.txt");
  fs.writeFileSync(scratch, "my own notes\n");

  const baseline = captureBaseline(root);
  assert.equal(baseline.dirty, true);

  fs.writeFileSync(scratch, "my own notes\nplus the agent's edit\n");

  const diff = diffAgainstBaseline(baseline);
  const outcome = revertPaths(root, baseline, diff.changed);

  assert.equal(fs.existsSync(scratch), true, "the user's file must survive");
  assert.equal(fs.readFileSync(scratch, "utf8"), "my own notes\n", "restored to its pre-job content");
  assert.deepEqual(outcome.removed, [], "nothing should have been deleted");
  assert.deepEqual(outcome.restored, ["notes.txt"]);
});

test("a tracked file dirty before the job keeps its pre-job edits", () => {
  // Checking it out of HEAD would silently discard the user's uncommitted work.
  const { root } = makeRepo();
  const tracked = path.join(root, "tracked.txt");
  fs.writeFileSync(tracked, "committed\nmy uncommitted edit\n");

  const baseline = captureBaseline(root);
  fs.writeFileSync(tracked, "committed\nmy uncommitted edit\nagent edit\n");

  const diff = diffAgainstBaseline(baseline);
  revertPaths(root, baseline, diff.changed);

  assert.equal(
    fs.readFileSync(tracked, "utf8"),
    "committed\nmy uncommitted edit\n",
    "the user's uncommitted edit must be preserved, not reset to HEAD"
  );
});

test("a file the agent genuinely created is still deleted", () => {
  const { root } = makeRepo();
  const baseline = captureBaseline(root);
  fs.writeFileSync(path.join(root, "agent-made.txt"), "new\n");

  const diff = diffAgainstBaseline(baseline);
  const outcome = revertPaths(root, baseline, diff.changed);

  assert.deepEqual(outcome.removed, ["agent-made.txt"]);
  assert.equal(fs.existsSync(path.join(root, "agent-made.txt")), false);
});

test("a pre-existing file too large to copy is skipped, not deleted", () => {
  const { root } = makeRepo();
  const big = path.join(root, "big.bin");
  fs.writeFileSync(big, Buffer.alloc(1024 * 1024 + 1, 7));

  const baseline = captureBaseline(root);
  assert.equal(baseline.contents["big.bin"], undefined, "too large to keep a copy of");

  fs.appendFileSync(big, Buffer.alloc(16, 9));

  const diff = diffAgainstBaseline(baseline);
  const outcome = revertPaths(root, baseline, diff.changed);

  assert.equal(fs.existsSync(big), true, "must never be deleted just because it could not be copied");
  assert.equal(outcome.skipped.length, 1);
  assert.match(outcome.skipped[0].reason, /too large/);
});

test("baseline content copies stay out of the record for a clean tree", () => {
  // A clean repository is the normal case, and it should not carry copies of
  // anything into the job record.
  const { root } = makeRepo();
  const baseline = captureBaseline(root);

  assert.deepEqual(Object.keys(baseline.contents), []);
});
