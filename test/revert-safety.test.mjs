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
  assert.match(outcome.skipped[0].reason, /per-file snapshot limit/);
});

test("baseline content copies stay out of the record for a clean tree", () => {
  // A clean repository is the normal case, and it should not carry copies of
  // anything into the job record.
  const { root } = makeRepo();
  const baseline = captureBaseline(root);

  assert.deepEqual(Object.keys(baseline.contents), []);
});

test("a snapshot from an older release still restores, and never deletes", () => {
  // Job records outlive upgrades. Release 0.2.0 stored a snapshot as a bare
  // base64 string; 0.3.0 stores an object. Reading `.content` off the string
  // yields undefined, and the earlier code unlinked the file BEFORE decoding,
  // so an upgrade turned revert into deletion with no restore.
  const { root } = makeRepo();
  const scratch = path.join(root, "legacy.txt");
  fs.writeFileSync(scratch, "original content\n");

  const baseline = captureBaseline(root);
  // Rewrite the snapshot in the old format.
  baseline.contents["legacy.txt"] = Buffer.from("original content\n").toString("base64");

  fs.writeFileSync(scratch, "agent overwrote this\n");

  const diff = diffAgainstBaseline(baseline);
  const outcome = revertPaths(root, baseline, diff.changed);

  assert.equal(fs.existsSync(scratch), true, "the file must survive a legacy snapshot");
  assert.equal(fs.readFileSync(scratch, "utf8"), "original content\n");
  assert.deepEqual(outcome.removed, []);
});

test("an unreadable snapshot leaves the file alone rather than destroying it", () => {
  const { root } = makeRepo();
  const scratch = path.join(root, "corrupt.txt");
  fs.writeFileSync(scratch, "mine\n");

  const baseline = captureBaseline(root);
  baseline.contents["corrupt.txt"] = { kind: "nonsense" };

  fs.writeFileSync(scratch, "agent edit\n");

  const diff = diffAgainstBaseline(baseline);
  const outcome = revertPaths(root, baseline, diff.changed);

  assert.equal(fs.existsSync(scratch), true, "never delete on the strength of a snapshot we cannot read");
  assert.equal(outcome.skipped.length, 1);
  assert.match(outcome.skipped[0].reason, /could not be read/);
});

test("a partially staged file keeps its unstaged hunks out of the index", () => {
  // Status MM: the index and working tree differ because the user staged some
  // hunks and not others. Reconstructing the index by re-adding the working
  // tree would stage the parts they deliberately left out.
  const { root, git } = makeRepo();
  const file = path.join(root, "tracked.txt");

  fs.writeFileSync(file, "committed\nstaged line\n");
  git("add", "--", "tracked.txt");
  const stagedBlob = git("ls-files", "-s", "--", "tracked.txt").trim().split(/\s+/)[1];

  fs.writeFileSync(file, "committed\nstaged line\nunstaged line\n");

  const baseline = captureBaseline(root);
  assert.equal(baseline.indexEntries["tracked.txt"].blob, stagedBlob);

  fs.writeFileSync(file, "committed\nstaged line\nunstaged line\nagent line\n");

  const diff = diffAgainstBaseline(baseline);
  revertPaths(root, baseline, diff.changed);

  const afterBlob = git("ls-files", "-s", "--", "tracked.txt").trim().split(/\s+/)[1];
  assert.equal(afterBlob, stagedBlob, "the index must hold exactly what was staged before the job");
  assert.equal(
    fs.readFileSync(file, "utf8"),
    "committed\nstaged line\nunstaged line\n",
    "the working tree returns to its pre-job state"
  );
});

test("an unstaged file is not left staged by revert", () => {
  const { root, git } = makeRepo();
  const scratch = path.join(root, "loose.txt");
  fs.writeFileSync(scratch, "mine\n");

  const baseline = captureBaseline(root);
  fs.writeFileSync(scratch, "agent edit\n");
  git("add", "--", "loose.txt");

  const diff = diffAgainstBaseline(baseline);
  revertPaths(root, baseline, diff.changed);

  assert.equal(git("ls-files", "-s", "--", "loose.txt").trim(), "", "must not be staged");
  assert.equal(fs.readFileSync(scratch, "utf8"), "mine\n");
});

test("the executable bit survives a revert", { skip: process.platform === "win32" }, () => {
  const { root } = makeRepo();
  const script = path.join(root, "run.sh");
  fs.writeFileSync(script, "#!/bin/sh\necho hi\n");
  fs.chmodSync(script, 0o755);

  const baseline = captureBaseline(root);
  fs.writeFileSync(script, "#!/bin/sh\necho tampered\n");

  const diff = diffAgainstBaseline(baseline);
  revertPaths(root, baseline, diff.changed);

  assert.equal(fs.statSync(script).mode & 0o111, 0o111, "a restored script must still be executable");
});
