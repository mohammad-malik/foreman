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

/**
 * Files OpenCode itself drops into the directory it is working in.
 *
 * These are bun native-module temp files, named like
 * `.fef7ffcf7b57e7fe-00000000.node`. They appear in any repository a session
 * touches, and they are not the agent's work. Counting them would attribute
 * junk to the model and, worse, leave every repository permanently dirty so
 * the next write delegation is refused for no real reason.
 *
 * The pattern is deliberately narrow: a dot, hex, a dash, eight digits, and
 * the .node suffix, at the top level only. A real file someone meant to keep
 * will not match it.
 */
const RUNTIME_ARTIFACT = /^\.[0-9a-f]{8,}-\d{8}\.node$/;

export function isRuntimeArtifact(filePath) {
  return RUNTIME_ARTIFACT.test(filePath);
}

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

  // Dropped before anything else looks at the list, so neither the dirty check
  // nor the change set ever sees OpenCode's own leftovers.
  return entries.filter((entry) => !isRuntimeArtifact(entry.path));
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
  const contents = Object.create(null);
  const skippedContents = Object.create(null);
  const budget = { remaining: RESTORE_TOTAL_CAP };

  // Whether each dirty path was staged before the job. Restoring the working
  // tree without restoring this leaves the agent's blob in the index, so
  // `git diff --cached` still shows its change and the next commit picks it up.
  const staged = new Set(
    status.filter((entry) => entry.code[0] !== " " && entry.code[0] !== "?").map((entry) => entry.path)
  );

  for (const entry of status) {
    const absolute = path.join(root, entry.path);
    hashes[entry.path] = hashFile(absolute);

    // Keep the content of files that were already dirty, so revert can put
    // them back. Without this an untracked file that existed before the job
    // has nothing to restore from, and the only options are to delete it
    // (losing the user's work) or leave the agent's edit in place.
    const stored = readForRestore(absolute, budget);
    if (stored.kind === "skipped") {
      // Recorded so revert can say why it will not touch this path, instead of
      // silently leaving the agent's edit in place.
      skippedContents[entry.path] = stored.reason;
    } else {
      contents[entry.path] = stored;
    }
  }

  return {
    root,
    head,
    capturedAt: new Date().toISOString(),
    dirty: status.length > 0,
    status,
    hashes,
    contents,
    skippedContents,
    staged: [...staged]
  };
}

/**
 * A copy of a pre-existing dirty file, small enough to keep.
 *
 * Two caps, not one. The per-file cap stops a single large uncommitted asset
 * from landing in a job record; the aggregate cap stops a generated tree of
 * hundreds of sub-megabyte files from serialising hundreds of megabytes, which
 * the per-file cap alone does nothing about.
 *
 * Symlinks are recorded as links rather than followed. `statSync` reports a
 * link to a regular file as a regular file, so reading it would copy the
 * target's bytes, and restoring later would write THROUGH the link, which can
 * clobber a file outside the repository entirely.
 */
const RESTORE_SIZE_CAP = 1024 * 1024;
const RESTORE_TOTAL_CAP = 16 * 1024 * 1024;

function readForRestore(absolutePath, budget) {
  try {
    const stat = fs.lstatSync(absolutePath);

    if (stat.isSymbolicLink()) {
      return { kind: "symlink", target: fs.readlinkSync(absolutePath) };
    }
    if (!stat.isFile()) {
      return { kind: "skipped", reason: "it is not a regular file" };
    }
    if (stat.size > RESTORE_SIZE_CAP) {
      return { kind: "skipped", reason: `it is larger than the ${RESTORE_SIZE_CAP / 1024 / 1024} MB per-file snapshot limit` };
    }
    if (stat.size > budget.remaining) {
      return { kind: "skipped", reason: "the snapshot budget for this job was already full" };
    }

    const content = fs.readFileSync(absolutePath).toString("base64");
    budget.remaining -= stat.size;
    return { kind: "file", content };
  } catch (error) {
    return { kind: "skipped", reason: `it could not be read (${error.code ?? error.message})` };
  }
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

/**
 * Put one path's index entry back the way it was before the job.
 *
 * Restoring file bytes is only half of it. If the agent staged its edit, the
 * index still holds the agent's blob afterwards, so `git diff --cached` shows
 * a change the user never made and the next commit quietly includes it.
 */
function restoreIndexState(root, baseline, filePath) {
  const wasStaged = (baseline.staged ?? []).includes(filePath);

  // Drop whatever the agent staged.
  git(root, ["reset", "-q", "--", filePath], { allowFailure: true });

  if (wasStaged) {
    // It was staged before the job, so put the restored content back in.
    git(root, ["add", "--", filePath], { allowFailure: true });
  }
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

  // Anything dirty when the baseline was taken already existed. Deleting it
  // would destroy the user's own uncommitted work, so those paths are restored
  // from the stored copy and never removed.
  const preExisting = new Set(baseline.status.map((entry) => entry.path));

  for (const entry of changed) {
    const absolute = path.join(root, entry.path);

    if (preExisting.has(entry.path)) {
      const stored = baseline.contents?.[entry.path];
      if (stored === undefined) {
        skipped.push({
          path: entry.path,
          reason: `it had uncommitted changes before the job and ${baseline.skippedContents?.[entry.path] ?? "no copy of it was kept"}`
        });
        continue;
      }

      // Remove first rather than writing over the path. Writing through a
      // symlink follows it, which could overwrite a file outside the
      // repository, and would leave a link where a link should be recreated.
      try {
        if (fs.lstatSync(absolute)) {
          fs.unlinkSync(absolute);
        }
      } catch {
        // Not there any more, which is fine.
      }

      fs.mkdirSync(path.dirname(absolute), { recursive: true });

      if (stored.kind === "symlink") {
        fs.symlinkSync(stored.target, absolute);
      } else {
        fs.writeFileSync(absolute, Buffer.from(stored.content, "base64"));
      }

      restoreIndexState(root, baseline, entry.path);
      restored.push(entry.path);
      continue;
    }

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
      restoreIndexState(root, baseline, entry.path);
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
