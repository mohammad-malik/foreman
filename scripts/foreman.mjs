#!/usr/bin/env node
/**
 * The foreman runtime.
 *
 * Every slash command in this plugin shells into exactly one place: here.
 * Claude reads job state by running the read-only subcommands through
 * `Bash(node:*)`. Dispatch itself is fronted by a slash command carrying
 * `disable-model-invocation: true`, so a delegation is always something a
 * person asked for, which is why there is no MCP server.
 */

import fs from "node:fs";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { extractOption, extractPath, normalizeArgv } from "./lib/tokenize.mjs";
import { doctor } from "./lib/cmd/doctor.mjs";
import { register, unregister, workspaces } from "./lib/cmd/register.mjs";
import { routes } from "./lib/cmd/routes.mjs";
import { servers, serverStart, serverStop, sweepServers } from "./lib/cmd/server.mjs";
import { delegate } from "./lib/cmd/delegate.mjs";
import { cancel, permit, result, revert, status } from "./lib/cmd/job-commands.mjs";
import { notify } from "./lib/cmd/notify.mjs";
import { resolve, waitForJobs } from "./lib/cmd/orchestrate.mjs";
import { fail } from "./lib/render.mjs";

const USAGE = `foreman runtime

Read-only:
  doctor                        Check the runtime, OpenCode, routes and workspaces
  routes [--refresh]            List model aliases and live availability
  workspaces                    List registered workspaces
  servers                       Show the OpenCode server for each workspace
  resolve <spoken name>         Turn "fast glm 5.3" into an exact model+route
  wait [job-ids...] [--timeout <s>] [--all]
                                Block until those jobs finish. With no ids:
                                this session's jobs and any in the current
                                repository; --all means every job anywhere
  status [job-id]               List jobs, or show one
  result [job-id]               Collect and show a job's outcome

Human-invoked:
  delegate --task <text> | --task-file <path>
           [--model kimi] [--route standard|fast]
           [--backend codex|opencode]
           [--role builder|fixer|researcher] [--write]
           [--background] [--timeout <seconds>] [--allow-dirty-tree]
           [--unattended] [--dir <path>]
                                Dispatch a handoff to an external model
  permit [job-id] [request-id] allow|reject
                                Answer a pending permission request. The ids are
                                optional when only one is pending, so
                                "permit allow" is usually enough.
  cancel [job-id]               Stop a running job
  revert <job-id>               Restore only the files a job changed
  register <path> [--allow-external] [--force]
                                Add a workspace to the allowlist
  unregister <path> [--force]    Remove a workspace, stopping its server

Maintenance:
  server-start [path]           Start or reuse this workspace's server
  server-stop [path]            Stop this workspace's server
  sweep                         Clean up dead and idle servers
  notify                        Report finished jobs once (used by the Stop hook)
`;

const DELEGATE_SPEC = {
  valueOptions: [
    "task",
    "task-file",
    "model",
    "route",
    "backend",
    "role",
    "timeout",
    "dir",
    "budget"
  ],
  boolOptions: ["write", "background", "wait", "allow-dirty-tree", "unattended"]
};

// Every option delegate recognises. extractOption reads --dir's value from
// the raw argument string and needs to know where that value ends: at the
// next recognised option, because the slash command puts --dir first.
const DELEGATE_OPTIONS = [...DELEGATE_SPEC.valueOptions, ...DELEGATE_SPEC.boolOptions];

/**
 * Read a handoff from a file, or refuse with the reason.
 *
 * Deliberately strict about an empty file: a truncated or not-yet-written
 * handoff would otherwise dispatch a paid job with no instructions, and the
 * agent would improvise something nobody asked for.
 */
function readTaskFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`--task-file ${file} does not exist.`);
    }
    if (error.code === "EISDIR") {
      throw new Error(`--task-file ${file} is a directory, not a file.`);
    }
    throw new Error(`Could not read --task-file ${file}: ${error.message}`);
  }

  // Decode by byte-order mark rather than assuming UTF-8.
  //
  // Windows PowerShell 5.1 writes UTF-16LE from `>` and `Out-File`, which is
  // exactly how the README tells people to produce a handoff. Read as UTF-8
  // that becomes replacement characters and embedded NULs, and it passes a
  // nonempty check, so a corrupted handoff would be dispatched and paid for.
  const badEncoding = () =>
    new Error(
      [
        `--task-file ${file} is not valid UTF-8 or UTF-16, so the handoff would arrive corrupted.`,
        "Write it as UTF-8: in PowerShell, Set-Content -Encoding utf8 (or Out-File -Encoding utf8)."
      ].join("\n")
    );

  // Strict on this branch too. `Buffer.toString("utf16le")` drops a trailing
  // odd byte without complaint, so a truncated file decoded into a shorter
  // handoff that looked fine and was dispatched.
  const decodeUtf16 = (bytes) => {
    if (bytes.length % 2 !== 0) {
      throw badEncoding();
    }
    try {
      return new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
    } catch {
      throw badEncoding();
    }
  };

  let text;
  if (raw[0] === 0xff && raw[1] === 0xfe) {
    text = decodeUtf16(raw.subarray(2));
  } else if (raw[0] === 0xfe && raw[1] === 0xff) {
    // Node has no utf16be decoder; swapping the pairs makes it one.
    text = decodeUtf16(Buffer.from(raw.subarray(2)).swap16());
  } else {
    // Strict, so malformed bytes are a decoding failure rather than a string
    // full of replacement characters. A handoff may legitimately contain a
    // literal U+FFFD, for instance when quoting corrupted output, and
    // rejecting on the character rather than the bytes refused that file with
    // advice that could not fix it.
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      throw badEncoding();
    }
    // A UTF-8 BOM decodes to one character, so it is stripped as text.
    text = text.replace(/^﻿/u, "");
  }

  // UTF-16 with no BOM decodes as UTF-8 into NULs. Nothing legitimate carries
  // a NUL, so this is the one case the bytes alone cannot distinguish.
  if (text.includes("\u0000")) {
    throw badEncoding();
  }

  const task = text.trim();

  if (task === "") {
    throw new Error(`--task-file ${file} is empty. Nothing was dispatched.`);
  }

  return task;
}

const COMMANDS = {
  doctor: () => {
    const outcome = doctor();
    process.stdout.write(`${outcome.text}\n`);
    return outcome.failures > 0 ? 1 : 0;
  },

  routes: (argv) => {
    const { options } = parseArgs(argv, { boolOptions: ["refresh"] });
    process.stdout.write(`${routes({ refresh: Boolean(options.refresh) })}\n`);
    return 0;
  },

  workspaces: () => {
    process.stdout.write(`${workspaces()}\n`);
    return 0;
  },

  register: (argv, raw) => {
    // Read from the raw string rather than parsed tokens. A path is never
    // reassembled from pieces, so `C:\My  Projects` keeps both spaces and
    // `C:\Users\O'Brien` keeps its apostrophe.
    const { path, flags } = extractPath(raw, ["allow-external", "force"], argv);
    process.stdout.write(
      `${register(path, {
        allowExternal: flags.has("allow-external"),
        force: flags.has("force")
      })}\n`
    );
    return 0;
  },

  unregister: async (argv, raw) => {
    const { path, flags } = extractPath(raw, ["force"], argv);
    process.stdout.write(`${await unregister(path, { force: flags.has("force") })}\n`);
    return 0;
  },

  servers: () => {
    process.stdout.write(`${servers()}\n`);
    return 0;
  },

  "server-start": async (argv, raw) => {
    process.stdout.write(`${await serverStart(extractPath(raw, [], argv).path)}\n`);
    return 0;
  },

  "server-stop": async (argv, raw) => {
    process.stdout.write(`${await serverStop(extractPath(raw, [], argv).path)}\n`);
    return 0;
  },

  sweep: async () => {
    process.stdout.write(`${await sweepServers()}\n`);
    return 0;
  },

  delegate: async (argv, raw) => {
    // --dir is read from the raw argument string, not from parsed tokens:
    // parseArgs stops an option value at its first space, so an unquoted
    // `--dir C:\Program Files\repo` would arrive as `C:\Program` with
    // `Files\repo` stranded in positionals and silently dropped.
    const { value: dir, rest: afterDir } = extractOption(argv, raw, "dir", DELEGATE_OPTIONS);

    // --task-file is a path and gets the same treatment for the same reason:
    // extracted from the raw string, and its tokens removed before parseArgs
    // runs. Reading the value but leaving the tokens behind left the tail of
    // `--task-file C:\My Tasks\handoff.md` sitting in positionals, which then
    // tripped the "both a file and an inline task" refusal on a command line
    // that had only ever named one.
    const { value: taskFile, rest: args } = extractOption(
      afterDir,
      raw,
      "task-file",
      DELEGATE_OPTIONS
    );
    const { options, positionals } = parseArgs(args, DELEGATE_SPEC);

    // The task can come from --task or from whatever is left over, so a long
    // handoff after `--` does not have to be quoted twice.
    //
    // Both at once means an unquoted --task value was cut at its first space
    // and the rest is sitting in positionals. Dispatching would send a paid
    // job with a one-word handoff, so it is refused instead.
    if (options.task !== undefined && positionals.length > 0) {
      throw new Error(
        `--task was given as "${options.task}" and ${positionals.length} more argument(s) follow it. Quote the task, or put it after --.`
      );
    }

    // --task-file keeps the handoff off the command line altogether.
    //
    // A handoff is long, and it quotes file contents, error text and paths.
    // Passing it inline means every one of those characters has to survive a
    // shell, and it means a permission classifier reading the command line
    // sees thousands of characters of untrusted text where it expects a
    // command. Both problems disappear when the text is read from a file: the
    // command line becomes a short, fixed shape a person can allow once.
    const handoffFile = taskFile ?? options["task-file"];

    if (handoffFile !== undefined && (options.task !== undefined || positionals.length > 0)) {
      throw new Error(
        "--task-file and an inline task were both given. Use one: the file, or --task."
      );
    }

    const task =
      handoffFile === undefined
        ? options.task ?? positionals.join(" ")
        : readTaskFile(handoffFile);

    process.stdout.write(
      `${await delegate({
        task,
        model: options.model ?? "kimi",
        route: options.route ?? "standard",
        // Omitted means the model's own default backend, which is the point of
        // recording one per model. Never inferred from anything else.
        backend: options.backend ?? null,
        role: options.role ?? "builder",
        write: Boolean(options.write),
        // options.dir can only be set when the raw string held no bare --dir
        // token (the name itself was quoted); then the parsed reading is the
        // only one there is.
        directory: dir ?? options.dir,
        wait: !options.background,
        timeoutSeconds: positiveSeconds("--timeout", options.timeout),
        budgetSeconds: positiveSeconds("--budget", options.budget),
        allowDirtyTree: Boolean(options["allow-dirty-tree"]),
        unattended: Boolean(options.unattended)
      })}\n`
    );
    return 0;
  },

  status: async (argv) => {
    const { positionals } = parseArgs(argv, {});
    process.stdout.write(`${await status(positionals[0])}\n`);
    return 0;
  },

  result: async (argv) => {
    const { positionals } = parseArgs(argv, {});
    process.stdout.write(`${await result(positionals[0])}\n`);
    return 0;
  },

  permit: async (argv) => {
    const { positionals } = parseArgs(argv, {});
    // Variadic: the ids are optional, so `permit allow` works when only one
    // request is pending. Copying two long ids to approve a test run is the
    // kind of friction that leaves a job blocked overnight.
    process.stdout.write(`${await permit(...positionals)}\n`);
    return 0;
  },

  cancel: async (argv) => {
    const { positionals } = parseArgs(argv, {});
    process.stdout.write(`${await cancel(positionals[0])}\n`);
    return 0;
  },

  revert: async (argv) => {
    const { positionals } = parseArgs(argv, {});
    const jobID = positionals[0];

    // Named explicitly, always. Every other job subcommand falls back to the
    // most recent job when given nothing, which is a harmless convenience for
    // reading state. revert restores and deletes files, and with the same
    // fallback a bare `revert` — or the empty $ARGUMENTS the slash command
    // produces when you type none — silently picked a victim job.
    if (!jobID) {
      throw new Error(
        "revert needs a job id. It restores and deletes files, so it will not guess which job you meant. Run `status` to list them."
      );
    }

    process.stdout.write(`${await revert(jobID)}\n`);
    return 0;
  },

  resolve: (argv, raw) => {
    // The whole remainder is the phrase: "fast glm 5.3" is three tokens.
    const phrase = typeof raw === "string" ? raw : argv.join(" ");
    process.stdout.write(`${resolve(phrase)}
`);
    return 0;
  },

  wait: async (argv) => {
    const { options, positionals } = parseArgs(argv, { valueOptions: ["timeout"], boolOptions: ["all"] });
    process.stdout.write(
      `${await waitForJobs(positionals, {
        timeoutSeconds: positiveSeconds("--timeout", options.timeout) ?? 3600,
        all: Boolean(options.all)
      })}
`
    );
    return 0;
  },

  notify: async () => {
    const text = await notify();
    if (text) {
      process.stdout.write(`${text}\n`);
    }
    return 0;
  }
};

/**
 * A numeric option, or undefined when omitted. Anything else is refused here:
 * a NaN that reaches a deadline comparison is never exceeded, so `--timeout abc`
 * waited forever and `--budget abc` switched the budget off.
 */
function positiveSeconds(name, value) {
  if (value === undefined) {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${name} must be a positive number of seconds, not "${value}".`);
  }
  return number;
}

async function main() {
  // A slash command hands the whole argument string over as one entry, because
  // it must be shell-quoted to survive Windows backslashes. See tokenize.mjs.
  const [name, ...rest] = process.argv.slice(2);
  const argv = normalizeArgv(rest);

  // The raw string is offered to a command ONLY when it genuinely arrived as
  // one entry. Reconstructing it with rest.join(" ") when real argv is present
  // destroys the argument boundaries the shell already got right, and a value
  // containing a flag then reads as that flag.
  //
  // This is not hypothetical. Delegating a task whose text described the
  // `--dir` option dispatched a WRITE job to the wrong repository: the task
  // was one argv entry, joining flattened it, and `--dir` was read out of the
  // prose instead of from the option. A parsing shortcut that can redirect
  // writes across repositories is not a shortcut worth having.
  const raw = rest.length === 1 ? rest[0] : null;

  if (!name || name === "help" || name === "--help" || name === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }

  const command = COMMANDS[name];
  if (!command) {
    process.stderr.write(`${fail(`Unknown command "${name}".`, USAGE)}\n`);
    return 2;
  }

  return await command(argv, raw);
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`${fail(error.message)}\n`);
  process.exitCode = 1;
}
