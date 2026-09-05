/**
 * Starting a long-lived child on Windows without putting a console on screen.
 *
 * The obvious spawn is wrong in a way that took a night to find. `detached: true`
 * sets DETACHED_PROCESS, which gives the child no console AT ALL. Windows then
 * creates a fresh, visible console for every console-subsystem process that a
 * console-less parent launches. So a detached `codex exec` did not merely leave
 * one window open: every shell command the agent ran inside its own sandbox
 * popped a window of its own, for the life of the job.
 *
 * `windowsHide` did not help either. libuv only adds CREATE_NO_WINDOW when no
 * stdio entry is an inherited file descriptor, and both call sites here redirect
 * to log files, so the flag was never actually set. Microsoft also documents
 * CREATE_NO_WINDOW as ignored alongside DETACHED_PROCESS, so it could not have
 * helped even if it had been set.
 *
 * The fix inverts the approach: give the job tree ONE console that has no
 * window, and let every descendant inherit it. A console process created without
 * CREATE_NEW_CONSOLE, DETACHED_PROCESS or CREATE_NO_WINDOW attaches to its
 * parent's console, so codex's shell children and opencode's tool processes all
 * land on the windowless one and never allocate their own.
 *
 * Survival comes from ancestry rather than from detaching. libuv creates its job
 * object with JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK, so only DIRECT children join
 * it. Launching through a short-lived PowerShell makes the real process a
 * grandchild, which is never in the job and outlives this process. That also
 * explains an earlier experiment where simply dropping `detached` killed the
 * child the moment node exited: it was a direct child.
 *
 * Designed by a Fable 5.1 agent from the libuv and Win32 documentation, then
 * implemented and tested here.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * The launcher script, a constant.
 *
 * Every value arrives through the environment rather than through string
 * interpolation, so there is no quoting to get wrong, nothing an antivirus can
 * read as an encoded command, and no way for a path with a quote in it to
 * change what runs.
 *
 * `-NoNewWindow` is what attaches the child to PowerShell's own windowless
 * console. `-WindowStyle Hidden` is NOT used: it goes through CREATE_NEW_CONSOLE
 * plus SW_HIDE, which is normally honoured but has a history of being ignored
 * when Windows Terminal is the default terminal application.
 */
const LAUNCHER = [
  "$ErrorActionPreference = 'Stop'",
  "try {",
  "  $o = @{",
  "    FilePath = $env:EA_SPAWN_FILE",
  "    WorkingDirectory = $env:EA_SPAWN_CWD",
  "    NoNewWindow = $true",
  "    PassThru = $true",
  "    RedirectStandardInput = $env:EA_SPAWN_STDIN",
  "    RedirectStandardOutput = $env:EA_SPAWN_STDOUT",
  "    RedirectStandardError = $env:EA_SPAWN_STDERR",
  "  }",
  "  if ($env:EA_SPAWN_ARGLINE) { $o.ArgumentList = $env:EA_SPAWN_ARGLINE }",
  "  $p = Start-Process @o",
  "  [IO.File]::WriteAllText($env:EA_SPAWN_PIDFILE, [string]$p.Id)",
  "  exit 0",
  "} catch {",
  "  [IO.File]::WriteAllText($env:EA_SPAWN_ERRFILE, $_.Exception.Message)",
  "  exit 1",
  "}"
].join("\n");

/**
 * Quote one argument the way CommandLineToArgvW unquotes it.
 *
 * PowerShell 5.1 passes an ArgumentList string through without quoting it, so
 * the quoting has to happen here. Backslashes only escape a following quote,
 * which is why they are doubled before one and left alone otherwise.
 */
export function quoteWindowsArg(arg) {
  const text = String(arg);
  if (text !== "" && !/[\s"]/.test(text)) {
    return text;
  }

  let out = '"';
  let slashes = 0;

  for (const ch of text) {
    if (ch === "\\") {
      slashes += 1;
      continue;
    }
    if (ch === '"') {
      out += "\\".repeat(slashes * 2 + 1) + '"';
      slashes = 0;
      continue;
    }
    out += "\\".repeat(slashes) + ch;
    slashes = 0;
  }

  return `${out}${"\\".repeat(slashes * 2)}"`;
}

/**
 * Absolute path for a command, or null.
 *
 * A real .exe anywhere on PATH beats a .cmd shim earlier on it, because a shim
 * makes cmd.exe the process we track instead of the program. `.ps1` is never
 * returned: Start-Process cannot run one, and npm installs codex.ps1 right
 * beside codex.cmd.
 */
export function resolveOnPath(command, env = process.env) {
  if (path.isAbsolute(command) || /[\\/]/.test(command)) {
    return command;
  }

  const dirs = String(env.PATH ?? env.Path ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  const extensions = path.extname(command) ? ["", ".exe", ".com", ".cmd", ".bat"] : [".exe", ".com", ".cmd", ".bat"];

  // Extension first, directory second: a .exe late on PATH is still preferable
  // to a .cmd shim early on it.
  for (const extension of extensions) {
    for (const dir of dirs) {
      const candidate = path.join(dir, command + extension);
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // Not in this directory.
      }
    }
  }

  return null;
}

/**
 * Start a process that shows no window and outlives this one.
 *
 * Returns `{ pid, reason }`: a pid on success, or null with the reason it could
 * not be obtained. Callers decide whether that is fatal.
 */
export function spawnHiddenDetached({
  file,
  args = [],
  cwd,
  env = process.env,
  stdin,
  stdout,
  stderr,
  pidFile,
  errFile,
  timeoutMs = 60_000
}) {
  const resolved = resolveOnPath(file, env);
  if (!resolved) {
    return { pid: null, reason: `"${file}" was not found on PATH.` };
  }

  // Cleared first so a value left by an earlier launch can never be read back
  // as this one's pid.
  for (const stale of [pidFile, errFile]) {
    try {
      fs.unlinkSync(stale);
    } catch {
      // Nothing to clear.
    }
  }

  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", LAUNCHER],
    {
      cwd,
      env: {
        ...env,
        EA_SPAWN_FILE: resolved,
        EA_SPAWN_ARGLINE: args.map(quoteWindowsArg).join(" "),
        EA_SPAWN_CWD: cwd,
        EA_SPAWN_STDIN: stdin,
        EA_SPAWN_STDOUT: stdout,
        EA_SPAWN_STDERR: stderr,
        EA_SPAWN_PIDFILE: pidFile,
        EA_SPAWN_ERRFILE: errFile
      },
      // "ignore", never "pipe", and this is the load-bearing detail. An
      // inherited descriptor would stop libuv setting CREATE_NO_WINDOW, putting
      // a console back on screen. A pipe would also be inherited by the
      // grandchild and held open for its whole life, so this call would block
      // until a 45 minute job finished.
      stdio: "ignore",
      windowsHide: true,
      timeout: timeoutMs
    }
  );

  let pid = null;
  try {
    pid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
  } catch {
    // Handled below.
  }

  if (Number.isInteger(pid) && pid > 0) {
    return { pid, reason: null };
  }

  let reason = null;
  try {
    reason = fs.readFileSync(errFile, "utf8").trim() || null;
  } catch {
    // Nothing recorded.
  }

  reason ??=
    result.error?.message ??
    `the launcher exited ${result.status ?? result.signal} without reporting a pid`;

  return { pid: null, reason };
}
