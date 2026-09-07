import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  captureBaseline,
  diffAgainstBaseline,
  isRuntimeArtifact,
  revertPaths
} from "../scripts/lib/git-baseline.mjs";

function makeRepo() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "foreman-git-")));
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });

  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  // The machine may set core.autocrlf globally, which rewrites line endings on
  // checkout and would make these assertions about file content depend on the
  // host's git config rather than on the code under test.
  git("config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(root, "kept.txt"), "original\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");

  return { root, git };
}

test("runtime artifacts are recognised, real files are not", () => {
  // OpenCode drops these into any directory a session works in. Counting them
  // would attribute junk to the model and leave every repo permanently dirty.
  assert.equal(isRuntimeArtifact(".fef7ffcf7b57e7fe-00000000.node"), true);
  assert.equal(isRuntimeArtifact(".abcdef0123456789-12345678.node"), true);

  assert.equal(isRuntimeArtifact("index.node"), false);
  assert.equal(isRuntimeArtifact("src/binding.node"), false);
  assert.equal(isRuntimeArtifact(".eslintrc.node"), false);
  assert.equal(isRuntimeArtifact("notes.txt"), false);
});

test("a clean repository produces a clean baseline", () => {
  const { root } = makeRepo();
  const baseline = captureBaseline(root);

  assert.equal(baseline.dirty, false);
  assert.deepEqual(baseline.status, []);
  assert.ok(baseline.head);
});

test("a runtime artifact does not make the tree look dirty", () => {
  const { root } = makeRepo();
  fs.writeFileSync(path.join(root, ".fef7ffcf7b57e7fe-00000000.node"), "junk");

  assert.equal(captureBaseline(root).dirty, false, "artifact must not block write delegation");
});

test("a created file is attributed to the agent", () => {
  const { root } = makeRepo();
  const baseline = captureBaseline(root);
  fs.writeFileSync(path.join(root, "created.txt"), "by the agent\n");

  const diff = diffAgainstBaseline(baseline);

  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].path, "created.txt");
  assert.equal(diff.changed[0].reason, "new change");
});

test("a modified tracked file is attributed", () => {
  const { root } = makeRepo();
  const baseline = captureBaseline(root);
  fs.writeFileSync(path.join(root, "kept.txt"), "changed\n");

  const diff = diffAgainstBaseline(baseline);
  assert.deepEqual(
    diff.changed.map((entry) => entry.path),
    ["kept.txt"]
  );
});

test("a file dirty before the agent ran is NOT attributed to it", () => {
  // The reason write delegation refuses a dirty tree by default. When it is
  // allowed anyway, an untouched pre-existing edit must not be credited to
  // the agent.
  const { root } = makeRepo();
  fs.writeFileSync(path.join(root, "kept.txt"), "edited by the user\n");

  const baseline = captureBaseline(root);
  assert.equal(baseline.dirty, true);

  const diff = diffAgainstBaseline(baseline);
  assert.deepEqual(diff.changed, [], "nothing changed since the baseline");
});

test("a file dirty before AND edited again IS attributed", () => {
  const { root } = makeRepo();
  fs.writeFileSync(path.join(root, "kept.txt"), "user edit\n");
  const baseline = captureBaseline(root);

  fs.writeFileSync(path.join(root, "kept.txt"), "user edit then agent edit\n");
  const diff = diffAgainstBaseline(baseline);

  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].reason, "modified again");
});

test("a moved HEAD is reported with the commits that caused it", () => {
  const { root, git } = makeRepo();
  const baseline = captureBaseline(root);

  fs.writeFileSync(path.join(root, "kept.txt"), "committed by the agent\n");
  git("add", "-A");
  git("commit", "-q", "-m", "agent commit");

  const diff = diffAgainstBaseline(baseline);

  assert.equal(diff.headMoved, true);
  assert.notEqual(diff.headAfter, diff.headBefore);
  assert.equal(diff.committedSinceBaseline.length, 1);
  assert.match(diff.committedSinceBaseline[0], /agent commit/);
});

test("revert deletes files the agent created and restores ones it changed", () => {
  const { root } = makeRepo();
  const baseline = captureBaseline(root);

  fs.writeFileSync(path.join(root, "created.txt"), "new\n");
  fs.writeFileSync(path.join(root, "kept.txt"), "mangled\n");

  const diff = diffAgainstBaseline(baseline);
  const outcome = revertPaths(root, baseline, diff.changed);

  assert.deepEqual(outcome.removed, ["created.txt"]);
  assert.deepEqual(outcome.restored, ["kept.txt"]);
  assert.equal(fs.existsSync(path.join(root, "created.txt")), false);
  assert.equal(fs.readFileSync(path.join(root, "kept.txt"), "utf8"), "original\n");
});

test("revert leaves files the job never touched alone", () => {
  // Revert must never widen into a reset. A file outside the job's change set
  // is not its business, however dirty it looks.
  const { root } = makeRepo();
  const baseline = captureBaseline(root);

  fs.writeFileSync(path.join(root, "created.txt"), "agent\n");
  fs.writeFileSync(path.join(root, "unrelated.txt"), "someone else\n");

  const agentOnly = [{ path: "created.txt", code: "??" }];
  revertPaths(root, baseline, agentOnly);

  assert.equal(fs.existsSync(path.join(root, "created.txt")), false);
  assert.equal(fs.readFileSync(path.join(root, "unrelated.txt"), "utf8"), "someone else\n");
});

test("a path with spaces and unicode survives status parsing", () => {
  const { root } = makeRepo();
  const baseline = captureBaseline(root);
  const awkward = "a file with spaces and ünïcödé.txt";
  fs.writeFileSync(path.join(root, awkward), "content\n");

  const diff = diffAgainstBaseline(baseline);
  assert.deepEqual(
    diff.changed.map((entry) => entry.path),
    [awkward]
  );
});

test("capturing a baseline outside a repository fails loudly", () => {
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-norepo-"));
  assert.throws(() => captureBaseline(notRepo), /not a git repository/);
});
