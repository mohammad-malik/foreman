/**
 * The Codex CLI as a delegation backend.
 *
 * OpenAI models are reachable two ways here, and they are not equivalent. The
 * OpenCode path bills a provider API key; `codex exec` runs on the ChatGPT
 * sign-in the user already has. So sol and luna default to this one, and the
 * OpenCode path stays available for when it is asked for by name.
 *
 * `codex exec` is a single one-shot process: no server, no session to reclaim,
 * no permission round trips. The sandbox flag decides what it may touch before
 * it starts, which is a smaller moving target than an agent asking mid-run.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class CodexError extends Error {
  constructor(message, { code = "codex_error", hint } = {}) {
    super(message);
    this.name = "CodexError";
    this.code = code;
    this.hint = hint;
  }
}

export function codexBinary() {
  return process.env.FOREMAN_CODEX_BIN || "codex";
}

export function codexHome() {
  return (
    process.env.CODEX_HOME ||
    path.join(os.homedir(), ".codex")
  );
}

/**
 * Version string, or a CodexError naming what to do about it.
 *
 * Called by doctor and before a dispatch, so a missing CLI is reported as a
 * missing CLI rather than as a job that failed for no stated reason.
 */
export function detectCodexVersion() {
  let raw;
  try {
    raw = execFileSync(codexBinary(), ["--version"], {
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true
    }).trim();
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new CodexError(`Codex executable "${codexBinary()}" was not found on PATH.`, {
        code: "codex_missing",
        hint: "Install the Codex CLI, or set FOREMAN_CODEX_BIN to its full path."
      });
    }
    throw new CodexError(`Could not run "${codexBinary()} --version": ${error.message}`, {
      code: "codex_unusable"
    });
  }

  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  return { raw, version: match ? match[0] : null };
}

/** True when Codex holds credentials. Cheap: it reads the auth file. */
export function codexSignedIn() {
  return fs.existsSync(path.join(codexHome(), "auth.json"));
}

/**
 * Model ids Codex knows about, best effort.
 *
 * Read from its own cache rather than by asking the network, because this is
 * consulted on the dispatch path. Best effort is deliberate: a stale or absent
 * cache reports "unverified" and the dispatch proceeds. Refusing a job because
 * a cache file was missing would be worse than letting Codex reject the id
 * itself, which it does clearly.
 */
export function codexModels() {
  const file = path.join(codexHome(), "models_cache.json");

  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  // The cache shape is Codex's business and has changed before, so the ids are
  // gathered from anywhere in the structure rather than from an assumed path.
  const ids = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if ((key === "id" || key === "slug" || key === "model") && typeof value === "string") {
          ids.add(value);
        }
        walk(value);
      }
    }
  };
  walk(parsed);

  return ids.size > 0 ? [...ids] : null;
}

/**
 * Sandbox policy for a role.
 *
 * Read-only work gets read-only, and that is the whole enforcement: unlike the
 * OpenCode path there is no per-command prompt to answer, so the policy has to
 * be right up front. `danger-full-access` is never returned. --unattended on
 * this backend means "do not ask", not "leave the sandbox", because a Codex
 * agent that could write anywhere on the machine is not something to hand out
 * behind a flag.
 */
export function sandboxFor({ write }) {
  return write ? "workspace-write" : "read-only";
}

/**
 * The `codex exec` argument list for one job.
 *
 * The handoff never appears here. It goes in on stdin, which sidesteps both the
 * Windows command-line length limit and every quoting bug that a long prompt
 * full of paths and backslashes invites.
 */
export function execArgs({ model, root, write, messageFile }) {
  return [
    "exec",
    "-",
    "--model",
    model,
    "--cd",
    root,
    "--sandbox",
    sandboxFor({ write }),
    "--json",
    "--skip-git-repo-check",
    "--output-last-message",
    messageFile
  ];
}

/**
 * Pull the useful facts out of a `codex exec --json` log.
 *
 * Shapes verified against codex-cli 0.147.0 by running a real job rather than
 * from the help text: events are JSONL, one per line, and the ones that matter
 * are `thread.started`, `item.completed` (with an `item.type` of
 * `agent_message`, `command_execution` or a patch), `turn.completed` carrying
 * the token usage, and `turn.failed`.
 *
 * Every line is parsed defensively. A job killed mid-write leaves a torn final
 * line, and a truncated log should still yield the text and tool calls it did
 * contain. Unknown event types are ignored rather than treated as errors: this
 * has to survive the CLI adding events, which it will.
 */
export function parseEventLog(text) {
  const out = { finalText: null, tools: [], tokens: null, errors: [], threadID: null, turnDone: false };

  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }

    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const type = String(event.type ?? "");

    if (type === "thread.started" && typeof event.thread_id === "string") {
      out.threadID = event.thread_id;
      continue;
    }

    if (type === "turn.completed") {
      out.turnDone = true;
      const usage = event.usage ?? {};
      out.tokens = {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        reasoning: usage.reasoning_output_tokens ?? 0,
        cached: usage.cached_input_tokens ?? 0
      };
      continue;
    }

    if (type === "turn.failed") {
      out.turnDone = true;
      const message = event.error?.message ?? event.error ?? "the turn failed";
      out.errors.push(typeof message === "string" ? message : JSON.stringify(message));
      continue;
    }

    if (type !== "item.completed") {
      continue;
    }

    const item = event.item ?? {};
    const itemType = String(item.type ?? "");

    if (itemType === "agent_message" && typeof item.text === "string") {
      // Last one wins: the closing message is the report, and an earlier one is
      // usually the model saying what it is about to do.
      out.finalText = item.text;
    } else if (itemType === "command_execution") {
      out.tools.push({
        name: "bash",
        detail: String(item.command ?? "").slice(0, 400),
        exitCode: item.exit_code ?? null
      });
    } else if (itemType.includes("patch") || itemType.includes("file_change")) {
      const changed = item.changes ?? item.files ?? null;
      out.tools.push({
        name: "edit",
        detail: changed ? Object.keys(changed).join(", ").slice(0, 400) : itemType
      });
    } else if (itemType === "error" && typeof item.message === "string") {
      out.errors.push(item.message);
    }
  }

  return out;
}
