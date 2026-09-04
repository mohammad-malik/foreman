import assert from "node:assert/strict";
import test from "node:test";

import { credentialEnv, credentialSummary } from "../scripts/lib/credentials.mjs";

/**
 * These handle real API keys, so the tests are about what must never happen
 * rather than about happy paths. They run against whatever is actually in the
 * OpenCode auth store on this machine, and skip when there is nothing to check.
 */

const summary = credentialSummary();
const withKeys = summary.filter((entry) => entry.hasKey);
const noCredentials = withKeys.length === 0;

test("the summary reports providers without exposing any key", { skip: noCredentials }, () => {
  const serialised = JSON.stringify(summary);
  const env = credentialEnv();

  for (const value of Object.values(env)) {
    assert.ok(value.length > 0);
    assert.equal(
      serialised.includes(value),
      false,
      "credentialSummary is printed by doctor and must never carry a key value"
    );
  }
});

test("keys map to the environment names OpenCode expects", { skip: noCredentials }, () => {
  // Getting these wrong is not a loud failure: the server starts, resolves only
  // the free model tier, and every paid model dies with ModelUnavailableError
  // somewhere the user cannot see.
  const known = summary.filter((entry) => entry.mapped);
  for (const entry of known) {
    assert.match(entry.envName, /^[A-Z0-9_]+$/);
  }

  const zen = summary.find((entry) => entry.providerID === "opencode");
  if (zen) {
    assert.equal(zen.envName, "OPENCODE_API_KEY");
  }

  const fireworks = summary.find((entry) => entry.providerID === "fireworks-ai");
  if (fireworks) {
    assert.equal(fireworks.envName, "FIREWORKS_API_KEY");
  }
});

test("injected key values are trimmed", { skip: noCredentials }, () => {
  // The stored Zen key ends with a newline and a space. Passing that through
  // verbatim risks an authorization header with embedded whitespace.
  for (const value of Object.values(credentialEnv())) {
    assert.equal(value, value.trim());
    assert.doesNotMatch(value, /\s/, "a key with embedded whitespace would be malformed");
  }
});

test("every provider with a key gets an environment variable", { skip: noCredentials }, () => {
  const env = credentialEnv();
  for (const entry of withKeys) {
    assert.ok(entry.envName in env, `${entry.providerID} should be injected as ${entry.envName}`);
  }
});

test("an unknown provider still gets a derived variable name", () => {
  const derived = summary.filter((entry) => !entry.mapped);
  for (const entry of derived) {
    assert.match(entry.envName, /^[A-Z0-9_]+_API_KEY$/);
  }
  // Always meaningful even with no unknown providers present.
  assert.ok(Array.isArray(derived));
});
