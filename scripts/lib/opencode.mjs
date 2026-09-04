/**
 * Talking to the OpenCode CLI: finding it, checking its version, and reading
 * the live model inventory.
 *
 * OpenCode ships fast and updates itself, so this supports a version range
 * rather than pinning one build. An unknown minor inside the range warns and
 * proceeds; only a genuinely missing capability is fatal. Pinning an exact
 * version would mean the plugin breaks on a random Tuesday.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";

import { readJsonIfPresent, stateRoot, writeJsonAtomic } from "./state.mjs";

export const SUPPORTED_RANGE = { min: "1.18.0", maxExclusive: "2.0.0" };
const INVENTORY_TTL_MS = 15 * 60 * 1000;

export class OpencodeError extends Error {
  constructor(message, { code = "opencode_error", hint } = {}) {
    super(message);
    this.name = "OpencodeError";
    this.code = code;
    this.hint = hint;
  }
}

export function opencodeBinary() {
  return process.env.EXTERNAL_AGENTS_OPENCODE_BIN || "opencode";
}

function run(args, { timeout = 60_000 } = {}) {
  try {
    return execFileSync(opencodeBinary(), args, {
      encoding: "utf8",
      timeout,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new OpencodeError(`OpenCode executable "${opencodeBinary()}" was not found on PATH.`, {
        code: "opencode_missing",
        hint: "Install OpenCode, or set EXTERNAL_AGENTS_OPENCODE_BIN to its full path."
      });
    }
    if (error.signal === "SIGTERM" || error.code === "ETIMEDOUT") {
      throw new OpencodeError(`OpenCode command timed out: ${args.join(" ")}`, {
        code: "opencode_timeout"
      });
    }
    const stderr = String(error.stderr ?? "").trim();
    throw new OpencodeError(
      `OpenCode command failed: ${args.join(" ")}${stderr ? `\n${stderr}` : ""}`,
      { code: "opencode_failed" }
    );
  }
}

export function detectVersion() {
  const raw = run(["--version"], { timeout: 20_000 }).trim();
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new OpencodeError(`Could not parse an OpenCode version from "${raw}".`, {
      code: "opencode_version_unparsed"
    });
  }
  return {
    raw,
    version: match[0],
    parts: [Number(match[1]), Number(match[2]), Number(match[3])]
  };
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) {
      return a[i] - b[i];
    }
  }
  return 0;
}

function parseVersionString(value) {
  return value.split(".").map(Number);
}

/**
 * @returns {{ok: boolean, level: "ok"|"warn"|"error", message: string}}
 */
export function checkVersionRange(detected) {
  const min = parseVersionString(SUPPORTED_RANGE.min);
  const max = parseVersionString(SUPPORTED_RANGE.maxExclusive);

  if (compareVersions(detected.parts, min) < 0) {
    return {
      ok: false,
      level: "error",
      message: `OpenCode ${detected.version} is older than the supported minimum ${SUPPORTED_RANGE.min}. Upgrade OpenCode.`
    };
  }

  if (compareVersions(detected.parts, max) >= 0) {
    return {
      ok: false,
      level: "warn",
      message: `OpenCode ${detected.version} is newer than the tested range (<${SUPPORTED_RANGE.maxExclusive}). Endpoints may have moved; proceed with care and report breakage.`
    };
  }

  return { ok: true, level: "ok", message: `OpenCode ${detected.version} is inside the supported range.` };
}

function inventoryCacheFile() {
  return path.join(stateRoot(), "inventory.json");
}

/**
 * Live `provider/model` identifiers, cached so routine delegations do not pay
 * a CLI round trip. `force` bypasses the cache, which is what doctor uses.
 */
export function loadInventory({ force = false, version = null } = {}) {
  const file = inventoryCacheFile();

  if (!force) {
    const cached = readJsonIfPresent(file);
    const fresh =
      cached &&
      Array.isArray(cached.models) &&
      Date.now() - Date.parse(cached.fetchedAt ?? 0) < INVENTORY_TTL_MS &&
      (version === null || cached.version === version);

    if (fresh) {
      return { models: cached.models, cached: true, fetchedAt: cached.fetchedAt };
    }
  }

  const models = run(["models"], { timeout: 60_000 })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && line.includes("/"));

  if (models.length === 0) {
    throw new OpencodeError("OpenCode returned no models.", {
      code: "inventory_empty",
      hint: "Check that at least one provider is connected: `opencode auth list`."
    });
  }

  const fetchedAt = new Date().toISOString();
  writeJsonAtomic(file, { fetchedAt, version, models });
  return { models, cached: false, fetchedAt };
}

/** Distinct provider prefixes present in the inventory. */
export function providersFrom(models) {
  return [...new Set(models.map((id) => id.split("/")[0]))].sort();
}
