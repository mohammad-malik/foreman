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
import { createHash, randomBytes } from "node:crypto";
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

  // The exact index entry for each staged path, not merely the fact that it
  // was staged. A partially staged file (status MM) holds different content in
  // the index and the working tree, so rebuilding the index by re-adding the
  // working tree would stage hunks the user deliberately left out.
  //
  // Read in one call. A per-path loop spawns a git process and re-opens the
  // index for every file, which on a generated tree with thousands of staged
  // paths turns baseline capture into a stall before the job even starts.
  const indexEntries = Object.create(null);
  const stagedPaths = new Set(
    status.filter((entry) => entry.code[0] !== " " && entry.code[0] !== "?").map((entry) => entry.path)
  );

  if (stagedPaths.size > 0) {
    const raw = git(root, ["ls-files", "-s", "-z"], { allowFailure: true });
    for (const record of raw.split("\0")) {
      if (record === "") {
        continue;
      }
      // Object IDs are 40 hex characters in a SHA-1 repository and 64 in one
      // created with --object-format=sha256, so the length is not assumed.
      const match = record.match(/^(\d{6}) ([0-9a-f]{40,64}) (\d)	([\s\S]*)$/);
      if (match && match[3] === "0" && stagedPaths.has(match[4])) {
        indexEntries[match[4]] = { mode: match[1], blob: match[2] };
      }
    }
  }

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
    indexEntries
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
    // Mode is kept so a restored script does not come back non-executable.
    return { kind: "file", content, mode: stat.mode };
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
 * Read a stored snapshot into something writable.
 *
 * Accepts both shapes deliberately. Job records persist across upgrades, and
 * an older release stored a snapshot as a bare base64 string; refusing to
 * understand that would strand every job written before the upgrade.
 */
function decodeSnapshot(stored) {
  if (typeof stored === "string") {
    return { kind: "file", buffer: Buffer.from(stored, "base64"), mode: null };
  }

  if (stored?.kind === "symlink" && typeof stored.target === "string") {
    return { kind: "symlink", target: stored.target };
  }

  if (stored?.kind === "file" && typeof stored.content === "string") {
    return {
      kind: "file",
      buffer: Buffer.from(stored.content, "base64"),
      mode: typeof stored.mode === "number" ? stored.mode : null
    };
  }

  throw new Error("unrecognised snapshot format");
}

/**
 * Put a decoded snapshot back on disk.
 *
 * A symlink is unlinked and recreated, because writing to it would follow it
 * and could clobber a file outside the repository. A regular file is written
 * in place, which preserves its inode and its mode; the recorded mode is
 * reapplied anyway so an executable bit survives even when the file had to be
 * created fresh.
 */
function writeSnapshot(absolute, replacement, { resolveLegacyMode = () => null } = {}) {
  fs.mkdirSync(path.dirname(absolute), { recursive: true });

  let current = null;
  try {
    current = fs.lstatSync(absolute);
  } catch {
    current = null;
  }

  if (replacement.kind === "symlink") {
    if (current) {
      fs.unlinkSync(absolute);
    }
    fs.symlinkSync(replacement.target, absolute);
    return;
  }

  // Write to a sibling temp file and rename over the target, rather than
  // writing in place. Writing in place would follow a hard link: if the agent
  // replaced the path with a link to a file elsewhere on disk, an in-place
  // write truncates that other inode, so reverting inside the repository could
  // destroy a file outside it. A rename replaces the directory entry and
  // touches nothing the old inode was also linked to.
  //
  // The temp path must be created exclusively, or the hole simply moves: the
  // name is predictable, and a process that dropped a symlink or hard link
  // there would have it followed and truncated instead. "wx" fails rather than
  // opening an existing entry, and a random name means a leftover temp file
  // cannot collide either.
  //
  // The name is fixed-length rather than derived from the target's, because
  // most filesystems cap a single path component at 255 bytes: appending to an
  // already-long basename fails with ENAMETOOLONG, and revert would skip the
  // file and leave the agent's version in place. It stays in the same
  // directory so the rename is still atomic.
  const tmp = path.join(
    path.dirname(absolute),
    `.ea-restore-${randomBytes(8).toString("hex")}.tmp`
  );

  // Mode. `replacement.mode` is genuine pre-job state. Anything else is not:
  // the mode on disk right now is whatever the agent left behind, so a
  // `chmod 777` or `chmod 000` would be preserved as though it were original.
  // Legacy records predate the mode field, so the answer there is 0600 unless
  // git can supply the real pre-job mode.
  // Resolved lazily. Looking up git's recorded mode costs a subprocess per
  // file, and it is needed only for a legacy snapshot on POSIX. Computing it
  // eagerly turned a large dirty-tree revert into one `git ls-tree` per path,
  // including on Windows where the result is discarded.
  let mode = null;
  if (process.platform !== "win32") {
    mode = replacement.mode !== null ? replacement.mode & 0o777 : (resolveLegacyMode() ?? 0o600);
  }

  try {
    fs.writeFileSync(tmp, replacement.buffer, { flag: "wx", mode: mode ?? 0o600 });

    // chmod explicitly: the mode passed at creation is masked by the umask, so
    // a restrictive umask would otherwise turn a 0644 snapshot into 0600.
    if (mode !== null) {
      fs.chmodSync(tmp, mode);
    }

    fs.renameSync(tmp, absolute);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Nothing to clean up.
    }
    throw error;
  }
}

/**
 * The file mode git recorded before the job, or null.
 *
 * Only used for legacy snapshots, which predate the mode field. Unlike the
 * mode currently on disk, this is genuine pre-job state: it comes from the
 * index as captured at baseline, or from the baseline commit. For a file that
 * was never tracked there is nothing to consult, and the caller falls back to
 * something conservative rather than trusting whatever the agent left.
 */
function gitRecordedMode(root, baseline, filePath) {
  const fromIndex = baseline.indexEntries?.[filePath]?.mode;
  if (fromIndex) {
    return gitModeToPosix(fromIndex);
  }

  if (!baseline.head) {
    return null;
  }

  const line = git(root, ["ls-tree", baseline.head, "--", filePath], { allowFailure: true }).trim();
  const match = line.match(/^(\d{6}) /);
  return match ? gitModeToPosix(match[1]) : null;
}

/** Git stores only two file modes: executable and not. */
function gitModeToPosix(gitMode) {
  if (gitMode === "100755") {
    return 0o755;
  }
  if (gitMode === "100644") {
    return 0o644;
  }
  return null;
}

/**
 * Put one path's index entry back the way it was before the job.
 *
 * Restoring file bytes is only half of it. If the agent staged its edit, the
 * index still holds the agent's blob afterwards, so `git diff --cached` shows
 * a change the user never made and the next commit quietly includes it.
 */
function restoreIndexState(root, baseline, filePath) {
  const entry = baseline.indexEntries?.[filePath];

  // Drop whatever the agent staged.
  git(root, ["reset", "-q", "--", filePath], { allowFailure: true });

  if (entry) {
    // Put back the exact blob that was staged, rather than re-adding the
    // working tree. For a partially staged file those differ, and re-adding
    // would stage hunks the user had deliberately kept out of the index.
    git(root, ["update-index", "--add", "--cacheinfo", `${entry.mode},${entry.blob},${filePath}`], {
      allowFailure: true
    });
    return;
  }

  // A record written by 0.3.0 has `staged` but no `indexEntries`. Without this
  // the reset above would silently unstage work the user had staged before the
  // job, so the older, coarser signal is honoured when it is all we have.
  if ((baseline.staged ?? []).includes(filePath)) {
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
export function revertPaths(root, baseline, changed, { resolveLegacyMode = gitRecordedMode } = {}) {
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

      // Decide everything BEFORE touching the disk. An earlier version of this
      // deleted the path first and then decoded the snapshot, so a job record
      // written by an older release, where a snapshot was a bare base64
      // string rather than an object, threw on the decode after the user's
      // file was already gone. Nothing is unlinked until the replacement bytes
      // are in hand.
      let replacement;
      try {
        replacement = decodeSnapshot(stored);
      } catch (error) {
        skipped.push({
          path: entry.path,
          reason: `its saved copy could not be read (${error.message}), so it was left untouched`
        });
        continue;
      }

      try {
        writeSnapshot(absolute, replacement, {
          resolveLegacyMode: () => resolveLegacyMode(root, baseline, entry.path)
        });
        restoreIndexState(root, baseline, entry.path);
        restored.push(entry.path);
      } catch (error) {
        skipped.push({ path: entry.path, reason: error.message });
      }
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
