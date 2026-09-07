import assert from "node:assert/strict";
import test from "node:test";

import { normalizeArgv, tokenize } from "../scripts/lib/tokenize.mjs";

/**
 * A slash command substitutes `$ARGUMENTS` textually into a shell command line.
 * Unquoted, bash eats a Windows path's backslashes; quoted, the whole string
 * arrives as a single argv entry. These pin the second half of that fix.
 *
 * Written with String.raw throughout. Backslash-heavy expectations are exactly
 * where a stray escaping layer hides, and getting one wrong here would pin the
 * wrong behaviour rather than catch it.
 */

test("a Windows path survives with its backslashes intact", () => {
  // The real failure: `register C:\Users\MohammadMalik\Documents\Codex\x`
  // arrived as `UsersMohammadMalikDocumentsCodexx` and resolved against cwd.
  const argv = tokenize(
    String.raw`C:\Users\MohammadMalik\Documents\Codex\foreman --allow-external`
  );

  assert.deepEqual(argv, [
    String.raw`C:\Users\MohammadMalik\Documents\Codex\foreman`,
    "--allow-external"
  ]);
});

test("backslash is a path separator, not an escape character", () => {
  assert.deepEqual(tokenize(String.raw`C:\a\b`), [String.raw`C:\a\b`]);

  // A trailing backslash does not join the next word. Quoting is the way to
  // include a space; treating backslash as an escape is the original bug.
  //
  // Ordinary quoted strings here, not String.raw: a template literal cannot
  // contain a backslash immediately before its closing backtick, because the
  // backslash escapes the backtick and the literal never terminates. That
  // exact mistake left this file unparseable and reported the error nine lines
  // away from its cause.
  assert.deepEqual(tokenize("a\\ b"), ["a\\", "b"]);
});

test("a trailing backslash is preserved", () => {
  // Windows directory paths are routinely written with one.
  assert.deepEqual(tokenize("C:\\repo\\"), ["C:\\repo\\"]);
});

test("quoting is how a path with spaces is passed", () => {
  assert.deepEqual(tokenize(String.raw`"C:\Program Files\repo" --force`), [
    String.raw`C:\Program Files\repo`,
    "--force"
  ]);
  assert.deepEqual(tokenize("'my repo' --force"), ["my repo", "--force"]);
});

test("multiple arguments split on whitespace", () => {
  assert.deepEqual(tokenize("job_abc per_xyz allow"), ["job_abc", "per_xyz", "allow"]);
  assert.deepEqual(tokenize("  spaced   out  "), ["spaced", "out"]);
});

test("an empty or blank string yields no arguments", () => {
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("   "), []);
  assert.deepEqual(tokenize(null), []);
});

test("an explicitly empty quoted argument is preserved", () => {
  assert.deepEqual(tokenize('"" x'), ["", "x"]);
});

test("normalizeArgv splits a single combined entry", () => {
  assert.deepEqual(normalizeArgv([String.raw`C:\a\b --force`]), [String.raw`C:\a\b`, "--force"]);
});

test("normalizeArgv leaves ordinary argv alone", () => {
  // Running the runtime directly must keep working.
  assert.deepEqual(normalizeArgv([String.raw`C:\a\b`, "--force"]), [
    String.raw`C:\a\b`,
    "--force"
  ]);
  assert.deepEqual(normalizeArgv(["job_abc"]), ["job_abc"]);
  assert.deepEqual(normalizeArgv([]), []);
});

test("a lone quoted path with spaces stays one argument", () => {
  // The case that matters for `register "C:\Program Files\repo"`: the quotes
  // reach the runtime, so the path must not be split on its space.
  assert.deepEqual(normalizeArgv([String.raw`"C:\Program Files\repo"`]), [
    String.raw`C:\Program Files\repo`
  ]);
});
