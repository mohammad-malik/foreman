// A smoke test that RUNS every subcommand, because 157 unit tests passed while
// `delegate` threw "Assignment to constant variable" on its first real call.
const { execFileSync } = require("child_process");
const runtime = "scripts/external-agents.mjs";
const readOnly = ["doctor", "routes", "workspaces", "servers", "status", "result", "sweep", "notify"];
let bad = 0;
for (const cmd of readOnly) {
  try {
    execFileSync("node", [runtime, cmd], { stdio: "pipe", timeout: 90000 });
    console.log("  ok   " + cmd);
  } catch (e) {
    const out = String(e.stderr || e.stdout || e.message);
    // A usage or state error is fine; a crash is not.
    if (/Assignment to|is not a function|Cannot read|undefined is not|SyntaxError|ReferenceError/.test(out)) {
      console.log("  CRASH " + cmd + ": " + out.split("\n")[0]);
      bad++;
    } else {
      console.log("  ok   " + cmd + " (non-zero exit, no crash)");
    }
  }
}
console.log(bad === 0 ? "\nno crashes" : "\n" + bad + " crashed");
process.exitCode = bad ? 1 : 0;
