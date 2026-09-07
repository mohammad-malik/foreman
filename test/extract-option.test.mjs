import assert from "node:assert/strict";
import test from "node:test";

import { extractOption, tokenize } from "../scripts/lib/tokenize.mjs";

/**
 * `--dir` reads its value from the raw argument string rather than from parsed
 * tokens, because parseArgs stops an option value at its first space: an
 * unquoted `--dir C:\Program Files\repo` arrived as `C:\Program` with
 * `Files\repo` stranded in positionals and silently dropped.
 *
 * Written after a delegated fix implemented extractOption but was reaped by
 * its budget before it could add these. The implementation passed all ten
 * cases below on the first run, including `--dir=value`, which was not in the
 * handoff.
 */

// The real option list, as DELEGATE_SPEC declares it.
const OPTIONS = [
  "task",
  "model",
  "route",
  "role",
  "timeout",
  "dir",
  "budget",
  "write",
  "background",
  "wait",
  "allow-dirty-tree",
  "unattended"
];

const dirIn = (raw) => extractOption([], raw, "dir", OPTIONS).value;

test("an unquoted path containing a space is kept whole", () => {
  assert.equal(
    dirIn(String.raw`--task x --dir C:\Program Files\repo`),
    String.raw`C:\Program Files\repo`
  );
});

test("the value ends at the next recognised option, not at the end of the string", () => {
  // The slash command documents `--dir "<repo>" --model ... --task "..."`, so
  // --dir comes first and everything after it must still parse as options.
  // Taking the value to end-of-string would swallow the whole command.
  assert.equal(
    dirIn(String.raw`--dir C:\Program Files\repo --model kimi --write`),
    String.raw`C:\Program Files\repo`
  );
});

test("runs of whitespace inside the value survive", () => {
  // A rejoin cannot reconstruct this, which is why the value is sliced out of
  // the raw string rather than reassembled from tokens.
  assert.equal(
    dirIn(String.raw`--dir C:\My  Projects\repo --model kimi`),
    String.raw`C:\My  Projects\repo`
  );
});

test("an apostrophe in the value survives", () => {
  assert.equal(
    dirIn(String.raw`--dir C:\Users\O'Brien\repo --model kimi`),
    String.raw`C:\Users\O'Brien\repo`
  );
});

test("a quoted value is unquoted", () => {
  assert.equal(
    dirIn(String.raw`--dir "C:\Program Files\repo" --model kimi`),
    String.raw`C:\Program Files\repo`
  );
});

test("the --dir=value form works too", () => {
  assert.equal(
    dirIn(String.raw`--dir=C:\Program Files\repo --model kimi`),
    String.raw`C:\Program Files\repo`
  );
});

test("an empty or blank value reads as omitted, so the caller can default", () => {
  // `""` is not nullish, so `directory ?? process.cwd()` would have handed it
  // to canonicalize, which throws on an empty string.
  assert.equal(dirIn(String.raw`--task x --dir ""`), undefined);
  assert.equal(dirIn("--task x --dir    "), undefined);
  assert.equal(dirIn("--task x"), undefined);
});

test("a value at the very end of the string is taken whole", () => {
  assert.equal(dirIn(String.raw`--model kimi --dir C:\a b\c`), String.raw`C:\a b\c`);
});

test("the option and its value are removed from the remaining argv", () => {
  const { rest } = extractOption(
    ["--dir", "C:\\a", "b\\c", "--model", "kimi"],
    String.raw`--dir C:\a b\c --model kimi`,
    "dir",
    OPTIONS
  );

  assert.equal(rest.includes("--dir"), false, "the option must not be parsed twice");
  assert.deepEqual(rest, ["--model", "kimi"]);
});

test("an unrecognised flag does not terminate the value", () => {
  // Ending the value at any `--something` would silently truncate a path that
  // legitimately contains one. An unknown flag stays part of the value, where
  // it is at least visible in the error rather than quietly dropped.
  assert.equal(
    dirIn(String.raw`--dir C:\repo --nonsense --model kimi`),
    String.raw`C:\repo --nonsense`
  );
});

test("a --dir inside a quoted task is prose, not the option", () => {
  // Token boundaries follow tokenize's rules, so a mention of --dir in the
  // handoff text cannot be mistaken for the option itself.
  assert.equal(
    dirIn(String.raw`--task "explain what --dir does" --dir C:\repo`),
    String.raw`C:\repo`
  );
});

test("the equals form consumes its whole path", () => {
  // `--dir=C:\My Tasks\repo` used to drop only the first token and leave
  // `Tasks\repo` in positionals, where delegate read it as a second task.
  const raw = "--dir=C:\My Tasks\repo --model kimi";
  const { value, rest } = extractOption(tokenize(raw), raw, "dir", ["dir", "model"]);

  assert.equal(value, "C:\My Tasks\repo");
  assert.deepEqual(rest, ["--model", "kimi"]);
});
