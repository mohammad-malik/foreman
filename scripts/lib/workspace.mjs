/**
 * Path canonicalization and containment.
 *
 * This is the security boundary for the whole plugin: an external model only
 * ever gets pointed at a directory that survives `assertInside` against a root
 * the user registered by hand. Everything here assumes hostile input.
 *
 * Windows makes this harder than it looks. The same directory can be spelled as
 * an 8.3 short name (PROGRA~1), through a junction or symlink, in any case, as
 * a UNC path, or drive-relative (`C:foo`). `fs.realpathSync.native` collapses
 * the first three and `path.resolve` handles the last, so canonicalization is
 * resolve-then-realpath, and comparison is done on a case-folded key.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const IS_WINDOWS = process.platform === "win32";

/**
 * Absolute, symlink-free, real-case form of a path.
 *
 * A path that does not exist yet still needs a stable form, so we realpath the
 * deepest ancestor that does exist and re-attach the missing tail. That keeps
 * `C:\repo\does-not-exist` canonical with respect to `C:\repo` even when the
 * leaf is absent.
 */
export function canonicalize(inputPath) {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    throw new Error("Path must be a non-empty string.");
  }

  const resolved = path.resolve(inputPath);

  let head = resolved;
  const tail = [];

  for (;;) {
    try {
      const real = fs.realpathSync.native(head);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(head);
      if (parent === head) {
        // Walked to the root without finding anything real. Nothing left to
        // resolve, so the resolved form is the best answer available.
        return resolved;
      }
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

/**
 * Comparison key for a canonical path. Case-folded on Windows, where the
 * filesystem is case-insensitive, and trailing separators stripped so that
 * `C:\repo` and `C:\repo\` are the same place.
 */
export function containmentKey(canonicalPath) {
  let key = canonicalPath;
  if (key.length > 1) {
    key = key.replace(/[\\/]+$/, "");
  }
  return IS_WINDOWS ? key.toLowerCase() : key;
}

/**
 * True when `childPath` is `rootPath` or sits underneath it.
 *
 * The separator check is what stops `C:\repo-evil` from passing as a child of
 * `C:\repo`, which a naive `startsWith` would wave through.
 */
export function isInside(childPath, rootPath) {
  const child = containmentKey(canonicalize(childPath));
  const root = containmentKey(canonicalize(rootPath));

  if (child === root) {
    return true;
  }

  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (child.startsWith(prefix)) {
    return true;
  }

  // Accept a forward-slash spelling of the same boundary. Node hands back
  // backslashes on Windows, but UNC and mixed-separator input reaches us too.
  return child.startsWith(root + "/");
}

/**
 * Containment check that throws with an actionable message instead of
 * returning false. Call sites should prefer this so no caller can forget to
 * branch on the boolean.
 */
export function assertInside(childPath, rootPath, label = "path") {
  if (!isInside(childPath, rootPath)) {
    throw new Error(
      `Refusing to use ${label} ${canonicalize(childPath)}: it is outside the registered workspace ${canonicalize(rootPath)}.`
    );
  }
  return canonicalize(childPath);
}

/**
 * Stable per-workspace directory name: a readable slug plus a hash of the
 * canonical path, so two repos with the same basename never collide.
 */
export function workspaceSlug(canonicalRoot) {
  const key = containmentKey(canonicalRoot);
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  const base = path.basename(canonicalRoot) || "workspace";
  const slug =
    base
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workspace";
  return `${slug}-${hash}`;
}

/** Nearest enclosing git repository root, or null when there is none. */
export function findGitRoot(startPath) {
  let current = canonicalize(startPath);

  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}
