#!/usr/bin/env node
/**
 * The external-agents runtime.
 *
 * Every slash command in this plugin shells into exactly one place: here.
 * Claude reads job state by running the read-only subcommands through
 * `Bash(node:*)`. Dispatch itself is fronted by a slash command carrying
 * `disable-model-invocation: true`, so a delegation is always something a
 * person asked for, which is why there is no MCP server.
 */

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
import { fail } from "./lib/render.mjs";

const USAGE = `external-agents runtime

Read-only:
  doctor                        Check the runtime, OpenCode, routes and workspaces
  routes [--refresh]            List model aliases and live availability
  workspaces                    List registered workspaces
  servers                       Show the OpenCode server for each workspace
  status [job-id]               List jobs, or show one
  result [job-id]               Collect and show a job's outcome

Human-invoked:
  delegate --task <text> [--model kimi] [--route standard|fast]
           [--role builder|fixer|researcher] [--write]
           [--background] [--timeout <seconds>] [--allow-dirty-tree]
           [--unattended] [--dir <path>]
                                Dispatch a handoff to an external model
  permit <job-id> <request-id> allow|reject
                                Answer one pending permission request
  cancel [job-id]               Stop a running job
  revert <job-id>               Restore only the files a job changed
  register <path> [--allow-external] [--force]
                                Add a workspace to the allowlist
  unregister <path>             Remove a workspace from the allowlist

Maintenance:
  server-start [path]           Start or reuse this workspace's server
  server-stop [path]            Stop this workspace's server
  sweep                         Clean up dead and idle servers
  notify                        Report finished jobs once (used by the Stop hook)
`;

const DELEGATE_SPEC = {
  valueOptions: ["task", "model", "route", "role", "timeout", "dir", "budget"],
  boolOptions: ["write", "background", "wait", "allow-dirty-tree", "unattended"]
};

// Every option delegate recognises. extractOption reads --dir's value from
// the raw argument string and needs to know where that value ends: at the
// next recognised option, because the slash command puts --dir first.
const DELEGATE_OPTIONS = [...DELEGATE_SPEC.valueOptions, ...DELEGATE_SPEC.boolOptions];

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
    const { path, flags } = extractPath(raw, ["allow-external", "force"]);
    process.stdout.write(
      `${register(path, {
        allowExternal: flags.has("allow-external"),
        force: flags.has("force")
      })}\n`
    );
    return 0;
  },

  unregister: (argv, raw) => {
    process.stdout.write(`${unregister(extractPath(raw).path)}\n`);
    return 0;
  },

  servers: () => {
    process.stdout.write(`${servers()}\n`);
    return 0;
  },

  "server-start": async (argv, raw) => {
    process.stdout.write(`${await serverStart(extractPath(raw).path)}\n`);
    return 0;
  },

  "server-stop": async (argv, raw) => {
    process.stdout.write(`${await serverStop(extractPath(raw).path)}\n`);
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
    const { value: dir, rest: args } = extractOption(argv, raw, "dir", DELEGATE_OPTIONS);
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

    const task = options.task ?? positionals.join(" ");

    process.stdout.write(
      `${await delegate({
        task,
        model: options.model ?? "kimi",
        route: options.route ?? "standard",
        role: options.role ?? "builder",
        write: Boolean(options.write),
        // options.dir can only be set when the raw string held no bare --dir
        // token (the name itself was quoted); then the parsed reading is the
        // only one there is.
        directory: dir ?? options.dir,
        wait: !options.background,
        timeoutSeconds: options.timeout ? Number(options.timeout) : undefined,
        budgetSeconds: options.budget ? Number(options.budget) : undefined,
        allowDirtyTree: Boolean(options["allow-dirty-tree"]),
        unattended: Boolean(options.unattended)
      })}\n`
    );
    return 0;
  },

  status: (argv) => {
    const { positionals } = parseArgs(argv, {});
    process.stdout.write(`${status(positionals[0])}\n`);
    return 0;
  },

  result: async (argv) => {
    const { positionals } = parseArgs(argv, {});
    process.stdout.write(`${await result(positionals[0])}\n`);
    return 0;
  },

  permit: async (argv) => {
    const { positionals } = parseArgs(argv, {});
    process.stdout.write(`${await permit(positionals[0], positionals[1], positionals[2])}\n`);
    return 0;
  },

  cancel: async (argv) => {
    const { positionals } = parseArgs(argv, {});
    process.stdout.write(`${await cancel(positionals[0])}\n`);
    return 0;
  },

  revert: (argv) => {
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

    process.stdout.write(`${revert(jobID)}\n`);
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

async function main() {
  // A slash command hands the whole argument string over as one entry, because
  // it must be shell-quoted to survive Windows backslashes. See tokenize.mjs.
  const [name, ...rest] = process.argv.slice(2);
  const argv = normalizeArgv(rest);

  if (!name || name === "help" || name === "--help" || name === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }

  const command = COMMANDS[name];
  if (!command) {
    process.stderr.write(`${fail(`Unknown command "${name}".`, USAGE)}\n`);
    return 2;
  }

  return await command(argv, rest.join(" "));
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`${fail(error.message)}\n`);
  process.exitCode = 1;
}
