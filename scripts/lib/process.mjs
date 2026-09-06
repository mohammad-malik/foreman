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
      forget(pid);
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
    forget(pid);
    return { killed: true };
  } catch {
    try {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
      forget(pid);
      return { killed: true };
    } catch (error) {
      return { killed: false, reason: error.message };
    }
  }
}

/** Escape a value for a WQL LIKE clause, where % and _ are wildcards. */
function wqlLike(value) {
  // The apostrophe doubling comes first, or it would escape itself.
  return String(value)
    .replace(/'/g, "''")
    .replace(/[%_[]/g, "[$&]");
}

/**
 * Live pids whose command line contains `marker`. Windows only.
 *
 * The recovery path for a launcher that created the process and then died
 * before it could write the pid down. Every job already carries a unique marker
 * in its command line, so this finds the process rather than orphaning it.
 *
 * Our own runtime is excluded by name as well as by pid. A concurrent
 * `external-agents.mjs status <job id>` in another session carries the same
 * marker on its command line, and adopting that as the job's codex process
 * would track the wrong thing.
 */
export function findPidsByCommandLine(marker) {
  if (!IS_WINDOWS) {
    return [];
  }

  try {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        // The querying process's own command line contains the marker, so it
        // has to exclude itself or it always finds a match.
        `(Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${wqlLike(marker)}%' AND NOT CommandLine LIKE '%external-agents.mjs%'" | Where-Object { $_.ProcessId -ne $PID }).ProcessId`
      ],
      { encoding: "utf8", timeout: 15_000, windowsHide: true }
    );

    return output
      .split(/\r?\n/)
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

/**
 * Command lines are cached briefly. Reading one costs a PowerShell start on
 * Windows, about a second, and a single `status` used to pay it once per
 * running server AND once per codex job, then the Stop hook paid it all again
 * on the next turn. The TTL is short because the whole point of reading the
 * command line is to notice a recycled pid, and a cache that outlived the
 * process it described would hide exactly that.
 */
const COMMAND_LINE_TTL_MS = 5_000;
const commandLineCache = new Map();

function remember(pid, line) {
  commandLineCache.set(pid, { line, at: Date.now() });
  return line;
}

function recall(pid) {
  const hit = commandLineCache.get(pid);
  if (hit && Date.now() - hit.at < COMMAND_LINE_TTL_MS) {
    return hit;
  }
  return null;
}

function forget(pid) {
  commandLineCache.delete(pid);
}

/** Drop the cache. Tests use it; nothing else should need to. */
export function clearCommandLineCache() {
  commandLineCache.clear();
}

/**
 * Read several command lines in one subprocess and cache them, so a sweep
 * over five servers costs one PowerShell start rather than five. Windows only;
 * `ps` is cheap enough that POSIX callers just ask one at a time.
 */
export function primeCommandLines(pids) {
  const wanted = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0 && isAlive(pid) && !recall(pid));
  if (!IS_WINDOWS || wanted.length === 0) {
    return;
  }

  try {
    const filter = wanted.map((pid) => `ProcessId=${pid}`).join(" OR ");
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "$($_.ProcessId)" + [char]9 + "$($_.CommandLine)" }`
      ],
      { encoding: "utf8", timeout: 15_000, windowsHide: true }
    );

    const seen = new Set();
    for (const line of output.split(/\r?\n/)) {
      const tab = line.indexOf("\t");
      if (tab === -1) {
        continue;
      }
      const pid = Number.parseInt(line.slice(0, tab), 10);
      const commandLine = line.slice(tab + 1).trim();
      if (Number.isInteger(pid)) {
        seen.add(pid);
        remember(pid, commandLine === "" ? null : commandLine);
      }
    }
    // A pid the query did not return has no readable command line right now.
    for (const pid of wanted) {
      if (!seen.has(pid)) {
        remember(pid, null);
      }
    }
  } catch {
    // Callers fall back to one query per pid.
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
    forget(pid);
    return null;
  }

  const cached = recall(pid);
  if (cached) {
    return cached.line;
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
      return remember(pid, trimmed === "" ? null : trimmed);
    }

    // -ww: unlimited width. Without it macOS truncates to the terminal width,
    // and the identity checks that read this look for a marker at the END of
    // the command line. A truncated line would read as "not our process" and
    // could get a live job killed or failed while it was still working.
    const output = execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 10_000
    });
    const trimmed = output.trim();
    return remember(pid, trimmed === "" ? null : trimmed);
  } catch {
    return null;
  }
}
