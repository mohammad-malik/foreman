/**
 * `doctor` is the only thing anyone should trust before the rest of the plugin
 * is trusted. It answers three questions the rest of the code assumes: where
 * state actually landed, whether OpenCode is usable, and which routes really
 * resolve against the live inventory right now.
 *
 * It never prints a credential. Provider health is inferred from what appears
 * in the model inventory, not by reading the auth store.
 */

import { execFileSync } from "node:child_process";

import {
  checkVersionRange,
  detectVersion,
  loadInventory,
  opencodeBinary,
  OpencodeError,
  providersFrom,
  SUPPORTED_RANGE
} from "../opencode.mjs";
import { codexModels, codexSignedIn, detectCodexVersion } from "../codex.mjs";
import { readUserOpencodeConfig } from "../servers.mjs";
import { findReservedCandidates, listAliases, resolveRoute } from "../routes.mjs";
import { listWorkspaces } from "../registry.mjs";
import { resolveStateRoot } from "../state.mjs";
import { bullet, checkLine, heading, keyValue } from "../render.mjs";

export function doctor() {
  const lines = [];
  let failures = 0;
  let warnings = 0;

  const record = (level, label, detail) => {
    if (level === "fail") failures += 1;
    if (level === "warn") warnings += 1;
    lines.push(checkLine(level, label, detail));
  };

  lines.push(heading("Environment"));

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  record(
    nodeMajor >= 20 ? "ok" : "fail",
    "Node",
    `${process.versions.node}${nodeMajor >= 20 ? "" : " (need >= 20)"}`
  );

  try {
    const gitVersion = execFileSync("git", ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true
    }).trim();
    record("ok", "git", gitVersion);
  } catch {
    record("fail", "git", "not found on PATH. Change attribution and revert both need it.");
  }

  const { root: stateDir, source, rejectedPluginData } = resolveStateRoot();
  if (source === "tmpdir") {
    record(
      "warn",
      "State directory",
      `${stateDir} (from ${source}; this does not survive a reboot, so registrations will be lost)`
    );
  } else {
    record("ok", "State directory", `${stateDir} (from ${source})`);
  }

  if (rejectedPluginData) {
    record(
      "info",
      "CLAUDE_PLUGIN_DATA",
      `ignored ${rejectedPluginData}: it belongs to a different plugin, so state went to the location above instead`
    );
  }

  lines.push(heading("OpenCode"));

  let version = null;
  let inventory = null;

  try {
    version = detectVersion();
    const range = checkVersionRange(version);
    record(range.level === "ok" ? "ok" : range.level, "Version", range.message);
  } catch (error) {
    record("fail", "Version", describe(error));
  }

  if (version) {
    try {
      inventory = loadInventory({ force: true, version: version.version });
      const providers = providersFrom(inventory.models);
      record("ok", "Inventory", `${inventory.models.length} models across ${providers.length} providers`);
      lines.push(bullet(`providers: ${providers.join(", ")}`, 8));
    } catch (error) {
      record("fail", "Inventory", describe(error));
    }
  }

  const userConfig = readUserOpencodeConfig();
  if (userConfig.error) {
    record(
      "warn",
      "User config",
      `${userConfig.file} could not be parsed (${userConfig.error}). Servers this plugin starts run without it: provider settings there will not apply.`
    );
  } else if (userConfig.file) {
    record("ok", "User config", `${userConfig.file} (provider, model, formatter and lsp settings are carried over; mcp, plugin and share are not)`);
  }

  lines.push(heading("Codex backend"));

  let codexList = null;
  try {
    const codex = detectCodexVersion();
    if (codexSignedIn()) {
      record("ok", "Codex CLI", `${codex.raw}, signed in`);
    } else {
      record(
        "fail",
        "Codex CLI",
        `${codex.raw}, but no stored credentials. Run \`codex login\`; sol and luna cannot run without it.`
      );
    }
    codexList = codexModels();
    record(
      codexList ? "ok" : "warn",
      "Codex models",
      codexList
        ? `${codexList.length} known locally`
        : "could not read the local model cache, so codex model ids are unverified"
    );
  } catch (error) {
    record("fail", "Codex CLI", describe(error));
  }

  lines.push(heading("Routes"));

  const models = inventory?.models ?? null;
  const inventories = {
    ...(models ? { opencode: models } : {}),
    ...(codexList ? { codex: codexList } : {})
  };

  // With the inventories, a reserved alias whose id has landed reports as a
  // live route instead of as a pending one.
  for (const alias of listAliases(inventories)) {
    if (alias.reserved && alias.routes.length === 0) {
      record("info", alias.alias, `reserved, no live provider ID yet (${alias.description})`);
      continue;
    }

    for (const route of alias.routes) {
      // The backend is in the name when a model has more than one, because
      // "sol.standard ok" would otherwise say nothing about which of the two
      // ways of reaching it actually works.
      const name =
        alias.backends.length > 1
          ? `${alias.alias}.${route.backend}.${route.route}${route.isDefaultBackend ? " (default)" : ""}`
          : `${alias.alias}.${route.route}`;
      try {
        resolveRoute(alias.alias, route.route, inventories, { backend: route.backend });
        record("ok", name, `${route.qualified}${alias.promoted ? "  (newly live)" : ""}`);
      } catch (error) {
        const detail = models
          ? `${error.message}${error.candidates?.length ? `\n${bullet(`closest live IDs: ${error.candidates.join(", ")}`, 8)}` : ""}`
          : `${route.qualified} (not verified: inventory unavailable)`;
        record(models ? "fail" : "warn", name, detail);
      }
    }
  }

  if (models) {
    const reserved = findReservedCandidates(inventories);
    for (const entry of reserved) {
      record(
        "info",
        `${entry.alias} watch`,
        `matching IDs now live: ${entry.matches.join(", ")}. Add a route for them in the plugin config.`
      );
    }
  }

  lines.push(heading("Workspaces"));

  const workspaces = listWorkspaces();
  if (workspaces.length === 0) {
    record("info", "Repositories", "none seen yet. Any git repository works; the first delegation from one asks about egress.");
  } else {
    record("ok", "Registered", `${workspaces.length}`);
    lines.push(
      keyValue(
        workspaces.map((workspace) => [
          workspace.root,
          workspace.allowExternal ? "external delegation ALLOWED" : "local only (no delegation)"
        ]),
        8
      )
    );
  }

  lines.push(heading("Summary"));
  if (failures > 0) {
    lines.push(`${failures} blocking problem(s), ${warnings} warning(s). Delegation will not work until the failures are fixed.`);
  } else if (warnings > 0) {
    lines.push(`No blocking problems, ${warnings} warning(s).`);
  } else {
    lines.push("Everything checks out.");
  }

  lines.push("");
  lines.push(
    `Supported OpenCode range: >=${SUPPORTED_RANGE.min} <${SUPPORTED_RANGE.maxExclusive}. Binary: ${opencodeBinary()}.`
  );

  return { text: lines.join("\n"), failures, warnings };
}

function describe(error) {
  if (error instanceof OpencodeError) {
    return error.hint ? `${error.message}\n${bullet(error.hint, 8)}` : error.message;
  }
  return error.message;
}
