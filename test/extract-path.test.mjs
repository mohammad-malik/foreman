import assert from "node:assert/strict";
import test from "node:test";

import { ArgumentError, extractPath, normalizeArgv, tokenize } from "../scripts/lib/tokenize.mjs";

/**
 * Every case here comes from a delegated review of the argument parsing, run
 * through this plugin against its own source. Kimi K3 read the parsing chain
 * and reported ten defects; these pin the ones that were confirmed.
 *
 * The theme is that reassembling a path from split pieces cannot be made
 * correct, so `extractPath` does not do it: flags come off the end of the raw
 * string and the remainder is the path exactly as written.
 */

test("an apostrophe in a path survives, and the flag after it is still parsed", () => {
  // The worst of the reported defects. The old tokenizer treated `'` as an
  // opening quote wherever it appeared, so this collapsed to ONE token with
  // the apostrophe deleted and `--allow-external` folded into the path:
  // silent corruption of the allowlist's own input, with no error.
  const { path, flags } = extractPath(
    String.raw`C:\Users\O'Brien\repo --allow-external`,
    ["allow-external", "force"]
  );

  assert.equal(path, String.raw`C:\Users\O'Brien\repo`);
  assert.deepEqual([...flags], ["allow-external"]);
});

test("runs of whitespace inside a path are preserved exactly", () => {
  // Splitting on whitespace and rejoining with one space turned
  // `C:\My  Projects` into `C:\My Projects`, which could be a real and
  // different directory. Nothing is split now, so nothing is lost.
  const { path } = extractPath(String.raw`C:\My  Projects\repo --force`, ["force"]);
  assert.equal(path, String.raw`C:\My  Projects\repo`);
});

test("a tab inside a path is preserved", () => {
  const { path } = extractPath("C:\\a\tb\\repo", ["force"]);
  assert.equal(path, "C:\\a\tb\\repo");
});

test("a quoted path is unquoted whether or not it contains a space", () => {
  // These used to disagree: the spaced one was unquoted, the spaceless one
  // kept its quote characters and failed as a path literally named `"C:\repo"`.
  assert.equal(extractPath('"C:\\repo"').path, "C:\\repo");
  assert.equal(extractPath('"C:\\Program Files\\repo"').path, "C:\\Program Files\\repo");
});

test("flags are recognised only at the end, and only if known", () => {
  const known = ["allow-external", "force"];

  assert.deepEqual([...extractPath("C:\\repo --allow-external --force", known).flags].sort(), [
    "allow-external",
    "force"
  ]);

  // An unknown trailing flag is part of the path, not silently swallowed.
  const unknown = extractPath("C:\\repo --nonsense", known);
  assert.equal(unknown.path, "C:\\repo --nonsense");
  assert.deepEqual([...unknown.flags], []);
});

test("an empty or blank argument string yields no path, so the caller can default", () => {
  // `server-stop ""` used to reach canonicalize("") and throw, instead of
  // falling back to the current directory the way a bare `server-stop` does.
  assert.equal(extractPath("").path, undefined);
  assert.equal(extractPath("   ").path, undefined);
  assert.equal(extractPath(undefined).path, undefined);
});

test("an unterminated quote is an error, not a silent swallow", () => {
  // It used to produce one garbage token with the flag folded in, so a typo
  // surfaced as a not-exist error naming a path the user never typed.
  assert.throws(() => tokenize('"C:\\Program Files\\repo --force'), ArgumentError);
  assert.throws(() => tokenize("'C:\\repo"), /Unterminated single quote/);
});

test("an apostrophe mid-token does not open a quote", () => {
  assert.deepEqual(tokenize("don't --force"), ["don't", "--force"]);
});

test("a quote at the start of a token still quotes", () => {
  assert.deepEqual(tokenize(`"a b" c`), ["a b", "c"]);
  assert.deepEqual(tokenize("'a b' c"), ["a b", "c"]);
});

test("normalizeArgv unquotes a lone value regardless of whitespace", () => {
  assert.deepEqual(normalizeArgv(['"job_abc"']), ["job_abc"]);
  assert.deepEqual(normalizeArgv(['"C:\\Program Files\\repo"']), ["C:\\Program Files\\repo"]);
  assert.deepEqual(normalizeArgv(["job_abc"]), ["job_abc"]);
});

test("normalizeArgv leaves real argv alone", () => {
  assert.deepEqual(normalizeArgv(["C:\\a", "--force"]), ["C:\\a", "--force"]);
  assert.deepEqual(normalizeArgv([]), []);
});

test("a non-breaking space is treated as whitespace by both halves", () => {
  // The two used to disagree: normalizeArgv's /\s/ matched U+00A0 and decided
  // to split, but tokenize only split on space, tab and newline, so the NBSP
  // stayed inside the token and a job id lookup failed on an invisible
  // character. Pasted NBSPs are common.
  const nbsp = "\u00A0";
  assert.deepEqual(tokenize(`job_abc${nbsp}`), ["job_abc"]);
  assert.deepEqual(normalizeArgv([`job_abc${nbsp}`]), ["job_abc"]);
});
