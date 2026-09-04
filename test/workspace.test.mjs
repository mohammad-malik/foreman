import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalize,
  containmentKey,
  isInside,
  workspaceSlug
} from "../scripts/lib/workspace.mjs";

const IS_WINDOWS = process.platform === "win32";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("canonicalize returns an absolute path", () => {
  const result = canonicalize(".");
  assert.ok(path.isAbsolute(result));
});

test("canonicalize resolves a path whose leaf does not exist yet", () => {
  const root = tempDir("ea-canon-");
  const missing = path.join(root, "not-created-yet", "deeper");

  const result = canonicalize(missing);

  assert.ok(result.endsWith(path.join("not-created-yet", "deeper")));
  assert.ok(path.isAbsolute(result));
});

test("canonicalize rejects empty input", () => {
  assert.throws(() => canonicalize(""), /non-empty string/);
  assert.throws(() => canonicalize(null), /non-empty string/);
});

test("containmentKey strips trailing separators", () => {
  const withSep = containmentKey(`${path.sep}tmp${path.sep}repo${path.sep}`);
  const without = containmentKey(`${path.sep}tmp${path.sep}repo`);
  assert.equal(withSep, without);
});

test("a directory contains itself", () => {
  const root = tempDir("ea-self-");
  assert.equal(isInside(root, root), true);
});

test("a child directory is inside its parent", () => {
  const root = tempDir("ea-child-");
  const child = path.join(root, "src", "lib");
  fs.mkdirSync(child, { recursive: true });

  assert.equal(isInside(child, root), true);
});

test("a sibling with a shared name prefix is NOT inside", () => {
  // The bug a naive startsWith check would introduce: C:\repo-evil passing as
  // a child of C:\repo. This is the whole reason for the separator boundary.
  const base = tempDir("ea-prefix-");
  const root = path.join(base, "repo");
  const evil = path.join(base, "repo-evil");
  fs.mkdirSync(root);
  fs.mkdirSync(evil);

  assert.equal(isInside(evil, root), false);
});

test("a parent is not inside its own child", () => {
  const root = tempDir("ea-parent-");
  const child = path.join(root, "nested");
  fs.mkdirSync(child);

  assert.equal(isInside(root, child), false);
});

test("relative traversal cannot escape the root", () => {
  const base = tempDir("ea-traverse-");
  const root = path.join(base, "repo");
  const outside = path.join(base, "secrets");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);

  const escape = path.join(root, "..", "secrets", "key.txt");

  assert.equal(isInside(escape, root), false);
});

test("case differences do not defeat containment on Windows", { skip: !IS_WINDOWS }, () => {
  const root = tempDir("ea-case-");
  const child = path.join(root, "Src");
  fs.mkdirSync(child);

  assert.equal(isInside(child.toUpperCase(), root.toLowerCase()), true);
});

test("a junction target is resolved to its real location", { skip: !IS_WINDOWS }, () => {
  const base = tempDir("ea-junction-");
  const real = path.join(base, "real");
  const other = path.join(base, "other");
  fs.mkdirSync(real);
  fs.mkdirSync(other);

  const link = path.join(other, "link-to-real");
  try {
    fs.symlinkSync(real, link, "junction");
  } catch {
    return; // Junction creation can be denied; nothing to assert then.
  }

  // Reached through `other`, but it really lives under `real`, so it must not
  // count as contained by `other`.
  assert.equal(isInside(link, real), true);
  assert.equal(isInside(link, other), false);
});

test("workspaceSlug is stable and collision resistant", () => {
  const base = tempDir("ea-slug-");
  const first = path.join(base, "a", "api");
  const second = path.join(base, "b", "api");
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(second, { recursive: true });

  const one = workspaceSlug(canonicalize(first));
  const two = workspaceSlug(canonicalize(second));

  assert.equal(one, workspaceSlug(canonicalize(first)), "same input, same slug");
  assert.notEqual(one, two, "same basename, different path, different slug");
  assert.match(one, /^api-[0-9a-f]{16}$/);
});

test("workspaceSlug sanitises awkward directory names", () => {
  const slug = workspaceSlug(path.join(path.sep, "tmp", "my repo (v2)"));
  assert.match(slug, /^my-repo-v2-[0-9a-f]{16}$/);
});
