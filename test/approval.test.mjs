/**
 * Approval, and what it is keyed to.
 *
 * There is no registration step. The only question left is whether a
 * repository's source may leave the machine, and it is asked once. The two
 * things worth pinning down are that a worktree inherits its main checkout's
 * answer, and that inheriting the answer does NOT move the work: a job
 * dispatched at a worktree has to run in that worktree, or a --write job would
 * edit whatever branch the main checkout is sitting on.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function repoWithWorktree() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "foreman-approval-")));
  const git = (args, cwd = root) => execFileSync("git", args, { cwd, stdio: "pipe" });

  git(["init", "-q", "."]);
  git(["commit", "-q", "--allow-empty", "-m", "init"]);
  git(["worktree", "add", "-q", path.join(root, "wt"), "-b", "side"]);

  return { root, worktree: path.join(root, "wt") };
}

async function freshRegistry(stateDir) {
  process.env.FOREMAN_STATE_DIR = stateDir;
  // A fresh module graph per case, since the config path is read at import.
  return import(`../scripts/lib/registry.mjs?case=${encodeURIComponent(stateDir)}`);
}

test("a repository needs no registration, only an answer about egress", async (t) => {
  const { root } = repoWithWorktree();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-state-"));
  const registry = await freshRegistry(stateDir);

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    delete process.env.FOREMAN_STATE_DIR;
  });

  // Local work is never refused, and nothing had to be registered first.
  const local = registry.requireWorkspaceFor(root);
  assert.equal(local.workspace.root, root);
  assert.equal(local.workspace.allowExternal, false);

  // Sending it away is the one thing that asks.
  assert.throws(
    () => registry.requireWorkspaceFor(root, { requireExternal: true }),
    /has not been approved yet/u
  );
});

test("a worktree inherits its main checkout's approval", async (t) => {
  const { root, worktree } = repoWithWorktree();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-state-"));
  const registry = await freshRegistry(stateDir);

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    delete process.env.FOREMAN_STATE_DIR;
  });

  assert.throws(
    () => registry.requireWorkspaceFor(worktree, { requireExternal: true }),
    /has not been approved yet/u
  );

  registry.registerWorkspace(root, { allowExternal: true });

  // Permitted now, and still pointed at the worktree. The approval itself is
  // deliberately NOT copied onto the worktree entry: it is read from the main
  // checkout each time, so revoking it there takes effect here.
  const resolved = registry.requireWorkspaceFor(worktree, { requireExternal: true });

  assert.equal(resolved.workspace.root, worktree);
  assert.equal(resolved.workspace.allowExternal, false);
  assert.equal(registry.approvalOwner(worktree).root, root);
});

test("the refusal names the repository to approve, not the worktree", async (t) => {
  const { root, worktree } = repoWithWorktree();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-state-"));
  const registry = await freshRegistry(stateDir);

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    delete process.env.FOREMAN_STATE_DIR;
  });

  assert.throws(
    () => registry.requireWorkspaceFor(worktree, { requireExternal: true }),
    (error) => error.message.includes(root) && !error.message.includes(worktree)
  );
});

test("approval does not leak between sibling repositories", async (t) => {
  const a = repoWithWorktree();
  const b = repoWithWorktree();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-state-"));
  const registry = await freshRegistry(stateDir);

  t.after(() => {
    fs.rmSync(a.root, { recursive: true, force: true });
    fs.rmSync(b.root, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    delete process.env.FOREMAN_STATE_DIR;
  });

  registry.registerWorkspace(a.root, { allowExternal: true });

  assert.throws(
    () => registry.requireWorkspaceFor(b.worktree, { requireExternal: true }),
    /has not been approved yet/u
  );
});

test("a job dispatched at a worktree runs in that worktree", async (t) => {
  // The main checkout is registered and contains the worktree on disk, so a
  // containment lookup returned the main repository for every worktree path.
  // Every job dispatched from any worktree then ran in the main tree, against
  // files that only exist on the worktree's branch, and the handoff was
  // refused for naming paths that were right there.
  const { root, worktree } = repoWithWorktree();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-state-"));
  const registry = await freshRegistry(stateDir);

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    delete process.env.FOREMAN_STATE_DIR;
  });

  registry.registerWorkspace(root, { allowExternal: true });

  for (const requireExternal of [false, true]) {
    const resolved = registry.requireWorkspaceFor(worktree, { requireExternal });
    assert.equal(resolved.workspace.root, worktree);
  }
});

test("a subdirectory still resolves to its repository root", async (t) => {
  // Containment was right for this case, and dropping it must not break it:
  // a path inside a repository is the repository, because findGitRoot walks up.
  const { root } = repoWithWorktree();
  const nested = path.join(root, "packages", "thing");
  fs.mkdirSync(nested, { recursive: true });

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-state-"));
  const registry = await freshRegistry(stateDir);

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    delete process.env.FOREMAN_STATE_DIR;
  });

  registry.registerWorkspace(root, { allowExternal: true });

  const resolved = registry.requireWorkspaceFor(nested, { requireExternal: true });
  assert.equal(resolved.workspace.root, root);
});

test("revoking the repository revokes its worktrees", async (t) => {
  // A worktree that had already run held its own approved entry, so `deny` on
  // the repository left it delegating happily. Approval is read from the main
  // checkout every time rather than copied down.
  const { root, worktree } = repoWithWorktree();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-state-"));
  const registry = await freshRegistry(stateDir);

  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    delete process.env.FOREMAN_STATE_DIR;
  });

  registry.registerWorkspace(root, { allowExternal: true });
  assert.equal(
    registry.requireWorkspaceFor(worktree, { requireExternal: true }).workspace.root,
    worktree
  );

  registry.registerWorkspace(root, { allowExternal: false });

  assert.throws(
    () => registry.requireWorkspaceFor(worktree, { requireExternal: true }),
    /has not been approved yet/u
  );
});
