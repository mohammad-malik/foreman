/**
 * Runs every read-only subcommand as a real child process.
 *
 * This exists because 157 unit tests passed while `delegate` threw
 * "Assignment to constant variable" on its first real invocation. Unit tests
 * over pure functions say nothing about whether the program runs.
 *
 * Two things it must get right, both learned by getting them wrong:
 *
 *   - It runs against a THROWAWAY state directory. Several of these commands
 *     mutate state: `notify` marks jobs reported, `status` reconciles and
 *     persists records, `sweep` stops servers. Against live state, running the
 *     test suite killed the OpenCode server under a blocked background
 *     delegation and lost forty minutes of work.
 *   - It fails on any unexpected error. The first version matched crashes
 *     against a small regex blacklist, so a timeout, ERR_MODULE_NOT_FOUND, a
 *     RangeError or "x is not iterable" all fell through to the success branch
 *     and the suite exited zero.
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const RUNTIME = path.join(__dirname, "..", "scripts", "foreman.mjs");
const COMMANDS = [
  "doctor",
  "routes",
  "workspaces",
  "servers",
  "status",
  "result",
  "sweep",
  "notify",
  "wait"
];

/**
 * Failures that are correct behaviour against an empty state directory, and so
 * are allowed. Anything not matched here fails the run, including timeouts.
 *
 * Explicit phrases rather than loose patterns: the point of this list is that
 * adding to it should be a deliberate act.
 */
const EXPECTED = [
  "No jobs yet",
  "No workspaces registered",
  "not inside any registered workspace",
  "is not registered"
];

function isExpected(output) {
  return EXPECTED.some((phrase) => output.includes(phrase));
}

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-smoke-"));
const env = {
  ...process.env,
  // Highest-precedence source in resolveStateRoot, so the children cannot
  // reach the developer's real jobs, servers or workspace allowlist.
  FOREMAN_STATE_DIR: stateDir
};
// A stray value exported by another plugin's hook would otherwise be consulted.
delete env.CLAUDE_PLUGIN_DATA;

let failures = 0;

console.log(`state dir: ${stateDir}`);

for (const command of COMMANDS) {
  let output;
  let failed = false;

  try {
    output = String(
      execFileSync("node", [RUNTIME, command], { stdio: "pipe", timeout: 120_000, env })
    );
  } catch (error) {
    failed = true;

    if (error.signal === "SIGTERM" || error.code === "ETIMEDOUT") {
      console.log(`  FAIL  ${command}: timed out`);
      failures += 1;
      continue;
    }

    output = `${error.stdout ?? ""}${error.stderr ?? ""}${error.message ?? ""}`;
  }

  // An un-awaited async command prints this instead of its output, and the
  // function itself resolves fine, so no unit test notices.
  if (output.includes("[object Promise]")) {
    console.log(`  FAIL  ${command}: printed [object Promise]`);
    failures += 1;
    continue;
  }

  if (!failed) {
    console.log(`  ok    ${command}`);
    continue;
  }

  if (isExpected(output)) {
    console.log(`  ok    ${command} (expected empty-state failure)`);
    continue;
  }

  const firstLine = output.split("\n").find((line) => line.trim() !== "") ?? "no output";
  console.log(`  FAIL  ${command}: ${firstLine}`);
  failures += 1;
}

try {
  fs.rmSync(stateDir, { recursive: true, force: true });
} catch {
  // A leftover temp directory is not worth failing the run over.
}

console.log(failures === 0 ? "\nno crashes" : `\n${failures} command(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
