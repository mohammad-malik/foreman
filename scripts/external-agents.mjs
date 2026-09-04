#!/usr/bin/env node
/**
 * The external-agents runtime.
 *
 * Every slash command in this plugin shells into exactly one place: here.
 * Claude reads job state by running the read-only subcommands through
 * `Bash(node:*)`. Nothing dispatches work to an external model without a
 * human-invoked command upstream of it, which is why there is no MCP server.
 */

import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { doctor } from "./lib/cmd/doctor.mjs";
import { register, unregister, workspaces } from "./lib/cmd/register.mjs";
import { routes } from "./lib/cmd/routes.mjs";
import { servers, serverStart, serverStop, sweepServers } from "./lib/cmd/server.mjs";
import { fail } from "./lib/render.mjs";

const USAGE = `external-agents runtime

Read-only:
  doctor                        Check the runtime, OpenCode, routes and workspaces
  routes [--refresh]            List model aliases and live availability
  workspaces                    List registered workspaces

  servers                       Show the OpenCode server for each workspace

Human-invoked:
  register <path> [--allow-external] [--force]
                                Add a workspace to the allowlist
  unregister <path>             Remove a workspace from the allowlist

Maintenance:
  server-start [path]           Start or reuse this workspace's server
  server-stop [path]            Stop this workspace's server
  sweep                         Clean up dead and idle servers
`;

const COMMANDS = {
  doctor: () => {
    const result = doctor();
    process.stdout.write(`${result.text}\n`);
    return result.failures > 0 ? 1 : 0;
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
      `${register(positionals[0], {
        allowExternal: Boolean(options["allow-external"]),
        force: Boolean(options.force)
      })}\n`
    );
    return 0;
  },

  unregister: (argv) => {
    const { positionals } = parseArgs(argv, {});
    process.stdout.write(`${unregister(positionals[0])}\n`);
    return 0;
  },

  servers: () => {
    process.stdout.write(`${servers()}\n`);
    return 0;
  },

  "server-start": async (argv) => {
    const { positionals } = parseArgs(argv, {});
    process.stdout.write(`${await serverStart(positionals[0])}\n`);
    return 0;
  },

  "server-stop": async (argv) => {
    const { positionals } = parseArgs(argv, {});
    process.stdout.write(`${await serverStop(positionals[0])}\n`);
    return 0;
  },

  sweep: async () => {
    process.stdout.write(`${await sweepServers()}\n`);
    return 0;
  }
};

async function main() {
  const [name, ...argv] = process.argv.slice(2);

  if (!name || name === "help" || name === "--help" || name === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }

  const command = COMMANDS[name];
  if (!command) {
    process.stderr.write(fail(`Unknown command "${name}".`, USAGE) + "\n");
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
