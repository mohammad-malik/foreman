/**
 * Running a delegation through the Codex CLI.
 *
 * The OpenCode backend needs a resident server, a session, and a permission
 * channel. This one needs none of that: `codex exec` is one process that starts,
 * works, and exits. That difference is the whole reason this file is short.
 *
 * Two decisions worth knowing about.
 *
 * The process is spawned detached with its output going to file descriptors, so
 * the delegation outlives the Claude session that started it. Nothing is left
 * holding a handle, exactly as with the OpenCode servers, so state is read back
 * from the event log rather than from memory.
 *
 * Nothing is written inside the workspace. The handoff, the event log and the
 * final message all live in the plugin's state directory, because the change set
 * for a job is computed by diffing the repository: a log file dropped next to
 * the code would show up as work the agent did.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { codexBinary, execArgs, parseEventLog, sandboxFor } from "./codex.mjs";
import { isAlive, terminateProcessTree } from "./process.mjs";
import { workspaceStateDir } from "./state.mjs";

/** Per-job scratch directory, outside the repository. */
export function codexJobDir(slug, jobID) {
  const dir = path.join(workspaceStateDir(slug), "codex", jobID);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function codexJobFiles(slug, jobID) {
  const dir = codexJobDir(slug, jobID);
  return {
    dir,
    taskFile: path.join(dir, "task.txt"),
    logFile: path.join(dir, "events.jsonl"),
    errFile: path.join(dir, "stderr.txt"),
    messageFile: path.join(dir, "last-message.txt")
  };
}

/**
 * Start `codex exec` for a job that has already been recorded.
 *
 * The job id comes in rather than out, so the record exists before the process
 * does. A process running against a job that was never written down is
 * untrackable, and that is the one failure mode here worth designing out.
 */
export function startCodexJob({ slug, jobID, model, root, task, write }) {
  const files = codexJobFiles(slug, jobID);

  fs.writeFileSync(files.taskFile, task, "utf8");

  const args = execArgs({ model, root, write, messageFile: files.messageFile });

  // Opened before the spawn so a failure to open is reported here rather than
  // silently losing the log of a job that is already running.
  const stdin = fs.openSync(files.taskFile, "r");
  const stdout = fs.openSync(files.logFile, "a");
  const stderr = fs.openSync(files.errFile, "a");

  let child;
  try {
    child = spawn(codexBinary(), args, {
      cwd: root,
      detached: true,
      windowsHide: true,
      stdio: [stdin, stdout, stderr]
    });
  } finally {
    // The child holds its own duplicates of these descriptors.
    for (const fd of [stdin, stdout, stderr]) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed; nothing to recover.
      }
    }
  }

  child.unref();

  return {
    pid: child.pid,
    sandbox: sandboxFor({ write }),
    command: `${codexBinary()} ${args.join(" ")}`,
    ...files
  };
}

/**
 * Read what a Codex job has produced so far.
 *
 * Works while it runs and after it has gone, because everything is read off
 * disk. `alive` is the authority on whether it is still going: the event log
 * having a `turn.completed` in it means the model finished its turn, not that
 * the process has exited.
 */
export function readCodexJob(job) {
  const files = codexJobFiles(job.slug, job.id);
  const logPath = job.logFile ?? files.logFile;

  let log = "";
  try {
    log = fs.readFileSync(logPath, "utf8");
  } catch {
    // Not started yet, or the state directory was cleared.
  }

  const parsed = parseEventLog(log);

  let lastMessage = null;
  try {
    lastMessage = fs.readFileSync(job.messageFile ?? files.messageFile, "utf8").trim();
  } catch {
    // Written only on a clean finish.
  }

  let stderr = "";
  try {
    stderr = fs.readFileSync(job.errFile ?? files.errFile, "utf8").trim();
  } catch {
    // Usually empty.
  }

  return {
    alive: isAlive(job.pid),
    parsed,
    // The message file is the CLI's own statement of its final answer, so it
    // wins over the text scraped from the event stream.
    finalText: lastMessage || parsed.finalText,
    stderr,
    // A live process that has written nothing is the one failure this backend
    // cannot see any other way. See isStalled.
    silent: log.length === 0
  };
}

/**
 * How long a Codex process may run without emitting a single event before it is
 * treated as stuck rather than busy.
 *
 * A working run writes `thread.started` within a few seconds, every time. The
 * number is generous anyway because the cost of being wrong in one direction is
 * a confusing early failure and in the other is silence.
 */
export const SILENT_GRACE_MS = 5 * 60 * 1000;

/**
 * A process that is alive, and has produced nothing at all, for longer than any
 * working run takes to say hello.
 *
 * This exists because of a real incident: a `codex` on PATH that was a shim
 * around the real binary could not be spawned detached on Windows, so the
 * process started, blocked forever, wrote nothing, and burned 0.06 seconds of
 * CPU over twenty minutes while the job sat at "running". Nothing in the record
 * distinguished that from a model thinking hard. Now something does.
 */
export function isStalled(job, state, now = Date.now()) {
  if (!state.alive || !state.silent) {
    return false;
  }
  const started = Date.parse(job.startedAt ?? job.createdAt ?? "");
  if (Number.isNaN(started)) {
    return false;
  }
  return now - started > SILENT_GRACE_MS;
}

/**
 * Whether a Codex job is finished, and how it ended.
 *
 * A finished process with a completed turn and some text is a success. A
 * finished process without them is a failure, and the reason is taken from the
 * event log's own error events or from stderr rather than invented here.
 */
export function judgeCodexJob(job, state) {
  if (state.alive) {
    return { status: "running", error: null };
  }

  if (state.parsed.turnDone && state.finalText && state.parsed.errors.length === 0) {
    return { status: "completed", error: null };
  }

  const reason =
    state.parsed.errors[0] ??
    (state.stderr ? firstLine(state.stderr) : null) ??
    (state.finalText
      ? "Codex exited before reporting the turn as complete."
      : "Codex exited without producing a final message.");

  return { status: "failed", error: reason };
}

function firstLine(text) {
  return text.split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? null;
}

/** Stop a running Codex job. */
export function cancelCodexJob(job) {
  if (!job.pid || !isAlive(job.pid)) {
    return { killed: false, reason: "the process had already exited" };
  }
  return terminateProcessTree(job.pid);
}
