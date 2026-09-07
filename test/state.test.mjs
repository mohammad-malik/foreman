import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveStateRoot } from "../scripts/lib/state.mjs";

const ENV_KEYS = [
  "FOREMAN_STATE_DIR",
  "CLAUDE_PLUGIN_DATA",
  "LOCALAPPDATA",
  "XDG_DATA_HOME"
];

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, overrides);

  try {
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

test("FOREMAN_STATE_DIR wins over everything", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-state-"));
  const result = withEnv(
    { FOREMAN_STATE_DIR: dir, CLAUDE_PLUGIN_DATA: path.join(dir, "foreman") },
    resolveStateRoot
  );

  assert.equal(result.root, path.resolve(dir));
  assert.equal(result.source, "FOREMAN_STATE_DIR");
});

test("CLAUDE_PLUGIN_DATA is used when it names this plugin", () => {
  const dir = path.join(os.tmpdir(), "plugins", "data", "foreman");
  const result = withEnv({ CLAUDE_PLUGIN_DATA: dir }, resolveStateRoot);

  assert.equal(result.root, path.resolve(dir));
  assert.equal(result.source, "CLAUDE_PLUGIN_DATA");
  assert.equal(result.rejectedPluginData, null);
});

test("CLAUDE_PLUGIN_DATA belonging to another plugin is rejected, not used", () => {
  // Found in practice: the installed Codex plugin exports CLAUDE_PLUGIN_DATA
  // into the whole session through CLAUDE_ENV_FILE, so an ambient value here
  // points at plugins/data/codex-inline. Trusting it would scatter our job
  // records and workspace registrations into a different plugin's directory.
  const foreign = path.join(os.tmpdir(), "plugins", "data", "codex-inline");
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-lad-"));

  const result = withEnv(
    { CLAUDE_PLUGIN_DATA: foreign, LOCALAPPDATA: localAppData },
    resolveStateRoot
  );

  assert.equal(result.source, "LOCALAPPDATA");
  assert.equal(result.root, path.join(path.resolve(localAppData), "foreman"));
  assert.equal(result.rejectedPluginData, path.resolve(foreign));
});

test("falls back to LOCALAPPDATA when CLAUDE_PLUGIN_DATA is absent", () => {
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-lad-"));
  const result = withEnv({ LOCALAPPDATA: localAppData }, resolveStateRoot);

  assert.equal(result.source, "LOCALAPPDATA");
  assert.equal(result.root, path.join(path.resolve(localAppData), "foreman"));
});

test("falls back to XDG_DATA_HOME when LOCALAPPDATA is absent", () => {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-xdg-"));
  const result = withEnv({ XDG_DATA_HOME: xdg }, resolveStateRoot);

  assert.equal(result.source, "XDG_DATA_HOME");
  assert.equal(result.root, path.join(path.resolve(xdg), "foreman"));
});

test("an empty CLAUDE_PLUGIN_DATA is treated as absent", () => {
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-lad-"));
  const result = withEnv({ CLAUDE_PLUGIN_DATA: "   ", LOCALAPPDATA: localAppData }, resolveStateRoot);

  assert.equal(result.source, "LOCALAPPDATA");
  assert.equal(result.rejectedPluginData, null);
});
