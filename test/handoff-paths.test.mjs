/**
 * Paths named in a handoff.
 *
 * Every "not a path" case here is taken from a handoff actually written in this
 * repository. The risk is not missing a path; it is flagging something that was
 * never a path and refusing a legitimate dispatch over it.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { checkNamedPaths, namedPaths } = await import("../scripts/lib/handoff-paths.mjs");

test("finds the paths a handoff actually names", () => {
  const task = [
    "Review scripts/lib/codex.mjs and scripts/lib/codex-job.mjs.",
    "The config lives at config/routes.default.json.",
    "Start from `test/codex.test.mjs`, and see (docs/design.md) for context.",
    'The Windows path tests\\fixtures\\log.jsonl counts too.'
  ].join("\n");

  assert.deepEqual(namedPaths(task), [
    "scripts/lib/codex.mjs",
    "scripts/lib/codex-job.mjs",
    "config/routes.default.json",
    "test/codex.test.mjs",
    "docs/design.md",
    "tests/fixtures/log.jsonl"
  ]);
});

test("things shaped like paths but that are not", () => {
  const task = [
    "See https://github.com/openai/codex-plugin-cc/pull/735 for the upstream fix.",
    "Install @anthropic-ai/sdk and import node:fs.",
    "OpenCode 1.18.16 and codex-cli 0.153.3 are the versions.",
    "My copy is at C:\\Users\\someone\\notes.txt, ignore it.",
    "So is /etc/hosts."
  ].join("\n");

  assert.deepEqual(namedPaths(task), []);
});

test("the same path named twice is reported once", () => {
  const named = namedPaths("Edit src/a.ts. Then run tests on src/a.ts and ./src/a.ts again.");
  assert.deepEqual(named, ["src/a.ts"]);
});

test("a bare filename is not treated as a path", () => {
  // Too weak a signal: "see README.md" or "the package.json" appears in
  // handoffs constantly and is usually a reference, not an instruction to open
  // one exact file. Requiring a separator is what keeps this from crying wolf.
  assert.deepEqual(namedPaths("Check README.md and package.json."), []);
});

test("missing paths are separated from present ones", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ea-paths-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "here.ts"), "", "utf8");

  const result = checkNamedPaths(root, "Edit src/here.ts and src/gone.ts.");

  assert.deepEqual(result.checked, ["src/here.ts", "src/gone.ts"]);
  assert.deepEqual(result.missing, ["src/gone.ts"]);

  fs.rmSync(root, { recursive: true, force: true });
});

test("a path escaping the workspace is not reported as missing", () => {
  // It is out of scope rather than absent, and reporting it as missing would
  // send someone looking for a file that was never meant to be there.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ea-paths-"));
  const result = checkNamedPaths(root, "Compare against ../other/thing.ts please.");

  assert.deepEqual(result.missing, []);

  fs.rmSync(root, { recursive: true, force: true });
});
