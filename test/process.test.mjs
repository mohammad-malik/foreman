import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { isAlive, processCommandLine, terminateProcessTree } from "../scripts/lib/process.mjs";


function spawnSleeper() {
  // Node rather than powershell or sleep: it starts in well under a second on
  // every platform, so the test does not have to guess at a startup delay.
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    detached: true,
    windowsHide: true,
    stdio: "ignore"
  });
  child.unref();
  return child;
}

test("the current process is alive", () => {
  assert.equal(isAlive(process.pid), true);
});

test("nonsense PIDs are not alive", () => {
  assert.equal(isAlive(-1), false);
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(null), false);
  assert.equal(isAlive(1.5), false);
});

test("a spawned process is alive, then is not after termination", async () => {
  const child = spawnSleeper();
  await new Promise((resolve) => setTimeout(resolve, 500));

  assert.equal(isAlive(child.pid), true, "should be running after spawn");

  const result = terminateProcessTree(child.pid, { force: true });
  assert.equal(result.killed, true);

  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(isAlive(child.pid), false, "should be gone after termination");
});

test("terminating something that is not running is reported, not thrown", () => {
  const result = terminateProcessTree(999_999_21);
  assert.equal(result.killed, false);
  assert.match(result.reason, /not running/);
});

test("processCommandLine identifies a running process", async () => {
  const child = spawnSleeper();
  await new Promise((resolve) => setTimeout(resolve, 800));

  try {
    const commandLine = processCommandLine(child.pid);
    // Reading it can be denied depending on host policy; only assert content
    // when we actually got something back.
    if (commandLine !== null) {
      assert.match(commandLine, /node/i);
    }
  } finally {
    terminateProcessTree(child.pid, { force: true });
  }
});

test("processCommandLine returns null for a dead process", () => {
  assert.equal(processCommandLine(999_999_21), null);
});
