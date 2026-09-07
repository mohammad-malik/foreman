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
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "foreman-revert-")));
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

test("reverting through a hard link does not truncate the linked file", { skip: process.platform === "win32" }, () => {
  // If the agent replaces a tracked path with a hard link to a file elsewhere
  // on disk, an in-place write would follow it and destroy that other file.
  // Renaming over the path touches only the directory entry.
  const { root } = makeRepo();
  const inside = path.join(root, "notes.txt");
  fs.writeFileSync(inside, "mine\n");

  const baseline = captureBaseline(root);

  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-outside-"));
  const outside = path.join(outsideDir, "important.txt");
  fs.writeFileSync(outside, "must not be touched\n");

  fs.unlinkSync(inside);
  fs.linkSync(outside, inside);

  const diff = diffAgainstBaseline(baseline);
  revertPaths(root, baseline, diff.changed);

  assert.equal(
    fs.readFileSync(outside, "utf8"),
    "must not be touched\n",
    "a file outside the repository must survive a revert inside it"
  );
  assert.equal(fs.readFileSync(inside, "utf8"), "mine\n");
});

test("a 0.3.0 record without indexEntries keeps its staged state", () => {
  // Records outlive upgrades. 0.3.0 recorded only `staged`; reading solely
  // `indexEntries` would silently unstage work the user had staged.
  const { root, git } = makeRepo();
  const file = path.join(root, "tracked.txt");

  fs.writeFileSync(file, "committed\nstaged by the user\n");
  git("add", "--", "tracked.txt");

  const baseline = captureBaseline(root);
  // Rewrite the record the way 0.3.0 stored it.
  baseline.staged = ["tracked.txt"];
  delete baseline.indexEntries;

  fs.writeFileSync(file, "committed\nstaged by the user\nagent line\n");

  const diff = diffAgainstBaseline(baseline);
  revertPaths(root, baseline, diff.changed);

  assert.notEqual(git("ls-files", "-s", "--", "tracked.txt").trim(), "", "must still be staged");
  assert.equal(fs.readFileSync(file, "utf8"), "committed\nstaged by the user\n");
});

test("index snapshots are read in a single git call", () => {
  // A per-path loop stalls baseline capture on a generated tree. This asserts
  // the entries are still captured correctly for many files at once.
  const { root, git } = makeRepo();

  for (let i = 0; i < 25; i += 1) {
    fs.writeFileSync(path.join(root, `f${i}.txt`), `content ${i}\n`);
  }
  git("add", "-A");

  const baseline = captureBaseline(root);

  assert.equal(Object.keys(baseline.indexEntries).length, 25);
  for (let i = 0; i < 25; i += 1) {
    assert.match(baseline.indexEntries[`f${i}.txt`].blob, /^[0-9a-f]{40,64}$/);
    assert.equal(baseline.indexEntries[`f${i}.txt`].mode, "100644");
  }
});

test("a planted temp file cannot be followed during restore", { skip: process.platform === "win32" }, () => {
  // The temp path used to be predictable, so a process that dropped a symlink
  // there would have it followed and truncated: the same data-loss path the
  // rename was meant to close, just moved one step along. Exclusive creation
  // plus a random suffix closes it.
  const { root } = makeRepo();
  const target = path.join(root, "notes.txt");
  fs.writeFileSync(target, "mine\n");

  const baseline = captureBaseline(root);

  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-planted-"));
  const outside = path.join(outsideDir, "victim.txt");
  fs.writeFileSync(outside, "must survive\n");

  // Plant links at every temp name the old scheme could have produced.
  for (const pid of [process.pid, process.pid + 1]) {
    try {
      fs.symlinkSync(outside, `${target}.foreman-${pid}.tmp`);
    } catch {
      // Planting is best effort; the assertion below is what matters.
    }
  }

  fs.writeFileSync(target, "agent edit\n");

  const diff = diffAgainstBaseline(baseline);
  revertPaths(root, baseline, diff.changed);

  assert.equal(fs.readFileSync(outside, "utf8"), "must survive\n");
  assert.equal(fs.readFileSync(target, "utf8"), "mine\n");
});

test("a restored file keeps a readable mode under a restrictive umask", { skip: process.platform === "win32" }, () => {
  // The mode passed at creation is masked by the umask, so it has to be
  // reapplied explicitly or a 0644 snapshot comes back 0600.
  const { root } = makeRepo();
  const file = path.join(root, "shared.txt");
  fs.writeFileSync(file, "mine\n");
  fs.chmodSync(file, 0o644);

  const baseline = captureBaseline(root);
  const previous = process.umask(0o077);

  try {
    fs.writeFileSync(file, "agent edit\n");
    const diff = diffAgainstBaseline(baseline);
    revertPaths(root, baseline, diff.changed);
    assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  } finally {
    process.umask(previous);
  }
});

test("the source file contains no literal NUL bytes", () => {
  // A literal NUL anywhere in the source makes git classify the whole file as
  // binary, so diffs show only "Binary files differ" and text tooling skips
  // it. One crept in from a generated edit and went unnoticed for a release.
  const source = fs.readFileSync(
    new URL("../scripts/lib/git-baseline.mjs", import.meta.url)
  );
  assert.equal(source.filter((byte) => byte === 0).length, 0);
});

test("a legacy snapshot does not inherit permissions the agent set", { skip: process.platform === "win32" }, () => {
  // The mode on disk at revert time is whatever the agent left behind, so
  // treating it as pre-job state would preserve a `chmod 777` as though the
  // user had chosen it. Git's recorded mode is the only trustworthy source
  // for a record that predates the mode field.
  const { root, git } = makeRepo();
  const file = path.join(root, "tracked.txt");
  fs.chmodSync(file, 0o644);
  fs.writeFileSync(file, "committed\nuser edit\n");

  const baseline = captureBaseline(root);
  // Rewrite the snapshot in the pre-0.4.0 format, which carries no mode.
  baseline.contents["tracked.txt"] = fs.readFileSync(file).toString("base64");

  fs.writeFileSync(file, "committed\nagent edit\n");
  fs.chmodSync(file, 0o777);

  const diff = diffAgainstBaseline(baseline);
  revertPaths(root, baseline, diff.changed);

  const mode = fs.statSync(file).mode & 0o777;
  assert.notEqual(mode, 0o777, "the agent's chmod must not survive the revert");
  assert.equal(mode, 0o644, "git's recorded mode is the pre-job truth");
});

test("a long filename can still be restored", () => {
  // The temp name used to extend the target's basename, so a valid but long
  // name pushed the temp path past the 255-byte component limit and revert
  // silently skipped the file, leaving the agent's version in place.
  const { root } = makeRepo();
  const longName = `${"n".repeat(240)}.txt`;
  const file = path.join(root, longName);
  fs.writeFileSync(file, "mine\n");

  const baseline = captureBaseline(root);
  fs.writeFileSync(file, "agent edit\n");

  const diff = diffAgainstBaseline(baseline);
  const outcome = revertPaths(root, baseline, diff.changed);

  assert.deepEqual(outcome.skipped, [], "a long name must not defeat restore");
  assert.equal(fs.readFileSync(file, "utf8"), "mine\n");
});

test("git is not consulted for snapshots that already record a mode", () => {
  // The mode lookup costs a git subprocess per file. Evaluating it eagerly
  // turned a large dirty-tree revert into one `git ls-tree` per path, even on
  // Windows where the result is discarded. A resolver that throws proves it is
  // never reached for a modern snapshot.
  const { root } = makeRepo();
  for (let i = 0; i < 5; i += 1) {
    fs.writeFileSync(path.join(root, `f${i}.txt`), `mine ${i}\n`);
  }

  const baseline = captureBaseline(root);
  for (let i = 0; i < 5; i += 1) {
    fs.writeFileSync(path.join(root, `f${i}.txt`), `agent ${i}\n`);
  }

  const diff = diffAgainstBaseline(baseline);
  const outcome = revertPaths(root, baseline, diff.changed, {
    resolveLegacyMode: () => {
      throw new Error("the legacy mode lookup must not run for a modern snapshot");
    }
  });

  assert.equal(outcome.restored.length, 5);
  assert.equal(fs.readFileSync(path.join(root, "f0.txt"), "utf8"), "mine 0\n");
});

test("git IS consulted when a legacy snapshot has no mode", { skip: process.platform === "win32" }, () => {
  const { root } = makeRepo();
  const file = path.join(root, "legacy.txt");
  fs.writeFileSync(file, "mine\n");

  const baseline = captureBaseline(root);
  baseline.contents["legacy.txt"] = fs.readFileSync(file).toString("base64");

  fs.writeFileSync(file, "agent edit\n");

  let consulted = 0;
  const diff = diffAgainstBaseline(baseline);
  revertPaths(root, baseline, diff.changed, {
    resolveLegacyMode: () => {
      consulted += 1;
      return 0o644;
    }
  });

  assert.equal(consulted, 1, "a legacy snapshot has no recorded mode, so git is the fallback");
  assert.equal(fs.readFileSync(file, "utf8"), "mine\n");
});

test("the legacy mode lookup runs before any filesystem operation", () => {
  // An ordering invariant, not a behaviour. The lookup shells out to git, and
  // every subprocess is a window in which a watcher could swap the target's
  // parent directory for a symlink; anything the restore does afterwards would
  // follow the swap. Placing it after mkdir and lstat was a real finding.
  //
  // The probe: delete the parent directory before reverting. mkdirSync will
  // recreate it, so if the resolver is called first the directory must not yet
  // exist when it runs.
  const { root } = makeRepo();
  const dir = path.join(root, "sub");
  const file = path.join(dir, "legacy.txt");
  fs.mkdirSync(dir);
  fs.writeFileSync(file, "mine\n");

  const baseline = captureBaseline(root);
  // Pre-0.4.0 format: a bare base64 string, so no mode is recorded and the
  // git lookup is the fallback.
  baseline.contents["sub/legacy.txt"] = fs.readFileSync(file).toString("base64");

  // The agent removes the file and its directory. Restoring it therefore has
  // to recreate the parent, which is what makes the probe below meaningful.
  fs.rmSync(dir, { recursive: true, force: true });
  const diff = diffAgainstBaseline(baseline);
  assert.equal(diff.changed.length, 1, "the deletion should be attributed to the agent");

  let directoryExistedWhenResolved = null;
  revertPaths(root, baseline, diff.changed, {
    resolveLegacyMode: () => {
      directoryExistedWhenResolved = fs.existsSync(dir);
      return 0o644;
    }
  });

  // On Windows the mode is never resolved at all, which is also correct: there
  // is no subprocess and therefore no window.
  if (process.platform === "win32") {
    assert.equal(directoryExistedWhenResolved, null, "no mode lookup is needed on Windows");
  } else {
    assert.equal(
      directoryExistedWhenResolved,
      false,
      "the lookup must happen before mkdirSync recreates the parent"
    );
  }

  assert.equal(fs.readFileSync(file, "utf8"), "mine\n");
});
