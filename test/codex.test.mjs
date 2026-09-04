/**
 * The Codex backend.
 *
 * The event shapes asserted here were captured from a real `codex exec --json`
 * run against codex-cli 0.147.0, not read off the help text. That distinction
 * matters: the first version of the parser was written from the documented
 * flags and looked for fields that do not exist, so it silently reported every
 * job as producing no text.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "ea-codex-"));
process.env.EXTERNAL_AGENTS_STATE_DIR = SCRATCH;
delete process.env.CLAUDE_PLUGIN_DATA;

const { execArgs, parseEventLog, sandboxFor } = await import("../scripts/lib/codex.mjs");
const { codexJobFiles, judgeCodexJob } = await import("../scripts/lib/codex-job.mjs");

// Verbatim from a real run: two shell commands and a closing message.
const LOG = [
  '{"type":"thread.started","thread_id":"01a06e1c-faaa-7490-8258-92f0ee1ce775"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I will run the check."}}',
  '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"git log -1","exit_code":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"git log -1","aggregated_output":"1ac1a70 init\\n","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Appended probe to note.txt."}}',
  '{"type":"turn.completed","usage":{"input_tokens":46008,"cached_input_tokens":39168,"output_tokens":406,"reasoning_output_tokens":142}}'
].join("\n");

test("the last agent message wins, not the first", () => {
  // The opening message is the model saying what it is about to do. Reporting
  // that as the result would describe intentions as outcomes.
  const parsed = parseEventLog(LOG);
  assert.equal(parsed.finalText, "Appended probe to note.txt.");
});

test("commands are collected once each, from item.completed", () => {
  const parsed = parseEventLog(LOG);
  const commands = parsed.tools.filter((tool) => tool.name === "bash");

  // item.started and item.completed both carry the command; counting both
  // would double every tool call in the report.
  assert.equal(commands.length, 1);
  assert.equal(commands[0].detail, "git log -1");
  assert.equal(commands[0].exitCode, 0);
});

test("tokens and thread id come off the stream", () => {
  const parsed = parseEventLog(LOG);

  assert.equal(parsed.threadID, "01a06e1c-faaa-7490-8258-92f0ee1ce775");
  assert.equal(parsed.turnDone, true);
  assert.deepEqual(parsed.tokens, { input: 46008, output: 406, reasoning: 142, cached: 39168 });
});

test("a torn final line does not lose the lines before it", () => {
  // A killed process leaves a half-written line. Everything up to it is still
  // evidence of what ran.
  const truncated = `${LOG.split("\n").slice(0, 5).join("\n")}\n{"type":"item.comp`;
  const parsed = parseEventLog(truncated);

  assert.equal(parsed.finalText, "I will run the check.");
  assert.equal(parsed.turnDone, false);
  assert.equal(parsed.tools.length, 1);
});

test("an unknown event type is ignored rather than treated as a failure", () => {
  const parsed = parseEventLog(`${LOG}\n{"type":"something.new","payload":{"a":1}}`);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.turnDone, true);
});

test("turn.failed is surfaced as an error", () => {
  const parsed = parseEventLog('{"type":"turn.failed","error":{"message":"model overloaded"}}');

  assert.deepEqual(parsed.errors, ["model overloaded"]);
  assert.equal(parsed.turnDone, true);
});

test("the sandbox is read-only unless the job may write", () => {
  assert.equal(sandboxFor({ write: false }), "read-only");
  assert.equal(sandboxFor({ write: true }), "workspace-write");
});

test("the handoff never appears in the argument list", () => {
  const args = execArgs({
    model: "gpt-5.6-luna",
    root: "C:\\repo",
    write: false,
    messageFile: "C:\\state\\last.txt"
  });

  // It goes in on stdin, which is what "-" means here. A long handoff on the
  // command line hits the Windows length limit and every quoting bug going.
  assert.equal(args[0], "exec");
  assert.equal(args[1], "-");
  assert.ok(!args.some((arg) => arg.includes("Review three new files")));
  assert.deepEqual(args.slice(2, 8), [
    "--model",
    "gpt-5.6-luna",
    "--cd",
    "C:\\repo",
    "--sandbox",
    "read-only"
  ]);
  assert.ok(args.includes("--json"));
  assert.ok(args.includes("--skip-git-repo-check"));
});

test("nothing a codex job writes lands inside the workspace", () => {
  // The change set for a job is a git diff of the workspace. A log file dropped
  // next to the code would be reported as work the agent did.
  const files = codexJobFiles("some-slug", "job_abc");

  for (const file of [files.taskFile, files.logFile, files.errFile, files.messageFile]) {
    assert.ok(file.startsWith(SCRATCH), file);
    assert.ok(file.includes("job_abc"), file);
  }
});

test("a live process is running, whatever the log says", () => {
  // turn.completed means the model finished its turn, not that the process has
  // exited. Settling on the log would freeze the change set while codex is
  // still flushing its edits.
  const judged = judgeCodexJob({ pid: 1 }, { alive: true, parsed: parseEventLog(LOG), finalText: "x", stderr: "" });
  assert.equal(judged.status, "running");
});

test("a finished process with a completed turn and text is a success", () => {
  const judged = judgeCodexJob(
    { pid: 1 },
    { alive: false, parsed: parseEventLog(LOG), finalText: "Appended probe.", stderr: "" }
  );

  assert.equal(judged.status, "completed");
  assert.equal(judged.error, null);
});

test("a process that died without finishing fails, with a stated reason", () => {
  const judged = judgeCodexJob(
    { pid: 1 },
    { alive: false, parsed: parseEventLog(""), finalText: null, stderr: "" }
  );

  assert.equal(judged.status, "failed");
  assert.match(judged.error, /without producing a final message/);
});

test("the reason comes from the run itself, not from a guess", () => {
  const fromLog = judgeCodexJob(
    { pid: 1 },
    {
      alive: false,
      parsed: parseEventLog('{"type":"turn.failed","error":{"message":"429 rate limited"}}'),
      finalText: null,
      stderr: "some noise"
    }
  );
  assert.equal(fromLog.error, "429 rate limited");

  const fromStderr = judgeCodexJob(
    { pid: 1 },
    {
      alive: false,
      parsed: parseEventLog(""),
      finalText: null,
      stderr: "error: unrecognized model\nsecond line"
    }
  );
  assert.equal(fromStderr.error, "error: unrecognized model");
});

test("text without a completed turn is not a success", () => {
  // Partial text with no turn.completed means it stopped mid-answer.
  const judged = judgeCodexJob(
    { pid: 1 },
    {
      alive: false,
      parsed: parseEventLog(LOG.split("\n").slice(0, 3).join("\n")),
      finalText: "I will run the check.",
      stderr: ""
    }
  );

  assert.equal(judged.status, "failed");
  assert.match(judged.error, /before reporting the turn as complete/);
});

test("a live process that has written nothing is stuck, not busy", async () => {
  const { isStalled, SILENT_GRACE_MS } = await import("../scripts/lib/codex-job.mjs");
  const started = new Date(Date.now() - SILENT_GRACE_MS - 1000).toISOString();

  // The incident this comes from: a shim on PATH that could not be spawned
  // detached, so codex started, blocked, and wrote nothing for twenty minutes
  // while the job read as "running".
  assert.equal(isStalled({ startedAt: started }, { alive: true, silent: true }), true);

  // Everything else is a normal run and must not be failed.
  assert.equal(isStalled({ startedAt: started }, { alive: true, silent: false }), false);
  assert.equal(isStalled({ startedAt: started }, { alive: false, silent: true }), false);
  assert.equal(
    isStalled({ startedAt: new Date().toISOString() }, { alive: true, silent: true }),
    false
  );
  assert.equal(isStalled({ startedAt: "not a date" }, { alive: true, silent: true }), false);
});
