/**
 * Commands a handoff tells a read-only agent to run.
 *
 * The cost of a false positive is a refused dispatch the user has to argue
 * with, so the "not an instruction" cases below matter more than the hits.
 */

import assert from "node:assert/strict";
import test from "node:test";

const { commandInstructions } = await import("../scripts/lib/handoff-commands.mjs");

test("catches the labelled block that broke a real job", () => {
  const task = [
    "Check the manifests and report what you find.",
    "",
    "Commands that prove the work: run these and include their raw output.",
    "  git grep -n -i \"external.agents\"",
    "  npm test",
    "",
    "A finished answer is a verdict plus the evidence."
  ].join("\n");

  const found = commandInstructions(task);

  assert.equal(found.length, 3);
  assert.match(found[0], /Commands that prove the work/u);
  assert.ok(found.includes("npm test"));
});

test("catches an imperative in a sentence", () => {
  assert.deepEqual(commandInstructions("Then run `npm test` and paste the summary."), [
    "Then run `npm test` and paste the summary."
  ]);
});

test("prose about a command is not an instruction to run it", () => {
  // Every one of these appears in handoffs that a researcher can complete.
  const task = [
    "The suite is driven by npm test, which is wired up in package.json.",
    "Tests live under test/ and the runner is node --test.",
    "Explain why the git history shows two renames."
  ].join("\n");

  assert.deepEqual(commandInstructions(task), []);
});

test("an imperative with nothing runnable is left alone", () => {
  const task = [
    "Run through the auth flow in your head and say where it breaks.",
    "Execute on the plan in the order given."
  ].join("\n");

  assert.deepEqual(commandInstructions(task), []);
});

test("the block ends when prose resumes at the left margin", () => {
  const task = [
    "Commands to run:",
    "  npm test",
    "Report what the config file contains."
  ].join("\n");

  const found = commandInstructions(task);

  assert.ok(found.includes("npm test"));
  assert.ok(!found.some((line) => line.startsWith("Report what")));
});

test("the same line is reported once", () => {
  const found = commandInstructions("Run npm test.\nRun npm test.");
  assert.deepEqual(found, ["Run npm test."]);
});

test("empty and absent handoffs are not instructions", () => {
  assert.deepEqual(commandInstructions(""), []);
  assert.deepEqual(commandInstructions(null), []);
  assert.deepEqual(commandInstructions(undefined), []);
});

test("a prohibition is not a request to run anything", () => {
  // A good read-only handoff says this out loud. Reading it as a request
  // would refuse exactly the handoffs that got the rule right.
  const task = [
    "Do not run npm test; inspect the source only.",
    "Never execute git commands.",
    "You cannot run the build, so do not try."
  ].join("\n");

  assert.deepEqual(commandInstructions(task), []);
});

test("a writing task that mentions commands is not an instruction", () => {
  const task = [
    "Document the supported commands: describe their arguments.",
    "List the commands the CLI exposes: one line each."
  ].join("\n");

  assert.deepEqual(commandInstructions(task), []);
});

test("a prohibition closes an open block", () => {
  const task = [
    "Commands to run:",
    "  npm test",
    "Do not run anything else.",
    "  npm run build"
  ].join("\n");

  const found = commandInstructions(task);

  assert.ok(found.includes("npm test"));
  assert.ok(!found.includes("npm run build"));
});

test("run as a subcommand is not the verb run", () => {
  // `npm run build` contains "run", and reading that as an instruction turned
  // every mention of the command into a refusal.
  const task = [
    "The bundle is produced by npm run build, wired up in package.json.",
    "Explain what npm run lint checks."
  ].join("\n");

  assert.deepEqual(commandInstructions(task), []);
});

test("a bulleted instruction is still an instruction", () => {
  // The commonest shape a handoff uses. Anchoring to the raw line missed
  // every one of them, so the check passed handoffs it exists to catch.
  const task = [
    "- Run npm test and report the output.",
    "* Execute git status before you start.",
    "1. Run eslint and quote any errors."
  ].join("\n");

  const found = commandInstructions(task);

  assert.equal(found.length, 3);
  assert.ok(found[0].startsWith("- Run npm test"));
});

test("commands the caller runs afterwards are not the agent's job", () => {
  // The delegating guidance asks for exactly this, so refusing it would
  // reject the handoffs that took the advice.
  const task = [
    "Commands run by the caller after your report:",
    "  npm test",
    "  git diff --stat"
  ].join("\n");

  assert.deepEqual(commandInstructions(task), []);
});

test("the caller running things later does not excuse an agent instruction", () => {
  const task = [
    "I will run npm test myself once you are done.",
    "Run npm test and paste its output."
  ].join("\n");

  assert.deepEqual(commandInstructions(task), ["Run npm test and paste its output."]);
});

test("naming who reads the output is not naming who runs it", () => {
  // "by the caller" assigns the work; "for the reviewer" only says who reads
  // the result, and reading that as an exemption let a real request through.
  assert.deepEqual(commandInstructions("Run npm test for the reviewer and paste the output."), [
    "Run npm test for the reviewer and paste the output."
  ]);
});

test("asking for suggested commands is not asking for them to be run", () => {
  const task = "List commands to run: include suggested verification in your report, without executing anything.";
  assert.deepEqual(commandInstructions(task), []);
});

test("a prohibition does not excuse a request in the same line", () => {
  // One line, two clauses. Letting the first suppress the second turned any
  // handoff that mentioned something forbidden into a free pass.
  assert.deepEqual(commandInstructions("Do not run npm test. Run git status instead."), [
    "Do not run npm test. Run git status instead."
  ]);
});

test("asking the agent to suggest commands is report content", () => {
  const task = [
    "Suggest commands to run: include these in your report for later verification.",
    "Document the commands that verify this change."
  ].join("\n");

  assert.deepEqual(commandInstructions(task), []);
});

test("the second person addresses the agent, not the caller", () => {
  // "you" in a handoff is who the handoff was written for.
  const task = [
    "You should run npm test and report the output.",
    "You will need to run git status first."
  ].join("\n");

  assert.equal(commandInstructions(task).length, 2);
});

test("a quoted command in documentation is not an instruction", () => {
  const task = [
    'Review the README text: "Run npm test" and report whether it matches the package scripts.',
    "Quote the line that reads `run npm ci` and say which file it is in."
  ].join("\n");

  assert.deepEqual(commandInstructions(task), []);
});

test("an idiom that happens to contain a command name is not an instruction", () => {
  const task = [
    "Run through the git authentication flow in your head and say where it breaks.",
    "Run the numbers again on the cache hit rate."
  ].join("\n");

  assert.deepEqual(commandInstructions(task), []);
});

test("a fenced excerpt is source material, not instruction", () => {
  // Reviewing documentation for accuracy means quoting it. Reading the
  // excerpt as the instruction refused exactly that job.
  const task = [
    "Check whether the README matches the package scripts.",
    "",
    "```",
    "Run npm test",
    "npm run build",
    "```",
    "",
    "Read files only."
  ].join("\n");

  assert.deepEqual(commandInstructions(task), []);
});

test("an instruction after a fence still counts", () => {
  const task = ["```", "npm test", "```", "Run npm test and paste the output."].join("\n");

  assert.deepEqual(commandInstructions(task), ["Run npm test and paste the output."]);
});

test("prose about what something else runs is not an instruction", () => {
  // The subject matters: this describes a build system rather than asking the
  // agent for anything.
  const task = [
    "The CI job will run npm test. Check its configuration by reading files only.",
    "The release script will run git tag on merge."
  ].join("\n");

  assert.deepEqual(commandInstructions(task), []);
});

test("a quoted instruction addressed to someone else is quoted text", () => {
  const task =
    'Review the README text: "First run npm test" and report whether it matches the package scripts.';

  assert.deepEqual(commandInstructions(task), []);
});

test("a quoted command whose subcommand is run is still a command", () => {
  // `npm run build` carries "run" as a subcommand. Treating the quoted span
  // as prose removed the very command being asked for.
  assert.deepEqual(commandInstructions("Run `npm run build` and report the output."), [
    "Run `npm run build` and report the output."
  ]);
});

test("a quoted heading belongs to the document being reviewed", () => {
  const task =
    'Review the README heading "Commands to run:" and check whether its list matches package.json.';

  assert.deepEqual(commandInstructions(task), []);
});

test("a multi-sentence quotation stays one unit", () => {
  // Splitting through the quotation separated it into clauses that had each
  // lost the quotes making them someone else's instruction.
  const task =
    'Review this README excerpt for accuracy: "Run npm ci. Then run npm test." Read files only.';

  assert.deepEqual(commandInstructions(task), []);
});

test("a quoted second-person instruction is still quoted text", () => {
  const task =
    'Review the README text: "You should run npm test" and check it against package.json.';

  assert.deepEqual(commandInstructions(task), []);
});

test("a blockquote is quoted source material", () => {
  // Its marker used to be stripped as though it were a list bullet, turning
  // a quoted line into this handoff's own instruction.
  const task = [
    "Review this README excerpt for accuracy:",
    "> Run npm test",
    "Read files only."
  ].join("\n");

  assert.deepEqual(commandInstructions(task), []);
});

test("what another actor does is a description, not an instruction", () => {
  // Without the subject, the "and" opening the second half read as a fresh
  // instruction to the agent.
  const task = [
    "The CI will install dependencies and run npm test. Read its configuration only.",
    "The release script runs git tag on merge."
  ].join("\n");

  assert.deepEqual(commandInstructions(task), []);
});

test("an instruction joined by and is still an instruction", () => {
  assert.deepEqual(commandInstructions("Read the config and run npm test."), [
    "Read the config and run npm test."
  ]);
});

test("a reporting request excuses only itself", () => {
  // Both clauses open as reporting tasks and end as execution requests.
  // Exempting the whole clause on its first half let the second half reach an
  // agent with no shell.
  const task = [
    "List the changed files and run git status.",
    "Explain the failure, then run npm test."
  ].join("\n");

  assert.equal(commandInstructions(task).length, 2);
});

test("a runner outside the known list is still a command", () => {
  // A fixed list of program names cannot be complete, and `bun test` was
  // passing straight through to an agent with no shell.
  const task = ["Run bun test and report the result.", "Execute deno lint."].join("\n");

  assert.equal(commandInstructions(task).length, 2);
});

test("a repository's own script is a command", () => {
  const task = [
    "Run ./verify.sh and paste the output.",
    "Execute scripts/check.py against the fixtures.",
    "Run build.ps1 first."
  ].join("\n");

  assert.equal(commandInstructions(task).length, 3);
});

test("widening the list did not swallow ordinary prose", () => {
  // The path pattern is the risky one: it must not match every hyphenated
  // word or every sentence with a slash in it.
  const task = [
    "Run through the sign-up flow and describe it.",
    "Explain the read/write split.",
    "The CI will run bun test on merge.",
    "Do not run ./verify.sh."
  ].join("\n");

  assert.deepEqual(commandInstructions(task), []);
});
