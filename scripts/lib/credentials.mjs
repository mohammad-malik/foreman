/**
 * Provider credentials for spawned servers.
 *
 * This exists because of a trap that costs an hour to find. `opencode serve`
 * reads the auth store for some purposes but NOT for resolving models in a
 * session. A server started without provider keys in its environment sees only
 * the free tier: 31 models instead of 131, with no Kimi, no GLM and no
 * Fireworks at all. Prompts are accepted, events fire, and then nothing
 * happens, because the runner fails with ModelUnavailableError somewhere you
 * cannot see unless you started the server with --print-logs.
 *
 * So the runtime reads the keys OpenCode already stores and passes them to the
 * child process. It does not create, manage or store credentials of its own.
 *
 * Handling rules, given these are real API keys:
 *   - they go into the child environment and nowhere else
 *   - they are never written to a lock file, job record or log
 *   - they are never included in command output, not even redacted
 *   - the values are never returned from this module, only the env block
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Environment variable each provider's key belongs in, taken from the `env`
 * field OpenCode reports for that provider. Unknown providers fall back to a
 * derived name, which is a guess, so `doctor` reports which ones were mapped.
 */
const ENV_BY_PROVIDER = {
  opencode: "OPENCODE_API_KEY",
  "fireworks-ai": "FIREWORKS_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  groq: "GROQ_API_KEY"
};

function authFile() {
  return path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
}

function deriveEnvName(providerID) {
  return `${providerID.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}_API_KEY`;
}

function readAuthStore() {
  const file = authFile();
  if (!fs.existsSync(file)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Which providers have an API key on record, and where it would be injected.
 * Returns names only. Never the values, so this is safe for doctor output.
 */
export function credentialSummary() {
  const store = readAuthStore();

  return Object.entries(store)
    .map(([providerID, entry]) => ({
      providerID,
      type: entry?.type ?? "unknown",
      hasKey: typeof entry?.key === "string" && entry.key.trim() !== "",
      envName: ENV_BY_PROVIDER[providerID] ?? deriveEnvName(providerID),
      mapped: providerID in ENV_BY_PROVIDER
    }))
    .sort((a, b) => a.providerID.localeCompare(b.providerID));
}

/**
 * Environment fragment carrying the provider keys, for merging into a spawn.
 * The only function that touches key values, and it returns them straight into
 * the child's environment.
 */
export function credentialEnv() {
  const store = readAuthStore();
  const env = {};

  for (const [providerID, entry] of Object.entries(store)) {
    if (entry?.type !== "api" || typeof entry.key !== "string") {
      continue;
    }
    const key = entry.key.trim();
    if (key === "") {
      continue;
    }
    env[ENV_BY_PROVIDER[providerID] ?? deriveEnvName(providerID)] = key;
  }

  return env;
}
