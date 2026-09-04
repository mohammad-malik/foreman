/**
 * Process liveness and termination.
 *
 * The servers this manages are spawned detached so work survives the Claude
 * session closing, which means nothing is left holding a handle to them. Every
 * later interaction goes through a PID recorded in a lock file, and a PID
 * alone is a weak reference: the process may have exited, and on a long-lived
 * machine the number may have been recycled onto something unrelated. Killing
 * the wrong process because a PID was reused is the failure worth designing
 * against, so callers pair these with the identity checks in servers.mjs.
 */

import { execFileSync, spawnSync } from "node:child_process";

const IS_WINDOWS = process.platform === "win32";

/** True when a process with this PID currently exists. */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    // Signal 0 performs the permission and existence checks without delivering
    // anything. EPERM means it exists but belongs to someone else.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * Kill a process and everything it spawned.
 *
 * OpenCode servers start child processes of their own, so signalling only the
 * parent leaves those behind holding ports. Windows has no process groups to
 * signal, hence `taskkill /T`.
 */
export function terminateProcessTree(pid, { force = false } = {}) {
  if (!isAlive(pid)) {
    return { killed: false, reason: "not running" };
  }

  if (IS_WINDOWS) {
    const args = ["/PID", String(pid), "/T"];
    if (force) {
      args.push("/F");
    }
    const result = spawnSync("taskkill", args, { windowsHide: true, encoding: "utf8" });

    if (result.status === 0) {
      return { killed: true };
    }
    if (!force) {
      // A graceful taskkill is refused for processes with no window, which is
      // every server we start. Escalate rather than reporting a false failure.
      return terminateProcessTree(pid, { force: true });
    }
    return { killed: false, reason: (result.stderr || "").trim() || `taskkill exit ${result.status}` };
  }

  try {
    // Negative PID targets the process group, which detached spawns lead.
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
    return { killed: true };
  } catch {
    try {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
      return { killed: true };
    } catch (error) {
      return { killed: false, reason: error.message };
    }
  }
}

/**
 * Command line of a running process, or null.
 *
 * This is the identity check that makes a recycled PID safe: before killing
 * anything, confirm the process still looks like the OpenCode server that was
 * recorded, not whatever inherited the number afterwards.
 */
export function processCommandLine(pid) {
  if (!isAlive(pid)) {
    return null;
  }

  try {
    if (IS_WINDOWS) {
      const output = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`
        ],
        { encoding: "utf8", timeout: 15_000, windowsHide: true }
      );
      const trimmed = output.trim();
      return trimmed === "" ? null : trimmed;
    }

    const output = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 10_000
    });
    const trimmed = output.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}
