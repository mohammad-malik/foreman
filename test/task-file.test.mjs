/**
 * Reading a handoff from a file.
 *
 * The encoding cases are not hypothetical: the README tells people to write a
 * handoff to a file, and Windows PowerShell 5.1 writes UTF-16LE from `>` and
 * `Out-File` by default. Read as UTF-8 that becomes replacement characters and
 * embedded NULs, which pass a nonempty check and reach the agent as garbage
 * the caller pays for.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runtime = fileURLToPath(new URL("../scripts/foreman.mjs", import.meta.url));

/** Dispatch against an unregistered directory: parsing runs, nothing is sent. */
function dispatch(taskFile) {
  try {
    execFileSync(process.execPath, [runtime, "delegate", "--dir", os.tmpdir(), "--task-file", taskFile], {
      encoding: "utf8",
      stdio: "pipe"
    });
    return "";
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
}

function withFile(bytes, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-taskfile-"));
  const file = path.join(dir, "handoff.md");
  fs.writeFileSync(file, bytes);

  try {
    return run(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a UTF-16LE handoff is decoded, not mangled", () => {
  const bytes = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from("Investigate the parser.", "utf16le")
  ]);

  const output = withFile(bytes, dispatch);

  // It got past parsing to the workspace gate, which means the text decoded.
  assert.match(output, /not inside any registered workspace|delegation is off/u);
  assert.doesNotMatch(output, /corrupted/u);
});

test("a UTF-16BE handoff is decoded too", () => {
  const bytes = Buffer.concat([
    Buffer.from([0xfe, 0xff]),
    Buffer.from("Investigate the parser.", "utf16le").swap16()
  ]);

  const output = withFile(bytes, dispatch);

  assert.doesNotMatch(output, /corrupted/u);
});

test("a UTF-8 BOM does not become the first character", () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Investigate.", "utf8")]);

  const output = withFile(bytes, dispatch);

  assert.doesNotMatch(output, /corrupted/u);
});

test("an encoding nothing here recognises is refused, not dispatched", () => {
  // UTF-16 with no BOM: the NULs survive, and a nonempty check would pass.
  const bytes = Buffer.from("Investigate the parser.", "utf16le");

  const output = withFile(bytes, dispatch);

  assert.match(output, /would arrive corrupted/u);
  assert.match(output, /utf8/u);
});

test("an empty handoff is refused", () => {
  const output = withFile(Buffer.alloc(0), dispatch);
  assert.match(output, /is empty/u);
});

test("a whitespace-only handoff is refused", () => {
  const output = withFile(Buffer.from("   \r\n\t\n", "utf8"), dispatch);
  assert.match(output, /is empty/u);
});

test("a missing handoff names the path", () => {
  const output = dispatch(path.join(os.tmpdir(), "foreman-does-not-exist.md"));
  assert.match(output, /does not exist/u);
});

test("a literal replacement character is content, not a decoding failure", () => {
  // A handoff quoting corrupted output legitimately contains U+FFFD, and
  // rejecting on the character rather than the bytes refused that file with
  // advice that could not fix it.
  const bytes = Buffer.from("The log shows � where the name should be. Explain why.", "utf8");

  const output = withFile(bytes, dispatch);

  assert.doesNotMatch(output, /would arrive corrupted/u);
});

test("malformed UTF-8 bytes are refused", () => {
  const bytes = Buffer.from([0x49, 0x6e, 0x76, 0xc3, 0x28, 0x65, 0x73, 0x74]);

  const output = withFile(bytes, dispatch);

  assert.match(output, /would arrive corrupted/u);
});

test("a truncated UTF-16 handoff is refused, not silently shortened", () => {
  // Buffer.toString("utf16le") drops a trailing odd byte without complaint,
  // so a cut-off file decoded into a shorter handoff that looked fine.
  const bytes = Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x42]);

  const output = withFile(bytes, dispatch);

  assert.match(output, /would arrive corrupted/u);
});
