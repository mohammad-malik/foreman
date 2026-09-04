/**
 * Plugin state: where it lives, and the global config that survives sessions.
 *
 * `CLAUDE_PLUGIN_DATA` is the intended home, but it is both unreliable (not
 * documented as reaching every context this runtime runs in) and ambiguous (it
 * can carry another plugin's directory, see below). So resolution walks a
 * chain of candidates and `doctor` reports which one won. Silently landing in
 * a temp directory, or in a neighbouring plugin's directory, would mean losing
 * workspace registrations without any visible failure.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_VERSION = 1;
const PLUGIN_DIR_NAME = "external-agents";

/**
 * `CLAUDE_PLUGIN_DATA` cannot be trusted on sight.
 *
 * Claude Code sets it per plugin when it runs that plugin's hooks, but a hook
 * can also export it into the whole session environment through
 * `CLAUDE_ENV_FILE`. The installed Codex plugin does exactly that, so an
 * ambient `CLAUDE_PLUGIN_DATA` here routinely points at
 * `plugins/data/codex-inline`. Writing our state there would scatter job
 * records and workspace registrations into a different plugin's directory.
 *
 * So the value is only accepted when its own path names this plugin.
 */
function claudePluginDataIfOurs() {
  const raw = process.env.CLAUDE_PLUGIN_DATA;
  if (!raw || raw.trim() === "") {
    return { value: null, rejected: null };
  }

  const resolved = path.resolve(raw);
  const owns = path
    .basename(resolved)
    .toLowerCase()
    .includes(PLUGIN_DIR_NAME);

  return owns ? { value: resolved, rejected: null } : { value: null, rejected: resolved };
}

/** @returns {{root: string, source: string, rejectedPluginData: string|null}} */
export function resolveStateRoot() {
  const explicit = process.env.EXTERNAL_AGENTS_STATE_DIR;
  const { value: fromClaude, rejected } = claudePluginDataIfOurs();

  if (explicit && explicit.trim() !== "") {
    return {
      root: path.resolve(explicit),
      source: "EXTERNAL_AGENTS_STATE_DIR",
      rejectedPluginData: rejected
    };
  }

  if (fromClaude) {
    return { root: fromClaude, source: "CLAUDE_PLUGIN_DATA", rejectedPluginData: rejected };
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData && localAppData.trim() !== "") {
    return {
      root: path.join(path.resolve(localAppData), PLUGIN_DIR_NAME),
      source: "LOCALAPPDATA",
      rejectedPluginData: rejected
    };
  }

  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && xdg.trim() !== "") {
    return {
      root: path.join(path.resolve(xdg), PLUGIN_DIR_NAME),
      source: "XDG_DATA_HOME",
      rejectedPluginData: rejected
    };
  }

  const home = os.homedir();
  if (home) {
    return {
      root: path.join(home, ".local", "share", PLUGIN_DIR_NAME),
      source: "homedir",
      rejectedPluginData: rejected
    };
  }

  // Last resort. State here does not survive a reboot, and doctor says so.
  return { root: path.join(os.tmpdir(), PLUGIN_DIR_NAME), source: "tmpdir", rejectedPluginData: rejected };
}

export function stateRoot() {
  return resolveStateRoot().root;
}

export function configFile() {
  return path.join(stateRoot(), "config.json");
}

export function workspacesDir() {
  return path.join(stateRoot(), "workspaces");
}

/** Per-workspace state directory, created on demand. */
export function workspaceStateDir(slug) {
  const dir = path.join(workspacesDir(), slug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    workspaces: {},
    routes: {}
  };
}

export function loadConfig() {
  const file = configFile();
  if (!fs.existsSync(file)) {
    return defaultConfig();
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `Plugin config at ${file} is not valid JSON (${error.message}). Fix or delete the file, then run doctor again.`
    );
  }

  if (parsed?.version !== CONFIG_VERSION) {
    throw new Error(
      `Plugin config at ${file} has version ${parsed?.version}, expected ${CONFIG_VERSION}. Delete the file to start clean.`
    );
  }

  return {
    ...defaultConfig(),
    ...parsed,
    workspaces: parsed.workspaces ?? {},
    routes: parsed.routes ?? {}
  };
}

/**
 * Write config atomically. A torn config file would lose every workspace
 * registration, so the write goes to a sibling temp file and renames over the
 * target, which is atomic on both NTFS and POSIX filesystems.
 */
export function saveConfig(config) {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const payload = JSON.stringify({ ...config, version: CONFIG_VERSION }, null, 2);
  const tmp = `${file}.${process.pid}.tmp`;

  fs.writeFileSync(tmp, `${payload}\n`, "utf8");
  fs.renameSync(tmp, file);
}

/**
 * Owner-only, because job records are not merely metadata. Under
 * `--allow-dirty-tree` a baseline embeds copies of the user's uncommitted
 * files, so a default 0644 under a shared or temporary state directory would
 * publish private source to every local account. The temp file carries the
 * same mode, or the content would be briefly world-readable before the rename.
 */
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readJsonIfPresent(file) {
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
