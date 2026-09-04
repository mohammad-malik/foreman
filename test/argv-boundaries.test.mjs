import assert from "node:assert/strict";
import test from "node:test";

import { extractOption, extractPath } from "../scripts/lib/tokenize.mjs";

/**
 * Argument boundaries, and why they are never reconstructed.
 *
 * main() used to rebuild the raw argument string as rest.join(" ") so that
 * every command could rescan it. With real argv that destroys boundaries the
 * shell already got right, and the consequence was not cosmetic: delegating a
 * task whose text described the --dir option dispatched a WRITE job to the
 * wrong repository. The task was one argv entry, joining flattened it, and
 * --dir was read out of the prose instead of from the option.
 *
 * So raw is offered only when the arguments genuinely arrived as one entry,
 * which is the slash-command form. These tests pin both readings.
 */

const OPTIONS = [
  "task", "model", "route", "role", "timeout", "dir", "budget",
  "write", "background", "wait", "allow-dirty-tree", "unattended"
];

test("with real argv, an option is not read out of another argument's text", () => {
  // The exact shape that misrouted a write job.
  const argv = ["--dir", String.raw`C:epo`, "--task", "explain --dir behavior"];

  const { value, rest } = extractOption(argv, null, "dir", OPTIONS);

  assert.equal(value, undefined, "no raw string means the parsed reading is the only one");
  assert.deepEqual(rest, argv, "argv is handed back untouched for parseArgs");
});

test("the single-string form still reads the option from the raw text", () => {
  const raw = String.raw`--dir C:epo --task "explain --dir behavior"`;
  assert.equal(extractOption([], raw, "dir", OPTIONS).value, String.raw`C:epo`);
});

test("with real argv, a path with spaces is taken from the argument as given", () => {
  const { path, flags } = extractPath(null, ["allow-external", "force"], [
    String.raw`C:Program Filesepo`,
    "--allow-external"
  ]);

  assert.equal(path, String.raw`C:Program Filesepo`);
  assert.deepEqual([...flags], ["allow-external"]);
});

test("with real argv, flags are still recognised wherever they appear", () => {
  const { path, flags } = extractPath(null, ["allow-external", "force"], [
    "--force",
    String.raw`C:epo`,
    "--allow-external"
  ]);

  assert.equal(path, String.raw`C:epo`);
  assert.deepEqual([...flags].sort(), ["allow-external", "force"]);
});

test("the single-string path form is unchanged", () => {
  const { path, flags } = extractPath(String.raw`C:My  Projectsepo --allow-external`, [
    "allow-external"
  ]);

  assert.equal(path, String.raw`C:My  Projectsepo`, "internal spacing survives");
  assert.deepEqual([...flags], ["allow-external"]);
});
