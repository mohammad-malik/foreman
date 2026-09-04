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
import { normalizeArgv } from "./lib/tokenize.mjs";
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
           [--dir <path>]
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
  boolOptions: ["write", "background", "wait", "allow-dirty-tree"]
};

/**
 * Reassemble a path from the positional arguments.
 *
 * Splitting the argument string is unavoidable, because a slash command must
 * quote `$ARGUMENTS` to keep a Windows path's backslashes and that delivers
 * everything as one entry. But splitting then breaks a path containing a
 * space, and `C:\Program Files\repo` is not an exotic input. Rejoining the
 * non-flag positionals restores it, so the common case works unquoted and
 * quoting is merely also supported.
 */
function pathArg(positionals) {
  return positionals.length === 0 ? undefined : positionals.join(" ");
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

  register: (argv) => {
    const { options, positionals } = parseArgs(argv, {
      boolOptions: ["allow-external", "force"]
    });
    process.stdout.write(
      `${register(pathArg(positionals), {
        allowExternal: Boolean(options["allow-external"]),
        force: Boolean(options.force)
      })}\n`
    );
    return 0;
  },

  unregister: (argv) => {
    const { positionals } = parseArgs(argv, {});
    process.stdout.write(`${unregister(pathArg(positionals))}\n`);
    return 0;
  },

  servers: () => {
    process.stdout.write(`${servers()}\n`);
    return 0;
  },

  "server-start": async (argv) => {
    const { positionals } = parseArgs(argv, {});
    process.stdout.write(`${await serverStart(pathArg(positionals))}\n`);
    return 0;
  },

  "server-stop": async (argv) => {
    const { positionals } = parseArgs(argv, {});
    process.stdout.write(`${await serverStop(pathArg(positionals))}\n`);
    return 0;
  },

  sweep: async () => {
    process.stdout.write(`${await sweepServers()}\n`);
    return 0;
  },

  delegate: async (argv) => {
    const { options, positionals } = parseArgs(argv, DELEGATE_SPEC);

    // The task can come from --task or from whatever is left over, so a long
    // handoff after `--` does not have to be quoted twice.
    const task = options.task ?? positionals.join(" ");

    process.stdout.write(
      `${await delegate({
        task,
        model: options.model ?? "kimi",
        route: options.route ?? "standard",
        role: options.role ?? "builder",
        write: Boolean(options.write),
        directory: options.dir,
        wait: !options.background,
        timeoutSeconds: options.timeout ? Number(options.timeout) : undefined,
        budgetSeconds: options.budget ? Number(options.budget) : undefined,
        allowDirtyTree: Boolean(options["allow-dirty-tree"])
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
    process.stdout.write(`${revert(positionals[0])}\n`);
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

  return await command(argv);
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`${fail(error.message)}\n`);
  process.exitCode = 1;
}
