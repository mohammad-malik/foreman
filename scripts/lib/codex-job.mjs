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
import { spawnHiddenDetached } from "./hidden-spawn.mjs";
import {
  findPidsByCommandLine,
  isAlive,
  processCommandLine,
  terminateProcessTree
} from "./process.mjs";
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

  // Windows takes the launcher, which is the only way to get a process that
  // shows no window, keeps its descendants windowless, and still outlives this
  // one. See hidden-spawn.mjs. POSIX has no such problem and keeps the plain
  // detached spawn below.
  if (process.platform === "win32") {
    return {
      pid: startHiddenCodex({ files, args, root, jobID }),
      sandbox: sandboxFor({ write }),
      command: `${codexBinary()} ${args.join(" ")}`,
      ...files
    };
  }

  // Descriptors are opened before the spawn so a failure to open is reported
  // here rather than silently losing the log of a job that is already running.
  // Each one is tracked as it opens: if the second or third throws, the ones
  // already open have to be closed, and a leak inside a long-lived process is
  // not the kind of thing that announces itself.
  const opened = [];
  let child;

  try {
    for (const [file, mode] of [
      [files.taskFile, "r"],
      [files.logFile, "a"],
      [files.errFile, "a"]
    ]) {
      opened.push(fs.openSync(file, mode));
    }

    child = spawn(codexBinary(), args, {
      cwd: root,
      detached: true,
      windowsHide: true,
      stdio: opened
    });
  } finally {
    // The child holds its own duplicates of these.
    for (const fd of opened) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed; nothing to recover.
      }
    }
  }

  // A spawn failure that is not synchronous arrives as an event, and an
  // unhandled "error" event takes the whole process down. That would kill the
  // dispatching session AFTER the job record was written as running, leaving a
  // job that never existed looking like one that is in flight. Recorded to the
  // job's own stderr file instead, which is where judgeCodexJob reads the
  // reason from.
  child.on("error", (error) => {
    try {
      fs.appendFileSync(files.errFile, `failed to start codex: ${error.message}\n`, "utf8");
    } catch {
      // The state directory is gone; there is nowhere left to say so.
    }
  });

  child.unref();

  return {
    pid: child.pid,
    sandbox: sandboxFor({ write }),
    command: `${codexBinary()} ${args.join(" ")}`,
    ...files
  };
}

/**
 * Whether the recorded PID is still OUR codex process.
 *
 * A PID is a weak reference. On a long-lived machine the number gets recycled,
 * and a job whose process died can be looking at something unrelated that
 * happens to hold the same number, reporting "running" forever.
 *
 * The check is exact and free of guesswork: every job passes
 * `--output-last-message <state dir>/codex/<job id>/last-message.txt`, so its
 * own id is in its command line and nothing else's is. Reading a command line
 * costs a subprocess, so ordinary polls defer it until the turn ends.
 */
export function processMatchesJob(job, readCommandLine = processCommandLine) {
  const line = readCommandLine(job.pid);
  if (line === null) {
    return false;
  }
  return line.includes(job.id);
}

/**
 * The Windows launch path. Throws with a stated reason rather than returning a
 * job that was never started: delegate turns that into a failed record.
 */
function startHiddenCodex({ files, args, root, jobID }) {
  const launched = spawnHiddenDetached({
    file: codexBinary(),
    args,
    cwd: root,
    stdin: files.taskFile,
    stdout: files.logFile,
    stderr: files.errFile,
    pidFile: path.join(files.dir, "pid"),
    errFile: path.join(files.dir, "launch-error.txt")
  });

  if (launched.pid) {
    return launched.pid;
  }

  // The launcher may have started codex and died before writing the pid down.
  // The job id is in the command line, via --output-last-message, which is the
  // same fact processMatchesJob relies on.
  const [recovered] = findPidsByCommandLine(jobID);
  if (recovered) {
    return recovered;
  }

  throw new Error(`Could not start codex: ${launched.reason}`);
}

/**
 * Read what a Codex job has produced so far.
 *
 * Works while it runs and after it has gone, because everything is read off
 * disk. A live PID still needs an identity check before settling: the event
 * log having a `turn.completed` in it means the model finished its turn, not
 * that the process has exited.
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
export function judgeCodexJob(job, state, matchesJob = processMatchesJob) {
  // turn.completed once froze the result while codex was still writing files,
  // leaving late edits out of both the report and revert. Wait for our process
  // to exit, but check identity: recycled PIDs previously kept settled jobs
  // running until their budget expired. A lingering process must be checked
  // again on later polls because its PID can be recycled after this check.
  if (state.alive && (!state.parsed.turnDone || matchesJob(job))) {
    return { status: "running", error: null };
  }

  if (state.parsed.turnDone && state.finalText && state.parsed.errors.length === 0) {
    return { status: "completed", error: null };
  }

  // A failed turn is just as terminal as a successful one. Leaving this to the
  // liveness check below meant an explicit `turn.failed` on a recycled PID read
  // as "running" until the budget expired, which is the same bug as the
  // completed case and was missed because the fix only covered success.
  if (state.parsed.turnDone && state.parsed.errors.length > 0) {
    return { status: "failed", error: state.parsed.errors[0] };
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
