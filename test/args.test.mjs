import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../scripts/lib/args.mjs";

const SPEC = { valueOptions: ["model", "route"], boolOptions: ["wait", "allow-external"] };

test("parses --name value pairs", () => {
  const { options } = parseArgs(["--model", "kimi", "--route", "fast"], SPEC);
  // Spread first: parseArgs returns a null-prototype object on purpose, so a
  // key named "constructor" or "__proto__" cannot be confused for a real one.
  assert.deepEqual({ ...options }, { model: "kimi", route: "fast" });
});

test("parses --name=value pairs", () => {
  const { options } = parseArgs(["--model=kimi"], SPEC);
  assert.equal(options.model, "kimi");
});

test("parses boolean flags without consuming the next token", () => {
  const { options, positionals } = parseArgs(["--wait", "some-job"], SPEC);
  assert.equal(options.wait, true);
  assert.deepEqual(positionals, ["some-job"]);
});

test("collects positionals", () => {
  const { positionals } = parseArgs(["one", "--model", "kimi", "two"], SPEC);
  assert.deepEqual(positionals, ["one", "two"]);
});

test("-- stops option parsing", () => {
  // Task text routinely contains things that look like flags. Everything after
  // -- has to survive verbatim or handoffs get mangled.
  const { options, positionals } = parseArgs(
    ["--model", "kimi", "--", "--route", "is not a flag here"],
    SPEC
  );
  assert.equal(options.model, "kimi");
  assert.deepEqual(positionals, ["--route", "is not a flag here"]);
});

test("rejects unknown options instead of ignoring them", () => {
  assert.throws(() => parseArgs(["--nope", "x"], SPEC), /Unknown option --nope/);
});

test("rejects a value option with no value", () => {
  assert.throws(() => parseArgs(["--model"], SPEC), /needs a value/);
  assert.throws(() => parseArgs(["--model", "--"], SPEC), /needs a value/);
});
