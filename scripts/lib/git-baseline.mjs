/**
 * Change attribution.
 *
 * The point of this file is that a result never says "I changed these files"
 * on the model's authority. An external agent's own summary of its work is a
 * claim; git is the record. So a baseline is taken before the agent starts and
 * the reported change set is the difference between that baseline and the tree
 * afterwards.
 *
 * This is also why write delegation into an already-dirty tree is refused by
 * default. If a file was modified before the agent ran, nothing here can tell
 * the agent's edit from yours, and a change set that quietly mixes the two is
 * worse than no change set.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class GitError extends Error {
  constructor(message) {
    super(message);
    this.name = "GitError";
    this.code = "git_error";
  }
}

function git(root, args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024
    });
  } catch (error) {
    if (allowFailure) {
      return "";
    }
    const stderr = String(error.stderr ?? "").trim();
    throw new GitError(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
}

export function isGitRepository(root) {
  try {
    return git(root, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Parse `git status --porcelain=v1 -z`.
 *
 * NUL separated because filenames can contain anything, newlines and quotes
 * included. The default newline-separated output would silently mis-parse
 * those, and a path parsed wrongly here becomes a file attributed wrongly
 * later.
 */
function parseStatusZ(raw) {
  const entries = [];
  const tokens = raw.split("\0");

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "") {
      continue;
    }

    const code = token.slice(0, 2);
    const filePath = token.slice(3);

    // Renames and copies put the source path in the following NUL-separated
    // field rather than inline.
    if (code[0] === "R" || code[0] === "C") {
      const from = tokens[i + 1] ?? "";
      i += 1;
      entries.push({ code, path: filePath, from });
      continue;
    }

    entries.push({ code, path: filePath });
  }

  return entries;
}

function hashFile(absolutePath) {
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) {
      return null;
    }
    return createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Snapshot the tree before an agent touches it.
 *
 * Dirty files are hashed, not just listed, so a file that was already modified
 * and is then modified again by the agent can still be detected as changed.
 */
export function captureBaseline(root) {
  if (!isGitRepository(root)) {
    throw new GitError(`${root} is not a git repository, so changes cannot be attributed.`);
  }

  const head = git(root, ["rev-parse", "HEAD"], { allowFailure: true }).trim() || null;
  const status = parseStatusZ(git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));

  const hashes = Object.create(null);
  for (const entry of status) {
    hashes[entry.path] = hashFile(path.join(root, entry.path));
  }

  return {
    root,
    head,
    capturedAt: new Date().toISOString(),
    dirty: status.length > 0,
    status,
    hashes
  };
}

export function describeDirty(baseline, limit = 10) {
  const paths = baseline.status.map((entry) => `${entry.code.trim()} ${entry.path}`);
  const shown = paths.slice(0, limit);
  const rest = paths.length - shown.length;
  return rest > 0 ? [...shown, `... and ${rest} more`] : shown;
}

/**
 * What changed since the baseline.
 *
 * Files dirty in the baseline only count as agent-changed when their content
 * hash actually moved, so pre-existing edits are not credited to the agent.
 */
export function diffAgainstBaseline(baseline) {
  const { root } = baseline;
  const head = git(root, ["rev-parse", "HEAD"], { allowFailure: true }).trim() || null;
  const status = parseStatusZ(git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));

  const before = new Map(baseline.status.map((entry) => [entry.path, entry]));
  const changed = [];

  for (const entry of status) {
    const wasDirty = before.has(entry.path);

    if (!wasDirty) {
      changed.push({ path: entry.path, code: entry.code, reason: "new change" });
      continue;
    }

    const nowHash = hashFile(path.join(root, entry.path));
    if (nowHash !== baseline.hashes[entry.path]) {
      changed.push({ path: entry.path, code: entry.code, reason: "modified again" });
    }
  }

  // A file dirty before and clean now was reverted, which is also a change.
  const nowPaths = new Set(status.map((entry) => entry.path));
  for (const entry of baseline.status) {
    if (!nowPaths.has(entry.path)) {
      changed.push({ path: entry.path, code: entry.code, reason: "reverted to committed state" });
    }
  }

  return {
    headBefore: baseline.head,
    headAfter: head,
    headMoved: baseline.head !== head,
    changed: changed.sort((a, b) => a.path.localeCompare(b.path)),
    committedSinceBaseline:
      baseline.head && head && baseline.head !== head
        ? git(root, ["log", "--oneline", `${baseline.head}..${head}`], { allowFailure: true })
            .trim()
            .split(/\r?\n/)
            .filter(Boolean)
        : []
  };
}

/** Compact per-file diffstat for the paths an agent actually touched. */
export function diffStat(root, paths) {
  if (paths.length === 0) {
    return "";
  }
  return git(root, ["diff", "--stat", "--", ...paths], { allowFailure: true }).trim();
}

/**
 * Restore only the paths a job changed.
 *
 * Deliberately narrow: tracked files are checked out from the baseline commit
 * and files the agent created are deleted. Anything the agent did not touch is
 * left alone, so this can never turn into an accidental `git reset --hard`.
 */
export function revertPaths(root, baseline, changed) {
  const restored = [];
  const removed = [];
  const skipped = [];

  for (const entry of changed) {
    const absolute = path.join(root, entry.path);

    // cat-file -e is the existence test. It has to be checked by exit status
    // rather than output, because it prints nothing on success.
    let existedAtBaseline = false;
    if (baseline.head) {
      try {
        execFileSync("git", ["-C", root, "cat-file", "-e", `${baseline.head}:${entry.path}`], {
          stdio: "ignore",
          windowsHide: true
        });
        existedAtBaseline = true;
      } catch {
        existedAtBaseline = false;
      }
    }

    if (existedAtBaseline) {
      git(root, ["checkout", baseline.head, "--", entry.path], { allowFailure: true });
      restored.push(entry.path);
      continue;
    }

    if (fs.existsSync(absolute)) {
      try {
        fs.unlinkSync(absolute);
        removed.push(entry.path);
      } catch (error) {
        skipped.push({ path: entry.path, reason: error.message });
      }
      continue;
    }

    skipped.push({ path: entry.path, reason: "not present and not in the baseline commit" });
  }

  return { restored, removed, skipped };
}
